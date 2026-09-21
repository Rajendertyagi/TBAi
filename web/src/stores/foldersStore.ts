import { create } from "zustand";
import { logger } from "../lib/logger";
import type { Folder, FolderGroup, FolderLink } from "../types";

/**
 * Registered folder / workspace registry store (codeg-aligned two-mode model).
 *
 * Holds ONLY: the registered folder list, folder groups, and UI navigation state
 * (the globally-selected folder for the Folders surface). Conversation workspace
 * mode/folder attachment lives on the conversation itself (persisted in SQLite
 * and surfaced via thread metadata) — never duplicated here.
 */
interface FoldersState {
  folders: Folder[];
  folderGroups: FolderGroup[];
  /** Globally-selected folder for navigation/UI (NOT the implicit chat workspace). */
  selectedFolderId: string | null;
  /** Per-folder expand/collapse state for the sidebar Folders section. */
  folderExpanded: Record<string, boolean>;
  loading: boolean;
  /**
   * True once the folder list has been fetched successfully at least once.
   * Guards pruning logic (e.g. draft scope validation): an empty list before
   * the first load means "unknown", never "no folders".
   */
  foldersLoaded: boolean;
  loadFolders: () => Promise<void>;
  loadGroups: () => Promise<void>;
  createFolder: (input: {
    path: string;
    name?: string;
    alias?: string | null;
    color?: string;
    groupId?: string | null;
  }) => Promise<Folder | null>;
  updateFolder: (
    id: string,
    data: {
      name?: string;
      alias?: string | null;
      color?: string;
      groupId?: string | null;
      isOpen?: boolean;
    },
  ) => Promise<void>;
  removeFolder: (id: string) => Promise<void>;
  closeFolder: (id: string) => Promise<void>;
  createGroup: (name: string, color?: string) => Promise<void>;
  updateGroup: (
    id: string,
    data: { name?: string; color?: string },
  ) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  setFolderGroup: (folderId: string, groupId: string | null) => Promise<void>;
  listLinks: (folderId: string) => Promise<FolderLink[]>;
  registerLink: (
    folderId: string,
    name: string,
    targetPath: string,
  ) => Promise<void>;
  renameLink: (folderId: string, linkId: string, name: string) => Promise<void>;
  deleteLink: (folderId: string, linkId: string) => Promise<void>;
  setSelectedFolder: (id: string | null) => void;
  setFolderExpanded: (id: string, expanded: boolean) => void;
  setAllFoldersExpanded: (expanded: boolean) => void;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as T & {
    error?: string;
    requestId?: string;
  };
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    (err as Error & { requestId?: string }).requestId = data.requestId;
    logger.warn("folders.ui", "api_failed", {
      message: `${init?.method ?? "GET"} ${path} → ${res.status}`,
      requestId: data.requestId,
    });
    throw err;
  }
  return data as T;
}

const SELECTED_KEY = "tbai:selectedFolder";
const EXPANDED_KEY = "tbai:folderExpanded";

function loadFolderExpanded(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(EXPANDED_KEY);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    /* ignore */
  }
  return {};
}

function saveFolderExpanded(state: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

/**
 * Drop a persisted navigation selection that no longer names a registered
 * folder (removed/never-existed after reload). Pure so the rule is
 * unit-testable; the store applies it to every loaded list.
 */
export function pruneSelectedFolderId(
  folders: Folder[],
  selectedId: string | null,
): string | null {
  if (!selectedId) return null;
  return folders.some((f) => f.id === selectedId) ? selectedId : null;
}

// Monotonic load epoch: overlapping loadFolders() calls converge on the
// NEWEST response. A stale (slower, earlier-issued) list must never overwrite
// newer registry state — the same stale-completion rule as navigation.
let foldersLoadEpoch = 0;

export const useFoldersStore = create<FoldersState>((set, get) => ({
  folders: [],
  folderGroups: [],
  selectedFolderId:
    (() => {
      try {
        return window.localStorage.getItem(SELECTED_KEY) || null;
      } catch {
        return null;
      }
    })(),
  folderExpanded: loadFolderExpanded(),
  loading: false,
  foldersLoaded: false,

  loadFolders: async () => {
    const epoch = ++foldersLoadEpoch;
    set({ loading: true });
    try {
      const folders = await api<Folder[]>("/api/folders");
      // A newer load issued while this one was in flight owns the state;
      // this response is stale and must not overwrite it.
      if (epoch !== foldersLoadEpoch) return;
      const selectedFolderId = pruneSelectedFolderId(
        folders,
        get().selectedFolderId,
      );
      if (selectedFolderId !== get().selectedFolderId) {
        try {
          if (selectedFolderId) window.localStorage.setItem(SELECTED_KEY, selectedFolderId);
          else window.localStorage.removeItem(SELECTED_KEY);
        } catch {
          /* ignore */
        }
      }
      set({ folders, foldersLoaded: true, selectedFolderId });
    } finally {
      if (epoch === foldersLoadEpoch) set({ loading: false });
    }
  },

  loadGroups: async () => {
    const folderGroups = await api<FolderGroup[]>("/api/folders/groups");
    set({ folderGroups });
  },

  createFolder: async (input) => {
    const folder = await api<Folder>("/api/folders", {
      method: "POST",
      body: JSON.stringify(input),
    });
    await get().loadFolders();
    return folder;
  },

  updateFolder: async (id, data) => {
    await api(`/api/folders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    await get().loadFolders();
  },

  removeFolder: async (id) => {
    await api(`/api/folders/${id}`, { method: "DELETE" });
    if (get().selectedFolderId === id) get().setSelectedFolder(null);
    await get().loadFolders();
  },

  closeFolder: async (id) => {
    await api(`/api/folders/${id}/close`, { method: "POST" });
    await get().loadFolders();
  },

  createGroup: async (name, color) => {
    await api("/api/folders/groups", {
      method: "POST",
      body: JSON.stringify({ name, color }),
    });
    await get().loadGroups();
  },

  updateGroup: async (id, data) => {
    await api(`/api/folders/groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    await get().loadGroups();
  },

  deleteGroup: async (id) => {
    await api(`/api/folders/groups/${id}`, { method: "DELETE" });
    await get().loadGroups();
    await get().loadFolders();
  },

  setFolderGroup: async (folderId, groupId) => {
    await api(`/api/folders/groups/${groupId ?? "_none"}/set`, {
      method: "POST",
      body: JSON.stringify({ folderId }),
    }).catch(async () => {
      // groupId null path: fall back to clearing via folder update
      if (groupId === null) {
        await get().updateFolder(folderId, { groupId: null });
      }
    });
    await get().loadFolders();
  },

  listLinks: async (folderId) =>
    api<FolderLink[]>(`/api/folders/${folderId}/links`),

  registerLink: async (folderId, name, targetPath) => {
    await api(`/api/folders/${folderId}/links`, {
      method: "POST",
      body: JSON.stringify({ name, targetPath }),
    });
  },

  renameLink: async (folderId, linkId, name) => {
    await api(`/api/folders/${folderId}/links/${linkId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  },

  deleteLink: async (folderId, linkId) => {
    await api(`/api/folders/${folderId}/links/${linkId}`, { method: "DELETE" });
  },

  setSelectedFolder: (id) => {
    try {
      if (id) window.localStorage.setItem(SELECTED_KEY, id);
      else window.localStorage.removeItem(SELECTED_KEY);
    } catch {
      /* ignore */
    }
    set({ selectedFolderId: id });
  },

  setFolderExpanded: (id, expanded) => {
    set((s) => {
      const next = { ...s.folderExpanded, [id]: expanded };
      saveFolderExpanded(next);
      return { folderExpanded: next };
    });
  },

  setAllFoldersExpanded: (expanded) => {
    set((s) => {
      const next: Record<string, boolean> = {};
      for (const f of s.folders) next[f.id] = expanded;
      saveFolderExpanded(next);
      return { folderExpanded: next };
    });
  },
}));
