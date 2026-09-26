import { describe, expect, it } from "bun:test";
import { createV2ThreadListAdapter } from "./v2ThreadList";
import type { V2ThreadState } from "./v2Types";

const SESSION_ID = "ses_v2_thread_list";
const CONVERSATION_ID = "conv_v2_thread_list";

const state: V2ThreadState = {
  sessionId: SESSION_ID,
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
  messages: {},
  messageOrder: [],
  permissions: [],
  forms: [],
  inboxById: {},
  usage: null,
  optimisticMessageIds: [],
  answeredPermissionIds: [],
  diagnosticCount: 0,
};

describe("createV2ThreadListAdapter", () => {
  it("publishes conversation identity separately from OpenCode session identity", () => {
    const adapter = createV2ThreadListAdapter(state, CONVERSATION_ID);
    expect(adapter.threads).toBeDefined();
    const threads = adapter.threads ?? [];
    expect(adapter.threadId).toBe(SESSION_ID);
    expect(threads[0]).toMatchObject({
      id: SESSION_ID,
      remoteId: SESSION_ID,
      externalId: SESSION_ID,
      custom: { conversationId: CONVERSATION_ID },
    });
  });
});

describe("Code approval conversation identity", () => {
  it("uses the shared resolver for both precheck and outside-workspace grant", async () => {
    const source = await Bun.file(
      new URL("../../tools/filesystem/ui.tsx", import.meta.url),
    ).text();
    const resolverCalls = source.match(/resolveThreadConversationId\(/g) ?? [];
    expect(resolverCalls.length).toBeGreaterThanOrEqual(2);
    expect(source).not.toContain("item.remoteId ?? item.id");
  });
});
