/** Centralized OpenCode frontend configuration. No magic paths inline. */
export const OPENCODE_PROXY_BASE_URL = "/api/opencode";
/**
 * The TBAi-owned header that names the OpenCode session a request belongs to.
 *
 * It is a **selector**, not an instruction: the backend resolves it to the
 * one workspace that session is rooted in and forwards that directory. The
 * browser therefore never chooses a working directory — it used to send
 * `x-opencode-directory` itself, which let any caller point the managed
 * server at a directory it did not own.
 */
export const OPENCODE_SESSION_HEADER = "x-tbai-session";
/** Bounded wait for session init before surfacing a retry affordance. */
export const OPENCODE_INIT_TIMEOUT_MS = 15_000;
export const OPENCODE_V2_HISTORY_PAGE_SIZE = 100;
/**
 * The number of DISTINCT events the hydration buffer will hold.
 *
 * Streamed deltas are coalesced per streaming target on arrival, so this bounds
 * "how many separate things happened during one read", not "how many tokens
 * arrived". It is a backstop: reaching it drops the oldest entries rather than
 * abandoning the read.
 */
export const OPENCODE_V2_EVENT_BUFFER_LIMIT = 4096;
export const OPENCODE_V2_RECENT_EVENT_ID_WINDOW = 256;
/**
 * How long a caller may wait for the runtime to become ready.
 *
 * A wait with no deadline is a wait with no answer: the composer holds the
 * reader's text, nothing is sent, and the reader is told nothing. The
 * deadline turns "waiting" into a reported state.
 *
 * It budgets the WHOLE wait — the start/load promise and the attempt's readiness
 * gate together, not each leg separately (`v2ThreadController.ts#awaitReady`). A
 * leg that restarts on a superseded attempt draws from what is left, so slow
 * hydration cannot extend the caller's wait past this number.
 */
export const OPENCODE_V2_READY_TIMEOUT_MS = 20_000;
/**
 * How long the event stream may be completely silent before it is considered
 * dead and reconnected.
 *
 * The 2.1.2 server - the binary this interval was measured on - sends an SSE
 * keepalive comment every 15 seconds on `/api/event`, and the official client
 * reports every chunk, so 30 seconds is two missed heartbeats. The 2.2.0 pin
 * has not been re-measured for this interval. Silence, not "no events": an
 * idle session legitimately delivers no events for hours.
 *
 * It must stay ABOVE `OPENCODE_V2_READY_TIMEOUT_MS`. A stream that is merely
 * quiet during a slow hydration must not be torn down while the caller still
 * has budget left; the caller reports its own timeout first.
 */
export const OPENCODE_V2_STREAM_IDLE_TIMEOUT_MS = 30_000;
/**
 * How long a send waits for the server to admit the prompt.
 *
 * The admission usually arrives in milliseconds. When the request fails in a
 * way that cannot prove the server refused it, the prompt may still be running
 * there, and the client waits for the answer rather than guessing. The
 * deadline bounds that wait: a send that never returns is worse than a send
 * that reports an honest ambiguity.
 */
export const OPENCODE_V2_PROMPT_ADMISSION_TIMEOUT_MS = 15_000;
export const OPENCODE_V2_INITIAL_RECONNECT_DELAY_MS = 250;
export const OPENCODE_V2_MAX_RECONNECT_DELAY_MS = 10_000;
/**
 * The backoff ceiling while the document is visible and the browser is online.
 *
 * A reader who is looking at the window is waiting, so the last retries are
 * kept short. The configured `OPENCODE_V2_MAX_RECONNECT_DELAY_MS` remains an
 * upper bound on top of this — the effective ceiling is the smaller of the two.
 */
export const OPENCODE_V2_FOREGROUND_RECONNECT_CAP_MS = 5_000;
export const OPENCODE_V2_MAX_RECONNECT_ATTEMPTS = 10;
/**
 * Idle re-sync cadence for the auxiliary snapshot (inbox, permissions, forms).
 *
 * Backstop for one failure mode the event stream cannot report: `ordinal` is a
 * LOCAL counter, so a dropped `form.created` / `permission.asked` leaves no
 * trace and nothing can detect it. Re-fetching on a slow cadence repairs that
 * within one interval instead of waiting for a reload. Runs only while the
 * session is idle, and a re-sync that finds nothing new dispatches nothing.
 */
export const OPENCODE_V2_AUX_RESYNC_INTERVAL_MS = 30_000;
/**
 * The most entries a long-lived per-controller collection may hold.
 *
 * The reducer's existing 256-item windows are the precedent: the controller's
 * sets were the one place with no bound at all, and they now share the same
 * number so there is one policy rather than two.
 */
export const OPENCODE_V2_RETENTION_CAP = 256;
/**
 * How long an untouched entry survives in a long-lived collection.
 *
 * Measured from the last touch, not from creation: an entry that is still
 * being consulted is alive, and one that has not been touched since it settled
 * is stale.
 */
export const OPENCODE_V2_RETENTION_TTL_MS = 30 * 60 * 1000;
export const OPENCODE_V2_DIAGNOSTIC_COUNT_CAP = 256;
export const OPENCODE_V2_FORM_FIELD_LIMIT = 100;
export const OPENCODE_V2_FORM_OPTION_LIMIT = 100;

/**
 * How often the retry banner recomputes its countdown from the absolute
 * deadline. The countdown is derived, never stored, so this is only a repaint
 * cadence — it does not create a retry or keep one alive.
 */
export const OPENCODE_RETRY_TICK_MS = 500;

/**
 * How long a session-restoration notice stays visible after a verified reuse.
 * It is an auto-hide duration, not a claim about how long the session lived.
 */
export const OPENCODE_RECOVERY_NOTICE_MS = 12_000;

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;

/**
 * Formats the seconds remaining in a live retry ("45s", "2m 5s", "1h 3m").
 *
 * Feature-local on purpose: the tool and scheduler formatters answer different
 * questions and are documented as intentionally different. The input is a
 * DERIVED remaining time; this function never invents a deadline.
 *
 * @param remainingSeconds - Seconds left, clamped at zero.
 * @returns A short human duration.
 */
export function formatRetryCountdown(remainingSeconds: number): string {
  // A non-finite value is not a deadline. Rendering "NaNh NaNm" would put the
  // bug in front of the reader, so it degrades to the same "no number" answer
  // as a passed deadline.
  const total = Number.isFinite(remainingSeconds) ? Math.max(0, Math.floor(remainingSeconds)) : 0;
  if (total < SECONDS_PER_MINUTE) return `${total}s`;
  if (total < SECONDS_PER_HOUR) {
    const minutes = Math.floor(total / SECONDS_PER_MINUTE);
    const seconds = total % SECONDS_PER_MINUTE;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(total / SECONDS_PER_HOUR);
  const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
