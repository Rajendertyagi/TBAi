/**
 * Reading a model's real context window out of a provider's own overflow error.
 *
 * ## Why this exists
 *
 * Some providers publish no context-window metadata at all. Verified for the
 * configured `custom` gateway: `GET /v1/models` returns only `id`, `object`,
 * `created`, `owned_by` and `supported_endpoint_types`, and no other metadata
 * endpoint exists. TBAi's registry therefore has nothing to read, and limit
 * resolution falls to the conservative stand-in — which refuses a large part of a
 * window the model actually has.
 *
 * The one place the provider DOES state its limit is the rejection itself:
 *
 * ```text
 * ContextWindowExceededError: The input (950284 tokens) is longer than the
 * model's context length (524288 tokens).
 * ```
 *
 * That is the provider asserting its own limit, so it is authoritative in the same
 * sense a listing would be — but it is *observed*, not *declared*, and the two must
 * never be reported as the same kind of knowledge. Hence a separate provenance
 * value rather than a silent promotion to `provider_reported`.
 *
 * ## What this module deliberately does NOT do
 *
 * - It does not return provider text. Only a number crosses this boundary, so a
 *   value learned here can never leak a message body into a log or a response.
 * - It is not provider-specific. It matches the *shape* providers use when they
 *   state a limit, which is a labelled figure next to a context keyword.
 * - It does not match arbitrary integers. The example error above contains TWO
 *   numbers — the input size and the limit — and learning the input size as the
 *   window would be catastrophic in the other direction.
 * - It does not persist anything. See `src/context/observed-limits.ts`.
 *
 * ## Failure containment
 *
 * Every input that is not an unambiguous, in-range, labelled limit yields
 * `undefined`. Guessing a window is far worse than not knowing one: the unknown
 * path is already safe (a conservative stand-in and a provider rejection), whereas a
 * wrong number silently mis-plans compaction and mis-reports occupancy.
 */

import { classifyError } from "./errors";

/**
 * Smallest window worth believing.
 *
 * Below this no real chat model exists, so a figure this small is a misparse — some
 * other number wearing a context keyword — not a limit.
 */
export const MIN_OBSERVED_CONTEXT_TOKENS = 1_024;

/**
 * Largest window worth believing.
 *
 * Well beyond any shipping model, and comfortably below `Number.MAX_SAFE_INTEGER`.
 * A larger figure means the regex matched something that is not a limit (a byte
 * count, a concatenated id, an exponent).
 */
export const MAX_OBSERVED_CONTEXT_TOKENS = 10_000_000;

/**
 * A stated context limit, matched as a LABEL followed closely by its figure.
 *
 * Two deliberate shapes:
 *
 * 1. The keyword must be `context` + (`length`|`window`|`size`), optionally
 *    separated by whitespace, `_` or `-`. This is what rejects the input size in
 *    "The input (950284 tokens)…" — `input` is not a context keyword.
 * 2. Between the keyword and the digits only CONNECTORS may appear. An unbounded
 *    `[^0-9]*` would let the pattern walk from `ContextWindowExceededError` all the
 *    way across the message to whichever number came first, which is how an extractor
 *    ends up confidently returning the wrong figure.
 *
 * The keyword alternative also absorbs the CamelCase exception name
 * (`ContextWindowExceededError`): `ExceededError` is not a connector, so that
 * occurrence cannot match.
 */
const OBSERVED_LIMIT_PATTERN =
  /(?:max(?:imum)?\s+)?context[\s_-]*(?:length|window|size)\s*(?:is|of|was|=|:|\(|\)|\s)*(\d[\d,]{0,14})\b/gi;

/**
 * The text an error carries, without ever returning it.
 *
 * `APICallError` exposes the provider body twice — once as a string
 * (`responseBody`) and once parsed (`data`) — and the useful figure can sit in
 * either, depending on the provider and the SDK version. Both are read; neither is
 * returned. `message` is included because some adapters surface the provider's text
 * only there.
 */
function providerTextCandidates(error: unknown): string[] {
  if (typeof error !== "object" || error === null) return [];
  const record = error as Record<string, unknown>;
  const out: string[] = [];

  const message = record.message;
  if (typeof message === "string" && message.length > 0) out.push(message);

  const body = record.responseBody;
  if (typeof body === "string" && body.length > 0) out.push(body);

  const data = record.data;
  if (typeof data === "object" && data !== null) {
    const nested = (data as Record<string, unknown>).error;
    if (typeof nested === "object" && nested !== null) {
      const nestedMessage = (nested as Record<string, unknown>).message;
      if (typeof nestedMessage === "string" && nestedMessage.length > 0) out.push(nestedMessage);
    }
    const dataMessage = (data as Record<string, unknown>).message;
    if (typeof dataMessage === "string" && dataMessage.length > 0) out.push(dataMessage);
  }

  return out;
}

/**
 * Parse one candidate figure, rejecting anything not a plausible token count.
 *
 * Commas are stripped because providers write both `524288` and `524,288`.
 */
function parseTokenCount(raw: string): number | undefined {
  const digits = raw.replace(/,/g, "");
  if (!/^\d+$/.test(digits)) return undefined;
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return undefined;
  if (value < MIN_OBSERVED_CONTEXT_TOKENS) return undefined;
  if (value > MAX_OBSERVED_CONTEXT_TOKENS) return undefined;
  return value;
}

/**
 * The context length a provider stated while rejecting an over-long request.
 *
 * Returns `undefined` unless ALL of the following hold:
 *
 * - the error is already classified `context_overflow`, so a rate-limit or auth
 *   failure can never contribute a figure;
 * - some carrier holds a CONTEXT-LABELLED number;
 * - that number is an integer inside {@link MIN_OBSERVED_CONTEXT_TOKENS}…
 *   {@link MAX_OBSERVED_CONTEXT_TOKENS}.
 *
 * When several labelled figures are present the first is taken. A message that
 * states a limit twice with different values is vanishingly rare, and guessing
 * "the bigger one" would be exactly the arbitrary-number matching this avoids.
 *
 * @param error The raw provider error, exactly as the transport surfaced it.
 * @returns The stated limit in tokens, or `undefined` when none can be trusted.
 */
export function observedContextLength(error: unknown): number | undefined {
  // Two guards before anything else, both learned the hard way:
  //
  // 1. A non-object carrier is not an error. `classifyError` reaches into the value
  //    and THROWS on `undefined` (inside the logger's redaction), so calling it first
  //    would turn a malformed input into a crash.
  // 2. `classifyError` is itself fallible for shapes it does not expect. This function
  //    runs on the provider-error path, where a secondary throw is strictly worse than
  //    learning nothing — so a classification failure yields `undefined`, never an
  //    exception. Observing a window is an optimisation; it must never be able to fail
  //    a turn.
  if (typeof error !== "object" || error === null) return undefined;

  let category: string;
  try {
    category = classifyError(error).category;
  } catch {
    return undefined;
  }
  if (category !== "context_overflow") return undefined;

  for (const text of providerTextCandidates(error)) {
    // Fresh lastIndex per carrier: the pattern is global, and sharing state across
    // strings would let one carrier's position skip another's first match.
    const pattern = new RegExp(OBSERVED_LIMIT_PATTERN.source, "gi");
    for (;;) {
      const match = pattern.exec(text);
      if (match === null) break;
      const parsed = parseTokenCount(match[1] ?? "");
      if (parsed !== undefined) return parsed;
    }
  }

  return undefined;
}
