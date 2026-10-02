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
  return {
    usedTokens,
    windowTokens,
    windowSource:
      source === "provider_reported" ||
      source === "configured" ||
      source === "conservative_default"
        ? source
        : "unknown",
    usableInputTokens: positiveInt(raw.usableInputTokens) ?? windowTokens,
    occupancyKind,
    ...(positiveInt(raw.cachedInputTokens) ? { cachedInputTokens: positiveInt(raw.cachedInputTokens) } : {}),
  };
}

/**
 * The newest assistant message's server-measured context, or undefined.
 *
 * Latest-message scoped, exactly like the vendored usage hook: the context meter
 * describes the turn that just happened, and the next turn replaces it. It resets
 * with the thread because a new conversation has no prior measurement.
 */
export function useCurrentContext(): CurrentContext | undefined {
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
  return useMemo(() => (message ? parseCurrentContext(message.metadata) : undefined), [message]);
}