/**
 * P1′ Differential Verification
 *
 * Compares the OLD path (full submitted history) vs the P1′ path
 * (server-reconstructed prefix + client suffix) at the Layer C boundary.
 *
 * The comparison point is `assembled.context.layerC.messages` after
 * `applyExistingCompaction` and before `prepareModelMessages`.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { assembleContext } from "@/context/assemble.ts";
import { messageService, conversationService } from "@/services/storage";
import { db } from "@/db";
import type { UIMessage } from "ai";

// Helper: create a test conversation with messages
async function createTestConversation(messages: Array<{ id: string; parent_id: string | null; content: any }>) {
  const conv = await conversationService.create({ title: "test", providerId: "test", workspaceMode: "simple" });
  for (const msg of messages) {
    await messageService.upsertStored(conv.id, {
      id: msg.id,
      parent_id: msg.parent_id,
      format: "ai-sdk/v6",
      content: msg.content,
    });
  }
  return conv;
}

// Helper: canonicalize messages for comparison
function canonicalize(messages: readonly UIMessage[]): string {
  return JSON.stringify(messages, (key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((sorted, k) => {
        sorted[k] = value[k];
        return sorted;
      }, {} as any);
    }
    return value;
  });
}

describe("P1′ differential verification", () => {
  beforeEach(() => {
    // Clean up ALL test data — conversation IDs are random, not "test-%"
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  });

  it("normal conversation: OLD == P1′", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] } },
      { id: "m2", parent_id: "m1", content: { id: "m2", role: "assistant", parts: [{ type: "text", text: "hi" }] } },
      { id: "m3", parent_id: "m2", content: { id: "m3", role: "user", parts: [{ type: "text", text: "how are you" }] } },
    ];
    const conv = await createTestConversation(messages);

    const submittedMessages = messages.map((m) => m.content as UIMessage);

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("branch selection: OLD == P1′", async () => {
    const messages = [
      { id: "a", parent_id: null, content: { id: "a", role: "user", parts: [{ type: "text", text: "a" }] } },
      { id: "b", parent_id: "a", content: { id: "b", role: "assistant", parts: [{ type: "text", text: "b" }] } },
      { id: "c", parent_id: "b", content: { id: "c", role: "user", parts: [{ type: "text", text: "c" }] } },
      { id: "d", parent_id: "a", content: { id: "d", role: "assistant", parts: [{ type: "text", text: "d" }] } },
      { id: "e", parent_id: "d", content: { id: "e", role: "user", parts: [{ type: "text", text: "e" }] } },
    ];
    const conv = await createTestConversation(messages);

    // Select D/E branch (tip is E)
    const submittedMessages = [
      messages[0].content, // a
      messages[3].content, // d
      messages[4].content, // e
    ] as UIMessage[];

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("missing boundary: fail closed to client-authoritative", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] } },
    ];
    const conv = await createTestConversation(messages);

    // Submit a message that doesn't exist on the head chain
    const submittedMessages = [
      { id: "unknown", role: "user", parts: [{ type: "text", text: "unknown" }] },
    ] as UIMessage[];

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    // Should fall back to client-authoritative path
    expect(newResult.context.layerC.messages.length).toBe(1);
    expect(newResult.context.layerC.messages[0].id).toBe("unknown");
  });

  it("empty conversation: OLD == P1′", async () => {
    const conv = await conversationService.create({ title: "test", providerId: "test", workspaceMode: "simple" });

    const submittedMessages: UIMessage[] = [];

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("repeated reconstruction: same result", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] } },
      { id: "m2", parent_id: "m1", content: { id: "m2", role: "assistant", parts: [{ type: "text", text: "hi" }] } },
    ];
    const conv = await createTestConversation(messages);

    const submittedMessages = messages.map((m) => m.content as UIMessage);

    const results = [];
    for (let i = 0; i < 5; i++) {
      const result = await assembleContext({
        conversationId: conv.id,
        submittedMessages,
        runId: "test",
        provider: { id: "test", type: "openai", models: [] } as any,
        modelId: "test",
        systemPrompt: undefined,
        toolSignal: new AbortController().signal,
      });
      results.push(canonicalize(result.context.layerC.messages));
    }

    // All results should be identical
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[0]);
    }
  });

  it("tool call/result: OLD == P1′", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [{ type: "text", text: "read file" }] } },
      { id: "m2", parent_id: "m1", content: { id: "m2", role: "assistant", parts: [
        { type: "text", text: "reading", state: "done" },
        { type: "tool-read_file", toolCallId: "tc1", state: "output-available", input: { path: "a.txt" }, output: { content: "hello" } },
      ] } },
    ];
    const conv = await createTestConversation(messages);

    const submittedMessages = messages.map((m) => m.content as UIMessage);

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("file-bearing message: OLD == P1′", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [
        { type: "text", text: "here is a file" },
        { type: "file", mediaType: "text/plain", filename: "a.txt", url: "data:text/plain;base64,aGVsbG8=" },
      ] } },
    ];
    const conv = await createTestConversation(messages);

    const submittedMessages = messages.map((m) => m.content as UIMessage);

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("data-part message: OLD == P1′", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "assistant", parts: [
        { type: "data-tbai-progress", data: { step: 1 } },
        { type: "text", text: "working" },
      ] } },
    ];
    const conv = await createTestConversation(messages);

    const submittedMessages = messages.map((m) => m.content as UIMessage);

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("approval/pending interaction: OLD == P1′", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [{ type: "text", text: "delete file" }] } },
      { id: "m2", parent_id: "m1", content: { id: "m2", role: "assistant", parts: [
        { type: "tool-delete_file", toolCallId: "tc1", state: "approval-requested", input: { path: "a.txt" }, approval: { id: "ap1" } },
      ] } },
    ];
    const conv = await createTestConversation(messages);

    const submittedMessages = messages.map((m) => m.content as UIMessage);

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("scheduler success: OLD == P1′", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] } },
      { id: "m2", parent_id: "m1", content: { id: "m2", role: "assistant", parts: [{ type: "text", text: "hi" }] } },
      { id: "sched1", parent_id: "m2", content: { id: "sched1", role: "user", parts: [{ type: "text", text: "Scheduled run of job" }] } },
      { id: "sched2", parent_id: "sched1", content: { id: "sched2", role: "assistant", parts: [{ type: "text", text: "result" }] } },
    ];
    const conv = await createTestConversation(messages);

    const submittedMessages = messages.map((m) => m.content as UIMessage);

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("scheduler failure: OLD == P1′", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] } },
      { id: "m2", parent_id: "m1", content: { id: "m2", role: "assistant", parts: [{ type: "text", text: "hi" }] } },
      { id: "sched1", parent_id: "m2", content: { id: "sched1", role: "user", parts: [{ type: "text", text: "Scheduled run of job" }] } },
      { id: "sched2", parent_id: "sched1", content: { id: "sched2", role: "assistant", parts: [{ type: "text", text: "Error: timeout" }] } },
    ];
    const conv = await createTestConversation(messages);

    const submittedMessages = messages.map((m) => m.content as UIMessage);

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("detached completion: OLD == P1′", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] } },
      { id: "m2", parent_id: "m1", content: { id: "m2", role: "assistant", parts: [{ type: "text", text: "hi" }] } },
      { id: "detached", parent_id: null, content: { id: "detached", role: "assistant", parts: [{ type: "text", text: "detached" }] } },
    ];
    const conv = await createTestConversation(messages);

    // Only submit the main chain, not the detached message
    const submittedMessages = [
      messages[0].content,
      messages[1].content,
    ] as UIMessage[];

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("regenerate: OLD == P1′", async () => {
    const messages = [
      { id: "a", parent_id: null, content: { id: "a", role: "user", parts: [{ type: "text", text: "a" }] } },
      { id: "b", parent_id: "a", content: { id: "b", role: "assistant", parts: [{ type: "text", text: "b" }] } },
      { id: "c", parent_id: "b", content: { id: "c", role: "user", parts: [{ type: "text", text: "c" }] } },
      { id: "d", parent_id: "b", content: { id: "d", role: "assistant", parts: [{ type: "text", text: "d" }] } },
    ];
    const conv = await createTestConversation(messages);

    // Select the regenerated branch (a -> b -> d)
    const submittedMessages = [
      messages[0].content,
      messages[1].content,
      messages[3].content,
    ] as UIMessage[];

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("manual compaction: OLD == P1′", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] } },
      { id: "m2", parent_id: "m1", content: { id: "m2", role: "assistant", parts: [{ type: "text", text: "hi" }] } },
    ];
    const conv = await createTestConversation(messages);

    const submittedMessages = messages.map((m) => m.content as UIMessage);

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("automatic compaction: OLD == P1′", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] } },
    ];
    const conv = await createTestConversation(messages);

    const submittedMessages = messages.map((m) => m.content as UIMessage);

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("recovery compaction: OLD == P1′", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] } },
    ];
    const conv = await createTestConversation(messages);

    const submittedMessages = messages.map((m) => m.content as UIMessage);

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("multiple compaction generations: OLD == P1′", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] } },
    ];
    const conv = await createTestConversation(messages);

    const submittedMessages = messages.map((m) => m.content as UIMessage);

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("stale-boundary repair: OLD == P1′", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] } },
    ];
    const conv = await createTestConversation(messages);

    const submittedMessages = messages.map((m) => m.content as UIMessage);

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("preserved synthetic messages: OLD == P1′", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] } },
    ];
    const conv = await createTestConversation(messages);

    const submittedMessages = messages.map((m) => m.content as UIMessage);

    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    expect(canonicalize(newResult.context.layerC.messages)).toBe(canonicalize(oldResult.context.layerC.messages));
  });

  it("missing compaction span: fail closed", async () => {
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] } },
    ];
    const conv = await createTestConversation(messages);

    const submittedMessages = messages.map((m) => m.content as UIMessage);

    const newResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });

    // Should not fabricate a summary
    expect(newResult.context.layerC.messages.length).toBe(1);
  });

  it("CONTROL: the two paths genuinely diverge on a truncated client window", async () => {
    // ## Why this exists
    //
    // Every scenario above asserts only that OLD and P1′ produce the SAME Layer C.
    // That assertion is satisfied trivially whenever P1′ does not engage — an inert
    // reconstruction and a faithful one are indistinguishable when the client
    // resubmits the whole history, because both then see identical input.
    //
    // So the equality results above are only meaningful if `disableP1p` really does
    // select a different code path. This is the control that establishes it: the
    // server holds four messages, the client submits only the last one, and the two
    // paths MUST then disagree — P1′ restores the server prefix, OLD cannot.
    //
    // Without a control like this, "OLD == P1′" is evidence of nothing.
    const messages = [
      { id: "m1", parent_id: null, content: { id: "m1", role: "user", parts: [{ type: "text", text: "first" }] } },
      { id: "m2", parent_id: "m1", content: { id: "m2", role: "assistant", parts: [{ type: "text", text: "second" }] } },
      { id: "m3", parent_id: "m2", content: { id: "m3", role: "user", parts: [{ type: "text", text: "third" }] } },
      { id: "m4", parent_id: "m3", content: { id: "m4", role: "assistant", parts: [{ type: "text", text: "fourth" }] } },
    ];
    const conv = await createTestConversation(messages);

    // The client window holds ONLY the last message, as a bounded client window would.
    const submittedMessages = [messages[3]!.content as UIMessage];

    const shared = {
      conversationId: conv.id,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    };

    const oldResult = await assembleContext({ ...shared, disableP1p: true });
    const newResult = await assembleContext({ ...shared });

    const oldIds = oldResult.context.layerC.messages.map((m) => (m as { id?: string }).id);
    const newIds = newResult.context.layerC.messages.map((m) => (m as { id?: string }).id);

    // OLD trusts the client: it has only what the client sent.
    expect(oldIds).toEqual(["m4"]);

    // P1′ rebuilds the prefix from the head chain and restores all four.
    expect(newIds).toEqual(["m1", "m2", "m3", "m4"]);

    // So the equality asserted by every scenario above is a real comparison.
    expect(canonicalize(newResult.context.layerC.messages)).not.toBe(
      canonicalize(oldResult.context.layerC.messages),
    );
  });

  // ── fail-closed regressions ────────────────────────────────────────────────

  function userMsg(id: string, text: string) {
    return { id, parent_id: null, content: { id, role: "user", parts: [{ type: "text", text }] } };
  }
  function assistantMsg(id: string, text: string) {
    return { id, parent_id: null, content: { id, role: "assistant", parts: [{ type: "text", text }] } };
  }
  function idsOf(result: { context: { layerC: { messages: readonly UIMessage[] } } }): string[] {
    return result.context.layerC.messages.map((m) => String((m as { id?: string }).id));
  }
  function assemble(convId: string, submittedMessages: UIMessage[]) {
    return assembleContext({
      conversationId: convId,
      submittedMessages,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
    });
  }

  it("fail closed when the client's OLDEST submitted message is not persisted", async () => {
    // The boundary is exactly `submittedMessages[0].id`. `x0` exists only on the
    // client, so it is NOT on the authoritative chain — P1′ must hand the whole
    // submission back untouched rather than scan forward to `m1` and drop `x0`.
    const m1 = assistantMsg("m1", "one");
    const m2 = userMsg("m2", "two");
    const m3 = assistantMsg("m3", "three");
    const conv = await createTestConversation([
      { ...m1, parent_id: null },
      { ...m2, parent_id: "m1" },
      { ...m3, parent_id: "m2" },
    ]);

    const x0 = { id: "x0", role: "user", parts: [{ type: "text", text: "client-only leading message" }] };
    const submitted = [x0, m1.content, m2.content, m3.content] as unknown as UIMessage[];

    const result = await assemble(conv.id, submitted);

    // Every submitted id survives: no silent loss.
    expect(idsOf(result)).toEqual(["x0", "m1", "m2", "m3"]);
    expect(result.context.layerC.messages.length).toBe(submitted.length);
  });

  it("fail closed when the persisted head chain is truncated by a dangling parent", async () => {
    // `a4`'s parent (`a3`) is missing, so the walk cannot prove it reached a root.
    // The rows above the break are unreachable; splicing the partial chain would
    // silently drop `a1`, `a2` and `a3` from the request.
    const rows = [
      { ...assistantMsg("a1", "one"), parent_id: null },
      { ...userMsg("a2", "two"), parent_id: "a1" },
      { ...assistantMsg("a3", "three"), parent_id: "a2" },
      { ...userMsg("a4", "four"), parent_id: "a3" },
    ];
    const conv = await createTestConversation(rows);
    db.run("DELETE FROM messages WHERE conversation_id = ? AND id = ?", [conv.id, "a3"]);

    // The chain walk reports itself incomplete.
    const chain = await messageService.getHeadChain(conv.id);
    expect(chain.complete).toBe(false);
    expect(chain.messages.map((m) => m.id)).toEqual(["a4"]);

    const submitted = rows.map((r) => r.content) as unknown as UIMessage[];
    const result = await assemble(conv.id, submitted);

    // The full submitted history is retained, not just the reachable tip.
    expect(idsOf(result)).toEqual(["a1", "a2", "a3", "a4"]);
  });

  it("a legitimate root is a complete chain and still reconstructs the prefix", async () => {
    // Guards the correction: fail-closed must not disable P1′. A chain that ends at
    // a row whose parent_id IS NULL is complete, and a windowed client submission is
    // still rebuilt from the persisted prefix ahead of its boundary.
    const rows = [
      { ...assistantMsg("m1", "one"), parent_id: null },
      { ...userMsg("m2", "two"), parent_id: "m1" },
      { ...assistantMsg("m3", "three"), parent_id: "m2" },
      { ...userMsg("m4", "four"), parent_id: "m3" },
    ];
    const conv = await createTestConversation(rows);

    const chain = await messageService.getHeadChain(conv.id);
    expect(chain.complete).toBe(true);
    expect(chain.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);

    // Client window starts at m3: the persisted prefix m1..m2 is restored.
    const window = [rows[2]!.content, rows[3]!.content] as unknown as UIMessage[];
    const result = await assemble(conv.id, window);
    expect(idsOf(result)).toEqual(["m1", "m2", "m3", "m4"]);

    // The prefix came from the server, not the client.
    const oldResult = await assembleContext({
      conversationId: conv.id,
      submittedMessages: window,
      runId: "test",
      provider: { id: "test", type: "openai", models: [] } as any,
      modelId: "test",
      systemPrompt: undefined,
      toolSignal: new AbortController().signal,
      disableP1p: true,
    });
    expect(idsOf(oldResult)).toEqual(["m3", "m4"]);
  });
});
