import { describe, expect, it } from "bun:test";
import type { ToolCallMessagePartStatus } from "@assistant-ui/react";
import { activityFromParts, type ActivityPart } from "@web/lib/assistantActivityParts";

function toolCall(
  toolName: string,
  overrides: { result?: unknown; status?: ToolCallMessagePartStatus } = {},
): ActivityPart {
  return {
    type: "tool-call",
    toolCallId: `${toolName}-call`,
    toolName,
    args: {},
    argsText: "{}",
    ...overrides,
  };
}

function reasoning(status: "running" | "complete"): ActivityPart {
  return { type: "reasoning", text: "…", status: { type: status } };
}

function text(value: string): ActivityPart {
  return { type: "text", text: value };
}

const label = (toolName: string) => `run:${toolName}`;

describe("activityFromParts", () => {
  it("labels the newest tool call that has no result", () => {
    const parts = [toolCall("read_file", { result: { ok: true } }), toolCall("edit_file")];

    expect(activityFromParts(parts, label)).toEqual({
      state: "working",
      label: "run:edit_file",
    });
  });

  it("waits without consulting the tool label when the pending call requires action", () => {
    const names: string[] = [];
    const parts = [
      toolCall("delete_file", {
        status: { type: "requires-action", reason: "tool-calls" },
      }),
    ];

    expect(
      activityFromParts(parts, (toolName) => {
        names.push(toolName);
        return `run:${toolName}`;
      }),
    ).toEqual({ state: "waiting", label: "Waiting for approval…" });
    expect(names).toEqual([]);
  });

  it("reports thinking while a reasoning part is running", () => {
    expect(activityFromParts([reasoning("running")], label)).toEqual({
      state: "working",
      label: "Thinking…",
    });
  });

  it("prefers a pending tool call over a running reasoning part", () => {
    expect(activityFromParts([reasoning("running"), toolCall("search_files")], label)).toEqual({
      state: "working",
      label: "run:search_files",
    });
  });

  it("returns null while visible text is streaming", () => {
    expect(activityFromParts([reasoning("complete"), text("Answer")], label)).toBeNull();
  });

  it("does not treat an empty text part as visible text", () => {
    expect(activityFromParts([text("")], label)).toEqual({
      state: "working",
      label: "Thinking…",
    });
  });

  it("reports thinking for a settled tool call with no other activity", () => {
    expect(activityFromParts([toolCall("read_file", { result: { ok: true } })], label)).toEqual({
      state: "working",
      label: "Thinking…",
    });
  });

  it("reports thinking for an empty part list", () => {
    expect(activityFromParts([], label)).toEqual({ state: "working", label: "Thinking…" });
  });
});
