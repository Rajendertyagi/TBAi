import { describe, expect, it } from "bun:test";
import { createInitialV2ThreadState, reduceV2ThreadState } from "./v2Events";
import { deriveLatestOpenCodeTodos } from "./v2Todos";

const tool = (id: string, todos: unknown) => ({
  id,
  parentId: null,
  role: "assistant" as const,
  createdAt: 1,
  parts: [{ kind: "tool" as const, id, order: 0, name: "todowrite", input: { todos }, output: null, status: "complete" as const, permissionId: null }],
  source: null,
});

describe("native V2 todo projection", () => {
  it("uses the newest usable todowrite call and ignores malformed entries", () => {
    let state = createInitialV2ThreadState("session-1");
    state = reduceV2ThreadState(state, { type: "history_loaded", messages: [tool("old", [{ content: "old", status: "pending", priority: "low" }]), tool("new", [{ content: "new", status: "in_progress", priority: "high" }])], messageOrder: ["old", "new"], pages: 1 });
    expect(deriveLatestOpenCodeTodos(state)).toEqual([{ content: "new", status: "in_progress", priority: "high" }]);
  });

  it("returns an empty stable snapshot when no usable todo exists", () => {
    const state = createInitialV2ThreadState("session-1");
    expect(deriveLatestOpenCodeTodos(state)).toEqual([]);
  });
});
