import { describe, it, expect } from "bun:test";
import type { UIMessage } from "ai";
import { pruneStaleMessages } from "../../src/lib/prune-messages";

// Shapes captured from real production history (login.html approval loop):
// the same interaction can persist as approval-responded (no output) AND as
// completed (output); rapid sends can persist adjacent text-only user turns.

const user = (text: string): UIMessage => ({
  id: `u-${text}`,
  role: "user",
  parts: [{ type: "text", text }],
});

const toolPart = (toolCallId: string, extra: Record<string, unknown> = {}) => ({
  type: "tool-write_file",
  toolCallId,
  input: { path: "a.txt" },
  ...extra,
});

const assistant = (id: string, parts: unknown[]): UIMessage =>
  ({ id, role: "assistant", parts }) as UIMessage;

const approvedNoOutput = (toolCallId: string) =>
  toolPart(toolCallId, {
    state: "approval-responded",
    approval: { id: `ap-${toolCallId}`, approved: true },
  });

const deniedNoOutput = (toolCallId: string) =>
  toolPart(toolCallId, {
    state: "approval-responded",
    approval: { id: `ap-${toolCallId}`, approved: false, reason: "no" },
  });

const withOutput = (toolCallId: string) =>
  toolPart(toolCallId, { state: "output-available", output: { ok: true } });

describe("approval lifecycle retention (the regression)", () => {
  it("KEEPS approval-responded + approved with no output at the conversation end", () => {
    const history = [user("hi"), assistant("a1", [approvedNoOutput("call-1")])];
    const { messages, stats } = pruneStaleMessages(history);
    expect(messages.length).toBe(2);
    expect((messages[1].parts as unknown[])[0]).toEqual(approvedNoOutput("call-1"));
    expect(stats.preservedApprovals).toEqual(["call-1"]);
  });

  it("KEEPS approval-responded + denied with no output at the conversation end", () => {
    const { messages } = pruneStaleMessages([
      user("hi"),
      assistant("a1", [deniedNoOutput("call-1")]),
    ]);
    expect((messages[1].parts as unknown[])[0]).toEqual(deniedNoOutput("call-1"));
  });

  it("KEEPS an open approval-requested gate", () => {
    const gate = toolPart("call-1", { state: "approval-requested", approval: { id: "ap-1" } });
    const { messages } = pruneStaleMessages([user("hi"), assistant("a1", [gate])]);
    expect((messages[1].parts as unknown[])[0]).toEqual(gate);
  });

  it("DROPS an approved call once the conversation moved past it (expired)", () => {
    // Continuation was lost; a later user turn means a fresh approval is
    // required — never retroactive execution on an unrelated message.
    const { messages, stats } = pruneStaleMessages([
      user("hi"),
      assistant("a1", [approvedNoOutput("call-1")]),
      user("next"),
    ]);
    expect(stats.removedToolParts).toEqual(["call-1"]);
    // Assistant turn emptied → dropped; adjacent users merged.
    expect(messages.length).toBe(1);
    expect((messages[0].parts as { text: string }[]).map((p) => p.text)).toEqual(["hi", "next"]);
  });

  it("preserves a DIFFERENT later attempt while dropping the expired one", () => {
    const freshGate = toolPart("call-2", { state: "approval-requested", approval: { id: "ap-2" } });
    const { messages } = pruneStaleMessages([
      user("hi"),
      assistant("a1", [approvedNoOutput("call-1")]),
      user("next"),
      assistant("a2", [freshGate]),
    ]);
    // a1 emptied → dropped; the adjacent users merge; a2's fresh gate survives.
    expect(messages.length).toBe(2);
    expect(messages[1].id).toBe("a2");
    expect((messages[1].parts as unknown[])[0]).toEqual(freshGate);
  });
});

describe("deduplication", () => {
  it("collapses approval-responded + output-available to the completed one", () => {
    const { messages } = pruneStaleMessages([
      user("hi"),
      assistant("a1", [approvedNoOutput("call-1")]),
      assistant("a2", [withOutput("call-1")]),
    ]);
    // a1 loses its superseded part → empty turn dropped; a2 (completed) stays.
    expect(messages.length).toBe(2);
    expect(messages[1].id).toBe("a2");
    expect((messages[1].parts as unknown[])[0]).toEqual(withOutput("call-1"));
  });

  it("keeps separate attempts (different tool-call ids) separate", () => {
    const { messages } = pruneStaleMessages([
      user("hi"),
      assistant("a1", [withOutput("call-1")]),
      assistant("a2", [withOutput("call-2")]),
    ]);
    expect(messages.length).toBe(3);
  });
});

describe("stale / incomplete handling", () => {
  it("drops input-available calls with no decision and no output", () => {
    const stale = toolPart("call-7", { state: "input-available" });
    const { messages, stats } = pruneStaleMessages([user("hi"), assistant("a1", [stale]), user("next")]);
    expect(stats.removedToolParts).toEqual(["call-7"]);
    expect(messages.length).toBe(1);
  });

  it("keeps cancelled (output-error with errorText only) parts", () => {
    const cancelled = toolPart("call-1", {
      state: "output-error",
      errorText: "User cancelled tool call by sending a new message.",
    });
    const { messages } = pruneStaleMessages([user("hi"), assistant("a1", [cancelled])]);
    expect((messages[1].parts as unknown[])[0]).toEqual(cancelled);
  });

  it("keeps output-denied parts", () => {
    const denied = toolPart("call-1", { state: "output-denied", approval: { id: "ap-1", approved: false } });
    const { messages } = pruneStaleMessages([user("hi"), assistant("a1", [denied])]);
    expect((messages[1].parts as unknown[])[0]).toEqual(denied);
  });
});

describe("empty assistant turns", () => {
  it("drops a step-start-only assistant turn", () => {
    const { messages, stats } = pruneStaleMessages([
      user("hi"),
      assistant("a1", [{ type: "step-start" }]),
      user("next"),
    ]);
    expect(stats.removedEmptyTurns).toBe(1);
    expect(messages.length).toBe(1);
  });

  it("keeps assistant turns that still carry text or tool parts", () => {
    const { messages } = pruneStaleMessages([
      user("hi"),
      assistant("a1", [{ type: "step-start" }, { type: "text", text: "hello" }]),
    ]);
    expect(messages.length).toBe(2);
  });
});

describe("user-message merging", () => {
  it("merges adjacent text-only user messages", () => {
    const { messages } = pruneStaleMessages([user("a"), user("b")]);
    expect(messages.length).toBe(1);
    expect((messages[0].parts as { text: string }[]).map((p) => p.text)).toEqual(["a", "b"]);
  });

  it("never merges across tool-result user messages", () => {
    const fr: UIMessage = {
      id: "t1",
      role: "user",
      parts: [{ type: "tool-result", toolCallId: "c1", toolName: "x", output: "y" } as any],
    };
    const { messages } = pruneStaleMessages([user("a"), user("b"), fr, user("c")]);
    expect(messages.length).toBe(3);
  });
});

describe("healthy history", () => {
  it("passes through semantically untouched", () => {
    const history = [
      user("hi"),
      assistant("a1", [{ type: "step-start" }, withOutput("call-1")]),
      user("thanks"),
    ];
    const { messages, stats } = pruneStaleMessages(history);
    expect(stats.removedToolParts).toEqual([]);
    expect(stats.removedEmptyTurns).toBe(0);
    expect(messages.length).toBe(history.length);
    expect((messages[1].parts as unknown[])[1]).toEqual(withOutput("call-1"));
  });
});
