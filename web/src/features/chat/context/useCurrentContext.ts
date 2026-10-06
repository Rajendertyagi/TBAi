/**
 * The CURRENT model-visible context for a Direct thread, as the SERVER measured it.
 *
 * ## Why this exists
 *
 * The context ring used to divide the provider's accumulated `totalUsage` by the
 * context window. `totalUsage` is token TRAFFIC, not occupancy: the AI SDK
 * accumulates it with `addLanguageModelUsage` across every model call in a turn,
 * so one tool-using turn can report several times the window in "input" tokens.
 * The meter then displayed "100% full" while the conversation was nowhere near
 * full - which is exactly what a long Direct chat showed.
 *
 * The server already knows the truth. `assembleContext` measures what the provider
 * was actually sent, against the same budget it enforces, and the route ships that
 * measurement on the message metadata. This reads it. Nothing here recomputes,
 * estimates, or guesses a context size.
 *
 * ## What this is NOT
 *
 * Cumulative input, cached input, output and reasoning remain available separately
 * as `usage`. They answer "how much have I spent"; this answers "how full is the
 * conversation right now". The two are never merged, and the meter uses only this.
 */
import { useAuiState } from "@assistant-ui/react";
import { useMemo } from "react";

/** Where the effective context window came from, in provider-neutral terms. */
export type ContextWindowSource =
  | "provider_reported"
  | "configured"
  /**
   * Stated by the provider in the rejection it sent for an over-long request.
   *
   * A real figure, so the ring shows the number rather than "unknown" — but weaker than
   * a declared listing, and worded as such so the user is not told it was published.
   */
  | "observed"
  | "conservative_default"
  | "unknown";

export interface CurrentContext {
  /** Model-visible input for the last completed turn, server-measured. */
  usedTokens: number;
  /** Effective context window the budget used for this model. */
  windowTokens: number;
  /** Provenance of `windowTokens`. Never presented as verified when it is not. */
  windowSource: ContextWindowSource;
  /** Input budget available after safety margin and output reservation. */
  usableInputTokens: number;
  /**
   * Which resolution produced `windowTokens`, when the server published it.
   *
   * Present so a reading can be checked against the conversation it is being shown
   * for. Absent on readings from a server that did not publish identity; those are
   * still rendered, because the number itself is authoritative for its own turn.
   */
  resolvedFor?: { providerId: string | undefined; modelId: string };
  /**
   * How `usedTokens` was established.
   *
   * `provider` is the provider's own count of the prompt for the last model
   * call - a measurement. `estimate` is the server's local heuristic, which is
   * preventive only. `unknown` means no trustworthy number is available.
   */
  occupancyKind: OccupancyKind;
  /** Cached portion of the measured prompt, when reported. Never summed into `usedTokens`. */
  cachedInputTokens?: number;
}

/** Whether the occupancy figure is a measurement, a heuristic, or absent. */
export type OccupancyKind = "provider" | "estimate" | "unknown";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Parse the server's context state, or return undefined when it is absent.
 *
 * Exported for tests: the parsing rules are the contract, and a malformed or
 * missing payload must yield "no reading" rather than a fabricated one.
 */
export function parseCurrentContext(metadata: unknown): CurrentContext | undefined {
  if (!isRecord(metadata)) return undefined;
  // The route emits it at the top level of the message metadata; assistant-ui
  // moves unrecognised keys under `custom`, so both are accepted.
  const raw = isRecord(metadata.context)
    ? metadata.context
    : isRecord(metadata.custom) && isRecord(metadata.custom.context)
      ? metadata.custom.context
      : undefined;
  if (!raw) return undefined;
  const usedTokens = positiveInt(raw.usedTokens);
  const windowTokens = positiveInt(raw.windowTokens);
  if (usedTokens === undefined || windowTokens === undefined) return undefined;
  const source = raw.windowSource;
  // Absent means the server could not establish a trustworthy number. That is
  // reported as `unknown` rather than silently defaulting to a measurement.
  const occupancyKind: OccupancyKind =
    raw.occupancyKind === "provider" || raw.occupancyKind === "estimate" ? raw.occupancyKind : "unknown";
  const resolvedForRaw = isRecord(raw.resolvedFor) ? raw.resolvedFor : undefined;
  const modelId = resolvedForRaw && typeof resolvedForRaw.modelId === "string" ? resolvedForRaw.modelId : undefined;
  return {
    usedTokens,
    windowTokens,
    windowSource:
      source === "provider_reported" ||
      source === "configured" ||
      source === "observed" ||
      source === "conservative_default"
        ? source
        : "unknown",
    usableInputTokens: positiveInt(raw.usableInputTokens) ?? windowTokens,
    occupancyKind,
    // Identity is carried only when it is complete enough to compare. A partial
    // object is dropped rather than half-honoured: matching on provider alone would
    // accept a reading taken for a DIFFERENT model on the same provider.
    ...(resolvedForRaw && modelId
      ? {
          resolvedFor: {
            providerId: typeof resolvedForRaw.providerId === "string" ? resolvedForRaw.providerId : undefined,
            modelId,
          },
        }
      : {}),
    ...(positiveInt(raw.cachedInputTokens) ? { cachedInputTokens: positiveInt(raw.cachedInputTokens) } : {}),
  };
}

/**
 * What the caller believes the CURRENT conversation binding is.
 *
 * Used only to decide whether a published reading is still applicable — never to
 * compute a window. A reading whose `resolvedFor` names a different provider or model
 * describes a different resolution, so it is dropped rather than displayed as this
 * conversation's.
 */
export interface ExpectedResolution {
  readonly providerId: string | undefined;
  readonly modelId: string;
}

/**
 * Whether a reading still describes the conversation it is being shown for.
 *
 * `undefined` expected means "the caller has no binding to check against", in which
 * case the reading stands: it is an authoritative measurement of the last turn, and
 * discarding it would remove a true number.
 */
export function readingApplies(
  reading: CurrentContext,
  expected: ExpectedResolution | undefined,
): boolean {
  if (!expected) return true;
  // No published identity means the server did not say which resolution this was, so
  // it cannot be contradicted by a comparison. Rendered, never adjusted.
  if (!reading.resolvedFor) return true;
  if (reading.resolvedFor.modelId !== expected.modelId) return false;
  // Provider identity is compared only when BOTH sides have it. A server that omits
  // it is not treated as disagreeing with a known provider id.
  if (reading.resolvedFor.providerId !== undefined && expected.providerId !== undefined) {
    return reading.resolvedFor.providerId === expected.providerId;
  }
  return true;
}

/**
 * The newest assistant message's server-measured context, or undefined.
 *
 * Latest-message scoped, exactly like the vendored usage hook: the context meter
 * describes the turn that just happened, and the next turn replaces it. It resets
 * with the thread because a new conversation has no prior measurement.
 *
 * ## Why a reading can be WITHHELD rather than adjusted
 *
 * The reading is a per-turn sample, so it goes stale whenever the authority's inputs
 * change under it. When that happens the honest move is to show nothing: the current
 * authoritative window is not knowable from here, and substituting a locally derived
 * one is exactly the second authority this module exists to prevent. The ring already
 * renders nothing when it has no reading, so withholding needs no new presentation.
 *
 * @param expected The conversation's current provider/model binding, when known.
 */
export function useCurrentContext(expected?: ExpectedResolution): CurrentContext | undefined {
  const message = useAuiState((s) => {
    const messages = s.thread.messages as ReadonlyArray<{ role?: string; metadata?: unknown }> | undefined;
    if (!messages) return undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m?.role !== "assistant") continue;
      const parsed = parseCurrentContext(m.metadata);
      if (parsed) return m;
    }
    return undefined;
  });
  return useMemo(() => {
    if (!message) return undefined;
    const reading = parseCurrentContext(message.metadata);
    if (!reading) return undefined;
    return readingApplies(reading, expected) ? reading : undefined;
  }, [message, expected?.providerId, expected?.modelId]);
}