/**
 * Phase 3 — the two-request cache verification protocol.
 *
 * ## The only honest way to measure a cache hit
 *
 * A single request cannot demonstrate reuse, and neither can latency. Both
 * vendors document the trap explicitly: a request below the minimum succeeds and
 * simply caches nothing, and a faster response can come from a warm machine
 * rather than a cache hit. So the protocol requires two requests:
 *
 * ```text
 *   REQUEST 1  →  stable prefix P + suffix A   →  expect cache WRITE
 *   REQUEST 2  →  the SAME prefix P + suffix B →  expect cache READ
 * ```
 *
 * The suffix MUST differ, or the second request would be a byte-identical repeat
 * that proves nothing about which part was reused. The prefix MUST be identical,
 * or the read proves nothing.
 *
 * ## What this module does and does not claim
 *
 * It EVALUATES a pair of already-performed observations. It does not perform
 * requests, and it never infers a hit from latency or from success. Its verdicts
 * are deliberately narrow:
 *
 * - `write_observed` / `read_observed` — a provider-reported number, and only that.
 * - `cache_not_observed` — the normal below-threshold / not-cached outcome.
 *   NOT a failure.
 * - `inconclusive_unobservable` — the model exposes no cache usage field, so the
 *   run can say nothing in either direction.
 * - `prefix_mismatch` — the two requests did not share a prefix, so a missing
 *   read is uninterpretable rather than negative.
 */

import type { CacheCapability, CacheObservation, CacheObservationKind } from "./types";
import { comparePrefixIdentities, type PrefixComponents } from "./prefix";
import { computePrefixIdentity } from "./prefix";
import { isCacheObservable } from "./observe";
import { isDocumented } from "./types";

/** What a two-request pair establishes. Never "caching works" on its own. */
export const CACHE_VERDICTS = [
  "write_then_read_observed",
  "write_observed_read_not_observed",
  "cache_not_observed",
  "inconclusive_unobservable",
  "inconclusive_prefix_mismatch",
  "ineligible_unknown_capability",
  "ineligible_below_documented_minimum",
] as const;
export type CacheVerdict = (typeof CACHE_VERDICTS)[number];

/**
 * One leg of the experiment. `suffixId` labels the varying tail so a mismatch is
 * diagnosable; it is a label, not content.
 */
export interface CacheExperimentLeg {
  readonly suffixId: string;
  readonly prefix: PrefixComponents;
  readonly observation: CacheObservation;
}

export interface CacheExperimentResult {
  readonly verdict: CacheVerdict;
  /** Whether this run may support a claim about cache effectiveness. */
  readonly supportsConclusion: boolean;
  /** Why the verdict is what it is. Enumerated so logs stay greppable. */
  readonly reasons: readonly string[];
  /** DOCUMENTED values, carried through unchanged for comparison. */
  readonly documented: {
    readonly minimumPrefixTokens: number | null;
    readonly mode: string;
    readonly source: string;
    readonly verifiedOn: string;
  } | null;
  /** OBSERVED values, from the provider. Never merged with `documented`. */
  readonly observed: {
    readonly firstLeg: CacheObservationKind;
    readonly secondLeg: CacheObservationKind;
    readonly writeTokens: number | null;
    readonly readTokens: number | null;
  };
}

const wroteOrRead = (kind: CacheObservationKind): boolean =>
  kind === "write_observed" || kind === "read_observed" || kind === "write_and_read_observed";

/**
 * Whether this capability's breakpoint sits on the LAST cacheable block.
 *
 * True only for Anthropic-style automatic caching, where the provider moves the
 * breakpoint to the final block and relies on a bounded lookback to find earlier
 * writes. Such a mode can only reuse a prefix that the later request CONTAINS.
 */
function requiresAppendGrowthShape(capability: CacheCapability): boolean {
  return capability.status === "documented" && capability.providerType === "anthropic";
}

/**
 * Whether `second` contains `first` plus appended content.
 *
 * The later request's retained history must begin with everything the earlier
 * request sent — its retained history AND its current turn, which the earlier
 * request sent as a variable tail and the later one carries as settled history.
 * That promotion is exactly what makes the earlier prefix reusable.
 */
function secondExtendsFirst(first: PrefixComponents, second: PrefixComponents): boolean {
  const firstSent = [...first.retainedMessageIds, ...first.currentTurnIds];
  if (second.retainedMessageIds.length < firstSent.length) return false;
  return firstSent.every((id, index) => second.retainedMessageIds[index] === id);
}

/**
 * Evaluate a two-request cache experiment.
 *
 * @param capability Documented capability for the exact model, or `unknown`.
 * @param legs Exactly two legs: the write-attempt and the read-attempt.
 */
export function evaluateCacheExperiment(input: {
  capability: CacheCapability;
  legs: readonly [CacheExperimentLeg, CacheExperimentLeg];
  /**
   * Measured prefix size in tokens, from TBAi's own estimator. Used ONLY against
   * a DOCUMENTED minimum — never against TBAi's context ceiling. See the
   * eligibility check in {@link cacheExperimentEligibility}.
   */
  measuredPrefixTokens?: number | undefined;
}): CacheExperimentResult {
  const { capability, legs } = input;
  const [first, second] = legs;

  const documented = isDocumented(capability)
    ? {
        minimumPrefixTokens: capability.documentedMinimumPrefixTokens,
        mode: capability.cacheMode,
        source: capability.source,
        verifiedOn: capability.verifiedOn,
      }
    : null;

  const observed = {
    firstLeg: first.observation.kind,
    secondLeg: second.observation.kind,
    writeTokens: first.observation.writeTokens ?? null,
    readTokens: second.observation.readTokens ?? null,
  };

  const reasons: string[] = [];

  // 1. Unknown capability. The phase's rules forbid drawing a conclusion from a
  //    model whose caching behaviour was never documented.
  if (capability.status === "unknown") {
    return {
      verdict: "ineligible_unknown_capability",
      supportsConclusion: false,
      reasons: [capability.reason],
      documented: null,
      observed,
    };
  }

  // 2. A model with no cache usage field can never yield a conclusion. Reported
  //    as inconclusive, NOT as a negative result.
  if (!isCacheObservable(capability)) {
    return {
      verdict: "inconclusive_unobservable",
      supportsConclusion: false,
      reasons: ["capability_exposes_no_cache_usage_field"],
      documented,
      observed,
    };
  }

  // 3. Prefix compatibility, which is MODE-DEPENDENT.
  //
  //    This check was previously mode-blind and that was a real defect. Under
  //    Anthropic AUTOMATIC caching the breakpoint sits on the LAST cacheable
  //    block, so a prior write is only reusable when the later request CONTAINS
  //    the earlier one plus appended content. Two same-length requests that
  //    differ only in the final block cannot read each other's write — the
  //    breakpoint hash differs and the lookback finds nothing — even when
  //    caching is working perfectly. Judging that pair would manufacture a false
  //    negative.
  //
  //    Providers whose breakpoints land on an INTERVAL (OpenAI implicit, Gemini)
  //    behave differently: the same prefix with a different tail does read.
  //
  //    Verified against the real Anthropic request body: turn 1's `messages` are a
  //    byte-exact prefix of turn 2's, and no message id is serialised, so append
  //    growth is the shape caching can actually reuse.
  const firstIdentity = computePrefixIdentity(first.prefix);
  const secondIdentity = computePrefixIdentity(second.prefix, firstIdentity);
  const comparison = comparePrefixIdentities(firstIdentity, secondIdentity);
  const requiresAppendGrowth = requiresAppendGrowthShape(capability);

  // 3a. Layer B / Layer A churn invalidates the ENTIRE cache, in every mode and
  //     regardless of breakpoint position. Anthropic documents it explicitly:
  //     "Modifying tool definitions (names, descriptions, parameters)
  //     invalidates the entire cache." So this is checked FIRST and
  //     unconditionally — it is not part of the append-growth special case.
  const invalidating = secondIdentity.invalidationReasons.filter(
    (r) => r !== "history_appended",
  );
  if (invalidating.length > 0) {
    reasons.push("stable_prefix_changed_between_requests");
    return {
      verdict: "inconclusive_prefix_mismatch",
      supportsConclusion: false,
      reasons: [...reasons, ...invalidating],
      documented,
      observed,
    };
  }

  // 3b. Breakpoint-position compatibility.
  if (requiresAppendGrowth && !secondExtendsFirst(first.prefix, second.prefix)) {
    reasons.push(
      "automatic_cache_requires_append_growth: the later request must contain the earlier one plus appended content, because the automatic breakpoint sits on the last cacheable block",
    );
    return {
      verdict: "inconclusive_prefix_mismatch",
      supportsConclusion: false,
      reasons,
      documented,
      observed,
    };
  }

  if (!comparison.identical && !requiresAppendGrowth) {
    reasons.push("suffix_varied_but_prefix_also_changed");
    return {
      verdict: "inconclusive_prefix_mismatch",
      supportsConclusion: false,
      reasons: [...reasons, ...comparison.reasons],
      documented,
      observed,
    };
  }

  // 3c. The suffix must actually vary, or the second request is a byte-identical
  //     repeat that proves nothing about which part was reused.
  if (first.prefix.currentTurnIds.length === 0 || second.prefix.currentTurnIds.length === 0) {
    reasons.push("experiment_requires_a_varying_suffix");
  }
  if (first.suffixId === second.suffixId) {
    reasons.push("suffix_must_differ_between_requests");
  }

  // 4. Below the DOCUMENTED minimum, nothing was ever going to cache. Reported
  //    as `cache_not_observed` — a normal outcome, not a failure. Skipped when
  //    the vendor documents no fixed number (OpenAI pre-5.6).
  if (
    input.measuredPrefixTokens !== undefined &&
    capability.documentedMinimumPrefixTokens !== undefined &&
    input.measuredPrefixTokens < capability.documentedMinimumPrefixTokens
  ) {
    reasons.push(
      `measured_prefix_below_documented_minimum: ${input.measuredPrefixTokens} < ${capability.documentedMinimumPrefixTokens}`,
    );
  }

  const firstObserved = wroteOrRead(first.observation.kind);
  const secondObserved = wroteOrRead(second.observation.kind);

  if (firstObserved && secondObserved) {
    return {
      verdict: "write_then_read_observed",
      supportsConclusion: true,
      reasons,
      documented,
      observed,
    };
  }

  if (firstObserved) {
    reasons.push("second_request_reported_no_cache_read");
    return {
      verdict: "write_observed_read_not_observed",
      supportsConclusion: true,
      reasons,
      documented,
      observed,
    };
  }

  // Neither leg observed caching. This is the silent case Phase 3 rule 14 exists
  // for: the requests may well have succeeded. That is not evidence of a hit,
  // and it is not evidence caching is broken either.
  reasons.push("no_cache_activity_reported_by_provider");
  return {
    verdict: "cache_not_observed",
    // FALSE deliberately. This is the outcome that must never be read as
    // "caching does not work here".
    supportsConclusion: false,
    reasons,
    documented,
    observed,
  };
}

/**
 * Where the number used to size or select a cache prefix comes from.
 *
 * Four sources, and only two are trustworthy for sizing an experiment. The
 * distinction the phase rules insist on is between the **cache threshold** (a
 * vendor-documented minimum for a model) and the **context-window ceiling** (how
 * large the window is). They are separate facts, neither supplies the other, and
 * one must never be substituted for the other.
 *
 * The gate therefore asks WHERE THE NUMBER CAME FROM rather than what the context
 * limit's provenance is. Requiring a `provider_reported` context ceiling would
 * wrongly forbid an experiment sizing against the vendor's own documented cache
 * minimum — an equally trustworthy number, and one that exists even when TBAi
 * knows nothing at all about the window.
 */
export const CACHE_SIZING_BASES = [
  /** The vendor's documented cache minimum for this exact model. Trustworthy. */
  "documented_cache_minimum",
  /** TBAi's own measurement of the prefix actually sent. Trustworthy. */
  "measured_prefix",
  /** The model's context-window ceiling. NEVER a valid sizing basis. */
  "context_ceiling",
  /** TBAi's stand-in ceiling or an estimate. NEVER a valid sizing basis. */
  "default_or_estimated",
] as const;
export type CacheSizingBasis = (typeof CACHE_SIZING_BASES)[number];

export interface CacheSizingBasisInput {
  readonly capability: CacheCapability;
  /** Where the number used to size/select the prefix comes from. */
  readonly sizingBasis: CacheSizingBasis;
  /**
   * TBAi's context-limit provenance for this model.
   *
   * RECORDED for the log line only. It no longer gates eligibility, because the
   * forbidden thing is sizing from the CEILING — not holding an untrustworthy
   * ceiling. Sizing from `context_ceiling` is refused regardless of provenance.
   */
  readonly contextLimitSource?: string | undefined;
}

/**
 * Whether an experiment may produce a SIZING claim.
 *
 * Two independent gates, both required:
 *
 * 1. A DOCUMENTED, observable minimum must exist for this exact model. Without a
 *    vendor number there is nothing trustworthy to size against.
 * 2. The sizing number must come from a trustworthy SOURCE — the vendor's
 *    documented cache minimum, or TBAi's own measurement of the prefix it sent.
 *    A context ceiling is never a valid basis, whatever its provenance.
 *
 * @returns Whether a sizing claim is permitted, and why not if it is not.
 */
export function cacheExperimentEligibility(
  input: CacheSizingBasisInput,
): { eligible: boolean; reasons: readonly string[] } {
  const { capability, sizingBasis } = input;
  const reasons: string[] = [];

  if (capability.status === "unknown") {
    reasons.push("capability_unknown: no documented minimum to size against");
  } else if (!isCacheObservable(capability)) {
    reasons.push("capability_unobservable: a result could not be measured");
  } else if (capability.documentedMinimumPrefixTokens === undefined) {
    // A vendor that documents "varies by request settings" gives us no number.
    // Sizing a prefix against a number we invented would be exactly the failure
    // this gate exists to prevent.
    reasons.push("no_documented_minimum: vendor states the minimum varies by request settings");
  }

  // The binding rule, stated over the SOURCE rather than the ceiling's
  // provenance. A context-window size is not a cache threshold even when it is a
  // real number, so it is refused outright; TBAi's stand-in is refused twice
  // over. This is STRICTER than requiring a `provider_reported` ceiling, and it
  // no longer forbids sizing against the vendor's own documented minimum.
  if (sizingBasis === "context_ceiling") {
    reasons.push(
      "sizing_basis_context_ceiling: a context-window ceiling is not a cache threshold; use documented_cache_minimum or measured_prefix",
    );
  }
  if (sizingBasis === "default_or_estimated") {
    reasons.push(
      "sizing_basis_default_or_estimated: a conservative default or estimate describes no model and must not size a cache experiment",
    );
  }

  return { eligible: reasons.length === 0, reasons };
}