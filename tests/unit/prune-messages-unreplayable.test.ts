/**
 * Replayable-history invariant — the `unreplayable` tool lifecycle.
 *
 * ## The production failure this pins
 *
 * On 2026-10-02 a Direct conversation against an OpenAI-compatible gateway
 * (`agnes`, custom / chat-completions) became permanently unusable: 18
 * consecutive sends answered HTTP 400 and the user was told "Generation failed.
 * Retry or pick another provider/model."
 *
 * The gateway streamed a `write_file` tool call and cut its arguments
 * mid-object. The AI SDK could not parse them, so it recorded the interaction as
 *
 *   { type: "tool-write_file", toolCallId: "call_92b1…",
 *     state: "output-error", input: undefined,
 *     rawInput: '{"path": "project-console/projects.json"' }
 *
 * The SDK substitutes `rawInput` for the missing `input`
 * (`ai@7.0.93` `convertToModelMessages`), and `@ai-sdk/openai-compatible@3.0.44`
 * then serializes it as `arguments: JSON.stringify(part.input)` — so the wire
 * carried a JSON *string* where a JSON *object* is required. Re-sending the
 * stored history reproduced the identical rejection forever.
 *
 * ## What these cases assert
 *
 * The application's history-repair seam is the only thing standing between that
 * persisted shape and the provider, so the invariant lives in
 * `pruneStaleMessages` (via `hasUsableToolInput`): before conversion, every tool
 * part that CAN become a provider tool call must carry usable arguments.
 *
 * The approval rules are asserted alongside it because they are the constraint
 * most easily broken by a fix like this one: valid approval state must survive,
 * and an open gate must never be dropped merely because some other case is
 * malformed.
 */
import { describe, it, expect } from "bun:test";
import type { UIMessage } from "ai";
import { convertToModelMessages } from "ai";
import { pruneStaleMessages } from "../../src/lib/prune-messages";

const user = (text: string): UIMessage => ({
  id: `u-${text}`,
  role: "user",
  parts: [{ type: "text", text }],
});

const assistant = (id: string, parts: unknown[]): UIMessage =>
  ({ id, role: "assistant", parts }) as UIMessage;

/** A tool part with PARSED arguments — always replayable. */
const parsed = (toolCallId: string, extra: Record<string, unknown> = {}) => ({
  type: "tool-write_file",
  toolCallId,
  input: { path: "a.txt", content: "x" },
  ...extra,
});

/** The exact production shape: `output-error`, no input, truncated rawInput. */
const PRODUCTION_RAW_INPUT = '{"path": "project-console/projects.json"';
const poisonedPart = (toolCallId = "call_92b1") => ({
  type: "tool-write_file",
  toolCallId,
  state: "output-error",
  rawInput: PRODUCTION_RAW_INPUT,
  errorText: "A tool call failed. See diagnostics and retry.",
});

const partsOf = (message: UIMessage | undefined): unknown[] =>
  ((message as { parts?: unknown[] } | undefined)?.parts ?? []) as unknown[];

const toolPartsOf = (message: UIMessage | undefined): Array<Record<string, unknown>> =>
  partsOf(message).filter((p) => String((p as { type?: string }).type).startsWith("tool-")) as Array<
    Record<string, unknown>
  >;

// ── The exact production shape ────────────────────────────────────────────────
describe("unreplayable: the exact production poisoned part", () => {
  it("is dropped, together with its synthesized tool result, and leaves the turn's text", () => {
    const history = [
      user("write it"),
      assistant("a1", [
        { type: "step-start" },
        { type: "text", text: "Creating the file now." },
        poisonedPart(),
      ]),
      user("?"),
    ];
    const { messages, stats } = pruneStaleMessages(history);

    expect(stats.removedToolParts).toEqual(["call_92b1"]);
    expect(messages.length).toBe(3);
    // The assistant turn survives on its TEXT; only the broken call is gone.
    expect(partsOf(messages[1]).map((p) => (p as { type: string }).type)).toEqual([
      "step-start",
      "text",
    ]);
  });

  it("removes an assistant turn that held nothing but the poisoned call", () => {
    const { messages, stats } = pruneStaleMessages([
      user("write it"),
      assistant("a1", [{ type: "step-start" }, poisonedPart("call_only")]),
      user("next"),
    ]);
    expect(stats.removedToolParts).toEqual(["call_only"]);
    expect(stats.removedEmptyTurns).toBe(1);
    expect(messages.length).toBe(1);
    expect((messages[0].parts as { text: string }[]).map((p) => p.text)).toEqual(["write it", "next"]);
  });

  it("converts to model messages with NO tool call and NO orphan tool result", async () => {
    // The end-to-end assertion: the malformed shape must not merely be dropped
    // from the pruned list, it must be ABSENT from the provider payload. The
    // AI SDK derives the tool-call part and the `tool` role message from the
    // SAME parts, so removing the part removes both — asserted here rather than
    // assumed.
    const history = [
      user("write it"),
      assistant("a1", [{ type: "step-start" }, { type: "text", text: "ok" }, poisonedPart()]),
      user("?"),
    ];
    const { messages } = pruneStaleMessages(history);
    const modelMessages = await convertToModelMessages(messages, {
      tools: {},
      ignoreIncompleteToolCalls: true,
    });

    const assistantMessages = modelMessages.filter((m) => m.role === "assistant");
    const toolCalls = assistantMessages.flatMap((m) =>
      (Array.isArray(m.content) ? m.content : []).filter((p) => p.type === "tool-call"),
    );
    expect(toolCalls).toHaveLength(0);
    // The orphan check: a `tool` message with no preceding tool call is exactly
    // the shape a partial repair would leave behind.
    expect(modelMessages.filter((m) => m.role === "tool")).toHaveLength(0);
  });
});

// ── Lenient rawInput recovery ─────────────────────────────────────────────────
describe("unreplayable: lenient rawInput recovery", () => {
  it("KEEPS an output-error part whose rawInput parses to a plain object, PROMOTING it to input", () => {
    const legacy = {
      type: "tool-write_file",
      toolCallId: "call_legacy",
      state: "output-error",
      rawInput: '{"path":"a.txt","content":"x"}',
      errorText: "A tool call failed. See diagnostics and retry.",
    };
    const { messages, stats } = pruneStaleMessages([user("hi"), assistant("a1", [legacy])]);
    // Recovery is lenient on purpose: these arguments are genuine, so history is
    // preserved rather than rewritten.
    expect(stats.removedToolParts).toEqual([]);
    expect(stats.preservedApprovals).toEqual([]);
    // Promoted, not merely kept. Keeping the part as-is is NOT enough: the SDK
    // substitutes `rawInput` VERBATIM and the adapter JSON.stringify's it, so an
    // un-promoted part still puts a JSON string where the wire needs an object —
    // the same defect as the production failure. `rawInput` is dropped so the
    // replayed part has exactly one source of arguments.
    expect(toolPartsOf(messages[1])[0]).toEqual({
      type: "tool-write_file",
      toolCallId: "call_legacy",
      state: "output-error",
      input: { path: "a.txt", content: "x" },
      errorText: "A tool call failed. See diagnostics and retry.",
    });
  });

  it("does not mutate the persisted part while promoting its arguments", () => {
    const legacy = {
      type: "tool-write_file",
      toolCallId: "call_legacy",
      state: "output-error",
      rawInput: '{"path":"a.txt"}',
      errorText: "boom",
    };
    pruneStaleMessages([user("hi"), assistant("a1", [legacy])]);
    expect(legacy.rawInput).toBe('{"path":"a.txt"}');
    expect("input" in legacy).toBe(false);
  });

  it.each([
    ["an array", "[]"],
    ["an array of objects", '[{"path":"a.txt"}]'],
    ["null", "null"],
    ["a number", "42"],
    ["a boolean", "true"],
    ["a bare string", '"just text"'],
    ["truncated JSON (production)", PRODUCTION_RAW_INPUT],
    ["empty", ""],
    ["whitespace", "   "],
    ["not JSON at all", "undefined"],
  ])("DROPS an output-error part whose rawInput is %s", (_label, rawInput) => {
    const broken = {
      type: "tool-write_file",
      toolCallId: `call_${_label}`,
      state: "output-error",
      rawInput,
      errorText: "A tool call failed. See diagnostics and retry.",
    };
    const { messages, stats } = pruneStaleMessages([user("hi"), assistant("a1", [broken])]);
    expect(stats.removedToolParts).toEqual([`call_${_label}`]);
    expect(toolPartsOf(messages[1])).toHaveLength(0);
  });

  it("DROPS a non-string rawInput (an object is not recoverable argument text)", () => {
    const broken = {
      type: "tool-write_file",
      toolCallId: "call_obj",
      state: "output-error",
      rawInput: { path: "a.txt" },
      errorText: "boom",
    };
    const { stats } = pruneStaleMessages([user("hi"), assistant("a1", [broken])]);
    expect(stats.removedToolParts).toEqual(["call_obj"]);
  });

  it("ignores rawInput outside output-error (the SDK never substitutes it there)", () => {
    // `approval-responded` with no input is handled by the APPROVAL rule, not by
    // rawInput recovery — see the approval suite below.
    const part = {
      type: "tool-write_file",
      toolCallId: "call_x",
      state: "output-denied",
      rawInput: '{"path":"a.txt"}',
      approval: { id: "ap-1", approved: false },
    };
    const { messages, stats } = pruneStaleMessages([user("hi"), assistant("a1", [part])]);
    // output-denied IS replayable, so the absence of `input` drops it.
    expect(stats.removedToolParts).toEqual(["call_x"]);
    expect(toolPartsOf(messages[1])).toHaveLength(0);
  });
});

// ── Healthy history must not move ────────────────────────────────────────────
describe("unreplayable: healthy history is untouched", () => {
  it("keeps an output-error part that HAS parsed input", () => {
    const cancelled = {
      type: "tool-write_file",
      toolCallId: "call_ok",
      state: "output-error",
      input: { path: "a.txt" },
      errorText: "User cancelled tool call by sending a new message.",
    };
    const { messages, stats } = pruneStaleMessages([user("hi"), assistant("a1", [cancelled])]);
    expect(stats.removedToolParts).toEqual([]);
    expect(stats.removedEmptyTurns).toBe(0);
    expect(toolPartsOf(messages[1])[0]).toEqual(cancelled);
  });

  it("keeps a completed call and its output byte-identically", () => {
    const done = parsed("call-1", { state: "output-available", output: { ok: true } });
    const { messages, stats } = pruneStaleMessages([
      user("hi"),
      assistant("a1", [{ type: "step-start" }, done]),
      user("thanks"),
    ]);
    expect(stats).toEqual({ removedToolParts: [], removedEmptyTurns: 0, preservedApprovals: [] });
    expect(toolPartsOf(messages[1])[0]).toEqual(done);
  });

  it("does not mutate the caller's history objects", () => {
    const part = poisonedPart();
    const history = [user("hi"), assistant("a1", [{ type: "step-start" }, part])];
    pruneStaleMessages(history);
    // The pruner copies the message it edits; the part object the caller holds
    // must survive untouched for the persisted history it came from.
    expect(part).toEqual(poisonedPart());
    expect(toolPartsOf(history[1])).toHaveLength(1);
  });
});

// ── Mixed states in one turn ──────────────────────────────────────────────────
describe("unreplayable: mixed states", () => {
  it("removes only the broken calls and preserves the replayable ones", () => {
    const { messages, stats } = pruneStaleMessages([
      user("hi"),
      assistant("a1", [
        { type: "step-start" },
        { type: "text", text: "two calls" },
        poisonedPart("call_bad"),
        parsed("call_good", { state: "output-available", output: { ok: true } }),
      ]),
    ]);
    expect(stats.removedToolParts).toEqual(["call_bad"]);
    const remaining = toolPartsOf(messages[1]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].toolCallId).toBe("call_good");
  });

  it("removes EVERY occurrence of a poisoned id, across messages", () => {
    const { stats, messages } = pruneStaleMessages([
      user("hi"),
      assistant("a1", [{ type: "step-start" }, poisonedPart("call_dup")]),
      assistant("a2", [{ type: "step-start" }, poisonedPart("call_dup")]),
    ]);
    // One id, two occurrences: the id is dropped once and both parts go with it.
    expect(stats.removedToolParts).toEqual(["call_dup"]);
    expect(messages).toHaveLength(1);
  });

  it("keeps the replayable occurrence of an id that also has a broken one", () => {
    const { messages, stats } = pruneStaleMessages([
      user("hi"),
      assistant("a1", [{ type: "step-start" }, poisonedPart("call_mixed")]),
      assistant("a2", [
        { type: "step-start" },
        parsed("call_mixed", { state: "output-available", output: { ok: true } }),
      ]),
    ]);
    // The keep-set is per occurrence, so a later valid completion of the same
    // interaction is still replayable and must survive. The broken occurrence is
    // on its own turn, which then empties and is dropped — hence only two
    // messages remain, and the survivor carries the valid call.
    expect(stats.removedToolParts).toEqual([]);
    expect(messages).toHaveLength(2);
    expect(messages[1].id).toBe("a2");
    expect(toolPartsOf(messages[1])).toHaveLength(1);
    expect(toolPartsOf(messages[1])[0].toolCallId).toBe("call_mixed");
  });

  it("drops a later broken occurrence while keeping the earlier resolved one", () => {
    const { messages, stats } = pruneStaleMessages([
      user("hi"),
      assistant("a1", [
        { type: "step-start" },
        parsed("call_x", { state: "output-available", output: { ok: true } }),
      ]),
      assistant("a2", [{ type: "step-start" }, poisonedPart("call_x")]),
    ]);
    expect(stats.removedToolParts).toEqual([]);
    expect(toolPartsOf(messages[1])).toHaveLength(1);
    expect(toolPartsOf(messages[2])).toHaveLength(0);
  });
});

// ── Approval semantics must not regress ──────────────────────────────────────
describe("unreplayable: approval semantics are preserved", () => {
  it("KEEPS approval-requested with valid input and still reports it preserved", () => {
    const gate = {
      type: "tool-write_file",
      toolCallId: "call_gate",
      state: "approval-requested",
      input: { path: "a.txt", content: "x" },
      approval: { id: "ap-1" },
    };
    const { messages, stats } = pruneStaleMessages([user("hi"), assistant("a1", [gate])]);
    expect(stats.removedToolParts).toEqual([]);
    expect(stats.preservedApprovals).toEqual(["call_gate"]);
    expect(toolPartsOf(messages[1])[0]).toEqual(gate);
  });

  it("KEEPS an approval-requested gate even when it has NO usable input", () => {
    // Defence in depth, not a reachable production shape: the route's UIMessage
    // schema REQUIRES `input` on an `approval-requested` part (verified against
    // `safeValidateUIMessages`), so this exact part is rejected at the request
    // boundary and never reaches the repair seam. The pruner is a pure function
    // with other callers, so it must still answer correctly for it.
    //
    // If it dropped the gate it would break the AGENTS.md approval-preservation
    // invariant to fix a defect this state cannot cause: an open gate is filtered
    // before conversion (`ignoreIncompleteToolCalls`), so it never becomes a
    // provider tool call in the first place.
    const gate = {
      type: "tool-write_file",
      toolCallId: "call_gate_bare",
      state: "approval-requested",
      approval: { id: "ap-2" },
    };
    const { messages, stats } = pruneStaleMessages([user("hi"), assistant("a1", [gate])]);
    expect(stats.removedToolParts).toEqual([]);
    expect(stats.preservedApprovals).toEqual(["call_gate_bare"]);
    expect(toolPartsOf(messages[1])[0]).toEqual(gate);
  });

  it("keeps an approval-responded approval WITH valid input (the continuation)", () => {
    const approved = {
      type: "tool-write_file",
      toolCallId: "call_appr",
      state: "approval-responded",
      input: { path: "a.txt", content: "x" },
      approval: { id: "ap-3", approved: true },
    };
    const { messages, stats } = pruneStaleMessages([user("hi"), assistant("a1", [approved])]);
    expect(stats.removedToolParts).toEqual([]);
    expect(stats.preservedApprovals).toEqual(["call_appr"]);
    expect(toolPartsOf(messages[1])[0]).toEqual(approved);
  });

  it("DROPS an approval-responded approval with NO usable input", () => {
    // Unlike an open gate, a RESPONDED approval IS replayed, so without
    // arguments the SDK emits a tool call whose `arguments` is absent entirely —
    // the same wire defect as the production case.
    const approved = {
      type: "tool-write_file",
      toolCallId: "call_appr_bare",
      state: "approval-responded",
      approval: { id: "ap-4", approved: true },
    };
    const { messages, stats } = pruneStaleMessages([user("hi"), assistant("a1", [approved])]);
    expect(stats.removedToolParts).toEqual(["call_appr_bare"]);
    expect(stats.preservedApprovals).toEqual([]);
    expect(toolPartsOf(messages[1])).toHaveLength(0);
  });

  it("still expires an approval once the conversation moved past it", () => {
    const approved = {
      type: "tool-write_file",
      toolCallId: "call_expired",
      state: "approval-responded",
      input: { path: "a.txt" },
      approval: { id: "ap-5", approved: true },
    };
    const { messages, stats } = pruneStaleMessages([
      user("hi"),
      assistant("a1", [approved]),
      user("next"),
    ]);
    expect(stats.removedToolParts).toEqual(["call_expired"]);
    expect(stats.preservedApprovals).toEqual([]);
    expect(messages).toHaveLength(1);
  });
});

// ── Determinism ───────────────────────────────────────────────────────────────
describe("unreplayable: removal statistics are deterministic", () => {
  const history = [
    user("hi"),
    assistant("a1", [
      { type: "step-start" },
      poisonedPart("call_b"),
      poisonedPart("call_a"),
      parsed("call_ok", { state: "output-available", output: { ok: true } }),
    ]),
  ];

  it("reports the same ids in the same order across runs", () => {
    const first = pruneStaleMessages(structuredClone(history));
    const second = pruneStaleMessages(structuredClone(history));
    expect(first.stats).toEqual(second.stats);
    // Insertion order (first occurrence in history), not sorted — stable enough
    // to be asserted on, which is what makes the debug log diffable.
    expect(first.stats.removedToolParts).toEqual(["call_b", "call_a"]);
  });

  it("does not accumulate state between calls", () => {
    const a = pruneStaleMessages(structuredClone(history));
    const b = pruneStaleMessages(structuredClone(history));
    expect(a.stats.removedToolParts).toEqual(b.stats.removedToolParts);
    expect(a.stats.removedToolParts).toHaveLength(2);
  });
});