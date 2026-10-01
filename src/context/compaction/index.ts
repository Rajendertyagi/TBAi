/**
 * Phase 4 — automatic context compaction: public surface.
 *
 * ## What this module owns
 *
 * A conversation whose assembled request no longer fits is compacted once, in a
 * bounded and reversible way, instead of being rejected.
 *
 * ## What it deliberately does not own
 *
 * - **Lifecycle repair.** `pruneStaleMessages` is untouched and still runs first.
 * - **Assembly.** `assembleContext` remains the only Direct context path.
 * - **Enforcement.** The Phase 2 budget still decides accept / reduce / reject.
 *   Compaction reduces the INPUT to that decision; it never overrides it.
 * - **Cache controls.** Phase 3's capability layer stays authoritative.
 * - **Provider selection.** The summariser model is injected.
 */

export {
  planCompaction,
  applyCompaction,
  renderCompactedMessages,
  latestCutIndexBefore,
  currentTurnStartIndex,
  spanFingerprint,
  compactionEnabled,
  COMPACTION_ENV,
  COMPACTION_SUMMARY_TIMEOUT_MS,
  CONTEXT_ORIGINS,
  type CompactionPlan,
  type CompactionPolicy,
  type CompactionReason,
  type CompactionRecord,
  type ContextOrigin,
} from "./contract";

export {
  summarizeSpan,
  renderSpanTranscript,
  SUMMARY_SYSTEM_PROMPT,
  type SummarizeInput,
  type SummarizeResult,
} from "./summarize";

export {
  maybeCompact,
  applyExistingCompaction,
  type CompactionOutcome,
  type MaybeCompactInput,
} from "./orchestrate";

export {
  isCompactionLatched,
} from "./orchestrate";

/**
 * Default policy.
 *
 * Every number is derived from the Phase 2 budget model rather than chosen:
 *
 * - `triggerFraction = 0.8` — compaction begins once 80% of the usable budget is
 *   consumed, leaving 20% for the summary itself. Compacting AT the limit would
 *   be too late: the summary has to fit.
 * - `releaseFraction = 0.6` — the hysteresis gap. A conversation sitting between
 *   60% and 80% does not re-compact, so repeated turns cannot pay a summarisation
 *   call for no progress.
 * - `minRetainedTail = 6` — a floor on the immediate context, so compaction can
 *   never reduce a conversation to "the last thing that happened".
 * - `maxSummaryTokens = 1500` — bounded well under the smallest documented cache
 *   minimum TBAi knows (512 is the floor; 1500 sits above it so a summary can
 *   actually reach cacheability) and far below any usable budget.
 * - `summaryOutputReservation = 2048` — the summariser's own output bound.
 */
export const DEFAULT_COMPACTION_POLICY = {
  triggerFraction: 0.8,
  releaseFraction: 0.6,
  minRetainedTail: 6,
  maxSummaryTokens: 1_500,
  summaryOutputReservation: 2_048,
} as const satisfies CompactionPolicyLike;

/** Structural alias so the constant above is checked against the real type. */
type CompactionPolicyLike = {
  readonly triggerFraction: number;
  readonly releaseFraction: number;
  readonly minRetainedTail: number;
  readonly maxSummaryTokens: number;
  readonly summaryOutputReservation: number;
};