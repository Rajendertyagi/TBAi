/**
 * Tier 2 — the universal assembly safety ceiling.
 *
 * ## Why this exists
 *
 * P-1 makes context-limit preflight ADVISORY for a model whose limit is unknown
 * (`conservative_default` / `unknown`). That is correct: a fabricated ceiling must
 * not terminally reject a request the provider would have served. But it removes the
 * only bound those requests had.
 *
 * The Agnes failure is the proof that both halves are needed. With a terminal 128K
 * ceiling, a ~101K request against a real 512K window was rejected locally, the
 * provider was never contacted, and no limit could ever be learned — the loop
 * repeated every turn. With no ceiling at all, `decideBudget` returns `accept`
 * unconditionally (`budget.ts`), so a pathological history would assemble without
 * bound.
 *
 * Tier 2 is the bound that survives removing the other one.
 *
 * ## What it measures
 *
 * The estimated INPUT token count of the fully assembled request, taken from
 * `assemble.ts`'s existing post-compaction estimate and read at `range.high` — the
 * pessimistic end, matching `decideBudget`'s own rule. There is deliberately no second
 * token estimator here.
 *
 * It is NOT a byte guard. Attachments are byte-heavy and token-light, so a
 * token-measured ceiling bounds the token dimension only. See "Residual risk".
 *
 * ## Why `TIER_2_MAX_TOKENS` is a policy value and not a derived constant
 *
 * It is a product/engineering decision, recorded as such. Two evidence anchors
 * informed it and are stated so a future reader can audit or revise it:
 *
 * - **Lower anchor.** 2,097,152 tokens is the largest context window that survives a
 *   reliability filter over the models.dev corpus (text-output models below the
 *   sentinel band). The sentinel values above it — 5,000,000 / 10,000,000 /
 *   20,000,000 / 99,999,999 — are artifacts, including a video model carrying
 *   `context: 99999999`, and one model recorded at 10,000,000 by one provider and
 *   1,310,720 by another. A catalog maximum cannot be trusted as a bound.
 * - **Upper anchor.** Anthropic documents a 32 MB maximum request size for the
 *   Messages API. 2^22 tokens sits below the point where a serialised request would
 *   exceed that, so the guard stays reachable rather than decorative.
 *
 * It is NOT a mathematically unique transport-derived value, and it is not a claim
 * that any model has a 4M window. It is the ceiling on what TBAi will assemble,
 * chosen to sit above every window TBAi must serve.
 *
 * ## The asymmetry that sets the direction
 *
 * Overshooting this ceiling costs one provider round trip, after which `observed`
 * corrects the estimate. Undershooting it costs a hard user-facing rejection of a
 * request the provider would have served — which is the exact defect this
 * architecture exists to remove. **The value is therefore biased high on purpose.**
 *
 * ## Properties this module guarantees
 *
 * - Finite, unconditional, and independent of model metadata.
 * - Applied to known AND unknown models alike: no `configured`, `provider_reported`,
 *   `catalog` or `observed` value can raise or skip it.
 * - Evaluated after reduction/compaction and before transport.
 * - Never triggers compaction itself, and never re-enters assembly.
 *
 * ## Residual risk (recorded, not addressed here)
 *
 * A request can be small in estimated tokens and large in serialized bytes via
 * base64 attachments. This guard bounds the token dimension only. A separate byte
 * guard is a deliberate follow-up; adding one in this change would alter the
 * approved scope.
 */

import type { InputSizeEstimate } from "./types";

/**
 * The universal assembly ceiling, in estimated input tokens.
 *
 * POLICY VALUE (2^22). See the module header for the two evidence anchors and for
 * why it is not presented as a derived transport constant.
 */
export const TIER_2_MAX_TOKENS = 4_194_304;

/**
 * Why a Tier 2 verdict is distinguishable from every other Direct failure.
 *
 * A model-context overflow is a SIZE problem against a known or planning ceiling
 * that recovery can act on. A Tier 2 breach means the request was never viable for
 * any model, so it must not enter overflow recovery or re-enter assembly.
 */
export const ASSEMBLY_LIMIT_CODE = "ASSEMBLY_LIMIT_EXCEEDED" as const;

/** A Tier 2 breach. Terminal by construction; never recoverable. */
export interface Tier2Breach {
  readonly outcome: "assembly_limit_exceeded";
  /** Pessimistic (`range.high`) estimate that crossed the ceiling. */
  readonly estimatedTokens: number;
  /** The unconditional ceiling. */
  readonly ceilingTokens: number;
  readonly overBy: number;
  /** True when the model's own limit was unknown, so preflight was advisory. */
  readonly limitWasAdvisory: boolean;
}

/** Pass or breach. There is no third outcome — the guard cannot be skipped. */
export type Tier2Verdict = { readonly outcome: "within_assembly_limit" } | Tier2Breach;

/**
 * Evaluate the Tier 2 guard against an assembled request.
 *
 * Pure. Reads `estimate.range.high` — the same pessimistic figure `decideBudget`
 * accepts on — so the two verdicts cannot disagree about how large the request is.
 *
 * `limitWasAdvisory` is carried for diagnostics only. It changes nothing about the
 * verdict: an unknown model and a fully-known model are bounded identically.
 *
 * @param estimate The post-compaction estimate of the request about to be sent.
 * @param limitSource Resolved provenance, used only to label the diagnostic.
 * @returns A breach when `range.high` exceeds {@link TIER_2_MAX_TOKENS}.
 */
export function evaluateTier2(
  estimate: InputSizeEstimate,
  limitSource: string,
): Tier2Verdict {
  const observed = estimate.range.high;

  if (!Number.isFinite(observed) || observed <= TIER_2_MAX_TOKENS) {
    return { outcome: "within_assembly_limit" };
  }

  return {
    outcome: "assembly_limit_exceeded",
    estimatedTokens: observed,
    ceilingTokens: TIER_2_MAX_TOKENS,
    overBy: observed - TIER_2_MAX_TOKENS,
    limitWasAdvisory: limitSource === "conservative_default" || limitSource === "unknown",
  };
}