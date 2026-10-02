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
  /**
   * The request exceeded the model's context window. Added by Phase 2 because
   * Phase 1 established (F7) that this was indistinguishable from a
   * configuration error, which made it both misreported and unactionable: the
   * user was told to "retry or pick another provider/model", and retrying an
   * oversized request reproduces it.
   *
   * Deliberately NOT retryable. The remediation is to shrink the context or
   * change model, never to send the same request again.
   */
  | "context_overflow"
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
  /**
   * True when a `config` failure is specifically the provider rejecting the
   * MODEL (an unknown/withdrawn/never-shipped model id) rather than rejecting
   * the request that referenced it.
   *
   * Both land in the same coarse `config` bucket — deliberately, since neither
   * is retryable — but they need OPPOSITE advice: switching model fixes a bad
   * model id, and switching model does nothing for a rejected request. A flag
   * keeps the classification (and therefore every existing policy decision:
   * retry, log fields, diagnostics) byte-identical while letting the display
   * layer tell the two apart.
   *
   * Only ever set when the category is `config`.
   */
  modelIdentity?: boolean;
}

const CANCELLED_RE = /abort|cancel|stopped/i;
const AUTH_RE =
  /401|403|unauthorized|forbidden|invalid api key|invalid_api_key|incorrect api key|authentication|credential|api key.*missing|no api key/i;
const RATE_RE = /429|rate limit|rate_limit|quota|too many requests/i;
const NETWORK_RE = /fetch failed|econn|enotfound|eai_again|socket|network/i;
const TIMEOUT_RE = /timeout|timed out/i;
const CONFIG_RE =
  /invalid model|model.*not found|invalid.*provider|invalid.*cron|not found|workspace|outside the workspace|approval|refus|permission denied|user approval required/i;

/**
 * The MODEL-IDENTITY subset of {@link CONFIG_RE}: the provider refusing the
 * model itself, as opposed to refusing the request built around it.
 *
 * Provider-worded, and deliberately narrower than `CONFIG_RE`'s `not found`,
 * which also matches unrelated application text ("conversation not found") and
 * must not be reported as a bad model id. OpenAI says "model_not_found" /
 * "does not exist"; Anthropic says "model: ... not found"; gateways commonly
 * pass either through.
 *
 * A false positive is the worse error: it would tell a user to switch models
 * when the request itself is what the provider rejected. So a miss degrades to
 * the accurate generic 4xx copy instead of lying.
 */
const MODEL_IDENTITY_RE =
  /\bmodel[_ -]?not[_ -]?found\b|\bno such model\b|\bunknown model\b|\bunsupported model\b|\binvalid model\b|\bmodel\b[^.]{0,80}\b(?:not found|does not exist|doesn't exist|unavailable|deprecated)\b/i;
const TOOL_SUBJECT_RE = /tool|mcp/i;
const TOOL_OUTCOME_RE = /error|fail/i;

/**
 * Context-window overflow, as providers actually word it.
 *
 * Phase 1 finding F7: an oversized request was classified into the generic
 * `config` bucket and the user was told "Generation failed. Retry or pick another
 * provider/model." — which is both wrong and unactionable, because retrying an
 * oversized request reproduces it. With `DIRECT_MAX_RETRIES = 0`
 * (`chat.ts:54-55`) nothing retried it either, so the user simply got a
 * misleading message.
 *
 * This is a COARSE category rather than a refinement, and is matched AHEAD of
 * the 4xx/config branch on purpose: an overflow arrives as a 400, so without
 * precedence the status line would claim it first. It is matched ahead of
 * `CANCELLED_RE` too, because "maximum context length" prose does not collide
 * with the cancel vocabulary but a provider may append it to a 400 body.
 *
 * Patterns are provider-worded, not invented: Anthropic says
 * "prompt is too long" / "input length and `max_tokens` exceed context limit";
 * OpenAI says "maximum context length" / "reduce the length of the messages";
 * Google says "prompt is too long" / "input length exceeds the maximum"; the
 * common AI SDK wording is "context length" / "context window" / "too many
 * tokens". The vocabulary is broad on purpose: a miss here degrades to the old
 * generic message, and a false positive would misreport an unrelated 400.
 */
const CONTEXT_OVERFLOW_RE =
  /prompt is too long|context length|context window|maximum context|exceeds context|input length (is )?(too )?(long|exceeds)|too many tokens|reduce the length of the messages|exceeds the maximum|input is too long|request too large for/i;

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

/**
 * Allowlisted, machine-readable provider rejection fields.
 *
 * Every field here is a short identifier the PROVIDER chose to label its own
 * failure with. That is the whole security argument for including them: a
 * provider that names its own error also has no reason to put a prompt, a tool
 * argument or a credential in a machine code field, whereas the same body
 * returned as prose routinely does.
 */
export interface ProviderErrorCodeFields {
  /** Provider error `type` (e.g. `invalid_request_error`). */
  errorType?: string;
  /** Provider error `code` (e.g. `model_not_found`). */
  errorCode?: string | number;
  /** Provider error `param` — which field it rejected, e.g. `messages[9].tool_calls`. */
  errorParam?: string;
}

/**
 * The provider's OWN machine identifiers for a failed call, and nothing else.
 *
 * ## Why this reads `data` and never `responseBody`
 *
 * `APICallError` carries three things this function must treat very differently:
 *
 *  - `data` — the provider's parsed error OBJECT. Read here, and only for the
 *    three allowlisted scalar fields above.
 *  - `responseBody` — the same content as an UNPARSED string. A gateway that
 *    echoes the offending request puts the user's prompt, their tool arguments
 *    and their file contents in here. Never logged, at any level.
 *  - `requestBodyValues` — the ENTIRE outbound request TBAi sent. It contains
 *    the system prompt and every message by definition. Never read.
 *
 * `param` is included precisely because it is the field that makes a rejection
 * actionable without being revealing: a provider answering
 * `param: "messages[9].tool_calls[0].function.arguments"` tells an engineer the
 * exact wire defect while quoting none of the user's data.
 *
 * Returns an empty object when the error is not a provider API error or the
 * provider supplied none of the allowlisted fields — absence must never be
 * papered over with a guess.
 */
export function providerErrorCodeFields(err: unknown): ProviderErrorCodeFields {
  if (err === null || typeof err !== "object") return {};
  const data = (err as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return {};
  // OpenAI-shaped: `{ error: { type, code, param } }`. Read defensively — a
  // provider may return the fields at the top level, or omit all of them.
  const envelope = data as Record<string, unknown>;
  const inner =
    envelope.error !== null && typeof envelope.error === "object"
      ? (envelope.error as Record<string, unknown>)
      : envelope;
  const out: ProviderErrorCodeFields = {};
  const type = inner.type;
  if (typeof type === "string" && type.length > 0) out.errorType = type;
  const code = inner.code;
  if (typeof code === "string" || typeof code === "number") out.errorCode = code;
  const param = inner.param;
  // `param` is provider-authored but occasionally an object/array; only the
  // scalar form is ever a field name, so anything else is dropped rather than
  // stringified into the log.
  if (typeof param === "string" && param.length > 0) out.errorParam = param;
  return out;
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
  // Ahead of the 4xx/config branch: an overflow ARRIVES as a 400, so without
  // this precedence the status line claims it and the user is told to change
  // their provider. Ahead of `rate_limit` for the same reason - a quota error
  // mentioning token counts must not be read as a size problem.
  else if (CONTEXT_OVERFLOW_RE.test(text)) base = "context_overflow";
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

  const category = refineCategory(base, text);
  const out: ClassifiedError = {
    category,
    statusCode: status,
    provider: opts?.provider,
    retryable,
    errorType: norm.errorType,
    message: norm.message,
  };
  if (BILLING_RE.test(text)) out.billing = true;
  // Checked against the REFINED category, so a failure the refinements claimed
  // (`validation`) never also claims to be a model-identity problem. Nothing
  // about retryability or the coarse category depends on this flag.
  if (category === "config" && MODEL_IDENTITY_RE.test(text)) out.modelIdentity = true;
  return out;
}
