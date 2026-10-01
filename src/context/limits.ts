/**
 * Model context-window resolution.
 *
 * This module is CAPABILITY LOOKUP ONLY. It answers "what limit was reported,
 * and where did it come from" and nothing else. Enforcement policy lives in
 * `budget.ts`, deliberately: a lookup that also decided policy could not be
 * reused by a different policy without lying about the model's capability.
 *
 * ── R1 (2026-10-01): provenance ───────────────────────────────────────────────
 *
 * Before R1, `ModelOption.contextWindow` was written by two unrelated code paths
 * — provider discovery (`modelDiscovery.ts`, Anthropic only) and the provider
 * dialog (a human typing) — into the SAME field. Provenance was therefore lost
 * at write time and unrecoverable afterwards, which made the pre-R1
 * `model_reported` branch untruthful the moment it was wired: a number a user
 * invented would have been reported as the provider's own figure.
 *
 * The fix is one additive field (`ModelOption.contextWindowSource`) plus two
 * writer helpers in `src/types/index.ts` (`providerReportedLimit` /
 * `configuredLimit`) that make it impossible for a user-entered value to be
 * labelled `provider_reported`. This module resolves the pair into a
 * `ContextLimit` that always carries the stance alongside the number.
 *
 * Phase 1 established (F14) that discovery populates a context window for
 * ANTHROPIC ONLY (`max_input_tokens`); OpenAI, Google, Ollama and custom
 * listings expose no per-model limit, so their models carry no `contextWindow`.
 * The frontend separately falls back to a 128_000 DISPLAY default
 * (`web/src/config/modelContext.ts:21`), which is deliberately not imported here.
 */

import type { ContextWindowSource, ModelOption } from "../types";
import type { ContextLimit, GenerationCap, LimitSource, OutputReservation } from "./types";

/**
 * Ceiling used when no real limit is known.
 *
 * NOT a claim about any model, NOT a safety calibration, and NOT configurable.
 * It is an assumption about typical windows: an unknown limit degrades to
 * "bounded and conservatively assumed" rather than "unbounded", and it is
 * reported with `source: "conservative_default"` so no caller can mistake it for
 * a stated figure.
 *
 * ⚠️ It is an ASSUMPTION, and it can be wrong in the direction that costs
 * capability: a model documenting a larger window will have its usable input
 * rejected by TBAi before the provider is ever called. R1 verified this against
 * the configured vendor (documented 512K vs this 128k), i.e. roughly three
 * quarters of the real usable window was being refused. Raising it is a product
 * decision about how long a conversation may grow, recorded in
 * `docs/r1-context-limit-decision.md` §6 and left UNCHANGED here.
 */
export const UNKNOWN_LIMIT_CEILING = 128_000;

/**
 * Output reservation when no output limit is available anywhere.
 *
 * A generation needs room to finish. Phase 1 established Direct reserved nothing
 * (F5), which let a request occupy the whole window. 4,096 is a deliberately
 * modest floor: enough for a short tool-calling turn, small enough that it does
 * not meaningfully shrink usable input. This is an INPUT-BUDGET reserve and is
 * not the model's output capability — see `GenerationCap`.
 */
export const DEFAULT_OUTPUT_RESERVATION = 4_096;

/**
 * Generation cap when no output limit is available anywhere.
 *
 * Deliberately equal to `DEFAULT_OUTPUT_RESERVATION` so that the pre-R1
 * behaviour is preserved EXACTLY for every path that exists today (no provider
 * currently populates `ModelOption.maxOutputTokens`): generation was capped at
 * the reservation, and it still is. The two are separate quantities that happen
 * to share a default; when a provider does report an output ceiling, only the
 * cap follows it. Raising this default is a product decision and is not made
 * here — the vendor figure that motivated the separation is recorded in
 * `docs/r1-context-limit-decision.md` §4 but is NOT hardcoded into generic
 * context logic.
 */
export const DEFAULT_GENERATION_CAP = 4_096;

/** Clamp for a model-reported output ceiling, so a bad figure cannot invert the budget. */
const MAX_OUTPUT_RESERVATION = 32_000;

/**
 * Provenance assumed for a stored `contextWindow` that predates R1.
 *
 * Such a row carries a bare number and no stance. It is resolved as
 * `configured`, never `provider_reported`.
 *
 * Direction matters: mislabelling a legacy row as provider-reported would let a
 * number nobody verified authorise Phase 3 cache sizing, which is exactly the
 * over-claim R1 exists to prevent. Mislabelling provider-discovered data as
 * configured only UNDERSTATES its authority — enforcement still uses the number,
 * and `isPhase3ExperimentEligible` correctly denies it. Choosing the label that
 * fails closed is deliberate.
 */
export const LEGACY_SOURCE: ContextWindowSource = "configured";

/**
 * Select the `ModelOption` for a model id from a provider's model list.
 *
 * Provider-agnostic by construction: it matches on id only and contains no
 * model-name or provider-name knowledge, so it cannot grow into a per-model
 * table. Returns undefined when the provider has no matching entry — which is
 * the normal case for OpenAI/Google/Ollama/custom providers, whose listings
 * carry no context metadata at all.
 */
export function selectModelOption(
  models: readonly ModelOption[] | undefined,
  modelId: string,
): ModelOption | undefined {
  return models?.find((m) => m.id === modelId);
}

/** A usable, positive token count, or undefined. Rejects NaN/Infinity/zero/negatives. */
function validTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** A limit candidate together with the stance of whoever asserted it. */
interface LimitCandidate {
  readonly value: number;
  readonly source: ContextWindowSource;
}

/**
 * Candidates for the effective input limit, in the order they are considered.
 *
 * `model` contributes at most one candidate, using the stance recorded beside
 * its value. `configuredContextWindow` (an explicitly-passed operator figure,
 * distinct from the stored row) contributes a second.
 */
function collectCandidates(input: {
  model?: Pick<ModelOption, "contextWindow" | "contextWindowSource"> | undefined;
  configuredContextWindow?: number | undefined;
}): LimitCandidate[] {
  const candidates: LimitCandidate[] = [];

  const stored = validTokenCount(input.model?.contextWindow);
  if (stored !== undefined) {
    candidates.push({
      value: stored,
      // A value with no recorded stance is a legacy row; see LEGACY_SOURCE.
      source: input.model?.contextWindowSource ?? LEGACY_SOURCE,
    });
  }

  const configured = validTokenCount(input.configuredContextWindow);
  if (configured !== undefined && configured !== stored) {
    candidates.push({ value: configured, source: "configured" });
  }

  return candidates;
}

/**
 * Resolve the input limit for a (provider, model) pair.
 *
 * Returns provenance alongside the number. A caller that wants a number and
 * ignores `source` is misusing this function - that is the whole reason `source`
 * is a required field rather than a comment.
 *
 * RESOLUTION ORDER (R1 decision A2, `docs/r1-context-limit-decision.md` §11):
 *
 *  1. exactly one candidate            -> that candidate, with its own stance
 *  2. two candidates, equal values     -> the value, stance `provider_reported`
 *                                        (no disagreement to resolve, so the
 *                                        stronger authority is reported)
 *  3. two candidates, conflicting       -> `configured` WINS, and the losing
 *                                        `provider_reported` figure is recorded
 *                                        on `divergentValue`
 *  4. no candidates                    -> `UNKNOWN_LIMIT_CEILING` as
 *                                        `conservative_default`
 *
 * Why `configured` wins a conflict (rule 3) — the decision record must state it,
 * because it is not the obvious order:
 *
 * - A provider's published window is MODEL-WIDE; this vendor's own documentation
 *   says limits "follow the entitlement shown for your account and API key". An
 *   operator who typed a number may be describing a per-account reality that no
 *   documentation can know. The operator is closer to the truth than the
 *   listing is.
 * - Overriding an explicit human setting silently is worse than honouring it.
 * - It is deterministic and never changes a setting behind the operator's back.
 * - It cannot authorise a Phase 3 cache experiment, because `configured` is not
 *   `provider_reported` (see `isPhase3ExperimentEligible`).
 *
 * The inverse — "provider-reported automatically wins" — was rejected because it
 * would let a stale or model-wide listing override a deliberate operator choice,
 * which is a capability regression with no safety benefit.
 *
 * ⚠️ In practice a conflict is RARE: discovery REPLACES a provider's whole
 * `models` array on save, so a configured value is overwritten rather than
 * contested. That behaviour is unspecified upstream and is a recorded residual
 * risk, not a policy this function implements.
 */
export function resolveContextLimit(input: {
  providerType: ContextLimit["providerType"];
  modelId: string;
  /** Model metadata for the selected model, when the caller has it. */
  model?: Pick<ModelOption, "contextWindow" | "contextWindowSource">;
  /** An operator-supplied limit, distinct from the value stored on `model`. */
  configuredContextWindow?: number | undefined;
}): ContextLimit {
  const { providerType, modelId } = input;
  const candidates = collectCandidates(input);

  const base = { providerType, modelId, divergent: false } as const;

  if (candidates.length === 0) {
    // No real figure. Report the conservative ceiling as a stood-in-for value,
    // never as a reported limit, so diagnostics can show it is a stand-in.
    return { ...base, maxInputTokens: UNKNOWN_LIMIT_CEILING, source: "conservative_default" };
  }

  const first = candidates[0] as LimitCandidate;

  if (candidates.length === 1) {
    return { ...base, maxInputTokens: first.value, source: first.source };
  }

  const second = candidates[1] as LimitCandidate;

  if (first.value === second.value) {
    // Agreement. Report the stronger authority; nothing is being overridden.
    return { ...base, maxInputTokens: first.value, source: "provider_reported" };
  }

  // Conflict. Configured wins (rule 3); the provider figure is preserved for
  // diagnostics so the disagreement is observable rather than lost.
  return {
    ...base,
    maxInputTokens: second.value,
    source: "configured",
    divergent: true,
    divergentValue: { value: first.value, source: first.source },
  };
}

/**
 * Whether a limit may be used as the basis for a Phase 3 cache experiment.
 *
 * BINDING RULE (R1, roadmap §3.0): a `conservative_default` or `unknown` ceiling
 * may be used for SAFETY enforcement, but must never be used to size a cache
 * prefix, choose a provider cache breakpoint, segment an experiment, or
 * conclude anything about cache effectiveness.
 *
 * The rule is enforced here as a function rather than left to prose, because the
 * failure it prevents is silent: an experiment measured against a fictional
 * ceiling produces a confidently wrong conclusion about whether caching helps.
 *
 * Only `provider_reported` qualifies. A `configured` figure is this
 * installation's belief about the model, not a statement by the model — which is
 * the same distinction §3.6 of the roadmap draws for cache thresholds.
 */
export function isPhase3ExperimentEligible(limit: ContextLimit): boolean {
  return limit.source === "provider_reported" && limit.maxInputTokens !== undefined;
}

/**
 * Resolve the output reservation — the INPUT BUDGET held back so a generation
 * has room to finish.
 *
 * Independent of any display-side context-ring arithmetic (`web/src/stores/
 * utils/contextUtils.ts`), which computes a percentage and is not a request
 * parameter. This value is NOT available input context: it is the room held back,
 * and the two must never be added together.
 *
 * This is NOT the generation cap. See `resolveGenerationCap`.
 */
export function resolveOutputReservation(modelOutputTokens: number | undefined): OutputReservation {
  const reported = validTokenCount(modelOutputTokens);
  if (reported !== undefined) {
    return { tokens: Math.min(reported, MAX_OUTPUT_RESERVATION), source: "provider_reported" };
  }
  return { tokens: DEFAULT_OUTPUT_RESERVATION, source: "conservative_default" };
}

/**
 * Resolve the MODEL GENERATION CAP — the ceiling on the model's own output.
 *
 * Distinct from the input-budget reservation (R1 decision P3). The formula is
 * deliberately explicit rather than reusing the reservation, because the two
 * answer different questions:
 *
 * ```text
 *   generationCap = min( model's documented output ceiling, ceiling - usableInput )
 *                  (falling back to DEFAULT_GENERATION_CAP when nothing is known)
 * ```
 *
 * The second term is what preserves the invariant that made the pre-R1 sharing
 * of one value coherent: `input + output <= ceiling`. Without it, a model
 * documenting a 65,536-token output on a 10,000-token window would be handed a
 * generation cap larger than the entire context — sending TBAi straight into a
 * provider rejection it had pre-flighted against.
 *
 * When the limit is not enforceable there is no window left to clamp against, so
 * the model's own figure (or the default) is used as-is.
 */
export function resolveGenerationCap(input: {
  /** Model's documented output ceiling, when a source stated one. */
  modelOutputTokens: number | undefined;
  /** Effective input ceiling, or undefined when the limit is unknown. */
  ceilingTokens: number | undefined;
  /** Usable input after reserve and margin; undefined when unenforceable. */
  usableInputTokens: number | undefined;
}): GenerationCap {
  const documented = validTokenCount(input.modelOutputTokens);
  const desired = documented ?? DEFAULT_GENERATION_CAP;
  const source: GenerationCap["source"] = documented !== undefined ? "provider_reported" : "conservative_default";

  if (input.ceilingTokens === undefined || input.usableInputTokens === undefined) {
    return { tokens: desired, source, boundedByRemainingWindow: false };
  }

  // Room the window can still give the model after input has been sized.
  const remaining = Math.floor(input.ceilingTokens - input.usableInputTokens);
  if (remaining <= 0) return { tokens: DEFAULT_GENERATION_CAP, source: "conservative_default", boundedByRemainingWindow: true };

  return {
    tokens: Math.min(desired, remaining),
    source: documented !== undefined && desired <= remaining ? "provider_reported" : "conservative_default",
    boundedByRemainingWindow: documented !== undefined && desired > remaining,
  };
}

/** Human-readable provenance, for logs and diagnostics. Never the number alone. */
export function describeLimitSource(limit: ContextLimit): string {
  switch (limit.source) {
    case "provider_reported":
      return "provider_reported";
    case "configured":
      return "configured";
    case "conservative_default":
      // Says out loud that the number is a stand-in.
      return `conservative_default(${limit.maxInputTokens})`;
    case "unknown":
      return "unknown";
  }
}