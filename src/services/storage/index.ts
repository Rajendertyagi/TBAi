import { db } from "../../db";
import { generateId } from "../../lib/utils";
import type { SQLQueryBindings } from "bun:sqlite";
import type { Conversation, ConversationStatus, Message, Memory, WorkspaceMode } from "../../types";
import { createChatWorkspace } from "../workspace";

interface ConversationRow {
  id: string;
  title: string;
  provider_id: string | null;
  model_id: string | null;
  reasoning_level: string | null;
  system_prompt: string | null;
  status: string;
  title_source: string | null;
  workspace_mode: string;
  workspace_folder_id: string | null;
  opencode_session_id: string | null;
  engine: string | null;
  opencode_agent: string | null;
  opencode_model: string | null;
  opencode_variant: string | null;
  opencode_auto_approve: number | null;
  client_request_id: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  parent_id: string | null;
  format: string;
  content: string;
}

interface MemoryRow {
  id: string;
  content: string;
  created_at: number;
  updated_at: number;
}

// The opaque serialized message body produced by the runtime's format adapter.
interface StoredMessageContent {
  content?: Array<{ type?: unknown; text?: unknown }>;
}

export interface ConversationListOptions {
  status?: ConversationStatus;
  search?: string;
  limit?: number;
  offset?: number;
  /** Newest-first key. Defaults to `updated` (last activity). */
  order?: "updated" | "created";
}

export interface ConversationListResult {
  threads: Conversation[];
  nextCursor?: string;
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    providerId: row.provider_id,
    modelId: row.model_id ?? null,
    reasoningLevel: row.reasoning_level ?? null,
    systemPrompt: row.system_prompt,
    status: (row.status as ConversationStatus) ?? "regular",
    titleSource: row.title_source as "auto" | "user" | undefined,
    workspaceMode: (row.workspace_mode as WorkspaceMode) ?? "simple",
    workspaceFolderId: row.workspace_folder_id ?? null,
    opencodeSessionId: row.opencode_session_id ?? null,
    engine: (row.engine as "direct" | "opencode") ?? "direct",
    opencodeAgent: row.opencode_agent ?? null,
    opencodeModel: row.opencode_model ?? null,
    opencodeVariant: row.opencode_variant ?? null,
    opencodeAutoApprove: row.opencode_auto_approve === 1,
    clientRequestId: row.client_request_id ?? null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Thrown when a mutation targets a conversation row that does not exist.
 *
 * Typed so the route layer can answer 404 ("this conversation is gone") instead
 * of a generic 500. The distinction matters to callers: a 5xx says the server
 * is at fault and invites a retry, while a missing row means the client's view
 * is stale and the correct response is to stop referencing it.
 */
export class ConversationNotFoundError extends Error {
  constructor(readonly conversationId: string) {
    super(`Conversation not found: ${conversationId}`);
    this.name = "ConversationNotFoundError";
  }
}

export const conversationService = {
  async create(
    data: Pick<
      Conversation,
      | "title"
      | "providerId"
      | "modelId"
      | "reasoningLevel"
      | "systemPrompt"
      | "workspaceMode"
      | "workspaceFolderId"
      | "opencodeSessionId"
      | "engine"
      | "opencodeAgent"
      | "opencodeModel"
      | "opencodeVariant"
      | "opencodeAutoApprove"
      | "clientRequestId"
    >,
  ): Promise<Conversation> {
    const now = Date.now();
    const id = generateId();
    const workspaceMode = data.workspaceMode ?? "simple";

    let workspaceFolderId: string | null;
    if (workspaceMode === "project") {
      workspaceFolderId = data.workspaceFolderId ?? null;
    } else {
      // Simple chats get a hidden kind='chat' folder on the stable
      // conversation-owned path (workspace/chats/<id>) so no legacy
      // data/chat/<uuid> debt accrues for new conversations.
      const { folderId } = await createChatWorkspace(id);
      workspaceFolderId = folderId;
    }

    db.run(
      "INSERT INTO conversations (id, title, provider_id, model_id, reasoning_level, system_prompt, status, workspace_mode, workspace_folder_id, opencode_session_id, engine, opencode_agent, opencode_model, opencode_variant, opencode_auto_approve, client_request_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'regular', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        data.title,
        data.providerId || null,
        data.modelId ?? null,
        data.reasoningLevel ?? null,
        data.systemPrompt || null,
        workspaceMode,
        workspaceFolderId,
        data.opencodeSessionId ?? null,
        data.engine ?? "direct",
        data.opencodeAgent ?? null,
        data.opencodeModel ?? null,
        data.opencodeVariant ?? null,
        data.opencodeAutoApprove === true ? 1 : 0,
        data.clientRequestId ?? null,
        now,
        now,
      ],
    );
    const created = await this.get(id);
    if (!created) throw new Error("Failed to create conversation");
    return created;
  },

  /**
   * Look up a conversation by its durable idempotency key (Task 3).
   *
   * This is the cross-restart replay path: when a client retries a draft
   * materialization with the same `clientRequestId` after a server restart,
   * the in-memory `createCompleted` map is lost, but the column survives in
   * SQLite. Returns the existing row, or `null` when no row carries the key.
   *
   * @param clientRequestId - The client's idempotency key.
   * @returns The conversation row, or `null` if no row carries the key.
   */
  async findByClientRequestId(
    clientRequestId: string,
  ): Promise<Conversation | null> {
    const row = db
      .query<ConversationRow, SQLQueryBindings[]>(
        "SELECT * FROM conversations WHERE client_request_id = ?",
      )
      .get(clientRequestId);
    return row ? mapConversation(row) : null;
  },

  async list(options: ConversationListOptions = {}): Promise<ConversationListResult> {
    const { status, search, limit = 50, offset = 0, order = "updated" } = options;
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (status) {
      clauses.push("c.status = ?");
      params.push(status);
    }
    if (search) {
      // Server-side content search: FTS5 sidecar over title + message content,
      // with a LIKE fallback if FTS is unavailable or yields nothing.
      const q = search.trim().replace(/"/g, '""');
      clauses.push(`(
        c.title LIKE ?
        OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ?)
        OR c.id IN (SELECT conversation_id FROM conv_fts WHERE conv_fts MATCH ?)
      )`);
      params.push(`%${search}%`, `%${search}%`, `"${q}"*`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    // Whitelisted column branch (never interpolated input) — `created` is
    // newest-first by creation, `updated` (default) by last activity.
    const orderBy =
      order === "created" ? "c.created_at DESC" : "c.updated_at DESC";
    const rows = db
      .query<ConversationRow, SQLQueryBindings[]>(
        `SELECT c.* FROM conversations c ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    const totalRow = db
      .query<{ c: number }, SQLQueryBindings[]>(`SELECT COUNT(*) as c FROM conversations c ${where}`)
      .get(...params);
    const total = totalRow?.c ?? 0;
    const threads = rows.map(mapConversation);
    const nextCursor = offset + limit < total ? String(offset + limit) : undefined;
    return { threads, nextCursor };
  },

  async get(id: string): Promise<Conversation | null> {
    const row = db.query<ConversationRow, SQLQueryBindings[]>("SELECT * FROM conversations WHERE id = ?").get(id);
    return row ? mapConversation(row) : null;
  },

  async update(
    id: string,
    data: Partial<Pick<Conversation, "title" | "providerId" | "modelId" | "reasoningLevel" | "systemPrompt" | "status" | "titleSource" | "workspaceMode" | "workspaceFolderId" | "opencodeSessionId" | "engine" | "opencodeAgent" | "opencodeModel" | "opencodeVariant" | "opencodeAutoApprove">>,
  ): Promise<Conversation> {
    const updates: string[] = [];
    const values: SQLQueryBindings[] = [];

    if (data.title !== undefined) {
      updates.push("title = ?");
      values.push(data.title);
    }
    if (data.providerId !== undefined) {
      updates.push("provider_id = ?");
      values.push(data.providerId);
    }
    if (data.modelId !== undefined) {
      updates.push("model_id = ?");
      values.push(data.modelId);
    }
    if (data.reasoningLevel !== undefined) {
      updates.push("reasoning_level = ?");
      values.push(data.reasoningLevel);
    }
    if (data.systemPrompt !== undefined) {
      updates.push("system_prompt = ?");
      values.push(data.systemPrompt);
    }
    if (data.status !== undefined) {
      updates.push("status = ?");
      values.push(data.status);
    }
    if (data.titleSource !== undefined) {
      updates.push("title_source = ?");
      values.push(data.titleSource);
    }
    if (data.workspaceMode !== undefined) {
      updates.push("workspace_mode = ?");
      values.push(data.workspaceMode);
    }
    if (data.workspaceFolderId !== undefined) {
      // A simple chat must not retain a folder; a project chat keeps its id.
      const folderId =
        data.workspaceMode === "simple" ? null : (data.workspaceFolderId ?? null);
      updates.push("workspace_folder_id = ?");
      values.push(folderId);
    }
    if (data.opencodeSessionId !== undefined) {
      updates.push("opencode_session_id = ?");
      values.push(data.opencodeSessionId);
    }
    if (data.engine !== undefined) {
      updates.push("engine = ?");
      values.push(data.engine);
    }
    if (data.opencodeAgent !== undefined) {
      updates.push("opencode_agent = ?");
      values.push(data.opencodeAgent);
    }
    if (data.opencodeModel !== undefined) {
      updates.push("opencode_model = ?");
      values.push(data.opencodeModel);
    }
    if (data.opencodeVariant !== undefined) {
      updates.push("opencode_variant = ?");
      values.push(data.opencodeVariant);
    }
    if (data.opencodeAutoApprove !== undefined) {
      updates.push("opencode_auto_approve = ?");
      values.push(data.opencodeAutoApprove === true ? 1 : 0);
    }

    updates.push("updated_at = ?");
    values.push(Date.now(), id);

    db.run(`UPDATE conversations SET ${updates.join(", ")} WHERE id = ?`, values);
    const updated = await this.get(id);
    // A missing row is NOT a server fault: the caller asked to modify something
    // that no longer exists (deleted concurrently, or a stale client id).
    if (!updated) throw new ConversationNotFoundError(id);
    return updated;
  },

  /** Removes the conversation and its messages. Returns whether a row existed. */
  async delete(id: string): Promise<boolean> {
    db.run("DELETE FROM messages WHERE conversation_id = ?", [id]);
    const before = db
      .query<{ c: number }, SQLQueryBindings[]>(
        "SELECT COUNT(*) AS c FROM conversations WHERE id = ?",
      )
      .get(id);
    db.run("DELETE FROM conversations WHERE id = ?", [id]);
    return (before?.c ?? 0) > 0;
  },
};

/**
 * Extracts plain text from an assistant-ui ThreadMessage for use as an
 * auto-generated conversation title.
 */
function threadMessageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as StoredMessageContent).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } => {
      if (typeof p !== "object" || p === null) return false;
      const part = p as { type?: unknown; text?: unknown };
      return part.type === "text" && typeof part.text === "string";
    })
    .map((p) => p.text)
    .join(" ")
    .trim();
}

export const messageService = {
  /**
   * Id of the thread tip (latest message by order) or null when empty.
   * Scheduler runs chain onto the tip so appended messages join the
   * visible tree instead of forming invisible disconnected roots.
   */
  async getThreadTip(conversationId: string): Promise<string | null> {
    const row = db
      .query<{ id: string }, SQLQueryBindings[]>(
        "SELECT id FROM messages WHERE conversation_id = ? ORDER BY order_seq DESC LIMIT 1",
      )
      .get(conversationId);
    return row?.id ?? null;
  },

  /**
   * Upserts a single stored message entry (keyed by message id). Called by the
   * ThreadHistoryAdapter's `withFormat` adapter on every append/update during a
   * run. The entry is the runtime's storage format (`{ id, parent_id, format,
   * content }`); `content` is an opaque serialized object produced by the
   * runtime's format adapter and is stored verbatim so it can be restored on
   * reload.
   */
  async upsertStored(
    conversationId: string,
    entry: { id: string; parent_id: string | null; format: string; content: unknown },
  ): Promise<void> {
    const now = Date.now();
    const existing = db
      .query<{ order_seq: number }, SQLQueryBindings[]>("SELECT order_seq FROM messages WHERE id = ?")
      .get(entry.id);
    const orderSeq = existing
      ? existing.order_seq
      : (db
          .query<{ next: number }, SQLQueryBindings[]>(
            "SELECT COALESCE(MAX(order_seq), -1) + 1 AS next FROM messages WHERE conversation_id = ?",
          )
          .get(conversationId)?.next ?? -1);

    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, parent_id, order_seq, status, format, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         parent_id = excluded.parent_id,
         format = excluded.format,
         updated_at = excluded.updated_at`,
      [
        entry.id,
        conversationId,
        null,
        JSON.stringify(entry.content),
        entry.parent_id,
        orderSeq,
        null,
        entry.format,
        now,
        now,
      ],
    );

    // Auto-title: name the conversation from the first user message text.
    // Only fires when title_source is NULL (new thread) or explicitly 'auto';
    // user-assigned titles are never overwritten by scheduler or chat runs.
    const userText = threadMessageText(entry.content);
    if (userText) {
      const conv = db
        .query<{ title: string; title_source: string | null }, SQLQueryBindings[]>(
          "SELECT title, title_source FROM conversations WHERE id = ?",
        )
        .get(conversationId);
      if (conv && (conv.title === "New Conversation" || conv.title_source === "auto")) {
        const title = userText.length > 50 ? userText.slice(0, 50) + "…" : userText;
        db.run("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", [
          title,
          now,
          conversationId,
        ]);
      }
    }
  },

  /**
   * Returns the persisted stored entries for a conversation, in order, in the
   * shape the runtime's format adapter expects (`{ id, parent_id, format,
   * content }`).
   */
  async listThreadMessages(
    conversationId: string,
  ): Promise<Array<{ id: string; parent_id: string | null; format: string; content: unknown }>> {
    const rows = db
      .query<MessageRow, SQLQueryBindings[]>(
        "SELECT id, parent_id, format, content FROM messages WHERE conversation_id = ? ORDER BY order_seq ASC, created_at ASC",
      )
      .all(conversationId);
    return rows
      .map((row) => {
        let content: unknown = null;
        try {
          content = JSON.parse(row.content);
        } catch {
          content = null;
        }
        return {
          id: row.id,
          parent_id: row.parent_id,
          format: row.format,
          content,
        };
      })
      .filter((r) => r.content !== null);
  },

  async deleteThreadMessage(conversationId: string, messageId: string): Promise<void> {
    db.run("DELETE FROM messages WHERE conversation_id = ? AND id = ?", [conversationId, messageId]);
  },

  async deleteByConversation(conversationId: string): Promise<void> {
    db.run("DELETE FROM messages WHERE conversation_id = ?", [conversationId]);
  },
};

export const memoryService = {
  async list(): Promise<Memory[]> {
    const rows = db.query<MemoryRow, SQLQueryBindings[]>("SELECT * FROM memories ORDER BY updated_at DESC").all();
    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));
  },

  async add(content: string): Promise<Memory> {
    const now = Date.now();
    const id = generateId();
    db.run("INSERT INTO memories (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)", [
      id,
      content,
      now,
      now,
    ]);
    return { id, content, createdAt: new Date(now), updatedAt: new Date(now) };
  },

  async delete(id: string): Promise<void> {
    db.run("DELETE FROM memories WHERE id = ?", [id]);
  },
};
