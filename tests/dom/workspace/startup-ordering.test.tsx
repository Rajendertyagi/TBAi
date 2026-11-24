/**
 * Startup ordering — authoritative preferences before Dockview restoration.
 *
 * `DockviewWorkspace` used to call `controller.start()` from `onReady`, before
 * the preferences snapshot (the authoritative shared-tab allowlist) had arrived.
 * A saved split layout was then restored against an empty allowlist, its panels
 * were pruned, and a deep-link focus arriving at `onHandleReady` saw an empty
 * workspace. This suite mounts the REAL component with a fake Dockview API and
 * pins the gate: no restore/persist/handle until hydration is ready, then
 * setOpenTabKeys → start → handle → onHandleReady → deep-link focus.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, useEffect, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  AddPanelOptionsLike,
  DockviewControllerApi,
  DockviewControllerDeps,
  Disposable,
  MutationKind,
  PanelRef,
} from "@web/features/workspace/dockviewController";
import type {
  SharedTabRef,
  WorkspacePreferencesSnapshot,
} from "@web/features/preferences/state/types";
import { DOCKVIEW_LAYOUT_VERSION } from "@web/features/workspace/state/layoutPersistence";
import { resetWorkspaceActivationForTests } from "@web/features/workspace/state/workspaceActivation";
import { useChatTabsStore } from "@web/features/chat/state/chatTabs";
import { usePreferencesStore } from "@web/features/preferences/state/preferencesStore";
import type { DockviewWorkspaceHandle } from "@web/features/workspace/components/DockviewWorkspace";

// Derive the library origin type from the web source's own signature: a direct
// `dockview-react` import cannot resolve from the root test project (the package
// lives in web/node_modules), but the web source resolves it from its own tree.
type DockviewOrigin = Parameters<NonNullable<DockviewControllerDeps["onActivePanelChange"]>>[1];
type SerializedDockview = Parameters<DockviewControllerApi["fromJSON"]>[0];

// --- Fake Dockview API ----------------------------------------------------
interface FakePanel extends PanelRef {
  api: { setActive(): void };
}

type ActiveListener = (event: {
  panel: { id: string } | undefined;
  origin: DockviewOrigin;
}) => void;
type MutateListener = (event: { kind: MutationKind; origin: DockviewOrigin }) => void;
type PanelListener = (panel: PanelRef) => void;
type LayoutListener = (event: { reasons: ReadonlySet<string> }) => void;

class FakeDockviewApi {
  panels: FakePanel[] = [];
  /** Load-bearing counter: zero while gated, exactly one after activation. */
  fromJsonCalls = 0;
  lastFromJson: SerializedDockview | null = null;
  activeId: string | undefined;
  private moveListeners: Array<(event: { panel: PanelRef }) => void> = [];
  private willMutateListeners: MutateListener[] = [];
  private didMutateListeners: MutateListener[] = [];
  private addListeners: PanelListener[] = [];
  private removeListeners: PanelListener[] = [];
  private layoutListeners: LayoutListener[] = [];
  private layoutFromJsonListeners: Array<() => void> = [];
  private activeListeners: ActiveListener[] = [];

  getPanel(id: string): FakePanel | undefined {
    return this.panels.find((panel) => panel.id === id);
  }

  addPanel(options: AddPanelOptionsLike): unknown {
    const panel: FakePanel = {
      id: options.id,
      api: { setActive: () => this.fireActive(options.id, "api") },
    };
    this.panels.push(panel);
    this.fireActive(options.id, "api");
    return panel;
  }

  removePanel(panel: PanelRef): void {
    this.panels = this.panels.filter((candidate) => candidate.id !== panel.id);
    for (const listener of this.removeListeners) listener(panel);
  }

  toJSON(): SerializedDockview {
    return {
      grid: {
        root: { type: "leaf", data: { id: "group-1", views: [] }, size: 100 },
        height: 100,
        width: 100,
        orientation: "HORIZONTAL" as SerializedDockview["grid"]["orientation"],
      },
      panels: {},
    };
  }

  /** Mirror dockview-core: replay the saved panels synchronously on restore. */
  fromJSON(data: SerializedDockview): void {
    this.fromJsonCalls += 1;
    this.lastFromJson = data;
    for (const id of Object.keys(data.panels)) {
      if (this.getPanel(id)) continue;
      this.addPanel({
        id,
        component: "tbai-direct",
        params: { tabKey: id, contentType: "direct" },
        renderer: "always",
      });
    }
  }

  onDidMovePanel(listener: (event: { panel: PanelRef }) => void): Disposable {
    this.moveListeners.push(listener);
    return { dispose() {} };
  }
  onWillMutateLayout(listener: MutateListener): Disposable {
    this.willMutateListeners.push(listener);
    return { dispose() {} };
  }
  onDidMutateLayout(listener: MutateListener): Disposable {
    this.didMutateListeners.push(listener);
    return { dispose() {} };
  }
  onDidAddPanel(listener: PanelListener): Disposable {
    this.addListeners.push(listener);
    return { dispose() {} };
  }
  onDidRemovePanel(listener: PanelListener): Disposable {
    this.removeListeners.push(listener);
    return { dispose() {} };
  }
  onDidLayoutChange(listener: LayoutListener): Disposable {
    this.layoutListeners.push(listener);
    return { dispose() {} };
  }
  onDidLayoutFromJSON(listener: () => void): Disposable {
    this.layoutFromJsonListeners.push(listener);
    return { dispose() {} };
  }
  onDidActivePanelChange(listener: ActiveListener): Disposable {
    this.activeListeners.push(listener);
    return { dispose() {} };
  }

  fireActive(id: string, origin: DockviewOrigin): void {
    this.activeId = id;
    for (const listener of this.activeListeners) listener({ panel: { id }, origin });
  }
}

// --- Mock the single runtime value DockviewWorkspace imports --------------
let fakeApi: FakeDockviewApi;

mock.module("dockview-react", () => ({
  DockviewReact: ({ onReady }: { onReady: (event: { api: FakeDockviewApi }) => void }) => {
    useEffect(() => {
      onReady({ api: fakeApi });
    }, [onReady]);
    return <div data-testid="dockview-react" />;
  },
}));

const { DockviewWorkspace } = await import("@web/features/workspace/components/DockviewWorkspace");

// --- Fixtures -------------------------------------------------------------
const STORAGE_KEY = "test-startup-ordering";

const BASE_SNAPSHOT: WorkspacePreferencesSnapshot = {
  revision: 1,
  sharedTabs: [],
  preferences: {
    appearance: {
      themeMode: "system",
      lightTheme: "default",
      darkTheme: "default",
      typography: "default",
    },
    desktop: {
      sidebarVisible: true,
      statusBarVisible: true,
      chatWidth: "comfortable",
      sidebarSort: "updated",
      sectionOrder: [],
      sectionCollapsed: {},
      showCompleted: false,
      spellCheck: false,
    },
    welcome: { engine: "direct", quickActionTab: "chat", scopeMode: "simple", folderId: null },
    navigation: { selectedFolderId: null, folderExpanded: {} },
  },
};

function snapshotWith(sharedTabs: SharedTabRef[]): WorkspacePreferencesSnapshot {
  return { ...BASE_SNAPSHOT, sharedTabs };
}

const AUTHORITATIVE_TABS: SharedTabRef[] = [
  { ref: "a", kind: "chat" },
  { ref: "b", kind: "chat" },
];

/** A saved two-panel split (branch root, two leaf groups). */
const SAVED_LAYOUT = {
  version: DOCKVIEW_LAYOUT_VERSION,
  savedAt: 1,
  layout: {
    grid: {
      root: {
        type: "branch",
        data: [
          {
            type: "leaf",
            data: { id: "group-a", views: ["chat:a"], activeView: "chat:a" },
            size: 50,
          },
          {
            type: "leaf",
            data: { id: "group-b", views: ["chat:b"], activeView: "chat:b" },
            size: 50,
          },
        ],
        size: 100,
      },
      height: 100,
      width: 100,
      orientation: "HORIZONTAL",
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
    activeGroup: "group-a",
  },
};

function seedSavedLayout(): string {
  const raw = JSON.stringify(SAVED_LAYOUT);
  localStorage.setItem(STORAGE_KEY, raw);
  return raw;
}

function savedSplitIntact(data: SerializedDockview | null): boolean {
  const root = data?.grid.root;
  return root?.type === "branch" && Array.isArray(root.data) && root.data.length === 2;
}

// --- Mount helpers --------------------------------------------------------
let container: HTMLElement;
let root: Root | null = null;

interface RenderProps {
  activeTabKey?: string;
  storageKey: string;
  handleRef?: MutableRefObject<DockviewWorkspaceHandle | null>;
  onHandleReady?: () => void;
}

function render(props: RenderProps): void {
  act(() => {
    if (!root) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    // Deliberately no `openTabKeys` prop: the hydration gate must be active.
    root.render(<DockviewWorkspace {...props} />);
  });
}

function unmount(): void {
  if (!root) return;
  const current = root;
  root = null;
  act(() => current.unmount());
  container.remove();
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setHydration(patch: {
  hydration: "idle" | "loading" | "ready" | "error";
  snapshot: WorkspacePreferencesSnapshot | null;
  hydrationError?: string | null;
}): void {
  act(() => {
    usePreferencesStore.setState({
      hydration: patch.hydration,
      snapshot: patch.snapshot,
      hydrationError: patch.hydrationError ?? null,
    });
  });
}

beforeEach(() => {
  resetWorkspaceActivationForTests();
  fakeApi = new FakeDockviewApi();
  localStorage.removeItem(STORAGE_KEY);
  usePreferencesStore.setState({ hydration: "idle", snapshot: null, hydrationError: null });
  useChatTabsStore.setState({
    localActiveKey: undefined,
    hasLocalDraft: false,
    detachedRefs: {},
  });
});

afterEach(() => {
  unmount();
  resetWorkspaceActivationForTests();
});

describe("Dockview startup ordering (authoritative hydration gate)", () => {
  it("defers restore while preferences are loading", async () => {
    const raw = seedSavedLayout();
    const handleRef: MutableRefObject<DockviewWorkspaceHandle | null> = { current: null };
    const onHandleReady = mock(() => {});
    setHydration({ hydration: "loading", snapshot: null });

    render({ storageKey: STORAGE_KEY, handleRef, onHandleReady });
    await settle();

    expect(fakeApi.panels.length).toBe(0);
    expect(fakeApi.fromJsonCalls).toBe(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
    expect(handleRef.current).toBeNull();
    expect(onHandleReady).not.toHaveBeenCalled();
  });

  it("restores the saved split once hydration is ready", async () => {
    seedSavedLayout();
    const handleRef: MutableRefObject<DockviewWorkspaceHandle | null> = { current: null };
    const onHandleReady = mock(() => {});
    setHydration({ hydration: "loading", snapshot: null });

    render({
      storageKey: STORAGE_KEY,
      activeTabKey: "chat:a",
      handleRef,
      onHandleReady,
    });
    await settle();
    expect(fakeApi.panels.length).toBe(0);

    setHydration({ hydration: "ready", snapshot: snapshotWith(AUTHORITATIVE_TABS) });
    await settle();

    expect(fakeApi.fromJsonCalls).toBe(1);
    expect(savedSplitIntact(fakeApi.lastFromJson)).toBe(true);
    expect(fakeApi.panels.map((panel) => panel.id).sort()).toEqual(["chat:a", "chat:b"]);
    expect(handleRef.current).not.toBeNull();
    expect(onHandleReady).toHaveBeenCalledTimes(1);
    // Deep-link focus is applied after restoration, not before it.
    expect(fakeApi.activeId).toBe("chat:a");
  });

  it("a focus call before hydration is a no-op and start precedes handle exposure", async () => {
    seedSavedLayout();
    const handleRef: MutableRefObject<DockviewWorkspaceHandle | null> = { current: null };
    let panelsAtHandleReady = -1;
    const onHandleReady = mock(() => {
      panelsAtHandleReady = fakeApi.panels.length;
    });
    useChatTabsStore.setState({ localActiveKey: "chat:deep" });
    setHydration({ hydration: "loading", snapshot: null });

    render({
      storageKey: STORAGE_KEY,
      activeTabKey: "chat:deep",
      handleRef,
      onHandleReady,
    });
    await settle();

    // The handle does not exist yet, so an early deep-link focus cannot create
    // a panel or trigger a restore against the stale allowlist.
    act(() => handleRef.current?.focusOrOpen("chat:deep"));
    expect(fakeApi.panels.length).toBe(0);
    expect(fakeApi.fromJsonCalls).toBe(0);

    setHydration({ hydration: "ready", snapshot: snapshotWith(AUTHORITATIVE_TABS) });
    await settle();

    // onHandleReady observed the restored layout: start ran before the handle
    // was exposed and before the focus controller was notified.
    expect(panelsAtHandleReady).toBe(2);
    expect(onHandleReady).toHaveBeenCalledTimes(1);
    expect(handleRef.current).not.toBeNull();
  });

  it("shows an error status without restoring, then recovers on ready", async () => {
    const raw = seedSavedLayout();
    const handleRef: MutableRefObject<DockviewWorkspaceHandle | null> = { current: null };
    const onHandleReady = mock(() => {});
    setHydration({ hydration: "error", snapshot: null, hydrationError: "boom" });

    render({ storageKey: STORAGE_KEY, handleRef, onHandleReady });
    await settle();

    expect(fakeApi.panels.length).toBe(0);
    expect(fakeApi.fromJsonCalls).toBe(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
    expect(handleRef.current).toBeNull();
    expect(onHandleReady).not.toHaveBeenCalled();
    const errorEl = container.querySelector('[data-testid="workspace-hydration-error"]');
    expect(errorEl).not.toBeNull();
    expect(errorEl?.getAttribute("role")).toBe("status");
    expect(errorEl?.textContent).toContain("Workspace unavailable");

    setHydration({ hydration: "ready", snapshot: snapshotWith(AUTHORITATIVE_TABS) });
    await settle();

    expect(fakeApi.fromJsonCalls).toBe(1);
    expect(savedSplitIntact(fakeApi.lastFromJson)).toBe(true);
    expect(fakeApi.panels.map((panel) => panel.id).sort()).toEqual(["chat:a", "chat:b"]);
    expect(handleRef.current).not.toBeNull();
    expect(container.querySelector('[data-testid="workspace-hydration-error"]')).toBeNull();
  });
});
