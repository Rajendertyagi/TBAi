import { generateId } from "../lib/utils";

/**
 * Server-owned AI run registry (chat streaming runs).
 *
 * The browser connection and the AI run are independent lifetimes: a dropped
 * client connection must not terminate an otherwise healthy run (see
 * docs/logging.md funnel rule + docs/decisions.md decoupling entry). This
 * module owns run state keyed by streamId; routes drive transitions, the
 * funnel layer logs them.
 *
 * Design rules enforced here:
 * - Transitions are idempotent and only move forward out of `running`
 *   (complete/failed/cancelled are terminal; concurrent completions race
 *   safely to a single winner).
 * - No logging inside: the owning route emits lifecycle events.
 * - No timers except the per-run wall clock (precedent: scheduler per-run
 *   timeouts). Reaping is lazy — every mutation sweeps expired terminal
 *   records, so quiescent processes need no background loop.
 * - In-memory only, like the resumable byte store: a process restart wipes
 *   both, and resume of a missing stream 404s (existing protocol, unchanged).
 */

export type ChatRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface ChatRunRecord {
  streamId: string;
  status: ChatRunStatus;
  /** Own controller: aborts the model run. Never the request signal. */
  controller: AbortController;
  /** Set by the wall clock before aborting, so onAbort logs timeout, not cancel. */
  timedOut: boolean;
  /** Set when the connection drops while running; cleared on resume attach. */
  detachedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Resolves when the record reaches a terminal status (settlement signal). */
  settled: Promise<void>;
  requestId?: string;
  conversationId?: string;
  providerId?: string;
  modelId?: string;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

export interface ChatRunStoreOptions {
  wallTimeoutMs?: number;
  recordTtlMs?: number;
  maxRecords?: number;
  now?: () => number;
}

const DEFAULT_WALL_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_RECORD_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 2000;

function numEnv(key: string, fallback: number): number {
  const n = Number(process.env[key] ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function createChatRunStore(opts: ChatRunStoreOptions = {}) {
  const wallTimeoutMs =
    opts.wallTimeoutMs ?? numEnv("TBAI_CHAT_RUN_TIMEOUT_MS", DEFAULT_WALL_TIMEOUT_MS);
  const recordTtlMs =
    opts.recordTtlMs ?? numEnv("TBAI_CHAT_RUN_RECORD_TTL_MS", DEFAULT_RECORD_TTL_MS);
  const maxRecords = opts.maxRecords ?? DEFAULT_MAX_RECORDS;
  const now = opts.now ?? Date.now;
  const records = new Map<string, ChatRunRecord>();
  /** Per-record settlement resolvers, cleaned on settle and sweep. */
  const settleResolvers = new Map<string, () => void>();
  /**
   * Detached-history finalization promises, tracked from creation until they
   * settle. A completed run's `settled` resolves before its history write
   * finishes, so awaiting `settled` alone cannot prove the write completed.
   */
  const finalizations = new Set<Promise<unknown>>();
  /** Set by abortAll(): create() then refuses new runs (shutdown gate). */
  let shuttingDown = false;

  function clearTimer(rec: ChatRunRecord): void {
    if (rec.timeoutHandle !== undefined) {
      clearTimeout(rec.timeoutHandle);
      rec.timeoutHandle = undefined;
    }
  }

  /** Settle to a terminal status; only the first transition out of running wins. */
  function settle(id: string, status: Exclude<ChatRunStatus, "running">): boolean {
    const rec = records.get(id);
    if (rec?.status !== "running") return false;
    clearTimer(rec);
    rec.status = status;
    rec.updatedAt = now();
    settleResolvers.get(id)?.();
    settleResolvers.delete(id);
    return true;
  }

  function sweep(sweepNow = now()): { pruned: number } {
    let pruned = 0;
    for (const [id, rec] of records) {
      if (rec.status !== "running" && sweepNow - rec.updatedAt > recordTtlMs) {
        clearTimer(rec);
        settleResolvers.delete(id);
        records.delete(id);
        pruned += 1;
      }
    }
    // Hard cap: drop oldest terminal records first, never running ones.
    if (records.size > maxRecords) {
      const terminal = [...records.values()]
        .filter((r) => r.status !== "running")
        .sort((a, b) => a.updatedAt - b.updatedAt);
      for (const rec of terminal.slice(0, records.size - maxRecords)) {
        clearTimer(rec);
        settleResolvers.delete(rec.streamId);
        records.delete(rec.streamId);
        pruned += 1;
      }
    }
    return { pruned };
  }

  return {
    /** Create a running record with its own controller + wall clock. */
    create(fields: {
      requestId?: string;
      conversationId?: string;
      providerId?: string;
      modelId?: string;
    }): ChatRunRecord {
      sweep();
      if (shuttingDown) {
        const rec: ChatRunRecord = {
          streamId: generateId(),
          status: "cancelled",
          controller: new AbortController(),
          timedOut: false,
          detachedAt: null,
          createdAt: now(),
          updatedAt: now(),
          settled: Promise.resolve(),
          ...fields,
        };
        rec.controller.abort();
        records.set(rec.streamId, rec);
        return rec;
      }
      let resolveSettled: () => void = () => {};
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve;
      });
      const rec: ChatRunRecord = {
        streamId: generateId(),
        status: "running",
        controller: new AbortController(),
        timedOut: false,
        detachedAt: null,
        createdAt: now(),
        updatedAt: now(),
        settled,
        ...fields,
      };
      settleResolvers.set(rec.streamId, resolveSettled);
      rec.timeoutHandle = setTimeout(() => {
        if (rec.status !== "running") return;
        // Mark only: the abort below drives the single terminal transition
        // through onAbort (timeout vs cancel), so concurrent completion wins
        // races honestly and nothing logs twice.
        rec.timedOut = true;
        rec.updatedAt = now();
        try {
          rec.controller.abort();
        } catch {
          /* abort is best-effort; onAbort still observes timedOut */
        }
      }, wallTimeoutMs);
      // Timer must never keep the process alive on its own.
      (rec.timeoutHandle as unknown as { unref?: () => void }).unref?.();
      records.set(rec.streamId, rec);
      return rec;
    },

    get(id: string): ChatRunRecord | undefined {
      return records.get(id);
    },

    /** Connection dropped while running: run continues, marked detached. */
    markDetached(id: string): boolean {
      const rec = records.get(id);
      if (rec?.status !== "running" || rec.detachedAt !== null) return false;
      rec.detachedAt = now();
      rec.updatedAt = now();
      return true;
    },

    /** Consumer reattached (resume): clear the detached mark. */
    attach(id: string): boolean {
      const rec = records.get(id);
      if (!rec || rec.detachedAt === null) return false;
      rec.detachedAt = null;
      rec.updatedAt = now();
      return true;
    },

    markCompleted(id: string): boolean {
      return settle(id, "completed");
    },

    markFailed(id: string): boolean {
      return settle(id, "failed");
    },

    markCancelled(id: string): boolean {
      return settle(id, "cancelled");
    },

    /** Abort every running run's controller; returns how many were aborted. */
    abortAll(): number {
      shuttingDown = true;
      let aborted = 0;
      for (const rec of records.values()) {
        if (rec.status !== "running") continue;
        clearTimer(rec);
        rec.timedOut = false;
        rec.updatedAt = now();
        try {
          rec.controller.abort();
          aborted += 1;
        } catch {
          /* abort is best-effort; onAbort still observes the terminal state */
        }
      }
      return aborted;
    },

    /**
     * Track a detached-history finalization promise so shutdown awaits the
     * write, not just the settlement signal that precedes it. Self-removing
     * on settle, so the set cannot grow without bound.
     */
    trackFinalization(promise: Promise<unknown>): void {
      finalizations.add(promise);
      void promise
        .finally(() => {
          finalizations.delete(promise);
        })
        .catch(() => {
          /* finalization reports its own outcome; the tracker never rejects */
        });
    },

    /**
     * Await in-flight runs' settlement AND tracked history finalizations,
     * bounded; returns settled vs timed out.
     */
    async awaitSettled(
      timeoutMs = 10_000,
    ): Promise<{ settled: number; timedOut: number; deadlineHit: boolean }> {
      const snapshot = [...records.values()].filter((r) => r.status === "running");
      const finals = [...finalizations];
      if (snapshot.length === 0 && finals.length === 0)
        return { settled: 0, timedOut: 0, deadlineHit: false };
      let boundTimer: ReturnType<typeof setTimeout> | undefined;
      let deadlineHit = false;
      const bound = new Promise<void>((resolve) => {
        boundTimer = setTimeout(() => {
          deadlineHit = true;
          resolve();
        }, timeoutMs);
      });
      // Referenced while pending: at shutdown this bound keeps the process alive
      // until the runs settle or the bound expires, so a wedged run cannot let
      // the event loop empty and exit before classification. It is cleared when
      // the race resolves, so a clean shutdown does not linger for the full bound.
      try {
        await Promise.race([
          Promise.allSettled([...snapshot.map((r) => r.settled), ...finals]),
          bound,
        ]);
      } finally {
        if (boundTimer !== undefined) clearTimeout(boundTimer);
      }
      const stillRunning = snapshot.filter((r) => r.status === "running").length;
      const stillPending = finals.filter((p) => finalizations.has(p)).length;
      return {
        settled: snapshot.length - stillRunning + (finals.length - stillPending),
        timedOut: stillRunning + stillPending,
        deadlineHit,
      };
    },

    sweep,

    /**
     * Whether any write-capable work remains: a still-running record or a
     * tracked finalization that has not settled. Used by the shutdown spine
     * to re-check, just before database closure, that a fired deadline did
     * not leave a writer behind.
     */
    hasUnsettledWork(): boolean {
      if ([...records.values()].some((r) => r.status === "running")) return true;
      return finalizations.size > 0;
    },

    /** For tests and diagnostics: current record count by status. */
    counts(): Record<ChatRunStatus, number> {
      const out: Record<ChatRunStatus, number> = {
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      };
      for (const rec of records.values()) out[rec.status] += 1;
      return out;
    },
  };
}

export type ChatRunStore = ReturnType<typeof createChatRunStore>;

/** Process singleton: runs are process-local, like the resumable byte store. */
export const chatRuns = createChatRunStore();
