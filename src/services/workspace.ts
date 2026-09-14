import fs from "fs";
import path from "path";
import { generateId } from "../lib/utils";
import { db } from "../db";
import { conversationService } from "../services/storage";
import { folderService, addChatFolder } from "../services/folders";
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
  | "invalid_mode";

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

/** How long a scratch dir must sit untouched before the GC may reclaim it. */
const CHAT_SCRATCH_STALE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Create a hidden chat folder + scratch directory for a simple-chat conversation.
 * Returns the folder detail so the caller can bind the conversation to it.
 */
export async function createChatWorkspace(): Promise<{
  folderId: string;
  dir: string;
}> {
  const uuid = generateId();
  const dir = path.join(CHAT_DIR, uuid);
  fs.mkdirSync(dir, { recursive: true });
  const folder = await addChatFolder(dir);
  return { folderId: folder.id, dir };
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
 * Reclaim orphaned chat scratch directories under `data/chat/<uuid>/`.
 *
 * A chat draft eagerly mints a scratch dir before any DB row exists; quitting
 * before the first send — or deleting a chat conversation, which intentionally
 * leaves the dir on disk — orphans it forever. This startup sweep removes the
 * leak.
 *
 * A `<uuid>` dir is reclaimed iff it is NOT bound to a live chat folder AND it
 * is older than `CHAT_SCRATCH_STALE_MS`. Matching codeg's
 * `gc_orphan_chat_dirs_core` logic. Returns the number of dirs removed. Never
 * fatal: every filesystem error is logged and skipped.
 */
export function gcOrphanChatDirs(): number {
  if (!fs.existsSync(CHAT_DIR)) return 0;

  const live = listLiveChatFolderPaths();
  const now = Date.now();
  let removed = 0;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(CHAT_DIR, { withFileTypes: true });
  } catch (err) {
    logger.error("workspace", "gc_read_failed", {
      path: CHAT_DIR,
      error: String(err),
    });
    return 0;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(CHAT_DIR, entry.name);

    // Skip if bound to a live chat folder.
    if (live.has(dirPath)) continue;

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
    logger.info("workspace", "gc_completed", { removed });
  }
  return removed;
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
      dir: getWorkspaceDir(),
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
    const { folderId, dir } = await createChatWorkspace();
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
  return {
    mode,
    dir: row.path,
    folderId: row.id,
    folderName: row.alias || row.name,
  };
}
