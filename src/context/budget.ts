/**
 * Context budget calculation and enforcement.
 *
 * Deliberately SEPARATE from `prune-messages.ts`, which is lifecycle repair and
 * must stay that way (guarantee G17, rule 6). The distinction is load-bearing:
 * lifecycle repair asks "is this part valid?" and budget asks "is this too
 * much?". They have different correctness requirements, and most importantly a
 * size decision must NEVER be able to drop an unexpired approval decision.
 *
 * Nothing in this module removes or rewrites a part. Reduction happens BEFORE the
 * verdict, in `reduce.ts` and the compaction seam; this module only judges what
 * they achieved, so its verdict is binary and honest: accept / reject.
 */

import { describeLimitSource, isPhase3ExperimentEligible, resolveGenerationCap, resolveOutputReservation } from "./limits";
import { REQUEST_REDUCIBLE_CATEGORIES } from "./reduce";
import type { ContextLimit, LimitSource } from "./types";
import {
  type BudgetDecision,
  type ContextBudget,
  type ContextCategory,
  type InputSizeEstimate,
  type MessagesLayer,
  type ReductionRecord,
} from "./types";

/**
 * Fraction of the usable input budget held back to absorb estimation error.
 *
 * Sized against the error model in `measure.ts`: the point estimate uses 3
 * chars/token, the band runs to ~2.5, so the point estimate can understate the
 * true count by roughly 20%. 25% covers that with margin. It is a POLICY number
 * and lives here, not in the measurement module, so tuning the estimate never
 * silently changes enforcement.
 */
export const SAFETY_MARGIN_FRACTION = 0.25;

/**
 * Categories eligible for size reduction, in the order they are reduced.
 *
 * **Sourced from `reduce.ts`, never restated here.** This constant previously
 * listed six categories — `mcp_results`, `tool_results`, `reasoning`,
 * `data_parts`, `attachments`, `assistant_text` — while `reduce.ts` only ever
 * touched three, and `decideBudget` returned all six in its `reduced` field. A
 * request where NOTHING had been reduced therefore logged a reduction of
 * `data_parts`, `attachments` and `assistant_text`. That is the Finding 1 defect:
 * the budget claimed work nobody did, in production diagnostics.
 *
 * Order encodes policy. Current user input is never reduced, and neither is
 * tool-call/result PAIRING - a result is never dropped or truncated in a way
 * that invalidates its call. Reducing an old tool result is safe precisely
 * because the call remains and the SDK accepts a bounded result.
 *
 * `reasoning` is reduced because Phase 1 established it is resent
 * unconditionally (F10) and therefore accumulates unboundedly; whether it should
 * be resent at all is a separate policy decision (U16) and is NOT made here.
 *
 * `data_parts`, `attachments` and `assistant_text` remain UNIMPLEMENTED as
 * reduction targets. If one is ever implemented it must be added in `reduce.ts`
 * first, and this constant will follow it — which is the whole point of not
 * restating the list.
 */
export const REDUCIBLE_CATEGORIES: readonly ContextCategory[] = REQUEST_REDUCIBLE_CATEGORIES;

/** Categories that must never be reduced. */
export const PROTECTED_CATEGORIES: readonly ContextCategory[] = ["instructions", "tool_definitions", "user_text"];

/**
 * Compute the budget for a request.
 *
 * `enforceable` is false only when there is no ceiling at all. Because
 * `resolveContextLimit` always returns a conservative ceiling (source
 * `default`), an unknown model limit still bounds growth - it is simply bounded
 * conservatively rather than accurately. That is the difference between "we
 * don't know" and "we let it run forever", and it is the behaviour Phase 2
 * requires.
 */
export function computeBudget(input: {
  limit: ContextLimit;
  modelOutputTokens?: number | undefined;
}): ContextBudget {
  const outputReservation = resolveOutputReservation(input.modelOutputTokens);
  const ceiling = input.limit.maxInputTokens;

  if (ceiling === undefined || !Number.isFinite(ceiling) || ceiling <= 0) {
    // No enforceable ceiling, so there is no window to clamp the generation cap
    // against. The cap still exists — an uncapped generation is not an option.
    const generationCap = resolveGenerationCap({
      modelOutputTokens: input.modelOutputTokens,
      ceilingTokens: undefined,
      usableInputTokens: undefined,
    });
    return {
      usableInputTokens: undefined,
      safetyMarginTokens: 0,
      outputReservation,
      generationCap,
      enforceable: false,
    };
  }

  // Reserve output FIRST: it is not optional, and computing input from a limit
  // that has not had it subtracted is the arithmetic error that made a request
  // fill the whole window.
  const afterOutput = Math.max(0, ceiling - outputReservation.tokens);
  const safetyMarginTokens = Math.floor(afterOutput * SAFETY_MARGIN_FRACTION);
  const usableInputTokens = Math.max(0, afterOutput - safetyMarginTokens);

  // The generation cap is computed AFTER usable input, because it is clamped by
  // the room the window still has left. The two quantities are separate (R1/P3):
  // `outputReservation` is input held back, `generationCap` is output allowed.
  const generationCap = resolveGenerationCap({
    modelOutputTokens: input.modelOutputTokens,
    ceilingTokens: ceiling,
    usableInputTokens,
  });

  return { usableInputTokens, safetyMarginTokens, outputReservation, generationCap, enforceable: true };
}

/**
 * Decide what to do with an assembled request.
 *
 * ## The one-sentence contract
 *
 * The verdict is `accept` (send it) or `reject` (do not send it), and every path
 * that returns `accept` while the estimate is over must be able to say *why no
 * safe reduction remained*.
 *
 * ## Why reduction is an input, not an output
 *
 * `reduceToolResults` and compaction both run BEFORE this call. This function is
 * not asked to perform a reduction, and it cannot: by now the messages are
 * measured. What it needs is the structured fact of what was attempted, so the
 * verdict can distinguish:
 *
 *   - nothing left to try   → reject (F-A Case B/C)
 *   - nothing was withheld  → still reject; a mechanism that is simply done
 *   - something withheld    → accept (F-A Case D)
 *
 * The old `reducedAlready: boolean` could not express that, which is exactly how a
 * request with nothing reducible came to be sent with a point estimate 61% over
 * budget.
 *
 * ## Determinism
 *
 * Pure. Same estimate, budget and reduction record ⇒ same verdict.
 */
export function decideBudget(input: {
  estimate: InputSizeEstimate;
  budget: ContextBudget;
  /** What each reduction mechanism actually did. Required — no defaulting. */
  reduction: ReductionRecord;
  /**
   * Resolved provenance of the ceiling, required to decide P-1 admissibility.
   *
   * `conservative_default` and `unknown` are stand-ins, not stated limits, so a
   * request over them is ADVISORY rather than rejected. Every other source names a
   * figure somebody asserted about this endpoint and stays terminal.
   */
  limitSource: LimitSource;
}): BudgetDecision {
  const { estimate, budget, reduction } = input;
  const usable = budget.usableInputTokens;
  const { estimatedTokens: point, range } = estimate;

  const accept = (headroomTokens: number): BudgetDecision => ({ action: "accept", headroomTokens, reduction });

  // P-1: a stand-in ceiling is advisory, never terminal.
  //
  // `conservative_default` and `unknown` are figures TBAi supplied, not figures the
  // provider stated. Rejecting against one refuses work the provider would have
  // done AND prevents the provider from ever stating its real limit — the request
  // never reaches transport, so nothing can be learned and the next turn repeats.
  // Tier 2 still bounds these requests unconditionally (`tier2.ts`), so this is not
  // an unbounded relaxation.
  const advisoryCeiling =
    input.limitSource === "conservative_default" || input.limitSource === "unknown";

  if (usable === undefined) {
    // No enforceable ceiling, so there is no budget to enforce and no verdict to
    // derive. `budget.enforceable` is already false and carries that fact to the
    // caller. The previous code returned `"reduce"` here and asked the caller to
    // decide — but no caller could, so it meant "send it" while claiming a
    // reduction had happened.
    return accept(0);
  }

  // Use the HIGH end of the estimate band for the accept decision. Accepting on
  // the point estimate would let a request through whenever the corpus is denser
  // than assumed, which is the failure the whole module exists to prevent.
  const worstCase = range.high;

  // Fits even at the pessimistic end: send, with the honest headroom.
  if (worstCase <= usable) return accept(usable - worstCase);

  // Over at the DENSE end too: the corpus cannot be dense enough to fit. Reject —
  // unless the ceiling is a stand-in (P-1), in which case the same verdict is
  // recorded as advisory so transport can still be reached.
  if (range.low > usable) {
    if (advisoryCeiling) {
      return {
        action: "advisory",
        reason: "limit_not_authoritative",
        planningCeilingTokens: usable,
        overBy: range.low - usable,
        reduction,
      };
    }
    return { action: "reject", reason: "over_limit", overBy: range.low - usable, reduction };
  }

  // The band straddles the budget: `low <= usable < high`. Whether the request
  // really fits is genuinely uncertain, so this is where the policy has to be
  // explicit rather than accidental.
  //
  // The point estimate is the project's single best number and the usable budget
  // already holds back a safety margin for the estimator's documented
  // pessimism (measure.ts uses 3 chars/token against a ~4 prose rule). So a point
  // estimate that fits is sent. A point estimate that does NOT fit is not sent
  // unless a mechanism that could have helped was deliberately withheld.
  if (point <= usable) return accept(usable - point);

  // Point estimate over budget, band cannot rule it out. Everything from here is
  // Case B/C/D.
  if (hasWithheldMechanism(reduction)) {
    // Case D. A mechanism that could have helped was not used: the hysteresis latch
    // will release on a later turn, compaction is configured off, or it failed.
    // The deliberate policy not to compact must NOT become a hard failure here —
    // that would be converting a conservative choice into an outage.
    return accept(usable - point);
  }

  // Case B/C. Every applicable mechanism is done: applied, exhausted, or had
  // nothing of its shape. Nothing safe is left to try, so sending would be
  // sending an oversized request and hoping the provider accepts the estimator's
  // pessimism — the exact behaviour this decision exists to prevent.
  //
  // P-1: when the ceiling is a stand-in there is no provider statement to honour, so
  // this is recorded as advisory rather than terminal. The provider — not a guessed
  // number — decides whether the request fits, and `observed` then learns the answer.
  if (advisoryCeiling) {
    return {
      action: "advisory",
      reason: "limit_not_authoritative",
      planningCeilingTokens: usable,
      overBy: point - usable,
      reduction,
    };
  }
  return { action: "reject", reason: "reduction_exhausted", overBy: point - usable, reduction };
}

/**
 * Whether any reduction mechanism that could have helped was deliberately not used.
 *
 * The single place the Case D policy is decided, so it cannot be applied
 * inconsistently between verdicts and diagnostics.
 */
function hasWithheldMechanism(reduction: ReductionRecord): boolean {
  return reduction.toolResults.kind === "withheld" || reduction.compaction.kind === "withheld";
}

/**
 * Flat, loggable summary of a budget decision.
 *
 * Counts and categories only - never prompt text, never tool payloads. Ids are
 * already excluded upstream: the divergence report carries counts, not ids.
 */
export function budgetDiagnostics(input: {
  estimate: InputSizeEstimate;
  budget: ContextBudget;
  limit: ContextLimit;
  decision: BudgetDecision;
  messages: MessagesLayer;
}): Record<string, unknown> {
  const { estimate, budget, limit, decision, messages } = input;
  const nonEmptyCategories = Object.entries(estimate.byCategory)
    .filter(([, tokens]) => (tokens as number) > 0)
    .map(([category, tokens]) => `${category}:${tokens as number}`);

  const base: Record<string, unknown> = {
    // NOTE ON KEY NAMES: `src/lib/logger.ts` redacts any field whose key
    // matches `.*token.*` (SENSITIVE_KEY_RE), because keys like `authToken` and
    // `refreshToken` really are secrets. That pattern is a security boundary and
    // is NOT relaxed here. The consequence is that a count of tokens cannot be
    // logged under a key containing the word "token" - it would be replaced with
    // "[REDACTED]" and the budget would be unexplainable in production.
    //
    // So the numeric keys avoid the substring and carry `unit: "tokens"` to say
    // unambiguously what they count. The typed fields on `InputSizeEstimate` and
    // `ContextBudget` keep the honest `estimatedTokens` / `usableInputTokens`
    // names - this renaming is a LOG-BOUNDARY concern only.
    unit: "tokens",
    estimatedSize: estimate.estimatedTokens,
    estimateRangeLow: estimate.range.low,
    estimateRangeHigh: estimate.range.high,
    estimatedChars: estimate.estimatedChars,
    charsPerUnit: estimate.charsPerToken,
    // Repeated explicitly so a log line can never be read as usage.
    measurementKind: "estimate_pre_request",
    windowLimit: limit.maxInputTokens ?? null,
    limitSource: describeLimitSource(limit),
    // R1: whether this ceiling may be used to size a Phase 3 cache experiment.
    // Emitted so the Phase 3 log analysis can exclude non-eligible runs instead
    // of quietly averaging a fictional ceiling into a cache-effectiveness result.
    phase3ExperimentEligible: isPhase3ExperimentEligible(limit),
    outputReserve: budget.outputReservation.tokens,
    outputReserveSource: budget.outputReservation.source,
    // The generation cap is a DIFFERENT quantity from the reserve above; both
    // are logged because the pre-R1 code used one value for both.
    generationCap: budget.generationCap.tokens,
    generationCapSource: budget.generationCap.source,
    generationCapBoundedByWindow: budget.generationCap.boundedByRemainingWindow,
    safetyMargin: budget.safetyMarginTokens,
    usableInput: budget.usableInputTokens ?? null,
    enforceable: budget.enforceable,
    decision: decision.action,
    messageCount: messages.messages.length,
    retainedCount: messages.retainedIds.length,
    currentTurnCount: messages.currentTurnIds.length,
    categories: nonEmptyCategories,
    // F-A: what each reduction mechanism actually did. Emitted unconditionally
    // because the WHOLE POINT is that the reduction state must be observable
    // without reconstructing it from token counts. Previously the only reduction
    // diagnostic was a hardcoded category list, which claimed work that had not
    // happened whenever the verdict was the dead `"reduce"`.
    toolResultReduction: decision.reduction.toolResults.kind,
    toolResultReductionReason: decision.reduction.toolResults.reason,
    compactionReduction: decision.reduction.compaction.kind,
    compactionReductionReason: decision.reduction.compaction.reason,
    // Case D made explicit at a glance: a helpful mechanism was deliberately
    // withheld, so an over-budget estimate was sent rather than rejected.
    reductionWithheld: hasWithheldMechanism(decision.reduction),
  };

  // A provider/configured disagreement is recorded only when it happened, so the
  // common case carries no extra keys. The losing value is a count-free number.
  if (limit.divergent && limit.divergentValue) {
    base.limitDivergent = true;
    base.limitDivergentValue = limit.divergentValue.value;
    base.limitDivergentSource = limit.divergentValue.source;
  }

  if (decision.action === "accept") base.headroom = decision.headroomTokens;
  if (decision.action === "reject") {
    base.rejectReason = decision.reason;
    base.overBy = decision.overBy;
  }
  // P-1: an advisory verdict is a distinct outcome, not an accept. Logging it as
  // "accept" would hide the fact that the request was over its planning ceiling and
  // that the ceiling was a stand-in — which is the signal an operator needs when a
  // conversation grows unexpectedly.
  if (decision.action === "advisory") {
    base.advisoryReason = decision.reason;
    base.planningCeiling = decision.planningCeilingTokens;
    base.overBy = decision.overBy;
  }
  return base;
}

/**
 * Whether a pre-flight rejection should happen before the provider is called.
 *
 * A rejection is cheap and actionable; an oversized request that reaches the
 * provider costs a round trip and, because `DIRECT_MAX_RETRIES = 0`
 * (`chat.ts:54-55`), is not retried - it simply fails. Preflight is therefore
 * always preferred, and the provider-side classification in `errors.ts` is the
 * backstop for the cases preflight cannot see (a limit smaller than reported, or
 * a provider counting differently than the estimate).
 */
export function shouldPreflightReject(decision: BudgetDecision): boolean {
  return decision.action === "reject";
}
