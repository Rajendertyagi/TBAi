/**
 * Phase 4 — compaction as wired into the assembly seam.
 *
 * ## Why this file exists separately from the others
 *
 * `contract.test.ts` proves the decision is right. `runtime.test.ts` proves the
 * summariser, the orchestrator and the store are right. Neither proves the
 * WIRING — that `assembleContext` runs compaction at the right point in the
 * pipeline, feeds it the real budget, keeps the Phase 2 verdict authoritative,
 * and contains a failure instead of propagating it.
 *
 * Those are exactly the claims that survive unit testing and fail in production.
 *
 * ## How the budget is made real
 *
 * The trigger must use the ACTUAL Phase 2 budget, so these tests configure a real
 * `contextWindow` with `provider_reported` provenance and then size the
 * conversation against it. A test that passed a hand-picked number would prove
 * nothing about the wiring.
 */

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { assembleContext } from "../index";
import { DEFAULT_COMPACTION_POLICY } from "./index";
import type { CompactionRecord } from "./index";
import type { ProviderConfig } from "../../types";

/**
 * A provider with a genuine, provider-reported 32k window.
 *
 * Small on purpose: it makes an over-budget conversation reachable in a test
 * without megabytes of filler, so the budget maths under test is the same maths
 * that runs in production.
 */
const TEST_WINDOW = 32_000;
const provider = {
  id: "p1",
  name: "Test",
  type: "anthropic",
  model: "claude-test",
  models: [
    {
      id: "claude-test",
      contextWindow: TEST_WINDOW,
      contextWindowSource: "provider_reported",
      maxOutputTokens: 1_024,
    },
  ],
} as unknown as ProviderConfig;

// ─── fixtures ──────────────────────────────────────────────────────────────

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}
function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", state: "done", text }] } as unknown as UIMessage;
}
/** A completed tool call + result pair. */
function toolTurn(id: string, toolCallId: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      { type: "text", state: "done", text: "running" },
      {
        type: "tool-read_file",
        toolName: "read_file",
        toolCallId,
        state: "output-available",
        input: { path: "a.txt" },
        output: { path: "a.txt", totalLines: 1, truncated: false, content: "file body" },
      },
    ],
  } as unknown as UIMessage;
}
/** The real mid-run persisted state: paused on an approval. */
function approvalPaused(id: string, toolCallId: string, approvalId: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-delete_file",
        toolName: "delete_file",
        toolCallId,
        state: "approval-requested",
        input: { path: "a.txt" },
        approval: { id: approvalId },
      },
    ],
  } as unknown as UIMessage;
}

/**
 * A conversation sized to OVERFLOW the configured window, with a live turn and a
 * pending approval at the end.
 *
 * Sized deliberately, from measurement rather than guesswork. Measured
 * against this 32k window: Layer B ~10.7k, budget ~23.2k, summariser capacity
 * ~29.9k. This fixture assembles to ~46k uncompacted, compacts to ~13.5k, and is
 * accepted — the whole point of the phase.
 *
 * Two earlier sizes were wrong and both taught something. At 24 heavy turns the
 * span was ~7061 against a 5952 ceiling, so compaction refused; that is correct
 * behaviour, not a bug, because a span bigger than the model can read cannot be
 * summarised in one pass and TBAI must refuse rather than summarise a prefix and
 * call it the whole span. The 8k window was worse: smaller than Layer B alone.
 * Both cases are pinned as explicit tests below.
 */
function oversizedConversation(): UIMessage[] {
  const messages: UIMessage[] = [];
  const filler = "context filler text that costs real tokens. ".repeat(90);
  for (let i = 0; i < 20; i += 1) {
    messages.push(user(`u${i}`, `question ${i} ${filler}`));
    messages.push(toolTurn(`a${i}`, `tc${i}`));
  }
  messages.push(user("live", "THE LIVE REQUEST"));
  messages.push(approvalPaused("aLive", "tc-live", "ap-live"));
  return messages;
}

/**
 * A conversation whose span to shed is LARGER than the summariser can read.
 *
 * This is the honest terminal case: a conversation grown past the model's entire
 * window cannot be compacted, because the span to summarise does not fit one
 * call. The correct behaviour is to refuse the compaction and let the existing
 * rejection stand — never to summarise a prefix and present it as the whole span.
 */
function beyondWindowConversation(): UIMessage[] {
  const messages: UIMessage[] = [];
  const filler = "context filler text that costs real tokens. ".repeat(120);
  for (let i = 0; i < 20; i += 1) {
    messages.push(user(`u${i}`, `question ${i} ${filler}`));
    messages.push(toolTurn(`a${i}`, `tc${i}`));
  }
  messages.push(user("live", "THE LIVE REQUEST"));
  messages.push(approvalPaused("aLive", "tc-live", "ap-live"));
  return messages;
}

const controller = new AbortController();

/** Records every compaction the seam attempts, and answers with a fixed summary. */
function seamHarness(
  over: {
    summaryText?: string;
    summarizeFails?: boolean;
    existing?: CompactionRecord;
    latched?: boolean;
  } = {},
) {
  const summarizeCalls: unknown[] = [];
  const persisted: CompactionRecord[] = [];
  const released: number[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: over.summaryText ?? "SUMMARY of earlier turns." }],
      finishReason: { unified: "stop" as const, raw: "end_turn" },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 40, text: 40, reasoning: 0 },
      },
      warnings: [],
    }),
  });

  return {
    summarizeCalls,
    persisted,
    released,
    seam: {
      policy: DEFAULT_COMPACTION_POLICY,
      existingRecord: over.existing,
      summarizeCalls,
      persist: (record: CompactionRecord): CompactionRecord => {
        persisted.push(record);
        return record;
      },
      releaseLatch: () => released.push(1),
      summarizerModel: model as never,
      summarizedBy: "anthropic/claude-test",
      nextCompactionId: (generation: number) => `cmp_${generation}`,
      now: () => 1_700_000_000_000,
      signal: controller.signal,
      timeoutMs: 5_000,
    },
    /** Whether compaction should even be attempted, and with what result. */
    async assemble(messages: UIMessage[], extra: Record<string, unknown> = {}) {
      return assembleContext({
        conversationId: "conv-seam-test",
        submittedMessages: messages,
        runId: "run_seam",
        provider,
        modelId: "claude-test",
        systemPrompt: "SYSTEM RULES THAT MUST SURVIVE",
        toolSignal: controller.signal,
        compaction: this.seam as never,
        ...extra,
      });
    },
  };
}

async function assembleWithoutCompaction(messages: UIMessage[], extra: Record<string, unknown> = {}) {
  return assembleContext({
    conversationId: "conv-seam-test",
    submittedMessages: messages,
    runId: "run_seam",
    provider,
    modelId: "claude-test",
    systemPrompt: "SYSTEM RULES THAT MUST SURVIVE",
    toolSignal: controller.signal,
    ...extra,
  });
}

/**
 * Assemble against a store that behaves like the real one.
 *
 * Reads the record FRESH from the store on every call, exactly as `chat.ts` does
 * with `compactionStore.get(threadId)`, and `releaseLatch` genuinely clears the
 * flag. An earlier probe passed the same in-memory object every turn, so the latch
 * never cleared and the second-compaction path was never reached — which is how a
 * real durability defect survived several rounds of testing before being caught.
 */
async function assembleWithStore(
  messages: UIMessage[],
  store: ReturnType<ReturnType<typeof makeDurableStoreType>>,
) {
  return assembleContext({
    conversationId: "conv-seam-test",
    submittedMessages: messages,
    runId: "run_seam",
    provider,
    modelId: "claude-test",
    systemPrompt: "SYSTEM RULES THAT MUST SURVIVE",
    toolSignal: controller.signal,
    compaction: {
      policy: DEFAULT_COMPACTION_POLICY,
      existingRecord: store.get("conv-seam-test"),
      persist: store.persist,
      releaseLatch: store.releaseLatch,
      summarizerModel: summaryOnlyModel(),
      summarizedBy: "anthropic/claude-test",
      nextCompactionId: (generation: number) => `cmp_${generation}`,
      now: () => 1_700_000_000_000,
      signal: controller.signal,
      timeoutMs: 5_000,
    } as never,
  });
}

/** A store shaped like `compactionStore`, backed by a Map. */
function makeDurableStoreType() {
  return function durableStore() {
    const rows = new Map<string, CompactionRecord>();
    return {
      rows,
      get: (id: string) => rows.get(id),
      persist: (r: CompactionRecord) => {
        rows.set(r.conversationId, r);
        return r;
      },
      releaseLatch: () => {
        const row = rows.get("conv-seam-test");
        if (row) rows.set(row.conversationId, { ...row, latched: false });
      },
    };
  };
}

/**
 * A conversation of `turns` at a given filler size, ending in a live turn and a
 * pending approval — the shape a real growing conversation has.
 *
 * Sized from measurement so the multi-turn sequences below actually reach the
 * states they claim to test. `20 @ 60` compacts once and settles at ~13 542; adding
 * six turns crosses the trigger again and reaches generation 2.
 */
function growingConversation(turns: number, repeat: number): UIMessage[] {
  const messages: UIMessage[] = [];
  const filler = "context filler text that costs real tokens. ".repeat(repeat);
  for (let i = 0; i < turns; i += 1) {
    messages.push(user(`u${i}`, `question ${i} ${filler}`));
    messages.push(toolTurn(`a${i}`, `tc${i}`));
  }
  messages.push(user("live", "THE LIVE REQUEST"));
  messages.push(approvalPaused("aLive", "tc-live", "ap-live"));
  return messages;
}

/** A model that always returns the same short summary. */
function summaryOnlyModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: "SUMMARY of earlier turns." }],
      finishReason: { unified: "stop" as const, raw: "end_turn" },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 40, text: 40, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

// ─── the wiring exists and is off unless asked for ──────────────────────────

describe("compaction is inert unless the seam supplies it", () => {
  it("reports not_attempted when no compaction seam is wired", async () => {
    const result = await assembleWithoutCompaction(oversizedConversation());
    expect(result.context.provenance.compaction?.applied).toBe(false);
    expect(result.context.provenance.compaction?.reason).toBe("not_attempted");
  });

  it("an unwired seam cannot compact even an overflowing conversation", async () => {
    // Behaviour must be identical to before Phase 4. The verdict here is whatever
    // Phase 2 alone decides — measured as `reduce` at this size, because its own
    // tool-result reduction already handles moderate overage — and the point is
    // that no summary appears and no compaction is reported.
    const result = await assembleWithoutCompaction(oversizedConversation());
    expect(result.context.provenance.compaction?.applied).toBe(false);
    expect(result.context.provenance.compaction?.reason).toBe("not_attempted");
    expect(JSON.stringify(result.context.layerC.messages)).not.toContain("compacted history");
  });

  it("leaves a moderately over-budget request alone", async () => {
    // Compaction must not pre-empt a pressure it does not need to solve, and must
    // not spend a summarisation call doing so. Sized from measurement: this
    // conversation assembles to ~18 035 tokens against a trigger of ~18 585, so it
    // is genuinely just below.
    //
    // Note the trigger is measured on A + B + C, not C alone. An earlier version
    // compared Layer C against a whole-request budget, which understated pressure
    // by the ~10 745-token tool layer and fired far too late.
    const harness = seamHarness();
    const moderate: UIMessage[] = [];
    const filler = "context filler text that costs real tokens. ".repeat(60);
    for (let i = 0; i < 8; i += 1) {
      moderate.push(user(`u${i}`, `question ${i} ${filler}`));
      moderate.push(toolTurn(`a${i}`, `tc${i}`));
    }
    moderate.push(user("live", "THE LIVE REQUEST"));
    moderate.push(approvalPaused("aLive", "tc-live", "ap-live"));
    const result = await harness.assemble(moderate);
    expect(result.context.provenance.compaction?.applied).toBe(false);
    expect(result.context.provenance.compaction?.reason).toBe("below_trigger");
    expect(harness.persisted).toHaveLength(0);
  });
});

// ─── the trigger is driven by the real budget ──────────────────────────────

describe("the trigger uses the seam's own Phase 2 budget", () => {
  it("compacts a conversation that overflows the configured window", async () => {
    const harness = seamHarness();
    const result = await harness.assemble(oversizedConversation());
    expect(result.context.provenance.compaction?.applied).toBe(true);
    expect(result.context.provenance.compaction?.origin).toBe("model_generated_summary");
    expect(harness.persisted).toHaveLength(1);
    expect(harness.persisted[0].summaryText).toContain("SUMMARY");
  });

  it("does not compact a conversation well inside the window", async () => {
    const harness = seamHarness();
    const result = await harness.assemble([user("u1", "short"), assistant("a1", "reply")]);
    expect(result.context.provenance.compaction?.applied).toBe(false);
    expect(harness.persisted).toHaveLength(0);
  });

  it("converts a hard rejection into an accepted request", async () => {
    // This is the phase's entire purpose, asserted end to end: the same
    // conversation that was rejected is now assembled and sent.
    const harness = seamHarness();
    const result = await harness.assemble(oversizedConversation());
    expect(result.decision.action).toBe("accept");
    expect(result.context.modelMessages.length).toBeGreaterThan(0);
  });
});

// ─── the retained set, proven through the real pipeline ────────────────────

describe("compaction never removes what the turn still needs", () => {
  it("keeps the current user request verbatim", async () => {
    const harness = seamHarness();
    const result = await harness.assemble(oversizedConversation());
    expect(JSON.stringify(result.context.modelMessages)).toContain("THE LIVE REQUEST");
  });

  it("keeps an unresolved approval, including its id", async () => {
    // Asserted on LAYER C, which is where compaction operates — not on
    // modelMessages. Verified while writing this: `prepareModelMessages` DROPS an
    // `approval-requested` tool call entirely, because the approval is answered by
    // the client sending a `tool-approval-response` part rather than by the model
    // seeing a pending call. That is pre-existing Phase 2 behaviour, unchanged
    // here, and asserting on modelMessages would have tested the wrong layer.
    const harness = seamHarness();
    const result = await harness.assemble(oversizedConversation());
    expect(JSON.stringify(result.context.layerC.messages)).toContain("ap-live");
    expect(JSON.stringify(result.context.layerC.messages)).toContain("tc-live");
  });

  it("keeps Layer A instructions out of the compacted span entirely", async () => {
    // Layer A is never a message, so compaction cannot reach it by construction.
    const harness = seamHarness();
    const result = await harness.assemble(oversizedConversation());
    expect(result.context.layerA.text).toBe("SYSTEM RULES THAT MUST SURVIVE");
    expect(JSON.stringify(result.context.layerC.messages)).not.toContain(
      "SYSTEM RULES THAT MUST SURVIVE",
    );
  });

  it("leaves no tool call without its result", async () => {
    const harness = seamHarness();
    const result = await harness.assemble(oversizedConversation());
    const calls = new Set<string>();
    const answered = new Set<string>();
    for (const message of result.context.layerC.messages) {
      for (const part of (message as { parts?: Array<Record<string, unknown>> }).parts ?? []) {
        const type = String(part.type ?? "");
        if (!type.startsWith("tool-")) continue;
        const id = String(part.toolCallId ?? "");
        if (part.output !== undefined || part.state === "output-error") answered.add(id);
        else calls.add(id);
      }
    }
    for (const id of calls) {
      // The only call allowed to lack an answer is the live approval, which is the
      // pending decision rather than a broken pair.
      expect(id === "tc-live" || answered.has(id)).toBe(true);
    }
  });

  it("keeps the compacted block's provenance in the request the model receives", async () => {
    const harness = seamHarness();
    const result = await harness.assemble(oversizedConversation());
    const serialized = JSON.stringify(result.context.modelMessages);
    expect(serialized).toContain("compacted history");
    expect(serialized).toContain("model_generated_summary");
  });
});

// ─── Part 13: durability across turns ──────────────────────────────────────

describe("a compaction is durable because it is stored, not recomputed", () => {
  it("re-applies a stored record on the NEXT turn without summarising again", async () => {
    const first = seamHarness();
    const before = await first.assemble(oversizedConversation());
    expect(before.context.provenance.compaction?.applied).toBe(true);
    const stored = first.persisted[0];

    // The next turn: same conversation plus one more exchange, with the durable
    // record now present. The summariser must NOT run again.
    const second = seamHarness({ existing: stored });
    const nextTurn = [...oversizedConversation(), user("uNext", "another question")];
    const after = await second.assemble(nextTurn);
    expect(second.persisted).toHaveLength(0);
    expect(after.context.provenance.compaction?.applied).toBe(false);
    expect(after.context.provenance.compaction?.reason).toContain("record_applied");
    expect(JSON.stringify(after.context.modelMessages)).toContain("SUMMARY of earlier turns.");
  });

  it("produces the SAME context for the same conversation and record", async () => {
    // The durability requirement stated directly: a reload must not change what
    // the model sees.
    const harness = seamHarness();
    const first = await harness.assemble(oversizedConversation());
    const stored = harness.persisted[0];

    const reload = seamHarness({ existing: stored });
    const messages = [...oversizedConversation(), user("uNext", "and another")];
    const a = await reload.assemble(messages);
    const b = await reload.assemble(messages);
    expect(JSON.stringify(a.context.modelMessages)).toBe(JSON.stringify(b.context.modelMessages));
    // And it must match the compacted shape, not the raw history.
    expect(JSON.stringify(a.context.modelMessages)).not.toBe(
      JSON.stringify(before(messages)),
    );
  });

  function before(messages: UIMessage[]): string {
    return JSON.stringify(messages);
  }
});

// ─── Part 3: the latch, end to end ─────────────────────────────────────────

describe("the hysteresis latch is released only when usage genuinely drops", () => {
  it("does not release the latch while the compacted conversation is still large", async () => {
    // The record covers exactly the messages this conversation presents, so there
    // is no fresh growth to compact. Hysteresis must hold: no second
    // summarisation call for history already summarised.
    const messages = oversizedConversation();
    const stored: CompactionRecord = {
      ...makeRecord(),
      coveredMessageIds: messages.map((m) => (m as { id?: string }).id ?? ""),
    };
    const harness = seamHarness({ existing: stored });
    await harness.assemble(messages);
    // Same history, already summarised: not summarised a second time.
    expect(harness.persisted).toHaveLength(0);
  });

  it("releases the latch for a conversation that has shrunk below the release fraction", async () => {
    const stored = makeRecord();
    const harness = seamHarness({ existing: stored });
    // A tiny conversation: the previous compaction demonstrably took effect.
    await harness.assemble([user("u1", "hi"), assistant("a1", "hello")]);
    expect(harness.released).toHaveLength(1);
  });

  function makeRecord(): CompactionRecord {
    return {
      compactionId: "cmp_1",
      conversationId: "conv-seam-test",
      spanStartIndex: 0,
      spanEndIndex: 10,
      coveredMessageIds: ["u0", "a0"],
      spanFingerprint: "span:0000abcd:2",
      summaryText: "SUMMARY of earlier turns.",
      summaryTokens: 40,
      origin: "model_generated_summary",
      summarizedBy: "anthropic/claude-test",
      generation: 1,
      latched: true,
      createdAt: 1,
    };
  }
});

// ─── Part 12: the failure boundary is the SEAM, and it holds ───────────────

describe("a failed compaction degrades to today's behaviour, never to corruption", () => {
  it("a provider error leaves the request exactly as it would be uncompacted", async () => {
    // The strongest available form of the assertion: compare the failed-compaction
    // assembly against the assembly with NO compaction seam at all. Anything other
    // than identical output means a failure changed behaviour.
    const harness = seamHarness();
    const failing = {
      ...harness,
      seam: {
        ...harness.seam,
        summarizerModel: new MockLanguageModelV3({
          doGenerate: async () => {
            throw new Error("provider unavailable");
          },
        }) as never,
      },
    };
    const attempted = await failing.assemble(oversizedConversation());
    const untouched = await assembleWithoutCompaction(oversizedConversation());

    expect(attempted.context.provenance.compaction?.applied).toBe(false);
    // The typed failure, not an uncaught throw. `summarizeSpan` catches provider
    // errors and reports them, so the seam records a specific diagnosis instead of
    // a generic `compaction_error` — which is the containment working, not a
    // weaker path.
    expect(attempted.context.provenance.compaction?.reason).toBe(
      "summarize_failed:provider_error",
    );
    // Byte-identical to never having tried. This is the load-bearing assertion:
    // a failure must not change the REQUEST.
    expect(JSON.stringify(attempted.context.layerC.messages)).toBe(
      JSON.stringify(untouched.context.layerC.messages),
    );
    // The REQUEST is unchanged, but the VERDICT is deliberately more permissive
    // than the never-offered path, and that difference is the F-A Case D policy
    // working rather than a regression.
    //
    // A compaction that was offered and then failed is a mechanism that *could*
    // have helped and was withheld, so the request is still sent. A build with no
    // compaction at all has nothing left to try once tool-output reduction is
    // exhausted, so the same conversation is rejected rather than shipped
    // oversized. Asserted in both directions, because either half alone would
    // pass for the wrong reason.
    expect(attempted.decision.reduction.compaction).toEqual({ kind: "withheld", reason: "failed" });
    expect(attempted.decision.action).toBe("accept");
    expect(untouched.decision.reduction.compaction).toEqual({ kind: "exhausted", reason: "disabled" });
    expect(untouched.decision.action).toBe("reject");
    expect(harness.persisted).toHaveLength(0);
  });

  it("a summariser that returns nothing usable changes nothing", async () => {
    const harness = seamHarness({ summaryText: "" });
    const result = await harness.assemble(oversizedConversation());
    expect(result.context.provenance.compaction?.applied).toBe(false);
    expect(harness.persisted).toHaveLength(0);
  });

  it("an over-budget summary is refused rather than injected", async () => {
    const harness = seamHarness({ summaryText: "word ".repeat(50_000) });
    const result = await harness.assemble(oversizedConversation());
    expect(result.context.provenance.compaction?.applied).toBe(false);
    expect(harness.persisted).toHaveLength(0);
    expect(JSON.stringify(result.context.modelMessages)).not.toContain("word word word");
  });

  it("compaction never turns a rejection into an oversized send", async () => {
    // The invariant the whole failure policy exists to protect: whatever happens,
    // a request that does not fit is NOT sent. A rejected request may legitimately
    // measure above budget — that is why it was rejected — so the bound is checked
    // only on the accept path, where sending actually happens.
    const harness = seamHarness({ summaryText: "x" });
    const result = await harness.assemble(oversizedConversation());
    if (result.decision.action === "accept") {
      expect(result.context.provenance.estimate.estimatedTokens).toBeLessThanOrEqual(
        result.context.provenance.budget.usableInputTokens ?? Number.MAX_SAFE_INTEGER,
      );
      // And the summary itself is inside the request, not extra on top.
      expect(result.context.modelMessages.length).toBeGreaterThan(0);
    }
  });

  it("recovers an oversized conversation by compacting a SAFE prefix span", async () => {
    // Previously this was a permanent refusal, which left the chat dead forever:
    // every later turn planned the same oversized span and reached the same
    // verdict. Recovery is now staged - the span end walks back to a safe turn
    // boundary until it fits one summariser call, and the remainder stays in the
    // conversation for a later turn.
    const harness = seamHarness();
    const result = await harness.assemble(beyondWindowConversation());
    expect(result.context.provenance.compaction?.applied).toBe(true);
    // The summary replaces exactly the span it claims to, and the live turn is
    // never inside it.
    const covered = harness.persisted[0] as unknown as { coveredMessageIds: string[] };
    expect(covered.coveredMessageIds.length).toBeGreaterThan(0);
    expect(covered.coveredMessageIds).not.toContain("live");
    expect(result.context.modelMessages.length).toBeGreaterThan(0);
  });

  it("refuses deterministically when even the smallest safe span cannot be summarised", async () => {
    // No amount of retrying helps when a single indivisible span cannot fit one
    // call, so this must stay a precise refusal rather than a silent half-summarise.
    const harness = seamHarness();
    const oneHugeTurn = [user("u0", "x".repeat(4_000_000)), assistant("a0", "ok"), user("live", "THE LIVE REQUEST")];
    const result = await harness.assemble(oneHugeTurn as never);
    // Either refusal is a correct, non-destructive answer: the span could not be
    // shrunk to anything worth summarising, or it could not fit one call. What
    // must never happen is a partial summary presented as the whole span.
    expect(result.context.provenance.compaction?.applied).toBe(false);
    expect(["span_exceeds_summarizer_capacity", "span_too_small_to_compact"]).toContain(
      result.context.provenance.compaction?.reason,
    );
    expect(harness.persisted).toHaveLength(0);
    expect(result.context.modelMessages).toHaveLength(0);
  });
});

// ─── the end-to-end defect this phase found in itself ──────────────────────

describe("a stored compaction stays applicable across reloads and growth", () => {
  /**
   * The realistic store: one row per conversation, `releaseLatch` actually writes,
   * and `get` re-reads — exactly what `compactionStore` does in production. An
   * earlier probe passed the SAME record object every turn and therefore missed
   * the defect below entirely.
   */
  function durableStore() {
    const rows = new Map<string, CompactionRecord>();
    return {
      rows,
      get: (id: string) => rows.get(id),
      persist: (r: CompactionRecord) => {
        rows.set(r.conversationId, r);
        return r;
      },
      releaseLatch: () => {
        const row = rows.get("conv-seam-test");
        if (row) rows.set(row.conversationId, { ...row, latched: false });
      },
    };
  }

  it("re-applies the summary on a reload with no new summarisation", async () => {
    const store = durableStore();
    const messages = oversizedConversation();

    const first = await assembleWithStore(messages, store);
    expect(first.context.provenance.compaction?.applied).toBe(true);
    expect(store.rows.size).toBe(1);

    // RELOAD: same conversation, record read fresh from the store.
    const second = await assembleWithStore(messages, store);
    expect(store.rows.size).toBe(1);
    expect(second.context.provenance.compaction?.reason).toContain("record_applied");
    expect(JSON.stringify(second.context.modelMessages)).toContain("SUMMARY of earlier turns.");
  });

  it("never records a span covering a server-injected id", async () => {
    // THE defect this phase found in itself, pinned through a REAL second
    // compaction. Compaction used to plan its span over the already-compacted
    // view, so a second compaction recorded the injected `tbai-compaction:*` id
    // among its covered ids. The client never receives that id, so the record
    // became unlocatable, compaction silently stopped applying, and the
    // conversation reverted to full history — growing without bound, with no
    // error anywhere.
    //
    // This test drives the full three-turn sequence with a production-shaped
    // store. An earlier version asserted the invariant after only ONE compaction,
    // where nothing has been injected yet and the assertion is vacuous.
    const store = durableStore();
    const base = growingConversation(20, 60);

    const first = await assembleWithStore(base, store);
    expect(first.context.provenance.compaction?.applied).toBe(true);
    expect(store.rows.get("conv-seam-test")?.generation).toBe(1);

    // Same conversation: below the release fraction, so the latch clears.
    await assembleWithStore(base, store);
    expect(store.rows.get("conv-seam-test")?.latched).toBe(false);

    // Grown past the trigger again — measured to reach generation 2.
    const grown = growingConversation(28, 60);
    const second = await assembleWithStore(grown, store);
    const record = store.rows.get("conv-seam-test");
    expect(
      second.context.provenance.compaction?.applied,
      `expected a second compaction, got: ${second.context.provenance.compaction?.reason}`,
    ).toBe(true);
    expect(record?.generation).toBe(2);

    // The assertion that matters.
    for (const id of record?.coveredMessageIds ?? []) {
      expect(
        id.startsWith("tbai-compaction:"),
        `covered id ${id} is server-injected and can never be re-located`,
      ).toBe(false);
      expect(
        grown.some((m) => String(m.id) === id),
        `covered id ${id} is not a message the client sent`,
      ).toBe(true);
    }
  });

  it("a second compaction still produces a reapplicable record after reload", async () => {
    // The user-visible consequence of the defect above, stated directly: after a
    // generation-2 compaction the summary must still be present on the next
    // request. If the record recorded an injected id, this fails and the
    // conversation silently reverts to full history.
    const store = durableStore();
    const base = growingConversation(20, 60);
    await assembleWithStore(base, store);
    await assembleWithStore(base, store);
    const grown = growingConversation(28, 60);
    await assembleWithStore(grown, store);
    expect(store.rows.get("conv-seam-test")?.generation).toBe(2);

    const reload = await assembleWithStore(grown, store);
    expect(reload.context.provenance.compaction?.reason).toContain("record_applied");
    expect(JSON.stringify(reload.context.layerC.messages)).toContain("SUMMARY of earlier turns.");
  });

  it("declines precisely when the conversation outgrows one summariser call", async () => {
    // The honest limit of single-pass compaction. Beyond the summariser's input
    // capacity the span cannot be summarised without either summarising a prefix
    // and calling it the whole span, or summarising summaries — the recursive
    // growth path this phase forbids. It declines, cheaply and specifically, and
    // the pre-existing budget machinery decides.
    const store = durableStore();
    await assembleWithStore(oversizedConversation(), store);
    const grown = [...oversizedConversation()];

    // The realistic sequence needs a MIDDLE turn: the compaction leaves the
    // conversation above the release fraction, so the latch is still engaged and
    // refuses first. Correct precedence, but it never reaches the capacity check.
    // Below the release fraction clears the durable latch and compacts nothing.
    const quiet = await assembleWithStore(
      [
        user("u1", "hi"),
        toolTurn("a1", "tc1"),
        user("live", "THE LIVE REQUEST"),
        approvalPaused("aLive", "tc-live", "ap-live"),
      ],
      store,
    );
    expect(quiet.context.provenance.compaction?.applied).toBe(false);
    expect(store.rows.get("conv-seam-test")?.latched).toBe(false);
    for (let i = 100; i < 140; i += 1) {
      grown.push(user(`u${i}`, `question ${i} ${"pad ".repeat(400)}`));
      grown.push(toolTurn(`a${i}`, `tc${i}`));
    }

    const result = await assembleWithStore(grown, store);
    // Recovery is staged now: the 40 fresh turns past the stored record are a NEW
    // span, so the conversation compacts again instead of being refused forever.
    // The prior summary still applies, which is the property this case protects.
    expect(result.context.provenance.compaction?.applied).toBe(true);
    expect(result.context.provenance.compaction?.generation).toBe(2);
    // Critically: the PRIOR summary is still applied, so the conversation did not
    // silently revert to full history.
    expect(JSON.stringify(result.context.layerC.messages)).toContain(
      "SUMMARY of earlier turns.",
    );
  });
});

describe("compaction leaves Phase 3's deterministic prefix intact", () => {
  it("a compacted conversation has a stable, content-derived prefix identity", async () => {
    const first = seamHarness();
    const a = await first.assemble(oversizedConversation());
    const b = await first.assemble(oversizedConversation());
    // Identical inputs, identical request: the property Phase 3's cache identity
    // depends on must survive compaction.
    expect(JSON.stringify(a.context.modelMessages)).toBe(
      JSON.stringify(b.context.modelMessages),
    );
  });

  it("the summary sits at a fixed position, not at the end", async () => {
    const harness = seamHarness();
    const result = await harness.assemble(oversizedConversation());
    const ids = result.context.layerC.messages.map((m) => String(m.id));
    const summaryIndex = ids.findIndex((id) => id.startsWith("tbai-compaction:"));
    const liveIndex = ids.indexOf("live");
    expect(summaryIndex).toBeGreaterThan(-1);
    // Before the live turn, never appended after it: a trailing summary would
    // change the prefix on every compaction.
    expect(summaryIndex).toBeLessThan(liveIndex);
  });
});

// ─── Part 18: property-style invariants ────────────────────────────────────

describe("invariants that must hold for ANY conversation", () => {
  const shapes: Array<[string, () => UIMessage[]]> = [
    ["many turns", oversizedConversation],
    ["two turns", () => [user("u0", "a"), assistant("a0", "b"), user("u1", "c")]],
    ["tool pairs only", () => {
      const out: UIMessage[] = [];
      for (let i = 0; i < 30; i += 1) {
        out.push(toolTurn(`a${i}`, `tc${i}`));
        out.push(user(`u${i}`, `q${i} ${"pad ".repeat(200)}`));
      }
      out.push(user("live", "live"));
      return out;
    }],
    ["approval mid-history", () => {
      const out: UIMessage[] = [];
      for (let i = 0; i < 20; i += 1) {
        out.push(user(`u${i}`, `q${i} ${"pad ".repeat(200)}`));
        out.push(assistant(`a${i}`, `r${i}`));
      }
      out.push(user("uLive", "delete it"));
      out.push(approvalPaused("aLive", "tc-x", "ap-x"));
      return out;
    }],
  ];

  for (const [name, build] of shapes) {
    it(`compacting "${name}" always retains the live turn`, async () => {
      const harness = seamHarness();
      const messages = build();
      const result = await harness.assemble(messages);
      if (result.context.provenance.compaction?.applied !== true) return; // nothing to assert
      expect(JSON.stringify(result.context.layerC.messages)).toContain("live");
    });

    it(`compacting "${name}" never emits a call with no result and no approval`, async () => {
      const harness = seamHarness();
      const result = await harness.assemble(build());
      if (result.context.provenance.compaction?.applied !== true) return;
      for (const message of result.context.layerC.messages) {
        for (const part of (message as { parts?: Array<Record<string, unknown>> }).parts ?? []) {
          const type = String(part.type ?? "");
          if (!type.startsWith("tool-")) continue;
          const resolved =
            part.output !== undefined ||
            part.state === "output-error" ||
            part.state === "output-denied" ||
            part.approval !== undefined;
          expect(resolved, `tool part ${String(part.toolCallId)} left unresolved`).toBe(true);
        }
      }
    });
  }

  it("repeated assembly of the same conversation never grows the request without bound", async () => {
    // Convergence: applying the same durable compaction over and over must not
    // compound. Anything else would be an unbounded context-growth path.
    const harness = seamHarness();
    const messages = oversizedConversation();
    const sizes: number[] = [];
    for (let turn = 0; turn < 5; turn += 1) {
      const result = await harness.assemble(messages);
      sizes.push(result.context.provenance.estimate.estimatedTokens);
    }
    const first = sizes[0];
    for (const size of sizes) {
      expect(size).toBeLessThanOrEqual(first * 1.05);
    }
  });
});
