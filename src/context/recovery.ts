/**
 * Bounded recovery from a provider context-overflow rejection.
 *
 * ## The gap this closes
 *
 * Until now a provider context overflow was CLASSIFIED and DISPLAYED and nothing
 * else happened. `classifyError` returned `context_overflow`, `sanitizeStreamError`
 * picked its copy, the run failed - and because Direct sets
 * `DIRECT_MAX_RETRIES = 0`, the user was told to retry into the identical
 * rejection, or to change provider, neither of which addresses the actual cause.
 *
 * OpenCode's reference behaviour is to COMPACT and retry. This module is the
 * decision half of that: a pure function that answers "given this failure, is
 * recovery permitted, and what kind?" - separated from execution so the policy
 * can be tested exhaustively without a provider.
 *
 * ## Why recovery is bounded to ONE attempt
 *
 * An unbounded "compact and retry on overflow" loop is a hang with extra steps:
 * if compaction cannot reduce the history enough, the retry overflows again,
 * compacts again, and never terminates. OpenCode guards this the same way - its
 * run loop clears its overflow-recovery flag after one successful recovery.
 *
 * So `decideOverflowRecovery` refuses a second attempt for the same request, and
 * that refusal is explicit and testable rather than an emergent property.
 *
 * ## Recovery is deliberately NOT the retry policy
 *
 * `DIRECT_MAX_RETRIES = 0` is correct: a transport blip should not be replayed
 * blindly, and a non-idempotent turn should not be duplicated. But zero general
 * retries must not also mean "no recovery from an overflow", because overflow is
 * a SIZE problem with a known remedy, not a transport fault. Keeping the two
 * decisions separate is why `maxRetries` is not consulted here at all.
 */
import type { ErrorCategory } from "../lib/errors";

/** Why recovery was or was not attempted. Every value is a reportable outcome. */
export type OverflowRecoveryOutcome =
  /** Compact the history, then let the caller re-issue the request once. */
  | "compact_and_retry"
  /** The failure is not a context overflow; ordinary handling applies. */
  | "not_context_overflow"
  /** A recovery has already run for this request. Bounded on purpose. */
  | "recovery_already_attempted"
  /** Compaction is switched off, so there is no remedy to apply. */
  | "compaction_disabled"
  /** There is no durable conversation to compact. */
  | "no_conversation";

export interface OverflowRecoveryDecision {
  readonly outcome: OverflowRecoveryOutcome;
  /** True only when the caller should compact and re-issue. */
  readonly shouldRecover: boolean;
}

export interface OverflowRecoveryInput {
  /** The classified provider failure. */
  readonly category: ErrorCategory | string | undefined;
  /** Whether a recovery has already been attempted for THIS request. */
  readonly alreadyAttempted: boolean;
  /** Result of `compactionEnabled()`. */
  readonly compactionEnabled: boolean;
  /** Whether the conversation is persisted, and so compactable at all. */
  readonly hasConversation: boolean;
}

/**
 * Decide whether a failed turn may be recovered by compacting and re-issuing.
 *
 * Pure and total: every input maps to exactly one outcome, so a caller can never
 * reach a state where it neither recovers nor reports.
 */
export function decideOverflowRecovery(input: OverflowRecoveryInput): OverflowRecoveryDecision {
  if (input.category !== "context_overflow") {
    return { outcome: "not_context_overflow", shouldRecover: false };
  }
  if (input.alreadyAttempted) {
    return { outcome: "recovery_already_attempted", shouldRecover: false };
  }
  if (!input.compactionEnabled) {
    return { outcome: "compaction_disabled", shouldRecover: false };
  }
  if (!input.hasConversation) {
    return { outcome: "no_conversation", shouldRecover: false };
  }
  return { outcome: "compact_and_retry", shouldRecover: true };
}

/**
 * True when the classification is one a size remedy could actually help.
 *
 * `payload-too-large` shares the 4xx family but is NOT a context problem: it is
 * a single oversized part, which compaction of the SPAN may not touch. Treating
 * it as recoverable would compact a conversation that was never too long.
 */
export function isRecoverableOverflow(category: ErrorCategory | string | undefined): boolean {
  return category === "context_overflow";
}