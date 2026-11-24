/**
 * Lazy OpenCode activation — startup / reconciliation regression (final audit fix).
 *
 * dockview-core makes every added panel active (origin 'api'), even during a
 * bulk `addPanel` burst. `DockviewWorkspace` used to forward EVERY
 * `onDidActivePanelChange` into `activateWorkspacePanel`, so with N OpenCode
 * panels open at startup all N bootstrapped their expensive runtimes even when
 * the deep link addressed a Direct panel. This suite mounts the REAL
 * `DockviewWorkspace` with a fake Dockview API that reproduces that library
 * behaviour, and pins the gate: only a user click or the window-level intended
 * key starts a runtime.
 *
 * The downstream consequence (dormant placeholder + zero session/capabilities/
 * config/folder/runtime requests while `activated=false`) is already proven by
 * `tests/dom/opencode/OpenCodeChatHost.activation.test.tsx`; this suite owns the
 * activation-state half of the contract, which is the root cause of the defect.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  AddPanelOptionsLike,
  DockviewControllerDeps,
  Disposable,
  MutationKind,
  PanelRef,
} from "@web/features/workspace/dockviewController";

// Derive the library origin type from the web source's own signature: a direct
// `dockview-react` import cannot resolve from the root test project (the package
// lives in web/node_modules), but the web source resolves it from its own tree.
type DockviewOrigin = Parameters<NonNullable<DockviewControllerDeps["onActivePanelChange"]>>[1];
import {
  getWorkspaceActivationGeneration,
  isWorkspacePanelStarted,
  resetWorkspaceActivationForTests,
} from "@web/features/workspace/state/workspaceActivation";

// --- Fake Dockview API ----------------------------------------------------
// `toControllerApi` in DockviewWorkspace reads only this structural subset at
// runtime. The fake deliberately fires onDidActivePanelChange with origin
// 'api' from addPanel/setActive, mirroring dockview-core 8.9.1's withOrigin("api").
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
  private moveListeners: Array<(event: { panel: PanelRef }) => void> = [];
  private willMutateListeners: MutateListener[] = [];
  private didMutateListeners: MutateListener[] = [];
  private addListeners: PanelListener[] = [];
  private removeListeners: PanelListener[] = [];
  private layoutListeners: LayoutListener[] = [];
  private layoutFromJSONListeners: Array<() => void> = [];
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
    // dockview-core: every added panel becomes active with origin 'api'.
    this.fireActive(options.id, "api");
    return panel;
  }

  removePanel(panel: PanelRef): void {
    this.panels = this.panels.filter((candidate) => candidate.id !== panel.id);
    for (const listener of this.removeListeners) listener(panel);
  }

  toJSON(): object {
    return {
      grid: {
        root: { type: "leaf", data: { id: "group-1", views: [] }, size: 100 },
        height: 100,
        width: 100,
        orientation: "HORIZONTAL",
      },
      panels: {},
    };
  }

  fromJSON(): void {}

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
    this.layoutFromJSONListeners.push(listener);
    return { dispose() {} };
  }
  onDidActivePanelChange(listener: ActiveListener): Disposable {
    this.activeListeners.push(listener);
    return { dispose() {} };
  }

  /** Drive an active-panel change with a controlled origin (test seam). */
  fireActive(id: string, origin: DockviewOrigin): void {
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

// --- Mount helpers --------------------------------------------------------
let container: HTMLElement;
let root: Root | null = null;

function render(props: {
  openTabKeys: readonly string[];
  activeTabKey?: string;
  storageKey: string;
}): void {
  act(() => {
    if (!root) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
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

beforeEach(() => {
  resetWorkspaceActivationForTests();
  fakeApi = new FakeDockviewApi();
});

afterEach(() => {
  unmount();
  resetWorkspaceActivationForTests();
});

describe("lazy OpenCode activation — startup / reconciliation (final audit fix)", () => {
  it("startup with a deep-linked Direct panel leaves every OpenCode panel dormant", async () => {
    const directKeys = ["chat:d1", "chat:d2", "chat:d3", "chat:d4"];
    const agentKeys = ["agent:o1", "agent:o2", "agent:o3", "agent:o4"];

    render({
      openTabKeys: [...directKeys, ...agentKeys],
      activeTabKey: "chat:d1",
      storageKey: "test-startup-dormant",
    });
    await settle();

    // The intended Direct panel is started (gate on the 'api' focus fired from
    // onReady, plus the activeTabKey effect safety net).
    expect(isWorkspacePanelStarted("chat:d1")).toBe(true);

    // All four OpenCode panels stayed dormant despite dockview-core's transient
    // 'api' activations during the bulk addPanel burst.
    for (const key of agentKeys) {
      expect(isWorkspacePanelStarted(key)).toBe(false);
      expect(getWorkspaceActivationGeneration(key)).toBe(0);
    }
    // Non-intended Direct panels are dormant too (the gate is engine-neutral).
    for (const key of directKeys.slice(1)) {
      expect(isWorkspacePanelStarted(key)).toBe(false);
    }
  });

  it("reconciliation adding panels does not activate non-intended panels", async () => {
    render({
      openTabKeys: ["chat:d1"],
      activeTabKey: "chat:d1",
      storageKey: "test-reconcile-dormant",
    });
    await settle();
    expect(isWorkspacePanelStarted("chat:d1")).toBe(true);

    // A canonical-key-set change adds two OpenCode panels via reconcilePanels;
    // each addPanel fires an 'api' active change that must be ignored.
    render({
      openTabKeys: ["chat:d1", "agent:r1", "agent:r2"],
      activeTabKey: "chat:d1",
      storageKey: "test-reconcile-dormant",
    });
    await settle();

    expect(isWorkspacePanelStarted("agent:r1")).toBe(false);
    expect(isWorkspacePanelStarted("agent:r2")).toBe(false);
    expect(isWorkspacePanelStarted("chat:d1")).toBe(true);
  });

  it("user focus activates exactly once; non-intended api focus does not", async () => {
    render({
      openTabKeys: ["chat:d1", "agent:o1", "agent:o2"],
      activeTabKey: "chat:d1",
      storageKey: "test-focus-activation",
    });
    await settle();

    expect(isWorkspacePanelStarted("chat:d1")).toBe(true);
    expect(isWorkspacePanelStarted("agent:o1")).toBe(false);

    // A transient 'api' event for a non-intended key must NOT start the runtime.
    act(() => fakeApi.fireActive("agent:o1", "api"));
    expect(isWorkspacePanelStarted("agent:o1")).toBe(false);

    // A user click is intentional and starts the runtime exactly once.
    act(() => fakeApi.fireActive("agent:o1", "user"));
    expect(isWorkspacePanelStarted("agent:o1")).toBe(true);
    const generation = getWorkspaceActivationGeneration("agent:o1");
    act(() => fakeApi.fireActive("agent:o1", "user"));
    expect(getWorkspaceActivationGeneration("agent:o1")).toBe(generation);

    // Route navigation to a new intended key still activates it (safety net),
    // and a subsequent 'api' echo for that key is a no-op.
    render({
      openTabKeys: ["chat:d1", "agent:o1", "agent:o2"],
      activeTabKey: "agent:o2",
      storageKey: "test-focus-activation",
    });
    await settle();
    expect(isWorkspacePanelStarted("agent:o2")).toBe(true);
    const intendedGeneration = getWorkspaceActivationGeneration("agent:o2");
    act(() => fakeApi.fireActive("agent:o2", "api"));
    expect(getWorkspaceActivationGeneration("agent:o2")).toBe(intendedGeneration);
  });
});
