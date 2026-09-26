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
  | "validation"
  | "config"
  | "tool"
  | "provider"
  | "invalid_stream"
  | "database"
  | "lifecycle"
  | "runtime"
  | "transport"
  | "unknown";

export interface ClassifiedError {
  category: ErrorCategory;
  statusCode?: number;
  provider?: string;
  retryable: boolean;
  errorType: string;
  message: string;
  /**
   * True when the failure is a provider-side billing/credit condition (not a
   * transient throttle). Deliberately a FLAG rather than a category: the
   * coarse category stays `rate_limit`/`provider` so retry policy is
   * unchanged, while logs and diagnostics can still tell the two apart.
   */
  billing?: boolean;
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

// ---------------------------------------------------------------------------
// Refinement markers. These split the two COARSE buckets (`config`, `unknown`)
// into actionable categories. They are applied only to those two buckets, and
// never to retryability (which is computed from the coarse category), so
// extending the vocabulary cannot change retry behavior or user-facing copy.
// Each pattern is deliberately specific: a generic word like "invalid" would
// swallow the existing `config` cases (`invalid model`, `invalid provider`).
// ---------------------------------------------------------------------------

/** Explicit request-validation rejections (Zod boundaries, malformed input). */
const VALIDATION_RE =
  /\bvalidation\b|invalid request|invalid query|invalid body|invalid payload|invalid log settings|invalid port|invalid startup|invalid scope|unprocessable|zod|schema validation/i;
/** SQLite / persistence faults. */
const DATABASE_RE =
  /sqlite|database is locked|database is closed|no such table|no such column|constraint failed|unique constraint|db_unavailable/i;
/** Process/boot lifecycle faults (startup, shutdown, listener ownership). */
const LIFECYCLE_RE =
  /\bstartup_failed\b|\bshutdown\b|server_not_running|port_bind_failed|port_persist_failed|is shutting down|not been started/i;
/** Programming errors that escape to a runtime boundary. */
const RUNTIME_RE =
  /\b(TypeError|ReferenceError|RangeError|SyntaxError|URIError)\b|is not a function|is not a constructor|cannot read propert|of undefined|of null|invariant/i;
/** Stream/connection transport faults (not DNS/connectivity, which is `network`). */
const TRANSPORT_RE =
  /incomplete chunked|err_incomplete|controller is already closed|premature close|stream (closed|error|aborted)|socket hang up|other side closed|econnreset/i;
/** Provider-side billing/credit exhaustion. */
const BILLING_RE =
  /insufficient balance|insufficient credit|out of credit|credit balance|insufficient_quota|billing|payment required|\b402\b|exceeded your current quota|quota exceeded/i;

// ---------------------------------------------------------------------------
// Provider-response conformance.
//
// A provider that answers 200 with a body the SDK cannot use (unparseable JSON,
// a payload that fails schema validation, a stream part of an unknown shape) is a
// DISTINCT failure from a transport hiccup, and the two need different user copy
// and different retry advice. It is recognised by the AI SDK's own error NAME —
// an authoritative signal — never by matching prose, which is how the coarse
// buckets below would misread it ("Type validation failed" is not a validation
// rejection of *our* request; a malformed `tool-call` delta is not a tool failure).
//
// Deliberately a COARSE base, not a `refineCategory` refinement: a refinement is
// unreachable once a prose heuristic has claimed the bucket, and the whole point is
// that these names win over the prose. See `classifyError` for the precedence.
// ---------------------------------------------------------------------------

/** SDK error names meaning "the provider's response was unusable". */
const PROVIDER_RESPONSE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "AI_InvalidStreamPartError",
  "AI_StreamProviderError",
  "AI_InvalidResponseDataError",
  "AI_TypeValidationError",
  "AI_JSONParseError",
  "AI_EmptyResponseBodyError",
]);

/**
 * True when this SDK error means the provider's response was unusable.
 *
 * `AI_APICallError` is deliberately NOT in the set: it is how every 401, 429 and
 * 5xx arrives, and treating it as a conformance fault would swallow `auth` and
 * `rate_limit`. It qualifies only in the one case that is genuinely a conformance
 * problem — a call that reported success but returned an unusable body. In
 * practice providers surface that as a parse/validation error instead, so this
 * branch is defence rather than a hot path.
 */
function isProviderResponseError(errorType: string, status: number | undefined): boolean {
  if (errorType === "AI_APICallError") {
    return status !== undefined && status >= 200 && status < 300;
  }
  return PROVIDER_RESPONSE_ERROR_NAMES.has(errorType);
}

/**
 * Narrows a coarse category into a more actionable one. Only `config` and
 * `unknown` are refined — every other category is already specific and is
 * returned untouched, which is what keeps the existing contract stable.
 */
function refineCategory(base: ErrorCategory, text: string): ErrorCategory {
  if (base === "config") return VALIDATION_RE.test(text) ? "validation" : base;
  if (base !== "unknown") return base;
  if (VALIDATION_RE.test(text)) return "validation";
  if (DATABASE_RE.test(text)) return "database";
  if (LIFECYCLE_RE.test(text)) return "lifecycle";
  if (RUNTIME_RE.test(text)) return "runtime";
  if (TRANSPORT_RE.test(text)) return "transport";
  return base;
}

export type ErrorLogFields = Omit<ClassifiedError, "message">;

/**
 * Return only classification fields that are safe to emit through a logger.
 * The raw provider/tool message remains available to user-facing sanitizers
 * but never crosses the structured logging boundary.
 */
export function errorLogFields(
  err: unknown,
  opts?: { provider?: string },
): ErrorLogFields {
  const classified = classifyError(err, opts);
  return {
    category: classified.category,
    statusCode: classified.statusCode,
    provider: classified.provider,
    retryable: classified.retryable,
    errorType: classified.errorType,
    ...(classified.billing ? { billing: true } : {}),
  };
}

export function classifyError(err: unknown, opts?: { provider?: string }): ClassifiedError {
  const norm = normalizeError(err, false);
  const text = `${norm.errorType} ${norm.message} ${norm.code ?? ""}`;
  const status = norm.status;

  let base: ErrorCategory = "unknown";
  if (CANCELLED_RE.test(text)) base = "cancelled";
  else if (status === 401 || status === 403 || AUTH_RE.test(text)) base = "auth";
  else if (status === 429 || RATE_RE.test(text)) base = "rate_limit";
  // Ahead of every prose heuristic below, and behind only the two facts the
  // display layer is entitled to trust: the user cancelled, or the provider
  // returned a status that already names the condition.
  else if (isProviderResponseError(norm.errorType, status)) base = "invalid_stream";
  else if (NETWORK_RE.test(text)) base = "network";
  else if (status === 408 || TIMEOUT_RE.test(text)) base = "timeout";
  else if (
    (status !== undefined && status >= 400 && status < 500 && status !== 408) ||
    CONFIG_RE.test(text)
  )
    base = "config";
  else if (TOOL_SUBJECT_RE.test(text) && TOOL_OUTCOME_RE.test(text)) base = "tool";
  // A 5xx is only a *provider* failure when we know which provider; otherwise
  // it is an unknown server-side fault. Either way it is retryable.
  else if (status !== undefined && status >= 500)
    base = opts?.provider ? "provider" : "unknown";

  // Retryability comes from the COARSE category — the pre-existing policy.
  // Deriving it here (rather than from the refined label) is what guarantees
  // that widening the REFINEMENT vocabulary cannot change retry behavior.
  //
  // `invalid_stream` is deliberately absent from that list. A response the SDK
  // could not parse is not a transient fault: retrying re-sends a request that
  // produced garbage, which is the same reasoning behind `DIRECT_MAX_RETRIES = 0`
  // on the Direct route. One behaviour changes as a result — a malformed stream
  // part whose text mentions a fetch failure used to read as a retryable network
  // error, and is now correctly non-retryable.
  const retryable =
    base === "rate_limit" ||
    base === "network" ||
    base === "timeout" ||
    (status !== undefined && status >= 500);

  const out: ClassifiedError = {
    category: refineCategory(base, text),
    statusCode: status,
    provider: opts?.provider,
    retryable,
    errorType: norm.errorType,
    message: norm.message,
  };
  if (BILLING_RE.test(text)) out.billing = true;
  return out;
}
