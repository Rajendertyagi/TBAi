import { afterEach, describe, expect, it } from "bun:test";
import { db } from "@/db";
import {
  WORKSPACE_PREFERENCES_SNAPSHOT_KEY,
  WorkspacePreferencesCorruptError,
  defaultSnapshot,
  getWorkspacePreferences,
  patchWorkspacePreferences,
  openSharedTab,
  closeSharedTab,
  closeSharedTabsBatch,
  reorderSharedTab,
  subscribePreferencesChanges,
  normalizeSectionOrderStrict,
} from "@/services/preferences";
import { conversationService, messageService } from "@/services/storage";

function clearSnapshot(): void {
  db.run("DELETE FROM app_settings WHERE key = ?", [WORKSPACE_PREFERENCES_SNAPSHOT_KEY]);
}

function readRawSnapshotRow(): { value: string; updated_at: number } | undefined {
  return db
    .query("SELECT value, updated_at FROM app_settings WHERE key = ?")
    .get(WORKSPACE_PREFERENCES_SNAPSHOT_KEY) as { value: string; updated_at: number } | undefined;
}

function writeRawSnapshot(value: unknown): void {
  db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [WORKSPACE_PREFERENCES_SNAPSHOT_KEY, JSON.stringify(value), Date.now()],
  );
}

afterEach(() => {
  clearSnapshot();
});

describe("workspace preferences service (canonical)", () => {
  it("returns defaults when no snapshot exists and does not write a row", () => {
    const snapshot = getWorkspacePreferences();
    expect(snapshot.revision).toBe(0);
    expect(snapshot.sharedTabs).toEqual([]);
    expect(snapshot.preferences).toEqual(defaultSnapshot().preferences);
    expect(readRawSnapshotRow() ?? undefined).toBeUndefined();
  });

  it("persists allowlisted preferences with leaf-field merge and increments revision", () => {
    const result = patchWorkspacePreferences({
      baseRevision: 0,
      preferences: { appearance: { themeMode: "dark" } },
    });
    expect(result.conflict).toBe(false);
    if (result.conflict) return;
    expect(result.snapshot.revision).toBe(1);
    expect(result.snapshot.preferences.appearance.themeMode).toBe("dark");
    expect(result.snapshot.preferences.appearance.lightTheme).toBe("default");
    expect(result.snapshot.preferences.appearance.darkTheme).toBe("default");

    // Leaf merge: updating only themeMode preserves other appearance fields.
    const second = patchWorkspacePreferences({
      baseRevision: 1,
      preferences: { appearance: { lightTheme: "solarized" } },
    });
    expect(second.conflict).toBe(false);
    if (second.conflict) return;
    expect(second.snapshot.preferences.appearance.themeMode).toBe("dark");
    expect(second.snapshot.preferences.appearance.lightTheme).toBe("solarized");
  });

  it("returns conflict with authoritative state on stale revision and makes no mutation", () => {
    patchWorkspacePreferences({
      baseRevision: 0,
      preferences: { appearance: { themeMode: "dark" } },
    });

    const stale = patchWorkspacePreferences({
      baseRevision: 0,
      preferences: { appearance: { themeMode: "light" } },
    });
    expect(stale.conflict).toBe(true);
    if (!stale.conflict) return;
    expect(stale.revision).toBe(1);
    expect(stale.snapshot.preferences.appearance.themeMode).toBe("dark");

    const loaded = getWorkspacePreferences();
    expect(loaded.revision).toBe(1);
    expect(loaded.preferences.appearance.themeMode).toBe("dark");
  });

  it("rejects unknown preference groups and invalid values", () => {
    expect(() =>
      patchWorkspacePreferences({
        baseRevision: 0,
        preferences: { unknownGroup: { x: 1 } },
      }),
    ).toThrow();

    expect(() =>
      patchWorkspacePreferences({
        baseRevision: 0,
        preferences: { appearance: { themeMode: "neon" } },
      }),
    ).toThrow();

    expect(getWorkspacePreferences().revision).toBe(0);
  });

  it("does not increment revision for an identical preferences patch", () => {
    const first = patchWorkspacePreferences({
      baseRevision: 0,
      preferences: { appearance: { themeMode: "dark" } },
    });
    expect(first.conflict).toBe(false);
    if (first.conflict) return;
    const rowAfterFirst = readRawSnapshotRow();

    const identical = patchWorkspacePreferences({
      baseRevision: 1,
      preferences: { appearance: { themeMode: "dark" } },
    });
    expect(identical.conflict).toBe(false);
    if (identical.conflict) return;
    expect(identical.snapshot.revision).toBe(1);
    const rowAfterIdentical = readRawSnapshotRow();
    expect(rowAfterIdentical?.value).toBe(rowAfterFirst?.value);
  });

  it("treats corrupt snapshot as explicit error, preserves row, and blocks unsafe mutations", () => {
    writeRawSnapshot({ revision: 1, sharedTabs: "nope", preferences: {} });
    const rawBefore = readRawSnapshotRow();
    expect(() => getWorkspacePreferences()).toThrow(WorkspacePreferencesCorruptError);
    expect(() =>
      patchWorkspacePreferences({
        baseRevision: 1,
        preferences: { appearance: { themeMode: "dark" } },
      }),
    ).toThrow(WorkspacePreferencesCorruptError);
    expect(() => openSharedTab({ baseRevision: 1, kind: "chat", conversationId: "c1" })).toThrow(
      WorkspacePreferencesCorruptError,
    );
    expect(() => closeSharedTab({ baseRevision: 1, conversationId: "c1" })).toThrow(
      WorkspacePreferencesCorruptError,
    );
    expect(() => closeSharedTabsBatch({ baseRevision: 1, mode: "all" })).toThrow(
      WorkspacePreferencesCorruptError,
    );
    expect(() => reorderSharedTab({ baseRevision: 1, conversationId: "c1", toIndex: 0 })).toThrow(
      WorkspacePreferencesCorruptError,
    );
    const rawAfter = readRawSnapshotRow();
    expect(rawAfter?.value).toBe(rawBefore?.value);
  });

  it("rejects explicit null required snapshot/group objects as corruption and preserves row", () => {
    const cases: unknown[] = [
      { revision: 1, sharedTabs: [], preferences: null },
      { revision: 1, sharedTabs: [], preferences: { appearance: null } },
      { revision: 1, sharedTabs: [], preferences: { desktop: null } },
      { revision: 1, sharedTabs: [], preferences: { welcome: null } },
      { revision: 1, sharedTabs: [], preferences: { navigation: null } },
    ];
    for (const value of cases) {
      writeRawSnapshot(value);
      const rawBefore = readRawSnapshotRow();
      expect(() => getWorkspacePreferences()).toThrow(WorkspacePreferencesCorruptError);
      expect(() =>
        patchWorkspacePreferences({
          baseRevision: 1,
          preferences: { appearance: { themeMode: "dark" } },
        }),
      ).toThrow(WorkspacePreferencesCorruptError);
      expect(readRawSnapshotRow()?.value).toBe(rawBefore?.value);
      clearSnapshot();
    }
  });

  it("missing fields use defaults; nullable leaves and sectionOrder:null remain valid", () => {
    writeRawSnapshot({
      revision: 3,
      sharedTabs: [],
      preferences: {
        appearance: {},
        desktop: { sectionOrder: null },
        welcome: { folderId: null },
        navigation: { selectedFolderId: null, folderExpanded: {} },
      },
    });
    const snapshot = getWorkspacePreferences();
    expect(snapshot.revision).toBe(3);
    expect(snapshot.preferences.appearance.themeMode).toBe("system");
    expect(snapshot.preferences.desktop.sectionOrder).toEqual(["folders", "chats"]);
    expect(snapshot.preferences.welcome.folderId).toBeNull();
    expect(snapshot.preferences.navigation.selectedFolderId).toBeNull();
  });

  it("ignores obsolete legacy fields on read without restoring behavior", () => {
    writeRawSnapshot({
      revision: 2,
      sharedTabs: [{ ref: "c1", kind: "chat" }],
      sharedActiveConversationId: "c1",
      migration: { sharedTabsInitialized: true },
      preferences: defaultSnapshot().preferences,
    });
    const snapshot = getWorkspacePreferences();
    expect(snapshot.revision).toBe(2);
    expect(snapshot.sharedTabs).toEqual([{ ref: "c1", kind: "chat" }]);
    expect((snapshot as any).sharedActiveConversationId).toBeUndefined();
    expect((snapshot as any).migration).toBeUndefined();
  });

  it("normalizes legacy WIP sharedTabs conversationId to canonical ref on read", () => {
    writeRawSnapshot({
      revision: 29,
      sharedTabs: [
        { kind: "chat", conversationId: "conv-legacy-1" },
        { kind: "agent", conversationId: "conv-legacy-2" },
      ],
      preferences: defaultSnapshot().preferences,
    });
    const snapshot = getWorkspacePreferences();
    expect(snapshot.revision).toBe(29);
    expect(snapshot.sharedTabs).toEqual([
      { kind: "chat", ref: "conv-legacy-1" },
      { kind: "agent", ref: "conv-legacy-2" },
    ]);
  });

  it("does not affect existing app_settings consumers' keys", () => {
    const before = db.query("SELECT key FROM app_settings WHERE key = ?").get("log.settings") as
      | { key: string }
      | undefined;
    patchWorkspacePreferences({
      baseRevision: 0,
      preferences: { appearance: { themeMode: "dark" } },
    });
    const after = db.query("SELECT key FROM app_settings WHERE key = ?").get("log.settings") as
      | { key: string }
      | undefined;
    expect(Boolean(after)).toBe(Boolean(before));
  });
});

describe("sectionOrder strict normalization (backend parity)", () => {
  it("missing/null/empty => default order", () => {
    expect(normalizeSectionOrderStrict(undefined)).toEqual(["folders", "chats"]);
    expect(normalizeSectionOrderStrict(null)).toEqual(["folders", "chats"]);
    expect(normalizeSectionOrderStrict([])).toEqual(["folders", "chats"]);
  });

  it("valid known IDs deduped and missing appended in default order", () => {
    expect(normalizeSectionOrderStrict(["chats", "folders"])).toEqual(["chats", "folders"]);
    expect(normalizeSectionOrderStrict(["chats"])).toEqual(["chats", "folders"]);
    expect(normalizeSectionOrderStrict(["folders", "folders", "chats"])).toEqual([
      "folders",
      "chats",
    ]);
  });

  it("non-array, invalid element types, unknown IDs => corruption error", () => {
    expect(() => normalizeSectionOrderStrict("folders")).toThrow(WorkspacePreferencesCorruptError);
    expect(() => normalizeSectionOrderStrict([1, 2])).toThrow(WorkspacePreferencesCorruptError);
    expect(() => normalizeSectionOrderStrict(["folders", "unknown"])).toThrow(
      WorkspacePreferencesCorruptError,
    );
  });
});

describe("workspace preferences shared tabs (CAS, canonical)", () => {
  it("opens a shared tab idempotently and increments revision once", () => {
    const first = openSharedTab({ baseRevision: 0, kind: "chat", conversationId: "c1" });
    expect(first.conflict).toBe(false);
    if (first.conflict) return;
    expect(first.snapshot.revision).toBe(1);
    expect(first.snapshot.sharedTabs).toEqual([{ kind: "chat", ref: "c1" }]);

    const second = openSharedTab({ baseRevision: 1, kind: "chat", conversationId: "c1" });
    expect(second.conflict).toBe(false);
    if (second.conflict) return;
    expect(second.snapshot.revision).toBe(1);
    expect(second.snapshot.sharedTabs).toHaveLength(1);
  });

  it("returns conflict with authoritative state on stale tab mutation and makes no mutation", () => {
    openSharedTab({ baseRevision: 0, kind: "chat", conversationId: "c1" });
    const stale = closeSharedTab({ baseRevision: 0, conversationId: "c1" });
    expect(stale.conflict).toBe(true);
    if (!stale.conflict) return;
    expect(stale.revision).toBe(1);
    expect(stale.snapshot.sharedTabs).toEqual([{ kind: "chat", ref: "c1" }]);
    expect(getWorkspacePreferences().sharedTabs).toHaveLength(1);
  });

  it("closes, batch-closes, and reorders with CAS", () => {
    openSharedTab({ baseRevision: 0, kind: "chat", conversationId: "a" });
    openSharedTab({ baseRevision: 1, kind: "chat", conversationId: "b" });
    openSharedTab({ baseRevision: 2, kind: "agent", conversationId: "c" });

    const reordered = reorderSharedTab({ baseRevision: 3, conversationId: "c", toIndex: 0 });
    expect(reordered.conflict).toBe(false);
    if (reordered.conflict) return;
    expect(reordered.snapshot.sharedTabs.map((t) => t.ref)).toEqual(["c", "a", "b"]);

    const batch = closeSharedTabsBatch({
      baseRevision: 4,
      mode: "right",
      anchorConversationId: "a",
    });
    expect(batch.conflict).toBe(false);
    if (batch.conflict) return;
    expect(batch.snapshot.sharedTabs.map((t) => t.ref)).toEqual(["c", "a"]);

    const closed = closeSharedTab({ baseRevision: 5, conversationId: "c" });
    expect(closed.conflict).toBe(false);
    if (closed.conflict) return;
    expect(closed.snapshot.sharedTabs.map((t) => t.ref)).toEqual(["a"]);
  });

  it("removing shared membership never deletes conversation data (close and batch)", async () => {
    const conv = await conversationService.create({
      title: "Keep me",
      engine: "direct",
      providerId: "test",
      workspaceMode: "simple",
    } as any);
    await messageService.upsertStored(conv.id, {
      id: "msg-keep-1",
      parent_id: null,
      format: "aui/v1",
      content: { role: "user", parts: [{ type: "text", text: "hello" }] },
    });

    try {
      const opened = openSharedTab({ baseRevision: 0, kind: "chat", conversationId: conv.id });
      expect(opened.conflict).toBe(false);
      if (opened.conflict) return;
      expect(opened.snapshot.sharedTabs.some((t) => t.ref === conv.id)).toBe(true);

      const closed = closeSharedTab({ baseRevision: 1, conversationId: conv.id });
      expect(closed.conflict).toBe(false);
      if (closed.conflict) return;
      expect(closed.snapshot.sharedTabs.some((t) => t.ref === conv.id)).toBe(false);

      // Membership removed, but conversation row and messages remain.
      const stillThere = await conversationService.get(conv.id);
      expect(stillThere).not.toBeNull();
      expect(stillThere?.title).toBe("Keep me");
      const msgs = await messageService.listThreadMessages(conv.id);
      expect(msgs.length).toBe(1);
      expect(msgs[0]?.id).toBe("msg-keep-1");

      // Batch close also never deletes conversation data.
      openSharedTab({ baseRevision: 2, kind: "chat", conversationId: conv.id });
      const batch = closeSharedTabsBatch({ baseRevision: 3, mode: "all" });
      expect(batch.conflict).toBe(false);
      if (batch.conflict) return;
      expect(batch.snapshot.sharedTabs).toEqual([]);
      expect(await conversationService.get(conv.id)).not.toBeNull();
      expect((await messageService.listThreadMessages(conv.id)).length).toBe(1);
    } finally {
      await conversationService.delete(conv.id).catch(() => {});
    }
  });

  it("emits preferences change after committed mutation with originWindowId", () => {
    const events: Array<{ revision: number; changedKeys?: string[]; originWindowId?: string }> = [];
    const unsub = subscribePreferencesChanges((e) =>
      events.push({
        revision: e.revision,
        changedKeys: e.changedKeys,
        originWindowId: e.originWindowId,
      }),
    );
    try {
      openSharedTab({
        baseRevision: 0,
        kind: "chat",
        conversationId: "c1",
        originWindowId: "win-1",
      });
      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1]?.revision).toBe(1);
      expect(events[events.length - 1]?.changedKeys).toContain("sharedTabs");
      expect(events[events.length - 1]?.originWindowId).toBe("win-1");
    } finally {
      unsub();
    }
  });

  it("does not emit events for stale conflicts or no-op mutations", () => {
    openSharedTab({ baseRevision: 0, kind: "chat", conversationId: "c1" });
    const events: Array<{ revision: number }> = [];
    const unsub = subscribePreferencesChanges((e) => events.push({ revision: e.revision }));
    try {
      const conflict = closeSharedTab({ baseRevision: 0, conversationId: "c1" });
      expect(conflict.conflict).toBe(true);
      const noop = openSharedTab({ baseRevision: 1, kind: "chat", conversationId: "c1" });
      expect(noop.conflict).toBe(false);
      if (!noop.conflict) expect(noop.snapshot.revision).toBe(1);
      const noopClose = closeSharedTab({ baseRevision: 1, conversationId: "missing" });
      expect(noopClose.conflict).toBe(false);
      if (!noopClose.conflict) expect(noopClose.snapshot.revision).toBe(1);
      expect(events).toEqual([]);
    } finally {
      unsub();
    }
  });

  it("subscriber exceptions do not break successful mutation results", () => {
    const events: number[] = [];
    const unsubThrow = subscribePreferencesChanges(() => {
      throw new Error("boom");
    });
    const unsubOk = subscribePreferencesChanges((e) => events.push(e.revision));
    try {
      const result = openSharedTab({ baseRevision: 0, kind: "chat", conversationId: "c1" });
      expect(result.conflict).toBe(false);
      if (!result.conflict) expect(result.snapshot.revision).toBe(1);
      expect(events).toEqual([1]);
    } finally {
      unsubThrow();
      unsubOk();
    }
  });
});
