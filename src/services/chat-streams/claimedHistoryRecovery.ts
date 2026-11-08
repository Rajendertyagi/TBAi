import { logger } from "../../lib/logger";
import { chatStreamStore } from "../../lib/resumable";
import { resolveMessageForHistorySync } from "../storage/messages";
import {
  abandonClaimedHistory,
  closeClaimedHistory,
  parseCapturedFinalMessage,
  type ClaimedHistoryOutcome,
  type HistoryPersistDeps,
} from "./historyFinalizer";
import type { SqliteResumableStreamStore, StaleClaimedHistoryRow } from "./sqliteResumableStore";

/**
 * Boot recovery of abandoned history claims.
 *
 * The problem: a completed run's assistant reply is written to history under a
 * guarded claim (`pending` → `claimed`), and the row is closed `done`/`skipped`
 * moments later in the same turn. If the process dies between `claimHistory` and
 * that closing write, the row is left `history_state='claimed'` with no writer.
 * Nothing closes it: `listPendingCompletedHistory` selects `pending`, `claimHistory`
 * requires `pending`, and periodic cleanup only removes *expired* rows — so the
 * reply is lost for as long as the row survives its 24 h retention window, silently.
 *
 * The fix (approved as "C-3, Option B"): a boot sweep over every `claimed` row whose
 * claim is older than a threshold. Each is driven to the SAME verdict the live
 * finalizer would have reached, through the SAME shared transition
 * (`closeClaimedHistory`, which is `persistClaimedHistory`'s implementation): the
 * guarded `claimed` → `done` transition and any message write happen in one SQLite
 * transaction, so a half-recovered row is not a state this sweep can leave behind.
 *
 * What it deliberately does NOT do:
 *  - reconstruct the message from replayable bytes. It re-offers the exact text the
 *    run captured at settlement, the same value `historyReconciler` re-offers for
 *    `pending` rows, so this stays inside the 2026-09-25 ADR's "no reconstruction, no
 *    boot re-arm of the byte stream" boundary;
 *  - guess at a contradiction. A claim whose stored message disagrees with it on
 *    identity, ownership, or parent is left `claimed` and reported, never written over
 *    and never closed as if it had been handled;
 *  - retry within the sweep. A write that failed (including lock contention) is left
 *    for the next sweep, and the keyset cursor has already advanced past it, so one
 *    stuck row can neither spin nor stall the rest.
 *
 * Ordering: it runs at boot once exclusive instance ownership exists and before
 * normal history reconciliation begins (`historyReconciler`'s `gate`), so the two
 * never scan or write the same rows concurrently. Cleanup is gated on this sweep
 * draining for the same reason: the retention hold on unresolved claims only
 * protects what this sweep had a chance to report.
 *
 * Design: docs/2026-09-25-phase2-durability-design.md §6/§9.
 * ADR: docs/decisions.md "ADR: Direct Chat durable resumable history".
 */

/**
 * How long after a claim is taken it is considered abandoned.
 *
 * A live finalizer closes its claim in microseconds, so any claim older than a few
 * minutes belongs to a process that will never finish it. The bound is deliberately
 * generous so a slow boot or a paused process never has a live claim stolen; the
 * cost of waiting longer is only that a crashed reply is recovered on the next boot
 * instead of this one.
 */
export const DEFAULT_STALE_HISTORY_CLAIM_MS = 300_000;

/** Claims examined per page, so a large backlog is drained in bounded steps. */
export const DEFAULT_CLAIMED_RECOVERY_PAGE_SIZE = 50;

/** The store surface recovery needs: enough to scan claims and close them. */
export type ClaimedHistoryRecoveryStore = HistoryPersistDeps["store"] &
  Pick<SqliteResumableStreamStore, "listStaleClaimedHistory">;

export interface ClaimedHistoryRecoveryDeps extends HistoryPersistDeps {
  store: ClaimedHistoryRecoveryStore;
}

/**
 * What one sweep did. Counts only — never message text or prompts.
 *
 * The outcomes are kept apart on purpose. "Nothing was recovered" is not one fact:
 * a lost compare-and-set, a live holder, a contradiction the sweep refuses to guess
 * at, and a lock timeout have four different follow-ups, and merging them is how a
 * contention error becomes an invisible, endlessly retried row.
 */
export interface ClaimedRecoveryReport {
  /** Abandoned claims examined, across every page. */
  scanned: number;
  /** Pages read from the store. */
  pages: number;
  /** Claims with no recorded claim time: corrupt rows, reported, still swept. */
  nullTimestamp: number;
  /** Captured messages written because nobody else had. */
  written: number;
  /** Stored rows replaced because they did not match the capture. */
  repaired: number;
  /** Claims closed because the message was already in history, untouched. */
  matched: number;
  /** Row was already `done` when the guard ran. Closed by someone else. */
  alreadyResolved: number;
  /** Row was already `skipped` when the guard ran. */
  alreadyResolvedSkipped: number;
  /** Row abandoned by this sweep with nothing legitimate to write. */
  abandoned: number;
  /** Row no longer existed. Never counted as a success. */
  rowGone: number;
  /** Still held by a live worker: deferred to the next sweep, never stolen. */
  contended: number;
  /** Left unresolved: identity, ownership, or parent contradicts the capture. */
  conflicted: number;
  /** Write or state-read failures. The row is left for the next sweep. */
  failed: number;
  /**
   * Why the sweep stopped. `drained` means every page was read and the cursor
   * reached the end, which is the only result that may gate cleanup. `scan_failed`
   * means a page could not be read, so the candidate set was NOT fully examined and
   * callers must not treat the sweep as complete.
   */
  stopReason: "drained" | "scan_failed";
}

export interface RecoverStaleClaimedHistoryOptions {
  /** Claim staleness bound; defaults to `DEFAULT_STALE_HISTORY_CLAIM_MS`. */
  staleMs?: number;
  /** Claims examined per page; defaults to `DEFAULT_CLAIMED_RECOVERY_PAGE_SIZE`. */
  pageSize?: number;
  /** Clock, for deterministic tests. */
  now?: () => number;
}

/**
 * Give the event loop a turn between rows.
 *
 * The sweep runs unawaited at boot while the server is serving requests, and each
 * row can issue several SQLite statements. Yielding keeps a long backlog from
 * monopolising the loop; it is not a correctness mechanism and nothing here depends
 * on it having run.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Tally one row's close outcome. Exhaustive over `ClaimedHistoryOutcome`. */
function countOutcome(report: ClaimedRecoveryReport, outcome: ClaimedHistoryOutcome): void {
  switch (outcome.status) {
    case "written":
      report.written += 1;
      break;
    case "repaired":
      report.repaired += 1;
      break;
    case "matched":
      report.matched += 1;
      break;
    case "already_resolved":
      report.alreadyResolved += 1;
      break;
    case "already_resolved_skipped":
      report.alreadyResolvedSkipped += 1;
      break;
    case "abandoned":
      report.abandoned += 1;
      break;
    case "row_gone":
      report.rowGone += 1;
      break;
    case "contended":
      report.contended += 1;
      break;
    case "conflicted":
      report.conflicted += 1;
      break;
    case "write_failed":
    case "state_read_failed":
      report.failed += 1;
      break;
  }
}

/**
 * Close abandoned history claims, page by page, until the candidate set is drained.
 *
 * Never rejects. A per-row failure is counted and the sweep continues; a failed page
 * read ends the sweep with `stopReason: "scan_failed"` rather than pretending the
 * remaining rows do not exist.
 *
 * Pagination is a `stream_id` keyset cursor, not an offset, and the cursor advances
 * past a row that could not be closed. That is what lets the sweep make progress on
 * exactly the rows it CAN close instead of returning to the same unresolvable head
 * forever.
 *
 * @returns Counts per outcome plus the stop reason. `stopReason === "drained"` is the
 *   only result a caller may treat as a complete scan.
 */
export async function recoverStaleClaimedHistory(
  deps: ClaimedHistoryRecoveryDeps,
  options: RecoverStaleClaimedHistoryOptions = {},
): Promise<ClaimedRecoveryReport> {
  const staleMs = Math.max(0, options.staleMs ?? DEFAULT_STALE_HISTORY_CLAIM_MS);
  const pageSize = Math.max(1, Math.trunc(options.pageSize ?? DEFAULT_CLAIMED_RECOVERY_PAGE_SIZE));
  const now = options.now ?? Date.now;

  const report: ClaimedRecoveryReport = {
    scanned: 0,
    pages: 0,
    nullTimestamp: 0,
    written: 0,
    repaired: 0,
    matched: 0,
    alreadyResolved: 0,
    alreadyResolvedSkipped: 0,
    abandoned: 0,
    rowGone: 0,
    contended: 0,
    conflicted: 0,
    failed: 0,
    stopReason: "drained",
  };

  // "" is below every valid stream id (`STREAM_ID_PATTERN` requires at least one
  // character), so it is a correct and total starting cursor. The staleness bound is
  // fixed for the whole sweep: recomputing it per page would let a window that has
  // not finished move forward underneath the cursor.
  let afterStreamId = "";
  const before = now() - staleMs;

  for (;;) {
    let rows: StaleClaimedHistoryRow[];
    try {
      rows = deps.store.listStaleClaimedHistory({ before, limit: pageSize, afterStreamId });
    } catch (error) {
      report.stopReason = "scan_failed";
      logger.error("chat", "chat_history_claimed_recovery_scan_failed", {
        signal: "boot",
        afterStreamId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      break;
    }
    if (rows.length === 0) break;

    report.pages += 1;
    report.scanned += rows.length;

    for (const row of rows) {
      // Advance FIRST: a row that cannot be closed must still be behind the cursor,
      // or the next page would return it again and the sweep would never finish.
      afterStreamId = row.streamId;
      if (row.historyClaimedAt === null) {
        // A NULL claim time cannot be shown to be recent, so the row is swept rather
        // than skipped. It is still corruption and is reported as such.
        report.nullTimestamp += 1;
        logger.warn("chat", "chat_history_claimed_recovery_null_timestamp", {
          signal: "boot",
          streamId: row.streamId,
        });
      }
      await closeOne(deps, row, report);
      await yieldToEventLoop();
    }

    if (rows.length < pageSize) break;
  }

  logger.info("chat", "chat_history_claimed_recovered", {
    signal: "boot",
    stopReason: report.stopReason,
    pages: report.pages,
    scanned: report.scanned,
    nullTimestamp: report.nullTimestamp,
    written: report.written,
    repaired: report.repaired,
    matched: report.matched,
    alreadyResolved: report.alreadyResolved,
    alreadyResolvedSkipped: report.alreadyResolvedSkipped,
    abandoned: report.abandoned,
    rowGone: report.rowGone,
    contended: report.contended,
    conflicted: report.conflicted,
    failed: report.failed,
  });

  return report;
}

/**
 * Close one abandoned claim, isolating any failure to that row.
 *
 * The row is `claimed` and nobody is left to finish it, so the only two legitimate
 * endings are "closed with a verified message" and "closed as deliberately
 * abandoned". Leaving it `claimed` is reserved for the two cases where closing would
 * destroy information: a contradiction (reported as `conflicted`) and a failure to
 * read or write it (reported as `failed`). Neither loses the row — the retention hold
 * in `cleanupExpired` keeps it long enough to be reported.
 */
async function closeOne(
  deps: ClaimedHistoryRecoveryDeps,
  row: StaleClaimedHistoryRow,
  report: ClaimedRecoveryReport,
): Promise<void> {
  try {
    const message = parseCapturedFinalMessage(row.finalMessageJson);
    if (message === null) {
      // The claim names an obligation, but the capture is missing or unreadable, so
      // there is nothing to write and nothing to invent. The abandon is verified, so
      // a skip that did not take effect is reported as a failure rather than as a
      // closure.
      countOutcome(report, abandonClaimedHistory(deps, row.streamId, "unreadable_capture"));
      return;
    }

    countOutcome(
      report,
      await closeClaimedHistory(deps, {
        streamId: row.streamId,
        message,
        parentId: row.finalParentId,
      }),
    );
  } catch (error) {
    // Per-row isolation: one unclosable row must not strand the rest of the sweep.
    report.failed += 1;
    logger.error("chat", "chat_history_claimed_recovery_row_failed", {
      signal: "boot",
      streamId: row.streamId,
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }
}

/**
 * Production wiring: the process singleton store and the same message resolver the
 * finalizer uses, so recovery, reconciliation, and `/api/chat` all observe one
 * history and one stream table.
 *
 * Note what is NOT passed: `claimHistory`. Recovery must never take a new claim - it
 * only finishes or abandons claims a dead process already took, which the narrowed
 * store type enforces.
 */
/**
 * Polling interval for the recurring sweep.
 *
 * A claim is only eligible once it is older than `DEFAULT_STALE_HISTORY_CLAIM_MS`
 * (5 min), so polling faster than that cannot recover anything new; polling slower
 * only delays recovery. Matching the staleness window is the natural cadence and
 * keeps the two constants from drifting apart.
 */
export const DEFAULT_CLAIMED_RECOVERY_POLL_MS = DEFAULT_STALE_HISTORY_CLAIM_MS;

// ── Recurring sweep state ─────────────────────────────────────────────────────

let recoveryDeps: ClaimedHistoryRecoveryDeps | null = null;
let recoveryIntervalMs = DEFAULT_CLAIMED_RECOVERY_POLL_MS;
let recoveryStaleMs = DEFAULT_STALE_HISTORY_CLAIM_MS;
let recoveryPageSize = DEFAULT_CLAIMED_RECOVERY_PAGE_SIZE;
let recoveryBootGate: Promise<boolean> | null = null;
let recoveryTimer: ReturnType<typeof setInterval> | null = null;
let recoveryInFlight = false;
let recoveryInflightTick: Promise<void> | null = null;
let recoveryTicks = 0;
let recoveryNow: () => number = Date.now;

/**
 * Run one recovery sweep, with the same overlap and failure discipline as the
 * cleanup and reconciliation timers: a second call while one is running is a
 * deliberate no-op, and a failure is logged and swallowed so the timer survives.
 */
export async function runClaimedHistoryRecoveryOnce(): Promise<ClaimedRecoveryReport | null> {
  const deps = recoveryDeps;
  if (deps === null) return null;
  if (recoveryInFlight) {
    logger.debug("ai", "ai.chat_history_claimed_recovery_overlapped", { signal: "interval" });
    return null;
  }

  recoveryInFlight = true;
  let resolveTick!: () => void;
  recoveryInflightTick = new Promise<void>((resolve) => {
    resolveTick = resolve;
  });

  try {
    // Only the first tick waits on the boot gate, and it consumes the reference
    // before awaiting so an overlapping caller cannot await the same gate twice.
    if (recoveryBootGate !== null) {
      const gate = recoveryBootGate;
      recoveryBootGate = null;
      let drained = false;
      try {
        drained = await gate;
      } catch {
        // A rejected gate is the boot sweep's own logged failure; from here it
        // means "not proven drained", which is all this tick needs to know.
        drained = false;
      }
      if (!drained) {
        logger.warn("ai", "ai.chat_history_claimed_recovery_gated", { signal: "interval" });
        return null;
      }
    }

    const report = await recoverStaleClaimedHistory(deps, {
      now: recoveryNow,
      staleMs: recoveryStaleMs,
      pageSize: recoveryPageSize,
    });
    recoveryTicks += 1;
    if (report.written > 0 || report.repaired > 0 || report.failed > 0 || report.conflicted > 0) {
      logger.info("ai", "ai.chat_history_claimed_recovery", {
        signal: "interval",
        stopReason: report.stopReason,
        scanned: report.scanned,
        written: report.written,
        repaired: report.repaired,
        matched: report.matched,
        abandoned: report.abandoned,
        contended: report.contended,
        conflicted: report.conflicted,
        failed: report.failed,
      });
    }
    return report;
  } catch (error) {
    logger.error("ai", "ai.chat_history_claimed_recovery_failed", {
      signal: "interval",
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return null;
  } finally {
    recoveryInFlight = false;
    recoveryInflightTick = null;
    resolveTick();
  }
}

export interface StartClaimedHistoryRecoveryOptions {
  /** Polling interval; defaults to `DEFAULT_CLAIMED_RECOVERY_POLL_MS`. */
  intervalMs?: number;
  /** Claim staleness bound; defaults to `DEFAULT_STALE_HISTORY_CLAIM_MS`. */
  staleMs?: number;
  /** Claims examined per page; defaults to `DEFAULT_CLAIMED_RECOVERY_PAGE_SIZE`. */
  pageSize?: number;
  /** Clock, for deterministic tests. */
  now?: () => number;
  /** Gate the first tick on this promise (the boot sweep's drain result). */
  gate?: Promise<boolean> | null;
  /** Fire one tick immediately. Defaults to true. */
  runImmediately?: boolean;
}

/**
 * Start the recurring recovery timer. Idempotent: a second call while running
 * changes nothing. The timer is unref'd so it never keeps the process alive.
 */
export function startClaimedHistoryRecovery(
  deps: ClaimedHistoryRecoveryDeps,
  options: StartClaimedHistoryRecoveryOptions = {},
): { started: boolean; alreadyRunning: boolean } {
  if (recoveryTimer !== null) return { started: false, alreadyRunning: true };

  recoveryDeps = deps;
  recoveryIntervalMs = Math.max(1, options.intervalMs ?? DEFAULT_CLAIMED_RECOVERY_POLL_MS);
  recoveryStaleMs = Math.max(0, options.staleMs ?? DEFAULT_STALE_HISTORY_CLAIM_MS);
  recoveryPageSize = Math.max(
    1,
    Math.trunc(options.pageSize ?? DEFAULT_CLAIMED_RECOVERY_PAGE_SIZE),
  );
  recoveryNow = options.now ?? Date.now;
  recoveryBootGate = options.gate ?? null;
  recoveryTicks = 0;

  if (options.runImmediately !== false) {
    void runClaimedHistoryRecoveryOnce().catch(() => {
      /* runClaimedHistoryRecoveryOnce already swallows and logs */
    });
  }

  recoveryTimer = setInterval(() => {
    void runClaimedHistoryRecoveryOnce().catch(() => {
      /* already logged inside */
    });
  }, recoveryIntervalMs);
  (recoveryTimer as unknown as { unref?: () => void }).unref?.();
  return { started: true, alreadyRunning: false };
}

/** Clear the timer. Safe to call when not running. */
export function stopClaimedHistoryRecovery(): boolean {
  if (recoveryTimer === null) return false;
  clearInterval(recoveryTimer);
  recoveryTimer = null;
  recoveryDeps = null;
  recoveryBootGate = null;
  return true;
}

/**
 * Await the currently running recovery tick, if any. Resolves immediately when
 * idle. Clearing the timer prevents future ticks; draining proves no tick is
 * still writing when the database closes.
 */
export function drainClaimedHistoryRecovery(): Promise<void> {
  return recoveryInflightTick ? recoveryInflightTick.then(() => undefined) : Promise.resolve();
}

/**
 * Production wiring: the process singleton store and the same message resolver the
 * finalizer uses, so recovery, reconciliation, and `/api/chat` all observe one
 * history and one stream table.
 *
 * Note what is NOT passed: `claimHistory`. Recovery must never take a new claim - it
 * only finishes or abandons claims a dead process already took, which the narrowed
 * store type enforces.
 */
/** Test/ops introspection. */
export function getClaimedHistoryRecoveryState(): {
  running: boolean;
  ticks: number;
  inFlight: boolean;
} {
  return {
    running: recoveryTimer !== null,
    ticks: recoveryTicks,
    inFlight: recoveryInFlight,
  };
}

/**
 * Production wiring: the process singleton store and the same message resolver the
 * finalizer uses, so recovery, reconciliation, and /api/chat all observe one
 * history and one stream table.
 *
 * Note what is NOT passed: claimHistory. Recovery must never take a new claim - it
 * only finishes or abandons claims a dead process already took, which the narrowed
 * store type enforces.
 */
export const chatClaimedHistoryRecoveryDeps: ClaimedHistoryRecoveryDeps = {
  store: chatStreamStore,
  messages: { resolveMessageForHistorySync },
};
