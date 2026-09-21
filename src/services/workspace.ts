import fs from "fs";
import path from "path";
import { generateId } from "../lib/utils";
import { db } from "../db";
import { conversationService } from "../services/storage";
import { folderService, addChatFolder } from "../services/folders";
import { canonicalizeRoot, WORKSPACE_DIR } from "../services/tools";
import { logger } from "../lib/logger";

/**
 * Canonical workspace resolution (codeg-aligned two-mode model).
 *
 * Every filesystem / terminal / coding operation for a conversation must resolve
 * its working directory through `resolveConversationWorkspace` — no service
 * invents its own folder logic. The model can never freely choose a filesystem
 * root: the directory is derived from the conversation's persisted
 * `workspace_mode` + `workspace_folder_id`, not from any request-supplied path.
 *
 *   simple  → a hidden `kind='chat'` folder with a per-conversation scratch dir
 *   project → the registered folder's path (resolved server-side by folder id)
 *
 * Every conversation has a `workspace_folder_id` — simple chats get a hidden
 * folder auto-created at conversation creation time. Invalid / deleted project
 * folders surface a structured `WorkspaceError` rather than silently falling
 * back to another directory.
 */

export type WorkspaceErrorCode =
  | "conversation_missing"
  | "folder_missing"
  | "folder_unavailable"
  | "invalid_mode"
  | "migration_verify_failed";

export class WorkspaceError extends Error {
  code: WorkspaceErrorCode;
  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

export interface ResolvedWorkspace {
  mode: "simple" | "project";
  /** Absolute working directory for filesystem / terminal operations. */
  dir: string;
  /** Registered folder id. */
  folderId: string;
  /** Display name for the UI (project folder name/alias, or "Chat" for simple). */
  folderName: string;
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const CHAT_DIR = path.join(DATA_DIR, "chat");

/** New-layout root: conversation-owned workspaces live here. */
const CHATS_DIR = path.join(WORKSPACE_DIR, "chats");

/** Canonical path for a simple-chat conversation workspace. Stable per id. */
export function chatWorkspaceDir(conversationId: string): string {
  return canonicalizeRoot(path.join(CHATS_DIR, conversationId));
}

/** Canonical-path equality (case-insensitive on Windows). */
function samePath(a: string, b: string): boolean {
  return process.platform === "win32"
    ? canonicalizeRoot(a).toLowerCase() === canonicalizeRoot(b).toLowerCase()
    : canonicalizeRoot(a) === canonicalizeRoot(b);
}

/** How long a scratch dir must sit untouched before the GC may reclaim it. */
const CHAT_SCRATCH_STALE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Create a hidden chat folder + scratch directory for a simple-chat conversation.
 * New chats live at `workspace/chats/<conversationId>` (stable, canonical,
 * conversation-owned). Without an id (defensive only — all callers pass one)
 * falls back to the legacy `data/chat/<uuid>` scratch shape.
 * Returns the folder detail so the caller can bind the conversation to it.
 */
export async function createChatWorkspace(
  conversationId?: string,
): Promise<{
  folderId: string;
  dir: string;
}> {
  const dir = conversationId
    ? path.join(CHATS_DIR, conversationId)
    : path.join(CHAT_DIR, generateId());
  fs.mkdirSync(dir, { recursive: true });
  const folder = await addChatFolder(canonicalizeRoot(dir));
  return { folderId: folder.id, dir: canonicalizeRoot(dir) };
}

/**
 * List paths of all live (non-deleted) chat folders. Consumed by the scratch-dir
 * GC to determine which dirs are still bound to a conversation.
 */
function listLiveChatFolderPaths(): Set<string> {
  const rows = db
    .query<{ path: string }, []>(
      "SELECT path FROM folders WHERE kind = 'chat' AND deleted_at IS NULL",
    )
    .all();
  return new Set(rows.map((r) => r.path));
}

/**
 * Reclaim orphaned chat scratch directories.
 *
 * A chat draft eagerly mints a scratch dir before any DB row exists; quitting
 * before the first send — or deleting a chat conversation, which intentionally
 * leaves the dir on disk — orphans it forever. This startup sweep removes the
 * leak.
 *
 * Two layouts are understood during migration: legacy `data/chat/<uuid>/` and
 * canonical `workspace/chats/<conversationId>/`. A dir is reclaimed iff it is
 * NOT bound to a live chat folder AND it is older than `CHAT_SCRATCH_STALE_MS`.
 * Matching codeg's `gc_orphan_chat_dirs_core` logic. Returns the number of
 * dirs removed. Never fatal: every filesystem error is logged and skipped.
 */
export function gcOrphanChatDirs(): number {
  const live = listLiveChatFolderPaths();
  // Canonical form of every bound path, computed once: bound paths are stored
  // canonical, but a symlinked root or case drift must never make a live dir
  // look orphaned.
  const liveCanon = new Set<string>();
  for (const p of live) {
    liveCanon.add(p);
    try {
      liveCanon.add(fs.realpathSync(p));
    } catch {
      /* bound dir missing on disk — raw form still protects the row */
    }
  }
  return sweepChatRoot(CHAT_DIR, liveCanon) + sweepChatRoot(CHATS_DIR, liveCanon);
}

function sweepChatRoot(rootDir: string, live: Set<string>): number {
  if (!fs.existsSync(rootDir)) return 0;

  const now = Date.now();
  let removed = 0;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    logger.error("workspace", "gc_read_failed", {
      path: rootDir,
      error: String(err),
    });
    return 0;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(rootDir, entry.name);

    // Skip if bound to a live chat folder (raw or canonical form).
    if (live.has(dirPath)) continue;
    try {
      if (live.has(fs.realpathSync(dirPath))) continue;
    } catch {
      continue;
    }

    // Check staleness via mtime.
    let mtime: number;
    try {
      const stat = fs.statSync(dirPath);
      mtime = stat.mtimeMs;
    } catch {
      // mtime unreadable → treat as fresh and spare (a GC should leak before
      // it deletes something possibly in use).
      continue;
    }

    if (now - mtime < CHAT_SCRATCH_STALE_MS) continue;

    // Old enough and not bound — reclaim.
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      removed++;
    } catch (err) {
      logger.error("workspace", "gc_remove_failed", {
        path: dirPath,
        error: String(err),
      });
    }
  }

  if (removed > 0) {
    logger.info("workspace", "gc_completed", { removed, root: rootDir });
  }
  return removed;
}

/**
 * Verify a migrated tree: every file/dir under `src` exists under `dst` with
 * equal byte size. Throws `WorkspaceError` on the first mismatch — the caller
 * must leave the legacy tree and the DB row untouched in that case. Exported
 * for unit tests (mismatch/missing cases without touching the database).
 */
export function verifyTreeCopy(src: string, dst: string): void {
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      out.push(full);
      if (e.isDirectory() && !e.isSymbolicLink()) out.push(...walk(full));
    }
    return out;
  };
  for (const full of walk(src)) {
    const rel = path.relative(src, full);
    const twin = path.join(dst, rel);
    let s: fs.Stats, t: fs.Stats;
    try {
      s = fs.statSync(full);
      t = fs.statSync(twin);
    } catch {
      throw new WorkspaceError(
        "migration_verify_failed",
        `Migrated copy is missing ${rel}`,
      );
    }
    if (s.isDirectory() !== t.isDirectory() || s.size !== t.size) {
      throw new WorkspaceError(
        "migration_verify_failed",
        `Migrated copy differs at ${rel}`,
      );
    }
  }
}

/**
 * Move a legacy simple-chat workspace (`data/chat/<uuid>`) to the canonical
 * `workspace/chats/<conversationId>` layout. Order is load-bearing:
 * copy → verify → switch the DB row → retain the legacy tree for GC.
 * A crash anywhere before the row switch retries cleanly (copy overwrites);
 * a crash after it needs no retry (row already canonical). Never deletes.
 */
async function migrateChatWorkspace(
  conversationId: string,
  folderId: string,
  legacyPath: string,
): Promise<void> {
  const next = chatWorkspaceDir(conversationId);
  fs.mkdirSync(next, { recursive: true });
  if (
    fs.existsSync(legacyPath) &&
    fs.statSync(legacyPath).isDirectory()
  ) {
    fs.cpSync(legacyPath, next, { recursive: true, force: true });
    verifyTreeCopy(legacyPath, next);
    // Grace retention: touch the legacy tree so GC spares it for at least one
    // more stale-window after a verified migration.
    try {
      fs.utimesSync(legacyPath, new Date(), new Date());
    } catch {
      /* retention hint only; the copy is already verified */
    }
  } else {
    logger.warn("workspace", "migration_missing_legacy", {
      conversationId,
      folderId,
      legacyPath,
    });
  }
  db.run("UPDATE folders SET path = ?, updated_at = ? WHERE id = ?", [
    next,
    Date.now(),
    folderId,
  ]);
  logger.info("workspace", "workspace_migrated", {
    conversationId,
    folderId,
    from: legacyPath,
    to: next,
  });
}

/**
 * Resolve the working directory for a conversation. Every conversation has a
 * `workspace_folder_id` — this function always resolves via the folder table.
 * Throws `WorkspaceError` when the folder is missing/deleted so the caller can
 * return a controlled failure instead of silently switching workspaces.
 *
 * Legacy conversations without a `workspace_folder_id` are handled by creating
 * a hidden chat folder on first access (migration path).
 */
export async function resolveConversationWorkspace(
  conversationId: string | undefined,
): Promise<ResolvedWorkspace> {
  // No thread context (should not happen in practice): fall back to the legacy
  // sandbox root rather than failing the whole request.
  if (!conversationId) {
    const { getWorkspaceDir } = await import("../services/tools");
    return {
      mode: "simple",
      dir: canonicalizeRoot(getWorkspaceDir()),
      folderId: "",
      folderName: "Chat",
    };
  }

  const conv = await conversationService.get(conversationId);
  if (!conv) {
    throw new WorkspaceError(
      "conversation_missing",
      `Conversation ${conversationId} not found`,
    );
  }

  // Legacy migration: conversation without a workspace_folder_id.
  // Create a hidden chat folder and bind it.
  if (!conv.workspaceFolderId) {
    const { folderId, dir } = await createChatWorkspace(conversationId);
    await conversationService.update(conversationId, {
      workspaceMode: "simple",
      workspaceFolderId: folderId,
    });
    return { mode: "simple", dir, folderId, folderName: "Chat" };
  }

  // Resolve via the folder table (both simple and project modes).
  const row = db
    .query<
      { id: string; name: string; alias: string | null; path: string; kind: string; deleted_at: number | null },
      [string]
    >("SELECT id, name, alias, path, kind, deleted_at FROM folders WHERE id = ?")
    .get(conv.workspaceFolderId);
  if (!row || row.deleted_at != null) {
    throw new WorkspaceError(
      "folder_missing",
      `Folder ${conv.workspaceFolderId} is missing or deleted`,
    );
  }

  const mode = row.kind === "chat" ? "simple" : "project";
  // Layout migration: simple-chat rows still pointing at the legacy
  // `data/chat/<uuid>` tree move to `workspace/chats/<conversationId>` on
  // first filesystem use (copy → verify → switch row → retain legacy for GC).
  // Project rows are never touched here.
  if (mode === "simple" && !samePath(row.path, chatWorkspaceDir(conversationId))) {
    await migrateChatWorkspace(conversationId, row.id, row.path);
  }
  if (mode === "project") {
    // A registered project whose directory vanished (moved/deleted/unmounted)
    // is an explicit unavailable state — never a silent switch to another
    // folder. The row is preserved (recovery = restore the directory or
    // re-point the folder), and every caller already maps WorkspaceError to
    // a controlled failure.
    let isDir = false;
    try {
      isDir = fs.statSync(canonicalizeRoot(row.path)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      logger.warn("workspace", "workspace.unavailable", {
        conversationId,
        folderId: row.id,
      });
      throw new WorkspaceError(
        "folder_unavailable",
        `Project folder is unavailable: ${row.alias || row.name}`,
      );
    }
    return {
      mode,
      dir: canonicalizeRoot(row.path),
      folderId: row.id,
      folderName: row.alias || row.name,
    };
  }
  return {
    mode,
    dir: chatWorkspaceDir(conversationId),
    folderId: row.id,
    folderName: row.alias || row.name,
  };
}
