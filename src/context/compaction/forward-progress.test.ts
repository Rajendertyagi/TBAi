/**
 * PHASE E — repeated compaction must make FORWARD PROGRESS.
 *
 * ## Why this file exists
 *
 * The reported production failure was not a provider overflow. It was a local
 * pre-flight rejection that never got better, and the reason it never got better
 * is the property pinned here:
 *
 * A conversation whose existing compaction record covered a span that was most of
 * the summariser's capacity could never be compacted again. The planner sized the
 * span's RAW size against the summariser's input ceiling, walked the span's end
 * backwards until the raw size fit, landed exactly on the already-covered range,
 * and the span-scoped hysteresis guard then correctly reported
 * `already_compacted_span`. Every subsequent turn grew the tail, re-planned the
 * same covered span, and was refused again — forever.
 *
 * The guard was not the bug. The span it was handed was.
 *
 * ## The correction
 *
 * A repeated compaction's summariser reads `previous summary + new growth`. The
 * covered prefix's raw size is therefore not something the summariser ever has to
 * read, and must not be charged against its capacity. When a record covers a
 * contiguous prefix, the planner now anchors there, extends FORWARD over all new
 * growth, and sizes capacity as `priorSummaryTokens + growth`.
 *
 * Every test below builds the conversation from the real production numbers:
 * `UNKNOWN_LIMIT_CEILING` 128k minus the 25% safety margin gives a usable budget of
 * 92,928, the summariser ceiling was 125,952, and the covered prefix measured
 * 114,921 — 91% of that ceiling. One new message of 15,000 tokens then exceeds the
 * 11,031 tokens of headroom the old accounting left, which is what pinned the span
 * to the covered range permanently.
 */

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";

import {
  applyExistingCompaction,
  DEFAULT_COMPACTION_POLICY,
  maybeCompact,
  planCompaction,
  type CompactionPlan,
  type CompactionRecord,
} from "./index";

// ─── The production numbers ─────────────────────────────────────────────────

/** `SUMMARISER_INPUT_CEILING` in the failing install. */
const SUMMARISER_CAPACITY = 125_952;
/** The failing conversation's generation-4 record summary. */
const PRIOR_SUMMARY_TOKENS = 947;
/** Measured size of the already-covered prefix: 91% of the ceiling. */
const COVERED_MESSAGE_TOKENS = 12_769;
/** Nine covered messages. */
const COVERED_COUNT = 9;
/** The single message that blew the remaining headroom. */
const OVERSIZE_MESSAGE_TOKENS = 15_000;
/** Ordinary settled turns after the covered range. */
const SETTLED_MESSAGE_TOKENS = 80;
/** Small turns before the covered range, and the live request. */
const SMALL_MESSAGE_TOKENS = 40;

const TURNS = 12;
/** `TURNS` user/assistant pairs plus the live user request. */
const MESSAGE_COUNT = TURNS * 2 + 1;

/** Index of the last assistant message before the live request. */
const CUT_INDEX = MESSAGE_COUNT - 2;
/**
 * Where retained-tail span selection anchors: `cutIndex - length + 1 +
 * minRetainedTail`. The covered prefix starts exactly here, which is why the old
 * walk-back landed inside it.
 */
const COVERED_START = CUT_INDEX - MESSAGE_COUNT + 1 + DEFAULT_COMPACTION_POLICY.minRetainedTail;
/** First uncovered message — the start of the growth a chained plan summarises. */
const GROWTH_START = COVERED_START + COVERED_COUNT;
/** The oversize message, the first of the growth. */
const OVERSIZE_INDEX = GROWTH_START;

/** Usable budget chosen so the trigger fires and the residual check passes. */
const USABLE_INPUT_TOKENS = 140_000;

// ─── fixtures ──────────────────────────────────────────────────────────────

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}
function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text, state: "done" }] } as unknown as UIMessage;
}

/**
 * A conversation whose measured sizes reproduce the production shape exactly.
 *
 * `conversation(12)` yields `u0 a0 … u11 a11` then the live request, so index
 * `2n` is a user turn and `2n+1` its assistant reply.
 */
function regressedConversation(): { messages: UIMessage[]; measuredTokens: number[] } {
  const messages: UIMessage[] = [];
  for (let i = 0; i < TURNS; i += 1) {
    messages.push(user(`u${i}`, `question ${i}`));
    messages.push(assistant(`a${i}`, `answer ${i}`));
  }
  messages.push(user("live", "the current question"));

  const measuredTokens = messages.map((_m, index) => {
    if (index >= COVERED_START && index < GROWTH_START) return COVERED_MESSAGE_TOKENS;
    if (index === OVERSIZE_INDEX) return OVERSIZE_MESSAGE_TOKENS;
    if (index === messages.length - 1) return SMALL_MESSAGE_TOKENS;
    if (index > OVERSIZE_INDEX) return SETTLED_MESSAGE_TOKENS;
    return SMALL_MESSAGE_TOKENS;
  });

  return { messages, measuredTokens };
}

/** Ids of the contiguous covered prefix, as a durable record would hold them. */
function coveredIds(messages: readonly UIMessage[]): string[] {
  return messages.slice(COVERED_START, COVERED_START + COVERED_COUNT).map((m) => String((m as { id: string }).id));
}

/** Total measured tokens across the removable range. */
function sumRange(values: readonly number[], start: number, end: number): number {
  let total = 0;
  for (let i = start; i <= end; i += 1) total += values[i] ?? 0;
  return total;
}

/** A planner call carrying only what a real caller can supply. */
function plan(over: Partial<Parameters<typeof planCompaction>[0]> = {}): CompactionPlan {
  const { messages, measuredTokens } = regressedConversation();
  const covered = coveredIds(messages);
  return planCompaction({
    messages,
    measuredTokens,
    usableInputTokens: USABLE_INPUT_TOKENS,
    measuredTotalTokens: sumRange(measuredTokens, COVERED_START, CUT_INDEX),
    fixedOverheadTokens: 0,
    policy: DEFAULT_COMPACTION_POLICY,
    hasExistingCompaction: true,
    compactionLatched: true,
    coveredMessageIds: covered,
    priorSummaryTokens: PRIOR_SUMMARY_TOKENS,
    summarizerInputTokens: SUMMARISER_CAPACITY,
    reason: "pressure",
    ...over,
  });
}

/** A durable record whose coverage is the covered prefix. */
function recordFor(generation: number, messages: readonly UIMessage[]): CompactionRecord {
  return {
    compactionId: `cmp_${generation}`,
    conversationId: "conv-regressed",
    spanStartIndex: COVERED_START,
    spanEndIndex: COVERED_START + COVERED_COUNT - 1,
    coveredMessageIds: coveredIds(messages),
    spanFingerprint: `fingerprint-${generation}`,
    summaryText: `SUMMARY generation ${generation}`,
    summaryTokens: PRIOR_SUMMARY_TOKENS,
    origin: "model_generated_summary",
    summarizedBy: "test/model",
    generation,
    latched: true,
    createdAt: 1_700_000_000_000,
  };
}

// ─── the stuck state, pinned as a precondition ─────────────────────────────

describe("PRECONDITION: the raw span cannot fit one summariser call", () => {
  it("the covered prefix alone is 91% of the ceiling, and the whole span exceeds it", () => {
    const { measuredTokens } = regressedConversation();
    const coveredTokens = sumRange(measuredTokens, COVERED_START, GROWTH_START - 1);
    const rawSpan = sumRange(measuredTokens, COVERED_START, CUT_INDEX);

    // The shape that pinned the span: a covered prefix that nearly fills the
    // summariser, and one new message larger than the headroom it leaves.
    expect(coveredTokens).toBeGreaterThan(SUMMARISER_CAPACITY * 0.9);
    expect(SUMMARISER_CAPACITY - coveredTokens).toBeLessThan(OVERSIZE_MESSAGE_TOKENS);
    expect(rawSpan).toBeGreaterThan(SUMMARISER_CAPACITY);
  });

  it("without the prior summary's size, the planner is permanently stuck", () => {
    // THE DEFECT, reproduced. A caller that cannot report the previous summary's
    // size falls back to raw-span accounting, walks the end back onto the covered
    // range, and is refused. This is the exact production loop.
    const stuck = plan({ priorSummaryTokens: undefined });
    expect(stuck).toEqual({ kind: "none", reason: "already_compacted_span" });
  });
});

// ─── forward progress ──────────────────────────────────────────────────────

describe("a repeated compaction extends FORWARD over new growth", () => {
  it("plans a compaction instead of refusing the conversation forever", () => {
    const result = plan();
    expect(result.kind).toBe("compact");
  });

  it("anchors the span at the covered prefix so coverage stays contiguous", () => {
    const result = plan();
    if (result.kind !== "compact") throw new Error("expected a compaction plan");
    expect(result.spanStartIndex).toBe(COVERED_START);
  });

  it("extends the span end to the last settled turn", () => {
    const result = plan();
    if (result.kind !== "compact") throw new Error("expected a compaction plan");
    expect(result.spanEndIndex).toBe(CUT_INDEX);
  });

  it("hands the summariser only the growth, never the covered prefix", () => {
    const result = plan();
    if (result.kind !== "compact") throw new Error("expected a compaction plan");
    // The covered prefix reaches the summariser as the previous summary. Charging
    // its raw size against capacity is what made progress impossible.
    expect(result.summarizerStartIndex).toBe(GROWTH_START);
    expect(result.summarizerStartIndex).toBeGreaterThan(result.spanStartIndex);
  });

  it("reclaims the whole covered prefix plus the growth, not just the prefix", () => {
    const result = plan();
    if (result.kind !== "compact") throw new Error("expected a compaction plan");
    const { measuredTokens } = regressedConversation();
    expect(result.spanEstimatedTokens).toBe(sumRange(measuredTokens, COVERED_START, CUT_INDEX));
  });

  it("a chained plan is exempt from the raw-span capacity refusal", () => {
    // The raw span is larger than one summariser call BY CONSTRUCTION here. The
    // capacity that actually matters — `priorSummary + growth` — fits, so refusing
    // would be refusing on a number the summariser never reads.
    const { measuredTokens } = regressedConversation();
    expect(sumRange(measuredTokens, COVERED_START, CUT_INDEX)).toBeGreaterThan(SUMMARISER_CAPACITY);

    const result = plan();
    if (result.kind !== "compact") throw new Error("expected a compaction plan");
    const summarizerRead =
      PRIOR_SUMMARY_TOKENS + sumRange(measuredTokens, result.summarizerStartIndex, result.spanEndIndex);
    expect(summarizerRead).toBeLessThanOrEqual(SUMMARISER_CAPACITY);
  });
});

// ─── the honest refusal ────────────────────────────────────────────────────

describe("forward progress stops only when there is genuinely nothing new", () => {
  it("refuses with a capacity reason when one new message dwarfs the summariser", () => {
    // One new message larger than the whole summariser budget cannot be summarised
    // at all. This is an honest, bounded refusal — distinct from the permanent
    // loop, because it describes THIS span rather than the conversation's growth.
    const { messages, measuredTokens } = regressedConversation();
    const result = plan({
      measuredTokens: measuredTokens.map((t, i) => (i >= GROWTH_START ? SUMMARISER_CAPACITY * 2 : t)),
    });
    expect(result).toEqual({ kind: "none", reason: "span_exceeds_summarizer_capacity" });
    expect(messages).toHaveLength(MESSAGE_COUNT);
  });

  it("reports already_compacted_span when the covered prefix reaches the last settled turn", () => {
    // The one situation `already_compacted_span` honestly describes: there is no
    // new settled history to compact. The covered prefix already reaches the last
    // safe cut point, so no chained plan is possible and the span-scoped
    // hysteresis guard refuses.
    const { messages, measuredTokens } = regressedConversation();
    const covered = coveredIds(messages);
    // A record whose coverage runs right up to the assistant reply before the live
    // request: nothing between its end and the cut point.
    const upToCut = messages
      .slice(COVERED_START, CUT_INDEX + 1)
      .map((m) => String((m as { id: string }).id));

    const result = plan({ coveredMessageIds: upToCut });
    expect(result).toEqual({ kind: "none", reason: "already_compacted_span" });
    expect(covered.length).toBe(COVERED_COUNT);
    expect(measuredTokens).toHaveLength(MESSAGE_COUNT);
  });

  it("shrinks the growth to the newest part that does fit, rather than refusing", () => {
    // Oversized growth: the tail cannot all be summarised in one call, so the span
    // end walks back to a safe cut and the rest stays eligible next turn.
    const { measuredTokens } = regressedConversation();
    const result = plan({
      measuredTokens: measuredTokens.map((t, i) =>
        i >= GROWTH_START ? Math.ceil(SUMMARISER_CAPACITY / 3) : t,
      ),
    });
    if (result.kind !== "compact") throw new Error(`expected a compaction plan, got ${result.reason}`);
    expect(result.summarizerStartIndex).toBe(GROWTH_START);
    expect(result.spanEndIndex).toBeLessThan(CUT_INDEX);
    expect(result.spanEndIndex).toBeGreaterThanOrEqual(GROWTH_START);
  });
});

// ─── safety of the fallback path ───────────────────────────────────────────

describe("an unprovable covered prefix falls back instead of splicing", () => {
  it("plans from the retained tail when the covered ids are not in this list", () => {
    // A branched or regenerated history. The planner cannot prove where the
    // covered range is, so it must fall back to retained-tail selection rather
    // than splice a range it guessed.
    const { messages, measuredTokens } = regressedConversation();
    const result = plan({
      messages,
      measuredTokens,
      coveredMessageIds: ["not-in-this-conversation", "also-absent"],
    });
    if (result.kind !== "compact") throw new Error(`expected a compaction plan, got ${result.reason}`);
    expect(result.summarizerStartIndex).toBe(result.spanStartIndex);
  });

  it("plans from the retained tail when the covered run has a gap", () => {
    // Covered ids present but non-contiguous: splicing across the gap would
    // remove a message no record accounts for.
    const { messages, measuredTokens } = regressedConversation();
    const ids = coveredIds(messages);
    const gapped = [...ids.slice(0, -1), "u11"]; // drop one id, append a later one
    const result = plan({ messages, measuredTokens, coveredMessageIds: gapped });
    if (result.kind !== "compact") throw new Error(`expected a compaction plan, got ${result.reason}`);
    expect(result.summarizerStartIndex).toBe(result.spanStartIndex);
  });
});

// ─── first compaction is untouched ─────────────────────────────────────────

describe("a first compaction is unchanged by any of this", () => {
  it("has no covered prefix, so it summarises the whole span", () => {
    const result = plan({
      hasExistingCompaction: false,
      compactionLatched: false,
      coveredMessageIds: undefined,
    });
    if (result.kind !== "compact") throw new Error(`expected a compaction plan, got ${result.reason}`);
    expect(result.summarizerStartIndex).toBe(result.spanStartIndex);
  });
});

// ─── end-to-end through the orchestrator ───────────────────────────────────

describe("repeated compaction through the orchestrator", () => {
  /** Drives one compaction turn and reports what the summariser was handed. */
  async function compactOnce(over: Partial<Parameters<typeof maybeCompact>[0]> = {}) {
    const { messages, measuredTokens } = regressedConversation();
    const existing = recordFor(1, messages);
    let summariserSaw: readonly UIMessage[] = [];
    const result = await maybeCompact({
      conversationId: "conv-regressed",
      messages,
      measuredTokens,
      currentTurnIds: ["live"],
      measuredTotalTokens: sumRange(measuredTokens, COVERED_START, CUT_INDEX),
      fixedOverheadTokens: 0,
      usableInputTokens: USABLE_INPUT_TOKENS,
      existing,
      compactionLatched: true,
      coveredMessageIds: existing.coveredMessageIds,
      priorSummaryText: existing.summaryText,
      summarizerInputTokens: SUMMARISER_CAPACITY,
      policy: DEFAULT_COMPACTION_POLICY,
      summarize: async (spanMessages) => {
        summariserSaw = spanMessages;
        return {
          ok: true as const,
          summaryText: "SUMMARY: generation 2.",
          summaryTokens: PRIOR_SUMMARY_TOKENS,
          summarizedBy: "test/model",
          origin: "model_generated_summary" as const,
        };
      },
      persist: (r: CompactionRecord) => r,
      nextCompactionId: (generation: number) => `cmp_${generation}`,
      now: () => 1_700_000_000_000,
      ...over,
    });
    return { result, summariserSaw };
  }

  it("applies a compaction where the old accounting refused", async () => {
    const { result } = await compactOnce();
    expect(result.outcome.applied).toBe(true);
  });

  it("gives the summariser the previous summary plus the growth, in that order", async () => {
    const { summariserSaw } = await compactOnce();
    const text = JSON.stringify(summariserSaw);
    // The chain is present…
    expect(text).toContain("SUMMARY generation 1");
    // …the new growth is present…
    expect(text).toContain("answer 11");
    // …and the live request never is.
    expect(text).not.toContain("the current question");
  });

  it("never hands the summariser the already-covered prefix", async () => {
    const { summariserSaw } = await compactOnce();
    const text = JSON.stringify(summariserSaw);
    // a2 is the first covered message. Re-reading it is exactly the cost that
    // made the covered prefix exceed one summariser call.
    expect(text).not.toContain("answer 2");
    expect(text).not.toContain("answer 5");
  });

  it("places the previous summary before the growth it precedes", async () => {
    const { summariserSaw } = await compactOnce();
    const text = JSON.stringify(summariserSaw);
    expect(text.indexOf("SUMMARY generation 1")).toBeLessThan(text.indexOf("answer 11"));
  });

  it("extends coverage to include every previously covered id", async () => {
    const { result } = await compactOnce();
    if (result.outcome.applied !== true) throw new Error("expected compaction to apply");
    const previous = result.outcome.record.coveredMessageIds;
    // Every id the old record covered is still covered — coverage never regresses.
    for (const id of coveredIds(regressedConversation().messages)) {
      expect(previous).toContain(id);
    }
  });

  it("covers strictly more than before, so progress is monotonic", async () => {
    const { messages } = regressedConversation();
    const { result } = await compactOnce();
    if (result.outcome.applied !== true) throw new Error("expected compaction to apply");
    expect(result.outcome.record.coveredMessageIds.length).toBeGreaterThan(
      coveredIds(messages).length,
    );
  });

  it("bumps the generation", async () => {
    const { result } = await compactOnce();
    if (result.outcome.applied !== true) throw new Error("expected compaction to apply");
    expect(result.outcome.record.generation).toBe(2);
  });

  it("leaves one summary where the covered prefix plus growth used to be", async () => {
    const { messages } = regressedConversation();
    const { result } = await compactOnce();
    // Covered prefix (9) plus growth (10) replaced by exactly one summary.
    const removed = COVERED_COUNT + (CUT_INDEX - GROWTH_START + 1);
    expect(result.messages).toHaveLength(messages.length - removed + 1);
    expect(JSON.stringify(result.messages)).toContain("tbai-compaction:");
  });
});

// ─── repeated forward progress across generations ──────────────────────────

describe("forward progress survives many generations", () => {
  it("compacts generation after generation as the conversation keeps growing", async () => {
    const base = regressedConversation();
    let messages = base.messages;
    let tokens = base.measuredTokens;
    let existing = recordFor(1, messages);
    const generations: number[] = [];

    // Each round appends two more turns, so there is always fresh growth.
    for (let round = 0; round < 4; round += 1) {
      const newMessages = [
        ...messages,
        user(`x${round}`, `follow-up ${round}`),
        assistant(`y${round}`, `follow-up reply ${round}`),
        user(`live${round}`, `the current question ${round}`),
      ];
      const newTokens = [...tokens, SETTLED_MESSAGE_TOKENS, SETTLED_MESSAGE_TOKENS, SMALL_MESSAGE_TOKENS];

      const outcome = await maybeCompact({
        conversationId: "conv-regressed",
        messages: newMessages,
        measuredTokens: newTokens,
        currentTurnIds: [`live${round}`],
        measuredTotalTokens: newTokens.reduce((a, b) => a + b, 0),
        fixedOverheadTokens: 0,
        usableInputTokens: USABLE_INPUT_TOKENS,
        existing,
        compactionLatched: true,
        coveredMessageIds: existing.coveredMessageIds,
        priorSummaryText: existing.summaryText,
        summarizerInputTokens: SUMMARISER_CAPACITY,
        policy: DEFAULT_COMPACTION_POLICY,
        summarize: async () => ({
          ok: true as const,
          summaryText: `SUMMARY generation ${existing.generation + 1}.`,
          summaryTokens: PRIOR_SUMMARY_TOKENS,
          summarizedBy: "test/model",
          origin: "model_generated_summary" as const,
        }),
        persist: (r: CompactionRecord) => r,
        nextCompactionId: (generation: number) => `cmp_${generation}`,
        now: () => 1_700_000_000_000,
      });

      if (outcome.outcome.applied !== true) {
        throw new Error(`round ${round} refused: ${outcome.outcome.reason}`);
      }
      generations.push(outcome.outcome.record.generation);

      // The client re-posts its full physical history every turn, so the next
      // round starts from the original list carrying the new record.
      existing = outcome.outcome.record;
      messages = newMessages;
      tokens = newTokens;
    }

    // Four successive compactions, each one generation higher than the last. No
    // "already compacted" flag can stop the fifth.
    expect(generations).toEqual([2, 3, 4, 5]);
    expect(existing.generation).toBe(5);
  });

  it("the compacted view stays stable when a later turn re-applies the record", async () => {
    // Persistence: a turn that does NOT compact must still see the summary, or the
    // conversation would revert to full history and regrow without bound.
    const { messages } = regressedConversation();
    const record = recordFor(1, messages);

    const first = applyExistingCompaction({ messages, record });
    expect(first.applied).toBe(true);

    // Deterministic across reloads: applying the same record twice is byte-identical.
    const second = applyExistingCompaction({ messages, record });
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages));
  });
});
