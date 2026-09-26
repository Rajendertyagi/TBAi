import { describe, expect, it } from "bun:test";
import type {
  SessionMessageInfo,
  SessionMessageShell,
  SessionMessageSystem,
  SessionMessagesResponse,
} from "@opencode/client";
import { V2_HISTORY_READER_BRAND, type V2HistoryReader } from "./v2Client";
import { loadV2History, projectV2History } from "./v2History";
import { projectV2RepositoryItems } from "./v2MessageProjection";
import type { V2ThreadState } from "./v2Types";

const message = (id: string, text: string, created: number): SessionMessageInfo => ({
  id,
  metadata: undefined,
  time: { created },
  text,
  type: "user",
});

function repositoryState(
  projection: ReturnType<typeof projectV2History>,
): V2ThreadState {
  return {
    sessionId: "session-1",
    connection: { type: "connected", serverVersion: "2.0.16" },
    load: { type: "ready" },
    execution: { type: "idle" },
    compaction: { type: "idle" },
    revertRecovery: { type: "none" },
    eventIdentity: {
      nextOrdinal: 0,
      recentObservedEventIds: [],
      recentAppliedEventIds: [],
      durableSequenceByAggregate: {},
    },
    session: null,
    model: null,
    agent: null,
    desiredModel: null,
    desiredAgent: null,
    selectionGeneration: 0,
    messages: Object.fromEntries(projection.messages.map((item) => [item.id, item])),
    messageOrder: projection.messageOrder,
    permissions: [],
    forms: [],
    inboxById: {},
    usage: null,
    optimisticMessageIds: [],
    answeredPermissionIds: [],
    diagnosticCount: 0,
  };
}

function reader(pages: SessionMessagesResponse[]): V2HistoryReader {
  let index = 0;
  return {
    [V2_HISTORY_READER_BRAND]: true,
    sessionId: "session-1",
    list: async () => {
      const page = pages[index++];
      if (!page) throw new Error("unexpected history page");
      return page;
    },
  } as V2HistoryReader;
}

describe("native V2 history projection", () => {
  it("loads cursor pages, reverses them, and deduplicates ids", async () => {
    const snapshot = await loadV2History(reader([
      { data: [message("m3", "third", 3), message("m2", "second", 2)], cursor: { next: "older" } },
      { data: [message("m2", "second", 2), message("m1", "first", 1)], cursor: {} },
    ]));
    expect(snapshot.messages.map((item) => item.id)).toEqual(["m1", "m2", "m3"]);
    expect(snapshot.pages).toBe(2);
    const projection = projectV2History(snapshot, []);
    expect(projection.messageOrder).toEqual(["m1", "m2", "m3"]);
    expect(projection.messages[0]?.parts[0]).toMatchObject({ kind: "text", value: "first" });
  });

  it("preserves V2 tool content arrays, errors, and edit metadata", () => {
    const assistantMessage: SessionMessageInfo = {
      id: "assistant-tool",
      type: "assistant",
      agent: "build",
      model: { id: "test-model", providerID: "test-provider" },
      time: { created: 1 },
      content: [
        {
          type: "tool",
          id: "tool-edit",
          name: "edit",
          time: { created: 1, ran: 1 },
          state: {
            status: "completed",
            input: { filePath: "tool-test.txt" },
            content: [{ type: "text", text: "Edit applied successfully." }],
            metadata: { files: [{ file: "tool-test.txt", patch: "Index: tool-test.txt" }] },
          },
        },
      ],
    };
    const projection = projectV2History({ messages: [assistantMessage], pages: 1 }, []);
    expect(projection.messages[0]?.parts[0]).toMatchObject({
      kind: "tool",
      output: [{ type: "text", text: "Edit applied successfully." }],
      metadata: { files: [{ file: "tool-test.txt", patch: "Index: tool-test.txt" }] },
      status: "complete",
    });
  });

  it("maps official streaming tool state to the running UI state", () => {
    const assistantMessage: SessionMessageInfo = {
      id: "assistant-tool-streaming",
      type: "assistant",
      agent: "build",
      model: { id: "test-model", providerID: "test-provider" },
      time: { created: 1 },
      content: [{
        type: "tool",
        id: "tool-streaming",
        name: "read",
        time: { created: 1 },
        state: { status: "streaming", input: "{\"filePath\":\"a.txt\"}" },
      }],
    };
    const projection = projectV2History({ messages: [assistantMessage], pages: 1 }, []);
    expect(projection.messages[0]?.parts[0]).toMatchObject({
      input: { text: "{\"filePath\":\"a.txt\"}" },
      output: undefined,
      status: "running",
    });
  });

  it("preserves partial content supplied with a V2 tool error", () => {
    const assistantMessage: SessionMessageInfo = {
      id: "assistant-tool-error",
      type: "assistant",
      agent: "build",
      model: { id: "test-model", providerID: "test-provider" },
      time: { created: 1 },
      content: [{
        type: "tool",
        id: "tool-error",
        name: "read",
        time: { created: 1, ran: 1 },
        state: {
          status: "error",
          input: { filePath: "a.txt" },
          error: { type: "tool.execution", message: "File not found" },
          content: [{ type: "text", text: "partial output" }],
        },
      }],
    };
    const projection = projectV2History({ messages: [assistantMessage], pages: 1 }, []);
    expect(projection.messages[0]?.parts[0]).toMatchObject({
      output: {
        error: "File not found",
        content: [{ type: "text", text: "partial output" }],
      },
      status: "error",
    });
  });

  it("projects a native V2 system record to one system text part", () => {
    const systemMessage: SessionMessageSystem = {
      id: "system-history",
      type: "system",
      text: "System history text",
      time: { created: 1 },
    };
    const projection = projectV2History(
      { messages: [systemMessage], pages: 1 },
      [],
    );
    expect(projection.messages[0]).toMatchObject({
      role: "system",
      parts: [{ kind: "text", value: "System history text" }],
    });
    expect(projection.messages[0]?.parts).toHaveLength(1);
  });

  it("projects a native V2 shell record to one deterministic system text part", () => {
    const shellMessage: SessionMessageShell = {
      id: "shell-history",
      type: "shell",
      shellID: "shell-1",
      command: "bun test",
      status: "exited",
      exit: 0,
      output: {
        output: "shell output",
        cursor: 12,
        size: 12,
        truncated: false,
      },
      time: { created: 2, completed: 3 },
    };
    const projection = projectV2History(
      { messages: [shellMessage], pages: 1 },
      [],
    );
    expect(projection.messages[0]).toMatchObject({
      role: "system",
      // Native text projection preserves the command and output in source order.
      parts: [{ kind: "text", value: "bun test\nshell output" }],
    });
    expect(projection.messages[0]?.parts).toHaveLength(1);
  });

  it("projects the system role to exactly one assistant-ui text content part", () => {
    const systemMessage: SessionMessageSystem = {
      id: "system-history",
      type: "system",
      text: "System history text",
      time: { created: 1 },
    };
    const projection = projectV2History(
      { messages: [systemMessage], pages: 1 },
      [],
    );
    const repositoryItems = projectV2RepositoryItems(repositoryState(projection));
    const projectedMessage = repositoryItems[0]?.message;
    expect(projectedMessage).toMatchObject({
      role: "system",
      content: [{ type: "text", text: "System history text" }],
    });
    expect(projectedMessage?.content).toHaveLength(1);
  });

  it("rejects a repeated cursor instead of looping", async () => {
    await expect(loadV2History(reader([
      { data: [], cursor: { next: "same" } },
      { data: [], cursor: { next: "same" } },
    ]))).rejects.toThrow("repeated cursor");
  });
});
