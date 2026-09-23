import type { TokenUsage } from "@/components/assistant-ui/elements/context-display";

interface OpenCodeWireTokens {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  total?: unknown;
  cache?: { read?: unknown; write?: unknown } | undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Narrow structural view of the thread state the selector reads. Deliberately
 * minimal: `metadata` stays `unknown` (narrowed with `in`, never cast) so the
 * full runtime state is always assignable to it.
 */
export interface TokenThreadState {
  thread: {
    messages: readonly {
      role: string;
      metadata?: unknown;
    }[];
  };
}

/**
 * Select the store-held OpenCode `tokens` object for the newest token-bearing
 * assistant message. This is the STORE SELECTION half of the ring's data
 * contract — presentation mapping (`toTokenUsage`) happens outside, memoized.
 *
 * External-store law (React #185 is the penalty): the return must be
 * referentially stable while the store is unchanged. This function therefore
 * returns the EXISTING `metadata.custom.tokens` reference (or `undefined`)
 * and never allocates, clones, maps, filters, or spreads anything, and never
 * mutates state. Pure.
 */
export function selectOpenCodeRawTokens(state: TokenThreadState): unknown {
  const messages = state.thread.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const metadata = m.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      continue;
    }
    const custom: unknown =
      "custom" in metadata ? metadata.custom : undefined;
    if (!custom || typeof custom !== "object" || Array.isArray(custom)) {
      continue;
    }
    const tokens: unknown =
      "tokens" in custom ? custom.tokens : undefined;
    if (tokens !== undefined) return tokens;
  }
  return undefined;
}

/**
 * Map the OpenCode message `tokens` payload (as preserved by the adapter at
 * `metadata.custom.tokens`) onto the display `TokenUsage`.
 *
 * Prefers the server-reported total; falls back to the sum of reported parts
 * only when no total exists (documented — totals never double-count across
 * tool-call round-trips). Returns undefined when nothing usable is reported,
 * which keeps the ring hidden. Pure.
 */
export function toTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as OpenCodeWireTokens;
  const cache = t.cache && typeof t.cache === "object" ? t.cache : undefined;
  const usage: TokenUsage = {
    totalTokens: num(t.total),
    inputTokens: num(t.input),
    outputTokens: num(t.output),
    reasoningTokens: num(t.reasoning),
    cachedInputTokens: cache ? num(cache.read) : undefined,
  };
  if (usage.totalTokens !== undefined) return usage;
  const sum =
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.reasoningTokens ?? 0) +
    (usage.cachedInputTokens ?? 0);
  if (sum <= 0) return undefined;
  usage.totalTokens = sum;
  return usage;
}
