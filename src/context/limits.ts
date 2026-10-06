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
import type {
  ContextLimit,
  GenerationCap,
  LimitCandidateField,
  LimitCandidateRecord,
  LimitCandidateRejection,
  LimitSource,
  OutputReservation,
} from "./types";

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

/**
 * A usable, positive token count, or undefined. Rejects NaN/Infinity/zero/negatives.
 *
 * ⚠️ FLOORS a fractional value. Retained ONLY for the OUTPUT ceiling paths
 * (`resolveOutputReservation`, `resolveGenerationCap`), which read
 * `ModelOption.maxOutputTokens` and are out of scope for the fractional
 * rejection below.
 *
 * For CONTEXT-LIMIT candidates use `checkLimitCandidate` instead. The two
 * behaviours differ on purpose: a context limit is a token COUNT and must be
 * rejected rather than quietly rewritten, because flooring it and then
 * trusting the result reports a figure no source ever stated. That asymmetry
 * is a known, documented boundary — `maxOutputTokensSource` is likewise
 * unexamined by `resolveOutputReservation` — and reconciling it is a separate
 * decision, not one taken silently here.
 */
function validTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * Classifies a supplied context-limit candidate WITHOUT altering it.
 *
 * Returns the value unchanged on success. Rejection is reported as an explicit
 * reason so a discarded candidate can be shown to the reader rather than
 * vanishing — which is the whole defect this replaces, where `Math.floor`
 * turned `1000.9` into an authoritative `1000`.
 */
function checkLimitCandidate(value: unknown): {
  readonly ok: boolean;
  readonly value: number | null;
  readonly rejectionReason: LimitCandidateRejection | null;
} {
  if (typeof value !== "number") {
    return { ok: false, value: null, rejectionReason: "not_a_number" };
  }
  if (!Number.isFinite(value)) {
    return { ok: false, value: null, rejectionReason: "non_finite" };
  }
  if (value <= 0) {
    return { ok: false, value: null, rejectionReason: "non_positive" };
  }
  if (!Number.isInteger(value)) {
    // Deliberately NOT floored. A context limit counts tokens; 1000.9 is not a
    // token count, and rounding it would let a malformed figure become
    // authoritative under a provenance label implying a source stated it.
    return { ok: false, value: null, rejectionReason: "non_integer" };
  }
  return { ok: true, value, rejectionReason: null };
}

/** A limit candidate together with the stance of whoever asserted it. */
interface LimitCandidate {
  readonly value: number;
  readonly source: ContextWindowSource;
  /** Index into the diagnostic record array, so selection can mark it later. */
  readonly recordIndex: number;
}

/**
 * One candidate as SUPPLIED, before validation — the shape a reader needs in
 * order to be told the value that was rejected, not the value that survived.
 */
interface SuppliedCandidate {
  readonly field: LimitCandidateField;
  readonly source: ContextWindowSource | "observed";
  readonly raw: unknown;
}

/**
 * Every input the resolver could consider, in the order it considers them.
 *
 * `observedContextWindow` is included for DIAGNOSTIC reporting only. It is
 * deliberately excluded from the participating candidates below: an observed
 * figure read out of an error string has no business arbitrating between two
 * declared figures, and the precedence that does consult it lives in
 * `resolveContextLimit` on the single path where nothing else produced a value.
 */
function collectCandidates(input: {
  model?: Pick<ModelOption, "contextWindow" | "contextWindowSource"> | undefined;
  configuredContextWindow?: number | undefined;
  observedContextWindow?: number | undefined;
}): {
  readonly candidates: LimitCandidate[];
  readonly records: LimitCandidateRecord[];
} {
  const supplied: SuppliedCandidate[] = [
    {
      field: "model.contextWindow",
      // A value with no recorded stance is a legacy row; see LEGACY_SOURCE.
      source: input.model?.contextWindowSource ?? LEGACY_SOURCE,
      raw: input.model?.contextWindow,
    },
    { field: "configuredContextWindow", source: "configured", raw: input.configuredContextWindow },
    { field: "observedContextWindow", source: "observed", raw: input.observedContextWindow },
  ];

  const candidates: LimitCandidate[] = [];
  const records: LimitCandidateRecord[] = [];

  supplied.forEach((entry, index) => {
    const present = entry.raw !== undefined && entry.raw !== null;
    const check = present
      ? checkLimitCandidate(entry.raw)
      : { ok: false, value: null, rejectionReason: "not_a_number" as const };

    records.push({
      field: entry.field,
      source: entry.source,
      present,
      valid: present && check.ok,
      suppliedValue: present ? (entry.raw as number | string) : null,
      value: present && check.ok ? check.value : null,
      rejectionReason: present ? check.rejectionReason : null,
      selected: false,
      outcome: present && !check.ok ? "rejected" : "not_compared",
    });

    if (entry.field === "observedContextWindow") return;
    if (!present || !check.ok) return;

    // The stored figure is `candidates[0]` and the configured figure follows it
    // even when their VALUES ARE EQUAL. Suppressing an equal pair used to make
    // the documented "two agreeing candidates" rule unreachable — the guard
    // below (`configured !== stored`) meant two candidates could only ever
    // disagree, so the agreement branch could never execute. Agreement is a real
    // state: a provider listing and an operator figure that coincide are two
    // independent statements of the same fact, and the contract reports the
    // stronger authority for them. Both paths still select the same number.
    candidates.push({
      value: check.value as number,
      source: entry.source as ContextWindowSource,
      recordIndex: index,
    });
  });

  return { candidates, records };
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
 *  3. two candidates, conflicting      -> `configured` WINS, and the losing
 *                                        `provider_reported` figure is recorded
 *                                        on `divergentValue`
 *  4. no candidates                    -> a remembered `observed` figure if one
 *                                        validates, else `UNKNOWN_LIMIT_CEILING`
 *                                        as `conservative_default`
 *
 * Rule 2 was documented but UNREACHABLE until this revision: `collectCandidates`
 * used to skip the configured figure whenever it equalled the stored one, so two
 * candidates could only ever disagree and the agreement branch could not run. The
 * candidate set is no longer filtered that way, so agreement is now a real state
 * rather than an implied one. Both routes select the same number, so no consumer
 * of `maxInputTokens` can observe the difference — only the diagnostic record can.
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
  /** A figure the provider stated in an overflow rejection, when one is remembered. */
  observedContextWindow?: number | undefined;
  /**
   * Identity of the endpoint this resolution is FOR, recorded on the result.
   *
   * Carried through so a figure can be traced to the provider/endpoint/protocol it
   * was resolved for. The same model id on two endpoints is two facts, and the
   * lookup is already endpoint-scoped structurally — `selectModelOption` reads the
   * selected provider's OWN model list — so this is the audit trail for that
   * guarantee rather than the mechanism enforcing it.
   */
  providerId?: string;
  endpoint?: string;
  protocol?: string;
}): ContextLimit {
  const { providerType, modelId } = input;
  const { candidates, records } = collectCandidates(input);

  /**
   * Marks the diagnostic record for a candidate and returns the limit unchanged.
   *
   * This is the ONLY place diagnostics touch the result, and it writes to
   * `records` exclusively — never to `candidates`. Selection below reads
   * `candidates` alone, so no record can influence a winner by construction
   * rather than by convention.
   */
  const withDiagnostics = (
    limit: ContextLimit,
    annotations: ReadonlyMap<number, { selected: boolean; outcome: LimitCandidateRecord["outcome"] }>,
  ): ContextLimit => {
    // ALWAYS attached, including on the fallback path. That path is precisely
    // where the records matter most: it is the only route by which a reader
    // learns that a real figure existed and was thrown away.
    const merged = records.map((record, index) => {
      const annotation = annotations.get(index);
      return annotation === undefined
        ? record
        : { ...record, selected: annotation.selected, outcome: annotation.outcome };
    });
    return { ...limit, candidates: merged };
  };

  const base = {
    providerType,
    modelId,
    divergent: false,
    ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
    ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
    ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
  } as const;

  // ## Where an observed figure sits in the hierarchy
  //
  // BELOW both stored sources and ABOVE the stand-in, and only when neither stored
  // source produced anything at all. Consulting it here rather than inside
  // `collectCandidates` is deliberate: that function's two-candidate conflict rule
  // (configured beats a provider listing, divergence recorded) is load-bearing, and an
  // observed value has no business arbitrating between two declared figures. So the
  // existing resolution runs completely untouched, and the observation is consulted
  // only on the one path that currently has nothing.
  if (candidates.length === 0) {
    // `observedContextWindow` is validated with the SAME classifier as every
    // other candidate, so a fractional observed figure is rejected for the same
    // reason a fractional stored one is rather than silently floored.
    const observedCheck = checkLimitCandidate(input.observedContextWindow);
    const observedIndex = records.findIndex((record) => record.field === "observedContextWindow");

    if (observedCheck.ok) {
      const annotations = new Map<number, { selected: boolean; outcome: LimitCandidateRecord["outcome"] }>();
      if (observedIndex >= 0) annotations.set(observedIndex, { selected: true, outcome: "not_compared" });
      return withDiagnostics({ ...base, maxInputTokens: observedCheck.value, source: "observed" }, annotations);
    }

    // No real figure. Report the conservative ceiling as a stood-in-for value,
    // never as a reported limit, so diagnostics can show it is a stand-in.
    return withDiagnostics(
      { ...base, maxInputTokens: UNKNOWN_LIMIT_CEILING, source: "conservative_default" },
      new Map(),
    );
  }

  const first = candidates[0] as LimitCandidate;

  if (candidates.length === 1) {
    return withDiagnostics(
      { ...base, maxInputTokens: first.value, source: first.source },
      new Map([[first.recordIndex, { selected: true, outcome: "not_compared" }]]),
    );
  }

  const second = candidates[1] as LimitCandidate;

  if (first.value === second.value) {
    // Agreement. Report the stronger authority; nothing is being overridden.
    return withDiagnostics(
      { ...base, maxInputTokens: first.value, source: "provider_reported" },
      new Map([
        [first.recordIndex, { selected: true, outcome: "agreed" }],
        [second.recordIndex, { selected: true, outcome: "agreed" }],
      ]),
    );
  }

  // Conflict. Configured wins (rule 3); the provider figure is preserved for
  // diagnostics so the disagreement is observable rather than lost.
  return withDiagnostics(
    {
      ...base,
      maxInputTokens: second.value,
      source: "configured",
      divergent: true,
      divergentValue: { value: first.value, source: first.source },
    },
    new Map([
      [first.recordIndex, { selected: false, outcome: "lost_precedence" }],
      [second.recordIndex, { selected: true, outcome: "conflicted" }],
    ]),
  );
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

/**
 * Flattens the resolver's candidate record into flat, loggable diagnostics.
 *
 * Two shapes, because a log line cannot usefully carry an array of records and
 * the fields a reader needs are counted, not searched:
 *
 *  - `limitCandidateCount` / `limitRejectedCount` — how many were considered and
 *    how many were thrown away. `limitRejectedCount > 0` on a successful
 *    resolution is the signal that a supplied figure did not become the winner.
 *  - `limitCandidateSummary` — one compact string per candidate, including the
 *    ones that lost, so "why wasn't this value used" is answerable from a log.
 *
 * Emits numbers and short enum tokens only. A supplied value is included
 * verbatim, unrounded, because that IS the diagnosis; it is a caller's own
 * metadata and never contains prompt content. Keys avoid the substring "token"
 * so the logger's redaction (`SENSITIVE_KEY_RE`) does not erase them.
 */
export function describeLimitCandidates(limit: ContextLimit): Record<string, string | number> {
  const records = limit.candidates ?? [];
  const rejected = records.filter((record) => record.present && !record.valid);

  const summary = records.map((record) => {
    if (!record.present) return `${record.field}=absent`;
    if (!record.valid) {
      return `${record.field}=invalid:${String(record.rejectionReason)}:${String(record.suppliedValue)}`;
    }
    const role = record.selected ? "selected" : record.outcome;
    return `${record.field}=valid:${String(record.value)}:${record.source}:${role}`;
  });

  return {
    limitCandidateCount: records.length,
    limitRejectedCount: rejected.length,
    limitCandidateSummary: summary.join(" "),
  };
}

/** Human-readable provenance, for logs and diagnostics. Never the number alone. */
export function describeLimitSource(limit: ContextLimit): string {
  switch (limit.source) {
    case "provider_reported":
      return "provider_reported";
    case "configured":
      return "configured";
    case "observed":
      // Says where it came from: stated by the provider, but read from a rejection
      // rather than declared in a listing.
      return "observed";
    case "conservative_default":
      // Says out loud that the number is a stand-in.
      return `conservative_default(${limit.maxInputTokens})`;
    case "unknown":
      return "unknown";
  }
}