import { describe, expect, it } from "bun:test";
import type { SessionMessageInfo } from "@opencode/client";
import { createInitialV2ThreadState } from "./v2Events";
import { projectV2RepositoryItems } from "./v2MessageProjection";

const SESSION_ID = "ses_live_projection_test";
const MESSAGE_ID = "msg_live_projection_test";
const TOOL_ID = "call_live_projection_test";
const PERMISSION_ID = "permission_live_projection_test";

describe("native V2 live tool projection", () => {
  it("matches a live tool event to its permission without history source metadata", () => {
    const initial = createInitialV2ThreadState(SESSION_ID);
    const state = {
      ...initial,
      messages: {
        [MESSAGE_ID]: {
          id: MESSAGE_ID,
          parentId: null,
          role: "assistant" as const,
          createdAt: 1,
          parts: [{
            kind: "tool" as const,
            id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
            order: 0,
            name: "shell",
            input: { command: "bun --version" },
            output: null,
            status: "running" as const,
            permissionId: null,
          }],
          source: null,
        },
      },
      messageOrder: [MESSAGE_ID],
      permissions: [{
        id: PERMISSION_ID,
        sessionID: SESSION_ID,
        action: "shell",
        resources: ["bun --version"],
        save: [],
        source: { type: "tool" as const, messageID: MESSAGE_ID, id: TOOL_ID },
      }],
    };

    const [item] = projectV2RepositoryItems(state);
    const part = item?.message.content[0];
    expect(part).toMatchObject({
      type: "tool-call",
      approval: { id: PERMISSION_ID },
    });
  });

  it("preserves assistant tool metadata for the V2 edit diff renderer", () => {
    const source: SessionMessageInfo = {
      id: MESSAGE_ID,
      type: "assistant",
      agent: "build",
      model: { id: "test-model", providerID: "test-provider" },
      time: { created: 1 },
      content: [{
        type: "tool",
        id: TOOL_ID,
        name: "edit",
        time: { created: 1, ran: 1 },
        state: {
          status: "completed",
          input: { filePath: "a.ts" },
          content: [{ type: "text", text: "done" }],
          metadata: { files: [{ file: "a.ts", patch: "PATCH" }] },
        },
      }],
    };
    const initial = createInitialV2ThreadState(SESSION_ID);
    const state = {
      ...initial,
      messages: {
        [MESSAGE_ID]: {
          id: MESSAGE_ID,
          parentId: null,
          role: "assistant" as const,
          createdAt: 1,
          parts: [{
            kind: "tool" as const,
            id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
            order: 0,
            name: "edit",
            input: { filePath: "a.ts" },
            output: [{ type: "text", text: "done" }],
            status: "complete" as const,
            permissionId: null,
          }],
          source,
        },
      },
      messageOrder: [MESSAGE_ID],
    };

    const [item] = projectV2RepositoryItems(state);
    expect(item?.message.metadata?.custom).toEqual({
      opencode: { parts: source.content },
    });
  });

  it("preserves live tool metadata for the edit diff renderer", () => {
    const initial = createInitialV2ThreadState(SESSION_ID);
    const state = {
      ...initial,
      messages: {
        [MESSAGE_ID]: {
          id: MESSAGE_ID,
          parentId: null,
          role: "assistant" as const,
          createdAt: 1,
          parts: [{
            kind: "tool" as const,
            id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
            order: 0,
            name: "edit",
            input: { filePath: "a.ts" },
            output: [{ type: "text", text: "done" }],
            metadata: { files: [{ file: "a.ts", patch: "PATCH" }] },
            status: "complete" as const,
            permissionId: null,
          }],
          source: null,
        },
      },
      messageOrder: [MESSAGE_ID],
    };

    const [item] = projectV2RepositoryItems(state);
    expect(item?.message.metadata?.custom).toEqual({
      opencode: {
        parts: [{
          type: "tool",
          id: TOOL_ID,
          name: "edit",
          state: {
            status: "completed",
            input: { filePath: "a.ts" },
            content: [{ type: "text", text: "done" }],
            metadata: { files: [{ file: "a.ts", patch: "PATCH" }] },
          },
        }],
      },
    });
  });

  it("keeps a running V2 tool pending instead of projecting a defined null result", () => {
    const initial = createInitialV2ThreadState(SESSION_ID);
    const state = {
      ...initial,
      messages: {
        [MESSAGE_ID]: {
          id: MESSAGE_ID,
          parentId: null,
          role: "assistant" as const,
          createdAt: 1,
          parts: [{
            kind: "tool" as const,
            id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
            order: 0,
            name: "shell",
            input: { command: "bun --version" },
            output: null,
            status: "running" as const,
            permissionId: null,
          }],
          source: null,
        },
      },
      messageOrder: [MESSAGE_ID],
    };

    const [item] = projectV2RepositoryItems(state);
    expect(item?.message.content[0]).toMatchObject({
      type: "tool-call",
      result: undefined,
    });
  });
});
