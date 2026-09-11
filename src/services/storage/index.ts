import { db } from "../../db";
import { generateId } from "../../lib/utils";
import type { SQLQueryBindings } from "bun:sqlite";
import type { Conversation, Message, Memory } from "../../types";

interface ConversationRow {
  id: string;
  title: string;
  provider_id: string | null;
  system_prompt: string | null;
  status: string;
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
  status?: "regular" | "archived";
  search?: string;
  limit?: number;
  offset?: number;
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
    systemPrompt: row.system_prompt,
    status: row.status as "regular" | "archived",
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export const conversationService = {
  async create(
    data: Pick<Conversation, "title" | "providerId" | "systemPrompt">,
  ): Promise<Conversation> {
    const now = Date.now();
    const id = generateId();
    db.run(
      "INSERT INTO conversations (id, title, provider_id, system_prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'regular', ?, ?)",
      [id, data.title, data.providerId || null, data.systemPrompt || null, now, now],
    );
    const created = await this.get(id);
    if (!created) throw new Error("Failed to create conversation");
    return created;
  },

  async list(options: ConversationListOptions = {}): Promise<ConversationListResult> {
    const { status, search, limit = 50, offset = 0 } = options;
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
    const rows = db
      .query<ConversationRow, SQLQueryBindings[]>(
        `SELECT c.* FROM conversations c ${where} ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`,
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
    data: Partial<Pick<Conversation, "title" | "systemPrompt" | "status">>,
  ): Promise<Conversation> {
    const updates: string[] = [];
    const values: SQLQueryBindings[] = [];

    if (data.title !== undefined) {
      updates.push("title = ?");
      values.push(data.title);
    }
    if (data.systemPrompt !== undefined) {
      updates.push("system_prompt = ?");
      values.push(data.systemPrompt);
    }
    if (data.status !== undefined) {
      updates.push("status = ?");
      values.push(data.status);
    }

    updates.push("updated_at = ?");
    values.push(Date.now(), id);

    db.run(`UPDATE conversations SET ${updates.join(", ")} WHERE id = ?`, values);
    const updated = await this.get(id);
    if (!updated) throw new Error("Failed to update conversation");
    return updated;
  },

  async delete(id: string): Promise<void> {
    db.run("DELETE FROM messages WHERE conversation_id = ?", [id]);
    db.run("DELETE FROM conversations WHERE id = ?", [id]);
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
    const userText = threadMessageText(entry.content);
    if (userText) {
      const conv = db
        .query<{ title: string }, SQLQueryBindings[]>("SELECT title FROM conversations WHERE id = ?")
        .get(conversationId);
      if (conv && conv.title === "New Conversation") {
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
