/**
 * The SHARED context contract: what TBAi believes about a model's context, and
 * how confident it is.
 *
 * ## Why one contract for two engines
 *
 * TBAi has two execution surfaces. Code delegates to OpenCode; Direct runs on
 * AI SDK 7. They must not share internals - but they must answer the SAME
 * user-visible questions identically, or the meter and the budget disagree
 * about one model depending on which tab is open.
 *
 * So the vocabulary lives here and both surfaces speak it. What each surface
 * *feeds* the contract differs, and that is correct: OpenCode already measures
 * occupancy itself, Direct has to measure it from the provider's own per-request
 * accounting.
 *
 * ## OCCUPANCY IS NOT TRAFFIC - the distinction this module exists to enforce
 *
 * Two different numbers get called "tokens":
 *
 *  - OCCUPANCY: the size of the prompt the provider was actually asked to hold.
 *    This is what fills the context window and what the meter must show.
 *  - TRAFFIC: every token billed across a turn. A tool-using turn makes several
 *    model calls and each one re-reads the whole prompt, so traffic can exceed
 *    the window several times over.
 *
 * Proven against AI SDK 7 (`ai@7.0.93`) with a real HTTP round trip and a stub
 * reporting 5,000 then 9,000 prompt tokens over two steps:
 *
 *   per-step inputTokens ....... [5000, 9000]
 *   totalUsage.inputTokens .... 14000   <- sum of steps. TRAFFIC.
 *   last step inputTokens ..... 9000<- the final round trip. OCCUPANCY.
 *
 * `totalUsage` is built by `addLanguageModelUsage(totalUsage, step.usage)` over
 * every step (`ai/dist/index.js:6292`), so it is arithmetic traffic by
 * construction and must never reach a context meter.
 *
 * The last step's input is the provider's own count of the prompt for the final
 * model call. That is the direct equivalent of the field OpenCode reports as
 * `tokens.total` and which OpenChamber's meter reads in preference to summing.
 *
 * It is a measurement of the LAST round trip, so the next request is slightly
 * larger (it adds the assistant turn and the new user message). It is the best
 * measured occupancy available, not an exact prediction - and the local estimate
 * remains the preventive signal for the request about to be sent.
 */

/** How the effective context window was established. Never presented as verified when it is not. */
export type ContextLimitProvenance =
  | "provider_reported"
  | "configured"
  /**
   * Stated by the provider while rejecting an over-long request.
   *
   * A real figure, so it must be carried rather than folded into `unknown` — a reading
   * that shows 524288 while claiming the window is unknown contradicts itself. Weaker
   * than a published listing, and worded as such in the UI.
   */
  | "observed"
  | "conservative_default"
  | "unknown";

/**
 * The current model-visible input, and where that number came from.
 *
 * `provider` is a real measurement of a prompt the provider accepted. `estimate`
 * is TBAi's own character heuristic, which exists to decide whether to compact
 * BEFORE sending - never to assert that the provider would refuse.
 */
export type OccupancyMeasurement =
  | {
      readonly kind: "provider";
      /** Prompt tokens the provider reported for the last model call of the turn. */
      readonly inputTokens: number;
      /** Cached portion of that prompt, when the provider broke it out. */
      readonly cachedInputTokens?: number;
      /** Which provider field this came from. Explicit so it is auditable. */
      readonly field: "last_step_input_tokens";
    }
  | {
      readonly kind: "estimate";
      readonly inputTokens: number;
      readonly field: "chars_per_token";
    };

/** One snapshot of everything the UI and the budget need to agree on. */
export interface ContextState {
  /** Current model-visible input. */
  readonly usedTokens: number;
  /** Effective context window in force for this model. */
  readonly windowTokens: number;
  /** Where `windowTokens` came from. */
  readonly windowSource: ContextLimitProvenance;
  /** Input budget after output reservation and safety margin. */
  readonly usableInputTokens: number;
  /** How `usedTokens` was established, or `undefined` when nothing is known yet. */
  readonly measurement?: OccupancyMeasurement;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Narrow an arbitrary provenance string to the contract.
 *
 * An unrecognised value becomes `unknown` rather than defaulting to a trusted
 * one: a fallback must never be presented as provider-verified.
 */
export function toLimitProvenance(value: unknown): ContextLimitProvenance {
  switch (value) {
    case "provider_reported":
    case "configured":
    case "observed":
    case "conservative_default":
      return value;
    default:
      return "unknown";
  }
}

/**
 * Extract the provider-measured occupancy from an AI SDK 7 step usage.
 *
 * `usage` here is a single step's `LanguageModelUsage`, whose `inputTokens` is
 * that ONE request's prompt size - already the occupancy, never traffic.
 *
 * Returns `undefined` for anything unusable so a caller falls back to the
 * estimate rather than reporting a fabricated zero.
 */
export function providerOccupancyFromStepUsage(usage: unknown): OccupancyMeasurement | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const input = (usage as { inputTokens?: unknown }).inputTokens;
  if (!isPositiveInt(input)) return undefined;
  const details = (usage as { inputTokenDetails?: { cacheReadTokens?: unknown } }).inputTokenDetails;
  const cacheRead = details?.cacheReadTokens;
  return {
    kind: "provider",
    inputTokens: Math.floor(input),
    ...(isPositiveInt(cacheRead) ? { cachedInputTokens: Math.floor(cacheRead) } : {}),
    field: "last_step_input_tokens",
  };
}

/**
 * Choose the occupancy to report.
 *
 * The provider measurement wins whenever it exists. The estimate is a fallback
 * for the very first turn, for providers that report no usage, and for the
 * request currently being assembled (which by definition has no measurement yet).
 */
export function resolveOccupancy(input: {
  provider?: OccupancyMeasurement | undefined;
  estimatedTokens?: number | undefined;
}): OccupancyMeasurement | undefined {
  if (input.provider?.kind === "provider" && isPositiveInt(input.provider.inputTokens)) {
    return input.provider;
  }
  if (isPositiveInt(input.estimatedTokens)) {
    return { kind: "estimate", inputTokens: Math.floor(input.estimatedTokens), field: "chars_per_token" };
  }
  return undefined;
}

/**
 * Build the state both surfaces publish.
 *
 * `windowTokens` is required: a meter with no denominator cannot honestly report
 * a percentage, so an absent window yields `undefined` rather than a guess.
 */
export function buildContextState(input: {
  occupancy: OccupancyMeasurement | undefined;
  windowTokens: unknown;
  windowSource: unknown;
  usableInputTokens: unknown;
}): ContextState | undefined {
  const usedTokens = input.occupancy?.inputTokens;
  const windowTokens = input.windowTokens;
  if (!isPositiveInt(usedTokens) || !isPositiveInt(windowTokens)) return undefined;
  return {
    usedTokens: Math.floor(usedTokens),
    windowTokens: Math.floor(windowTokens),
    windowSource: toLimitProvenance(input.windowSource),
    usableInputTokens: isPositiveInt(input.usableInputTokens) ? Math.floor(input.usableInputTokens) : Math.floor(windowTokens),
    ...(input.occupancy ? { measurement: input.occupancy } : {}),
  };
}