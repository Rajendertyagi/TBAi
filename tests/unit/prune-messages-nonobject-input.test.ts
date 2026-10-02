/**
 * Generation-400 regression — a tool part's `input` must be a REPLAYABLE SHAPE.
 *
 * ## The defect this pins
 *
 * Generation-400's replayability repair treated `input !== undefined` as
 * "usable arguments":
 *
 *   export function hasUsableToolInput(part) {
 *     if (part.input !== undefined) return true;   // ← accepts null/[]/"x"/42/true
 *     …
 *   }
 *
 * The AI SDK substitutes the missing argument with
 * `part.input ?? part.rawInput` (`ai@7.0.93` `convertToModelMessages`), and
 * `@ai-sdk/openai-compatible@3.0.44` serializes whatever it received as
 * `arguments: JSON.stringify(part.input)`. `??` treats `null` as absent, so a
 * part carrying `input: null` falls straight through to `rawInput` and puts
 * text on the wire — the exact production defect the repair was written to
 * eliminate, reachable again through `input: null` instead of an absent key.
 *
 * The same hole covers every other non-object `input`: an array, a string, a
 * number or a boolean all reach the provider as a JSON array/string/number/
 * boolean where an OpenAI-compatible provider requires an object. Generation
 * was observed answering HTTP 400 for each of these shapes.
 *
 * ## The rule these cases assert
 *
 * A tool part that can become a provider tool call must carry a PLAIN OBJECT
 * as `input` (the same shape the file already defines as "a JSON object and
 * nothing else"), or a legacy `rawInput` that recovers to one. Anything else is
 * unreplayable and is dropped together with the tool result the SDK synthesizes
 * from the same part — never paired, never orphaned.
 *
 * Approval semantics are unchanged and are asserted here because they are the
 * constraint a shape fix must not break: an open gate is filtered before
 * conversion and survives whatever its `input` looks like; a RESPONDED
 * approval is replayed and therefore needs usable arguments.
 */
import { describe, it, expect } from "bun:test";
import type { UIMessage } from "ai";
import { convertToModelMessages } from "ai";
import { pruneStaleMessages, hasUsableToolInput } from "../../src/lib/prune-messages";

/** The verbatim truncated argument text from the failing production run. */
const PRODUCTION_RAW_INPUT = '{"path": "project-console/projects.json"';

const user = (text: string, id = "u1"): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

const assistant = (id: string, parts: unknown[]): UIMessage =>
  ({ id, role: "assistant", parts }) as UIMessage;

const toolPartsOf = (message: UIMessage | undefined): Array<Record<string, unknown>> =>
  (((message as { parts?: unknown[] } | undefined)?.parts ?? []) as Array<Record<string, unknown>>).filter(
    (p) => String(p.type).startsWith("tool-"),
  );

/** Convert exactly as the production seam does and return the tool-call inputs. */
async function toolCallInputs(messages: UIMessage[]): Promise<unknown[]> {
  const modelMessages = await convertToModelMessages(messages, {
    tools: {},
    ignoreIncompleteToolCalls: true,
  });
  return modelMessages.flatMap((m) =>
    m.role === "assistant" && Array.isArray(m.content)
      ? m.content.filter((p) => p.type === "tool-call").map((p) => (p as { input: unknown }).input)
      : [],
  );
}

/** Prune then convert — the production order. */
async function prunedToolCallInputs(
  history: UIMessage[],
): Promise<{ inputs: unknown[]; toolMessages: number; stats: ReturnType<typeof pruneStaleMessages>["stats"] }> {
  const { messages, stats } = pruneStaleMessages(history);
  const modelMessages = await convertToModelMessages(messages, {
    tools: {},
    ignoreIncompleteToolCalls: true,
  });
  return {
    inputs: await toolCallInputs(messages),
    toolMessages: modelMessages.filter((m) => m.role === "tool").length,
    stats,
  };
}

const poisonPart = (id: string, overrides: Record<string, unknown> = {}) => ({
  type: "tool-write_file",
  toolCallId: id,
  state: "output-error",
  rawInput: PRODUCTION_RAW_INPUT,
  errorText: "A tool call failed. See diagnostics and retry.",
  ...overrides,
});

// ── 1–5: every non-object `input` is unusable ─────────────────────────────────
describe("Generation-400: non-object input is not replayable", () => {
  it.each([
    ["null", null],
    ["an array", [1, 2, 3]],
    ["an empty array", []],
    ["a string", "not-an-object"],
    ["an empty string", ""],
    ["a number", 42],
    ["a boolean", true],
  ])("input = %s is NOT usable, is dropped, and reaches no provider payload", async (_label, badInput) => {
    const id = `call_${_label}`;
    const part = poisonPart(id, { input: badInput });

    expect(hasUsableToolInput(part)).toBe(false);

    const { inputs, toolMessages, stats } = await prunedToolCallInputs([
      user("write it"),
      assistant("a1", [{ type: "step-start" }, { type: "text", text: "Creating the file now." }, part]),
      user("continue", "u2"),
    ]);

    expect(stats.removedToolParts).toEqual([id]);
    // Absent from the provider payload, and no synthesized result survives it.
    expect(inputs).toHaveLength(0);
    expect(toolMessages).toBe(0);
  });

  it("input: null with a VALID object rawInput is recovered and promoted, not dropped", async () => {
    // Lenient recovery must still win over the stricter shape check: these
    // arguments are genuine, so history is preserved rather than rewritten.
    const part = poisonPart("call_recover", {
      input: null,
      rawInput: '{"path":"notes.txt","content":"hello"}',
    });
    expect(hasUsableToolInput(part)).toBe(true);

    const { messages, stats } = pruneStaleMessages([
      user("hi"),
      assistant("a1", [{ type: "step-start" }, part]),
    ]);

    expect(stats.removedToolParts).toEqual([]);
    const kept = toolPartsOf(messages[1])[0];
    // Promoted to a plain object and the unparsed text dropped, so exactly one
    // authoritative source of arguments reaches the wire.
    expect(kept.input).toEqual({ path: "notes.txt", content: "hello" });
    expect("rawInput" in kept).toBe(false);

    const inputs = await toolCallInputs(messages);
    expect(inputs).toEqual([{ path: "notes.txt", content: "hello" }]);
  });
});

// ── 6–8: the accepted shapes are unchanged ────────────────────────────────────
describe("Generation-400: usable shapes are preserved", () => {
  it("6. a valid input object is preserved and reaches the wire", async () => {
    const part = {
      type: "tool-write_file",
      toolCallId: "call_valid",
      state: "output-available",
      input: { path: "a.txt", content: "x" },
      output: { ok: true },
    };
    const { inputs, stats } = await prunedToolCallInputs([
      user("hi"),
      assistant("a1", [{ type: "step-start" }, part]),
      user("next", "u2"),
    ]);
    expect(stats.removedToolParts).toEqual([]);
    expect(inputs).toEqual([{ path: "a.txt", content: "x" }]);
  });

  it("7. a valid object rawInput is promoted to input", async () => {
    const part = poisonPart("call_legacy", { rawInput: '{"path":"a.txt","content":"x"}' });
    const { messages, stats } = pruneStaleMessages([user("hi"), assistant("a1", [{ type: "step-start" }, part])]);
    expect(stats.removedToolParts).toEqual([]);
    expect(toolPartsOf(messages[1])[0].input).toEqual({ path: "a.txt", content: "x" });
  });

  it("8. a malformed rawInput is dropped", async () => {
    const { stats } = pruneStaleMessages([
      user("hi"),
      assistant("a1", [{ type: "step-start" }, poisonPart("call_bad")]),
    ]);
    expect(stats.removedToolParts).toEqual(["call_bad"]);
  });

  it("a part with no input and no rawInput is dropped", async () => {
    const { stats } = pruneStaleMessages([
      user("hi"),
      assistant("a1", [{ type: "step-start" }, { type: "tool-x", toolCallId: "call_none", state: "output-error", errorText: "e" }]),
    ]);
    expect(stats.removedToolParts).toEqual(["call_none"]);
  });

  it("recovery does not mutate the caller's persisted part", () => {
    const part = poisonPart("call_legacy", { rawInput: '{"path":"a.txt"}' });
    pruneStaleMessages([user("hi"), assistant("a1", [{ type: "step-start" }, part])]);
    expect(part.rawInput).toBe('{"path":"a.txt"}');
    expect("input" in part).toBe(false);
  });
});

// ── 9–11: approval semantics must not regress ────────────────────────────────
describe("Generation-400: approval semantics survive the shape fix", () => {
  it("9. approval-requested with valid input is preserved", () => {
    const gate = {
      type: "tool-write_file",
      toolCallId: "call_gate",
      state: "approval-requested",
      input: { path: "a.txt" },
      approval: { id: "ap-1" },
    };
    const { messages, stats } = pruneStaleMessages([user("hi"), assistant("a1", [{ type: "step-start" }, gate])]);
    expect(stats.removedToolParts).toEqual([]);
    expect(stats.preservedApprovals).toEqual(["call_gate"]);
    expect(toolPartsOf(messages[1])[0]).toEqual(gate);
  });

  it("approval-requested survives ANY input shape — an open gate is never a wire risk", () => {
    // An open gate is filtered before conversion, so it never becomes a
    // provider tool call. Dropping it would break the approval-preservation
    // invariant to fix a defect this state cannot cause.
    for (const badInput of [undefined, null, [1], "text", 7, true]) {
      const gate = {
        type: "tool-write_file",
        toolCallId: "call_gate_shape",
        state: "approval-requested",
        approval: { id: "ap-shape" },
        ...(badInput === undefined ? {} : { input: badInput }),
      };
      const { messages, stats } = pruneStaleMessages([user("hi"), assistant("a1", [{ type: "step-start" }, gate])]);
      expect(stats.removedToolParts).toEqual([]);
      expect(stats.preservedApprovals).toEqual(["call_gate_shape"]);
      expect(toolPartsOf(messages[1])).toHaveLength(1);
    }
  });

  it("10. approval-responded with valid input is preserved", () => {
    const approved = {
      type: "tool-write_file",
      toolCallId: "call_appr",
      state: "approval-responded",
      input: { path: "a.txt" },
      approval: { id: "ap-2", approved: true },
    };
    const { messages, stats } = pruneStaleMessages([user("hi"), assistant("a1", [{ type: "step-start" }, approved])]);
    expect(stats.removedToolParts).toEqual([]);
    expect(stats.preservedApprovals).toEqual(["call_appr"]);
    expect(toolPartsOf(messages[1])[0]).toEqual(approved);
  });

  it("11. approval-responded with invalid input is unreplayable and removed", async () => {
    for (const badInput of [null, [1, 2], "text", 42, true, undefined]) {
      const id = `call_appr_bad_${String(badInput)}`;
      const part = {
        type: "tool-write_file",
        toolCallId: id,
        state: "approval-responded",
        approval: { id: "ap-3", approved: true },
        ...(badInput === undefined ? {} : { input: badInput }),
      };
      const { inputs, toolMessages, stats } = await prunedToolCallInputs([
        user("hi"),
        assistant("a1", [{ type: "step-start" }, part]),
      ]);
      // A RESPONDED approval IS replayed, so without usable arguments the SDK
      // emits a tool call whose `arguments` is absent or not an object.
      expect(stats.removedToolParts).toEqual([id]);
      expect(inputs).toHaveLength(0);
      expect(toolMessages).toBe(0);
    }
  });

  it("an approval still expires once a later user turn moves past it", () => {
    const approved = {
      type: "tool-write_file",
      toolCallId: "call_expired",
      state: "approval-responded",
      input: { path: "a.txt" },
      approval: { id: "ap-4", approved: true },
    };
    const { stats } = pruneStaleMessages([user("hi"), assistant("a1", [{ type: "step-start" }, approved]), user("next", "u2")]);
    expect(stats.removedToolParts).toEqual(["call_expired"]);
    expect(stats.preservedApprovals).toEqual([]);
  });
});

// ── 12: pairing ──────────────────────────────────────────────────────────────
describe("Generation-400: no orphan tool message can survive", () => {
  it("a dropped call takes its synthesized tool result with it", async () => {
    const history = [
      user("write it"),
      assistant("a1", [
        { type: "step-start" },
        { type: "text", text: "mixed" },
        poisonPart("call_null", { input: null }),
        { type: "tool-x", toolCallId: "call_ok", state: "output-available", input: { p: 1 }, output: { ok: true } },
      ]),
      user("continue", "u2"),
    ];
    const { messages, stats } = pruneStaleMessages(history);
    const modelMessages = await convertToModelMessages(messages, { tools: {}, ignoreIncompleteToolCalls: true });

    expect(stats.removedToolParts).toEqual(["call_null"]);

    const callIds: string[] = [];
    const resultIds: string[] = [];
    for (const m of modelMessages) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const p of m.content) if (p.type === "tool-call") callIds.push((p as { toolCallId: string }).toolCallId);
      }
      if (m.role === "tool" && Array.isArray(m.content)) {
        for (const p of m.content) resultIds.push((p as { toolCallId: string }).toolCallId);
      }
    }
    // Exactly paired: every call has a result, every result has a call.
    expect(callIds.sort()).toEqual(resultIds.sort());
    // The healthy sibling is untouched; the broken one is gone from both.
    expect(callIds).toContain("call_ok");
    expect(callIds).not.toContain("call_null");
    expect(resultIds).not.toContain("call_null");
  });

  it("every occurrence of a broken id is removed across messages", async () => {
    const { inputs, toolMessages, stats } = await prunedToolCallInputs([
      user("hi"),
      assistant("a1", [{ type: "step-start" }, poisonPart("dup", { input: null })]),
      assistant("a2", [{ type: "step-start" }, poisonPart("dup", { input: null })]),
    ]);
    expect(stats.removedToolParts).toEqual(["dup"]);
    expect(inputs).toHaveLength(0);
    expect(toolMessages).toBe(0);
  });
});