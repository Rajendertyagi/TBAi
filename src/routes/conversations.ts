import { Hono } from "hono";
import type { Context } from "hono";
import { registry } from "../config/providers";
import { ConversationNotFoundError, conversationService, messageService } from "../services/storage";
import type { Conversation } from "../types";
import { terminateOpenCodeSession } from "../services/opencode/sessions";
import { logger, normalizeError } from "../lib/logger";
import {
  conversationsListQuerySchema,
  conversationCreateSchema,
  conversationUpdateSchema,
  messageUpsertSchema,
} from "../lib/validation";
import { isContentlessAssistantMessage } from "../lib/message-persistence-policy";
import { folderService } from "../services/folders";
import { storageError } from "./shared";

const app = new Hono();

/**
 * Truthful 404 for a conversation row that no longer exists. Returned by every
 * mutation that targets a missing id, so a stale client can tell "this is gone"
 * apart from "the server broke" (which is a 5xx and retryable). Same body shape
 * as the GET 404 below — one shape for "not found" across this route module.
 * The requestId is not echoed here; the edge middleware already stamps every
 * 4xx/5xx log line with it.
 */
function conversationNotFound(c: Context) {
  return c.json({ error: "Conversation not found" }, 404);
}

// Phase 4 idempotency for draft materialization: clientRequestId → conversation.
// Covers two holes the client cannot close alone: concurrent duplicate POSTs
// (singleflight: latecomers await the same creation) and commit-but-response-
// lost retries (completed map: replays resolve to the existing row).
//
// Durable replay (Task 3): the in-memory maps are the fast path for the
// process-lifetime case. The `client_request_id` column on `conversations`
// is the cross-restart source of truth: a server restart between the commit
// and the client's retry loses the maps, but `findByClientRequestId` finds
// the row by the column, so a replayed key returns the EXISTING row instead
// of minting a second one. The column + partial unique index enforce that a
// key maps to at most one row across all process lifetimes.
const CREATE_KEY_TTL_MS = 10 * 60 * 1000;

/**
 * What one idempotent create resolved to.
 *
 * `row` is the conversation to answer with. `missingId` is the rare case where
 * the create committed and the row is already unreadable, which is a 404 — kept
 * distinct from `row` so a vanished row can never be answered with a body that
 * claims it exists.
 */
type CreateOutcome =
  | { row: Conversation; replayed: boolean }
  | { missingId: string; replayed: boolean };

const createInFlight = new Map<string, Promise<CreateOutcome>>();
const createCompleted = new Map<string, { id: string; at: number }>();

function pruneCreateKeys(now: number): void {
  if (createCompleted.size <= 200) return;
  for (const [key, entry] of createCompleted) {
    if (now - entry.at > CREATE_KEY_TTL_MS) createCompleted.delete(key);
  }
}

// Conversation routes
app.get("/api/conversations", async (c) => {
  const parsed = conversationsListQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) {
    return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
  }
  try {
    const { status, ...scope } = parsed.data;
    // `"all"` is a query sentinel, not a stored status: it means "no status
    // clause". Mapping it here keeps `ConversationStatus` (the row vocabulary)
    // free of a value SQLite never holds.
    return c.json(
      await conversationService.list({
        ...scope,
        status: status === "all" ? undefined : status,
      }),
    );
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

    // Project conversations bind a live registered folder at creation: the
    // folder id must reference a non-deleted regular (project) folder. A
    // stale/foreign id fails truthfully here instead of minting a row that
    // can never resolve its workspace.
    if ((parsed.workspaceMode ?? "simple") === "project") {
      const folder = parsed.workspaceFolderId
        ? await folderService.get(parsed.workspaceFolderId)
        : null;
      if (!folder || folder.kind === "chat") {
        logger.warn("workspace", "workspace.rejected", {
          reason: "folder_not_available",
          folderId: parsed.workspaceFolderId ?? null,
        });
        return c.json(
          { error: "Project folder is not available" },
          400,
        );
      }
    }

    // Idempotent create (Phase 4): same clientRequestId resolves to the same
    // conversation. In-flight duplicates share one creation; completed keys
    // replay the existing row (see module map + limitation note above).
    // Lifecycle evidence for the draft→row transition — the highest-value
    // conversation event, and the one a duplicate-row bug would surface in.
    // `replayed` distinguishes a fresh materialization from an idempotent
    // replay of the same clientRequestId, so a duplicate can never be
    // mistaken for two real creations. Values are never logged (title is user
    // text); only ids, enums and presence flags.
    const materialized = (
      row: {
        id: string;
        engine?: string | null;
        workspaceMode?: string | null;
        providerId?: string | null;
        modelId?: string | null;
      },
      replayed: boolean,
    ) => {
      logger.info("conversations", "conversation.materialize", {
        conversationId: row.id,
        engine: row.engine ?? "direct",
        workspaceMode: row.workspaceMode ?? "simple",
        providerConfigured: row.providerId != null,
        modelConfigured: row.modelId != null,
        replayed,
      });
      return c.json(row);
    };

    const idempotencyKey = parsed.clientRequestId ?? null;

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
        clientRequestId: parsed.clientRequestId ?? null,
      });
    };

    if (!idempotencyKey) {
      return materialized(await createOne(), false);
    }

    // The singleflight reservation is taken SYNCHRONOUSLY, before this handler's
    // first `await`, and the promise it stores owns the whole decision (completed
    // map → durable column → create). That ordering is the whole fix.
    //
    // Deciding needs awaits, so when the reservation was registered *after* them
    // (the old order), a duplicate arriving during those awaits also concluded
    // "no row carries this key" and called createOne() a second time. The loser's
    // INSERT then hit the partial unique index on `client_request_id` and the
    // route reported it as a 500 — a request the contract defines as a replay.
    // The loser had also already created a chat workspace (dir + `folders` row)
    // before the INSERT, so every rejected duplicate leaked one.
    //
    // Nothing is caught here on purpose: a genuine storage failure inside the
    // creation still propagates (and still answers 5xx) to every request sharing
    // the key. Only the duplicate INSERT is prevented, never an error.
    const reserved = createInFlight.get(idempotencyKey);
    const creation: Promise<CreateOutcome> =
      reserved ??
      (async () => {
        // Replay of a key that already completed in this process.
        const completed = createCompleted.get(idempotencyKey);
        if (completed && Date.now() - completed.at <= CREATE_KEY_TTL_MS) {
          const row = await conversationService.get(completed.id);
          if (row) return { row, replayed: true };
          createCompleted.delete(idempotencyKey);
        }

        // Durable replay (Task 3): a restart between the commit and this retry
        // loses both in-memory maps, so fall back to the SQLite column. If a
        // row already carries this key, return it — never mint a second row.
        const durable = await conversationService.findByClientRequestId(idempotencyKey);
        if (durable) return { row: durable, replayed: true };

        const created = await createOne();
        pruneCreateKeys(Date.now());
        createCompleted.set(idempotencyKey, { id: created.id, at: Date.now() });
        const row = await conversationService.get(created.id);
        // The create committed but the row is already unreadable: report the
        // truth (it is gone) instead of answering with a row that does not exist.
        if (!row) return { missingId: created.id, replayed: false };
        return { row, replayed: false };
      })();
    // Registered before the first `await` below, so a duplicate that arrives
    // while this decision is still running joins it instead of starting its own.
    if (!reserved) createInFlight.set(idempotencyKey, creation);
    try {
      const outcome = await creation;
      if ("missingId" in outcome) return conversationNotFound(c);
      return materialized(outcome.row, outcome.replayed);
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

    // Opening is a read, and this route is also the existence probe every
    // surface mounts with — so it is recorded at debug (visible when tracing a
    // lifecycle, quiet under normal production capture) rather than as a second
    // info line beside the http audit entry.
    logger.debug("conversations", "conversation.open", {
      conversationId: id,
      engine: conversation.engine ?? "direct",
    });
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

    // A message with nothing renderable in it is not a reply yet. The client
    // posts an assistant row the moment a run STARTS, when the runtime holds only
    // the UI-only progress part; if the run then dies, that row would survive
    // forever as a blank bubble. Refusing the write means the phantom is never
    // created — no cleanup pass, nothing to race, and a reconnect cannot bring it
    // back. The real reply arrives seconds later as an update to this same id and
    // is persisted normally.
    //
    // This is the CLIENT boundary only. `messageService.upsertStored` is
    // untouched, so server-side writers (detached-run finalization, the scheduler)
    // keep writing whatever they intend.
    if (isContentlessAssistantMessage(parsed.message.content)) {
      logger.debug("conversations", "conversation.message_shell_skipped", {
        conversationId: id,
        messageId: parsed.message.id,
        format: parsed.message.format,
      });
      return c.json({ success: true, persisted: false });
    }

    await messageService.upsertStored(id, {
      id: parsed.message.id,
      parent_id: parsed.message.parent_id ?? null,
      format: parsed.message.format,
      content: parsed.message.content,
    });
    return c.json({ success: true, persisted: true });
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
    // A mutation against a missing row is a stale-client condition, not a
    // server fault: answer 404 so the caller can stop referencing it, instead
    // of a 5xx that reads as "retry".
    if (!old) return conversationNotFound(c);
    const oldFolderId = old.workspaceFolderId ?? null;

    // Effective-state guard: a patch that would leave the row project-scoped
    // with no live folder (mode flip without an id, or an id pointing at a
    // deleted/chat folder) fails truthfully. Without this, the row would
    // silently convert to simple on first filesystem use.
    const effectiveMode = parsed.workspaceMode ?? old.workspaceMode ?? "simple";
    const effectiveFolderId =
      parsed.workspaceMode === "simple" || parsed.workspaceFolderId === null
        ? null
        : (parsed.workspaceFolderId ?? oldFolderId);
    if (effectiveMode === "project") {
      const folder = effectiveFolderId
        ? await folderService.get(effectiveFolderId)
        : null;
      if (!folder || folder.kind === "chat") {
        logger.warn("workspace", "workspace.rejected", {
          reason: "folder_not_available",
          conversationId: id,
          folderId: effectiveFolderId,
        });
        return c.json(
          { error: "Project folder is not available" },
          400,
        );
      }
    }

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

    // Which fields changed — names only, never values (title/systemPrompt are
    // user text). This is what makes "did my update land, and what did it
    // touch" answerable without diffing rows by hand.
    logger.info("conversations", "conversation.update", {
      conversationId: id,
      fields: Object.keys(parsed).sort().join(",") || "none",
      engine: conversation.engine ?? "direct",
      ...(parsed.status ? { status: parsed.status } : {}),
    });
    return c.json(conversation);
  } catch (e) {
    // A row deleted between the existence check and the UPDATE is the same
    // stale-client condition, not a server fault.
    if (e instanceof ConversationNotFoundError) return conversationNotFound(c);
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
    const deleted = await conversationService.delete(id);
    // Cleanup hidden chat folder if no other conversations reference it.
    if (folderId) {
      await folderService.cleanupChatFolder(folderId);
    }
    // Truthful teardown record. `deleted:false` means the row was already gone
    // (a repeat or raced delete): the desired end state still holds, but the
    // difference is visible instead of being flattened into "success".
    logger.info("conversations", "conversation.delete", {
      conversationId: id,
      deleted,
      ...(conv ? { engine: conv.engine ?? "direct" } : {}),
    });
    return c.json({ success: true, deleted });
  } catch (e) {
    return storageError(c, e);
  }
});

export default app;
