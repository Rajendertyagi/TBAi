import type { TokenUsageInfo } from "@opencode/client";
import type { TokenUsage } from "@/components/assistant-ui/elements/context-display";

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTokenUsageInfo(value: unknown): value is TokenUsageInfo {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    total?: unknown;
    cache: { read?: unknown; write?: unknown } | null;
  };
  return (
    isNonNegativeNumber(candidate.input) &&
    isNonNegativeNumber(candidate.output) &&
    isNonNegativeNumber(candidate.reasoning) &&
    candidate.cache !== null &&
    typeof candidate.cache === "object" &&
    isNonNegativeNumber(candidate.cache.read) &&
    isNonNegativeNumber(candidate.cache.write)
  );
}

/**
 * Maps the generated native V2 `TokenUsageInfo` onto the display contract.
 * Input and output are the total buckets; reasoning and cache reads are
 * subdivisions and are never added again.
 *
 * @returns The display usage, or `undefined` when the payload is not valid V2.
 */
export function toTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!isTokenUsageInfo(raw)) return undefined;
  return {
    totalTokens: raw.input + raw.output,
    inputTokens: raw.input,
    outputTokens: raw.output,
    reasoningTokens: raw.reasoning,
    cachedInputTokens: raw.cache.read,
  };
}

/** How the context NUMERATOR was obtained. Never conflate the two cases. */
export type ContextNumeratorSource =
  /** The server's own final-round-trip window. Authoritative. */
  | "server_total"
  /**
   * Derived from the buckets because the server sent no `total`.
   *
   * A documented FALLBACK, not a measurement. Older servers omit `total`, and the
   * field sum is the closest honest approximation available - it is preferred
   * over refusing to render, and never presented as authoritative.
   *
   * It is also the sum that OVERSTATES a multi-step turn, because the input and
   * cache fields accumulate across round trips. That is exactly why a reported
   * `total` wins: this branch is the degraded path, not the design.
   */
  | "derived_input_output";

export interface CodeContextUsage {
  /** Spend breakdown. Unchanged semantics; NOT the ring numerator. */
  readonly usage: TokenUsage | undefined;
  /**
   * Current model-visible context, or `undefined` when nothing trustworthy is
   * known - which after a compaction is the correct answer, not zero.
   */
  readonly contextTokens: number | undefined;
  readonly numeratorSource: ContextNumeratorSource | undefined;
  /** Cached portion of the same prompt, for the breakdown only. */
  readonly cachedInputTokens: number | undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The Code surface's CURRENT model-visible context, matching OpenChamber.
 *
 * ## Why `total` wins
 *
 * Two numbers get called "tokens" here. OCCUPANCY is the prompt the provider
 * held; TRAFFIC is everything billed across a turn. A multi-step turn makes
 * several model calls and each re-reads the whole prompt, so summing them
 * reports a conversation as many times larger than the window that held it.
 *
 * OpenCode reports the final round trip's window as `total` on the usage
 * payload - optional, and absent on older servers. OpenChamber prefers it and
 * falls back to summing only when it is missing (`contextTokensFromBreakdown`).
 * This is that same rule, applied to the same field.
 *
 * ## What this deliberately does NOT do
 *
 * It never sums per-round-trip input, and it never adds cache reads to the
 * numerator. `cache.read` is a subdivision OF the same prompt the `total`
 * already contains; adding it is what produced OpenChamber's documented 330%
 * readout (`cache.read` 3,291,956 against a window that really held 232,872).
 * Cached tokens still appear in the spend breakdown, where they belong.
 */
export function toCodeContextUsage(raw: unknown): CodeContextUsage | undefined {
  if (!isTokenUsageInfo(raw)) return undefined;
  const reportedTotal = positive((raw as { total?: unknown }).total);
  return {
    usage: toTokenUsage(raw),
    contextTokens: reportedTotal ?? (positive(sumTokenBreakdown(raw)) ?? undefined),
    numeratorSource: reportedTotal !== undefined ? "server_total" : "derived_input_output",
    cachedInputTokens: raw.cache.read,
  };
}

/**
 * Every field of the breakdown, added up.
 *
 * Byte-for-byte OpenChamber's `sumTokenBreakdown`: `input + output + reasoning
 * + cache.read + cache.write`. Only ever reached when the server sent no
 * `total`, so this is the closest honest approximation available rather than a
 * measurement - and it is the sum that overstates a multi-step turn, which is
 * precisely why the reported total is preferred above.
 */
function sumTokenBreakdown(raw: TokenUsageInfo): number {
  return (
    raw.input +
    raw.output +
    raw.reasoning +
    (raw.cache?.read ?? 0) +
    (raw.cache?.write ?? 0)
  );
}