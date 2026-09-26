import { logger } from "../../lib/logger";
import { chatStreamStore } from "../../lib/resumable";
import {
  chatHistoryFinalizerDeps,
  finalizeDetachedRunHistory,
  type FinalUIMessage,
  type HistoryFinalizeOutcome,
  type HistoryFinalizerDeps,
  type HistoryFinalizerStore,
} from "./historyFinalizer";
import type { SqliteResumableStreamStore } from "./sqliteResumableStore";

/**
 * Durable reconciliation of completed runs whose assistant history is still
 * outstanding.
 *
 * Why this exists: `routes/chat.ts` finalizes a completed run server-side only
 * when it *knows* the client detached. When the run completes while the server
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
 *  - it never writes a message the client already persisted (it closes the
 *    obligation as `already_persisted` instead);
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
  /** Obligations closed because the client had already persisted the reply. */
  alreadyPersisted: number;
  /** Closed with no usable message (aborted, corrupt, or no conversation). */
  skipped: number;
  /** Claims lost to a concurrent finalizer; correct, not an error. */
  notClaimed: number;
  /** Write attempts that threw; the row was marked `skipped`, never left claimed. */
  failed: number;
  /** Rows with no captured final message at all, so nothing could be written. */
  unrecoverable: number;
}

export interface StartHistoryReconciliationOptions {
  deps: HistoryReconcilerDeps;
  intervalMs?: number;
  graceMs?: number;
  limit?: number;
  now?: () => number;
  /** Skip the immediate first tick (used to isolate timer behaviour in tests). */
  runImmediately?: boolean;
}

let timer: ReturnType<typeof setInterval> | null = null;
let intervalMs = DEFAULT_HISTORY_RECONCILE_INTERVAL_MS;
let ticks = 0;
let inFlight = false;
let deps: HistoryReconcilerDeps | null = null;
let graceMs = DEFAULT_HISTORY_RECONCILE_GRACE_MS;
let limit = DEFAULT_HISTORY_RECONCILE_LIMIT;
let now: () => number = Date.now;

/** Observable timer state, so lifecycle behaviour is testable without fake timers. */
export function getHistoryReconciliationState(): {
  running: boolean;
  intervalMs: number;
  ticks: number;
  inFlight: boolean;
} {
  return { running: timer !== null, intervalMs, ticks, inFlight };
}

/**
 * Recover a captured final message from its stored text.
 *
 * Returns null — never a guess — for anything that is not a JSON object. Whether
 * a message is actually persistable is decided by the finalizer's own
 * `validateFinalMessage`, which runs on this value exactly as it ran when the
 * message was captured, so a row cannot acquire a second, looser verdict here.
 */
function parseFinalMessage(json: string | null): FinalUIMessage | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<FinalUIMessage>;
  return typeof candidate.id === "string" ? (candidate as FinalUIMessage) : null;
}

function countOutcome(report: HistoryReconcileReport, outcome: HistoryFinalizeOutcome): void {
  if (outcome === "written") report.written += 1;
  else if (outcome === "already_persisted") report.alreadyPersisted += 1;
  else if (outcome === "not_claimed") report.notClaimed += 1;
  else if (outcome === "skipped") report.skipped += 1;
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
  const report: HistoryReconcileReport = {
    scanned: 0,
    written: 0,
    alreadyPersisted: 0,
    skipped: 0,
    notClaimed: 0,
    failed: 0,
    unrecoverable: 0,
  };

  try {
    const rows = deps.store.listPendingCompletedHistory({
      before: now() - graceMs,
      limit,
    });
    report.scanned = rows.length;

    for (const row of rows) {
      const message = parseFinalMessage(row.finalMessageJson);
      if (message === null) {
        // The run either predates capture or had no persistable message. There is
        // nothing to write and nothing to invent, so the obligation is closed
        // truthfully rather than left pending forever.
        deps.store.skipHistory(row.streamId);
        report.unrecoverable += 1;
        logger.warn("chat", "chat_history_reconcile_unrecoverable", {
          streamId: row.streamId,
          conversationId: row.conversationId,
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
  }
}

/**
 * Start the reconciliation timer, running one pass immediately so anything left
 * outstanding by a previous process is settled at boot rather than an interval
 * later. Idempotent: a second call while running changes nothing.
 */
export function startHistoryReconciliation(
  options: StartHistoryReconciliationOptions,
): { started: boolean; alreadyRunning: boolean } {
  if (timer !== null) return { started: false, alreadyRunning: true };

  deps = options.deps;
  intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_HISTORY_RECONCILE_INTERVAL_MS);
  graceMs = Math.max(0, options.graceMs ?? DEFAULT_HISTORY_RECONCILE_GRACE_MS);
  limit = Math.max(1, options.limit ?? DEFAULT_HISTORY_RECONCILE_LIMIT);
  now = options.now ?? Date.now;
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
  return true;
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
