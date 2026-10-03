/**
 * Context-window display helpers, and the CODE-side window resolution.
 *
 * ## Direct does NOT resolve its context window here
 *
 * This module previously exported a `resolveContextWindow` that Direct's context ring
 * used as a fallback, alongside its own `DEFAULT_MODEL_CONTEXT_WINDOW`. That made a
 * SECOND authority for the Direct effective window, with its own precedence and its own
 * 128k fallback — able to contradict the server's resolution, and able to do it while
 * reporting no provenance, so the meter could read "… / 128k" beside the words
 * "Context limit unknown".
 *
 * Direct no longer participates. `src/context/limits.ts` (`resolveContextLimit`) is the
 * one Direct authority; it applies precedence, keeps conflicting evidence, and ships
 * the value WITH its provenance on the message metadata. `DirectContextRing` consumes
 * that reading and renders nothing when it is absent. The frontend is a consumer of
 * Direct capability resolution, never an authority for it.
 *
 * ## What still lives here, and why
 *
 * `resolveContextWindow` remains for the CODE (OpenCode) ring only. Code's window
 * genuinely comes from Code sources — OpenCode's live `model.limit.context` and the
 * Code model catalogue — which is a different provenance chain with different inputs,
 * and folding it into the Direct contract would mean merging two unrelated sources
 * into one fake "normalized" model. Per the architecture, source-specific data stays
 * source-specific: this is Code's resolver, living here, and Direct must not call it.
 *
 * `web/src/config/directCapabilityAuthority.test.ts` enforces that boundary statically.
 *
 * No model-specific values live in this file, and none ever may.
 */
import { findModelOption, type ModelGroup } from "../lib/model-groups";

/**
 * CODE-ONLY fallback window. NOT a Direct value.
 *
 * Applies to the OpenCode ring when the host reports no limit and the model carries no
 * configured window. It is never used on a Direct path: Direct's equivalent ceiling
 * is the server's `UNKNOWN_LIMIT_CEILING`, which travels with its provenance so it can
 * be labelled as a fallback rather than presented as a model's window.
 */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;

/** Inputs to the CODE-side window resolution. */
export interface ContextWindowSource {
  /** Live host-reported limit (OpenCode `model.limit.context`). */
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
 * Resolve the CODE-side context window for the OpenCode ring. Pure.
 *
 * NOT for Direct. A Direct window must come from the server's resolution so that the
 * meter, the budget and the compaction trigger cannot disagree.
 *
 * @returns A positive token count: live host limit, else the Code model's configured
 *          window, else `DEFAULT_MODEL_CONTEXT_WINDOW`.
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
 *
 * This is the CONFIGURED-override entry point. The parsed value is stored per model
 * on the provider config, carries `source: "configured"`, and is resolved by the one
 * Direct server seam — so an operator can set a real window without any model value
 * ever appearing in application source.
 */
export function parseContextWindowInput(text: string): number | undefined {
  const trimmed = text.trim().replace(/[,_\s]/g, "");
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}
