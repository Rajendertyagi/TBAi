/** Centralized OpenCode frontend configuration. No magic paths inline. */
export const OPENCODE_PROXY_BASE_URL = "/api/opencode";
export const OPENCODE_DIRECTORY_HEADER = "x-opencode-directory";
/** Bounded wait for session init before surfacing a retry affordance. */
export const OPENCODE_INIT_TIMEOUT_MS = 15_000;
export const OPENCODE_V2_HISTORY_PAGE_SIZE = 100;
export const OPENCODE_V2_EVENT_BUFFER_LIMIT = 512;
export const OPENCODE_V2_RECENT_EVENT_ID_WINDOW = 256;
export const OPENCODE_V2_INITIAL_RECONNECT_DELAY_MS = 250;
export const OPENCODE_V2_MAX_RECONNECT_DELAY_MS = 10_000;
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
export const OPENCODE_V2_HISTORY_CONVERGENCE_PASS_CAP = 4;
export const OPENCODE_V2_DIAGNOSTIC_COUNT_CAP = 256;
export const OPENCODE_V2_FORM_FIELD_LIMIT = 100;
export const OPENCODE_V2_FORM_OPTION_LIMIT = 100;
