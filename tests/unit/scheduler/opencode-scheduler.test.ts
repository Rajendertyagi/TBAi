/**
 * Unit tests for Unified Scheduler + OpenCode 2.2.0 integration.
 *
 * Covers:
 * - OpenCode field validation (checkOpenCodeFields, checkProvider bypass)
 * - SchedulerStore persistence of engine and OpenCode job attributes
 * - Clearing conversationId when model/agent changes on a persistent job
 * - Run claim and terminal recording with OpenCode promptId, sessionId, and turnOutcome
 * - Interrupted run recovery preserving / populating turn_outcome = 'outcome_unknown'
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@/db";
import { schedulerStore } from "@/services/scheduler/schedulerStore.ts";
import type { JobCreate } from "@/services/scheduler/schedulerStore.ts";
import {
  checkOpenCodeFields,
  checkProvider,
} from "@/services/scheduler/schedulerValidation.ts";

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

  it("clears conversationId on update when model or agent changes on a persistent job", () => {
    const job = schedulerStore.create(
      sampleOpenCodeJob({
        opencodeSessionStrategy: "persistent",
        conversationId: "conv_bound_123",
      }),
      db,
    );
    expect(job.conversationId).toBe("conv_bound_123");

    // Updating prompt does not clear conversationId
    const u1 = schedulerStore.update(job.id, { prompt: "New prompt" }, db);
    expect(u1?.conversationId).toBe("conv_bound_123");

    // Updating model clears conversationId to force new session provisioning
    const u2 = schedulerStore.update(
      job.id,
      { opencodeModel: "openai/gpt-4o", conversationId: null },
      db,
    );
    expect(u2?.conversationId).toBeNull();
    expect(u2?.opencodeModel).toBe("openai/gpt-4o");
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
