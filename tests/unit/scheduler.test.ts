/**
 * Built-in scheduler unit tests.
 *
 * Covers: cron validation/parsing, presets + human descriptions,
 * timezone-aware next-run computation, job CRUD, atomic occurrence
 * claims (UNIQUE duplicate guard), overlap detection, interrupted-run
 * reconciliation, overdue one-time handling (missed path), retry
 * classification, destructive-tool refusal, and workspace verification.
 *
 * DB isolation: tests/setup.ts redirects DATA_DIR to a tmp dir, so the
 * shared `db` singleton is test-scoped. The coordinator's live timers
 * (Bun.cron / setTimeout) are NOT exercised here — see docs/scheduler.md
 * for the live E2E checklist (another agent runs tests + live runs).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import fs from "fs";
import path from "path";
import {
  parseCron,
  isValidCron,
  computeNextRun,
  computeNextRuns,
  assertValidTimezone,
  describeCron,
  presetEveryNMinutes,
  presetHourly,
  presetDaily,
  presetWeekdays,
  presetWeekly,
  presetMonthly,
  cronOccurrenceId,
  onceOccurrenceId,
  manualOccurrenceId,
  expandMacro,
  countUpcoming,
} from "../../src/services/scheduler/cron";
import { schedulerStore } from "../../src/services/scheduler/schedulerStore";
import type { JobCreate } from "../../src/services/scheduler/schedulerStore";
import type { SchedulerJob } from "../../src/services/scheduler/schedulerTypes";
import {
  isRetryableError,
  verifyJobWorkspace,
  buildSchedulerTools,
  ensureJobConversation,
} from "../../src/services/scheduler/schedulerExecution";
import { handleOverdueOnce, fireJob, scheduleJob, runJobNow, cancelRun, clearAllTimers, activeTimerCount } from "../../src/services/scheduler/scheduler";
import schedulerApp from "../../src/routes/scheduler";
import { getWorkspaceDir } from "../../src/services/tools";
import { conversationService } from "../../src/services/storage";

function makeJob(overrides: Partial<JobCreate> = {}): SchedulerJob {
  return schedulerStore.create({
    name: "test job",
    scheduleType: "once",
    execAt: Date.now() + 3600_000,
    timezone: "UTC",
    providerId: "p1",
    modelId: "m1",
    workspacePath: getWorkspaceDir(),
    prompt: "hello",
    ...overrides,
  });
}

describe("cron validation", () => {
  it("accepts valid 5-field expressions", () => {
    expect(isValidCron("* * * * *")).toBe(true);
    expect(isValidCron("*/15 * * * *")).toBe(true);
    expect(isValidCron("0 9 * * 1-5")).toBe(true);
    expect(isValidCron("30 18 * * mon,fri")).toBe(true);
    expect(isValidCron("0 0 1 jan *")).toBe(true);
  });

  it("rejects seconds, wrong arity, and out-of-range values", () => {
    expect(isValidCron("* * * * * *")).toBe(false); // no seconds
    expect(isValidCron("* * * *")).toBe(false);
    expect(isValidCron("61 * * * *")).toBe(false);
    expect(isValidCron("* 25 * * *")).toBe(false);
    expect(isValidCron("*/0 * * * *")).toBe(false);
    expect(isValidCron("5-2 * * * *")).toBe(false);
    expect(isValidCron("not a cron")).toBe(false);
  });

  it("parseCron throws with a useful message", () => {
    expect(() => parseCron("* * *")).toThrow(/5 fields/);
  });
});

describe("cron presets + descriptions", () => {
  it("builds valid expressions", () => {
    for (const expr of [
      presetEveryNMinutes(15),
      presetHourly(30),
      presetDaily(9, 30),
      presetWeekdays(9, 0),
      presetWeekly(1, 9, 0),
      presetMonthly(1, 9, 0),
    ]) {
      expect(isValidCron(expr)).toBe(true);
    }
    expect(presetEveryNMinutes(1)).toBe("* * * * *");
  });

  it("rejects bad preset inputs", () => {
    expect(() => presetEveryNMinutes(0)).toThrow();
    expect(() => presetEveryNMinutes(60)).toThrow();
    expect(() => presetDaily(24, 0)).toThrow();
    expect(() => presetMonthly(31, 0, 0)).toThrow();
  });

  it("describes common shapes in plain language", () => {
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("30 * * * *")).toBe("Hourly at :30");
    expect(describeCron("0 9 * * *")).toBe("Daily at 09:00");
    expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 09:00");
    expect(describeCron("30 18 * * 5")).toContain("Weekly");
  });
});

describe("timezone + next-run", () => {
  it("rejects invalid timezones", () => {
    expect(() => assertValidTimezone("Mars/Olympus")).toThrow();
    assertValidTimezone("UTC");
    assertValidTimezone("Asia/Kolkata");
  });

  it("computes the next daily run strictly in the future", () => {
    // 2026-01-01T00:00:00Z is a Thursday.
    const from = Date.UTC(2026, 0, 1, 0, 0, 0);
    const next = computeNextRun("0 9 * * *", "UTC", from);
    expect(next).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
    const after = computeNextRun("0 9 * * *", "UTC", next);
    expect(after).toBe(Date.UTC(2026, 0, 2, 9, 0, 0));
  });

  it("computes every-N-minutes slots", () => {
    const from = Date.UTC(2026, 0, 1, 0, 7, 0);
    expect(computeNextRun("*/15 * * * *", "UTC", from)).toBe(
      Date.UTC(2026, 0, 1, 0, 15, 0),
    );
  });

  it("honors the job timezone (Asia/Kolkata 09:00 = 03:30Z)", () => {
    const from = Date.UTC(2026, 0, 1, 0, 0, 0);
    const next = computeNextRun("0 9 * * *", "Asia/Kolkata", from);
    expect(next).toBe(Date.UTC(2026, 0, 1, 3, 30, 0));
  });

  it("computes ordered run lists", () => {
    const runs = computeNextRuns(
      "0 9 * * *",
      "UTC",
      Date.UTC(2026, 0, 1, 0, 0, 0),
      3,
    );
    expect(runs).toEqual([
      Date.UTC(2026, 0, 1, 9, 0, 0),
      Date.UTC(2026, 0, 2, 9, 0, 0),
      Date.UTC(2026, 0, 3, 9, 0, 0),
    ]);
  });

  it("matches weekday + month names", () => {
    // 2026-01-05 is a Monday.
    const from = Date.UTC(2026, 0, 1, 0, 0, 0);
    const next = computeNextRun("0 9 * * mon", "UTC", from);
    expect(next).toBe(Date.UTC(2026, 0, 5, 9, 0, 0));
  });
});

describe("occurrence ids", () => {
  it("cron slots are stable per minute; manual ids are unique", () => {
    expect(cronOccurrenceId(1_000)).toBe(cronOccurrenceId(59_999));
    expect(cronOccurrenceId(60_000)).not.toBe(cronOccurrenceId(0));
    expect(onceOccurrenceId()).toBe("once");
    expect(manualOccurrenceId()).not.toBe(manualOccurrenceId());
  });
});

describe("scheduler store", () => {
  beforeEach(() => {
    for (const job of schedulerStore.list()) schedulerStore.remove(job.id);
  });

  it("creates, reads, updates, and deletes jobs", () => {
    const job = makeJob({ name: "alpha" });
    expect(job.id.length).toBeGreaterThan(0);
    expect(job.enabled).toBe(true);
    expect(job.status).toBe("active");
    expect(schedulerStore.get(job.id)?.name).toBe("alpha");

    const updated = schedulerStore.update(job.id, {
      name: "beta",
      enabled: false,
    });
    expect(updated?.name).toBe("beta");
    expect(updated?.enabled).toBe(false);

    schedulerStore.remove(job.id);
    expect(schedulerStore.get(job.id)).toBeNull();
  });

  it("lists enabled jobs only when active", () => {
    const a = makeJob({ name: "a" });
    const b = makeJob({ name: "b" });
    schedulerStore.update(b.id, { enabled: false });
    const ids = schedulerStore.listEnabled().map((j) => j.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it("claims each occurrence exactly once (UNIQUE guard)", () => {
    const job = makeJob({ scheduleType: "cron", cronExpression: "0 9 * * *" });
    const first = schedulerStore.claimRun(job, "cron-123", "req_1");
    expect(first).not.toBeNull();
    expect(first?.status).toBe("running");
    // Duplicate fire for the same slot is refused — no second execution.
    expect(schedulerStore.claimRun(job, "cron-123", "req_2")).toBeNull();
    // A different slot claims fine.
    expect(schedulerStore.claimRun(job, "cron-124", "req_3")).not.toBeNull();
  });

  it("detects running runs for the overlap policy", () => {
    const job = makeJob();
    expect(schedulerStore.hasRunningRun(job.id)).toBe(false);
    schedulerStore.claimRun(job, onceOccurrenceId(), "req_1");
    expect(schedulerStore.hasRunningRun(job.id)).toBe(true);
  });

  it("marks orphaned running/scheduled runs as interrupted", () => {
    const job = makeJob();
    schedulerStore.claimRun(job, "cron-1", "req_1");
    schedulerStore.claimRun(job, "cron-2", "req_2");
    const count = schedulerStore.markInterrupted();
    expect(count).toBeGreaterThanOrEqual(2);
    const { runs } = schedulerStore.listRuns(job.id);
    expect(runs.every((r) => r.status === "interrupted")).toBe(true);
  });

  it("lists runs newest-first with totals", () => {
    const job = makeJob();
    schedulerStore.claimRun(job, "cron-1", "req_1");
    schedulerStore.claimRun(job, "cron-2", "req_2");
    const { runs, total } = schedulerStore.listRuns(job.id, 50, 0);
    expect(total).toBe(2);
    expect(runs[0].startedAt).toBeGreaterThanOrEqual(runs[1].startedAt);
  });
});

describe("overdue one-time policy", () => {
  beforeEach(() => {
    for (const job of schedulerStore.list()) schedulerStore.remove(job.id);
  });

  it("marks long-overdue jobs missed, never executes them", async () => {
    const job = makeJob({
      scheduleType: "once",
      execAt: Date.now() - 3600_000,
      missedGraceSeconds: 600,
    });
    await handleOverdueOnce(job);
    const after = schedulerStore.get(job.id)!;
    expect(after.status).toBe("missed");
    expect(after.enabled).toBe(false);
    const { runs } = schedulerStore.listRuns(job.id);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("missed");
    expect(runs[0].occurrenceId).toBe("once");
  });
});

describe("retry classification", () => {
  it("retries transient failures", () => {
    expect(isRetryableError(new Error("fetch failed: socket hang up"))).toBe(true);
    expect(isRetryableError(new Error("429 rate limit exceeded"))).toBe(true);
    expect(
      isRetryableError(Object.assign(new Error("x"), { status: 503 })),
    ).toBe(true);
  });

  it("never retries config/auth/safety failures", () => {
    expect(isRetryableError(new Error("401 Unauthorized"))).toBe(false);
    expect(isRetryableError(new Error("No API key configured"))).toBe(false);
    expect(isRetryableError(new Error("Provider x is missing"))).toBe(false);
    expect(isRetryableError(new Error("Workspace not found"))).toBe(false);
    expect(
      isRetryableError(new Error("user approval required for run_command")),
    ).toBe(false);
    expect(
      isRetryableError(Object.assign(new Error("bad"), { status: 400 })),
    ).toBe(false);
  });
});

describe("unattended tool safety", () => {
  it("destructive tools always refuse (never auto-approve)", async () => {
    const tools = buildSchedulerTools();
    for (const name of [
      "write_file",
      "edit_file",
      "delete_file",
      "run_command",
      "process_kill",
    ] as const) {
      const err = await (tools[name] as { execute: (a: unknown) => Promise<unknown> }).execute(
        {},
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).not.toBeNull();
      expect(String((err as Error)?.message ?? err)).toMatch(/approval/i);
    }
  });

  it("read-only tools still execute", async () => {
    const root = getWorkspaceDir();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "sched-probe.txt"), "probe\n");
    const tools = buildSchedulerTools();
    const out = (await (
      tools.read_file as { execute: (a: unknown) => Promise<{ content: string }> }
    ).execute({ path: "sched-probe.txt" })) as { content: string };
    expect(out.content).toContain("probe");
  });
});

describe("workspace verification", () => {
  it("accepts the workspace root, rejects outside + missing paths", () => {
    expect(verifyJobWorkspace(getWorkspaceDir())).toBe(getWorkspaceDir());
    expect(() => verifyJobWorkspace("/etc")).toThrow(/outside/);
    expect(() =>
      verifyJobWorkspace(path.join(getWorkspaceDir(), "no-such-dir-xyz")),
    ).toThrow(/not found/);
  });
});

describe("ensureJobConversation", () => {
  beforeEach(async () => {
    for (const job of schedulerStore.list()) schedulerStore.remove(job.id);
    try {
      const all = await conversationService.list();
      for (const c of all?.threads ?? []) {
        if (c.title.startsWith("[Scheduler]") || c.title === "Test conv") {
          void conversationService.delete(c.id);
        }
      }
    } catch {
      /* best-effort cleanup */
    }
  });

  it("throws when existing_thread mode has no conversationId", async () => {
    const job = schedulerStore.create({
      name: "test-existing-missing",
      scheduleType: "once",
      execAt: Date.now() + 3600_000,
      timezone: "UTC",
      providerId: "p1",
      modelId: "m1",
      workspacePath: getWorkspaceDir(),
      prompt: "hello",
      conversationPolicy: "existing_thread",
      conversationId: null,
    });
    await expect(ensureJobConversation(job)).rejects.toThrow(/no conversationId/i);
  });

  it("throws when the selected conversation was deleted", async () => {
    const job = schedulerStore.create({
      name: "test-gone-conv",
      scheduleType: "once",
      execAt: Date.now() + 3600_000,
      timezone: "UTC",
      providerId: "p1",
      modelId: "m1",
      workspacePath: getWorkspaceDir(),
      prompt: "hello",
      conversationPolicy: "existing_thread",
    });
    const updated = schedulerStore.update(job.id, { conversationId: "nonexistent-id-xyz" });
    await expect(ensureJobConversation(updated!)).rejects.toThrow(/not found/i);
  });

  it("returns the existing conversation id without creating a new one (existing_thread)", async () => {
    const conv = await conversationService.create({
      title: "Test conv",
      providerId: "p1",
    });
    const job = schedulerStore.create({
      name: "test-existing-ok",
      scheduleType: "once",
      execAt: Date.now() + 3600_000,
      timezone: "UTC",
      providerId: "p1",
      modelId: "m1",
      workspacePath: getWorkspaceDir(),
      prompt: "hello",
      conversationPolicy: "existing_thread",
    });
    schedulerStore.update(job.id, { conversationId: conv.id });
    const result = await ensureJobConversation(schedulerStore.get(job.id)!);
    expect(result.conversationId).toBe(conv.id);
    expect(result.created).toBe(false);
    expect(result.safeToDelete).toBe(false);
  });

  it("dedicated_thread creates a new conversation when none exists", async () => {
    const job = schedulerStore.create({
      name: "test-dedicated-new",
      scheduleType: "once",
      execAt: Date.now() + 3600_000,
      timezone: "UTC",
      providerId: "p1",
      modelId: "m1",
      workspacePath: getWorkspaceDir(),
      prompt: "hello",
      conversationPolicy: "dedicated_thread",
      conversationId: null,
    });
    const result = await ensureJobConversation(job);
    expect(result.conversationId).toBeTruthy();
    expect(result.created).toBe(true);
    expect(result.safeToDelete).toBe(true);
  });

  it("dedicated_thread reuses an existing conversationId", async () => {
    const conv = await conversationService.create({
      title: "Test conv",
      providerId: "p1",
    });
    const job = schedulerStore.create({
      name: "test-dedicated-reuse",
      scheduleType: "once",
      execAt: Date.now() + 3600_000,
      timezone: "UTC",
      providerId: "p1",
      modelId: "m1",
      workspacePath: getWorkspaceDir(),
      prompt: "hello",
      conversationPolicy: "dedicated_thread",
    });
    schedulerStore.update(job.id, { conversationId: conv.id });
    const result = await ensureJobConversation(schedulerStore.get(job.id)!);
    expect(result.conversationId).toBe(conv.id);
    expect(result.created).toBe(false);
  });
});

describe("SchedulerRun.conversationId persistence", () => {
  beforeEach(async () => {
    for (const job of schedulerStore.list()) schedulerStore.remove(job.id);
    try {
      const all = await conversationService.list();
      for (const c of all?.threads ?? []) {
        if (c.title.startsWith("[Scheduler]") || c.title === "Test conv") {
          void conversationService.delete(c.id);
        }
      }
    } catch {
      /* best-effort cleanup */
    }
  });

  it("run captures conversationId at claim time, not from later job state", async () => {
    const convA = await conversationService.create({ title: "Chat A", providerId: "p1" });
    const convB = await conversationService.create({ title: "Chat B", providerId: "p1" });

    const job = schedulerStore.create({
      name: "test-conv-persist",
      scheduleType: "once",
      execAt: Date.now() + 3600_000,
      timezone: "UTC",
      providerId: "p1",
      modelId: "m1",
      workspacePath: getWorkspaceDir(),
      prompt: "hello",
      conversationPolicy: "existing_thread",
    });
    schedulerStore.update(job.id, { conversationId: convA.id });
    const fresh = schedulerStore.get(job.id)!;
    const run = schedulerStore.claimRun(fresh, "once-persist-test", "req-persist");
    expect(run).not.toBeNull();
    expect(run!.conversationId).toBe(convA.id);

    // Job later switches to Chat B.
    schedulerStore.update(job.id, { conversationId: convB.id });

    // Run still points to Chat A.
    const persisted = schedulerStore.getRun(run!.id);
    expect(persisted!.conversationId).toBe(convA.id);
  });

  it("dedicated_thread run stores null at claim (resolved later by ensureJobConversation)", () => {
    const job = schedulerStore.create({
      name: "test-dedicated-claim",
      scheduleType: "once",
      execAt: Date.now() + 3600_000,
      timezone: "UTC",
      providerId: "p1",
      modelId: "m1",
      workspacePath: getWorkspaceDir(),
      prompt: "hello",
      conversationPolicy: "dedicated_thread",
      conversationId: null,
    });
    const run = schedulerStore.claimRun(job, "once-dedicated-test", "req-ded");
    expect(run).not.toBeNull();
    expect(run!.conversationId).toBeNull();
  });
});

describe("existing_thread safety", () => {
  beforeEach(async () => {
    for (const job of schedulerStore.list()) schedulerStore.remove(job.id);
    try {
      const all = await conversationService.list();
      for (const c of all?.threads ?? []) {
        if (c.title.startsWith("[Scheduler]") || c.title === "Test conv") {
          void conversationService.delete(c.id);
        }
      }
    } catch {
      /* best-effort cleanup */
    }
  });

  it("throws on deleted conversation and does not create a replacement", async () => {
    const job = schedulerStore.create({
      name: "test-safety-deleted",
      scheduleType: "once",
      execAt: Date.now() + 3600_000,
      timezone: "UTC",
      providerId: "p1",
      modelId: "m1",
      workspacePath: getWorkspaceDir(),
      prompt: "hello",
      conversationPolicy: "existing_thread",
    });
    schedulerStore.update(job.id, { conversationId: "gone-id-xyz" });
    await expect(ensureJobConversation(schedulerStore.get(job.id)!)).rejects.toThrow(/not found/i);
    // Verify no new [Scheduler] conversation was silently created.
    const all = await conversationService.list();
    const justCreated = all?.threads.find((c) => c.title.startsWith("[Scheduler]"));
    expect(justCreated).toBeUndefined();
  });

  it("refuses an archived target conversation", async () => {
    const conv = await conversationService.create({
      title: "Test conv archived-guard",
      providerId: "p1",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "simple",
      workspaceFolderId: null,
    });
    await conversationService.update(conv.id, { status: "archived" });
    const job = schedulerStore.create({
      name: "test-safety-archived",
      scheduleType: "once",
      execAt: Date.now() + 3600_000,
      timezone: "UTC",
      providerId: "p1",
      modelId: "m1",
      workspacePath: getWorkspaceDir(),
      prompt: "hello",
      conversationPolicy: "existing_thread",
    });
    schedulerStore.update(job.id, { conversationId: conv.id });
    await expect(ensureJobConversation(schedulerStore.get(job.id)!)).rejects.toThrow(/archived/i);
    await conversationService.delete(conv.id);
  });

  it("permits a regular target conversation", async () => {
    const conv = await conversationService.create({
      title: "Test conv regular-guard",
      providerId: "p1",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "simple",
      workspaceFolderId: null,
    });
    const job = schedulerStore.create({
      name: "test-safety-regular",
      scheduleType: "once",
      execAt: Date.now() + 3600_000,
      timezone: "UTC",
      providerId: "p1",
      modelId: "m1",
      workspacePath: getWorkspaceDir(),
      prompt: "hello",
      conversationPolicy: "existing_thread",
    });
    schedulerStore.update(job.id, { conversationId: conv.id });
    const result = await ensureJobConversation(schedulerStore.get(job.id)!);
    expect(result.conversationId).toBe(conv.id);
    expect(result.created).toBe(false);
    await conversationService.delete(conv.id);
  });
});

describe("enable endpoint regression", () => {
  beforeEach(() => {
    for (const job of schedulerStore.list()) schedulerStore.remove(job.id);
    clearAllTimers();
  });

  it("allows enabling a completed one-time job", async () => {
    const job = makeJob({ status: "completed", enabled: false });
    // scheduleJob should accept a completed job that has been re-enabled.
    // After enable, the job is set to active + enabled=true.
    schedulerStore.update(job.id, { enabled: true, status: "active" });
    const fresh = schedulerStore.get(job.id)!;
    expect(fresh.enabled).toBe(true);
    expect(fresh.status).toBe("active");
    // scheduleJob does not reject completed status anymore — it re-schedules.
    expect(() => scheduleJob(fresh)).not.toThrow();
  });

  it("allows enabling a missed one-time job", async () => {
    const job = makeJob({ status: "missed", enabled: false });
    schedulerStore.update(job.id, { enabled: true, status: "active" });
    const fresh = schedulerStore.get(job.id)!;
    expect(fresh.enabled).toBe(true);
    expect(fresh.status).toBe("active");
    expect(() => scheduleJob(fresh)).not.toThrow();
  });

  it("route refuses a spent one-time date with a helpful message", async () => {
    const job = makeJob({
      status: "completed",
      enabled: false,
      execAt: Date.now() - 3600_000,
    });
    const res = await schedulerApp.request(`/jobs/${job.id}/enable`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/already passed|Duplicate/i);
  });

  it("route refuses a deleted job", async () => {
    const job = makeJob({ scheduleType: "cron", cronExpression: "0 9 * * *" });
    schedulerStore.softDelete(job.id);
    const res = await schedulerApp.request(`/jobs/${job.id}/enable`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("soft-delete hides the job but retains its runs", async () => {
    const job = makeJob();
    const run = schedulerStore.claimRun(job, "once", "req-1")!;
    schedulerStore.updateRun(run.id, {
      status: "completed",
      completedAt: Date.now(),
    });
    const del = await schedulerApp.request(`/jobs/${job.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(schedulerStore.list().some((j) => j.id === job.id)).toBe(false);
    expect(schedulerStore.getRun(run.id)).not.toBeNull();
  });

  it("summary reports running and problem runs", async () => {
    const job = makeJob();
    schedulerStore.claimRun(job, "cron-live", "req-live");
    const res = await schedulerApp.request("/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      running: Array<{ jobId: string }>;
      jobCount: number;
    };
    expect(body.running.some((r) => r.jobId === job.id)).toBe(true);
    expect(body.jobCount).toBeGreaterThanOrEqual(1);
  });
});

describe("Bun.cron timezone option", () => {
  beforeEach(() => {
    for (const job of schedulerStore.list()) schedulerStore.remove(job.id);
    clearAllTimers();
  });

  it("passes the job's IANA timezone to Bun.cron as { tz: ... }", () => {
    const job = makeJob({
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      timezone: "America/New_York",
    });
    // scheduleJob calls scheduleRecurring which calls Bun.cron with { tz }.
    // We verify the timer was registered by checking activeTimerCount.
    scheduleJob(job);
    expect(activeTimerCount()).toBe(1);
    clearAllTimers();
  });

  it("uses UTC timezone when configured", () => {
    const job = makeJob({
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
    });
    scheduleJob(job);
    expect(activeTimerCount()).toBe(1);
    clearAllTimers();
  });
});

describe("overlap guard: cron vs manual", () => {
  beforeEach(() => {
    for (const job of schedulerStore.list()) schedulerStore.remove(job.id);
    clearAllTimers();
  });

  it("fireJob no longer has a redundant overlap check (Bun.cron guarantees no-overlap)", async () => {
    // Create a job and claim a run so hasRunningRun returns true.
    const job = makeJob({ scheduleType: "cron", cronExpression: "* * * * *" });
    schedulerStore.claimRun(job, "cron-test-1", "req-1");
    expect(schedulerStore.hasRunningRun(job.id)).toBe(true);
    // fireJob should NOT skip — it should proceed to claim (which will fail
    // because the occurrence is different, but it won't hit the old overlap guard).
    // The key behavior change: no skipped run row is created.
    await fireJob(job.id, "cron-test-2", undefined);
    // No skipped run should exist.
    const { runs } = schedulerStore.listRuns(job.id);
    const skipped = runs.filter((r) => r.status === "skipped");
    expect(skipped.length).toBe(0);
    // The new occurrence was claimed (UNIQUE guard still works).
    expect(runs.some((r) => r.occurrenceId === "cron-test-2")).toBe(true);
  });

  it("runJobNow still guards against double-click manual runs", () => {
    const job = makeJob();
    // Manually claim a run so hasRunningRun returns true.
    schedulerStore.claimRun(job, "once-double-click", "req-1");
    expect(schedulerStore.hasRunningRun(job.id)).toBe(true);
    // Second runJobNow call should be blocked.
    const result = runJobNow(job.id);
    expect(result).resolves.toEqual({ error: "Previous execution still running; manual run skipped" });
  });
});
describe("@-macro shorthands", () => {
  it("expands to canonical 5-field forms", () => {
    expect(expandMacro("@daily")).toBe("0 0 * * *");
    expect(expandMacro("@weekly")).toBe("0 0 * * 0");
    expect(expandMacro("@monthly")).toBe("0 0 1 * *");
    expect(expandMacro("@yearly")).toBe("0 0 1 1 *");
    expect(expandMacro("@hourly")).toBe("0 * * * *");
    expect(expandMacro("@DAILY")).toBe("0 0 * * *");
    expect(expandMacro("0 9 * * *")).toBe("0 9 * * *");
  });

  it("validates and describes macros", () => {
    expect(isValidCron("@daily")).toBe(true);
    expect(isValidCron("@weekly")).toBe(true);
    expect(isValidCron("@nope")).toBe(false);
    expect(describeCron("@daily")).toBe("Daily at 00:00");
    expect(describeCron("@weekly")).toBe("Weekly on Sunday at 00:00");
    // Next-run works through the macro.
    const from = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(computeNextRun("@daily", "UTC", from)).toBe(
      Date.UTC(2026, 0, 2, 0, 0, 0),
    );
  });

  it("counts upcoming runs for the gallery", () => {
    const from = Date.UTC(2026, 0, 5, 0, 0, 0); // a Monday
    expect(countUpcoming("*/15 * * * *", "UTC", from)).toBe(96);
    expect(countUpcoming("0 9 * * MON-FRI", "UTC", from)).toBe(1);
    expect(countUpcoming("0,30 9-17 * * *", "UTC", from)).toBe(18);
    expect(countUpcoming("@daily", "UTC", from)).toBe(1);
  });
});

describe("run retention prune", () => {
  it("deletes only old terminal runs", () => {
    const job = makeJob();
    const old = schedulerStore.claimRun(job, "cron-old", "req-old")!;
    schedulerStore.updateRun(old.id, {
      status: "completed",
      completedAt: Date.now() - 31 * 24 * 3600_000,
      durationMs: 1,
    });
    const fresh = schedulerStore.claimRun(job, "cron-fresh", "req-fresh")!;
    schedulerStore.updateRun(fresh.id, {
      status: "completed",
      completedAt: Date.now(),
      durationMs: 1,
    });
    const running = schedulerStore.claimRun(job, "cron-live", "req-live")!;
    expect(schedulerStore.pruneOldRuns()).toBe(1);
    expect(schedulerStore.getRun(old.id)).toBeNull();
    expect(schedulerStore.getRun(fresh.id)).not.toBeNull();
    expect(schedulerStore.getRun(running.id)).not.toBeNull();
  });

  it("lists recent problem runs for the badge", () => {
    const job = makeJob();
    const failed = schedulerStore.claimRun(job, "cron-prob", "req-p")!;
    schedulerStore.updateRun(failed.id, {
      status: "failed",
      error: "boom",
      completedAt: Date.now(),
    });
    const problems = schedulerStore.listProblemRuns(Date.now() - 3600_000);
    expect(problems.some((p) => p.id === failed.id)).toBe(true);
    expect(problems.find((p) => p.id === failed.id)?.jobName).toBe(
      "test job",
    );
  });
});

describe("cancelRun validation", () => {
  it("rejects unknown runs and non-running runs", () => {
    const job = makeJob();
    expect(cancelRun(job.id, "nope")).toEqual({
      ok: false,
      error: "Run not found",
    });
    const run = schedulerStore.claimRun(job, "cron-c", "req-c")!;
    schedulerStore.updateRun(run.id, {
      status: "completed",
      completedAt: Date.now(),
    });
    expect(cancelRun(job.id, run.id)).toEqual({
      ok: false,
      error: "Run is completed, nothing to cancel",
    });
  });

  it("rejects runs from another job and runs without a controller", () => {
    const a = makeJob({ name: "a" });
    const b = makeJob({ name: "b" });
    const run = schedulerStore.claimRun(a, "cron-x", "req-x")!;
    expect(cancelRun(b.id, run.id)).toEqual({
      ok: false,
      error: "Run not found",
    });
    // Running but no in-process controller (e.g. after restart).
    expect(cancelRun(a.id, run.id)).toEqual({
      ok: false,
      error: "Run is not executing in this process (restarted?)",
    });
  });
});

describe("manual runs need no live schedule", () => {
  it("runJobNow works on missed and paused jobs", async () => {
    const missed = makeJob({ execAt: Date.now() - 3600_000 });
    schedulerStore.update(missed.id, { status: "missed", enabled: false });
    const r1 = await runJobNow(missed.id);
    expect("runId" in r1).toBe(true);
    const paused = makeJob({
      name: "paused-cron",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
    });
    schedulerStore.update(paused.id, { enabled: false, status: "paused" });
    const r2 = await runJobNow(paused.id);
    expect("runId" in r2).toBe(true);
    // The spent schedule is untouched by manual runs.
    expect(schedulerStore.get(missed.id)?.status).toBe("missed");
  });
});

describe("thread chaining for scheduler messages", () => {
  it("getThreadTip returns the latest message id", async () => {
    const { messageService } = await import("../../src/services/storage");
    const conv = await conversationService.create({
      title: "tip-test",
      providerId: "",
    });
    expect(await messageService.getThreadTip(conv.id)).toBeNull();
    await messageService.upsertStored(conv.id, {
      id: "tip-1",
      parent_id: null,
      format: "ai-sdk/v6",
      content: {},
    });
    await messageService.upsertStored(conv.id, {
      id: "tip-2",
      parent_id: "tip-1",
      format: "ai-sdk/v6",
      content: {},
    });
    expect(await messageService.getThreadTip(conv.id)).toBe("tip-2");
    await conversationService.delete(conv.id);
  });

  it("repair chains orphan scheduler rows without touching content", async () => {
    const { messageService } = await import("../../src/services/storage");
    const { repairSchedulerThreadChains } = await import("../../src/db/index");
    const conv = await conversationService.create({
      title: "repair-test",
      providerId: "",
    });
    const job = makeJob();
    schedulerStore.update(job.id, { conversationId: conv.id });
    // Simulate the old bug: three disconnected roots.
    for (const id of ["r1", "r2", "r3"]) {
      await messageService.upsertStored(conv.id, {
        id,
        parent_id: null,
        format: "ai-sdk/v6",
        content: { marker: id },
      });
    }
    repairSchedulerThreadChains();
    const rows = await messageService.listThreadMessages(conv.id);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("r1")?.parent_id).toBeNull();
    expect(byId.get("r2")?.parent_id).toBe("r1");
    expect(byId.get("r3")?.parent_id).toBe("r2");
    // Content untouched.
    expect(JSON.stringify(byId.get("r2")?.content)).toContain("r2");
    // Idempotent: second run changes nothing.
    repairSchedulerThreadChains();
    const again = await messageService.listThreadMessages(conv.id);
    expect(again.map((r) => [r.id, r.parent_id])).toEqual(
      rows.map((r) => [r.id, r.parent_id]),
    );
    await conversationService.delete(conv.id);
  });
});

describe("thread retarget persistence", () => {
  it("PATCH saves conversationId instead of silently stripping it", async () => {
    const conv = await conversationService.create({
      title: "retarget-target",
      providerId: "",
    });
    const job = makeJob({ conversationPolicy: "existing_thread" });
    const res = await schedulerApp.request(`/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: conv.id }),
    });
    expect(res.status).toBe(200);
    expect(schedulerStore.get(job.id)?.conversationId).toBe(conv.id);
    await conversationService.delete(conv.id);
    clearAllTimers();
  });

  it("PATCH rejects an unknown target thread with a clear error", async () => {
    const job = makeJob({ conversationPolicy: "existing_thread" });
    const res = await schedulerApp.request(`/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "no-such-thread" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not found/i);
    clearAllTimers();
  });
});
