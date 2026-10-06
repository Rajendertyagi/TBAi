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
  findSupersededTurns,
  planCompaction,
  type CompactionPlan,
  type CompactionRecord,
  type SupersededTurn,
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
      /**
       * Whether THIS turn's compaction is the one now stored.
       *
       * False when a concurrent writer won the race and this turn applied the
       * winner's record instead. Diagnostics must distinguish the two: the second
       * case did no summarisation work worth attributing to itself.
       */
      readonly wonRace: boolean;
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
  readonly measuredTotalTokens: number;
  /**
   * Tokens compaction cannot reclaim: Layer A + Layer B.
   *
   * Lets the planner confirm the request will actually FIT after compaction,
   * rather than summarising and leaving the caller to reject anyway.
   */
  fixedOverheadTokens: number;
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
   * Message ids the durable record already covers.
   *
   * Hysteresis is decided against these, not against `compactionLatched` alone. A
   * conversation-wide latch made compaction happen exactly once and then grow to
   * the budget forever; scoping the guard to the span the record already paid to
   * summarise lets fresh growth be independently eligible while still preventing a
   * second summarisation of the same history.
   */
  coveredMessageIds?: readonly string[];
  /** Compact on request even when usage is under the trigger (Direct `/compact`). */
  force?: boolean;
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
    fixedOverheadTokens: input.fixedOverheadTokens,
    policy: input.policy,
    hasExistingCompaction: input.existing !== undefined,
    compactionLatched: input.compactionLatched,
    coveredMessageIds: input.coveredMessageIds,
    // Enables the planner's chained capacity accounting. Taken from the record
    // itself rather than passed separately, so it cannot disagree with the summary
    // that is actually handed to the summariser below.
    priorSummaryTokens: input.existing?.summaryTokens,
    force: input.force,
    summarizerInputTokens: input.summarizerInputTokens,
    reason: "pressure",
  });

  if (plan.kind === "none") return { messages: [...input.messages], outcome: { applied: false, reason: plan.reason } };

  // The RAW messages to summarise, sliced from the already-repaired CLIENT list, so
  // the summariser cannot see a stale tool part even if one existed upstream — and
  // so every covered id exists in what the client will re-post.
  //
  // Starts at `summarizerStartIndex`, not `spanStartIndex`. For a first compaction
  // they are equal. For a CHAINED one the already-covered prefix is deliberately
  // skipped: it reaches the summariser as the previous summary instead, which is
  // what lets an oversized history keep making progress instead of re-reading a
  // prefix that alone exceeds one summariser call.
  const spanMessages = input.messages.slice(plan.summarizerStartIndex, plan.spanEndIndex + 1);

  // A repeated compaction hands the summariser the PREVIOUS summary alongside the
  // new material. The previous summary stands for the covered prefix, so without
  // it that history would be silently dropped; and it is placed FIRST because it
  // describes turns that came before everything in `spanMessages`.
  const summariserInput =
    input.priorSummaryText === undefined
      ? spanMessages
      : [
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
          ...spanMessages,
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

  // Did we actually win the race? `persist` returns whatever is stored, which may
  // be another writer's record.
  //
  // Identity is (generation, spanFingerprint), NOT `compactionId`. The audit found
  // that id-based detection is unsound: two concurrent writers at the same
  // generation can produce the SAME id whenever the id is derived from the
  // generation rather than from a unique per-call source, and a test doing exactly
  // that made a losing writer believe it had won. Comparing the span we measured
  // against the span that was stored is semantic and cannot collide.
  const wonRace =
    stored.generation === record.generation && stored.spanFingerprint === record.spanFingerprint;

  // ## Why the loser's path re-locates the winner's span by ID
  //
  // Splicing OUR plan indices with THEIR summary is a silent history-loss defect,
  // and it was found by adversarial audit rather than by review. Verified: with
  // request A winning generation 1 over 20 turns (its record covering a2..a19) and
  // request B losing over 24 turns, B replaced ITS OWN index range [5..47] with
  // A's summary. Eight messages (u20..a23) left B's request and were covered by no
  // durable record at all — no provenance, no way to recover them, and the model
  // was told a summary that did not describe what had been removed.
  //
  // So when we lose: apply the WINNER's record located by id, exactly as an ordinary
  // reload would. If their span is not present in our message list — a different
  // branch, or a history that diverged — compact nothing at all. Refusing is safe;
  // mis-splicing is not.
  const applied = wonRace
    ? {
        messages: applyCompaction({
          messages: input.messages,
          plan,
          record: stored,
          // The span crossed superseded turns, so the ones carrying model-visible
          // non-text content are replayed after the summary under fresh ids.
          preservedTurns: plan.crossedSupersededTurns,
        }),
        applied: true as const,
      }
    : applyExistingCompaction({ messages: input.messages, record: stored });

  if (applied.applied === false) {
    return {
      messages: [...input.messages],
      outcome: { applied: false, reason: "lost_race_span_not_locatable" },
    };
  }

  return {
    messages: applied.messages,
    outcome: {
      applied: true,
      record: stored,
      plan,
      reclaimedTokens: plan.spanEstimatedTokens,
      // True when this turn applied its own compaction; false when it deferred to a
      // concurrent writer's record. Diagnostics need to distinguish them, because
      // the second turn did no summarisation work worth attributing to itself.
      wonRace,
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

  // A replay summarises nothing, so there is nothing to preserve from THIS call.
  // But a record that crossed superseded turns must still re-materialise them: the
  // covered ids no longer appear in the request, so without this the file payload
  // would be absent on every turn after the compaction, not just the one that
  // produced it.
  //
  // Derived from the located span, so it needs no extra persisted state and cannot
  // disagree with what the record actually covered.
  const crossedSupersededTurns = locateCrossedSuperseded(messages, located);

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
        // Nothing is being summarised here — an existing record is being replayed
        // verbatim — so the whole span is the "raw" input by definition.
        summarizerStartIndex: located.start,
        firstRetainedIndex: located.end + 1,
        spanEstimatedTokens: 0,
        spanFingerprint: record.spanFingerprint,
        crossedSupersededTurns,
      },
      record,
      preservedTurns: crossedSupersededTurns,
    }),
    applied: true,
    reason: "record_applied",
  };
}

/**
 * The superseded turns a stored record's span crossed, located in this list.
 *
 * A replay does not carry the original plan, so the crossed turns are recovered
 * structurally: the messages inside the covered span that sit in the trailing
 * unanswered run and carry model-visible non-text content. That is exactly the set
 * the crossing planner recorded, recovered from the same inputs it used.
 */
function locateCrossedSuperseded(
  messages: readonly UIMessage[],
  located: { start: number; end: number },
): SupersededTurn[] {
  return findSupersededTurns(messages).filter(
    (turn) => turn.index >= located.start && turn.index <= located.end,
  );
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