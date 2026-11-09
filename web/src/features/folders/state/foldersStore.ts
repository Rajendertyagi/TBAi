import { create } from "zustand";
import { apiJson } from "../../../lib/api";
import { usePreferencesStore } from "../../preferences/state/preferencesStore";
import type { Folder, FolderGroup, FolderLink } from "../../../types/index";

/**
 * Registered folder / workspace registry store.
 * Folder list/groups come from API. Navigation selection/expansion are shared
 * portable preferences (SQLite authoritative); defaults before hydration.
 */
interface FoldersState {
  folders: Folder[];
  folderGroups: FolderGroup[];
  /** Globally-selected folder for navigation/UI (shared portable). */
  selectedFolderId: string | null;
  /** Per-folder expand/collapse state (shared portable). */
  folderExpanded: Record<string, boolean>;
  loading: boolean;
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
  updateGroup: (id: string, data: { name?: string; color?: string }) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  reorderFolders: (ids: string[]) => Promise<void>;
  setFolderGroup: (folderId: string, groupId: string | null) => Promise<void>;
  listLinks: (folderId: string) => Promise<FolderLink[]>;
  registerLink: (folderId: string, name: string, targetPath: string) => Promise<void>;
  renameLink: (folderId: string, linkId: string, name: string) => Promise<void>;
  deleteLink: (folderId: string, linkId: string) => Promise<void>;
  setSelectedFolder: (id: string | null) => void;
  setFolderExpanded: (id: string, expanded: boolean) => void;
  setAllFoldersExpanded: (expanded: boolean) => void;
}

/**
 * Soft-reference resolver for navigation selection. Missing folder IDs are
 * preserved (never silently nulled/substituted).
 */
export function resolveSelectedFolderId(
  _folders: Folder[],
  selectedId: string | null,
): string | null {
  return selectedId;
}

/** @deprecated Use resolveSelectedFolderId; kept for compatibility with existing imports. */
export const pruneSelectedFolderId = resolveSelectedFolderId;

let foldersLoadEpoch = 0;

export const useFoldersStore = create<FoldersState>((set, get) => ({
  folders: [],
  folderGroups: [],
  selectedFolderId: null,
  folderExpanded: {},
  loading: false,
  foldersLoaded: false,

  loadFolders: async () => {
    const epoch = ++foldersLoadEpoch;
    set({ loading: true });
    try {
      const folders = await apiJson<Folder[]>("/api/folders");
      if (epoch !== foldersLoadEpoch) return;
      set({ folders, foldersLoaded: true });
    } finally {
      if (epoch === foldersLoadEpoch) set({ loading: false });
    }
  },

  loadGroups: async () => {
    const folderGroups = await apiJson<FolderGroup[]>("/api/folders/groups");
    set({ folderGroups });
  },

  createFolder: async (input) => {
    const folder = await apiJson<Folder>("/api/folders", {
      method: "POST",
      body: JSON.stringify(input),
    });
    await get().loadFolders();
    return folder;
  },

  updateFolder: async (id, data) => {
    await apiJson(`/api/folders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    await get().loadFolders();
  },

  removeFolder: async (id) => {
    await apiJson(`/api/folders/${id}`, { method: "DELETE" });
    if (get().selectedFolderId === id) get().setSelectedFolder(null);
    await get().loadFolders();
  },

  closeFolder: async (id) => {
    await apiJson(`/api/folders/${id}/close`, { method: "POST" });
    await get().loadFolders();
  },

  createGroup: async (name, color) => {
    await apiJson("/api/folders/groups", {
      method: "POST",
      body: JSON.stringify({ name, color }),
    });
    await get().loadGroups();
  },

  updateGroup: async (id, data) => {
    await apiJson(`/api/folders/groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    await get().loadGroups();
  },

  reorderFolders: async (ids: string[]) => {
    const current = get().folders;
    const map = new Map(current.map((f) => [f.id, f]));
    const next: Folder[] = [];
    for (const id of ids) {
      const f = map.get(id);
      if (f) next.push(f);
    }
    for (const f of current) {
      if (!ids.includes(f.id)) next.push(f);
    }
    set({ folders: next });
    await apiJson("/api/folders/reorder", {
      method: "PATCH",
      body: JSON.stringify({ ids }),
    });
  },

  deleteGroup: async (id) => {
    await apiJson(`/api/folders/groups/${id}`, { method: "DELETE" });
    await get().loadGroups();
    await get().loadFolders();
  },

  setFolderGroup: async (folderId, groupId) => {
    await apiJson(`/api/folders/groups/${groupId ?? "_none"}/set`, {
      method: "POST",
      body: JSON.stringify({ folderId }),
    }).catch(async () => {
      if (groupId === null) {
        await get().updateFolder(folderId, { groupId: null });
      }
    });
    await get().loadFolders();
  },

  listLinks: async (folderId) => apiJson<FolderLink[]>(`/api/folders/${folderId}/links`),

  registerLink: async (folderId, name, targetPath) => {
    await apiJson(`/api/folders/${folderId}/links`, {
      method: "POST",
      body: JSON.stringify({ name, targetPath }),
    });
  },

  renameLink: async (folderId, linkId, name) => {
    await apiJson(`/api/folders/${folderId}/links/${linkId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  },

  deleteLink: async (folderId, linkId) => {
    await apiJson(`/api/folders/${folderId}/links/${linkId}`, { method: "DELETE" });
  },

  setSelectedFolder: (id) => {
    set({ selectedFolderId: id });
    void usePreferencesStore
      .getState()
      .patchPreferences({ navigation: { selectedFolderId: id } })
      .catch(() => {});
  },

  setFolderExpanded: (id, expanded) => {
    set((s) => {
      const next = { ...s.folderExpanded, [id]: expanded };
      void usePreferencesStore
        .getState()
        .patchPreferences({ navigation: { folderExpanded: next } })
        .catch(() => {});
      return { folderExpanded: next };
    });
  },

  setAllFoldersExpanded: (expanded) => {
    set((s) => {
      const next: Record<string, boolean> = {};
      for (const f of s.folders) next[f.id] = expanded;
      void usePreferencesStore
        .getState()
        .patchPreferences({ navigation: { folderExpanded: next } })
        .catch(() => {});
      return { folderExpanded: next };
    });
  },
}));
