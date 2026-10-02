/**
 * Phase 4 — summariser, orchestrator, store and seam integration tests.
 *
 * ## Where the real risk lives
 *
 * `contract.test.ts` (sibling) covers the pure decision. This file covers the
 * three places where a mistake becomes INVISIBLE rather than loud:
 *
 *  1. **The summariser** — a bounded transformation that calls a provider. A bug
 *     here can produce an oversized summary that silently grows the request.
 *  2. **The orchestrator** — failure containment. A bug here corrupts state on
 *     the way to a failure, which is worse than the failure itself.
 *  3. **The store** — the single-winner race and the durable latch. A bug here
 *     lets one summarisation silently overwrite another.
 *
 * The summariser tests use `MockLanguageModelV3` from the installed SDK's own
 * `ai/test` export. No new dependency, and the call shape is the real one, so the
 * tests would notice an SDK signature change.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import {
  applyExistingCompaction,
  maybeCompact,
  summarizeSpan,
  type CompactionRecord,
} from "./index";
import { createCompactionStore, type CompactionStore } from "../../services/compaction";
import { DEFAULT_COMPACTION_POLICY } from "./index";

// ─── fixtures ──────────────────────────────────────────────────────────────

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}
function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text, state: "done" }] } as unknown as UIMessage;
}
function conversation(turns: number): UIMessage[] {
  const out: UIMessage[] = [];
  for (let i = 0; i < turns; i += 1) {
    out.push(user(`u${i}`, `question ${i} ${"detail ".repeat(20)}`));
    out.push(assistant(`a${i}`, `answer ${i} ${"reply ".repeat(20)}`));
  }
  return out;
}

/**
 * The SDK's own generate-result type, DERIVED from the installed mock's
 * signature.
 *
 * Not imported from `@ai-sdk/provider`: that package is a transitive dependency
 * and importing it directly would create an undeclared dependency. Deriving it
 * keeps the test honest — if the SDK changes its result shape, this type stops
 * compiling.
 */
type MockDoGenerate = NonNullable<
  ConstructorParameters<typeof MockLanguageModelV3>[0]
>["doGenerate"];
type MockGenerateResult = Awaited<
  ReturnType<Extract<MockDoGenerate, (...args: never[]) => unknown>>
>;

/**
 * A successful mock result with the SDK's exact literal unions.
 *
 * The `finishReason` and `usage` shapes are AI SDK v7's detailed-accounting form
 * (`{ unified, raw }` and `{ total, noCache, cacheRead, cacheWrite }`), read off
 * the installed `@ai-sdk/provider` 4.0.10 types rather than assumed. The type is
 * derived, so a shape change here is a compile error rather than a silent lie.
 */
function textResult(text: string): MockGenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "end_turn" },
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 50, text: 50, reasoning: 0 },
    },
    warnings: [],
  };
}

/** A model that returns a fixed summary, and records what it was asked. */
function summaryModel(text: string): { model: MockLanguageModelV3; calls: unknown[] } {
  const calls: unknown[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls.push(options);
      return textResult(text);
    },
  });
  return { model, calls };
}

/** A model that always fails. */
function failingModel(error: Error): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw error;
    },
  });
}

/**
 * A model that never answers until aborted.
 *
 * It checks `signal.aborted` BEFORE subscribing, exactly as `fetch` does. This
 * fidelity is load-bearing: the SDK can hand the model an ALREADY-ABORTED signal
 * (verified by capturing `doGenerate` options), and a provider that only listens
 * for the event never learns about it. A mock that got that wrong hung the suite
 * for 10s and taught nothing.
 */
function hangingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const signal = (options as { abortSignal?: AbortSignal }).abortSignal;
      if (!signal) throw new Error("model received no abortSignal");
      if (signal.aborted) throw new Error("model saw an already-aborted signal");
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("model aborted")), { once: true });
      });
    },
  });
}

/**
 * Per-message size for the orchestrator fixtures.
 *
 * Must exceed maxSummaryTokens / spanLength, or the contract CORRECTLY refuses
 * with summary_would_not_reclaim_enough and no orchestrator behaviour is reached.
 */
const ORCHESTRATOR_TOKENS_PER_MESSAGE = 400;

/** Stand-in for the seam-derived summariser input ceiling. */
const SUMMARISER_INPUT_CEILING = 200_000;

function spanFixture(): UIMessage[] {
  return [...conversation(8), user("live", "the current question")];
}

function summarize(over: Partial<Parameters<typeof summarizeSpan>[0]> = {}) {
  const { model } = summaryModel("SUMMARY: earlier turns asked about X and produced Y.");
  return summarizeSpan({
    model: model as never,
    spanMessages: spanFixture(),
    maxSummaryTokens: DEFAULT_COMPACTION_POLICY.maxSummaryTokens,
    outputReservation: DEFAULT_COMPACTION_POLICY.summaryOutputReservation,
    maxInputTokens: SUMMARISER_INPUT_CEILING,
    summarizedBy: "test/model",
    timeoutMs: 5_000,
    ...over,
  });
}

// ─── Part 7/11: the summariser is a bounded transformation ──────────────────

describe("the summariser never receives unbounded context", () => {
  it("transcribes exactly what it was handed, and nothing else", async () => {
    // The summariser has no notion of "the conversation" — it renders its input.
    // Containment therefore comes from the CALLER handing it only a span, which
    // the next test pins. Asserting the weaker true property here keeps this test
    // from asserting something the function was never responsible for.
    const { model, calls } = summaryModel("bounded");
    const span = conversation(4);
    await summarizeSpan({
      model: model as never,
      spanMessages: span,
      maxSummaryTokens: 1_500,
      outputReservation: 2_048,
      maxInputTokens: SUMMARISER_INPUT_CEILING,
      summarizedBy: "test/model",
      timeoutMs: 5_000,
    });
    const prompt = JSON.stringify(calls[0]);
    expect(prompt).toContain("question 0");
    expect(prompt).toContain("answer 3");
    // Nothing that was not in the span can appear.
    expect(prompt).not.toContain("the current question");
  });

  it("the orchestrator hands the summariser ONLY the covered span", async () => {
    // This is the real containment guarantee. The live turn is in the fixture and
    // must not reach the summariser, because summarising the current request would
    // fold the user's live intent into a record of PAST turns.
    const messages = spanFixture();
    const live = messages[messages.length - 1];
    expect(live.id).toBe("live");

    let seen: readonly UIMessage[] = [];
    const result = await maybeCompact(
      compactInput({
        messages,
        summarize: async (spanMessages) => {
          seen = spanMessages;
          return {
            ok: true as const,
            summaryText: "SUMMARY: earlier turns.",
            summaryTokens: 30,
            summarizedBy: "test/model",
            origin: "model_generated_summary" as const,
          };
        },
      }),
    );
    expect(result.outcome.applied).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(messages.length);
    expect(JSON.stringify(seen)).not.toContain("the current question");
  });

  it("bounds the output with an explicit reservation", async () => {
    const { model, calls } = summaryModel("bounded");
    await summarizeSpan({
      model: model as never,
      spanMessages: spanFixture(),
      maxSummaryTokens: 1_500,
      outputReservation: 777,
      summarizedBy: "test/model",
      maxInputTokens: SUMMARISER_INPUT_CEILING,
      timeoutMs: 5_000,
    });
    const options = calls[0] as { maxOutputTokens?: number };
    expect(options.maxOutputTokens).toBe(777);
  });

  it("refuses an empty span without calling the provider", async () => {
    const { model, calls } = summaryModel("unused");
    const result = await summarizeSpan({
      model: model as never,
      spanMessages: [],
      maxSummaryTokens: 1_500,
      outputReservation: 2_048,
      maxInputTokens: SUMMARISER_INPUT_CEILING,
      summarizedBy: "test/model",
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.failure).toBe("span_empty");
    expect(calls).toHaveLength(0);
  });
});

describe("a summary that breaks its contract is REJECTED, never truncated", () => {
  it("rejects an over-budget summary", async () => {
    // A half-summary silently claims coverage it does not have, which would
    // corrupt the conversation's durable record. Refusing is the only safe move.
    const huge = "word ".repeat(20_000);
    const result = await summarize({ model: summaryModel(huge).model as never });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.failure).toBe("summary_exceeds_budget");
      expect(result.summaryTokens).toBeGreaterThan(DEFAULT_COMPACTION_POLICY.maxSummaryTokens);
    }
  });

  it("rejects an empty summary", async () => {
    const result = await summarize({ model: summaryModel("   ").model as never });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.failure).toBe("empty_summary");
  });

  it("measures the summary with the project's estimator, not the provider's claim", async () => {
    // The mock reports outputTokens: 50, far below any cap. A summary that the
    // provider calls small but the project measures large must still be rejected.
    const oversized = "word ".repeat(2_000);
    const result = await summarize({
      model: summaryModel(oversized).model as never,
      maxSummaryTokens: 200,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.failure).toBe("summary_exceeds_budget");
  });

  it("carries provenance on success", async () => {
    const result = await summarize();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.origin).toBe("model_generated_summary");
      expect(result.summarizedBy).toBe("test/model");
      expect(result.summaryTokens).toBeGreaterThan(0);
    }
  });
});

describe("summariser failures are typed, never thrown", () => {
  it("reports a provider error", async () => {
    const result = await summarize({ model: failingModel(new Error("upstream 500")) as never });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.failure).toBe("provider_error");
  });

  it("reports a timeout distinctly from an abort", async () => {
    // The distinction matters: a timeout is TBAi's bound doing its job, while an
    // abort means the user's own cancel or the run's lifetime ended.
    const result = await summarize({ model: hangingModel() as never, timeoutMs: 20 });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.failure).toBe("timeout");
  });

  it("reports an abort distinctly from a timeout", async () => {
    // A deadline far longer than the test could ever wait, so the abort is the
    // ONLY thing that can end this call. Any other outcome would be the deadline
    // masquerading as an abort.
    const controller = new AbortController();
    const pending = summarize({
      model: hangingModel() as never,
      abortSignal: controller.signal,
      timeoutMs: 120_000,
    });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.failure).toBe("aborted");
  }, 10_000);

  it("refuses a span too large to summarise within its own bounds", async () => {
    const huge = conversation(200);
    const result = await summarize({ spanMessages: huge, maxInputTokens: 100 });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.failure).toBe("summary_exceeds_budget");
  });
});

// ─── Part 12: the orchestrator contains every failure ──────────────────────

/** In-memory stand-in for the durable store. */
function memoryStore(): { store: CompactionStore; writes: CompactionRecord[]; cleared: string[] } {
  const rows = new Map<string, CompactionRecord>();
  const writes: CompactionRecord[] = [];
  const cleared: string[] = [];
  return {
    writes,
    cleared,
    store: {
      get: (id) => rows.get(id),
      has: (id) => rows.has(id),
      record: (record) => {
        const existing = rows.get(record.conversationId);
        if (existing && existing.generation >= record.generation) return existing;
        rows.set(record.conversationId, record);
        writes.push(record);
        return record;
      },
      releaseLatch: (id) => {
        const row = rows.get(id);
        if (row) rows.set(id, { ...row, latched: false });
      },
      clear: (id) => {
        cleared.push(id);
        rows.delete(id);
      },
    },
  };
}

function compactInput(over: Partial<Parameters<typeof maybeCompact>[0]> = {}) {
  const messages = spanFixture();
  return {
    conversationId: "conv-1",
    messages,
    measuredTokens: messages.map(() => ORCHESTRATOR_TOKENS_PER_MESSAGE),
    currentTurnIds: ["live"],
    measuredTotalTokens: 900,
    fixedOverheadTokens: 0,
    usableInputTokens: 1_000,
    existing: undefined,
    compactionLatched: false,
    summarizerInputTokens: 200_000,
    priorSummaryText: undefined,
    policy: DEFAULT_COMPACTION_POLICY,
    summarize: async () => ({
      ok: true as const,
      summaryText: "SUMMARY: earlier turns.",
      summaryTokens: 30,
      summarizedBy: "test/model",
      origin: "model_generated_summary" as const,
    }),
    persist: (record: CompactionRecord) => record,
    nextCompactionId: (generation: number) => `cmp_${generation}`,
    now: () => 1_700_000_000_000,
    ...over,
  };
}

describe("a failed compaction leaves no trace and changes nothing", () => {
  it("summariser failure returns the ORIGINAL messages, untouched", async () => {
    const input = compactInput();
    const result = await maybeCompact({
      ...input,
      summarize: async () => ({ ok: false, failure: "provider_error" }),
    });
    expect(result.outcome.applied).toBe(false);
    // Byte-identical, not merely equal in length.
    expect(JSON.stringify(result.messages)).toBe(JSON.stringify(input.messages));
  });

  it("a failed compaction does NOT persist anything", async () => {
    const { store, writes } = memoryStore();
    const result = await maybeCompact(
      compactInput({
        persist: store.record,
        summarize: async () => ({ ok: false, failure: "timeout" }),
      }),
    );
    expect(result.outcome.applied).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it("reports the failure reason, so the log is diagnosable", async () => {
    const result = await maybeCompact(
      compactInput({ summarize: async () => ({ ok: false, failure: "summary_exceeds_budget" }) }),
    );
    expect(result.outcome.applied).toBe(false);
    if (result.outcome.applied === false) {
      expect(result.outcome.reason).toBe("summarize_failed:summary_exceeds_budget");
    }
  });

  it("a persist failure does not apply an unrecorded compaction", async () => {
    // Applying a summary the database does not hold would make the model see a
    // compaction that a reload would not reproduce — exactly the inconsistency
    // durability forbids.
    const result = await maybeCompact(
      compactInput({ persist: () => undefined as unknown as CompactionRecord }),
    );
    expect(result.outcome.applied).toBe(false);
    if (result.outcome.applied === false) expect(result.outcome.reason).toBe("persist_failed");
    expect(JSON.stringify(result.messages)).toBe(JSON.stringify(spanFixture()));
  });

  it("an unexpected throw in the planner is not the orchestrator's to survive", async () => {
    // The orchestrator trusts its pure collaborators; the SEAM is the failure
    // boundary. This test documents where that boundary actually is.
    const input = compactInput({ measuredTokens: null as unknown as number[] });
    await expect(maybeCompact(input)).rejects.toThrow();
  });
});

describe("a successful compaction is recorded and applied together", () => {
  it("persists a latched record", async () => {
    const { store, writes } = memoryStore();
    const result = await maybeCompact(compactInput({ persist: store.record }));
    expect(result.outcome.applied).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].latched).toBe(true);
    expect(writes[0].generation).toBe(1);
    expect(writes[0].origin).toBe("model_generated_summary");
  });

  it("increments the generation on a repeat compaction", async () => {
    const { store } = memoryStore();
    await maybeCompact(compactInput({ persist: store.record }));
    const second = await maybeCompact(
      compactInput({
        persist: store.record,
        existing: store.get("conv-1"),
        compactionLatched: false,
      }),
    );
    expect(second.outcome.applied).toBe(true);
    if (second.outcome.applied) expect(second.outcome.record.generation).toBe(2);
  });

  it("applies the STORED record when another writer won the race", async () => {
    // The caller must apply what the database holds, not what it proposed.
    // Otherwise the model sees a span the durable record does not describe.
    const winner: CompactionRecord = {
      compactionId: "winner",
      conversationId: "conv-1",
      spanStartIndex: 0,
      spanEndIndex: 1,
      coveredMessageIds: ["u0", "a0"],
      spanFingerprint: "span:00000000:2",
      summaryText: "SUMMARY: the WINNER's span.",
      summaryTokens: 20,
      origin: "model_generated_summary",
      summarizedBy: "other/model",
      generation: 99,
      latched: true,
      createdAt: 1,
    };
    const result = await maybeCompact(compactInput({ persist: () => winner }));
    expect(result.outcome.applied).toBe(true);
    const text = JSON.stringify(result.messages);
    expect(text).toContain("the WINNER's span");
    expect(text).not.toContain("earlier turns.");
  });

  it("never lets the compaction remove the current turn", async () => {
    const result = await maybeCompact(compactInput());
    expect(JSON.stringify(result.messages)).toContain("the current question");
  });
});

// ─── the defect this suite exists to prevent ───────────────────────────────

describe("a concurrent writer never has its span silently overwritten", () => {
  /**
   * Store semantics identical to `compactionStore.record`: a strictly-greater
   * generation wins, everything else returns the row that is already there.
   */
  function racingStore() {
    const rows = new Map<string, CompactionRecord>();
    return {
      rows,
      persist: (r: CompactionRecord) => {
        const existing = rows.get(r.conversationId);
        if (existing && existing.generation >= r.generation) return existing;
        rows.set(r.conversationId, r);
        return r;
      },
    };
  }

  function racingInput(messages: UIMessage[], summaryText: string, store: ReturnType<typeof racingStore>, idFactory: (g: number) => string) {
    return compactInput({
      messages,
      summarize: async () => ({
        ok: true as const,
        summaryText,
        summaryTokens: 30,
        summarizedBy: "test/model",
        origin: "model_generated_summary" as const,
      }),
      persist: store.persist,
      nextCompactionId: idFactory,
      existing: undefined,
      compactionLatched: false,
    });
  }

  function sizedConversation(turns: number): UIMessage[] {
    const out: UIMessage[] = [];
    for (let i = 0; i < turns; i += 1) {
      out.push(user(`u${i}`, `q${i} ${"pad ".repeat(60)}`));
      out.push(assistant(`a${i}`, `r${i} ${"reply ".repeat(60)}`));
    }
    out.push(user("live", "THE LIVE REQUEST"));
    return out;
  }

  it("a race loser keeps its own messages instead of splicing the winner's summary over them", async () => {
    // D9. Two concurrent requests over the SAME conversation with DIFFERENT
    // histories — two tabs, or a detached run plus a new submit. A wins
    // generation 1 over the shorter history; B loses over the longer one.
    //
    // The defect: B applied the winner's summary across B's OWN plan indices, so
    // every message between the two spans left B's request and was covered by no
    // durable record. Silent loss, no provenance, unrecoverable from the record.
    const store = racingStore();
    // Unique ids, exactly as the route generates them.
    let n = 0;
    const uniqueIds = () => `cmp_${++n}`;

    const short = sizedConversation(12);
    const long = sizedConversation(16);

    const a = await maybeCompact(racingInput(short, "SUMMARY A (short span)", store, uniqueIds));
    expect(a.outcome.applied).toBe(true);
    const winner = store.rows.get("conv-1");
    expect(winner?.generation).toBe(1);

    const b = await maybeCompact(racingInput(long, "SUMMARY B (long span)", store, uniqueIds));
    // B lost the race, so the durable record is still A's.
    expect(store.rows.get("conv-1")?.generation).toBe(1);
    expect(store.rows.get("conv-1")?.summaryText).toBe("SUMMARY A (short span)");

    const sentIds = b.messages.map((m) => String(m.id));
    // THE ASSERTION: nothing from B's own history may be dropped.
    for (const id of long.map((m) => String(m.id))) {
      const coveredByRecord = new Set(winner!.coveredMessageIds);
      // A message is either still present, or explicitly described by the record.
      expect(
        sentIds.includes(id) || coveredByRecord.has(id),
        `message ${id} vanished from the loser's request and is covered by no record`,
      ).toBe(true);
    }
    // And the live turn is always present.
    expect(sentIds).toContain("live");
  });

  it("a race loser is recognised even when both writers generate the SAME id", async () => {
    // Race detection must not rest on `compactionId`. Two writers at the same
    // generation produce the same id whenever the id is derived from the
    // generation, so an id comparison makes the loser believe it won. Identity is
    // (generation, spanFingerprint), which cannot collide.
    const store = racingStore();
    const derivedIds = (g: number) => `cmp_${g}`;

    await maybeCompact(racingInput(sizedConversation(12), "SUMMARY A", store, derivedIds));
    const b = await maybeCompact(racingInput(sizedConversation(16), "SUMMARY B", store, derivedIds));

    const sent = JSON.stringify(b.messages);
    // B's summary must NOT be present — it lost, so A's is authoritative.
    expect(sent).toContain("SUMMARY A");
    expect(sent).not.toContain("SUMMARY B");
    // And B's own extra turns must survive.
    for (let i = 12; i < 16; i += 1) {
      expect(sent, `u${i} must survive`).toContain(`"u${i}"`);
      expect(sent, `a${i} must survive`).toContain(`"a${i}"`);
    }
  });

  it("refuses to compact at all when the winner's span is absent from the loser's history", async () => {
    // A branched or regenerated conversation: the winner's covered ids do not exist
    // here. Locating them is impossible, and mis-splicing would drop messages the
    // winner never described. Refusing is the only safe outcome.
    const store = racingStore();
    await maybeCompact(racingInput(sizedConversation(12), "SUMMARY A", store, (g) => `cmp_${g}`));
    // A branched or regenerated conversation: the winner's covered ids do not exist
    // here. It must still be large enough to PLAN a compaction, otherwise the
    // planner refuses first (`span_too_small_to_compact`) and the loser path is
    // never reached — which is safe, but would leave the race untested.
    const alien: UIMessage[] = [];
    for (let i = 0; i < 12; i += 1) {
      alien.push(user(`z${i}`, `other branch ${i} ${"pad ".repeat(60)}`));
      alien.push(assistant(`y${i}`, `other reply ${i} ${"reply ".repeat(60)}`));
    }
    alien.push(user("live", "THE LIVE REQUEST"));
    const b = await maybeCompact(racingInput(alien, "SUMMARY alien", store, (g) => `cmp_${g}`));
    expect(b.outcome.applied).toBe(false);
    if (b.outcome.applied === false) {
      expect(b.outcome.reason).toBe("lost_race_span_not_locatable");
    }
    // Nothing removed.
    expect(JSON.stringify(b.messages)).toBe(JSON.stringify(alien));
  });

  it("reports whether this turn won the race, so diagnostics can tell", async () => {
    const store = racingStore();
    let n = 0;
    const ids = () => `cmp_${++n}`;
    const winner = await maybeCompact(racingInput(sizedConversation(12), "A", store, ids));
    expect(winner.outcome.applied).toBe(true);
    if (winner.outcome.applied) expect(winner.outcome.wonRace).toBe(true);

    const loser = await maybeCompact(racingInput(sizedConversation(16), "B", store, ids));
    if (loser.outcome.applied) {
      expect(loser.outcome.wonRace, "the second writer must know it lost").toBe(false);
      expect(loser.outcome.record.summaryText).toBe("A");
    }
  });
});
describe("a repeated compaction must record only ids the client will re-post", () => {
  it("hands the summariser the previous summary so history is not dropped", async () => {
    // Without this, the second compaction's span covers strictly MORE of the
    // conversation, but the messages between the two spans survive only inside the
    // first summary. Omitting it would silently lose that history.
    let seen: readonly UIMessage[] = [];
    await maybeCompact(
      compactInput({
        existing: { ...makeRecord(1), summaryText: "SUMMARY: the FIRST compaction." },
        priorSummaryText: "SUMMARY: the FIRST compaction.",
        summarize: async (spanMessages) => {
          seen = spanMessages;
          return {
            ok: true as const,
            summaryText: "SUMMARY: the SECOND compaction.",
            summaryTokens: 30,
            summarizedBy: "test/model",
            origin: "model_generated_summary" as const,
          };
        },
      }),
    );
    const text = JSON.stringify(seen);
    expect(text).toContain("the FIRST compaction");
    // And the new span's own content too, so the two are combined rather than one
    // replacing the other. The span is whatever the plan selected, so assert against
    // a span message rather than a specific turn.
    expect(seen.length).toBeGreaterThan(1);
    expect(text).toContain("reply reply");
  });

  it("plans the span over the CLIENT's messages, never over an injected block", async () => {
    // THE defect. Planning over the compacted view produced a record whose covered
    // ids began with the server-injected `tbai-compaction:*` id. The client never
    // receives that id, so on the next request the record could not be located, the
    // compaction silently stopped applying, and the conversation reverted to full
    // history and grew without bound.
    const clientMessages = spanFixture();
    const withInjected = applyExistingCompaction({
      messages: clientMessages,
      record: makeRecord(1),
    }).messages;
    expect(JSON.stringify(withInjected)).toContain("tbai-compaction:");

    const result = await maybeCompact(
      compactInput({
        messages: clientMessages,
        priorSummaryText: "SUMMARY: the FIRST compaction.",
        existing: makeRecord(1),
        compactionLatched: false,
      }),
    );
    expect(result.outcome.applied).toBe(true);
    if (result.outcome.applied === false) return;

    const covered = result.outcome.record.coveredMessageIds;
    expect(covered.length).toBeGreaterThan(0);
    expect(
      covered.some((id) => id.startsWith("tbai-compaction:")),
      "a durable record must never cover a server-injected id",
    ).toBe(false);
    // Every covered id must exist in what the client actually sent.
    const clientIds = new Set(clientMessages.map((m) => String(m.id)));
    for (const id of covered) {
      expect(clientIds.has(id), `covered id ${id} is not a client message`).toBe(true);
    }
  });

  it("refuses a span larger than one summariser call, before calling the provider", async () => {
    // Single-pass compaction cannot honestly summarise a prefix of a span. Refusing
    // at plan time costs nothing and gives a precise diagnosis instead of an opaque
    // provider error.
    let called = false;
    const messages = spanFixture();
    const result = await maybeCompact(
      compactInput({
        messages,
        summarizerInputTokens: 10,
        summarize: async () => {
          called = true;
          return {
            ok: true as const,
            summaryText: "unused",
            summaryTokens: 5,
            summarizedBy: "test/model",
            origin: "model_generated_summary" as const,
          };
        },
      }),
    );
    expect(result.outcome.applied).toBe(false);
    if (result.outcome.applied === false) {
      // With a summariser that can read almost nothing, staged recovery shrinks
      // the span to nothing worth summarising. Either precise refusal is correct;
      // what matters is that the provider is never called and the messages are
      // returned untouched rather than partially summarised.
      expect(["span_exceeds_summarizer_capacity", "span_too_small_to_compact", "summary_would_not_reclaim_enough"]).toContain(
        result.outcome.reason,
      );
    }
    expect(called).toBe(false);
    expect(JSON.stringify(result.messages)).toBe(JSON.stringify(messages));
  });

  function makeRecord(generation: number): CompactionRecord {
    return {
      compactionId: `cmp_${generation}`,
      conversationId: "conv-1",
      spanStartIndex: 0,
      spanEndIndex: 10,
      coveredMessageIds: ["u0", "a0", "u1", "a1"],
      spanFingerprint: "span:abcd1234:4",
      summaryText: "SUMMARY: earlier turns.",
      summaryTokens: 40,
      origin: "model_generated_summary",
      summarizedBy: "test/model",
      generation,
      latched: false,
      createdAt: 1_700_000_000_000,
    };
  }
});

// ─── the durable store ──────────────────────────────────────────────────────

describe("the compaction store round-trips and refuses to lose a newer record", () => {
  let dir: string;
  let conn: Database;
  let store: CompactionStore;

  const SCHEMA = `
    CREATE TABLE conversations (id TEXT PRIMARY KEY);
    CREATE TABLE conversation_compactions (
      conversation_id      TEXT PRIMARY KEY,
      compaction_id        TEXT NOT NULL UNIQUE,
      generation           INTEGER NOT NULL DEFAULT 1,
      latched               INTEGER NOT NULL DEFAULT 1,
      span_start_index     INTEGER NOT NULL,
      span_end_index       INTEGER NOT NULL,
      covered_message_ids  TEXT NOT NULL,
      span_fingerprint     TEXT NOT NULL,
      summary_text         TEXT NOT NULL,
      summary_tokens       INTEGER NOT NULL,
      origin               TEXT NOT NULL CHECK(origin = 'model_generated_summary'),
      summarized_by        TEXT NOT NULL,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );
  `;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-compaction-"));
    conn = new Database(path.join(dir, "compaction.db"));
    // `exec`, not `run`: bun:sqlite's `run` executes exactly ONE statement, so a
    // multi-table schema silently created nothing but the first table. That
    // produced an unnamed failure rather than a clear error — which is precisely
    // why the store is tested against a real database instead of a fake.
    conn.exec(SCHEMA);
    // Schema first: the compaction table's foreign key needs the parent row, and
    // inserting before the tables exist fails with "no such table".
    conn.run(`INSERT INTO conversations (id) VALUES ('conv-1')`);
    store = createCompactionStore(conn);
  });

  afterAll(() => {
    conn.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base: CompactionRecord = {
    compactionId: "cmp-1",
    conversationId: "conv-1",
    spanStartIndex: 0,
    spanEndIndex: 3,
    coveredMessageIds: ["u0", "a0", "u1", "a1"],
    spanFingerprint: "span:abcd1234:4",
    summaryText: "SUMMARY: earlier turns.",
    summaryTokens: 42,
    origin: "model_generated_summary",
    summarizedBy: "anthropic/claude-opus-5-5",
    generation: 1,
    latched: true,
    createdAt: 1_700_000_000_000,
  };

  it("stores nothing for an unknown conversation", () => {
    expect(store.get("nope")).toBeUndefined();
    expect(store.has("nope")).toBe(false);
  });

  it("round-trips every field, including the latch", () => {
    store.record(base);
    const read = store.get("conv-1");
    expect(read).toBeDefined();
    expect(read?.coveredMessageIds).toEqual(["u0", "a0", "u1", "a1"]);
    expect(read?.summaryTokens).toBe(42);
    expect(read?.origin).toBe("model_generated_summary");
    expect(read?.latched).toBe(true);
    expect(read?.generation).toBe(1);
    expect(store.has("conv-1")).toBe(true);
  });

  it("keeps exactly ONE row per conversation across repeated compactions", () => {
    for (let generation = 2; generation <= 5; generation += 1) {
      store.record({ ...base, compactionId: `cmp-${generation}`, generation });
    }
    const count = conn
      .query("SELECT COUNT(*) AS n FROM conversation_compactions WHERE conversation_id = 'conv-1'")
      .get() as { n: number };
    expect(count.n).toBe(1);
    expect(store.get("conv-1")?.generation).toBe(5);
  });

  it("a slower writer with an OLDER generation cannot clobber a newer summary", () => {
    // The concurrency case: run A starts summarising, run B finishes first and
    // writes generation 6, then A's generation-5 summary arrives late. Applying
    // A's would show the model a span the conversation has moved past.
    store.record({ ...base, compactionId: "cmp-6", generation: 6, summaryText: "SUMMARY: gen 6." });
    const result = store.record({
      ...base,
      compactionId: "cmp-5-late",
      generation: 5,
      summaryText: "SUMMARY: the stale one.",
    });
    expect(result.summaryText).toBe("SUMMARY: gen 6.");
    expect(result.generation).toBe(6);
    expect(store.get("conv-1")?.summaryText).toBe("SUMMARY: gen 6.");
  });

  it("releases the latch without losing the summary", () => {
    store.releaseLatch("conv-1");
    const read = store.get("conv-1");
    expect(read?.latched).toBe(false);
    expect(read?.summaryText).toBe("SUMMARY: gen 6.");
    expect(read?.generation).toBe(6);
  });

  it("a corrupt row degrades to absent rather than throwing", () => {
    // Assembly must never fail because of one unreadable row — the existing
    // CONTEXT_OVERFLOW path is the correct behaviour, not a 500.
    conn.run("UPDATE conversation_compactions SET covered_message_ids = 'not json'");
    expect(store.get("conv-1")).toBeUndefined();
    // ...but the row still exists, so `has` remains honest about the fact.
    expect(store.has("conv-1")).toBe(true);
  });

  it("clearing is a complete rollback", () => {
    store.clear("conv-1");
    expect(store.get("conv-1")).toBeUndefined();
    expect(store.has("conv-1")).toBe(false);
  });
});
