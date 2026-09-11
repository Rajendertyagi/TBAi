import { Hono } from "hono";
import { registry } from "../config/providers";
import { conversationService, messageService } from "../services/storage";
import { conversationCreateSchema, conversationUpdateSchema, messageUpsertSchema } from "../lib/validation";
import { storageError } from "./shared";

const app = new Hono();

// Conversation routes
app.get("/api/conversations", async (c) => {
  try {
    const statusQuery = c.req.query("status");
    const status = statusQuery === "archived" || statusQuery === "regular" ? statusQuery : undefined;
    const search = c.req.query("search") || undefined;
    const limit = Number(c.req.query("limit") ?? 200);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await conversationService.list({ status, search, limit, offset });
    return c.json(result);
  } catch (e) {
    return storageError(c, e);
  }
});

app.post("/api/conversations", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = conversationCreateSchema.parse(body);
    const activeProvider = registry.getActive();
    const provider =
      (parsed.providerId && registry.get(parsed.providerId)) || activeProvider;
    // New chats default non-null to the active provider's model + reasoning
    // level so every conversation owns a concrete config from creation.
    const modelId = parsed.modelId ?? provider?.model ?? null;
    const reasoningLevel =
      parsed.reasoningLevel ?? provider?.thinking ?? "off";

    const conversation = await conversationService.create({
      title: parsed.title || "New Conversation",
      providerId: provider?.id || activeProvider?.id || "",
      modelId,
      reasoningLevel,
      systemPrompt: parsed.systemPrompt,
    });

    return c.json(conversation);
  } catch (e) {
    return storageError(c, e);
  }
});

app.get("/api/conversations/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const conversation = await conversationService.get(id);

    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    return c.json(conversation);
  } catch (e) {
    return storageError(c, e);
  }
});

app.get("/api/conversations/:id/messages", async (c) => {
  try {
    const id = c.req.param("id");
    const conversation = await conversationService.get(id);
    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    const messages = await messageService.listThreadMessages(id);
    return c.json({ messages });
  } catch (e) {
    return storageError(c, e);
  }
});

app.post("/api/conversations/:id/messages", async (c) => {
  try {
    const id = c.req.param("id");
    const conversation = await conversationService.get(id);
    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    const body = await c.req.json();
    const parsed = messageUpsertSchema.parse(body);

    await messageService.upsertStored(id, {
      id: parsed.message.id,
      parent_id: parsed.message.parent_id ?? null,
      format: parsed.message.format,
      content: parsed.message.content,
    });
    return c.json({ success: true });
  } catch (e) {
    return storageError(c, e);
  }
});

app.delete("/api/conversations/:id/messages/:messageId", async (c) => {
  try {
    const id = c.req.param("id");
    const messageId = c.req.param("messageId");
    await messageService.deleteThreadMessage(id, messageId);
    return c.json({ success: true });
  } catch (e) {
    return storageError(c, e);
  }
});

app.patch("/api/conversations/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const parsed = conversationUpdateSchema.parse(body);
    const conversation = await conversationService.update(id, {
      ...parsed,
      // Normalize "unset" sentinels to undefined so they don't overwrite an
      // existing persisted value with null on a partial PATCH.
      modelId: parsed.modelId === null ? undefined : parsed.modelId,
      reasoningLevel:
        parsed.reasoningLevel === null ? undefined : parsed.reasoningLevel,
    });
    return c.json(conversation);
  } catch (e) {
    return storageError(c, e);
  }
});

app.delete("/api/conversations/:id", async (c) => {
  try {
    const id = c.req.param("id");
    await messageService.deleteByConversation(id);
    await conversationService.delete(id);
    return c.json({ success: true });
  } catch (e) {
    return storageError(c, e);
  }
});

export default app;
