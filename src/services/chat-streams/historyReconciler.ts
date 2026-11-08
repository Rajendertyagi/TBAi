import { logger } from "../../lib/logger";
import { chatStreamStore } from "../../lib/resumable";
import {
  chatHistoryFinalizerDeps,
  finalizeDetachedRunHistory,
  parseCapturedFinalMessage,
  type HistoryFinalizeOutcome,
  type HistoryFinalizerDeps,
  type HistoryFinalizerStore,
} from "./historyFinalizer";
import type { SqliteResumableStreamStore } from "./sqliteResumableStore";

/**
 * Durable reconciliation of completed runs whose assistant history is still
 * outstanding.
 *
 * Why this exists: `routes/chat/index.ts` finalizes a completed run server-side
 * only when it *knows* the client detached. When the run completes while the server
 * still believes a browser is attached, the server deliberately writes nothing —
 * the assistant-ui `ThreadHistoryAdapter` owns persistence. That ownership is
 * an assumption about the future, and a client that dies, loses the network, or
 * errors inside the adapter after the last chunk never discharges it. The
 * durable row then sits at `status='done' + terminal_kind='completed' +
 * history_state='pending'` with no writer left in existence, and the client's
 * honest "couldn't reconnect this reply" is the visible symptom.
 *
 * What it does: re-offers the run's own captured final message to the existing
 * finalizer. It is not a second writer, a retry of the failed path, or a repair
 * of the bytes — the message was already validated and stored at settlement, so
 * reconciliation re-runs one guarded transition and nothing else.
 *
 * What it deliberately does not do:
 *  - it never finalizes a `failed`, `cancelled` or `interrupted` run. The store's
 *    claim is guarded on `terminal_kind='completed'`, and so is this scan;
 *  - it never DUPLICATES a row the client already persisted. The reply it offers is
 *    keyed by the run's own message id, so a stored row holding that same reply is
 *    closed as `already_persisted` with nothing rewritten, and one holding anything
 *    else is replaced in place (`repaired` — same row, same position). The captured
 *    reply is the run's own validated output, so it is the authority for what that
 *    id contains; the alternative is closing an obligation `done` over a row that
 *    holds a stale, truncated, or contentless variant of it;
 *  - it never invents content. A row with no usable captured message is reported
 *    and closed as `skipped`, not reconstructed from replayable bytes;
 *  - it never deletes rows, and is not part of retention. `cleanup.ts` remains
 *    solely responsible for expiry.
 *
 * Lifecycle: a boot tick plus an interval, mirroring `cleanup.ts` — idempotent
 * start, `unref`'d timer, explicit stop, and a single in-flight tick so two
 * passes can never overlap.
 *
 * ADR: docs/decisions.md "ADR: Direct Chat durable resumable streams".
 */

/** How often outstanding completed-run history is reconciled. */
export const DEFAULT_HISTORY_RECONCILE_INTERVAL_MS = 60 * 1000;

/**
 * How long after a run settles it may be reconciled.
 *
 * This is what keeps the normal attached path untouched: the client is given a
 * grace window to persist through its own adapter before the server considers
 * the obligation outstanding. Without it, reconciliation would race every
 * healthy run in the app.
 */
export const DEFAULT_HISTORY_RECONCILE_GRACE_MS = 60 * 1000;

/** Rows examined per tick, so a large backlog is drained over several passes. */
export const DEFAULT_HISTORY_RECONCILE_LIMIT = 50;

/** The store surface reconciliation needs: the finalizer's, plus the scan. */
export type HistoryReconcilerStore = HistoryFinalizerStore &
  Pick<SqliteResumableStreamStore, "listPendingCompletedHistory">;

export interface HistoryReconcilerDeps extends HistoryFinalizerDeps {
  store: HistoryReconcilerStore;
}

/** What one pass did. Counts only — never message text or prompts. */
export interface HistoryReconcileReport {
  /** Outstanding rows the pass looked at. */
  scanned: number;
  /** Assistant messages written because nobody else had. */
  written: number;
  /** Obligations closed because the stored row already held this exact reply. */
  alreadyPersisted: number;
  /** Closed with no usable message (aborted, corrupt, or no conversation). */
  skipped: number;
  /** Claims lost to a concurrent finalizer; correct, not an error. */
  notClaimed: number;
  /** Write attempts that threw; the row was marked `skipped`, never left claimed. */
  failed: number;
  /** Rows with no captured final message at all, so nothing could be written. */
  unrecoverable: number;
  /** Stored rows that existed but did not match the capture and were replaced. */
  repaired: number;
  /**
   * Obligations left UNRESOLVED because the stored message contradicts them
   * (identity, ownership, or parent). The row stays `claimed` for the next sweep,
   * and is reported here rather than counted as a write failure or a skip.
   */
  conflicted: number;
}

export interface StartHistoryReconciliationOptions {
  deps: HistoryReconcilerDeps;
  intervalMs?: number;
  graceMs?: number;
  limit?: number;
  now?: () => number;
  /** Skip the immediate first tick (used to isolate timer behaviour in tests). */
  runImmediately?: boolean;
  /**
   * A boot-time promise that must settle before ANY pass scans.
   *
   * Boot recovery of abandoned history claims (`claimedHistoryRecovery`) runs at
   * startup and touches the same stream rows and the same message store this
   * reconciler writes. Gating the first pass on it keeps the two from overlapping:
   * reconciliation never begins until recovery has completed (or failed, which it
   * reports itself). It is not an error for the gate to reject — recovery owns its
   * own failure logging — so a rejection is swallowed and the pass proceeds.
   */
  gate?: Promise<unknown>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let intervalMs = DEFAULT_HISTORY_RECONCILE_INTERVAL_MS;
let ticks = 0;
let inFlight = false;
/**
 * The currently running reconciliation tick, if any. Stored so shutdown can
 * drain it: clearing the timer stops future ticks, but a tick already writing
 * must complete before the database closes.
 */
let inflightTick: Promise<unknown> | null = null;
let deps: HistoryReconcilerDeps | null = null;
let graceMs = DEFAULT_HISTORY_RECONCILE_GRACE_MS;
let limit = DEFAULT_HISTORY_RECONCILE_LIMIT;
let now: () => number = Date.now;
/**
 * Boot recovery that must settle before the first pass scans. Awaiting a promise
 * that is already resolved is a no-op, so this is cheap on every later tick.
 */
let bootGate: Promise<unknown> | null = null;

/** Observable timer state, so lifecycle behaviour is testable without fake timers. */
export function getHistoryReconciliationState(): {
  running: boolean;
  intervalMs: number;
  ticks: number;
  inFlight: boolean;
} {
  return { running: timer !== null, intervalMs, ticks, inFlight };
}

function countOutcome(report: HistoryReconcileReport, outcome: HistoryFinalizeOutcome): void {
  if (outcome === "written") report.written += 1;
  else if (outcome === "repaired") report.repaired += 1;
  else if (outcome === "already_persisted") report.alreadyPersisted += 1;
  else if (outcome === "not_claimed") report.notClaimed += 1;
  else if (outcome === "skipped") report.skipped += 1;
  else if (outcome === "conflicted") report.conflicted += 1;
  else report.failed += 1;
}

/**
 * Run one reconciliation pass. Never throws: a bookkeeping failure here must not
 * take the server down, so it is reported as a logged error and a null report.
 *
 * Returns null when reconciliation was never started, or when a pass is already
 * in flight — the second case is a deliberate no-op, because a pass that
 * overlaps another could only contend for claims it is already the loser of.
 */
export async function runHistoryReconciliationOnce(): Promise<HistoryReconcileReport | null> {
  if (!deps) return null;
  if (inFlight) {
    logger.debug("chat", "chat_history_reconcile_overlapped", { signal: "interval" });
    return null;
  }

  inFlight = true;
  let resolveTick!: () => void;
  inflightTick = new Promise<void>((resolve) => {
    resolveTick = resolve;
  });
  const report: HistoryReconcileReport = {
    scanned: 0,
    written: 0,
    alreadyPersisted: 0,
    skipped: 0,
    notClaimed: 0,
    failed: 0,
    unrecoverable: 0,
    repaired: 0,
    conflicted: 0,
  };

  try {
    // Wait for boot recovery before scanning: it writes the same rows and the same
    // message store, so the first pass must not start until it has finished. The
    // tick promise is already live, so a shutdown draining this tick also drains
    // the gated work. A rejecting gate is recovery's own logged failure, not ours.
    if (bootGate) {
      try {
        await bootGate;
      } catch {
        /* claimedHistoryRecovery logs its own failures */
      }
    }

    const rows = deps.store.listPendingCompletedHistory({
      before: now() - graceMs,
      limit,
    });
    report.scanned = rows.length;

    for (const row of rows) {
      const message = parseCapturedFinalMessage(row.finalMessageJson);
      if (message === null) {
        // The run either predates capture or had no persistable message. There is
        // nothing to write and nothing to invent, so the obligation is closed
        // truthfully rather than left pending forever.
        deps.store.skipHistory(row.streamId);
        report.unrecoverable += 1;
        logger.warn("chat", "chat_history_reconcile_unrecoverable", {
          streamId: row.streamId,
          conversationId: row.conversationId ?? undefined,
          reason: row.finalMessageJson === null ? "no_captured_message" : "unreadable_capture",
        });
        continue;
      }

      // `isAborted: false` is the captured fact, not a guess: a run that was
      // aborted failed `validateFinalMessage` at settlement and therefore never
      // reached storage, so no captured message can describe an aborted run.
      const outcome = await finalizeDetachedRunHistory(deps, {
        streamId: row.streamId,
        responseMessage: message,
        isAborted: false,
        parentId: row.finalParentId,
      });
      countOutcome(report, outcome);
    }

    ticks += 1;
    if (report.scanned > 0) {
      logger.info("chat", "chat_history_reconciled", {
        signal: "interval",
        scanned: report.scanned,
        written: report.written,
        alreadyPersisted: report.alreadyPersisted,
        skipped: report.skipped,
        notClaimed: report.notClaimed,
        failed: report.failed,
        unrecoverable: report.unrecoverable,
        repaired: report.repaired,
        conflicted: report.conflicted,
      });
    }
    return report;
  } catch (error) {
    logger.error("chat", "chat_history_reconcile_failed", {
      signal: "interval",
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return null;
  } finally {
    inFlight = false;
    inflightTick = null;
    resolveTick();
  }
}

/**
 * Start the reconciliation timer, running one pass immediately so anything left
 * outstanding by a previous process is settled at boot rather than an interval
 * later. Idempotent: a second call while running changes nothing.
 */
export function startHistoryReconciliation(options: StartHistoryReconciliationOptions): {
  started: boolean;
  alreadyRunning: boolean;
} {
  if (timer !== null) return { started: false, alreadyRunning: true };

  deps = options.deps;
  intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_HISTORY_RECONCILE_INTERVAL_MS);
  graceMs = Math.max(0, options.graceMs ?? DEFAULT_HISTORY_RECONCILE_GRACE_MS);
  limit = Math.max(1, options.limit ?? DEFAULT_HISTORY_RECONCILE_LIMIT);
  now = options.now ?? Date.now;
  bootGate = options.gate ?? null;
  ticks = 0;

  if (options.runImmediately !== false) {
    // Fire-and-forget: boot must not block on history bookkeeping.
    void runHistoryReconciliationOnce().catch(() => {
      /* runHistoryReconciliationOnce already swallows and logs */
    });
  }

  timer = setInterval(() => {
    void runHistoryReconciliationOnce().catch(() => {
      /* already logged inside */
    });
  }, intervalMs);
  // A bookkeeping timer must never be the reason the process stays alive.
  (timer as unknown as { unref?: () => void }).unref?.();
  return { started: true, alreadyRunning: false };
}

/** Clear the timer. Safe to call when not running. */
export function stopHistoryReconciliation(): boolean {
  if (timer === null) return false;
  clearInterval(timer);
  timer = null;
  deps = null;
  bootGate = null;
  return true;
}

/**
 * Await the currently running reconciliation tick, if any. Resolves
 * immediately when idle. Stopping the timer prevents future ticks; draining
 * proves no tick is still writing when the database closes.
 */
export function drainHistoryReconciliation(): Promise<void> {
  return inflightTick ? inflightTick.then(() => undefined) : Promise.resolve();
}

/**
 * Production wiring.
 *
 * Built from the process singleton store and the same message service the
 * fast path uses, so reconciliation and `/api/chat` observe the same rows and
 * the same history — there is deliberately no second store or writer.
 */
export const chatHistoryReconcilerDeps: HistoryReconcilerDeps = {
  ...chatHistoryFinalizerDeps,
  store: chatStreamStore,
};
