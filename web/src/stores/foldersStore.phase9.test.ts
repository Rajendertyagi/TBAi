/**
 * Phase 9 — frontend workspace registry state correctness.
 *
 * Pure selection pruning + load-epoch convergence for the folders store, and
 * draft scope bind/unbind transitions for the welcome scope. Deterministic:
 * controlled promise barriers for the overlapping-load race — no sleeps.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  pruneSelectedFolderId,
  useFoldersStore,
} from "./foldersStore";
import { useWelcomeScopeStore } from "../features/chat/state/welcomeScope";
import type { Folder } from "../types";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
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
});

describe("pruneSelectedFolderId — persisted selection converges on reload", () => {
  it("keeps a selection that still names a registered folder", () => {
    expect(
      pruneSelectedFolderId([folder("a"), folder("b")], "b"),
    ).toBe("b");
  });

  it("drops a selection whose folder is gone (removed or never existed)", () => {
    expect(pruneSelectedFolderId([folder("a")], "gone")).toBeNull();
    expect(pruneSelectedFolderId([], "gone")).toBeNull();
  });

  it("null stays null (no selection invents one)", () => {
    expect(pruneSelectedFolderId([folder("a")], null)).toBeNull();
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
    // Newer resolves first, stale resolves last: stale must not win.
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

  it("a stale selection is pruned when the fresh list arrives", async () => {
    globalThis.fetch = (async () =>
      okFolders([folder("kept")])) as unknown as typeof fetch;
    useFoldersStore.setState({ selectedFolderId: "removed" });
    await useFoldersStore.getState().loadFolders();
    expect(useFoldersStore.getState().selectedFolderId).toBeNull();
    expect(useFoldersStore.getState().folders.map((f) => f.id)).toEqual([
      "kept",
    ]);
  });
});

describe("welcome scope — project binding is explicit UI state", () => {
  it("simple has no workspace dependency", () => {
    useWelcomeScopeStore
      .getState()
      .setScope({ mode: "simple", folderId: null });
    expect(useWelcomeScopeStore.getState().scope).toEqual({
      mode: "simple",
      folderId: null,
    });
  });

  it("project scope carries the folder id and survives re-selection", () => {
    const store = () => useWelcomeScopeStore.getState();
    store().setScope({ mode: "project", folderId: "proj-1" });
    expect(store().scope).toEqual({ mode: "project", folderId: "proj-1" });
    // Switching to a second project ends on the second (rapid A→B).
    store().setScope({ mode: "project", folderId: "proj-2" });
    expect(store().scope).toEqual({ mode: "project", folderId: "proj-2" });
  });

  it("project without an id collapses to simple (never a half-bound scope)", () => {
    useWelcomeScopeStore
      .getState()
      .setScope({ mode: "project", folderId: null });
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
});
