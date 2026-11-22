/**
 * Versioned Dockview layout persistence: migration, validation, reconciliation
 * against canonical chatTabs, and safe fallback on corrupt/incompatible data.
 */
import { describe, it, expect } from "bun:test";
import {
  clearLayout,
  DOCKVIEW_LAYOUT_VERSION,
  loadLayout,
  migrateLayout,
  reconcileLayout,
  saveLayout,
  type LayoutStorage,
} from "@web/features/workspace/state/layoutPersistence";

// Derive the Dockview type from the web source's own signature: a direct
// `dockview-react` import cannot resolve from the root test project (the package
// lives in web/node_modules), but the web source resolves it from its own tree.
type SerializedDockview = Parameters<typeof saveLayout>[0];

function fakeStorage(): LayoutStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function makeLayout(): SerializedDockview {
  return {
    grid: {
      root: {
        type: "leaf",
        data: { id: "group-1", views: ["chat:a", "chat:b"], activeView: "chat:a" },
        size: 100,
      },
      height: 100,
      width: 100,
      orientation: "HORIZONTAL" as SerializedDockview["grid"]["orientation"],
    },
    panels: {
      "chat:a": {
        id: "chat:a",
        contentComponent: "tbai-direct",
        params: { tabKey: "chat:a", contentType: "direct" },
      },
      "chat:b": {
        id: "chat:b",
        contentComponent: "tbai-direct",
        params: { tabKey: "chat:b", contentType: "direct" },
      },
    },
    activeGroup: "group-1",
  };
}

describe("migrateLayout", () => {
  it("accepts the current version", () => {
    const record = { version: DOCKVIEW_LAYOUT_VERSION, savedAt: 123, layout: makeLayout() };
    expect(migrateLayout(record)).toEqual(record);
  });

  it("wraps a v0 bare layout", () => {
    const migrated = migrateLayout(makeLayout());
    expect(migrated?.version).toBe(DOCKVIEW_LAYOUT_VERSION);
    expect(migrated?.savedAt).toBe(0);
  });

  it("rejects unknown versions, corrupt shapes and secret-bearing params", () => {
    expect(migrateLayout({ version: 999, savedAt: 1, layout: makeLayout() })).toBeNull();
    expect(migrateLayout({ version: DOCKVIEW_LAYOUT_VERSION, savedAt: 1, layout: {} })).toBeNull();
    expect(migrateLayout("not an object")).toBeNull();
    const withSecret = makeLayout();
    withSecret.panels["chat:a"] = {
      ...withSecret.panels["chat:a"]!,
      params: { tabKey: "chat:a", contentType: "direct", apiKey: "super-secret" },
    };
    expect(migrateLayout(withSecret)).toBeNull();
  });
});

describe("reconcileLayout", () => {
  it("drops stale panel refs and prunes grid views/activeView", () => {
    const result = reconcileLayout(makeLayout(), ["chat:a"]);
    expect(result).not.toBeNull();
    expect(Object.keys(result!.panels)).toEqual(["chat:a"]);
    const root = result!.grid.root;
    expect(root.type).toBe("leaf");
    const data = root.data as { views: string[]; activeView?: string };
    expect(data.views).toEqual(["chat:a"]);
    expect(data.activeView).toBe("chat:a");
  });

  it("falls back to a safe default when no panel survives", () => {
    expect(reconcileLayout(makeLayout(), ["chat:deleted"])).toBeNull();
  });

  it("clears a stale active group", () => {
    const layout = makeLayout();
    layout.activeGroup = "group-gone";
    const result = reconcileLayout(layout, ["chat:a", "chat:b"]);
    expect(result?.activeGroup).toBeUndefined();
  });

  it("intentionally drops floating/popout/edge groups in V1", () => {
    // These carry absolute screen coordinates and refs that cannot be safely
    // reconciled against canonical chatTabs. The grid (splits + group structure
    // + placement) and active selection survive; the rest is dropped by design.
    const layout = makeLayout();
    layout.floatingGroups = [
      {
        data: { id: "float-group", views: ["chat:a"], activeView: "chat:a" },
        position: { top: 10, left: 10, width: 200, height: 200 },
      },
    ];
    const result = reconcileLayout(layout, ["chat:a"]);
    expect(result).not.toBeNull();
    expect(result!.floatingGroups).toBeUndefined();
    expect(result!.popoutGroups).toBeUndefined();
    expect(result!.edgeGroups).toBeUndefined();
    // The grid half still survives the drop.
    expect(Object.keys(result!.panels)).toEqual(["chat:a"]);
  });
});

describe("saveLayout / loadLayout", () => {
  it("round-trips a versioned envelope", () => {
    const storage = fakeStorage();
    saveLayout(makeLayout(), undefined, storage);
    expect(storage.data.size).toBe(1);
    const loaded = loadLayout(undefined, ["chat:a", "chat:b"], storage);
    expect(Object.keys(loaded!.panels).sort()).toEqual(["chat:a", "chat:b"]);
  });

  it("returns null for missing/corrupt records", () => {
    const storage = fakeStorage();
    expect(loadLayout(undefined, ["chat:a"], storage)).toBeNull();
    storage.data.set("tbai:dockview-layout", "{not json");
    expect(loadLayout(undefined, ["chat:a"], storage)).toBeNull();
  });

  it("clearLayout removes the saved record", () => {
    const storage = fakeStorage();
    saveLayout(makeLayout(), undefined, storage);
    clearLayout(undefined, storage);
    expect(storage.data.size).toBe(0);
  });
});
