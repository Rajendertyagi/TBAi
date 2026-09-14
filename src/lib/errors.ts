import { normalizeError } from "./logger";

/**
 * Shared error classification — the single place that turns an arbitrary
 * thrown value into normalized fields. Logging (log fields) and user-facing
 * handling (UI copy, retry policy) both consume this; nothing classifies the
 * same error twice with diverging regexes.
 *
 * Conservative by design: unknown errors are non-retryable with a generic
 * message. Callers with domain knowledge (e.g. the scheduler's abort policy)
 * layer their own rules on top and document the divergence.
 */

export type ErrorCategory =
  | "cancelled"
  | "auth"
  | "rate_limit"
  | "network"
  | "timeout"
  | "config"
  | "tool"
  | "provider"
  | "unknown";

export interface ClassifiedError {
  category: ErrorCategory;
  statusCode?: number;
  provider?: string;
  retryable: boolean;
  errorType: string;
  message: string;
}

const CANCELLED_RE = /abort|cancel|stopped/i;
const AUTH_RE =
  /401|403|unauthorized|forbidden|invalid api key|invalid_api_key|incorrect api key|authentication|credential|api key.*missing|no api key/i;
const RATE_RE = /429|rate limit|rate_limit|quota|too many requests/i;
const NETWORK_RE = /fetch failed|econn|enotfound|eai_again|socket|network/i;
const TIMEOUT_RE = /timeout|timed out/i;
const CONFIG_RE =
  /invalid model|model.*not found|invalid.*provider|invalid.*cron|not found|workspace|outside the workspace|approval|refus|permission denied|user approval required/i;
const TOOL_SUBJECT_RE = /tool|mcp/i;
const TOOL_OUTCOME_RE = /error|fail/i;

export function classifyError(err: unknown, opts?: { provider?: string }): ClassifiedError {
  const norm = normalizeError(err, false);
  const text = `${norm.errorType} ${norm.message} ${norm.code ?? ""}`;
  const status = norm.status;

  let category: ErrorCategory = "unknown";
  if (CANCELLED_RE.test(text)) category = "cancelled";
  else if (status === 401 || status === 403 || AUTH_RE.test(text)) category = "auth";
  else if (status === 429 || RATE_RE.test(text)) category = "rate_limit";
  else if (NETWORK_RE.test(text)) category = "network";
  else if (status === 408 || TIMEOUT_RE.test(text)) category = "timeout";
  else if (
    (status !== undefined && status >= 400 && status < 500 && status !== 408) ||
    CONFIG_RE.test(text)
  )
    category = "config";
  else if (TOOL_SUBJECT_RE.test(text) && TOOL_OUTCOME_RE.test(text)) category = "tool";
  // A 5xx is only a *provider* failure when we know which provider; otherwise
  // it is an unknown server-side fault. Either way it is retryable.
  else if (status !== undefined && status >= 500)
    category = opts?.provider ? "provider" : "unknown";

  const retryable =
    category === "rate_limit" ||
    category === "network" ||
    category === "timeout" ||
    (status !== undefined && status >= 500);

  return {
    category,
    statusCode: status,
    provider: opts?.provider,
    retryable,
    errorType: norm.errorType,
    message: norm.message,
  };
}
