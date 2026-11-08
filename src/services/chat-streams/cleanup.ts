import type { Database } from "bun:sqlite";
import { logger } from "../../lib/logger";
import { APP_BOOT_ID } from "./boot";
import {
  createSqliteResumableStreamStore,
  type ChatStreamCleanupReport,
  type SqliteResumableStreamStoreOptions,
  type SqliteResumableStreamStore,
} from "./sqliteResumableStore";

/**
 * Periodic cleanup of durable Direct-chat resumable streams.
 *
 * This module is the single owner of the cleanup timer, the same way
 * `services/scheduler/scheduler.ts` owns the cron handles: nothing else creates
 * or clears it, so repeated server initialisation cannot accumulate timers.
 *
 * Division of labour with boot recovery (design §6, §10):
 *   - boot recovery settles rows left `streaming` by a dead process;
 *   - periodic cleanup only *deletes expired terminal* rows.
 * They never overlap, and cleanup can never relabel a live stream.
 *
 * Design: docs/2026-09-25-phase2-durability-design.md §10.
 * ADR: docs/decisions.md "ADR: Direct Chat durable resumable streams".
 */

/** How often expired terminal rows are reclaimed. */
export const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface ChatStreamCleanupState {
  running: boolean;
  intervalMs: number;
  /**
   * Completed ticks since start, including the immediate first one. A tick that
   * was suppressed by the boot gate is not counted: it reclaimed nothing.
   */
  ticks: number;
  /** Whether a tick is executing right now — see {@link drainChatStreamCleanup}. */
  inFlight: boolean;
}

export interface StartChatStreamCleanupOptions {
  /** Tick interval. Defaults to hourly; tests use a short value. */
  intervalMs?: number;
  /** Rows per tick (store-side batch bound). */
  limit?: number;
  /** Extra store options (ttl, poll interval, ...). */
  store?: Omit<SqliteResumableStreamStoreOptions, "db" | "bootId">;
  /** Skip the immediate first tick (used to isolate timer behaviour in tests). */
  runImmediately?: boolean;
  /**
   * A boot-time promise that must resolve TRUE before the FIRST tick reclaims
   * anything.
   *
   * Boot recovery of abandoned history claims (`claimedHistoryRecovery`) reads the
   * same `claimed` rows and must get the chance to report them before retention
   * starts deleting them. Gating the first tick on its `stopReason` is what makes
   * the retention hold meaningful: if the sweep could not finish its scan, cleanup
   * must not consume the very rows it was going to report.
   *
   * Only the first tick is gated. `false` therefore postpones reclamation by one
   * interval, not forever, and the store's own hold still protects the rows - a
   * single incomplete scan must not disable retention for the process lifetime.
   */
  gate?: Promise<boolean>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let intervalMs = DEFAULT_CLEANUP_INTERVAL_MS;
let ticks = 0;
let inFlight = false;
/**
 * The currently running cleanup tick, if any. Stored so shutdown can drain it:
 * clearing the timer stops future ticks, but a tick already reclaiming rows
 * must complete before the database closes.
 */
let inflightTick: Promise<unknown> | null = null;
let database: Database | null = null;
let storeOptions: StartChatStreamCleanupOptions = {};
/**
 * The boot recovery gate, held only until the first tick consumes it. Kept as a
 * single reference rather than a boolean flag so a tick that is already running can
 * never observe it twice.
 */
let bootGate: Promise<boolean> | null = null;

/** Observable timer state, so lifecycle behaviour is testable without fake timers. */
export function getChatStreamCleanupState(): ChatStreamCleanupState {
  return { running: timer !== null, intervalMs, ticks, inFlight };
}

/**
 * Run one cleanup tick. Never throws: a failure here must not take the server
 * down, and it is surfaced as a logged error plus a `failures` count.
 *
 * A second call while a tick is executing is a deliberate no-op: two overlapping
 * reclaim passes could only contend for rows they each already hold, and the
 * single tracked tick is what makes {@link drainChatStreamCleanup} sufficient
 * (one promise to await, not an unbounded set of them).
 */
export async function runChatStreamCleanupOnce(): Promise<ChatStreamCleanupReport | null> {
  if (!database) return null;
  if (inFlight) {
    logger.debug("ai", "ai.stream_cleanup_overlapped", { signal: "interval" });
    return null;
  }

  inFlight = true;
  let resolveTick!: () => void;
  inflightTick = new Promise<void>((resolve) => {
    resolveTick = resolve;
  });
  let store: SqliteResumableStreamStore | null = null;
  try {
    // Only the first tick waits, and it consumes the reference before awaiting so
    // an overlapping caller cannot await the same gate a second time.
    if (bootGate) {
      const gate = bootGate;
      bootGate = null;
      let drained = false;
      try {
        drained = await gate;
      } catch {
        // A rejected gate is the recovery sweep's own logged failure; from here it
        // means "not proven drained", which is all this tick needs to know.
        drained = false;
      }
      if (!drained) {
        logger.warn("ai", "ai.stream_cleanup_gated", { signal: "interval" });
        return null;
      }
    }

    // Construction is inside the try: a closed database or a missing migration
    // must be contained here rather than escaping as an unhandled rejection.
    store = createSqliteResumableStreamStore({
      ...storeOptions.store,
      db: database,
      bootId: APP_BOOT_ID,
    });
    const report = await store.cleanupExpired({ limit: storeOptions.limit });
    ticks += 1;
    if (report.deleted > 0 || report.failures > 0) {
      // Counts only: never bytes, prompts, or provider payloads.
      logger.info("ai", "ai.stream_cleanup", {
        signal: "interval",
        scanned: report.scanned,
        deleted: report.deleted,
        skippedStreaming: report.skippedStreaming,
        heldUnresolved: report.heldUnresolved,
        expiredUnresolved: report.expiredUnresolved,
        failures: report.failures,
        deletedChunks: report.deletedChunks,
      });
    }
    return report;
  } catch {
    logger.error("ai", "ai.stream_cleanup_failed", { signal: "interval" });
    return null;
  } finally {
    store?.dispose();
    inFlight = false;
    inflightTick = null;
    resolveTick();
  }
}

/**
 * Start the cleanup timer, running one tick immediately so rows that expired
 * while the app was closed are reclaimed at boot rather than up to an interval
 * later. Idempotent: a second call while running changes nothing.
 */
export function startChatStreamCleanup(
  db: Database,
  options: StartChatStreamCleanupOptions = {},
): { started: boolean; alreadyRunning: boolean } {
  if (timer !== null) return { started: false, alreadyRunning: true };

  database = db;
  storeOptions = options;
  intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS);
  bootGate = options.gate ?? null;
  ticks = 0;

  if (options.runImmediately !== false) {
    // Fire-and-forget: startup must not block on retention bookkeeping.
    void runChatStreamCleanupOnce().catch(() => {
      /* runChatStreamCleanupOnce already swallows and logs */
    });
  }

  timer = setInterval(() => {
    void runChatStreamCleanupOnce().catch(() => {
      /* already logged inside */
    });
  }, intervalMs);
  // A retention timer must never be the reason the process stays alive.
  (timer as unknown as { unref?: () => void }).unref?.();
  return { started: true, alreadyRunning: false };
}

/** Clear the timer. Safe to call when not running. */
export function stopChatStreamCleanup(): boolean {
  if (timer === null) return false;
  clearInterval(timer);
  timer = null;
  database = null;
  bootGate = null;
  return true;
}

/**
 * Await the currently running cleanup tick, if any. Resolves immediately when
 * idle. Clearing the timer prevents future ticks; draining proves no tick is
 * still writing when the database closes.
 *
 * Deliberately unbounded, matching `drainHistoryReconciliation`: a tick can only
 * await SQLite work that cannot block indefinitely (`cleanupExpired` performs no
 * asynchronous I/O at all), and the tick resolves its promise from a `finally`,
 * so it cannot reject. A bound here would be a second failure mode with no
 * reachable state behind it.
 */
export function drainChatStreamCleanup(): Promise<void> {
  return inflightTick ? inflightTick.then(() => undefined) : Promise.resolve();
}
