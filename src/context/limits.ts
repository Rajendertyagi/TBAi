/**
 * Model context-window resolution.
 *
 * This module is CAPABILITY LOOKUP ONLY. It answers "what limit was reported,
 * and where did it come from" and nothing else. Enforcement policy lives in
 * `budget.ts`, deliberately: a lookup that also decided policy could not be
 * reused by a different policy without lying about the model's capability.
 *
 * Phase 1 established (F14) that `contextWindow` is populated from a provider
 * response for ANTHROPIC ONLY (`modelDiscovery.ts:131`, `max_input_tokens`);
 * OpenAI, Google, Ollama and custom listings set none (`:111-119`, `:140-156`).
 * The frontend then falls back to a 128_000 display default
 * (`web/src/config/modelContext.ts:21`).
 *
 * That 128k is a DISPLAY DENOMINATOR. It is not evidence about any model and is
 * deliberately not imported here - a display default that becomes an enforcement
 * truth would make the context ring and the budget agree for the wrong reason.
 */

import type { ModelOption } from "../types";
import type { ContextLimit, OutputReservation } from "./types";

/**
 * Ceiling used when no real limit is known.
 *
 * NOT a claim about any model. It exists so an unknown limit degrades to
 * "bounded and conservative" rather than "unbounded", and it is reported with
 * `source: "default"` so no caller can mistake it for a reported figure. The
 * true limit may be much smaller; a request is rejected rather than sent when it
 * exceeds this.
 */
export const UNKNOWN_LIMIT_CEILING = 128_000;

/**
 * Output reservation when the model reports no output limit.
 *
 * A generation needs room to finish. Phase 1 established Direct reserved nothing
 * (F5), which let a request occupy the whole window. 4,096 is a deliberately
 * modest floor: it is enough for a short tool-calling turn, and small enough that
 * it does not meaningfully shrink usable input.
 */
export const DEFAULT_OUTPUT_RESERVATION = 4_096;

/** Clamp for a model-reported output ceiling, so a bad figure cannot invert the budget. */
const MAX_OUTPUT_RESERVATION = 32_000;

/**
 * Resolve the input limit for a (provider, model) pair.
 *
 * Returns provenance alongside the number. A caller that wants a number and
 * ignores `source` is misusing this function - that is the whole reason `source`
 * is a required field rather than a comment.
 */
export function resolveContextLimit(input: {
  providerType: ContextLimit["providerType"];
  modelId: string;
  /** Discovery metadata for the selected model, when the caller has it. */
  model?: Pick<ModelOption, "contextWindow">;
  /** A limit configured by the user, when present. */
  configuredContextWindow?: number | undefined;
}): ContextLimit {
  const { providerType, modelId, model, configuredContextWindow } = input;

  if (typeof model?.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
    return { maxInputTokens: Math.floor(model.contextWindow), source: "model_reported", providerType, modelId };
  }
  if (typeof configuredContextWindow === "number" && Number.isFinite(configuredContextWindow) && configuredContextWindow > 0) {
    return { maxInputTokens: Math.floor(configuredContextWindow), source: "configured", providerType, modelId };
  }
  // No real figure. Report the conservative ceiling as a DEFAULT, never as a
  // reported limit, so budget diagnostics can show that the number is a stand-in.
  return { maxInputTokens: UNKNOWN_LIMIT_CEILING, source: "default", providerType, modelId };
}

/**
 * Resolve the output reservation.
 *
 * Independent of any display-side context-ring arithmetic (`web/src/stores/
 * utils/contextUtils.ts`), which computes a percentage and is not a request
 * parameter. `maxOutputTokens` is NOT available input context: this is the room
 * held back, and the two must never be added together.
 */
export function resolveOutputReservation(modelOutputTokens: number | undefined): OutputReservation {
  if (typeof modelOutputTokens === "number" && Number.isFinite(modelOutputTokens) && modelOutputTokens > 0) {
    return { tokens: Math.min(Math.floor(modelOutputTokens), MAX_OUTPUT_RESERVATION), source: "model_reported" };
  }
  return { tokens: DEFAULT_OUTPUT_RESERVATION, source: "default" };
}

/** Human-readable provenance, for logs and diagnostics. Never the number alone. */
export function describeLimitSource(limit: ContextLimit): string {
  switch (limit.source) {
    case "model_reported":
      return "model_reported";
    case "configured":
      return "configured";
    case "default":
      // Says out loud that the number is a stand-in.
      return `default_conservative(${limit.maxInputTokens})`;
    case "unknown":
      return "unknown";
  }
}
