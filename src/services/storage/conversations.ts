/**
 * Conversation persistence: the `conversations` table, its workspace, and its
 * per-conversation model/thinking defaults.
 *
 * ## Why this was split out of `storage/index.ts`
 *
 * The three aggregates that shared that module - conversations, messages and
 * memories - never referenced each other. Each used only its own row mapper and
 * the shared `db` handle, so "three services in one 1,069-line file" was a
 * packaging decision, not a coupling one. Splitting them lets each be read,
 * changed, and tested on its own; the barrel `index.ts` re-exports all three so
 * every existing `@/services/storage` import keeps resolving unchanged.
 *
 * ## What is deliberately NOT here
 *
 * Message rows and message ordering live in `messages.ts`. Memories live in
 * `memories.ts`. None of the three may call another - the storage layer stays a
 * leaf below the services that orchestrate it.
 */

import { db } from "../../db";
import { generateId } from "../../lib/utils";
import type { SQLQueryBindings } from "bun:sqlite";
import type { Conversation, ConversationStatus, WorkspaceMode } from "../../types";
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

export interface ConversationListOptions {
  status?: ConversationStatus;
  search?: string;
  limit?: number;
  offset?: number;
  /** Newest-first key. Defaults to `updated` (last activity). */
  order?: "updated" | "created";
  /**
   * Sidebar scope. `simple` = non-folder chats; `project` = folder-bound chats.
   * Omit for no scope clause (every conversation).
   *
   * This is the discriminator, NOT `workspace_folder_id IS NULL`: every
   * conversation carries a folder id because simple chats are bound to an
   * auto-created hidden `kind='chat'` folder (see `create`).
   */
  workspaceMode?: "simple" | "project";
  /**
   * Restrict to one folder's project chats. Implies `workspace_mode = 'project'`
   * so a hidden chat folder id can never match. Combine with `workspaceMode` only
   * as `"project"`; the route's Zod schema rejects the contradictory pairing.
   */
  folderId?: string;
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
  async findByClientRequestId(clientRequestId: string): Promise<Conversation | null> {
    const row = db
      .query<ConversationRow, SQLQueryBindings[]>(
        "SELECT * FROM conversations WHERE client_request_id = ?",
      )
      .get(clientRequestId);
    return row ? mapConversation(row) : null;
  },

  /**
   * Look up the conversation that owns an OpenCode session.
   *
   * This is the **missing link** in the workspace-authorization chain
   * `OpenCode session id → conversation → folder → absolute directory`. The
   * proxy needs it to resolve the session a browser request names into the
   * one directory the request is allowed to address; without it the proxy
   * would have to trust the caller's directory, which is exactly the
   * disclosure the chain exists to prevent.
   *
   * The session id is a **selector**, not an authority: the directory that
   * comes back is always resolved from the `folders` table through
   * `resolveConversationWorkspace`, never from the session id itself.
   *
   * @param sessionId - The managed OpenCode session id.
   * @returns The owning conversation, or `null` when no row carries the id.
   */
  async findByOpenCodeSessionId(sessionId: string): Promise<Conversation | null> {
    if (!sessionId) return null;
    const row = db
      .query<ConversationRow, SQLQueryBindings[]>(
        "SELECT * FROM conversations WHERE opencode_session_id = ? LIMIT 1",
      )
      .get(sessionId);
    return row ? mapConversation(row) : null;
  },

  async list(options: ConversationListOptions = {}): Promise<ConversationListResult> {
    const {
      status,
      search,
      limit = 50,
      offset = 0,
      order = "updated",
      workspaceMode,
      folderId,
    } = options;
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (status) {
      clauses.push("c.status = ?");
      params.push(status);
    }
    // Scope clauses are AND-ed with status/search below, so the sidebar's
    // section filter, the archived toggle, and the search term all narrow the
    // same query and paging (total/nextCursor) stays honest.
    if (workspaceMode) {
      clauses.push("c.workspace_mode = ?");
      params.push(workspaceMode);
    }
    if (folderId) {
      // `workspace_mode = 'project'` mirrors the folder-membership subquery in
      // folders.ts: a conversation only counts as "in" a visible folder when it
      // is project-scoped, so a hidden `kind='chat'` folder id never matches.
      clauses.push("(c.workspace_folder_id = ? AND c.workspace_mode = 'project')");
      params.push(folderId);
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
    const orderBy = order === "created" ? "c.created_at DESC" : "c.updated_at DESC";
    const rows = db
      .query<ConversationRow, SQLQueryBindings[]>(
        `SELECT c.* FROM conversations c ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    const totalRow = db
      .query<{ c: number }, SQLQueryBindings[]>(
        `SELECT COUNT(*) as c FROM conversations c ${where}`,
      )
      .get(...params);
    const total = totalRow?.c ?? 0;
    const threads = rows.map(mapConversation);
    const nextCursor = offset + limit < total ? String(offset + limit) : undefined;
    return { threads, nextCursor };
  },

  async get(id: string): Promise<Conversation | null> {
    const row = db
      .query<ConversationRow, SQLQueryBindings[]>("SELECT * FROM conversations WHERE id = ?")
      .get(id);
    return row ? mapConversation(row) : null;
  },

  /**
   * Which of `ids` currently exist as conversation rows.
   *
   * The authoritative answer set for tab reconciliation. Only the id column is
   * selected: reconciliation proves existence and nothing more, so no title,
   * config, or message content leaves SQLite for this path.
   *
   * Absence from the returned set is meaningful ONLY because the caller supplied
   * the complete id set (the request drives the answer). Deriving absence from
   * `list()` would be unsound — that query is scoped and capped, so a missing id
   * could be archived, folder-scoped, or past the limit rather than deleted.
   *
   * @param ids - Candidate conversation ids. Duplicates are harmless.
   * @returns The subset of `ids` that exists (never includes anything else).
   */
  async existsMany(ids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (ids.length === 0) return found;
    // Chunked to stay well inside SQLite's bound-parameter ceiling regardless
    // of what the route's request cap allows.
    const CHUNK_SIZE = 500;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = db
        .query<{ id: string }, SQLQueryBindings[]>(
          `SELECT id FROM conversations WHERE id IN (${placeholders})`,
        )
        .all(...chunk);
      for (const row of rows) found.add(row.id);
    }
    return found;
  },

  async update(
    id: string,
    data: Partial<
      Pick<
        Conversation,
        | "title"
        | "providerId"
        | "modelId"
        | "reasoningLevel"
        | "systemPrompt"
        | "status"
        | "titleSource"
        | "workspaceMode"
        | "workspaceFolderId"
        | "opencodeSessionId"
        | "engine"
        | "opencodeAgent"
        | "opencodeModel"
        | "opencodeVariant"
        | "opencodeAutoApprove"
      >
    >,
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
      const folderId = data.workspaceMode === "simple" ? null : (data.workspaceFolderId ?? null);
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
