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
export const OPENCODE_V2_HISTORY_CONVERGENCE_PASS_CAP = 4;
export const OPENCODE_V2_DIAGNOSTIC_COUNT_CAP = 256;
export const OPENCODE_V2_FORM_FIELD_LIMIT = 100;
export const OPENCODE_V2_FORM_OPTION_LIMIT = 100;
