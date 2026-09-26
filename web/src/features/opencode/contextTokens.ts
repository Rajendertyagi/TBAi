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
    cache?: { read?: unknown; write?: unknown } | null;
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
