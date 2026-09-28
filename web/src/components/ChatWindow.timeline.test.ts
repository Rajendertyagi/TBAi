import { describe, it, expect, beforeAll } from "bun:test";
import { shouldShowSessionTimeline } from "./ChatWindow";
import { stripComments } from "@/testing/source-scope";

/**
 * Which engine renders the per-message tool timeline.
 *
 * ## What changed
 *
 * `SessionTimeline` was mounted unconditionally, so the Direct chat surface
 * printed `1 step · 0 files changed` above every tool turn. That is
 * OpenCode's vocabulary: a coding session is a sequence of steps that change
 * files. The Direct engine has neither concept, so the count it could print was
 * structurally zero on every turn.
 *
 * ## Why the gate is the engine, not the tool name
 *
 * Both surfaces render the SAME `AssistantMessage` from the SAME file, so a
 * tool-name test would be re-deriving the engine from the data the runtime
 * already states — and it would be wrong in both directions: a Direct tool
 * name (`read_file`) reaching the OpenCode surface, or an MCP tool with no
 * name at all. `mode` is the engine, and it is already the prop the rest of
 * this component branches on. The predicate is pure (no hooks) so the whole
 * matrix is assertable here, exactly as `shouldShowThreadBoot` is.
 */
describe("shouldShowSessionTimeline — the engine gate", () => {
  it("shows the timeline for the agent (OpenCode) engine, which owns steps", () => {
    expect(shouldShowSessionTimeline({ mode: "agent" })).toBe(true);
  });

  it("never shows it for the Direct engine, which has no steps or file counts", () => {
    // THE defect. Direct messages can carry tool calls, so the timeline used
    // to render there — with a file count that is always 0, because
    // `write_file` returns `{ path, bytes, created }` and `edit_file` returns
    // `{ path, occurrences, diff }`, neither of which carries line counts.
    expect(shouldShowSessionTimeline({ mode: "chat" })).toBe(false);
  });

  it("is a total function over both modes", () => {
    // Non-vacuity control: the predicate discriminates, so it cannot be
    // satisfied by a constant `return true` (which would keep the Direct
    // defect) or `return false` (which would delete the OpenCode timeline).
    expect(shouldShowSessionTimeline({ mode: "agent" })).not.toBe(
      shouldShowSessionTimeline({ mode: "chat" }),
    );
  });
});

/**
 * Source guards.
 *
 * A static render of an assistant message needs the assistant-ui runtime
 * provider and cannot be mounted under `bun test` (same reason as
 * `ChatWindow.blocks.test.ts`), so the wiring is pinned against the source.
 * Comments are stripped, so prose describing the rule cannot satisfy a test for
 * the rule.
 */
describe("source guards — the timeline is gated at the call site", () => {
  let source = "";

  beforeAll(async () => {
    source = stripComments(
      await Bun.file(new URL("./ChatWindow.tsx", import.meta.url)).text(),
    );
  });

  it("derives the timeline from the shared predicate, not from a tool name", () => {
    expect(source).toContain("shouldShowSessionTimeline({ mode })");
    // The same shape `shouldShowThreadBoot` uses, so there is one idiom in
    // this file for "a pure engine/draft decision".
    expect(source).toContain("export function shouldShowSessionTimeline");
  });

  it("does not mount the timeline unconditionally", () => {
    // The exact expression that was there before. If it returns, the Direct
    // surface shows OpenCode's step vocabulary again.
    expect(source).not.toMatch(/^\s*<SessionTimeline \/>$/m);
  });

  it("keeps the timeline mounted for the agent surface", () => {
    // Non-vacuity: the guards above are also satisfied by deleting the
    // element entirely, which would fix Direct and break Code mode.
    expect(source).toContain("<SessionTimeline />");
    expect(source).toContain("shouldShowSessionTimeline");
  });

  it("neither the Direct nor the OpenCode view reaches for the timeline itself", async () => {
    // The gate lives at the ONE call site. If either surface started mounting
    // its own, the engine rule would exist in two places and could drift.
    const chatView = stripComments(
      await Bun.file(
        new URL("../features/chat/components/ChatView.tsx", import.meta.url),
      ).text(),
    );
    const openCodeView = stripComments(
      await Bun.file(
        new URL("../features/opencode/OpenCodeView.tsx", import.meta.url),
      ).text(),
    );
    expect(chatView).not.toContain("SessionTimeline");
    expect(openCodeView).not.toContain("SessionTimeline");
  });
});
