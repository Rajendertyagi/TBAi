import fs from "fs";
import { db } from "../db";
import { generateId } from "../lib/utils";
import { canonicalizeRoot } from "../services/tools";
import type { SQLQueryBindings } from "bun:sqlite";
import type { Folder, FolderLink, FolderGroup } from "../types";

/**
 * Registration-time path failure. The route maps these to structured
 * 404/400 responses (never a 500): a missing directory is a client error,
 * not a server fault.
 */
export type FolderRegistrationErrorCode = "path_missing" | "path_not_directory";

export class FolderRegistrationError extends Error {
  code: FolderRegistrationErrorCode;
  constructor(code: FolderRegistrationErrorCode, message: string) {
    super(message);
    this.name = "FolderRegistrationError";
    this.code = code;
  }
}

/**
 * Folder / workspace registry services (codeg-aligned two-mode model).
 *
 * Registered project folders the user can attach a Project Chat to, their
 * linked/allowed paths (authorization records — no real symlinks in phase 1),
 * and folder groups. The folder ID is the canonical identity; paths are
 * resolved server-side by `resolveConversationWorkspace`.
 */

interface FolderRow {
  id: string;
  name: string;
  path: string;
  alias: string | null;
  color: string;
  group_id: string | null;
  is_open: number;
  sort_order: number;
  kind: string;
  last_opened_at: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  conversation_count: number;
}

interface FolderLinkRow {
  id: string;
  folder_id: string;
  name: string;
  target_path: string;
  created_at: number;
  updated_at: number;
}

interface FolderGroupRow {
  id: string;
  name: string;
  color: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

function mapFolder(row: FolderRow): Folder {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    alias: row.alias,
    color: row.color,
    groupId: row.group_id,
    isOpen: row.is_open === 1,
    sortOrder: row.sort_order,
    kind: (row.kind as "regular" | "chat") ?? "regular",
    lastOpenedAt: row.last_opened_at,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    conversationCount: row.conversation_count,
  };
}

function mapLink(row: FolderLinkRow): FolderLink {
  return {
    id: row.id,
    folderId: row.folder_id,
    name: row.name,
    targetPath: row.target_path,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function mapGroup(row: FolderGroupRow): FolderGroup {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    sortOrder: row.sort_order,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function nextSortOrder(): number {
  const row = db
    .query<{ max: number | null }, SQLQueryBindings[]>("SELECT MAX(sort_order) AS max FROM folders WHERE deleted_at IS NULL")
    .get() as { max: number | null } | undefined;
  return (row?.max ?? -1) + 1;
}

function nextGroupSortOrder(): number {
  const row = db
    .query<{ max: number | null }, SQLQueryBindings[]>("SELECT MAX(sort_order) AS max FROM folder_groups")
    .get() as { max: number | null } | undefined;
  return (row?.max ?? -1) + 1;
}

/**
 * Create a dedicated hidden folder backing a single chat-mode conversation.
 *
 * Unlike [`openFolder`], the display name is a fixed sentinel ("Chat") rather
 * than derived from the path, and `kind = 'chat'` is set so the frontend routes
 * this folder's conversations to the sidebar "Chat" section and hides
 * folder-bound chrome. `path` is a freshly generated per-conversation scratch
 * dir, so it never collides on the `UNIQUE(path)` constraint.
 */
async function addChatFolder(scratchPath: string): Promise<Folder> {
  const now = Date.now();
  const id = generateId();
  const order = nextSortOrder();
  db.run(
    "INSERT INTO folders (id, name, path, alias, color, group_id, is_open, sort_order, kind, last_opened_at, created_at, updated_at, deleted_at) VALUES (?, ?, ?, NULL, '#6b7280', NULL, 1, ?, 'chat', ?, ?, ?, NULL)",
    [id, "Chat", scratchPath, order, now, now, now],
  );
  return (await folderService.get(id))!;
}

export const folderService = {
  /**
   * Register or re-open a folder by its absolute path (upsert).
   *
   * Identity is canonical, never the raw string: the input is trimmed and
   * resolved through `canonicalizeRoot` (absolute, normalized, symlinks
   * resolved) before lookup AND storage, so `D:\PM\x`, `D:\PM\x\` and
   * `D:\PM\x\.` all resolve to the same persisted row. A brand-new
   * registration must point at an existing directory (typed
   * `FolderRegistrationError`, mapped to 404/400 by the route); re-opening
   * an already-registered row never re-checks the disk, so a temporarily
   * unmounted project can still be re-opened by identity.
   */
  async openFolder(input: {
    path: string;
    name?: string;
    alias?: string | null;
    color?: string;
    groupId?: string | null;
  }): Promise<Folder> {
    const now = Date.now();
    const trimmed = input.path.trim();
    if (!trimmed) {
      // Never let a blank path resolve to process.cwd() (path.resolve("")
      // yields the server's own working directory — registering that as a
      // project folder would be a path-safety failure).
      throw new FolderRegistrationError("path_missing", "Path is required");
    }
    const canonical = canonicalizeRoot(trimmed);
    const existing = db
      .query<FolderRow & { conversation_count: number }, SQLQueryBindings[]>(
        "SELECT *, (SELECT COUNT(*) FROM conversations c WHERE c.workspace_folder_id = folders.id AND c.workspace_mode = 'project') AS conversation_count FROM folders WHERE path = ?",
      )
      .get(canonical);

    if (existing) {
      const name = input.name ?? existing.name;
      db.run(
        "UPDATE folders SET name = ?, alias = ?, color = ?, group_id = ?, is_open = 1, deleted_at = NULL, last_opened_at = ?, updated_at = ? WHERE id = ?",
        [
          name,
          input.alias !== undefined ? input.alias : existing.alias,
          input.color ?? existing.color,
          input.groupId !== undefined ? input.groupId : existing.group_id,
          now,
          now,
          existing.id,
        ],
      );
      return (await this.get(existing.id))!;
    }

    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(canonical);
    } catch {
      stat = null;
    }
    if (!stat) {
      throw new FolderRegistrationError(
        "path_missing",
        `Directory not found: ${canonical}`,
      );
    }
    if (!stat.isDirectory()) {
      throw new FolderRegistrationError(
        "path_not_directory",
        `Not a directory: ${canonical}`,
      );
    }

    const id = generateId();
    const name = input.name ?? canonical.split(/[\\/]/).filter(Boolean).pop() ?? canonical;
    db.run(
      "INSERT INTO folders (id, name, path, alias, color, group_id, is_open, sort_order, kind, last_opened_at, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'regular', ?, ?, ?, NULL)",
      [
        id,
        name,
        canonical,
        input.alias ?? null,
        input.color ?? "#6b7280",
        input.groupId ?? null,
        nextSortOrder(),
        now,
        now,
        now,
      ],
    );
    return (await this.get(id))!;
  },

  async listAll(): Promise<Folder[]> {
    const rows = db
      .query<FolderRow & { conversation_count: number }, SQLQueryBindings[]>(
        `SELECT f.*, (SELECT COUNT(*) FROM conversations c WHERE c.workspace_folder_id = f.id AND c.workspace_mode = 'project') AS conversation_count
         FROM folders f WHERE f.deleted_at IS NULL ORDER BY f.sort_order ASC, f.created_at ASC`,
      )
      .all() as (FolderRow & { conversation_count: number })[];
    return rows.map(mapFolder);
  },

  /** User-facing list: excludes hidden chat folders. Used by sidebar + settings. */
  async listOpen(): Promise<Folder[]> {
    const rows = db
      .query<FolderRow & { conversation_count: number }, SQLQueryBindings[]>(
        `SELECT f.*, (SELECT COUNT(*) FROM conversations c WHERE c.workspace_folder_id = f.id AND c.workspace_mode = 'project') AS conversation_count
         FROM folders f WHERE f.deleted_at IS NULL AND f.kind != 'chat' AND f.is_open = 1 ORDER BY f.sort_order ASC, f.created_at ASC`,
      )
      .all() as (FolderRow & { conversation_count: number })[];
    return rows.map(mapFolder);
  },

  async get(id: string): Promise<Folder | null> {
    const row = db
      .query<FolderRow & { conversation_count: number }, SQLQueryBindings[]>(
        `SELECT f.*, (SELECT COUNT(*) FROM conversations c WHERE c.workspace_folder_id = f.id AND c.workspace_mode = 'project') AS conversation_count
         FROM folders f WHERE f.id = ? AND f.deleted_at IS NULL`,
      )
      .get(id) as (FolderRow & { conversation_count: number }) | undefined;
    return row ? mapFolder(row) : null;
  },

  async update(
    id: string,
    data: {
      name?: string;
      alias?: string | null;
      color?: string;
      groupId?: string | null;
      sortOrder?: number;
      isOpen?: boolean;
    },
  ): Promise<Folder | null> {
    const updates: string[] = [];
    const values: SQLQueryBindings[] = [];
    if (data.name !== undefined) {
      updates.push("name = ?");
      values.push(data.name);
    }
    if (data.alias !== undefined) {
      updates.push("alias = ?");
      values.push(data.alias);
    }
    if (data.color !== undefined) {
      updates.push("color = ?");
      values.push(data.color);
    }
    if (data.groupId !== undefined) {
      updates.push("group_id = ?");
      values.push(data.groupId);
    }
    if (data.sortOrder !== undefined) {
      updates.push("sort_order = ?");
      values.push(data.sortOrder);
    }
    if (data.isOpen !== undefined) {
      updates.push("is_open = ?");
      values.push(data.isOpen ? 1 : 0);
    }
    if (updates.length === 0) return this.get(id);
    updates.push("updated_at = ?");
    values.push(Date.now(), id);
    db.run(`UPDATE folders SET ${updates.join(", ")} WHERE id = ?`, values);
    return this.get(id);
  },

  async close(id: string): Promise<void> {
    db.run("UPDATE folders SET is_open = 0, updated_at = ? WHERE id = ?", [Date.now(), id]);
  },

  /** Re-open a closed folder (without touching deleted_at). */
  async open(id: string): Promise<void> {
    db.run("UPDATE folders SET is_open = 1, last_opened_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [Date.now(), Date.now(), id]);
  },

  /** Soft-delete: keeps the row so conversations referencing it fail with a
   *  controlled `folder_missing` error rather than silently switching. */
  async remove(id: string): Promise<void> {
    db.run("UPDATE folders SET deleted_at = ?, is_open = 0, updated_at = ? WHERE id = ?", [
      Date.now(),
      Date.now(),
      id,
    ]);
  },

  /**
   * Cleanup a hidden chat folder after its backing conversation is deleted.
   * Soft-deletes the folder if no other live conversations reference it.
   * Idempotent: a folder already soft-deleted or already cleaned up is a no-op.
   * Returns true if the folder was cleaned up (or was already gone).
   */
  async cleanupChatFolder(folderId: string): Promise<boolean> {
    const row = db
      .query<{ id: string; kind: string; deleted_at: number | null }, SQLQueryBindings[]>(
        "SELECT id, kind, deleted_at FROM folders WHERE id = ?",
      )
      .get(folderId) as { id: string; kind: string; deleted_at: number | null } | undefined;
    if (!row || row.deleted_at != null) return true;
    if (row.kind !== "chat") return false;
    const countRow = db
      .query<{ c: number }, SQLQueryBindings[]>(
        "SELECT COUNT(*) AS c FROM conversations WHERE workspace_folder_id = ?",
      )
      .get(folderId) as { c: number } | undefined;
    if ((countRow?.c ?? 0) > 0) return false;
    db.run("UPDATE folders SET deleted_at = ?, is_open = 0, updated_at = ? WHERE id = ?", [
      Date.now(),
      Date.now(),
      folderId,
    ]);
    return true;
  },
};

/** Create a dedicated hidden chat folder for a simple-chat conversation. */
export { addChatFolder };

export const folderLinkService = {
  async listByFolder(folderId: string): Promise<FolderLink[]> {
    const rows = db
      .query<FolderLinkRow, SQLQueryBindings[]>(
        "SELECT * FROM folder_links WHERE folder_id = ? ORDER BY id ASC",
      )
      .all(folderId) as FolderLinkRow[];
    return rows.map(mapLink);
  },

  async insert(folderId: string, name: string, targetPath: string): Promise<FolderLink> {
    const now = Date.now();
    const id = generateId();
    db.run(
      "INSERT INTO folder_links (id, folder_id, name, target_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, folderId, name, targetPath, now, now],
    );
    const row = db
      .query<FolderLinkRow, SQLQueryBindings[]>("SELECT * FROM folder_links WHERE id = ?")
      .get(id) as FolderLinkRow;
    return mapLink(row);
  },

  async rename(linkId: string, newName: string): Promise<FolderLink | null> {
    db.run("UPDATE folder_links SET name = ?, updated_at = ? WHERE id = ?", [
      newName,
      Date.now(),
      linkId,
    ]);
    const row = db
      .query<FolderLinkRow, SQLQueryBindings[]>("SELECT * FROM folder_links WHERE id = ?")
      .get(linkId) as FolderLinkRow | undefined;
    return row ? mapLink(row) : null;
  },

  async delete(linkId: string): Promise<void> {
    db.run("DELETE FROM folder_links WHERE id = ?", [linkId]);
  },

  /**
   * Dry-run plan for creating links (authorization records). Validates each
   * candidate name and flags collisions / invalid names. No filesystem symlink
   * is created in phase 1 — the record is the authorization.
   */
  async preview(
    folderId: string,
    targets: { name: string; targetPath: string }[],
  ): Promise<Array<{ name: string; targetPath: string; status: "ok" | "skipped"; reason?: string }>> {
    const existing = await this.listByFolder(folderId);
    const taken = new Set(existing.map((l) => l.name));
    const seen = new Set<string>();
    return targets.map((t) => {
      const clean = t.name.trim();
      if (!clean || /[\\/]/.test(clean)) {
        return { ...t, status: "skipped" as const, reason: "invalid name" };
      }
      if (taken.has(clean) || seen.has(clean)) {
        return { ...t, status: "skipped" as const, reason: "name already used" };
      }
      seen.add(clean);
      return { ...t, status: "ok" as const };
    });
  },
};

export const folderGroupService = {
  async list(): Promise<FolderGroup[]> {
    const rows = db
      .query<FolderGroupRow, SQLQueryBindings[]>("SELECT * FROM folder_groups ORDER BY sort_order ASC")
      .all() as FolderGroupRow[];
    return rows.map(mapGroup);
  },

  async create(input: { name: string; color?: string }): Promise<FolderGroup> {
    const now = Date.now();
    const id = generateId();
    db.run(
      "INSERT INTO folder_groups (id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, input.name, input.color ?? "inherit", nextGroupSortOrder(), now, now],
    );
    const row = db
      .query<FolderGroupRow, SQLQueryBindings[]>("SELECT * FROM folder_groups WHERE id = ?")
      .get(id) as FolderGroupRow;
    return mapGroup(row);
  },

  async update(
    id: string,
    data: { name?: string; color?: string; sortOrder?: number },
  ): Promise<FolderGroup | null> {
    const updates: string[] = [];
    const values: SQLQueryBindings[] = [];
    if (data.name !== undefined) {
      updates.push("name = ?");
      values.push(data.name);
    }
    if (data.color !== undefined) {
      updates.push("color = ?");
      values.push(data.color);
    }
    if (data.sortOrder !== undefined) {
      updates.push("sort_order = ?");
      values.push(data.sortOrder);
    }
    if (updates.length === 0) return this.list().then((g) => g.find((x) => x.id === id) ?? null);
    updates.push("updated_at = ?");
    values.push(Date.now(), id);
    db.run(`UPDATE folder_groups SET ${updates.join(", ")} WHERE id = ?`, values);
    const row = db
      .query<FolderGroupRow, SQLQueryBindings[]>("SELECT * FROM folder_groups WHERE id = ?")
      .get(id) as FolderGroupRow | undefined;
    return row ? mapGroup(row) : null;
  },

  /** Hard-delete a group; its members fall back to the top level. */
  async delete(id: string): Promise<void> {
    db.run("UPDATE folders SET group_id = NULL WHERE group_id = ?", [id]);
    db.run("DELETE FROM folder_groups WHERE id = ?", [id]);
  },

  /** Move a folder into (or out of) a group. */
  async setFolderGroup(folderId: string, groupId: string | null): Promise<void> {
    db.run("UPDATE folders SET group_id = ?, updated_at = ? WHERE id = ?", [
      groupId,
      Date.now(),
      folderId,
    ]);
  },
};
