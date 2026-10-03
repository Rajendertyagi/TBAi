/**
 * Request-side reasoning reduction.
 *
 * Reasoning is a declared, reducible category (`REQUEST_REDUCIBLE_CATEGORIES`)
 * and the single largest unbounded consumer in a long Direct conversation. These
 * tests pin the property the whole thing exists for: reducing reasoning LOWERS
 * the model-visible estimate, without touching any load-bearing part (visible text,
 * tool calls, tool results, approvals) and without mutating the input.
 */

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import {
  describeToolResultReduction,
  measureMessages,
  reduceToolResults,
  REASONING_RETAIN_LAST_MESSAGES,
  REQUEST_REASONING_MAX_CHARS,
} from "./index";

/** An assistant message holding ONLY a reasoning trace. */
function reasoningMsg(id: string, reasoning: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "reasoning", text: reasoning } as unknown as Record<string, unknown>],
  } as unknown as UIMessage;
}

/** An assistant message with a reasoning trace AND a visible text reply. */
function reasoningPlusText(id: string, reasoning: string, text: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      { type: "reasoning", text: reasoning } as unknown as Record<string, unknown>,
      { type: "text", text } as unknown as Record<string, unknown>,
    ],
  } as unknown as UIMessage;
}

/** An assistant message with a tool call whose result is present. */
function toolMsg(id: string, toolCallId: string, output: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-read",
        toolCallId,
        state: "output-available",
        input: { path: "x" },
        output,
      } as unknown as Record<string, unknown>,
    ],
  } as unknown as UIMessage;
}

function userMsg(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}

/** How many reasoning parts survive a reduction of this list. */
function countReasoning(messages: readonly UIMessage[]): number {
  let n = 0;
  for (const m of messages) {
    const parts = (m as { parts?: Array<{ type?: string }> }).parts ?? [];
    for (const p of parts) {
      if (p.type === "reasoning") n += 1;
    }
  }
  return n;
}

describe("reasoning reduction: it lowers the model-visible context", () => {
  it("drops reasoning from old turns and keeps it in the most recent", () => {
    const messages = [
      reasoningMsg("old1", "R".repeat(3000)),
      reasoningMsg("old2", "R".repeat(3000)),
      toolMsg("m1", "c1", "ok"),
      userMsg("u1", "hi"),
      reasoningPlusText("cur", "R".repeat(3000), "done"),
    ];
    // Keep reasoning only on the last message.
    const { messages: next, report } = reduceToolResults(messages, { reasoningRetainLast: 1 });

    // The two old reasoning-only messages are gone; the current one survives.
    expect(countReasoning(next)).toBe(1);
    expect(report.reducedReasoningParts).toBeGreaterThan(0);
    expect(report.removedReasoningChars).toBeGreaterThan(0);
    const ids = next.map((m) => (m as { id?: string }).id);
    expect(ids).not.toContain("old1");
    expect(ids).not.toContain("old2");
    // Tool result and text are preserved, untouched.
    const kept = next.find((m) => (m as { id?: string }).id === "m1");
    expect(kept).toBeDefined();
    expect(((kept as { parts: Array<Record<string, unknown>> }).parts[0] as Record<string, unknown>).toolCallId).toBe("c1");
    const current = next.find((m) => (m as { id?: string }).id === "cur");
    const currentParts = (current as { parts: Array<Record<string, unknown>> }).parts;
    expect(currentParts.find((p) => p.type === "text")?.text).toBe("done");
    expect(currentParts.find((p) => p.type === "reasoning")).toBeDefined();
  });

  it("caps the retained recent reasoning to the request ceiling", () => {
    const huge = "R".repeat(REQUEST_REASONING_MAX_CHARS * 3);
    const { messages, report } = reduceToolResults([reasoningMsg("a", huge)]);
    expect(report.reducedReasoningParts).toBe(1);
    const part = (messages[0] as { parts: Array<Record<string, unknown>> }).parts[0] as Record<string, unknown>;
    expect(String(part.text).length).toBeLessThanOrEqual(REQUEST_REASONING_MAX_CHARS + 200); // notice slack
    expect(String(part.text)).toContain("truncated");
  });

  it("actually lowers the measured estimate, not just the part count", () => {
    const big = "R".repeat(20000);
    const messages = [
      reasoningMsg("old", big),
      reasoningMsg("old2", big),
      userMsg("u", "hi"),
      reasoningPlusText("cur", "small", "answer"),
    ];
    const before = measureMessages({ messages, currentTurnIds: [], retainedIds: [] }).estimatedTokens;
    const { messages: next } = reduceToolResults(messages);
    const after = measureMessages({ messages: next, currentTurnIds: [], retainedIds: [] }).estimatedTokens;
    expect(after).toBeLessThan(before);
    // The visible reply and the user turn survive the reduction.
    const ids = next.map((m) => (m as { id?: string }).id);
    expect(ids).toContain("cur");
    expect(ids).toContain("u");
  });

  it("leaves a conversation with no reasoning untouched (no-op)", () => {
    const messages = [toolMsg("a", "c1", "x"), userMsg("u", "hi")];
    const { messages: next, report } = reduceToolResults(messages);
    expect(next).toHaveLength(2);
    expect(report.reducedReasoningParts).toBe(0);
    expect(report.removedReasoningChars).toBe(0);
  });

  it("honours the configured retained-tail window", () => {
    const msgs = [
      reasoningMsg("a", "R".repeat(2000)),
      reasoningMsg("b", "R".repeat(2000)),
      reasoningMsg("c", "R".repeat(2000)),
      reasoningMsg("d", "R".repeat(2000)),
      reasoningMsg("e", "R".repeat(2000)),
      reasoningMsg("f", "R".repeat(2000)),
    ];
    // Keep reasoning only on the last 2.
    const { messages: next } = reduceToolResults(msgs, { reasoningRetainLast: 2 });
    expect(countReasoning(next)).toBe(2);
  });
});

describe("reasoning reduction is a first-class reducible category", () => {
  it("is declared reducible AND actually reduced", () => {
    // The declared list and the implementation must agree (see budget.test.ts
    // "never claims a category reduce.ts does not implement").
    expect(REASONING_RETAIN_LAST_MESSAGES).toBeGreaterThan(0);
    expect(REQUEST_REASONING_MAX_CHARS).toBeGreaterThan(0);

    const big = "R".repeat(REQUEST_REASONING_MAX_CHARS * 2);
    const report = reduceToolResults([reasoningMsg("a", big), userMsg("u", "x")]).report;
    // A reasoning-only reduction is still a real, applied reduction.
    expect(describeToolResultReduction(report)).toEqual({ kind: "exhausted", reason: "applied" });
  });

  it("does not mutate the caller's messages", () => {
    const big = "R".repeat(20000);
    const original = reasoningMsg("a", big);
    const snapshot = JSON.stringify(original);
    reduceToolResults([original, userMsg("u", "x")]);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
