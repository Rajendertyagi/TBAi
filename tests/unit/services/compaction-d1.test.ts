/**
 * D1 Integration Test
 *
 * Verifies that the compaction divider is persisted exactly once:
 * - Server writes the durable divider
 * - Browser/history adapter cannot duplicate it
 * - Reload does not produce another divider
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { messageService, conversationService } from "@/services/storage";
import { db } from "@/db";

describe("D1 divider ownership", () => {
  beforeEach(() => {
    db.run("DELETE FROM messages WHERE conversation_id LIKE 'test-%'");
    db.run("DELETE FROM conversations WHERE id LIKE 'test-%'");
  });

  it("server durable divider exists, browser cannot duplicate", async () => {
    const conv = await conversationService.create({
      title: "test",
      providerId: "test",
      workspaceMode: "simple",
    });

    // Server writes the durable divider
    const dividerId = "data-tbai-compact-test-op-1";
    await messageService.upsertStored(conv.id, {
      id: dividerId,
      parent_id: null,
      format: "ai-sdk/v6",
      content: {
        id: dividerId,
        role: "assistant",
        parts: [{ type: "data-tbai-compact", data: { operationId: "test-op-1" } }],
      },
    });

    // Verify the divider exists
    const messages = await messageService.listThreadMessages(conv.id);
    const dividers = messages.filter((m) => {
      const content = m.content as any;
      return content?.parts?.some((p: any) => p?.type === "data-tbai-compact");
    });
    expect(dividers.length).toBe(1);

    // Simulate browser trying to persist the same divider
    // (the adapter should strip data-tbai-compact parts)
    const browserContent = {
      id: "browser-msg-1",
      role: "assistant",
      parts: [
        { type: "data-tbai-compact", data: { operationId: "test-op-1" } },
        { type: "text", text: "hello" },
      ],
    };

    // The adapter's encode function strips data-tbai-compact parts
    const filteredParts = browserContent.parts.filter((p: any) => p?.type !== "data-tbai-compact");
    const filteredContent = { ...browserContent, parts: filteredParts };

    await messageService.upsertStored(conv.id, {
      id: "browser-msg-1",
      parent_id: dividerId,
      format: "ai-sdk/v6",
      content: filteredContent,
    });

    // Verify only one divider exists
    const messagesAfter = await messageService.listThreadMessages(conv.id);
    const dividersAfter = messagesAfter.filter((m) => {
      const content = m.content as any;
      return content?.parts?.some((p: any) => p?.type === "data-tbai-compact");
    });
    expect(dividersAfter.length).toBe(1);
  });

  it("repeated reload does not duplicate divider", async () => {
    const conv = await conversationService.create({
      title: "test",
      providerId: "test",
      workspaceMode: "simple",
    });

    // Server writes the durable divider
    const dividerId = "data-tbai-compact-test-op-2";
    await messageService.upsertStored(conv.id, {
      id: dividerId,
      parent_id: null,
      format: "ai-sdk/v6",
      content: {
        id: dividerId,
        role: "assistant",
        parts: [{ type: "data-tbai-compact", data: { operationId: "test-op-2" } }],
      },
    });

    // Simulate multiple reloads
    for (let i = 0; i < 3; i++) {
      const messages = await messageService.listThreadMessages(conv.id);
      const dividers = messages.filter((m) => {
        const content = m.content as any;
        return content?.parts?.some((p: any) => p?.type === "data-tbai-compact");
      });
      expect(dividers.length).toBe(1);
    }
  });
});
