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

  // 3. Prefix mismatch invalidates the comparison: without an identical prefix a
  //    missing read is uninterpretable rather than negative.
  const firstIdentity = computePrefixIdentity(first.prefix);
  const secondIdentity = computePrefixIdentity(second.prefix, firstIdentity);
  const comparison = comparePrefixIdentities(firstIdentity, secondIdentity);
  if (!comparison.identical) {
    reasons.push("suffix_varied_but_prefix_also_changed");
    return {
      verdict: "inconclusive_prefix_mismatch",
      supportsConclusion: false,
      reasons: [...reasons, ...comparison.reasons],
      documented,
      observed,
    };
  }
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
 * Whether an experiment may produce a SIZING claim.
 *
 * Two independent gates, both required:
 *
 * 1. A DOCUMENTED minimum must exist for this exact model. Without one there is
 *    no number to size against.
 * 2. TBAi's CONTEXT CEILING must never be used as the sizing input. A
 *    `conservative_default` or `unknown` limit describes no model, so a prefix
 *    sized from it is meaningless — this is the Phase 3 binding rule from the
 *    roadmap §3.0.1, enforced here at the point where a decision would otherwise
 *    be taken.
 *
 * @returns Whether a sizing claim is permitted, and why not if it is not.
 */
export function cacheExperimentEligibility(input: {
  capability: CacheCapability;
  /** Whether TBAi's context limit for this model is provider-reported. */
  contextLimitSource: string;
}): { eligible: boolean; reasons: readonly string[] } {
  const { capability, contextLimitSource } = input;
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

  // The binding rule: a stood-in-for context ceiling may bound safety, never a
  // cache experiment. Sizing from it would produce a confidently wrong answer.
  if (contextLimitSource !== "provider_reported") {
    reasons.push(
      `context_limit_source_${contextLimitSource}: a conservative or configured limit may bound safety but must not size a cache experiment`,
    );
  }

  return { eligible: reasons.length === 0, reasons };
}