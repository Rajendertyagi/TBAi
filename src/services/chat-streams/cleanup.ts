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
  /** Completed ticks since start, including the immediate first one. */
  ticks: number;
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
}

let timer: ReturnType<typeof setInterval> | null = null;
let intervalMs = DEFAULT_CLEANUP_INTERVAL_MS;
let ticks = 0;
let database: Database | null = null;
let storeOptions: StartChatStreamCleanupOptions = {};

/** Observable timer state, so lifecycle behaviour is testable without fake timers. */
export function getChatStreamCleanupState(): ChatStreamCleanupState {
  return { running: timer !== null, intervalMs, ticks };
}

/**
 * Run one cleanup tick. Never throws: a failure here must not take the server
 * down, and it is surfaced as a logged error plus a `failures` count.
 */
export async function runChatStreamCleanupOnce(): Promise<ChatStreamCleanupReport | null> {
  if (!database) return null;
  let store: SqliteResumableStreamStore | null = null;
  try {
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
  return true;
}
