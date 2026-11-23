/**
 * Behavioral tests for the Dockview workspace controller state machine.
 *
 * A fake DockviewApi drives the real event handlers. These pin the invariants
 * that source-level guards cannot: a move never triggers close semantics or
 * disposes a runtime, a genuine close is confirmed only after mutation settles
 * and absence is verified, layout writes are suppressed during restore, and
 * reconciliation is an idempotent add/remove diff against canonical chatTabs.
 */
import { describe, it, expect } from "bun:test";
import {
  DockviewController,
  type AddPanelOptionsLike,
  type DockviewControllerApi,
  type MutationKind,
  type PanelRef,
} from "@web/features/workspace/dockviewController";

type MoveListener = Parameters<DockviewControllerApi["onDidMovePanel"]>[0];
type MutateListener = Parameters<DockviewControllerApi["onDidMutateLayout"]>[0];
type PanelListener = Parameters<DockviewControllerApi["onDidRemovePanel"]>[0];
type LayoutListener = Parameters<DockviewControllerApi["onDidLayoutChange"]>[0];
type ActiveListener = Parameters<DockviewControllerApi["onDidActivePanelChange"]>[0];
type LayoutReasons =
  Parameters<LayoutListener>[0]["reasons"] extends ReadonlySet<infer R> ? R : never;
type SerializedLayout = ReturnType<DockviewControllerApi["toJSON"]>;

function makeLayout(): SerializedLayout {
  return {
    grid: {
      root: {
        type: "leaf",
        data: { id: "group-1", views: ["chat:a"], activeView: "chat:a" },
        size: 100,
      },
      height: 100,
      width: 100,
      orientation: "HORIZONTAL" as SerializedLayout["grid"]["orientation"],
    },
    panels: {
      "chat:a": {
        id: "chat:a",
        contentComponent: "tbai-direct",
        params: { tabKey: "chat:a", contentType: "direct" },
      },
    },
  };
}

/** Fake API with explicit event firing and observable side effects. */
class FakeApi implements DockviewControllerApi {
  panels: PanelRef[] = [];
  addPanelCalls: AddPanelOptionsLike[] = [];
  removePanelCalls: string[] = [];
  activePanelCalls: string[] = [];
  fromJSONCalls: Array<{ data: SerializedLayout; options?: { reuseExistingPanels: boolean } }> = [];
  toJSONCalls = 0;

  private moveListeners: MoveListener[] = [];
  private willMutateListeners: MutateListener[] = [];
  private didMutateListeners: MutateListener[] = [];
  private addListeners: PanelListener[] = [];
  private removeListeners: PanelListener[] = [];
  private layoutListeners: LayoutListener[] = [];
  private layoutFromJSONListeners: Array<() => void> = [];
  private activeListeners: ActiveListener[] = [];

  getPanel(id: string): PanelRef | undefined {
    return this.panels.find((panel) => panel.id === id);
  }

  addPanel(options: AddPanelOptionsLike): unknown {
    this.addPanelCalls.push(options);
    this.panels.push({ id: options.id });
    return { id: options.id };
  }

  removePanelById(id: string): void {
    this.removePanelCalls.push(id);
    this.panels = this.panels.filter((panel) => panel.id !== id);
    // Real Dockview emits onDidRemovePanel when a panel is removed
    // programmatically (reconciliation, replacePanel). Mirror that so the
    // controller's suspected-close path is exercised by programmatic removals.
    for (const l of this.removeListeners) l({ id });
  }

  setActivePanelById(id: string): void {
    this.activePanelCalls.push(id);
  }

  toJSON(): SerializedLayout {
    this.toJSONCalls += 1;
    return makeLayout();
  }

  fromJSON(data: SerializedLayout, options?: { reuseExistingPanels: boolean }): void {
    this.fromJSONCalls.push({ data, options });
    this.panels = Object.keys(data.panels).map((id) => ({ id }));
  }

  onDidMovePanel(listener: MoveListener) {
    this.moveListeners.push(listener);
    return { dispose: () => {} };
  }
  onWillMutateLayout(listener: MutateListener) {
    this.willMutateListeners.push(listener);
    return { dispose: () => {} };
  }
  onDidMutateLayout(listener: MutateListener) {
    this.didMutateListeners.push(listener);
    return { dispose: () => {} };
  }
  onDidAddPanel(listener: PanelListener) {
    this.addListeners.push(listener);
    return { dispose: () => {} };
  }
  onDidRemovePanel(listener: PanelListener) {
    this.removeListeners.push(listener);
    return { dispose: () => {} };
  }
  onDidLayoutChange(listener: LayoutListener) {
    this.layoutListeners.push(listener);
    return { dispose: () => {} };
  }
  onDidLayoutFromJSON(listener: () => void) {
    this.layoutFromJSONListeners.push(listener);
    return { dispose: () => {} };
  }
  onDidActivePanelChange(listener: ActiveListener) {
    this.activeListeners.push(listener);
    return { dispose: () => {} };
  }

  // --- explicit event firing (mirrors Dockview's event sequence) ---
  fireWillMutate(kind: MutationKind): void {
    for (const l of this.willMutateListeners) l({ kind, origin: "user" });
  }
  fireDidMutate(kind: MutationKind): void {
    for (const l of this.didMutateListeners) l({ kind, origin: "user" });
  }
  fireMove(id: string): void {
    for (const l of this.moveListeners) l({ panel: { id } });
  }
  /** Remove from the registry AND fire onDidRemovePanel (Dockview's signal). */
  simulateRemove(id: string): void {
    this.panels = this.panels.filter((panel) => panel.id !== id);
    for (const l of this.removeListeners) l({ id });
  }
  /** Add to the registry AND fire onDidAddPanel. */
  simulateAdd(id: string): void {
    if (!this.getPanel(id)) this.panels.push({ id });
    for (const l of this.addListeners) l({ id });
  }
  /** Fire a remove signal WITHOUT removing the panel (intermediate move step). */
  fireRemoveSignalOnly(id: string): void {
    for (const l of this.removeListeners) l({ id });
  }
  fireLayoutChange(reasons: ReadonlySet<LayoutReasons>): void {
    for (const l of this.layoutListeners) l({ reasons });
  }
  fireLayoutFromJSON(): void {
    for (const l of this.layoutFromJSONListeners) l();
  }
}

interface Harness {
  api: FakeApi;
  controller: DockviewController;
  closed: string[];
  persisted: SerializedLayout[];
  flushMicrotasks(): void;
  flushTimers(): void;
}

function harness(opts: {
  openTabKeys: readonly string[];
  restore?: () => SerializedLayout | null;
  initialPanels?: string[];
}): Harness {
  const api = new FakeApi();
  api.panels = (opts.initialPanels ?? []).map((id) => ({ id }));
  const closed: string[] = [];
  const persisted: SerializedLayout[] = [];
  const microtasks: Array<() => void> = [];
  const timers: Array<(() => void) | null> = [];

  const controller = new DockviewController({
    api,
    openTabKeys: opts.openTabKeys,
    onPanelClose: (tabKey) => closed.push(tabKey),
    persist: (layout) => persisted.push(layout),
    restore: opts.restore ?? (() => null),
    scheduleMicrotask: (fn) => microtasks.push(fn),
    setTimeoutFn: (fn) => {
      timers.push(fn);
      return timers.length - 1;
    },
    clearTimeoutFn: (handle) => {
      timers[handle as number] = null;
    },
    debounceMs: 0,
  });
  controller.start();

  return {
    api,
    controller,
    closed,
    persisted,
    flushMicrotasks: () => {
      let guard = 0;
      while (microtasks.length > 0 && guard++ < 100) {
        const next = microtasks.shift();
        next?.();
      }
    },
    flushTimers: () => {
      const pending = timers.splice(0, timers.length);
      for (const fn of pending) fn?.();
    },
  };
}

describe("DockviewController — relocation is never a close", () => {
  it("move-then-remove/add sequence applies no close and disposes no runtime", () => {
    const h = harness({
      openTabKeys: ["chat:a", "chat:b"],
      initialPanels: ["chat:a", "chat:b"],
    });
    h.flushMicrotasks(); // initial reconcile: no diff
    h.api.addPanelCalls = [];
    h.api.removePanelCalls = [];

    // Dockview move: will-mutate(move) → movePanel → remove/add pair → did-mutate(move).
    h.api.fireWillMutate("move");
    h.api.fireMove("chat:a");
    h.api.simulateRemove("chat:a");
    h.api.simulateAdd("chat:a");
    h.api.fireDidMutate("move");
    h.flushMicrotasks();

    expect(h.closed).toEqual([]);
    expect(h.api.removePanelCalls).toEqual([]);
    expect(h.api.getPanel("chat:a")).toBeDefined();
  });

  it("retains the relocation marker until the move mutation settles", () => {
    const h = harness({
      openTabKeys: ["chat:a"],
      initialPanels: ["chat:a"],
    });
    h.flushMicrotasks();

    h.api.fireWillMutate("move");
    h.api.fireMove("chat:a");
    h.api.simulateRemove("chat:a");
    h.flushMicrotasks(); // still inside the mutation — no close may be applied
    expect(h.closed).toEqual([]);

    h.api.simulateAdd("chat:a");
    h.api.fireDidMutate("move");
    h.flushMicrotasks();
    expect(h.closed).toEqual([]);
    expect(h.api.removePanelCalls).toEqual([]);
  });
});

describe("DockviewController — definitive close detection", () => {
  it("applies close only after mutation settles and the panel is genuinely absent", () => {
    const h = harness({
      openTabKeys: ["chat:a", "chat:b"],
      initialPanels: ["chat:a", "chat:b"],
    });
    h.flushMicrotasks();

    h.api.fireWillMutate("remove");
    h.api.simulateRemove("chat:b");
    h.flushMicrotasks(); // mutation not settled yet
    expect(h.closed).toEqual([]);

    h.api.fireDidMutate("remove");
    h.flushMicrotasks();
    expect(h.closed).toEqual(["chat:b"]);
  });

  it("does not close when a remove event fires but the panel is still present", () => {
    const h = harness({
      openTabKeys: ["chat:a"],
      initialPanels: ["chat:a"],
    });
    h.flushMicrotasks();

    // A structural remove signal without actual removal (e.g. an intermediate
    // move step) must not be treated as a close.
    h.api.fireRemoveSignalOnly("chat:a");
    h.flushMicrotasks();
    expect(h.closed).toEqual([]);
  });

  it("does not re-add a genuinely closed panel during reconciliation", () => {
    const h = harness({
      openTabKeys: ["chat:a", "chat:b"],
      initialPanels: ["chat:a", "chat:b"],
    });
    h.flushMicrotasks();

    h.api.fireWillMutate("remove");
    h.api.simulateRemove("chat:b");
    h.api.fireDidMutate("remove");
    h.flushMicrotasks();
    expect(h.closed).toEqual(["chat:b"]);

    h.api.addPanelCalls = [];
    h.api.simulateAdd("chat:a"); // trigger another settled reconciliation
    h.flushMicrotasks();
    expect(h.api.addPanelCalls.map((c) => c.id)).not.toContain("chat:b");
  });
});

describe("DockviewController — restore guard", () => {
  it("suppresses persistence while fromJSON is applied, then allows it", () => {
    const saved = makeLayout();
    const h = harness({
      openTabKeys: ["chat:a"],
      restore: () => saved,
    });

    expect(h.api.fromJSONCalls).toHaveLength(1);
    expect(h.api.fromJSONCalls[0]?.options).toEqual({ reuseExistingPanels: true });

    // A layout change fired before the guard is cleared must not persist.
    h.api.fireLayoutChange(new Set(["structure"]));
    h.flushMicrotasks(); // clears the restore guard
    h.flushTimers();
    expect(h.persisted).toEqual([]);

    // After restore, a fresh layout change persists normally.
    h.api.fireLayoutChange(new Set(["structure"]));
    h.flushTimers();
    expect(h.persisted).toHaveLength(1);
  });

  it("clears the guard via the fallback even if onDidLayoutFromJSON never fires", () => {
    const h = harness({
      openTabKeys: ["chat:a"],
      restore: () => makeLayout(),
    });
    // Do NOT fire onDidLayoutFromJSON; the post-fromJSON microtask must clear it.
    h.flushMicrotasks();
    h.api.fireLayoutChange(new Set(["geometry"]));
    h.flushTimers();
    expect(h.persisted).toHaveLength(1);
  });
});

describe("DockviewController — reconciliation against canonical chatTabs", () => {
  it("adds missing canonical panels and removes stale ones with renderer always", () => {
    const h = harness({
      openTabKeys: ["chat:a", "agent:b"],
      initialPanels: ["chat:stale"],
    });
    h.flushMicrotasks();

    expect(h.api.addPanelCalls.map((c) => c.id).sort()).toEqual(["agent:b", "chat:a"]);
    expect(h.api.addPanelCalls.every((c) => c.renderer === "always")).toBe(true);
    expect(h.api.addPanelCalls.find((c) => c.id === "agent:b")?.params).toEqual({
      tabKey: "agent:b",
      contentType: "opencode",
    });
    expect(h.api.removePanelCalls).toEqual(["chat:stale"]);
  });

  it("reacts to setOpenTabKeys changes idempotently", () => {
    const h = harness({
      openTabKeys: ["chat:a", "chat:b"],
      initialPanels: ["chat:a", "chat:b"],
    });
    h.flushMicrotasks();
    h.api.addPanelCalls = [];
    h.api.removePanelCalls = [];

    h.controller.setOpenTabKeys(["chat:b"]);
    h.flushMicrotasks(); // setOpenTabKeys schedules its own settled work

    expect(h.api.removePanelCalls).toEqual(["chat:a"]);
    expect(h.api.addPanelCalls).toEqual([]);
  });

  it("opens a panel for a newly-added canonical key without any Dockview event", () => {
    // A conversation added to shared membership changes openTabKeys but fires
    // no Dockview event. The controller must reconcile on its own — otherwise
    // the second conversation never gets a panel (E2E: Expected 2, Received 1).
    const h = harness({ openTabKeys: ["chat:a"], initialPanels: ["chat:a"] });
    h.flushMicrotasks();
    h.api.addPanelCalls = [];

    h.controller.setOpenTabKeys(["chat:a", "chat:b"]);
    h.flushMicrotasks();

    expect(h.api.addPanelCalls.map((c) => c.id)).toEqual(["chat:b"]);
  });

  it("does not report a reconciliation removal as a user close (audit Major #1)", () => {
    // A conversation closed ELSEWHERE is dropped from the canonical set first.
    // reconcilePanels then removes its panel, which fires onDidRemovePanel. That
    // must NOT become a close/requestSharedClose for an already-closed conversation.
    const h = harness({
      openTabKeys: ["chat:a", "chat:b"],
      initialPanels: ["chat:a", "chat:b"],
    });
    h.flushMicrotasks();
    h.api.addPanelCalls = [];
    h.api.removePanelCalls = [];
    h.closed.length = 0;

    // chatTabs closed chat:a elsewhere -> canonical set no longer contains it.
    h.controller.setOpenTabKeys(["chat:b"]);
    h.api.simulateAdd("chat:b"); // trigger settled work (reconcile removes chat:a)
    h.flushMicrotasks();

    expect(h.api.removePanelCalls).toEqual(["chat:a"]); // panel removed
    expect(h.closed).toEqual([]); // but NO close semantics applied
  });

  it("includes drafts in the canonical panel set (single draft host)", () => {
    // Phase E: the `chat:new` panel hosts the single DraftChatHost, which owns
    // first-send materialization. The panel id stays stable across
    // materialization (DockviewWorkspace maps the materialized key back to it).
    const h = harness({
      openTabKeys: ["chat:new", "chat:a"],
      initialPanels: [],
    });
    h.flushMicrotasks();
    expect(h.api.addPanelCalls.map((c) => c.id)).toEqual(["chat:new", "chat:a"]);
  });
});

describe("DockviewController — imperative focus/open (Phase E route controller)", () => {
  it("focuses an already-open panel without adding a duplicate", () => {
    const h = harness({ openTabKeys: ["chat:a"], initialPanels: ["chat:a"] });
    h.flushMicrotasks();
    h.api.addPanelCalls = [];

    h.controller.focusOrOpen("chat:a");

    expect(h.api.activePanelCalls).toEqual(["chat:a"]);
    expect(h.api.addPanelCalls).toEqual([]);
  });

  it("opens a missing panel then focuses it (deep link / draft focus)", () => {
    const h = harness({ openTabKeys: [], initialPanels: [] });
    h.flushMicrotasks();

    h.controller.focusOrOpen("agent:deep");

    expect(h.api.addPanelCalls.map((c) => c.id)).toEqual(["agent:deep"]);
    expect(h.api.activePanelCalls).toEqual(["agent:deep"]);
  });

  it("ignores a non-canonical key", () => {
    const h = harness({ openTabKeys: [], initialPanels: [] });
    h.flushMicrotasks();

    h.controller.focusOrOpen("not-a-tab-key");

    expect(h.api.addPanelCalls).toEqual([]);
    expect(h.api.activePanelCalls).toEqual([]);
  });

  it("replacePanel re-creates a fresh host without applying close semantics", () => {
    const h = harness({ openTabKeys: ["chat:new"], initialPanels: ["chat:new"] });
    h.flushMicrotasks();
    h.api.addPanelCalls = [];

    h.controller.replacePanel("chat:new"); // fake fires onDidRemovePanel itself
    h.flushMicrotasks();

    // No conversation close, and reconciliation re-adds a fresh panel.
    expect(h.closed).toEqual([]);
    expect(h.api.addPanelCalls.map((c) => c.id)).toEqual(["chat:new"]);
  });
});
