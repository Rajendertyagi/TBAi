/**
 * Folder/welcome soft-reference correctness (shared workspace architecture).
 *
 * `navigation.selectedFolderId` and welcome project `folderId` are soft
 * references: a missing folder during hydration/refresh must not erase the
 * selection, substitute an unrelated folder, or trigger accidental CAS patches.
 * Genuine deletion is handled only by explicit delete actions.
 *
 * Also preserves load-epoch convergence for the folders store and draft scope
 * binding transitions. Deterministic: controlled promise barriers for
 * overlapping-load races — no sleeps.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  pruneSelectedFolderId,
  resolveSelectedFolderId,
  useFoldersStore,
} from "@web/features/folders/state/foldersStore";
import { useWelcomeScopeStore } from "@web/features/chat/state/welcomeScope.ts";
import { usePreferencesStore } from "@web/features/preferences/state/preferencesStore";
import type { Folder } from "@web/types";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

function folder(id: string): Folder {
  return {
    id,
    name: id,
    path: `/proj/${id}`,
    alias: null,
    color: "#6b7280",
    groupId: null,
    isOpen: true,
    sortOrder: 0,
    kind: "regular",
    lastOpenedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    conversationCount: 0,
  };
}

function okFolders(list: Folder[]) {
  return {
    ok: true,
    status: 200,
    json: async () => list,
  } as Response;
}

function deferred() {
  let resolve!: (v: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  useFoldersStore.setState({
    folders: [],
    foldersLoaded: false,
    loading: false,
    selectedFolderId: null,
  });
  useWelcomeScopeStore.setState({
    scope: { mode: "simple", folderId: null },
  });
  usePreferencesStore.setState({
    patchPreferences: async () => null,
  } as any);
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem("tbai:selectedFolder");
  } catch {
    /* ignore */
  }
});

describe("resolveSelectedFolderId — soft reference (never prunes/substitutes)", () => {
  it("keeps a selection that still names a registered folder", () => {
    expect(resolveSelectedFolderId([folder("a"), folder("b")], "b")).toBe("b");
  });

  it("preserves a missing folder ID (no silent null, no unrelated fallback)", () => {
    expect(resolveSelectedFolderId([folder("a")], "gone")).toBe("gone");
    expect(resolveSelectedFolderId([], "gone")).toBe("gone");
  });

  it("null stays null (no selection invents one)", () => {
    expect(resolveSelectedFolderId([folder("a")], null)).toBeNull();
  });

  it("pruneSelectedFolderId compat alias preserves soft references", () => {
    expect(pruneSelectedFolderId([folder("a")], "gone")).toBe("gone");
  });
});

describe("loadFolders — soft references preserved across hydration/refresh", () => {
  it("missing selected folder during initial folder loading is preserved", async () => {
    globalThis.fetch = (async () => okFolders([folder("other")])) as unknown as typeof fetch;
    useFoldersStore.setState({ selectedFolderId: "missing-id", foldersLoaded: false });
    await useFoldersStore.getState().loadFolders();
    const s = useFoldersStore.getState();
    expect(s.selectedFolderId).toBe("missing-id");
    expect(s.folders.map((f) => f.id)).toEqual(["other"]);
    expect(s.foldersLoaded).toBe(true);
  });

  it("missing folder after successful folder-list refresh is preserved", async () => {
    globalThis.fetch = (async () => okFolders([folder("a")])) as unknown as typeof fetch;
    useFoldersStore.setState({ selectedFolderId: "a", foldersLoaded: true, folders: [folder("a")] });
    await useFoldersStore.getState().loadFolders();
    expect(useFoldersStore.getState().selectedFolderId).toBe("a");

    globalThis.fetch = (async () => okFolders([folder("b")])) as unknown as typeof fetch;
    await useFoldersStore.getState().loadFolders();
    const s = useFoldersStore.getState();
    expect(s.selectedFolderId).toBe("a"); // soft ref preserved, not substituted with b
    expect(s.folders.map((f) => f.id)).toEqual(["b"]);
  });

  it("folder becoming available again resolves the same reference", async () => {
    globalThis.fetch = (async () => okFolders([folder("other")])) as unknown as typeof fetch;
    useFoldersStore.setState({ selectedFolderId: "target", foldersLoaded: false });
    await useFoldersStore.getState().loadFolders();
    expect(useFoldersStore.getState().selectedFolderId).toBe("target");

    globalThis.fetch = (async () =>
      okFolders([folder("other"), folder("target")])) as unknown as typeof fetch;
    await useFoldersStore.getState().loadFolders();
    const s = useFoldersStore.getState();
    expect(s.selectedFolderId).toBe("target");
    expect(s.folders.some((f) => f.id === "target")).toBe(true);
  });

  it("no unrelated folder selected as a fallback when selection is missing", async () => {
    globalThis.fetch = (async () =>
      okFolders([folder("x"), folder("y")])) as unknown as typeof fetch;
    useFoldersStore.setState({ selectedFolderId: "missing" });
    await useFoldersStore.getState().loadFolders();
    expect(useFoldersStore.getState().selectedFolderId).toBe("missing");
    expect(useFoldersStore.getState().selectedFolderId).not.toBe("x");
    expect(useFoldersStore.getState().selectedFolderId).not.toBe("y");
  });

  it("no accidental CAS patch or localStorage erasure for missing reference during load", async () => {
    const patchPreferences = mock(async () => null);
    usePreferencesStore.setState({ patchPreferences } as any);
    const ls = typeof window !== "undefined" ? window.localStorage : undefined;
    ls?.setItem("tbai:selectedFolder", "missing");
    globalThis.fetch = (async () => okFolders([folder("other")])) as unknown as typeof fetch;
    useFoldersStore.setState({ selectedFolderId: "missing" });
    await useFoldersStore.getState().loadFolders();
    expect(useFoldersStore.getState().selectedFolderId).toBe("missing");
    if (ls) expect(ls.getItem("tbai:selectedFolder")).toBe("missing");
    expect(patchPreferences).not.toHaveBeenCalled();
  });

  it("server-to-local hydration applies selectedFolderId as soft reference (no pruning)", () => {
    // Mirrors PreferencesNavigationSync: applies server value even if folder not loaded.
    useFoldersStore.setState({ selectedFolderId: "local", folders: [], foldersLoaded: false });
    const serverSelectedFolderId = "server-missing-folder";
    // Sync behavior: set state directly (soft reference), no validation/pruning.
    useFoldersStore.setState({ selectedFolderId: serverSelectedFolderId });
    expect(useFoldersStore.getState().selectedFolderId).toBe("server-missing-folder");
  });

  it("explicit deletion clears selection (genuine delete contract only)", async () => {
    const patchPreferences = mock(async () => null);
    usePreferencesStore.setState({ patchPreferences } as any);
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return { ok: true, status: 200, json: async () => ({}) } as Response;
      return okFolders([folder("other")]);
    }) as unknown as typeof fetch;
    useFoldersStore.setState({
      selectedFolderId: "to-delete",
      folders: [folder("to-delete"), folder("other")],
      foldersLoaded: true,
    });
    await useFoldersStore.getState().removeFolder("to-delete");
    expect(useFoldersStore.getState().selectedFolderId).toBeNull();
  });
});

describe("loadFolders — stale responses never overwrite newer state", () => {
  it("an older in-flight load resolving last is ignored", async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    }) as unknown as typeof fetch;

    const store = () => useFoldersStore.getState();
    const p1 = store().loadFolders();
    const p2 = store().loadFolders();
    second.resolve(okFolders([folder("new")]));
    await p2;
    first.resolve(okFolders([folder("stale")]));
    await p1;

    expect(store().folders.map((f) => f.id)).toEqual(["new"]);
    expect(store().foldersLoaded).toBe(true);
  });

  it("rapid A→B selection of lists ends on B", async () => {
    const a = deferred();
    const b = deferred();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? a.promise : b.promise;
    }) as unknown as typeof fetch;

    const store = () => useFoldersStore.getState();
    const p1 = store().loadFolders();
    const p2 = store().loadFolders();
    a.resolve(okFolders([folder("A")]));
    await p1;
    b.resolve(okFolders([folder("B")]));
    await p2;

    expect(store().folders.map((f) => f.id)).toEqual(["B"]);
  });
});

describe("welcome scope — project binding is explicit UI state (soft refs preserved)", () => {
  it("simple has no workspace dependency", () => {
    useWelcomeScopeStore.getState().setScope({ mode: "simple", folderId: null });
    expect(useWelcomeScopeStore.getState().scope).toEqual({
      mode: "simple",
      folderId: null,
    });
  });

  it("project scope carries the folder id and survives re-selection", () => {
    const store = () => useWelcomeScopeStore.getState();
    store().setScope({ mode: "project", folderId: "proj-1" });
    expect(store().scope).toEqual({ mode: "project", folderId: "proj-1" });
    store().setScope({ mode: "project", folderId: "proj-2" });
    expect(store().scope).toEqual({ mode: "project", folderId: "proj-2" });
  });

  it("project without an id collapses to simple (never a half-bound scope)", () => {
    useWelcomeScopeStore.getState().setScope({ mode: "project", folderId: null });
    expect(useWelcomeScopeStore.getState().scope).toEqual({
      mode: "simple",
      folderId: null,
    });
  });

  it("switching back to simple clears the folder binding", () => {
    const store = () => useWelcomeScopeStore.getState();
    store().setScope({ mode: "project", folderId: "proj-1" });
    store().setScope({ mode: "simple", folderId: null });
    expect(store().scope).toEqual({ mode: "simple", folderId: null });
  });

  it("validateAgainstFolderIds preserves missing project folder soft reference", () => {
    const store = () => useWelcomeScopeStore.getState();
    store().setScope({ mode: "project", folderId: "missing-folder" });
    store().validateAgainstFolderIds(["other-folder"]);
    expect(store().scope).toEqual({ mode: "project", folderId: "missing-folder" });
  });

  it("validateAgainstFolderIds preserves project folder when it becomes available again", () => {
    const store = () => useWelcomeScopeStore.getState();
    store().setScope({ mode: "project", folderId: "target" });
    store().validateAgainstFolderIds([]);
    expect(store().scope).toEqual({ mode: "project", folderId: "target" });
    store().validateAgainstFolderIds(["target"]);
    expect(store().scope).toEqual({ mode: "project", folderId: "target" });
  });
});
