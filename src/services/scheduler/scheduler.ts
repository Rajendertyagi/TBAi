/**
 * Scheduler coordinator.
 *
 * SQLite is authoritative. This module only keeps an in-memory map of
 * active timer handles (Bun.cron jobs for recurring schedules, setTimeout
 * handles for one-time jobs) and rebuilds them from the database on
 * startup, on job changes, and on recovery.
 */
import { db } from "../../db";
import type { Database } from "bun:sqlite";
import { logger, newRequestId } from "../../lib/logger";
import type { SchedulerJob } from "./schedulerTypes";
import { isTerminalJobStatus } from "./schedulerTypes";
import { schedulerStore } from "./schedulerStore";
import {
  computeNextRun,
  cronOccurrenceId,
  manualOccurrenceId,
  onceOccurrenceId,
  parseCron,
} from "./cron";
import { executeJobRun, ensureJobConversation } from "./schedulerExecution";

// Minimal shape of the Bun.cron handle (no @types/bun cron typings in 1.4.2).
interface CronHandle {
  stop(): void;
  unref?(): void;
  ref?(): void;
}

declare const Bun: {
  cron(
    expression: string,
    callback: () => void | Promise<void>,
    options?: { timezone?: string; tz?: string },
  ): CronHandle;
};

interface TimerEntry {
  kind: "cron" | "once";
  cronHandle?: CronHandle;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

const timers = new Map<string, TimerEntry>();

/** In-flight run abort controllers, keyed by run id (cancel-run support). */
const runControllers = new Map<string, AbortController>();

/**
 * Create and register an abort controller for a run. The controller is
 * removed when the run settles. Used by fire paths; cancelRun aborts it.
 */
function controllerForRun(runId: string): AbortSignal {
  const controller = new AbortController();
  runControllers.set(runId, controller);
  return controller.signal;
}

function releaseRun(runId: string): void {
  runControllers.delete(runId);
}

/**
 * Cancel a running run: aborts its AI execution; executeJobRun records the
 * run as cancelled. Returns ok:false with an error when there is nothing
 * cancellable (unknown run, wrong job, or not running).
 */
export function cancelRun(
  jobId: string,
  runId: string,
  database: Database = db,
): { ok: true } | { ok: false; error: string } {
  const run = schedulerStore.getRun(runId, database);
  if (!run || run.jobId !== jobId) {
    return { ok: false, error: "Run not found" };
  }
  if (run.status !== "running") {
    return { ok: false, error: `Run is ${run.status}, nothing to cancel` };
  }
  const controller = runControllers.get(runId);
  if (!controller) {
    return {
      ok: false,
      error: "Run is not executing in this process (restarted?)",
    };
  }
  controller.abort();
  logger.info("scheduler", "scheduler.run_cancel_requested", {
    jobId,
    runId,
    occurrenceId: run.occurrenceId,
  });
  return { ok: true };
}

function clearTimer(jobId: string): void {
  const entry = timers.get(jobId);
  if (!entry) return;
  timers.delete(jobId);
  try {
    if (entry.kind === "cron") entry.cronHandle?.stop();
    else clearTimeout(entry.timeoutHandle);
  } catch {
    /* timer teardown is best-effort */
  }
}

function slotOccurrenceId(): string {
  return cronOccurrenceId(Date.now());
}

/**
 * Core fire path: overlap check → atomic claim → execute.
 * The UNIQUE(job_id, occurrence_id) insert is the duplicate guard;
 * a conflicting insert means "already claimed" and we do not execute.
 */
export async function fireJob(
  jobId: string,
  occurrenceId: string,
  database: Database = db,
): Promise<void> {
  const job = schedulerStore.get(jobId, database);
  if (!job) {
    logger.warn("scheduler", "scheduler.job_due", {
      jobId,
      occurrenceId,
      message: "Job no longer exists; ignoring fire",
    });
    return;
  }
  if (!job.enabled || job.status !== "active") {
    logger.info("scheduler", "scheduler.job_due", {
      jobId,
      occurrenceId,
      message: "Job disabled or not active; ignoring fire",
    });
    return;
  }
  const requestId = newRequestId();
  logger.info("scheduler", "scheduler.job_due", {
    requestId,
    jobId,
    occurrenceId,
  });

  // Bun.cron guarantees no-overlap: the next fire is scheduled only after the
  // handler Promise settles, so invocations never stack. The overlap guard
  // below remains for manual "Run now" (runJobNow) where two rapid clicks can
  // bypass Bun's guarantee.
  const run = schedulerStore.claimRun(job, occurrenceId, requestId, database);
  if (!run) {
    logger.info("scheduler", "scheduler.run_skipped", {
      requestId,
      jobId,
      occurrenceId,
      message: "Occurrence already claimed; duplicate fire ignored",
    });
    return;
  }
  logger.info("scheduler", "scheduler.run_claimed", {
    requestId,
    jobId,
    occurrenceId,
    runId: run.id,
  });

  // Resolve the conversation used for this execution and persist it on the run.
  // This captures the exact conversation at claim time, so later job edits
  // do not alter historical run records.
  let resolvedConversationId: string | undefined;
  try {
    const conv = await ensureJobConversation(job);
    resolvedConversationId = conv.conversationId;
    schedulerStore.updateRun(run.id, { conversationId: conv.conversationId }, database);
  } catch (err) {
    logger.warn("scheduler", "scheduler.run_failed", {
      requestId,
      jobId,
      occurrenceId,
      runId: run.id,
      message: err instanceof Error ? err.message : "Conversation setup failed",
    });
  }

  let result;
  try {
    result = await executeJobRun(
      job,
      run,
      resolvedConversationId ?? "",
      controllerForRun(run.id),
    );
  } finally {
    releaseRun(run.id);
  }

  // One-time jobs reach a terminal state after the terminal attempt.
  if (job.scheduleType === "once" && !occurrenceId.startsWith("manual-")) {
    if (result.ok) {
      schedulerStore.update(job.id, {
        status: "completed",
        enabled: false,
        nextRunAt: null,
      });
      clearTimer(job.id);
    } else if (!result.retryable) {
      schedulerStore.update(job.id, { status: "failed" });
      clearTimer(job.id);
    }
    // Retryable failure on a once job: leave active so a later manual run
    // or an operator can retry; the timer is gone (it already fired).
  }

  // Recurring jobs: refresh next_run_at bookkeeping after each fire.
  if (job.scheduleType === "cron" && job.cronExpression) {
    try {
      const next = computeNextRun(
        job.cronExpression,
        job.timezone,
        Date.now(),
      );
      schedulerStore.update(job.id, { nextRunAt: next });
    } catch {
      /* keep the previous next_run_at; the cron timer still fires */
    }
  }
}

function scheduleRecurring(job: SchedulerJob): void {
  clearTimer(job.id);
  if (!job.cronExpression) return;
  parseCron(job.cronExpression); // throws on invalid; caller handles
  const expression = job.cronExpression;
  const timezone = job.timezone;
  const jobId = job.id;
  const handle = Bun.cron(
    expression,
    () => {
      void fireJob(jobId, slotOccurrenceId());
    },
    { tz: job.timezone },
  );
  try {
    handle.unref?.();
  } catch {
    /* unref is best-effort */
  }
  timers.set(job.id, { kind: "cron", cronHandle: handle });
  try {
    const next = computeNextRun(expression, timezone, Date.now());
    schedulerStore.update(job.id, { nextRunAt: next });
  } catch {
    /* preview is best-effort; the timer still fires */
  }
}

function scheduleOnce(job: SchedulerJob): void {
  clearTimer(job.id);
  if (job.execAt == null) return;
  const delay = job.execAt - Date.now();
  if (delay <= 0) {
    // Overdue at (re)schedule time → apply the missed-run policy now.
    void handleOverdueOnce(job);
    return;
  }
  const jobId = job.id;
  const handle = setTimeout(() => {
    void fireJob(jobId, onceOccurrenceId());
  }, delay);
  try {
    (handle as unknown as { unref?: () => void }).unref?.();
  } catch {
    /* ignore */
  }
  timers.set(job.id, { kind: "once", timeoutHandle: handle });
  schedulerStore.update(job.id, { nextRunAt: job.execAt });
}

/**
 * Missed-run policy for one-time jobs whose exec_at is in the past:
 * within the grace window → run once now; otherwise record missed/expired
 * and never execute late.
 */
export async function handleOverdueOnce(
  job: SchedulerJob,
  database: Database = db,
): Promise<void> {
  const now = Date.now();
  const overdueSec = Math.floor((now - (job.execAt ?? now)) / 1000);
  const requestId = newRequestId();
  if (overdueSec <= Math.max(0, job.missedGraceSeconds)) {
    logger.info("scheduler", "scheduler.job_due", {
      requestId,
      jobId: job.id,
      occurrenceId: onceOccurrenceId(),
      message: `One-time job overdue by ${overdueSec}s but within grace; running once`,
    });
    await fireJob(job.id, onceOccurrenceId(), database);
    return;
  }
  schedulerStore.recordTerminalRun(
    job,
    onceOccurrenceId(),
    "missed",
    `Missed: exec_at was ${overdueSec}s ago, beyond the ${job.missedGraceSeconds}s grace window`,
    requestId,
    database,
  );
  schedulerStore.update(job.id, {
    status: "missed",
    enabled: false,
    nextRunAt: null,
  });
  clearTimer(job.id);
  logger.info("scheduler", "scheduler.run_missed", {
    requestId,
    jobId: job.id,
    occurrenceId: onceOccurrenceId(),
  });
}

/** (Re)schedule a single active job from its database state. */
export function scheduleJob(job: SchedulerJob): void {
  if (!job.enabled || job.status !== "active") {
    clearTimer(job.id);
    schedulerStore.update(job.id, { nextRunAt: null });
    return;
  }
  if (isTerminalJobStatus(job.status)) {
    clearTimer(job.id);
    return;
  }
  if (job.scheduleType === "cron") {
    scheduleRecurring(job);
  } else {
    scheduleOnce(job);
  }
}

/** Drop a job's timer (disable/delete path). */
export function unscheduleJob(jobId: string): void {
  clearTimer(jobId);
}

/** Manual "Run now": a fresh explicit occurrence, never colliding with schedule. */
export async function runJobNow(jobId: string): Promise<{ runId: string } | { error: string }> {
  const job = schedulerStore.get(jobId);
  if (!job) return { error: "Job not found" };
  const occurrenceId = manualOccurrenceId();
  const requestId = newRequestId();
  if (
    job.overlapPolicy === "skip_if_running" &&
    schedulerStore.hasRunningRun(job.id)
  ) {
    schedulerStore.recordTerminalRun(
      job,
      `${occurrenceId}-skip`,
      "skipped",
      "Skipped: previous execution still running (overlap policy skip_if_running)",
      requestId,
    );
    return { error: "Previous execution still running; manual run skipped" };
  }
  const run = schedulerStore.claimRun(job, occurrenceId, requestId);
  if (!run) return { error: "Occurrence already claimed" };
  logger.info("scheduler", "scheduler.run_claimed", {
    requestId,
    jobId,
    occurrenceId,
    runId: run.id,
  });
  const conv = await ensureJobConversation(job);
  schedulerStore.updateRun(run.id, { conversationId: conv.conversationId });
  const signal = controllerForRun(run.id);
  void executeJobRun(job, run, conv.conversationId, signal).finally(() =>
    releaseRun(run.id),
  );
  return { runId: run.id };
}

export interface RecoveryReport {
  interrupted: number;
  prunedRuns: number;
  rebuiltRecurring: number;
  rebuiltOnce: number;
  missed: number;
  ranFromGrace: number;
}

/** Startup recovery: reconcile interrupted runs, rebuild timers, apply missed policy. */
export async function recover(database: Database = db): Promise<RecoveryReport> {
  logger.info("scheduler", "scheduler.recovery_started", {});
  const report: RecoveryReport = {
    interrupted: 0,
    prunedRuns: 0,
    rebuiltRecurring: 0,
    rebuiltOnce: 0,
    missed: 0,
    ranFromGrace: 0,
  };
  report.interrupted = schedulerStore.markInterrupted(database);
  report.prunedRuns = schedulerStore.pruneOldRuns(undefined, database);

  const jobs = schedulerStore.listEnabled(database);
  for (const job of jobs) {
    try {
      if (job.scheduleType === "cron") {
        if (!job.cronExpression) {
          logger.warn("scheduler", "scheduler.recovery_completed", {
            jobId: job.id,
            message: "Recurring job has no cron expression; left unscheduled",
          });
          continue;
        }
        parseCron(job.cronExpression);
        scheduleRecurring(job);
        report.rebuiltRecurring += 1;
      } else {
        if (job.execAt == null) continue;
        if (job.execAt <= Date.now()) {
          const overdueSec = Math.floor(
            (Date.now() - job.execAt) / 1000,
          );
          await handleOverdueOnce(job, database);
          if (overdueSec <= Math.max(0, job.missedGraceSeconds)) {
            report.ranFromGrace += 1;
          } else {
            report.missed += 1;
          }
        } else {
          scheduleOnce(job);
          report.rebuiltOnce += 1;
        }
      }
    } catch (err) {
      logger.warn("scheduler", "scheduler.recovery_completed", {
        jobId: job.id,
        message: err instanceof Error ? err.message : "Recovery failed for job",
      });
      schedulerStore.update(
        job.id,
        { enabled: false, status: "failed", nextRunAt: null },
        database,
      );
    }
  }
  logger.info("scheduler", "scheduler.recovery_completed", {
    ...report,
  });
  return report;
}

/** Boot the scheduler: recover + rebuild all timers. Call once at startup. */
export async function initScheduler(): Promise<RecoveryReport> {
  return recover(db);
}

/** For tests: how many active timer handles are cached. */
export function activeTimerCount(): number {
  return timers.size;
}

/** For tests/shutdown: clear all cached timers without touching the DB. */
export function clearAllTimers(): void {
  for (const jobId of [...timers.keys()]) clearTimer(jobId);
}
