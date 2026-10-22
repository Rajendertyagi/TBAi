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
 */
export const OPENCODE_V2_READY_TIMEOUT_MS = 20_000;
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
 * The 4xx statuses that are NOT permanent: a retry can legitimately succeed.
 *
 * Used by the prompt path to decide whether a failure may be reported as a
 * definitive rejection instead of a transient one.
 */
export const OPENCODE_V2_RETRYABLE_HTTP_STATUSES: readonly number[] = [408, 409, 425, 429];
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
export const OPENCODE_V2_DIAGNOSTIC_COUNT_CAP = 256;
export const OPENCODE_V2_FORM_FIELD_LIMIT = 100;
export const OPENCODE_V2_FORM_OPTION_LIMIT = 100;
