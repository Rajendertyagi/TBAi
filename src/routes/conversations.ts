import { Hono } from "hono";
import { registry } from "../config/providers";
import { conversationService, messageService } from "../services/storage";
import { terminateOpenCodeSession } from "../services/opencode/sessions";
import { logger, normalizeError } from "../lib/logger";
import { conversationCreateSchema, conversationUpdateSchema, messageUpsertSchema } from "../lib/validation";
import { folderService } from "../services/folders";
import { storageError } from "./shared";

const app = new Hono();

// Phase 4 idempotency for draft materialization: clientRequestId → conversation.
// Covers two holes the client cannot close alone: concurrent duplicate POSTs
// (singleflight: latecomers await the same creation) and commit-but-response-
// lost retries (completed map: replays resolve to the existing row). Plain
// in-memory maps — no new table, no migration.
//
// Documented limitation: process lifetime only. A server restart between the
// commit and the client retry loses the map, and the retry mints a second
// row. No existing conversations-table field can carry the identity without
// semantic abuse (every TEXT column owns a feature meaning; title_source is
// CHECK-constrained), so durable cross-restart idempotency would require a
// migration — explicitly deferred, not pretended.
const CREATE_KEY_TTL_MS = 10 * 60 * 1000;
const createInFlight = new Map<string, Promise<{ id: string }>>();
const createCompleted = new Map<string, { id: string; at: number }>();

function pruneCreateKeys(now: number): void {
  if (createCompleted.size <= 200) return;
  for (const [key, entry] of createCompleted) {
    if (now - entry.at > CREATE_KEY_TTL_MS) createCompleted.delete(key);
  }
}

// Conversation routes
app.get("/api/conversations", async (c) => {
  try {
    const statusQuery = c.req.query("status");
    const status = statusQuery === "regular" || statusQuery === "archived" ? statusQuery : undefined;
    const search = c.req.query("search") || undefined;
    const orderQuery = c.req.query("order");
    const order = orderQuery === "created" ? "created" : "updated";
    const limit = Number(c.req.query("limit") ?? 200);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await conversationService.list({ status, search, limit, offset, order });
    return c.json(result);
  } catch (e) {
    return storageError(c, e);
  }
});

app.post("/api/conversations", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = conversationCreateSchema.parse(body);
    // Phase 2 contract: persist explicit values as-given; absent stays absent
    // (NULL), resolved to global defaults only at request time. The server
    // must NOT concretize active-provider values into the row — a persisted
    // value means "the user chose this" and must survive refresh/switching.
    // (Rows created before this contract carry baked defaults that are
    // indistinguishable from explicit choices; only new behavior is covered.)
    const provider =
      (parsed.providerId && registry.get(parsed.providerId)) || null;
    const modelId = parsed.modelId ?? null;
    const reasoningLevel = parsed.reasoningLevel ?? null;

    // Idempotent create (Phase 4): same clientRequestId resolves to the same
    // conversation. In-flight duplicates share one creation; completed keys
    // replay the existing row (see module map + limitation note above).
    const idempotencyKey = parsed.clientRequestId ?? null;
    if (idempotencyKey) {
      const inFlight = createInFlight.get(idempotencyKey);
      if (inFlight) {
        const existing = await inFlight;
        const row = await conversationService.get(existing.id);
        if (row) return c.json(row);
      } else {
        const completed = createCompleted.get(idempotencyKey);
        if (completed && Date.now() - completed.at <= CREATE_KEY_TTL_MS) {
          const row = await conversationService.get(completed.id);
          if (row) return c.json(row);
          createCompleted.delete(idempotencyKey);
        }
      }
    }

    const createOne = async () => {
      return conversationService.create({
        title: parsed.title || "New Conversation",
        providerId: provider?.id ?? parsed.providerId ?? null,
        modelId,
        reasoningLevel,
        systemPrompt: parsed.systemPrompt,
        workspaceMode: parsed.workspaceMode ?? "simple",
        workspaceFolderId: parsed.workspaceFolderId ?? null,
        engine: parsed.engine ?? "direct",
        opencodeAgent: parsed.opencodeAgent ?? null,
        opencodeModel: parsed.opencodeModel ?? null,
        opencodeVariant: parsed.opencodeVariant ?? null,
        opencodeAutoApprove: parsed.opencodeAutoApprove ?? false,
      });
    };

    if (!idempotencyKey) {
      return c.json(await createOne());
    }

    const creation = createOne().then((conversation) => ({ id: conversation.id }));
    createInFlight.set(idempotencyKey, creation);
    try {
      const created = await creation;
      pruneCreateKeys(Date.now());
      createCompleted.set(idempotencyKey, { id: created.id, at: Date.now() });
      const conversation = await conversationService.get(created.id);
      return c.json(conversation);
    } finally {
      if (createInFlight.get(idempotencyKey) === creation) {
        createInFlight.delete(idempotencyKey);
      }
    }
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

    // Capture old folder id before update so we can clean up hidden chat
    // folders when switching modes (codeg parity).
    const old = await conversationService.get(id);
    const oldFolderId = old?.workspaceFolderId ?? null;

    const conversation = await conversationService.update(id, {
      ...parsed,
      // Phase 2 contract: explicit null clears the field (storage.update
      // writes NULL for null, skips undefined). Omitted fields stay
      // undefined via the schema and preserve existing values.
      // A simple chat must not retain a folder. Switching the mode to "simple"
      // clears the folder id; an explicit null also clears it; otherwise leave
      // an unspecified value untouched.
      workspaceFolderId:
        parsed.workspaceMode === "simple"
          ? null
          : parsed.workspaceFolderId === null
            ? null
            : parsed.workspaceFolderId ?? undefined,
    });

    // Cleanup old hidden chat folder when switching away from simple mode,
    // or when the folder id changed. The GC would eventually reclaim it, but
    // eager cleanup is cleaner (codeg parity).
    if (oldFolderId && oldFolderId !== conversation.workspaceFolderId) {
      await folderService.cleanupChatFolder(oldFolderId);
    }

    return c.json(conversation);
  } catch (e) {
    return storageError(c, e);
  }
});

app.delete("/api/conversations/:id", async (c) => {
  try {
    const id = c.req.param("id");
    // Capture the folder id before deleting the conversation so we can
    // clean up the hidden chat folder afterward.
    const conv = await conversationService.get(id);
    const folderId = conv?.workspaceFolderId ?? null;
    // Phase 6: terminate the bound OpenCode session BEFORE the deletes —
    // terminate reads the conversation row for the session id, and only
    // opencode-engine conversations own a session. Best-effort: a failed
    // cleanup is logged and never blocks conversation teardown.
    if (conv?.engine === "opencode") {
      try {
        await terminateOpenCodeSession(id);
      } catch (err) {
        logger.warn("opencode", "conversation_delete_terminate_failed", {
          conversationId: id,
          ...normalizeError(err),
        });
      }
    }
    await messageService.deleteByConversation(id);
    await conversationService.delete(id);
    // Cleanup hidden chat folder if no other conversations reference it.
    if (folderId) {
      await folderService.cleanupChatFolder(folderId);
    }
    return c.json({ success: true });
  } catch (e) {
    return storageError(c, e);
  }
});

export default app;
