/**
 * Testable state machine for the Dockview workspace controller.
 *
 * All event handling, relocation detection, definitive close confirmation,
 * reconciliation and persistence gating live here behind a minimal structural
 * API surface, so the behavior can be driven with a fake DockviewApi in unit
 * tests. `DockviewWorkspace.tsx` is a thin React adapter that supplies the real
 * API, persistence functions and timers.
 *
 * Relocation uses TWO signals (plan §4b): `onDidMovePanel` marks the panel, and
 * a settled `onDidMutateLayout` with `kind:'move'` confirms the relocation. A
 * suspected close is only applied after the enclosing mutation settles AND the
 * panel is genuinely absent from `api.panels` / `api.getPanel(id)`.
 */
import type {
  SerializedDockview,
  LayoutChangeEvent,
  DockviewActivePanelChangeEvent,
  DockviewOrigin,
} from "dockview-react";
import {
  componentForContentType,
  contentTypeForTabKey,
  createPanelParams,
  type PanelParams,
} from "./dockviewParams";
import { desiredPanelKeys, diffPanelKeys } from "./panelRegistry";
import { parseTabKey } from "../chat/state/chatTabs";

/** Minimal panel identity the controller needs from a Dockview panel. */
export interface PanelRef {
  readonly id: string;
}

/** The subset of `addPanel` options the controller uses. */
export interface AddPanelOptionsLike {
  id: string;
  component: string;
  params: PanelParams;
  renderer: "always";
}

/** Coarse mutation kinds (mirrors Dockview's `DockviewLayoutMutationKind`). */
export type MutationKind =
  | "add"
  | "remove"
  | "move"
  | "float"
  | "popout"
  | "maximize"
  | "tab-group"
  | "load"
  | "clear";

/** A disposable event subscription. */
export interface Disposable {
  dispose(): void;
}

/**
 * Structural surface of `DockviewApi` used by the controller. The real API
 * satisfies it through the thin adapter in `DockviewWorkspace.tsx`; tests
 * implement it with a fake. `removePanelById` is an adapter seam so the heavy
 * `IDockviewPanel` type never leaks into this module.
 */
export interface DockviewControllerApi {
  readonly panels: readonly PanelRef[];
  getPanel(id: string): PanelRef | undefined;
  addPanel(options: AddPanelOptionsLike): unknown;
  removePanelById(id: string): void;
  /** Focus an existing panel programmatically (adapter calls `panel.api.setActive()`). */
  setActivePanelById(id: string): void;
  toJSON(): SerializedDockview;
  fromJSON(data: SerializedDockview, options?: { reuseExistingPanels: boolean }): void;
  onDidMovePanel(listener: (event: { panel: PanelRef }) => void): Disposable;
  onWillMutateLayout(
    listener: (event: { kind: MutationKind; origin: DockviewOrigin }) => void,
  ): Disposable;
  onDidMutateLayout(
    listener: (event: { kind: MutationKind; origin: DockviewOrigin }) => void,
  ): Disposable;
  onDidAddPanel(listener: (panel: PanelRef) => void): Disposable;
  onDidRemovePanel(listener: (panel: PanelRef) => void): Disposable;
  onDidLayoutChange(listener: (event: LayoutChangeEvent) => void): Disposable;
  onDidLayoutFromJSON(listener: () => void): Disposable;
  onDidActivePanelChange(listener: (event: DockviewActivePanelChangeEvent) => void): Disposable;
}

export interface DockviewControllerDeps {
  api: DockviewControllerApi;
  openTabKeys: readonly string[];
  onPanelClose?: (tabKey: string) => void;
  onActivePanelChange?: (tabKey: string | undefined, origin: DockviewOrigin) => void;
  /** Persist a serialized layout (debounced by the controller). */
  persist: (layout: SerializedDockview) => void;
  /** Return a saved layout to restore, or null for a safe default. */
  restore: () => SerializedDockview | null;
  /** Injectable microtask scheduler (defaults to `queueMicrotask`). */
  scheduleMicrotask?: (fn: () => void) => void;
  /** Injectable timer (defaults to global `setTimeout`). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  /** Injectable timer cancel (defaults to global `clearTimeout`). */
  clearTimeoutFn?: (handle: unknown) => void;
  /** Persist debounce window (defaults to the shared constant). */
  debounceMs?: number;
}

/** Reasons serialized by `toJSON()` and therefore worth persisting. */
const PERSIST_REASONS = [
  "geometry",
  "structure",
  "activePanel",
  "panelTitle",
  "panelParameters",
] as const;

/**
 * Canonical panel keys are the valid tab keys as-is. Drafts (`chat:new`) are
 * included: in Phase E the single draft panel hosts `DraftChatHost`, which owns
 * first-send materialization. The panel id stays stable across materialization
 * (Dockview ids are immutable); `DockviewWorkspace` maps the materialized key
 * back to `chat:new` so the live runtime is never disposed mid-send.
 */
function canonicalPanelKeys(tabKeys: readonly string[]): string[] {
  return desiredPanelKeys(tabKeys);
}

/** Drive the Dockview event state machine independently of React. */
export class DockviewController {
  private readonly api: DockviewControllerApi;
  private readonly deps: DockviewControllerDeps;
  private readonly microtask: (fn: () => void) => void;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly debounceMs: number;
  private readonly disposables: Disposable[] = [];

  private openTabKeys: string[];
  private restoreGuard = false;
  private mutationDepth = 0;
  /** Signal 1: panels reported moved by `onDidMovePanel`. */
  private pendingMoveIds = new Set<string>();
  /** Signal 2: confirmed by a settled `onDidMutateLayout(kind:'move')`. */
  private confirmedRelocations = new Set<string>();
  private suspectedCloses = new Set<string>();
  private closedByUser = new Set<string>();
  private persistHandle: unknown = null;
  private disposed = false;

  /** Create a controller with injected API, persistence and scheduling seams. */
  constructor(deps: DockviewControllerDeps) {
    this.deps = deps;
    this.api = deps.api;
    this.openTabKeys = canonicalPanelKeys(deps.openTabKeys);
    this.microtask = deps.scheduleMicrotask ?? ((fn) => queueMicrotask(fn));
    this.setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn =
      deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.debounceMs = deps.debounceMs ?? 250;
  }

  /** Subscribe to Dockview events and restore (or build) the initial layout. */
  start(): void {
    this.disposables.push(
      this.api.onDidMovePanel((event) => this.onDidMovePanel(event)),
      this.api.onWillMutateLayout((event) => this.onWillMutateLayout(event)),
      this.api.onDidMutateLayout((event) => this.onDidMutateLayout(event)),
      this.api.onDidAddPanel(() => this.scheduleSettledWork()),
      this.api.onDidRemovePanel((panel) => this.onDidRemovePanel(panel)),
      this.api.onDidLayoutChange((event) => this.onDidLayoutChange(event)),
      this.api.onDidLayoutFromJSON(() => this.onDidLayoutFromJSON()),
      this.api.onDidActivePanelChange((event) => this.onDidActivePanelChange(event)),
    );

    this.restoreGuard = true;
    const saved = this.deps.restore();
    let applied = false;
    if (saved) {
      try {
        this.api.fromJSON(saved, { reuseExistingPanels: true });
        applied = true;
      } catch {
        applied = false;
      }
    }
    if (applied) {
      // Fallback: `onDidLayoutFromJSON` normally clears the guard, but clear it
      // here too in case the event is not emitted by a given version/implementation.
      this.microtask(() => this.clearRestoreGuardAndSettle());
    } else {
      for (const tabKey of this.openTabKeys) {
        if (!this.api.getPanel(tabKey)) this.addPanelForTabKey(tabKey);
      }
      this.restoreGuard = false;
      this.microtask(() => this.runSettledWork());
    }
  }

  /** Update canonical open tab keys (called when chatTabs changes). */
  setOpenTabKeys(tabKeys: readonly string[]): void {
    this.openTabKeys = canonicalPanelKeys(tabKeys);
    const desired = new Set(this.openTabKeys);
    for (const id of [...this.closedByUser]) {
      if (!desired.has(id)) this.closedByUser.delete(id);
    }
    // A canonical-key change (e.g. a conversation added to shared membership)
    // must reconcile the panel set. No Dockview event fires for a store change,
    // so without this the newly-open conversation never gets a panel.
    this.scheduleSettledWork();
  }

  /**
   * Remove a panel and let reconciliation immediately re-create a FRESH host
   * under the same id. Used when a new draft replaces a materialized one: the
   * panel id (`chat:new`) is stable but the runtime must be new. Close
   * semantics are explicitly suppressed — this is a replacement, not a close.
   */
  replacePanel(panelId: string): void {
    if (this.disposed || !this.api.getPanel(panelId)) return;
    // Mark as a relocation so the suspected-close path skips it; reconcile
    // then re-adds it because the id is still in the canonical open set.
    this.confirmedRelocations.add(panelId);
    this.api.removePanelById(panelId);
  }

  /**
   * Focus the panel for `panelId`, opening it first when absent. Used by the
   * Phase E route/focus controller to converge `localActiveKey` with Dockview.
   * The panel id is already canonical (draft aliasing is resolved by the
   * caller), so no identity translation happens here.
   */
  focusOrOpen(panelId: string): void {
    if (this.disposed || !parseTabKey(panelId)) return;
    if (!this.api.getPanel(panelId)) this.addPanelForTabKey(panelId);
    const panel = this.api.getPanel(panelId);
    if (panel) this.api.setActivePanelById(panelId);
  }

  /** Unsubscribe and cancel pending work. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    if (this.persistHandle !== null) {
      this.clearTimeoutFn(this.persistHandle);
      this.persistHandle = null;
    }
  }

  private addPanelForTabKey(tabKey: string): void {
    const contentType = contentTypeForTabKey(tabKey);
    if (!contentType) return;
    const params = createPanelParams(tabKey);
    if (!params) return;
    this.api.addPanel({
      id: tabKey,
      component: componentForContentType(contentType),
      params,
      renderer: "always",
    });
  }

  private reconcilePanels(): void {
    if (this.restoreGuard) return;
    const current = this.api.panels.map((panel) => panel.id);
    const { toAdd, toRemove } = diffPanelKeys(current, this.openTabKeys);

    for (const id of toRemove) {
      if (this.confirmedRelocations.has(id)) continue;
      this.api.removePanelById(id);
    }
    for (const id of toAdd) {
      if (this.closedByUser.has(id)) continue;
      if (this.api.getPanel(id)) continue;
      this.addPanelForTabKey(id);
    }
  }

  private confirmSuspectedCloses(): void {
    if (this.mutationDepth > 0 || this.suspectedCloses.size === 0) return;
    const present = new Set(this.api.panels.map((panel) => panel.id));
    for (const id of this.suspectedCloses) {
      // A confirmed relocation is never a close, and a panel still in the
      // registry is not a close — even if add/remove fired during a move.
      if (this.confirmedRelocations.has(id)) continue;
      if (present.has(id) || this.api.getPanel(id)) continue;
      if (!parseTabKey(id)) continue;

      // A panel removed by reconciliation because the conversation was closed
      // ELSEWHERE is not a user close. `setOpenTabKeys` already dropped it from
      // the canonical set before reconcilePanels removed it, so applying close
      // semantics here would redundantly close/requestSharedClose an already
      // closed conversation (plan §5b "Conversation closed elsewhere"). Clear
      // the suspicion only; the canonical store is already authoritative.
      if (!this.openTabKeys.includes(id)) continue;

      this.closedByUser.add(id);
      this.deps.onPanelClose?.(id);
    }
    this.suspectedCloses.clear();
  }

  private runSettledWork(): void {
    if (this.disposed || this.mutationDepth > 0) return;
    this.confirmSuspectedCloses();
    this.reconcilePanels();
    // Markers are valid only for the mutation that produced them.
    this.confirmedRelocations.clear();
    this.pendingMoveIds.clear();
  }

  private scheduleSettledWork(): void {
    this.microtask(() => this.runSettledWork());
  }

  private onDidMovePanel(event: { panel: PanelRef }): void {
    // Signal 1 only. Promotion to a confirmed relocation requires the settled
    // `onDidMutateLayout(kind:'move')` signal below.
    this.pendingMoveIds.add(event.panel.id);
    this.scheduleSettledWork();
  }

  private onWillMutateLayout(_event: { kind: MutationKind; origin: DockviewOrigin }): void {
    this.mutationDepth += 1;
  }

  private onDidMutateLayout(event: { kind: MutationKind; origin: DockviewOrigin }): void {
    this.mutationDepth = Math.max(0, this.mutationDepth - 1);
    if (event.kind === "move") {
      // Signal 2: the enclosing mutation was a move. Promote every panel
      // marked by onDidMovePanel into a confirmed relocation; these markers
      // survive until the mutation settles and settled work runs.
      for (const id of this.pendingMoveIds) this.confirmedRelocations.add(id);
      this.pendingMoveIds.clear();
    }
    this.scheduleSettledWork();
  }

  private onDidRemovePanel(panel: PanelRef): void {
    // Suspect a close, but never act here. Confirmation is deferred until the
    // mutation settles and genuine absence is verified.
    this.suspectedCloses.add(panel.id);
    this.scheduleSettledWork();
  }

  private onDidLayoutChange(event: LayoutChangeEvent): void {
    if (this.restoreGuard) return;
    const relevant = PERSIST_REASONS.some((reason) => event.reasons.has(reason));
    if (!relevant) return;
    this.schedulePersist();
  }

  private onDidLayoutFromJSON(): void {
    this.microtask(() => this.clearRestoreGuardAndSettle());
  }

  private clearRestoreGuardAndSettle(): void {
    this.restoreGuard = false;
    this.runSettledWork();
  }

  private onDidActivePanelChange(event: DockviewActivePanelChangeEvent): void {
    this.deps.onActivePanelChange?.(event.panel?.id, event.origin);
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.persistHandle !== null) this.clearTimeoutFn(this.persistHandle);
    this.persistHandle = this.setTimeoutFn(() => {
      this.persistHandle = null;
      if (this.disposed || this.restoreGuard) return;
      this.deps.persist(this.api.toJSON());
    }, this.debounceMs);
  }
}
