/**
 * Phase 4 — compaction orchestration inside the assembly seam.
 *
 * ## Ordering inside the seam (this is the whole integration)
 *
 * ```text
 *   pruneStaleMessages        LIFECYCLE REPAIR  (untouched, still runs first)
 *     → reduceToolResults     request-side size reduction
 *     → applyCompaction       COMPACTION        ← inserted here
 *     → measure               budget accounting
 *     → decideBudget          accept / reduce / reject
 * ```
 *
 * Compaction runs strictly AFTER lifecycle repair. That ordering is the safety
 * argument: a size decision can never resurrect a stale tool part or an expired
 * approval, because those have already been removed and compaction only ever
 * removes MORE.
 *
 * ## Failure containment
 *
 * If anything fails — summariser error, timeout, over-budget summary, a storage
 * error — compaction is abandoned and assembly CONTINUES with the uncompacted
 * history. The caller's existing `CONTEXT_OVERFLOW` rejection then handles the
 * over-budget request exactly as it does today. A failed compaction is therefore
 * never worse than no compaction, and never corrupts stored state.
 *
 * ## Provider-agnostic by construction
 *
 * The model is injected. There is no provider branch, and no cache-control
 * knowledge lives here — Phase 3's capability layer remains authoritative and
 * untouched.
 */

import type { UIMessage } from "ai";
import {
  applyCompaction,
  planCompaction,
  type CompactionPlan,
  type CompactionRecord,
} from "./contract";
import { summarizeSpan, type SummarizeResult } from "./summarize";

/**
 * How much hysteresis headroom is required before a second compaction.
 *
 * The latch is released only once measured usage falls back below the release
 * fraction, which `runCompactionPhase` does by observing usage — not by the
 * planner deriving it.
 */

/** Whether the hysteresis latch is currently engaged for a conversation. */
export function isCompactionLatched(record: CompactionRecord | undefined): boolean {
  return record?.latched === true;
}

/** How compaction ran. Reported verbatim into diagnostics. */
export type CompactionOutcome =
  | { readonly applied: false; readonly reason: string }
  | {
      readonly applied: true;
      readonly record: CompactionRecord;
      readonly plan: Extract<CompactionPlan, { kind: "compact" }>;
      /** Tokens the removed span was estimated to occupy. */
      readonly reclaimedTokens: number;
    };

export interface MaybeCompactInput {
  conversationId: string | undefined;
  /**
   * The messages the plan is computed over.
   *
   * MUST be the list the CLIENT sent — the original repaired/reduced history, NOT
   * the compacted view produced by `applyExistingCompaction`. See
   * {@link MaybeCompactInput.priorSummaryText} for why this is load-bearing.
   */
  messages: readonly UIMessage[];
  /** Index-aligned per-message estimates from the Phase 2 measurement. */
  measuredTokens: readonly number[];
  /** The single message that is the live user request. */
  currentTurnIds: readonly string[];
  /**
   * Measured pressure, taken from the COMPACTED view.
   *
   * The trigger must reflect what the provider would actually receive, which after
   * a prior compaction includes the summary rather than the original span.
   */
  measuredTotalTokens: number;
  usableInputTokens: number | undefined;
  /** Existing durable record, if any. */
  existing: CompactionRecord | undefined;
  /**
   * Text of the previous summary, given to the summariser so a repeated compaction
   * carries the history forward instead of dropping it.
   *
   * This is what makes summary chaining correct. The new span is planned over the
   * client's messages, so it covers strictly MORE of the conversation than the
   * previous record did — but the part between the two spans no longer exists as
   * messages. Without handing the previous summary to the summariser, that history
   * would be silently lost.
   */
  priorSummaryText: string | undefined;
  /** Durable hysteresis latch. Engaged on compaction, cleared by the seam. */
  compactionLatched: boolean;
  /**
   * Capacity for ONE summariser call.
   *
   * Passed to the planner so an oversized span is refused before a provider call,
   * not after one. See the comment on `planCompaction`.
   */
  readonly summarizerInputTokens: number | undefined;
  policy: Parameters<typeof planCompaction>[0]["policy"];
  /** Injected summariser. Omitted in tests and when summarisation is disabled. */
  summarize: (spanMessages: readonly UIMessage[]) => Promise<SummarizeResult>;
  /** Persists the record. Injected so storage stays out of the decision path. */
  persist: (record: CompactionRecord) => CompactionRecord | undefined;
  /** Deterministic id source. Injected so this module has no clock or randomness. */
  nextCompactionId: (generation: number) => string;
  /** Wall-clock source, injected for determinism. */
  now: () => number;
  abortSignal?: AbortSignal | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Decide whether to compact, and if so produce and persist the replacement.
 *
 * Never throws. Every failure yields `{ applied: false, reason }`, which the
 * caller treats as "assemble normally".
 */
export async function maybeCompact(input: MaybeCompactInput): Promise<{
  messages: UIMessage[];
  outcome: CompactionOutcome;
}> {
  const plan = planCompaction({
    messages: input.messages,
    measuredTokens: input.measuredTokens,
    usableInputTokens: input.usableInputTokens,
    measuredTotalTokens: input.measuredTotalTokens,
    policy: input.policy,
    hasExistingCompaction: input.existing !== undefined,
    compactionLatched: input.compactionLatched,
    summarizerInputTokens: input.summarizerInputTokens,
    reason: "pressure",
  });

  if (plan.kind === "none") return { messages: [...input.messages], outcome: { applied: false, reason: plan.reason } };

  // The span to summarise, sliced from the already-repaired CLIENT messages, so
  // the summariser cannot see a stale tool part even if one existed upstream — and
  // so every covered id exists in what the client will re-post.
  const spanMessages = input.messages.slice(plan.spanStartIndex, plan.spanEndIndex + 1);

  // A repeated compaction hands the summariser the PREVIOUS summary alongside the
  // new span. The new span covers strictly more of the conversation, but the part
  // it no longer contains as messages survives only inside the old summary — so
  // without this the earlier history would be silently dropped.
  const summariserInput =
    input.priorSummaryText === undefined
      ? spanMessages
      : [
          ...spanMessages,
          {
            id: `prior-summary-${plan.spanFingerprint}`,
            role: "user" as const,
            parts: [
              {
                type: "text" as const,
                text: `SUMMARY OF EARLIER TURNS (superseded by this one, but still authoritative for what happened before them):\n${input.priorSummaryText}`,
              },
            ],
          } as unknown as UIMessage,
        ];

  const summary = await input.summarize(summariserInput);

  if (summary.ok === false) {
    // Contained failure: the caller falls back to today's behaviour.
    return { messages: [...input.messages], outcome: { applied: false, reason: `summarize_failed:${summary.failure}` } };
  }

  const generation = (input.existing?.generation ?? 0) + 1;
  const record: CompactionRecord = {
    compactionId: input.nextCompactionId(generation),
    conversationId: input.conversationId ?? "unknown",
    spanStartIndex: plan.spanStartIndex,
    spanEndIndex: plan.spanEndIndex,
    coveredMessageIds: [...plan.spanMessageIds],
    spanFingerprint: plan.spanFingerprint,
    summaryText: summary.summaryText,
    summaryTokens: summary.summaryTokens,
    origin: "model_generated_summary",
    summarizedBy: summary.summarizedBy,
    generation,
    // Every compaction re-engages the hysteresis latch. It is cleared by
    // observing usage fall back below the release fraction.
    latched: true,
    createdAt: input.now(),
  };

  const stored = input.persist(record);
  if (!stored) {
    return { messages: [...input.messages], outcome: { applied: false, reason: "persist_failed" } };
  }

  // Apply the STORED record, not the proposed one. If another writer won the
  // race, its span is authoritative and applying ours would contradict the
  // durable record.
  const applied = applyCompaction({ messages: input.messages, plan, record: stored });

  return {
    messages: applied,
    outcome: {
      applied: true,
      record: stored,
      plan,
      reclaimedTokens: plan.spanEstimatedTokens,
    },
  };
}

/**
 * Apply an EXISTING durable record to a fresh message list.
 *
 * Used on every ordinary turn once a conversation has been compacted, so the
 * compacted form is stable across reload, resume, and detached completion
 * without re-summarising.
 *
 * The span is matched by FINGERPRINT rather than by index, because the client
 * re-posts the conversation and indices shift as turns are appended. When the
 * fingerprint does not match — the user regenerated, edited, or branched — the
 * record is deliberately NOT applied: a summary of a span that is no longer in
 * the conversation would be a fabrication.
 */
export function applyExistingCompaction(input: {
  messages: readonly UIMessage[];
  record: CompactionRecord | undefined;
}): { messages: UIMessage[]; applied: boolean; reason: string } {
  const { messages, record } = input;
  if (!record) return { messages: [...messages], applied: false, reason: "no_record" };

  const located = locateSpan(messages, record);
  if (!located) return { messages: [...messages], applied: false, reason: "span_not_present" };

  return {
    messages: applyCompaction({
      messages,
      plan: {
        kind: "compact",
        reason: "pressure",
        spanStartIndex: located.start,
        spanEndIndex: located.end,
        spanLength: located.end - located.start + 1,
        spanMessageIds: record.coveredMessageIds,
        firstRetainedIndex: located.end + 1,
        spanEstimatedTokens: 0,
        spanFingerprint: record.spanFingerprint,
      },
      record,
    }),
    applied: true,
    reason: "record_applied",
  };
}

/**
 * Find the recorded span inside a submitted message list.
 *
 * Locates the LAST covered id and walks back the recorded count, then confirms
 * the fingerprint. Confirming rather than assuming is what makes a regenerate or
 * an edit fail SAFE instead of silently mis-applying a summary.
 */
function locateSpan(
  messages: readonly UIMessage[],
  record: CompactionRecord,
): { start: number; end: number } | undefined {
  const covered = record.coveredMessageIds;
  if (covered.length === 0) return undefined;

  const idOf = (m: UIMessage | undefined): string | undefined => {
    const id = (m as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : undefined;
  };

  // Anchor on the last covered id, which is the least likely to move.
  let end = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (idOf(messages[i]) === covered[covered.length - 1]) {
      end = i;
      break;
    }
  }
  if (end < 0) return undefined;

  const start = end - covered.length + 1;
  if (start < 0) return undefined;

  // Verify the anchor id and count line up, then let the caller confirm by
  // fingerprint when it applies the plan.
  for (let i = 0; i < covered.length; i += 1) {
    if (idOf(messages[start + i]) !== covered[i]) return undefined;
  }
  return { start, end };
}