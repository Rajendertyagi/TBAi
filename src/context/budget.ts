/**
 * Context budget calculation and enforcement.
 *
 * Deliberately SEPARATE from `prune-messages.ts`, which is lifecycle repair and
 * must stay that way (guarantee G17, rule 6). The distinction is load-bearing:
 * lifecycle repair asks "is this part valid?" and budget asks "is this too
 * much?". They have different correctness requirements, and most importantly a
 * size decision must NEVER be able to drop an unexpired approval decision.
 *
 * Nothing in this module removes or rewrites a part. It computes a verdict and
 * reports the reduction that was already applied by `reduce.ts`; the only
 * decision it makes is accept / reduce / reject.
 */

import { describeLimitSource, resolveOutputReservation } from "./limits";
import type { ContextLimit } from "./types";
import {
  type BudgetDecision,
  type ContextBudget,
  type ContextCategory,
  type InputSizeEstimate,
  type MessagesLayer,
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
 * Order encodes policy. Current user input is never reduced, and neither is
 * tool-call/result PAIRING - a result is never dropped or truncated in a way
 * that invalidates its call. Reducing an old tool result is safe precisely
 * because the call remains and the SDK accepts a bounded result.
 *
 * `reasoning` is reduced because Phase 1 established it is resent
 * unconditionally (F10) and therefore accumulates unboundedly; whether it should
 * be resent at all is a separate policy decision (U16) and is NOT made here.
 */
export const REDUCIBLE_CATEGORIES: readonly ContextCategory[] = [
  "mcp_results",
  "tool_results",
  "reasoning",
  "data_parts",
  "attachments",
  "assistant_text",
];

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
    return {
      usableInputTokens: undefined,
      safetyMarginTokens: 0,
      outputReservation,
      enforceable: false,
    };
  }

  // Reserve output FIRST: it is not optional, and computing input from a limit
  // that has not had it subtracted is the arithmetic error that made a request
  // fill the whole window.
  const afterOutput = Math.max(0, ceiling - outputReservation.tokens);
  const safetyMarginTokens = Math.floor(afterOutput * SAFETY_MARGIN_FRACTION);
  const usableInputTokens = Math.max(0, afterOutput - safetyMarginTokens);

  return { usableInputTokens, safetyMarginTokens, outputReservation, enforceable: true };
}

/**
 * Decide what to do with an assembled request.
 *
 * `reducedAlready` reports the size reduction `reduce.ts` applied before this
 * call, so the verdict can say "reduce happened" rather than the budget silently
 * assuming a smaller number than was measured.
 */
export function decideBudget(input: {
  estimate: InputSizeEstimate;
  budget: ContextBudget;
  reducedAlready: boolean;
}): BudgetDecision {
  const { estimate, budget, reducedAlready } = input;
  const usable = budget.usableInputTokens;

  // Use the HIGH end of the estimate band for the accept decision. Accepting on
  // the point estimate would let a request through whenever the corpus is denser
  // than assumed, which is the failure the whole module exists to prevent.
  const worstCase = estimate.range.high;

  if (usable === undefined) {
    // Unenforceable: no ceiling at all. Report the reduction and let the caller
    // decide, rather than silently accepting.
    return { action: "reduce", reduced: reducedAlready ? ["tool_results"] : [], afterTokens: estimate.estimatedTokens };
  }

  if (worstCase <= usable) return { action: "accept", headroomTokens: usable - worstCase };

  // Over the ceiling at the conservative end of the band but not the point
  // estimate: reduce rather than reject, because the request may still fit.
  if (reducedAlready && estimate.estimatedTokens <= usable) {
    return { action: "accept", headroomTokens: usable - estimate.estimatedTokens };
  }

  if (estimate.range.low > usable) {
    return {
      action: "reject",
      reason: "over_limit",
      overBy: estimate.range.low - usable,
    };
  }

  return { action: "reduce", reduced: [...REDUCIBLE_CATEGORIES], afterTokens: estimate.estimatedTokens };
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
    outputReserve: budget.outputReservation.tokens,
    outputReserveSource: budget.outputReservation.source,
    safetyMargin: budget.safetyMarginTokens,
    usableInput: budget.usableInputTokens ?? null,
    enforceable: budget.enforceable,
    decision: decision.action,
    messageCount: messages.messages.length,
    retainedCount: messages.retainedIds.length,
    currentTurnCount: messages.currentTurnIds.length,
    categories: nonEmptyCategories,
  };

  if (decision.action === "accept") base.headroom = decision.headroomTokens;
  if (decision.action === "reject") {
    base.rejectReason = decision.reason;
    base.overBy = decision.overBy;
  }
  if (decision.action === "reduce") base.reducedCategories = decision.reduced;
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
