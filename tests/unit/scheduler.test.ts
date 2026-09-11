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
} from "../../src/services/scheduler/cron";
import { schedulerStore } from "../../src/services/scheduler/schedulerStore";
import type { JobCreate } from "../../src/services/scheduler/schedulerStore";
import type { SchedulerJob } from "../../src/services/scheduler/schedulerTypes";
import {
  isRetryableError,
  verifyJobWorkspace,
  buildSchedulerTools,
} from "../../src/services/scheduler/schedulerExecution";
import { handleOverdueOnce } from "../../src/services/scheduler/scheduler";
import { getWorkspaceDir } from "../../src/services/tools";

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
