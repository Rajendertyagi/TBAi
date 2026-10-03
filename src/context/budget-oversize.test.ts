/**
 * F-A — the confirmed Phase 2 budget defect, permanently regression-tested.
 *
 * ## The defect
 *
 * `decideBudget` returned a `"reduce"` verdict that no consumer acted on: every
 * consumer branched on `"reject"` alone. A verdict of `"reduce"` therefore meant
 * "send it anyway" while claiming a reduction had happened. Measured with the real
 * seam before the fix: an assistant-text-only conversation of ~80 000 characters
 * was estimated at 37 466 tokens against a usable budget of 23 232 — **61% over** —
 * with nothing reducible, and it was sent to the provider, which then failed
 * generically instead of with an actionable `CONTEXT_OVERFLOW`.
 *
 * ## What these tests are for
 *
 * Every assertion states the EXACT verdict. A test shaped like
 * `expect(verdict).not.toBe("accept")` passes for `"reduce"` and therefore proves
 * nothing; that pattern was itself part of the defect and is banned here. Each test
 * also asserts what happened to the messages, because "not accept" and "not sent"
 * are the property that actually matters.
 *
 * `pruneStaleMessages` is not involved in any of this and is not exercised here —
 * it is lifecycle repair and is unchanged by this work.
 */

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import {
  assembleContext,
  computeBudget,
  decideBudget,
  resolveContextLimit,
  selectModelOption,
} from "./index";
import { describeCompactionOutcome } from "./compaction/outcome";
import { describeToolResultReduction } from "./reduce";
import { logger } from "../lib/logger";
import type { ProviderConfig } from "../types";
import type { CompactionSeam } from "./types";
import type { CompactionRecord } from "./compaction/contract";

/**
 * Two windows, because the reduction tests need headroom a single figure cannot
 * give. A reduced tool result is capped at 64 KiB, which is ~21 845 estimated
 * tokens — more than the whole Layer C allowance at a 32 000-token window, so no
 * reduction test can pass there.
 */
function providerWithWindow(contextWindow: number): ProviderConfig {
  return {
    id: "fa",
    name: "FA",
    type: "anthropic",
    model: "claude-test",
    models: [
      {
        id: "claude-test",
        contextWindow,
        contextWindowSource: "provider_reported",
        maxOutputTokens: 1024,
      },
    ],
  } as unknown as ProviderConfig;
}

const SMALL_WINDOW = providerWithWindow(32_000);
const LARGE_WINDOW = providerWithWindow(128_000);

/** The usable budget for a provider, derived rather than hardcoded. */
function usableBudget(provider: ProviderConfig): number {
  const model = selectModelOption(provider.models, "claude-test");
  const limit = resolveContextLimit({ providerType: "anthropic", modelId: "claude-test", model });
  return computeBudget({ limit, modelOutputTokens: model?.maxOutputTokens }).usableInputTokens!;
}

/** `count` assistant text messages totalling `totalChars`, no tool parts anywhere. */
function assistantText(totalChars: number): UIMessage[] {
  const messages: UIMessage[] = [];
  const chunk = 3_000;
  let made = 0;
  let i = 0;
  while (made < totalChars) {
    const text = "A".repeat(Math.min(chunk, totalChars - made));
    messages.push({
      id: `a${i}`,
      role: "assistant",
      parts: [{ type: "text", state: "done", text }],
    } as unknown as UIMessage);
    made += text.length;
    i += 1;
  }
  return messages;
}

/** The live user turn. Always last, so the current turn is identifiable. */
function question(): UIMessage {
  return { id: "live", role: "user", parts: [{ type: "text", text: "THE CURRENT QUESTION" }] } as unknown as UIMessage;
}

/** One assistant turn with a single oversized tool result (a string output, as `reduce.ts` requires). */
function toolTurn(toolChars: number): UIMessage {
  return {
    id: "tool-turn",
    role: "assistant",
    parts: [
      { type: "text", state: "done", text: "Reading the file." },
      {
        type: "tool-read_file",
        toolName: "read_file",
        toolCallId: "tc0",
        state: "output-available",
        input: { path: "f" },
        output: "Z".repeat(toolChars),
      },
    ],
  } as unknown as UIMessage;
}

async function assemble(messages: UIMessage[], provider: ProviderConfig, compaction?: CompactionSeam) {
  return assembleContext({
    conversationId: "fa-regression",
    submittedMessages: messages,
    runId: "fa-regression-run",
    provider,
    modelId: "claude-test",
    systemPrompt: "SYSTEM RULES THAT MUST SURVIVE",
    toolSignal: new AbortController().signal,
    ...(compaction ? { compaction } : {}),
  });
}

describe("F-A: the assistant-text-only over-budget conversation", () => {
  it("REJECTS it — before the fix this shipped 61% over budget", async () => {
    const usable = usableBudget(SMALL_WINDOW);
    const result = await assemble([...assistantText(80_000), question()], SMALL_WINDOW);
    const { estimate, decision, reduction } = result.context.provenance;

    // The preconditions that made this a defect, asserted so a future estimator
    // change cannot make this test pass for the wrong reason: genuinely over the
    // point estimate, genuinely uncertain at the dense end, genuinely unshrinkable.
    expect(estimate.estimatedTokens).toBeGreaterThan(usable);
    expect(estimate.range.low).toBeLessThanOrEqual(usable);
    expect(reduction).toBeNull();

    // The verdict, exactly. `not.toBe("accept")` would pass for the dead
    // `"reduce"` and prove nothing.
    expect(decision.action).toBe("reject");
    if (decision.action !== "reject") throw new Error("expected a reject verdict");
    expect(decision.reason).toBe("reduction_exhausted");
    expect(decision.overBy).toBeGreaterThan(0);

    // Nothing sent, so the provider is never asked to fail opaquely.
    expect(result.context.modelMessages).toHaveLength(0);
  });

  it("names the cause: tool reduction found nothing and compaction was never offered", async () => {
    const result = await assemble([...assistantText(80_000), question()], SMALL_WINDOW);
    expect(result.context.provenance.decision.reduction).toEqual({
      toolResults: { kind: "exhausted", reason: "no_reducible_content" },
      compaction: { kind: "exhausted", reason: "disabled" },
    });
    // The same facts in diagnostics, so a production log explains the rejection.
    expect(result.diagnostics.toolResultReduction).toBe("exhausted");
    expect(result.diagnostics.toolResultReductionReason).toBe("no_reducible_content");
    expect(result.diagnostics.compactionReductionReason).toBe("disabled");
    expect(result.diagnostics.reductionWithheld).toBe(false);
  });
});

describe("F-A: the reduction-state matrix, through the real seam", () => {
  it("ACCEPTS an ordinary small conversation", async () => {
    const result = await assemble([...assistantText(2_000), question()], SMALL_WINDOW);
    expect(result.context.provenance.decision.action).toBe("accept");
    expect(result.context.modelMessages.length).toBeGreaterThan(0);
  });

  it("ACCEPTS once tool-result reduction has brought the request inside the budget", async () => {
    // The reduction genuinely runs: a 300 000-char result is truncated to the cap.
    const usable = usableBudget(LARGE_WINDOW);
    const result = await assemble([...assistantText(2_000), toolTurn(300_000), question()], LARGE_WINDOW);
    const { estimate, decision, reduction } = result.context.provenance;

    expect(reduction?.reducedParts).toBeGreaterThan(0);
    expect(estimate.estimatedTokens).toBeLessThanOrEqual(usable);
    expect(decision.action).toBe("accept");
    expect(result.context.modelMessages.length).toBeGreaterThan(0);
  });

  it("REJECTS when tool-result reduction APPLIED and the request is still over (Case B)", async () => {
    // Reduction succeeded and was not enough. Nothing safe is left to try, so the
    // request must not be sent hoping the provider's count lands lower.
    const usable = usableBudget(LARGE_WINDOW);
    const result = await assemble([...assistantText(300_000), toolTurn(300_000), question()], LARGE_WINDOW);
    const { estimate, decision, reduction } = result.context.provenance;

    expect(reduction?.reducedParts).toBeGreaterThan(0);
    expect(estimate.estimatedTokens).toBeGreaterThan(usable);
    expect(estimate.range.low).toBeLessThanOrEqual(usable);

    expect(decision.action).toBe("reject");
    if (decision.action !== "reject") throw new Error("expected a reject verdict");
    expect(decision.reason).toBe("reduction_exhausted");
    expect(decision.reduction.toolResults).toEqual({ kind: "exhausted", reason: "applied" });
    expect(result.context.modelMessages).toHaveLength(0);
  });

  it("REJECTS when every applicable mechanism is exhausted (Case C)", async () => {
    // Over at BOTH ends of the band: a certain over-limit, not a judgement call.
    const result = await assemble([...assistantText(120_000), question()], SMALL_WINDOW);
    expect(result.context.provenance.estimate.range.low).toBeGreaterThan(usableBudget(SMALL_WINDOW));

    const decision = result.context.provenance.decision;
    expect(decision.action).toBe("reject");
    if (decision.action !== "reject") throw new Error("expected a reject verdict");
    expect(decision.reason).toBe("over_limit");
    expect(result.context.modelMessages).toHaveLength(0);
  });
});

describe("F-A: the compaction error is contained AND recorded", () => {
  const policy = {
    triggerFraction: 0.8,
    releaseFraction: 0.6,
    minRetainedTail: 6,
    maxSummaryTokens: 1_500,
    summaryOutputReservation: 2_048,
  } as const;

  /** A durable record that is latched and covers the first message. */
  function latchedRecord(): CompactionRecord {
    return {
      compactionId: "c1",
      conversationId: "fa-regression",
      spanStartIndex: 0,
      spanEndIndex: 0,
      coveredMessageIds: ["a0"],
      spanFingerprint: "fingerprint-for-test",
      summaryText: "Earlier summary.",
      summaryTokens: 5,
      origin: "model_generated_summary",
      summarizedBy: "test",
      generation: 1,
      latched: true,
      createdAt: 0,
    };
  }

  /**
   * A seam whose own latch store fails.
   *
   * A summariser failure is NOT enough to reach the outer boundary: `summarizeSpan`
   * contains its own errors and reports `summarize_failed`, which is correct and
   * observable. The outer boundary is for failures the inner stages do not own —
   * this one stands in for that class.
   */
  function failingLatchSeam(): CompactionSeam {
    return {
      policy,
      existingRecord: latchedRecord(),
      persist: (record) => record,
      summarizerModel: {} as never,
      summarizedBy: "test",
      nextCompactionId: () => "c2",
      now: () => 0,
      timeoutMs: 1_000,
      releaseLatch: () => {
        throw new TypeError("latch store unavailable");
      },
    };
  }

  it("logs compaction_error with an error type instead of discarding it", async () => {
    const since = logger.getRecentEntries().at(-1)?.seq ?? 0;
    const result = await assemble([...assistantText(6_000), question()], SMALL_WINDOW, failingLatchSeam());
    const entries = logger.getRecentEntries(since).filter((e) => e.event === "compaction_error");

    // Under a bare `catch {}` this entry could not exist at all.
    expect(entries.length).toBe(1);
    expect(entries[0]!.level).toBe("warn");
    expect(entries[0]!.scope).toBe("context");
    expect(entries[0]!.errorType).toBe("TypeError");

    // Containment is unchanged: the conversation still assembles and still answers.
    expect(result.context.provenance.compaction?.reason).toBe("compaction_error");
    expect(result.context.modelMessages.length).toBeGreaterThan(0);
  });

  it("records the error TYPE only — never the message, the stack, or any content", async () => {
    const since = logger.getRecentEntries().at(-1)?.seq ?? 0;
    await assemble([...assistantText(6_000), question()], SMALL_WINDOW, failingLatchSeam());
    const entry = logger.getRecentEntries(since).find((e) => e.event === "compaction_error");
    if (!entry) throw new Error("expected a compaction_error entry");

    // A summariser or storage error can quote the span it was handed, so the
    // message must never be logged. This is the boundary the fix must not cross.
    expect(entry.message).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain("latch store unavailable");
    expect(entry.stack).toBeUndefined();
  });

  it("reports a summariser failure as withheld rather than as a silent success", async () => {
    const seam: CompactionSeam = {
      policy,
      existingRecord: undefined,
      persist: (record) => record,
      summarizerModel: {} as never,
      summarizedBy: "test",
      nextCompactionId: () => "c3",
      now: () => 0,
      timeoutMs: 1_000,
    };
    const result = await assemble([...assistantText(80_000), question()], SMALL_WINDOW, seam);
    expect(result.context.provenance.compaction?.reason).toMatch(/^summarize_failed:/);
    // Failed after being offered is Case D: sent, and the withhold is visible.
    expect(result.context.provenance.decision.reduction.compaction).toEqual({ kind: "withheld", reason: "failed" });
    expect(result.diagnostics.reductionWithheld).toBe(true);
  });
});

describe("the reduction state is modelled, not guessed", () => {
  it("maps every reachable compaction reason", () => {
    const cases = [
      ["compacted", "exhausted", "applied"],
      ["below_trigger", "withheld", "trigger_not_reached"],
      ["above_release_but_within_hysteresis", "withheld", "hysteresis"],
      ["no_compactable_span", "exhausted", "no_compactable_span"],
      ["span_too_small_to_compact", "exhausted", "span_too_small_to_compact"],
      ["summary_would_not_reclaim_enough", "exhausted", "summary_would_not_reclaim_enough"],
      ["span_exceeds_summarizer_capacity", "exhausted", "span_exceeds_summarizer_capacity"],
      ["would_still_exceed_budget", "exhausted", "would_still_exceed_budget"],
      ["no_conversation", "withheld", "not_eligible"],
      ["not_attempted", "exhausted", "disabled"],
      ["persist_failed", "withheld", "failed"],
      ["lost_race_span_not_locatable", "withheld", "failed"],
      ["compaction_error", "withheld", "failed"],
      ["summarize_failed:timeout", "withheld", "failed"],
    ] as const;

    for (const [reason, kind, expected] of cases) {
      const outcome = describeCompactionOutcome({
        applied: reason === "compacted",
        reason,
        generation: 0,
        spanLength: 0,
        spanFingerprint: null,
        summaryTokens: 0,
        reclaimedTokens: 0,
        origin: null,
        summarizedBy: null,
      });
      expect([reason, outcome.kind, outcome.reason]).toEqual([reason, kind, expected]);
    }
  });

  it("decodes a re-applied record's embedded reason instead of trusting the wrapper", () => {
    expect(
      describeCompactionOutcome({
        applied: false,
        reason: "record_applied_no_new_compaction:above_release_but_within_hysteresis",
        generation: 1,
        spanLength: 4,
        spanFingerprint: "fp",
        summaryTokens: 10,
        reclaimedTokens: 0,
        origin: "model_generated_summary",
        summarizedBy: "m",
      }),
    ).toEqual({ kind: "withheld", reason: "hysteresis" });
  });

  it("falls back to `unknown` rather than dropping an unrecognised reason", () => {
    expect(
      describeCompactionOutcome({
        applied: false,
        reason: "a_reason_from_a_future_build",
        generation: 0,
        spanLength: 0,
        spanFingerprint: null,
        summaryTokens: 0,
        reclaimedTokens: 0,
        origin: null,
        summarizedBy: null,
      }),
    ).toEqual({ kind: "exhausted", reason: "unknown" });
  });

  it("treats both tool-reduction outcomes as exhausted, with distinct reasons", () => {
    // `reduceToolResults` always runs and always caps in one pass, so both cases
    // mean "nothing further from this mechanism".
    expect(
      describeToolResultReduction({
        reducedParts: 0,
        removedChars: 0,
        droppedParts: 0,
        reducedReasoningParts: 0,
        removedReasoningChars: 0,
      }),
    ).toEqual({
      kind: "exhausted",
      reason: "no_reducible_content",
    });
    expect(
      describeToolResultReduction({
        reducedParts: 2,
        removedChars: 100,
        droppedParts: 0,
        reducedReasoningParts: 0,
        removedReasoningChars: 0,
      }),
    ).toEqual({
      kind: "exhausted",
      reason: "applied",
    });
    // Reasoning-only reduction also reads as "applied".
    expect(
      describeToolResultReduction({
        reducedParts: 0,
        removedChars: 0,
        droppedParts: 0,
        reducedReasoningParts: 3,
        removedReasoningChars: 5000,
      }),
    ).toEqual({
      kind: "exhausted",
      reason: "applied",
    });
  });
});

describe("no dead verdicts remain", () => {
  it("BudgetDecision has exactly two variants, and both are reachable", () => {
    const budget = computeBudget({
      limit: resolveContextLimit({
        providerType: "anthropic",
        modelId: "claude-test",
        model: selectModelOption(LARGE_WINDOW.models, "claude-test"),
      }),
      modelOutputTokens: 1024,
    });
    const usable = budget.usableInputTokens!;
    const banded = (point: number, low: number, high: number) => ({
      estimatedTokens: point,
      estimatedChars: 0,
      charsPerToken: 3,
      range: { low, high },
      byCategory: {} as never,
      charsByCategory: {} as never,
    });
    const exhausted = {
      toolResults: { kind: "exhausted", reason: "no_reducible_content" },
      compaction: { kind: "exhausted", reason: "disabled" },
    } as const;

    const verdicts = [
      // Branch 1: fits at the pessimistic end.
      decideBudget({ estimate: banded(usable - 1, usable - 2, usable - 1), budget, reduction: exhausted }),
      // Branch 2: the band straddles and the point estimate FITS. This is the
      // branch the old `"reduce"` verdict came from, so it must be pinned here —
      // otherwise a reintroduced dead verdict hides behind branch 1.
      decideBudget({ estimate: banded(usable - 10, usable - 100, usable + 5_000), budget, reduction: exhausted }),
      // Branch 3: the band straddles and the point estimate is OVER.
      decideBudget({ estimate: banded(usable + 1, usable, usable + 9), budget, reduction: exhausted }),
      // Branch 4: over at both ends.
      decideBudget({ estimate: banded(usable + 50_000, usable + 40_000, usable + 60_000), budget, reduction: exhausted }),
    ];

    // Compile-time exhaustiveness is the strongest form of this assertion; this is
    // its runtime equivalent, and it fails loudly if `"reduce"` ever returns —
    // including from the straddle branch it originally came from.
    expect([...new Set(verdicts.map((v) => v.action))].sort()).toEqual(["accept", "reject"]);
    // Every straddle verdict is pinned exactly, so no branch can be a silent send.
    expect(verdicts[1]!.action).toBe("accept");
    expect(verdicts[2]!.action).toBe("reject");
    // Both verdicts carry the reduction record, so no state is unobservable.
    for (const verdict of verdicts) expect(verdict.reduction).toEqual(exhausted);
  });
});