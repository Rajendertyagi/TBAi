import { findModelOption, type ModelGroup } from "../lib/model-groups";

/**
 * Single source of truth for the context-usage ring denominator.
 *
 * Resolution order (`resolveContextWindow`):
 * 1. a live `limit.context` reported by the model host (OpenCode
 *    `model.limit.context`) — always preferred, never configured;
 * 2. the model's configured `contextWindow` from the provider settings
 *    (per-model field on the provider's model list, filled by discovery
 *    where providers expose it, editable in the provider dialog);
 * 3. `DEFAULT_MODEL_CONTEXT_WINDOW` — last resort for truly-unknown models
 *    (e.g. a hand-typed custom endpoint id with no configured window).
 *    Silent by approved decision; the alternative (an "unknown" ring state)
 *    would need an element deviation for zero diagnostic gain.
 *
 * No pricing lives here (cost is out of scope); no fabricated
 * system/tools/message splits; no per-model table in code — windows live in
 * provider configuration, exactly one fallback constant lives here.
 */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;

export interface ContextWindowSource {
  /** Live host-reported limit (e.g. OpenCode model.limit.context). */
  limitContext?: number | undefined;
  /** Bare model id, looked up in `groups` when no live limit applies. */
  modelId?: string | undefined;
  /** Provider groups (same source the model picker consumes). */
  groups?: readonly ModelGroup[] | undefined;
}

function validWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Compact display for a context window ("128k", "1M"). Pure. Used by
 * provider-settings surfaces; the ring itself formats internally.
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000)
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${tokens}`;
}

/**
 * Parse a user-typed context window. Returns the positive integer, or
 * undefined for blank (unset) and for anything that is not a positive
 * integer. Pure — the dialog commits only defined values or explicit unsets.
 */
export function parseContextWindowInput(text: string): number | undefined {
  const trimmed = text.trim().replace(/[,_\s]/g, "");
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

/**
 * Resolve the context window for the ring denominator. Pure.
 *
 * @returns A positive token count: live limit, else configured model window,
 * else the documented default.
 */
export function resolveContextWindow(source: ContextWindowSource): number {
  const live = validWindow(source.limitContext);
  if (live !== undefined) return live;
  if (source.modelId && source.groups) {
    const configured = validWindow(
      findModelOption(source.groups, source.modelId)?.contextWindow,
    );
    if (configured !== undefined) return configured;
  }
  return DEFAULT_MODEL_CONTEXT_WINDOW;
}
