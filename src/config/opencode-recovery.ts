/**
 * Configuration for managed OpenCode restart recovery.
 *
 * Every value the recovery service uses that would otherwise be a magic number
 * or string lives here. Kept separate from `OPENCODE_CONFIG` so the recovery
 * feature owns its own tuning surface without widening the runtime config type.
 */

/** Metadata marker that identifies a TBAi-owned recovery synthetic. */
export const RECOVERY_NOTICE = "opencode-restart";

export const OPENCODE_RECOVERY_CONFIG = {
  /** Grace before acting, chosen by the detected state. */
  graceMs: {
    /** Shutdown interruption: a resumed execution continues the same turn. */
    shutdownInterruption: 60_000,
    /** Incomplete assistant: allow an in-flight successor to appear. */
    incompleteAssistant: 30_000,
    /** Pending user prompt or pending recovery synthetic. */
    pendingInput: 5_000,
    /** Projected user input after the last idle, before any assistant. */
    projectedUser: 5_000,
  },
  /** Total HTTP calls per resume operation: 1 initial + 2 retries. */
  maxHttpCalls: 3,
  /** Backoff before retry 1 and retry 2 (no third backoff). */
  backoffMs: [15_000, 30_000] as const,
  /** Per-call timeout. */
  perCallTimeoutMs: 15_000,
  /** Newest-first history scan bounds. */
  scan: {
    pageSize: 200,
    maxPages: 10,
    maxMessages: 2_000,
  },
  /** Bounds so a large workspace cannot stall boot. */
  maxConcurrentScans: 4,
  maxCandidatesPerPass: 50,
  passBudgetMs: 5 * 60_000,
  /** Bound for draining in-flight recovery work during shutdown. */
  drainTimeoutMs: 10_000,
} as const;
