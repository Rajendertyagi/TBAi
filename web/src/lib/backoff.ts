/**
 * Bounded jittered backoff for the global availability poller (Phase 3).
 *
 * Single home for reconnect-delay math so no second poller invents its own
 * curve. Full jitter (decorrelated) is deliberate: every browser tab runs its
 * own poller, and synchronized retries would thunder the recovering backend.
 * Pure function — deterministic bounds, directly unit-testable.
 */
export interface BackoffOptions {
  /** Delay for attempt 0 before jitter. */
  baseMs: number;
  /** Hard ceiling after jitter. */
  maxMs: number;
  /** Growth factor per attempt. Defaults to 2. */
  factor?: number;
}

/** Delay for the given consecutive-failure attempt (0-based), in [0, cap]. */
export function computeBackoffDelay(attempt: number, options: BackoffOptions): number {
  const factor = options.factor ?? 2;
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const cap = Math.min(options.maxMs, options.baseMs * Math.pow(factor, safeAttempt));
  return Math.floor(Math.random() * (cap + 1));
}
