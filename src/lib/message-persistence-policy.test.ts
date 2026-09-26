import { describe, expect, it } from "bun:test";
import {
  hasRenderableAssistantContent,
  isContentlessAssistantMessage,
} from "./message-persistence-policy";

/**
 * The rule that decides whether an assistant message is a reply yet.
 *
 * The regression this exists for: the client persists an assistant row when a run
 * STARTS, holding only TBAi's UI-only progress part with no stages. `TodoList`
 * returns null for an empty stage list, so if the run then dies that row renders
 * as a blank bubble. Verified on a real interrupted run — 0 rows had `parts: []`,
 * and every phantom carried exactly one empty progress part.
 */

const progressPart = (stages: unknown[]) => ({
  type: "data-tbai-progress",
  data: { kind: "tbai-progress", version: 1, stages },
});

describe("message persistence policy — the interrupted-run phantom", () => {
  it("treats the real shell — one empty progress part — as contentless", () => {
    // The exact shape observed on disk. This is the regression case.
    const shell = {
      metadata: { custom: { providerId: "p1", modelId: "m1" } },
      role: "assistant",
      parts: [progressPart([])],
    };
    expect(isContentlessAssistantMessage(shell)).toBe(true);
  });

  it("treats an empty parts array as contentless", () => {
    expect(isContentlessAssistantMessage({ role: "assistant", parts: [] })).toBe(true);
  });

  it("keeps a progress part that actually shows something", () => {
    // Stages mean the user really saw a progress panel, so it is visible history.
    const shown = {
      role: "assistant",
      parts: [progressPart([{ id: "s1", label: "Reading", status: "completed" }])],
    };
    expect(isContentlessAssistantMessage(shown)).toBe(false);
  });

  it("keeps a reply with text, reasoning, or a tool result", () => {
    const parts: unknown[] = [
      { type: "step-start" },
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "the answer" },
    ];
    expect(isContentlessAssistantMessage({ role: "assistant", parts })).toBe(false);
    expect(
      isContentlessAssistantMessage({
        role: "assistant",
        parts: [{ type: "tool-read_file", toolCallId: "c1", state: "output-available" }],
      }),
    ).toBe(false);
  });

  it("ignores step-start markers when the reply has real content", () => {
    expect(
      isContentlessAssistantMessage({
        role: "assistant",
        parts: [{ type: "step-start" }, { type: "step-start" }],
      }),
    ).toBe(true);
    expect(
      isContentlessAssistantMessage({
        role: "assistant",
        parts: [{ type: "step-start" }, { type: "text", text: "hi" }],
      }),
    ).toBe(false);
  });

  it("never drops a user turn, however short", () => {
    // An attachment-only prompt is a legitimate, persisted user message.
    expect(isContentlessAssistantMessage({ role: "user", parts: [] })).toBe(false);
    expect(
      isContentlessAssistantMessage({ role: "user", parts: [{ type: "file", url: "x" }] }),
    ).toBe(false);
  });

  it("fails OPEN on anything it cannot classify", () => {
    // Dropping content we do not understand would destroy a real reply, so every
    // unrecognised shape is kept.
    expect(hasRenderableAssistantContent(null)).toBe(true);
    expect(hasRenderableAssistantContent("nope")).toBe(true);
    expect(hasRenderableAssistantContent({})).toBe(true);
    expect(hasRenderableAssistantContent({ role: "assistant" })).toBe(true);
    expect(
      hasRenderableAssistantContent({ role: "assistant", parts: [{ text: "no type" }] }),
    ).toBe(true);
    // A part type we have never seen is content, not noise.
    expect(
      hasRenderableAssistantContent({ role: "assistant", parts: [{ type: "future-widget" }] }),
    ).toBe(true);
  });

  it("does not classify a non-assistant payload as a contentless assistant message", () => {
    expect(isContentlessAssistantMessage({ parts: [] })).toBe(false);
    expect(isContentlessAssistantMessage(null)).toBe(false);
  });
});
