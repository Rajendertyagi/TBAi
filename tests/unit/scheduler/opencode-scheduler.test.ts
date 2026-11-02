/**
 * Unit tests for Unified Scheduler + OpenCode 2.2.0 integration.
 *
 * Covers:
 * - OpenCode field validation (checkOpenCodeFields, checkProvider bypass)
 * - checkExistingThread validation: rejects non-OpenCode engine, archived, and folder/directory mismatch
 * - Exact conversation creation counts: Fresh (1 per run), Persistent (1 on first run, reused), Existing (0 created)
 * - Persistent configuration invalidation via PATCH /jobs/:id on model, agent, variant, perms, folder, path, strategy
 * - Durable prompt submission reconciliation (inbox/messages lookup, ambiguous failure as outcome_unknown)
 * - Turn-bounding & completion verification in executeOpenCodeScheduledTurn (inbox post-wait check, idle outcomes)
 * - Cancellation/timeout isolation: Existing conversation never calls session.interrupt
 * - SchedulerStore persistence of engine and OpenCode job attributes
 * - Run claim and terminal recording with OpenCode promptId, sessionId, and turnOutcome
 * - Interrupted run recovery preserving / populating turn_outcome = 'outcome_unknown'
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import path from "node:path";
import { db } from "@/db";
import { schedulerStore } from "@/services/scheduler/schedulerStore.ts";
import type { JobCreate } from "@/services/scheduler/schedulerStore.ts";
import {
  checkOpenCodeFields,
  checkProvider,
  checkExistingThread,
} from "@/services/scheduler/schedulerValidation.ts";
import { conversationService } from "@/services/storage";
import { ensureJobConversation } from "@/services/scheduler/schedulerExecution.ts";
import {
  executeOpenCodeScheduledTurn,
  reconcilePromptSubmission,
  resolveSessionForJob,
} from "@/services/opencode/scheduledExecution.ts";
import schedulerApp from "@/routes/scheduler.ts";
import { setSchedulerReady } from "@/services/scheduler/scheduler.ts";

let mockOpenCodeClient: any = null;

mock.module("@/services/opencode/sessions.ts", () => ({
  ensureOpenCodeSession: async (conversationId: string, options?: any) => ({
    sessionId: "mock_ses_" + conversationId,
    created: true,
    serviceOwner: "local",
    locationDirectory: process.cwd(),
    autoApproveOnce: false,
  }),
  AUTONOMOUS_CODING_PERMISSIONS: {},
  READ_ONLY_PERMISSIONS: {},
}));

mock.module("@/services/opencode/serviceAccess.ts", () => ({
  resolveOpenCodeServiceAccess: async () => ({
    owner: { kind: "local" },
    baseUrl: "http://127.0.0.1:0",
    transport: globalThis.fetch,
  }),
}));

mock.module("@/services/opencode/client.ts", () => ({
  createOpenCodeClient: () => mockOpenCodeClient,
}));

function sampleOpenCodeJob(overrides: Partial<JobCreate> = {}): JobCreate {
  return {
    name: "OpenCode scheduled maintenance",
    description: "Automated repo audit via OpenCode",
    enabled: true,
    scheduleType: "cron",
    cronExpression: "0 4 * * *",
    execAt: null,
    timezone: "UTC",
    engine: "opencode",
    providerId: "opencode",
    modelId: "anthropic/claude-3-7-sonnet",
    thinkingLevel: null,
    workspacePath: "/repos/test-app",
    prompt: "Run linter and tests",
    conversationPolicy: "dedicated_thread",
    conversationId: null,
    overlapPolicy: "skip_if_running",
    maxRetries: 0,
    retryDelaySeconds: 60,
    timeoutSeconds: 600,
    missedGraceSeconds: 600,
    opencodeSessionStrategy: "fresh",
    opencodeAgent: "build",
    opencodeModel: "anthropic/claude-3-7-sonnet",
    opencodeVariant: null,
    opencodePermissions: "autonomous_coding",
    workspaceFolderId: "wf_123",
    ...overrides,
  };
}

describe("OpenCode Scheduler Validation", () => {
  it("ignores non-OpenCode engine configurations", () => {
    const err = checkOpenCodeFields({ engine: "direct" });
    expect(err).toBeNull();
  });

  it("requires opencodeSessionStrategy for OpenCode engine", () => {
    const err = checkOpenCodeFields({ engine: "opencode", opencodeSessionStrategy: null });
    expect(err).toContain("opencodeSessionStrategy");
  });

  it("rejects unknown session strategies", () => {
    const err = checkOpenCodeFields({
      engine: "opencode",
      opencodeSessionStrategy: "unknown_strategy" as any,
    });
    expect(err).toContain("Invalid opencodeSessionStrategy");
  });

  it("requires conversationId when strategy is existing_conversation", () => {
    const err = checkOpenCodeFields({
      engine: "opencode",
      opencodeSessionStrategy: "existing_conversation",
      conversationId: null,
    });
    expect(err).toContain("conversationId is required");
  });

  it("requires workspaceFolderId or workspacePath for fresh/persistent strategies", () => {
    const err = checkOpenCodeFields({
      engine: "opencode",
      opencodeSessionStrategy: "fresh",
      workspaceFolderId: null,
      workspacePath: null,
    });
    expect(err).toContain("workspaceFolderId or workspacePath is required");
  });

  it("passes checkProvider for OpenCode engine without needing registry provider", () => {
    const err = checkProvider({
      providerId: "opencode",
      modelId: "anthropic/claude-3-7-sonnet",
      engine: "opencode",
    });
    expect(err).toBeNull();
  });
});

describe("OpenCode Existing Conversation Validation", () => {
  let openCodeConvId: string;
  let directConvId: string;
  let archivedConvId: string;

  beforeEach(async () => {
    db.run(
      "INSERT OR REPLACE INTO folders (id, name, path, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["wf_target", "Target Repo", process.cwd(), "regular", Date.now(), Date.now()],
    );
    const opencodeConv = await conversationService.create({
      title: "OpenCode Target",
      providerId: "opencode",
      engine: "opencode",
      workspaceFolderId: "wf_target",
      workspaceMode: "project",
    });
    openCodeConvId = opencodeConv.id;

    const directConv = await conversationService.create({
      title: "Direct Target",
      providerId: "p1",
      engine: "direct",
      workspaceMode: "simple",
    });
    directConvId = directConv.id;

    const archivedConv = await conversationService.create({
      title: "Archived OpenCode",
      providerId: "opencode",
      engine: "opencode",
      workspaceFolderId: "wf_target",
      workspaceMode: "project",
    });
    await conversationService.update(archivedConv.id, { status: "archived" });
    archivedConvId = archivedConv.id;
  });

  it("accepts a matching active OpenCode conversation", async () => {
    const err = await checkExistingThread({
      engine: "opencode",
      opencodeSessionStrategy: "existing_conversation",
      conversationId: openCodeConvId,
      workspaceFolderId: "wf_target",
    });
    expect(err).toBeNull();
  });

  it("rejects non-existent conversation", async () => {
    const err = await checkExistingThread({
      engine: "opencode",
      opencodeSessionStrategy: "existing_conversation",
      conversationId: "non_existent_id",
    });
    expect(err).toContain("Target OpenCode conversation not found");
  });

  it("rejects non-OpenCode engine conversation", async () => {
    const err = await checkExistingThread({
      engine: "opencode",
      opencodeSessionStrategy: "existing_conversation",
      conversationId: directConvId,
    });
    expect(err).toContain("does not belong to OpenCode engine");
  });

  it("rejects archived conversation", async () => {
    const err = await checkExistingThread({
      engine: "opencode",
      opencodeSessionStrategy: "existing_conversation",
      conversationId: archivedConvId,
    });
    expect(err).toContain("archived");
  });

  it("rejects workspaceFolderId mismatch", async () => {
    const err = await checkExistingThread({
      engine: "opencode",
      opencodeSessionStrategy: "existing_conversation",
      conversationId: openCodeConvId,
      workspaceFolderId: "wf_different",
    });
    expect(err).toContain("different workspace folder");
  });
});

describe("Authoritative Conversation Creation Counts", () => {
  beforeEach(() => {
    setSchedulerReady(true);
    db.run("DELETE FROM scheduler_runs");
    db.run("DELETE FROM scheduler_jobs");
    db.run("DELETE FROM folders");
    db.run(
      "INSERT OR REPLACE INTO folders (id, name, path, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["wf_123", "Test Repo", process.cwd(), "regular", Date.now(), Date.now()],
    );
  });

  it("Fresh strategy: creates exactly 1 new conversation per execution", async () => {
    const initialList = await conversationService.list();
    const countBefore = initialList.threads.length;

    const job = schedulerStore.create(
      sampleOpenCodeJob({ opencodeSessionStrategy: "fresh" }),
      db,
    );

    // Run 1
    const run1 = await ensureJobConversation(job);
    expect(run1.created).toBe(true);

    const listAfter1 = await conversationService.list();
    expect(listAfter1.threads.length).toBe(countBefore + 1);

    // Run 2
    const run2 = await ensureJobConversation(job);
    expect(run2.created).toBe(true);
    expect(run2.conversationId).not.toBe(run1.conversationId);

    const listAfter2 = await conversationService.list();
    expect(listAfter2.threads.length).toBe(countBefore + 2);

    // Adapter resolveSessionForJob must NOT create conversations
    const dummyRun = schedulerStore.claimRun(job, "occ_fresh_test", "req_1", db)!;
    const sessionRes = await resolveSessionForJob(job, dummyRun, run1.conversationId);
    expect(sessionRes.conversationId).toBe(run1.conversationId);

    const listAfterAdapter = await conversationService.list();
    expect(listAfterAdapter.threads.length).toBe(countBefore + 2); // 0 added
  });

  it("Persistent strategy: creates exactly 1 dedicated conversation across runs", async () => {
    const initialList = await conversationService.list();
    const countBefore = initialList.threads.length;

    const job = schedulerStore.create(
      sampleOpenCodeJob({ opencodeSessionStrategy: "persistent", conversationId: null }),
      db,
    );

    // Run 1: first run creates dedicated conversation and binds to job
    const run1 = await ensureJobConversation(job);
    expect(run1.created).toBe(true);

    const listAfter1 = await conversationService.list();
    expect(listAfter1.threads.length).toBe(countBefore + 1);

    // Refresh job from store to verify conversationId is bound
    const refreshedJob = schedulerStore.get(job.id, db)!;
    expect(refreshedJob.conversationId).toBe(run1.conversationId);

    // Run 2: reuses dedicated conversation, creates 0 new conversations
    const run2 = await ensureJobConversation(refreshedJob);
    expect(run2.created).toBe(false);
    expect(run2.conversationId).toBe(run1.conversationId);

    const listAfter2 = await conversationService.list();
    expect(listAfter2.threads.length).toBe(countBefore + 1); // 0 added

    // Adapter resolveSessionForJob must NOT create conversations
    const dummyRun = schedulerStore.claimRun(refreshedJob, "occ_pers_test", "req_2", db)!;
    const sessionRes = await resolveSessionForJob(refreshedJob, dummyRun, run1.conversationId);
    expect(sessionRes.conversationId).toBe(run1.conversationId);

    const listAfterAdapter = await conversationService.list();
    expect(listAfterAdapter.threads.length).toBe(countBefore + 1); // 0 added
  });

  it("Existing conversation strategy: reuses target conversation with 0 creations", async () => {
    const targetConv = await conversationService.create({
      title: "Shared Target",
      providerId: "opencode",
      engine: "opencode",
      workspaceMode: "project",
      workspaceFolderId: "wf_123",
    });

    const countBefore = (await conversationService.list()).threads.length;

    const job = schedulerStore.create(
      sampleOpenCodeJob({
        opencodeSessionStrategy: "existing_conversation",
        conversationId: targetConv.id,
        workspacePath: process.cwd(),
      }),
      db,
    );

    const run = await ensureJobConversation(job);
    expect(run.created).toBe(false);
    expect(run.conversationId).toBe(targetConv.id);

    const countAfter = (await conversationService.list()).threads.length;
    expect(countAfter).toBe(countBefore); // 0 created

    const dummyRun = schedulerStore.claimRun(job, "occ_exist_test", "req_3", db)!;
    const sessionRes = await resolveSessionForJob(job, dummyRun, targetConv.id);
    expect(sessionRes.conversationId).toBe(targetConv.id);
    expect(sessionRes.isSharedExisting).toBe(true);

    const countAfterAdapter = (await conversationService.list()).threads.length;
    expect(countAfterAdapter).toBe(countBefore); // 0 created
  });
});

describe("Persistent Job Configuration Invalidation (PATCH /jobs/:id)", () => {
  beforeEach(() => {
    setSchedulerReady(true);
    db.run("DELETE FROM scheduler_runs");
    db.run("DELETE FROM scheduler_jobs");
    db.run("DELETE FROM folders");
    db.run(
      "INSERT OR REPLACE INTO folders (id, name, path, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["wf_123", "Test Repo", process.cwd(), "regular", Date.now(), Date.now()],
    );
    db.run(
      "INSERT OR REPLACE INTO folders (id, name, path, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["wf_updated_new", "Updated Repo", process.cwd(), "regular", Date.now(), Date.now()],
    );
  });

  const testFields = [
    { field: "workspaceFolderId", value: "wf_updated_new" },
    { field: "workspacePath", value: path.join(process.cwd(), "other-dir") },
    { field: "opencodeModel", value: "openai/gpt-4o" },
    { field: "opencodeAgent", value: "plan" },
    { field: "opencodeVariant", value: "high" },
    { field: "opencodePermissions", value: "read_only" },
    { field: "opencodeSessionStrategy", value: "fresh" },
  ];

  for (const { field, value } of testFields) {
    it(`clears conversationId when editing ${field} on a persistent job`, async () => {
      const job = schedulerStore.create(
        sampleOpenCodeJob({
          opencodeSessionStrategy: "persistent",
          conversationId: "conv_bound_123",
          workspacePath: process.cwd(),
        }),
        db,
      );
      expect(job.conversationId).toBe("conv_bound_123");

      const res = await schedulerApp.request(`/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.conversationId).toBeNull();

      const inDb = schedulerStore.get(job.id, db);
      expect(inDb?.conversationId).toBeNull();
    });
  }

  it("preserves conversationId when editing non-configuration fields (e.g. prompt)", async () => {
    const job = schedulerStore.create(
      sampleOpenCodeJob({
        opencodeSessionStrategy: "persistent",
        conversationId: "conv_keep_123",
        workspacePath: process.cwd(),
      }),
      db,
    );
    expect(job.conversationId).toBe("conv_keep_123");

    const res = await schedulerApp.request(`/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Updated scheduled prompt" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.conversationId).toBe("conv_keep_123");

    const inDb = schedulerStore.get(job.id, db);
    expect(inDb?.conversationId).toBe("conv_keep_123");
  });
});

describe("Durable Prompt Submission Reconciliation", () => {
  it("reconciles prompt found in session inbox", async () => {
    const mockClient = {
      session: {
        inbox: {
          list: async () => ({
            data: [{ id: "target_prm_1", text: "Run lint" }],
          }),
        },
      },
      message: {
        list: async () => ({ data: [] }),
      },
    } as any;

    const res = await reconcilePromptSubmission(mockClient, "ses_1", "target_prm_1");
    expect(res.found).toBe(true);
    expect(res.location).toBe("inbox");
  });

  it("reconciles prompt found in session message list", async () => {
    const mockClient = {
      session: {
        inbox: {
          list: async () => ({ data: [] }),
        },
      },
      message: {
        list: async () => ({
          data: [{ id: "target_prm_2", type: "user" }],
        }),
      },
    } as any;

    const res = await reconcilePromptSubmission(mockClient, "ses_1", "target_prm_2");
    expect(res.found).toBe(true);
    expect(res.location).toBe("messages");
  });

  it("reports not found when prompt is absent from inbox and messages", async () => {
    const mockClient = {
      session: {
        inbox: {
          list: async () => ({ data: [] }),
        },
      },
      message: {
        list: async () => ({ data: [] }),
      },
    } as any;

    const res = await reconcilePromptSubmission(mockClient, "ses_1", "missing_prm");
    expect(res.found).toBe(false);
    expect(res.location).toBe("none");
    expect(res.error).toBeUndefined();
  });

  it("captures reconciliation error when client throws transport failure", async () => {
    const mockClient = {
      session: {
        inbox: {
          list: async () => {
            throw new Error("Connection refused (ECONNREFUSED)");
          },
        },
      },
      message: {
        list: async () => ({ data: [] }),
      },
    } as any;

    const res = await reconcilePromptSubmission(mockClient, "ses_1", "prm_error");
    expect(res.found).toBe(false);
    expect(res.location).toBe("none");
    expect(res.error).toContain("ECONNREFUSED");
  });
});

describe("Turn-Bounding & Completion in executeOpenCodeScheduledTurn", () => {
  let testConv: any;
  let testJob: any;
  let testRun: any;

  beforeEach(async () => {
    db.run("DELETE FROM scheduler_runs");
    db.run("DELETE FROM scheduler_jobs");
    db.run(
      "INSERT OR REPLACE INTO folders (id, name, path, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["wf_123", "Test Repo", process.cwd(), "regular", Date.now(), Date.now()],
    );
    testConv = await conversationService.create({
      title: "Scheduled Test Conversation",
      providerId: "opencode",
      engine: "opencode",
      workspaceMode: "project",
      workspaceFolderId: "wf_123",
    });
    testJob = schedulerStore.create(
      sampleOpenCodeJob({
        opencodeSessionStrategy: "existing_conversation",
        conversationId: testConv.id,
        timeoutSeconds: 10,
      }),
      db,
    );
    testRun = schedulerStore.claimRun(testJob, "occ_turn_test", "req_turn", db, {
      opencodePromptId: "test_prompt_id",
      opencodeSessionId: "mock_ses",
    })!;
  });

  it("settles ambiguous submission honestly as outcome_unknown when prompt fails and reconciliation fails", async () => {
    mockOpenCodeClient = {
      session: {
        prompt: async () => {
          throw new Error("fetch failed (ECONNRESET)");
        },
        inbox: {
          list: async () => {
            throw new Error("Connection error during reconciliation");
          },
        },
      },
      message: {
        list: async () => ({ data: [] }),
      },
    };

    const res = await executeOpenCodeScheduledTurn({
      job: testJob,
      run: testRun,
      conversationId: testConv.id,
    });

    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(false);

    const completedRun = schedulerStore.getRun(testRun.id, db)!;
    expect(completedRun.status).toBe("failed");
    expect(completedRun.turnOutcome).toBe("outcome_unknown");
    expect(completedRun.error).toContain("Ambiguous prompt submission");
  });

  it("settles as outcome_unknown if prompt remains queued in inbox post-wait", async () => {
    const promptId = testRun.opencodePromptId ?? "test_prompt_id";
    mockOpenCodeClient = {
      session: {
        prompt: async () => ({}),
        wait: async () => ({}),
        inbox: {
          list: async () => ({
            data: [{ id: promptId, text: testJob.prompt }],
          }),
        },
      },
      message: {
        list: async () => ({ data: [] }),
      },
    };

    const res = await executeOpenCodeScheduledTurn({
      job: testJob,
      run: testRun,
      conversationId: testConv.id,
    });

    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(false);

    const completedRun = schedulerStore.getRun(testRun.id, db)!;
    expect(completedRun.status).toBe("failed");
    expect(completedRun.turnOutcome).toBe("outcome_unknown");
    expect(completedRun.error).toContain("remained queued in session inbox");
  });

  it("settles as outcome_unknown if intervening user message arrives before idle", async () => {
    const promptId = testRun.opencodePromptId ?? "test_prompt_id";
    mockOpenCodeClient = {
      session: {
        prompt: async () => ({}),
        wait: async () => ({}),
        inbox: {
          list: async () => ({ data: [] }),
        },
      },
      message: {
        list: async () => ({
          data: [
            { id: promptId, type: "user" },
            { id: "intervening_user_msg", type: "user" },
            { id: "idle_1", type: "idle", outcome: "succeeded" },
          ],
        }),
      },
    };

    const res = await executeOpenCodeScheduledTurn({
      job: testJob,
      run: testRun,
      conversationId: testConv.id,
    });

    expect(res.ok).toBe(false);
    const completedRun = schedulerStore.getRun(testRun.id, db)!;
    expect(completedRun.status).toBe("failed");
    expect(completedRun.turnOutcome).toBe("outcome_unknown");
    expect(completedRun.error).toContain("Interactive user message intervened");
  });

  it("settles as completed / succeeded on successful idle boundary", async () => {
    const promptId = testRun.opencodePromptId ?? "test_prompt_id";
    mockOpenCodeClient = {
      session: {
        prompt: async () => ({}),
        wait: async () => ({}),
        inbox: {
          list: async () => ({ data: [] }),
        },
      },
      message: {
        list: async () => ({
          data: [
            { id: promptId, type: "user" },
            {
              id: "asst_1",
              type: "assistant",
              content: [{ type: "text", text: "Turn output from assistant" }],
            },
            { id: "idle_1", type: "idle", outcome: "succeeded" },
          ],
        }),
      },
    };

    const res = await executeOpenCodeScheduledTurn({
      job: testJob,
      run: testRun,
      conversationId: testConv.id,
    });

    expect(res.ok).toBe(true);
    expect(res.text).toBe("Turn output from assistant");

    const completedRun = schedulerStore.getRun(testRun.id, db)!;
    expect(completedRun.status).toBe("completed");
    expect(completedRun.turnOutcome).toBe("succeeded");
    expect(completedRun.outputExcerpt).toBe("Turn output from assistant");
  });

  it("settles as failed on failed idle boundary", async () => {
    const promptId = testRun.opencodePromptId ?? "test_prompt_id";
    mockOpenCodeClient = {
      session: {
        prompt: async () => ({}),
        wait: async () => ({}),
        inbox: {
          list: async () => ({ data: [] }),
        },
      },
      message: {
        list: async () => ({
          data: [
            { id: promptId, type: "user" },
            {
              id: "idle_1",
              type: "idle",
              outcome: "failed",
              error: { message: "Model refused prompt due to rate limit" },
            },
          ],
        }),
      },
    };

    const res = await executeOpenCodeScheduledTurn({
      job: testJob,
      run: testRun,
      conversationId: testConv.id,
    });

    expect(res.ok).toBe(false);
    const completedRun = schedulerStore.getRun(testRun.id, db)!;
    expect(completedRun.status).toBe("failed");
    expect(completedRun.turnOutcome).toBe("failed");
    expect(completedRun.error).toBe("Model refused prompt due to rate limit");
  });

  it("never calls session.interrupt on shared Existing Conversation timeout/cancellation", async () => {
    let interruptCalled = false;
    let cancelInboxCalled = false;

    mockOpenCodeClient = {
      session: {
        prompt: async () => ({}),
        wait: async (_args: any, opts: any) => {
          // Simulate timeout/abort
          return new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          });
        },
        interrupt: async () => {
          interruptCalled = true;
        },
        inbox: {
          cancel: async () => {
            cancelInboxCalled = true;
          },
        },
      },
    };

    // Use a very short timeout job
    const shortJob = schedulerStore.create(
      sampleOpenCodeJob({
        opencodeSessionStrategy: "existing_conversation",
        conversationId: testConv.id,
        timeoutSeconds: 5,
      }),
      db,
    );
    const run = schedulerStore.claimRun(shortJob, "occ_timeout_shared", "req_timeout", db)!;

    // Trigger parent abort
    const controller = new AbortController();
    controller.abort();

    const res = await executeOpenCodeScheduledTurn({
      job: shortJob,
      run,
      conversationId: testConv.id,
      parentSignal: controller.signal,
    });

    expect(res.ok).toBe(false);
    expect(interruptCalled).toBe(false); // CRITICAL: must never interrupt shared session!
    const runInDb = schedulerStore.getRun(run.id, db)!;
    expect(runInDb.status).toBe("cancelled");
  });
});

describe("Cursor Pagination & Cancellation Reconciliation (regression)", () => {
  it("reconcilePromptSubmission walks cursor pages and finds prompt on later page", async () => {
    const mockClient = {
      session: {
        inbox: { list: async () => ({ data: [] }) },
      },
      message: {
        list: async (args: any) => {
          if (!args.cursor) {
            return { data: [{ id: "other" }], cursor: { next: "c1" } };
          }
          return { data: [{ id: "target_prm" }], cursor: {} };
        },
      },
    } as any;
    const res = await reconcilePromptSubmission(mockClient, "ses_1", "target_prm");
    expect(res.found).toBe(true);
    expect(res.location).toBe("messages");
  });

  it("reconcilePromptSubmission stops on cursor cycle", async () => {
    const mockClient = {
      session: { inbox: { list: async () => ({ data: [] }) } },
      message: {
        list: async () => ({ data: [{ id: "other" }], cursor: { next: "c1" } }),
      },
    } as any;
    const res = await reconcilePromptSubmission(mockClient, "ses_1", "missing");
    expect(res.found).toBe(false);
    expect(res.error).toContain("Incomplete");
  });

  it("reconcilePromptSubmission reports incomplete on empty page with remaining cursor", async () => {
    const mockClient = {
      session: { inbox: { list: async () => ({ data: [] }) } },
      message: {
        list: async () => ({ data: [], cursor: { next: "c1" } }),
      },
    } as any;
    const res = await reconcilePromptSubmission(mockClient, "ses_1", "missing");
    expect(res.found).toBe(false);
    expect(res.error).toContain("Incomplete");
  });

  it("shared-existing cancellation reports outcome_unknown when prompt already delivered", async () => {
    const conv = await conversationService.create({
      title: "Shared",
      providerId: "opencode",
      engine: "opencode",
      workspaceMode: "project",
      workspaceFolderId: "wf_123",
    });
    db.run(
      "INSERT OR REPLACE INTO folders (id, name, path, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["wf_123", "Test Repo", process.cwd(), "regular", Date.now(), Date.now()],
    );
    const job = schedulerStore.create(
      sampleOpenCodeJob({
        opencodeSessionStrategy: "existing_conversation",
        conversationId: conv.id,
        workspacePath: process.cwd(),
        timeoutSeconds: 10,
      }),
      db,
    );
    const run = schedulerStore.claimRun(job, "occ_cancel_delivered", "req_cancel", db, {
      opencodePromptId: "prm_cancel",
      opencodeSessionId: "mock_ses",
    })!;

    let cancelCalled = false;
    mockOpenCodeClient = {
      session: {
        prompt: async () => ({}),
        wait: async () => ({}),
        inbox: {
          cancel: async () => {
            cancelCalled = true;
          },
          list: async () => ({ data: [] }),
        },
      },
      message: {
        list: async () => ({ data: [{ id: "prm_cancel", type: "user" }] }),
      },
    };

    const controller = new AbortController();
    const waitPromise = new Promise<void>((resolve) => {
      setTimeout(() => controller.abort(), 10);
    });
    mockOpenCodeClient = {
      ...mockOpenCodeClient,
      session: {
        ...mockOpenCodeClient.session,
        wait: async (_args: any, opts: any) => {
          return new Promise((resolve) => {
            const onAbort = () => resolve({});
            if (opts?.signal?.aborted) return resolve({});
            opts?.signal?.addEventListener("abort", onAbort, { once: true });
          });
        },
      },
    };
    void waitPromise;
    const res = await executeOpenCodeScheduledTurn({
      job,
      run,
      conversationId: conv.id,
      parentSignal: controller.signal,
    });
    expect(res.ok).toBe(false);
    const completed = schedulerStore.getRun(run.id, db)!;
    expect(completed.turnOutcome).toBe("outcome_unknown");
  });

  it("shared-existing cancellation reports outcome_unknown when reconciliation fails", async () => {
    const conv = await conversationService.create({
      title: "Shared3",
      providerId: "opencode",
      engine: "opencode",
      workspaceMode: "project",
      workspaceFolderId: "wf_123",
    });
    const job = schedulerStore.create(
      sampleOpenCodeJob({
        opencodeSessionStrategy: "existing_conversation",
        conversationId: conv.id,
        workspacePath: process.cwd(),
        timeoutSeconds: 10,
      }),
      db,
    );
    const run = schedulerStore.claimRun(job, "occ_cancel_recon_fail", "req_cancel3", db, {
      opencodePromptId: "prm_cancel3",
      opencodeSessionId: "mock_ses",
    })!;

    const controller = new AbortController();
    mockOpenCodeClient = {
      session: {
        prompt: async () => ({}),
        wait: async (_args: any, opts: any) => {
          return new Promise((resolve) => {
            const onAbort = () => resolve({});
            if (opts?.signal?.aborted) return resolve({});
            opts?.signal?.addEventListener("abort", onAbort, { once: true });
            setTimeout(() => controller.abort(), 10);
          });
        },
        inbox: {
          cancel: async () => ({}),
          list: async () => {
            throw new Error("inbox list failed");
          },
        },
      },
      message: {
        list: async () => ({ data: [] }),
      },
    };

    const res = await executeOpenCodeScheduledTurn({
      job,
      run,
      conversationId: conv.id,
      parentSignal: controller.signal,
    });
    expect(res.ok).toBe(false);
    const completed = schedulerStore.getRun(run.id, db)!;
    expect(completed.turnOutcome).toBe("outcome_unknown");
  });

  it("shared-existing cancellation reports cancelled when prompt removed", async () => {
    const conv = await conversationService.create({
      title: "Shared2",
      providerId: "opencode",
      engine: "opencode",
      workspaceMode: "project",
      workspaceFolderId: "wf_123",
    });
    const job = schedulerStore.create(
      sampleOpenCodeJob({
        opencodeSessionStrategy: "existing_conversation",
        conversationId: conv.id,
        workspacePath: process.cwd(),
        timeoutSeconds: 10,
      }),
      db,
    );
    const run = schedulerStore.claimRun(job, "occ_cancel_removed", "req_cancel2", db, {
      opencodePromptId: "prm_cancel2",
      opencodeSessionId: "mock_ses",
    })!;

    mockOpenCodeClient = {
      session: {
        prompt: async () => ({}),
        wait: async () => ({}),
        inbox: {
          cancel: async () => ({}),
          list: async () => ({ data: [] }),
        },
      },
      message: {
        list: async () => ({ data: [] }),
      },
    };

    const controller = new AbortController();
    mockOpenCodeClient = {
      ...mockOpenCodeClient,
      session: {
        ...mockOpenCodeClient.session,
        wait: async (_args: any, opts: any) => {
          return new Promise((resolve) => {
            const onAbort = () => resolve({});
            if (opts?.signal?.aborted) return resolve({});
            opts?.signal?.addEventListener("abort", onAbort, { once: true });
            setTimeout(() => controller.abort(), 10);
          });
        },
      },
    };
    const res = await executeOpenCodeScheduledTurn({
      job,
      run,
      conversationId: conv.id,
      parentSignal: controller.signal,
    });
    expect(res.ok).toBe(false);
    const completed = schedulerStore.getRun(run.id, db)!;
    expect(completed.status).toBe("cancelled");
  });
});

describe("OpenCode Scheduler Store & Persistence", () => {
  beforeEach(() => {
    db.run("DELETE FROM scheduler_runs");
    db.run("DELETE FROM scheduler_jobs");
  });

  it("creates and maps an OpenCode job with all engine-specific columns", () => {
    const job = schedulerStore.create(sampleOpenCodeJob(), db);
    expect(job.engine).toBe("opencode");
    expect(job.opencodeSessionStrategy).toBe("fresh");
    expect(job.opencodeAgent).toBe("build");
    expect(job.opencodeModel).toBe("anthropic/claude-3-7-sonnet");
    expect(job.opencodePermissions).toBe("autonomous_coding");
    expect(job.workspaceFolderId).toBe("wf_123");

    const fetched = schedulerStore.get(job.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched?.engine).toBe("opencode");
    expect(fetched?.opencodeSessionStrategy).toBe("fresh");
    expect(fetched?.opencodeAgent).toBe("build");
    expect(fetched?.opencodePermissions).toBe("autonomous_coding");
    expect(fetched?.workspaceFolderId).toBe("wf_123");
  });

  it("claims a run with opencodeSessionId and opencodePromptId", () => {
    const job = schedulerStore.create(sampleOpenCodeJob(), db);
    const occurrenceId = "cron_occ_123";

    const run = schedulerStore.claimRun(
      job,
      occurrenceId,
      "req_test_1",
      db,
      {
        opencodeSessionId: "ses_abc_456",
        opencodePromptId: "prm_xyz_789",
      },
    );

    expect(run).not.toBeNull();
    if (!run) return;

    expect(run.engine).toBe("opencode");
    expect(run.opencodeSessionId).toBe("ses_abc_456");
    expect(run.opencodePromptId).toBe("prm_xyz_789");

    const fetchedRun = schedulerStore.getRun(run.id, db);
    expect(fetchedRun?.engine).toBe("opencode");
    expect(fetchedRun?.opencodeSessionId).toBe("ses_abc_456");
    expect(fetchedRun?.opencodePromptId).toBe("prm_xyz_789");
    expect(fetchedRun?.turnOutcome).toBeNull();
  });

  it("records terminal run with turnOutcome", () => {
    const job = schedulerStore.create(sampleOpenCodeJob(), db);
    const run = schedulerStore.claimRun(
      job,
      "cron_occ_term",
      "req_term",
      db,
      {
        opencodeSessionId: "ses_term",
        opencodePromptId: "prm_term",
      },
    );

    if (!run) throw new Error("Claim failed");

    schedulerStore.updateRun(
      run.id,
      {
        status: "completed",
        turnOutcome: "succeeded",
        completedAt: Date.now(),
        durationMs: 4200,
        outputExcerpt: "All 15 tests passed.",
      },
      db,
    );

    const completed = schedulerStore.getRun(run.id, db);
    expect(completed?.status).toBe("completed");
    expect(completed?.turnOutcome).toBe("succeeded");
    expect(completed?.outputExcerpt).toBe("All 15 tests passed.");
    expect(completed?.durationMs).toBe(4200);

    // Also verify recordTerminalRun helper accepts turnOutcome
    const terminalInfoRun = schedulerStore.recordTerminalRun(
      job,
      "occ_skipped_term",
      "skipped",
      "Skipped run due to overlap",
      "req_skip",
      db,
      "interrupted",
    );
    expect(terminalInfoRun?.turnOutcome).toBe("interrupted");
  });

  it("markInterrupted populates turn_outcome as outcome_unknown for crashed runs", () => {
    const job = schedulerStore.create(sampleOpenCodeJob(), db);
    const run = schedulerStore.claimRun(
      job,
      "crash_occ",
      "req_crash",
      db,
      {
        opencodeSessionId: "ses_crashed",
        opencodePromptId: "prm_crashed",
      },
    );

    if (!run) throw new Error("Claim failed");

    const recoveredCount = schedulerStore.markInterrupted(db);
    expect(recoveredCount).toBe(1);

    const recoveredRun = schedulerStore.getRun(run.id, db);
    expect(recoveredRun?.status).toBe("interrupted");
    expect(recoveredRun?.turnOutcome).toBe("outcome_unknown");
  });
});
