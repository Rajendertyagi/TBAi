/**
 * Classify a compaction report into the budget gate's reduction vocabulary.
 *
 * ## Why this lives here and not in `budget.ts`
 *
 * The strings being classified — `above_release_but_within_hysteresis`,
 * `span_exceeds_summarizer_capacity`, `record_applied_no_new_compaction:<x>` — are
 * compaction's own vocabulary. `budget.ts` is Phase 2 and must not know them, so
 * the owner of the vocabulary does the translation. That keeps the budget gate's
 * input a closed set (`MechanismOutcome`) while every real reason still reaches a
 * log line.
 *
 * ## The governing rule
 *
 * `exhausted` — this mechanism is DONE for this request. It either ran and gave
 * everything it can, or it was applicable and could not help. Nothing further is
 * available from it, so an over-budget estimate means nothing safe is left to try.
 *
 * `withheld` — a mechanism that could have helped was deliberately not used.
 * Compaction is withheld by the hysteresis latch (it will fire on a later turn) or
 * lost to a failure. An over-budget estimate is then still sent, because a
 * conservative policy choice must not be converted into a hard failure.
 *
 * Being configured OFF is `exhausted`, not `withheld`. That is the one judgement
 * call in this file and it is deliberate: with compaction off, the configured
 * policy is "reduce tool output only", and exhausting tool-output reduction means
 * nothing is left to try *under that policy*. Failing fast with an actionable
 * `CONTEXT_OVERFLOW` is strictly better than sending an oversized request and
 * letting the provider fail opaquely. The `disabled` reason keeps the cause
 * visible in diagnostics so the operator can see compaction was never offered.
 */

import type { CompactionReport, MechanismOutcome, ReductionReason } from "../types";

/** Prefix of a reapply-in-place report whose embedded reason needs re-decoding. */
const REAPPLY_PREFIX = "record_applied_no_new_compaction:";

/** Prefix of a report carrying a summariser failure detail. */
const SUMMARIZE_FAILED_PREFIX = "summarize_failed";

/**
 * Describe what compaction did for one request, in the budget gate's vocabulary.
 *
 * Never throws and never returns `undefined`: an unrecognised reason becomes
 * `unknown` rather than being dropped, so a new refusal reason cannot silently
 * become "no information".
 */
export function describeCompactionOutcome(report: CompactionReport): MechanismOutcome {
  if (report.applied) return { kind: "exhausted", reason: "applied" };

  const reason = report.reason;

  // A re-applied record means a previous compaction is in force; the embedded
  // reason is a genuine compaction decision and is decoded on its own merits.
  if (reason.startsWith(REAPPLY_PREFIX)) {
    return describeCompactionOutcome({ ...report, applied: false, reason: reason.slice(REAPPLY_PREFIX.length) });
  }

  if (reason.startsWith(SUMMARIZE_FAILED_PREFIX)) return { kind: "withheld", reason: "failed" };

  switch (reason) {
    // ── Withheld: a helpful mechanism was skipped, not found wanting ─────────
    // The latch is the clearest case. It is set by a compaction that DID apply, so
    // the conversation has already been reduced once; it clears on a later turn
    // once usage demonstrably falls. Rejecting here would fail a conversation
    // that is one turn from being compacted again.
    case "above_release_but_within_hysteresis":
      return { kind: "withheld", reason: "hysteresis" };
    // Never offered because usage is below the policy trigger. Reaching the
    // over-budget branch with this reason would mean the trigger and the budget
    // disagree; mapping it to `withheld` means the more permissive of the two
    // readings wins, so a measurement disagreement cannot reject a request.
    case "below_trigger":
      return { kind: "withheld", reason: "trigger_not_reached" };
    case "no_conversation":
      return { kind: "withheld", reason: "not_eligible" };

    // ── Failed after being offered: it would have helped but could not ──────
    case "persist_failed":
    case "lost_race_span_not_locatable":
    case "compaction_error":
      return { kind: "withheld", reason: "failed" };

    // ── Exhausted: applicable, and genuinely cannot reduce this request ─────
    // Each of these is a hard structural or capacity limit that no amount of
    // retrying or re-planning changes.
    case "span_exceeds_summarizer_capacity":
      return { kind: "exhausted", reason: "span_exceeds_summarizer_capacity" };
    case "would_still_exceed_budget":
      return { kind: "exhausted", reason: "would_still_exceed_budget" };
    case "no_compactable_span":
      return { kind: "exhausted", reason: "no_compactable_span" };
    case "span_too_small_to_compact":
      return { kind: "exhausted", reason: "span_too_small_to_compact" };
    case "summary_would_not_reclaim_enough":
      return { kind: "exhausted", reason: "summary_would_not_reclaim_enough" };

    // ── Not offered by configuration ────────────────────────────────────────
    // No seam wired, or no conversation to record against. `exhausted` is the
    // judgement documented at the top of this file: the configured policy has no
    // message-level reduction, so there is nothing left to try under it.
    case "not_attempted":
      return { kind: "exhausted", reason: "disabled" };

    default:
      return { kind: "exhausted", reason: "unknown" satisfies ReductionReason };
  }
}