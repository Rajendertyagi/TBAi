/**
 * Phase 4 — compaction tests.
 *
 * These are the correctness claims the phase rests on. Every one asserts an
 * externally meaningful property, not that a branch was taken.
 *
 * The highest-value tests here are the NEGATIVE ones — "compaction never
 * produces X" — because the failure mode of compaction is silently losing
 * something the conversation still needs.
 */

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import {
  DEFAULT_COMPACTION_POLICY,
  applyCompaction,
  applyExistingCompaction,
  currentTurnStartIndex,
  latestCutIndexBefore,
  planCompaction,
  renderCompactedMessages,
  renderSpanTranscript,
  spanFingerprint,
  type CompactionPlan,
  type CompactionRecord,
} from "./index";

// ─── fixtures ──────────────────────────────────────────────────────────────

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}
function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text, state: "done" }] } as unknown as UIMessage;
}
/** An assistant turn carrying a COMPLETED tool call + result pair. */
function toolTurn(id: string, toolCallId: string, result: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      { type: "text", text: "running", state: "done" },
      {
        type: "tool-read_file",
        toolName: "read_file",
        toolCallId,
        state: "output-available",
        input: { path: "a.txt" },
        output: { path: "a.txt", totalLines: 1, truncated: false, content: result },
      },
    ],
  } as unknown as UIMessage;
}
/** An assistant turn PAUSED on an approval — the real mid-run persisted state. */
function approvalPaused(id: string, toolCallId: string, approvalId: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-delete_file",
        toolCallId,
        state: "approval-requested",
        input: { path: "a.txt" },
        approval: { id: approvalId },
      },
    ],
  } as unknown as UIMessage;
}

function conversation(turns: number): UIMessage[] {
  const out: UIMessage[] = [];
  for (let i = 0; i < turns; i += 1) {
    out.push(user(`u${i}`, `question ${i}`));
    out.push(assistant(`a${i}`, `answer ${i}`));
  }
  return out;
}

const POLICY = DEFAULT_COMPACTION_POLICY;

function record(overrides: Partial<CompactionRecord> = {}): CompactionRecord {
  return {
    compactionId: "cmp-1",
    conversationId: "conv-1",
    spanStartIndex: 0,
    spanEndIndex: 3,
    coveredMessageIds: ["m0", "m1", "m2", "m3"],
    spanFingerprint: "span:deadbeef:4",
    summaryText: "SUMMARY: the user asked about X and we answered Y.",
    summaryTokens: 20,
    origin: "model_generated_summary",
    summarizedBy: "anthropic/claude-opus-5-5",
    generation: 1,
    latched: true,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

/**
 * Per-message measured size used by the trigger fixtures.
 *
 * Realistic on purpose: the contract refuses to compact a span smaller than the
 * summary that would replace it, so a fixture with 10-token messages would be
 * refused for the right reason and test nothing about the trigger.
 */
const TOKENS_PER_MESSAGE = 100;

/** Plan over a conversation, with a measured size that forces a given outcome. */
function planOver(messages: UIMessage[], measuredTotal: number, usable: number | undefined = 1000): CompactionPlan {
  return planCompaction({
    messages,
    measuredTokens: messages.map(() => TOKENS_PER_MESSAGE),
    usableInputTokens: usable,
    measuredTotalTokens: measuredTotal,
    fixedOverheadTokens: 0,
    policy: POLICY,
    hasExistingCompaction: false,
    reason: "pressure",
  });
}

// ─── Part 3: trigger ───────────────────────────────────────────────────────

describe("trigger uses the measured budget, not a message count", () => {
  it("does not compact below the trigger fraction", () => {
    // 700 of 1000 usable = 70%, below the 80% trigger.
    const plan = planOver(conversation(20), 700);
    expect(plan.kind).toBe("none");
    if (plan.kind === "none") expect(plan.reason).toBe("below_trigger");
  });

  it("compacts above the trigger fraction", () => {
    const plan = planOver(conversation(20), 850);
    expect(plan.kind).toBe("compact");
  });

  it("scales with the budget rather than a fixed token count", () => {
    // The SAME measured usage is below trigger on a large model and above on a
    // small one. A hardcoded token threshold could not do this.
    const messages = conversation(20);
    const small = planCompaction({
      messages,
      measuredTokens: messages.map(() => TOKENS_PER_MESSAGE),
      usableInputTokens: 1000,
      measuredTotalTokens: 850,
    fixedOverheadTokens: 0,
      policy: POLICY,
      hasExistingCompaction: false,
      reason: "pressure",
    });
    const large = planCompaction({
      messages,
      measuredTokens: messages.map(() => TOKENS_PER_MESSAGE),
      usableInputTokens: 100_000,
      measuredTotalTokens: 850,
    fixedOverheadTokens: 0,
      policy: POLICY,
      hasExistingCompaction: false,
      reason: "pressure",
    });
    expect(small.kind).toBe("compact");
    expect(large.kind).toBe("none");
  });

  it("refuses to compact when there is no usable budget", () => {
    // Called directly rather than through `planOver`: a default parameter
    // applies when `undefined` is passed explicitly, so the helper cannot
    // express "no budget".
    const messages = conversation(20);
    const plan = planCompaction({
      messages,
      measuredTokens: messages.map(() => TOKENS_PER_MESSAGE),
      usableInputTokens: undefined,
      measuredTotalTokens: 9999,
    fixedOverheadTokens: 0,
      policy: POLICY,
      hasExistingCompaction: false,
      compactionLatched: false,
      reason: "pressure",
    });
    expect(plan.kind).toBe("none");
    if (plan.kind === "none") expect(plan.reason).toBe("no_conversation");
  });

  it("refuses to compact when the usable budget is zero", () => {
    const messages = conversation(20);
    const plan = planCompaction({
      messages,
      measuredTokens: messages.map(() => TOKENS_PER_MESSAGE),
      usableInputTokens: 0,
      measuredTotalTokens: 9999,
    fixedOverheadTokens: 0,
      policy: POLICY,
      hasExistingCompaction: false,
      compactionLatched: false,
      reason: "pressure",
    });
    expect(plan.kind).toBe("none");
  });

  it("refuses to compact a span smaller than the summary that would replace it", () => {
    // A "compaction" that grows the request is not a compaction.
    const messages = conversation(20);
    const plan = planCompaction({
      messages,
      measuredTokens: messages.map(() => 1), // tiny span
      usableInputTokens: 1000,
      measuredTotalTokens: 900,
    fixedOverheadTokens: 0,
      policy: POLICY,
      hasExistingCompaction: false,
      reason: "pressure",
    });
    expect(plan.kind).toBe("none");
    if (plan.kind === "none") expect(plan.reason).toBe("summary_would_not_reclaim_enough");
  });
});

// ─── Part 3: hysteresis ────────────────────────────────────────────────────

describe("hysteresis prevents compaction on every turn", () => {
it("does not re-summarise a span the durable record already covers", () => {
    // HYSTERESIS, correctly scoped. The thing that must never happen twice is
    // paying a summarisation call for the SAME history. So the guard is the
    // covered-id set, not a conversation-wide latch.
    const messages = conversation(20);
    const covered = messages.map((m) => (m as { id?: string }).id ?? "");
    const plan = planCompaction({
      messages,
      measuredTokens: messages.map(() => TOKENS_PER_MESSAGE),
      usableInputTokens: 1000,
      measuredTotalTokens: 900,
      fixedOverheadTokens: 0,
      policy: POLICY,
      hasExistingCompaction: true,
      compactionLatched: true,
      coveredMessageIds: covered,
      reason: "pressure",
    });
    expect(plan.kind).toBe("none");
    if (plan.kind === "none") expect(plan.reason).toBe("already_compacted_span");
  });

  it("treats FRESH growth as independently eligible, even while latched", () => {
    // The defect this replaces: the latch short-circuited every later plan, so a
    // long conversation compacted exactly once and then grew to the budget and was
    // rejected. New messages past the covered ids are new history, so they must
    // compact on their own.
    const messages = conversation(20);
    const covered = messages.slice(0, 10).map((m) => (m as { id?: string }).id ?? "");
    const plan = planCompaction({
      messages,
      measuredTokens: messages.map(() => TOKENS_PER_MESSAGE),
      usableInputTokens: 1000,
      measuredTotalTokens: 900,
      fixedOverheadTokens: 0,
      policy: POLICY,
      hasExistingCompaction: true,
      compactionLatched: true,
      coveredMessageIds: covered,
      reason: "pressure",
    });
    expect(plan.kind).toBe("compact");
  });

  it("compacts again once the latch has been released", () => {
    const messages = conversation(20);
    const plan = planCompaction({
      messages,
      measuredTokens: messages.map(() => TOKENS_PER_MESSAGE),
      usableInputTokens: 1000,
      measuredTotalTokens: 900,
      fixedOverheadTokens: 0,
      policy: POLICY,
      hasExistingCompaction: true,
      compactionLatched: false,
      reason: "pressure",
    });
    expect(plan.kind).toBe("compact");
  });

  it("does not compact below the trigger, latched or not", () => {
    const messages = conversation(20);
    for (const compactionLatched of [false, true]) {
      const plan = planCompaction({
        messages,
        measuredTokens: messages.map(() => TOKENS_PER_MESSAGE),
        usableInputTokens: 1000,
        measuredTotalTokens: 500,
    fixedOverheadTokens: 0,
        policy: POLICY,
        hasExistingCompaction: compactionLatched,
        compactionLatched,
        reason: "pressure",
      });
      expect(plan.kind).toBe("none");
    }
  });

  it("reaches a stable state instead of oscillating", () => {
    // Repeated turns inside the band must not pay a summarisation call each time.
    const messages = conversation(20);
    let compactions = 0;
    for (let turn = 0; turn < 10; turn += 1) {
      const usage = 620 + (turn % 3) * 10; // inside [release, trigger]
      const plan = planCompaction({
        messages,
        measuredTokens: messages.map(() => TOKENS_PER_MESSAGE),
        usableInputTokens: 1000,
        measuredTotalTokens: usage,
      fixedOverheadTokens: 0,
        policy: POLICY,
        hasExistingCompaction: compactions > 0,
        compactionLatched: compactions > 0,
        reason: "pressure",
      });
      if (plan.kind === "compact") compactions += 1;
    }
    expect(compactions).toBe(0);
  });
});

// ─── Part 4/5: retained set and tool boundaries ─────────────────────────────

describe("the removable span never reaches into the current turn", () => {
  it("places the cut strictly before the last user message", () => {
    const messages = conversation(5);
    const lastUser = currentTurnStartIndex(messages);
    const cut = latestCutIndexBefore(messages);
    expect(cut).toBeGreaterThanOrEqual(0);
    expect(cut).toBeLessThan(lastUser);
  });

  it("returns no cut point when the conversation has no user turn", () => {
    expect(latestCutIndexBefore([])).toBe(-1);
    expect(latestCutIndexBefore([assistant("a0", "x")])).toBe(-1);
  });

  it("never compacts a conversation that is only a user message", () => {
    const plan = planOver([user("u1", "hello")], 900);
    expect(plan.kind).toBe("none");
    if (plan.kind === "none") expect(plan.reason).toBe("no_compactable_span");
  });

  it("retains the current user request verbatim", () => {
    const messages = [...conversation(20), user("current", "THE LIVE QUESTION")];
    const plan = planOver(messages, 900);
    expect(plan.kind).toBe("compact");
    if (plan.kind !== "compact") return;
    expect(plan.spanEndIndex).toBeLessThan(messages.length - 1);

    const applied = applyCompaction({ messages, plan, record: record() });
    const live = applied.find((m) => m.id === "current");
    expect(live).toBeDefined();
    expect(JSON.stringify(live)).toContain("THE LIVE QUESTION");
  });

  it("retains a minimum recent tail regardless of size", () => {
    const messages = conversation(20);
    const plan = planOver(messages, 900);
    expect(plan.kind).toBe("compact");
    if (plan.kind !== "compact") return;
    // The tail floor is 6, so at least 6 messages survive the span.
    const survivors = messages.length - plan.spanLength;
    expect(survivors).toBeGreaterThanOrEqual(POLICY.minRetainedTail);
  });

  it("never splits a tool call from its result", () => {
    // The span must not end between a call and its result. `latestCutIndexBefore`
    // lands on an ASSISTANT message, and a completed tool pair lives inside one,
    // so the pair is structurally atomic with respect to the cut.
    const messages: UIMessage[] = [
      user("u0", "q0"),
      toolTurn("a0", "tc0", "content-0"),
      user("u1", "q1"),
      toolTurn("a1", "tc1", "content-1"),
      user("u2", "q2"),
      toolTurn("a2", "tc2", "content-2"),
      user("u3", "THE LIVE QUESTION"),
    ];
    const cut = latestCutIndexBefore(messages);
    const cutMessage = messages[cut];
    expect(cutMessage).toBeDefined();
    // Whatever the cut lands on, every tool call at or before it has a result.
    const parts = ((cutMessage as { parts?: Array<Record<string, unknown>> }).parts ?? []) as Array<Record<string, unknown>>;
    for (const part of parts) {
      if (typeof part.type === "string" && part.type.startsWith("tool-")) {
        expect(part.output, `tool call at the cut must have its result`).toBeDefined();
      }
    }
  });

  it("never removes an unresolved approval, because it sits at or after the last user turn", () => {
    // This is the structural argument, tested. `pruneStaleMessages` preserves an
    // approval only when its index >= lastUserIndex, so every unresolved approval
    // lives in the region compaction is forbidden to touch.
    const messages: UIMessage[] = [
      user("u0", "old question"),
      assistant("a0", "old answer"),
      user("u1", "delete the file"),
      approvalPaused("a1", "tc-approval", "ap-1"),
    ];
    const lastUser = currentTurnStartIndex(messages);
    const approvalIndex = messages.findIndex((m) => m.id === "a1");
    expect(approvalIndex).toBeGreaterThanOrEqual(lastUser);

    const plan = planOver(messages, 900);
    // Either no compaction, or the span ends strictly before the approval.
    if (plan.kind === "compact") {
      expect(plan.spanEndIndex).toBeLessThan(approvalIndex);
    } else {
      expect(plan.kind).toBe("none");
    }
  });

  it("leaves an approval-paused turn entirely intact", () => {
    const messages: UIMessage[] = [
      ...conversation(10),
      user("uLive", "delete it"),
      approvalPaused("aLive", "tc-live", "ap-live"),
    ];
    const plan = planOver(messages, 900);
    const applied =
      plan.kind === "compact" ? applyCompaction({ messages, plan, record: record() }) : messages;
    const live = applied.find((m) => m.id === "aLive");
    expect(live).toBeDefined();
    expect(JSON.stringify(live)).toContain("ap-live");
  });
});

// ─── Part 8/9: provenance ──────────────────────────────────────────────────

describe("an injected block carries explicit provenance", () => {
  it("states its origin and size in the text the model receives", () => {
    const rendered = renderCompactedMessages(record());
    expect(rendered).toHaveLength(1);
    const text = String((rendered[0] as { parts: Array<{ text: string }> }).parts[0].text);
    expect(text).toContain("compacted history");
    expect(text).toContain("model_generated_summary");
    // It must not be mistakable for a user instruction.
    expect(text).toContain("not new user input");
  });

  it("is injected as a single user-role block at a stable position", () => {
    const messages = conversation(20);
    const plan = planOver(messages, 900);
    if (plan.kind !== "compact") throw new Error("expected a plan");
    const applied = applyCompaction({ messages, plan, record: record() });
    const summary = applied.find((m) => String(m.id).startsWith("tbai-compaction:"));
    expect(summary).toBeDefined();
    expect((summary as { role?: string }).role).toBe("user");
    // The whole span collapses to exactly one block.
    expect(applied.length).toBe(messages.length - plan.spanLength + 1);
  });

  it("renders deterministically — the same record always yields the same bytes", () => {
    expect(JSON.stringify(renderCompactedMessages(record()))).toBe(
      JSON.stringify(renderCompactedMessages(record())),
    );
  });

  it("never puts prompt content into the span fingerprint", () => {
    const messages = conversation(4);
    const fingerprint = spanFingerprint(messages, 0, 3);
    expect(fingerprint).not.toContain("question 0");
    expect(fingerprint).not.toContain("answer 0");
    expect(fingerprint).toMatch(/^span:[0-9a-f]{8}:\d+$/);
  });
});

// ─── Part 7: summary bounds ────────────────────────────────────────────────

describe("the summariser transcript is bounded and never sees the whole conversation", () => {
  it("records tool outcomes rather than raw payloads", () => {
    const turn = toolTurn("a0", "tc0", "x".repeat(50_000));
    const transcript = renderSpanTranscript([turn]);
    expect(transcript).toContain("read_file");
    expect(transcript).toContain("output-available");
    // The 50k payload must NOT be transcribed verbatim.
    expect(transcript.length).toBeLessThan(500);
  });

  it("transcribes text parts faithfully", () => {
    const transcript = renderSpanTranscript([user("u0", "hello world"), assistant("a0", "hi there")]);
    expect(transcript).toContain("USER: hello world");
    expect(transcript).toContain("ASSISTANT: hi there");
  });
});

// ─── Part 13: durability ───────────────────────────────────────────────────

describe("a compaction is applied from the durable record, not re-summarised", () => {
  const stored = record({
    spanStartIndex: 0,
    spanEndIndex: 3,
    coveredMessageIds: ["u0", "a0", "u1", "a1"],
  });

  it("re-applies to a conversation that still contains the recorded span", () => {
    const messages = [...conversation(3), user("live", "next question")];
    const result = applyExistingCompaction({ messages, record: stored });
    expect(result.applied).toBe(true);
    expect(result.messages).toHaveLength(messages.length - 4 + 1);
    expect(JSON.stringify(result.messages)).toContain("SUMMARY");
  });

  it("produces IDENTICAL output on reload — durability", () => {
    const messages = [...conversation(3), user("live", "next question")];
    const first = applyExistingCompaction({ messages, record: stored });
    const second = applyExistingCompaction({ messages, record: stored });
    expect(JSON.stringify(first.messages)).toBe(JSON.stringify(second.messages));
  });

  it("refuses to apply when the recorded span is absent", () => {
    // A summary of a span that is no longer in the conversation would be a
    // fabrication.
    const messages = [user("brand-new", "different conversation")];
    const result = applyExistingCompaction({ messages, record: stored });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("span_not_present");
    expect(result.messages).toHaveLength(1);
  });

  it("refuses after a regenerate that drops covered messages", () => {
    const full = [...conversation(3), user("live", "q")];
    const regenerated = [user("u9", "regenerated"), user("live", "q")];
    expect(applyExistingCompaction({ messages: full, record: stored }).applied).toBe(true);
    // The covered ids are gone, so the record must not be applied blindly.
    const result = applyExistingCompaction({ messages: regenerated, record: stored });
    expect(result.applied).toBe(false);
  });

  it("is a no-op when no record exists", () => {
    const messages = conversation(3);
    const result = applyExistingCompaction({ messages, record: undefined });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("no_record");
    expect(result.messages).toHaveLength(messages.length);
  });
});

// ─── Part 15: branching ────────────────────────────────────────────────────

describe("branch topology is not flattened", () => {
  it("locates the span by id, not by position", () => {
    // The client re-posts the conversation and positions shift as turns append.
    // A positional lookup would apply a summary to the wrong messages.
    const stored = record({
      coveredMessageIds: ["u1", "a1"],
      spanStartIndex: 2,
      spanEndIndex: 3,
    });
    const shifted = [user("u0", "q0"), assistant("a0", "a0"), user("u1", "q1"), assistant("a1", "a1"), user("live", "q")];
    const result = applyExistingCompaction({ messages: shifted, record: stored });
    expect(result.applied).toBe(true);
    // u0/a0 survived because they are BEFORE the covered ids.
    expect(JSON.stringify(result.messages)).toContain("q0");
    expect(JSON.stringify(result.messages)).not.toContain("q1");
  });

  it("does not apply when covered ids appear in a different order (a rebase)", () => {
    const stored = record({ coveredMessageIds: ["u1", "a1"] });
    const reordered = [user("a1", "answer"), user("u1", "question"), user("live", "q")];
    const result = applyExistingCompaction({ messages: reordered, record: stored });
    expect(result.applied).toBe(false);
  });
});

// ─── determinism ────────────────────────────────────────────────────────────

describe("the same inputs always produce the same decision", () => {
  it("produces an identical plan across repeated calls", () => {
    const messages = conversation(20);
    const first = planOver(messages, 900);
    const second = planOver(messages, 900);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("produces an identical fingerprint for the same span", () => {
    const messages = conversation(10);
    expect(spanFingerprint(messages, 0, 4)).toBe(spanFingerprint(messages, 0, 4));
    expect(spanFingerprint(messages, 0, 4)).not.toBe(spanFingerprint(messages, 0, 5));
  });
});

// ─── Phase 3 interaction ────────────────────────────────────────────────────

describe("compaction does not leak provider specifics", () => {
  it("the compaction module names no provider and no cache syntax", async () => {
    const { readFileSync } = await import("node:fs");
    const dir = new URL(".", import.meta.url);
    for (const file of ["contract.ts", "summarize.ts", "orchestrate.ts"]) {
      const source = readFileSync(new URL(file, dir), "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
        .join("\n");
      expect(source, `${file} must not name a provider`).not.toMatch(
        /provider(Type)?\s*[!=]==?\s*['"](anthropic|openai|google|ollama)['"]/,
      );
      expect(source, `${file} must not contain cache wire syntax`).not.toMatch(
        /cache_control|prompt_cache_options|promptCacheKey|cacheControl/,
      );
      // The summariser model is injected, never constructed here.
      expect(source, `${file} must not construct a provider model`).not.toMatch(
        /createAnthropic|createOpenAI|createGoogle|getModel/,
      );
    }
  });
});
