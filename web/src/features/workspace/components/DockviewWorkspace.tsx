"use client";

/**
 * Production Dockview workspace (Phase 2 core + Phase E application integration).
 *
 * This is a thin React adapter: it hosts `DockviewReact`, adapts the real
 * `DockviewApi` to the controller's structural surface, and wires persistence
 * and canonical-close defaults. All event handling, relocation detection,
 * definitive close confirmation, reconciliation and persistence gating live in
 * `dockviewController.ts`, which is driven by behavioral tests with a fake API.
 *
 * Dockview owns spatial layout only. Canonical identity stays in `chatTabs`;
 * panel ids are canonical tab keys and params carry only `{ tabKey,
 * contentType }`. In Phase E this component is mounted once at AppShell level
 * as the persistent chat surface and exposes an imperative focus handle so the
 * single route/focus controller can converge `localActiveKey` with Dockview.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type FunctionComponent,
  type MutableRefObject,
} from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type DockviewOrigin,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";

import { tbaiTheme } from "../dockviewTheme";

import { DIRECT_COMPONENT, OPENCODE_COMPONENT, type PanelParams } from "../dockviewParams";
import { DockviewController, type DockviewControllerApi } from "../dockviewController";
import {
  DOCKVIEW_LAYOUT_PERSIST_DEBOUNCE_MS,
  loadLayout,
  saveLayout,
} from "../state/layoutPersistence";
import { DirectPanel } from "./DirectPanel";
import { OpenCodePanel } from "./OpenCodePanel";
import { createDraftAlias, DRAFT_PANEL_ID, type DraftAlias } from "../draftAlias";
import {
  NEW_DRAFT_TAB_ID,
  parseTabKey,
  useChatTabsStore,
  visibleTabs,
} from "../../chat/state/chatTabs";
import { activateHistoryConversation } from "../../chat/history/useDirectHistoryWindow";
import { activateWorkspacePanel, registerPanelCanonicalKey } from "../state/workspaceActivation";
import { usePreferencesStore } from "../../preferences/state/preferencesStore";

const COMPONENTS: Record<string, FunctionComponent<IDockviewPanelProps<PanelParams>>> = {
  [DIRECT_COMPONENT]: DirectPanel,
  [OPENCODE_COMPONENT]: OpenCodePanel,
};

/** Imperative focus handle populated on `handleRef` once the API is ready. */
export interface DockviewWorkspaceHandle {
  /** Focus the panel for a canonical tab key, opening it when absent. */
  focusOrOpen(tabKey: string): void;
}

export interface DockviewWorkspaceProps {
  /**
   * Override the canonical open tab keys (tests/harnesses). When omitted they
   * are derived from chatTabs + shared membership. Drafts are included: the
   * single `chat:new` panel hosts `DraftChatHost`, which owns first-send
   * materialization.
   */
  openTabKeys?: readonly string[];
  /** Window-level active tab key (URL-authoritative). Drives the draft alias. */
  activeTabKey?: string;
  /** Called only after a panel is confirmed genuinely closed. */
  onPanelClose?: (tabKey: string) => void;
  /** Focus/URL seam for Phase E; `origin` avoids feedback loops. */
  onActivePanelChange?: (tabKey: string | undefined, origin: DockviewOrigin) => void;
  /** localStorage key override (tests). */
  storageKey?: string;
  /** Receives the imperative focus handle once the Dockview API is ready. */
  handleRef?: MutableRefObject<DockviewWorkspaceHandle | null>;
  /**
   * Fired once the imperative handle is populated. The focus controller uses
   * this to re-drive focus for a deep link whose `localActiveKey` was set
   * before Dockview became ready (otherwise the one-shot effect skips focus).
   */
  onHandleReady?: () => void;
}

/** Adapt the real `DockviewApi` to the controller's minimal structural surface. */
function toControllerApi(api: DockviewApi): DockviewControllerApi {
  return {
    get panels() {
      return api.panels;
    },
    getPanel: (id) => api.getPanel(id),
    addPanel: (options) => api.addPanel(options),
    removePanelById: (id) => {
      const panel = api.getPanel(id);
      if (panel) api.removePanel(panel);
    },
    setActivePanelById: (id) => {
      const panel = api.getPanel(id);
      // `panel.api.setActive()` fires onDidActivePanelChange with origin 'api',
      // which the focus controller ignores — no URL/focus feedback loop.
      if (panel) panel.api.setActive();
    },
    toJSON: () => api.toJSON(),
    fromJSON: (data, options) => api.fromJSON(data, options),
    onDidMovePanel: (listener) => api.onDidMovePanel(listener),
    onWillMutateLayout: (listener) => api.onWillMutateLayout(listener),
    onDidMutateLayout: (listener) => api.onDidMutateLayout(listener),
    onDidAddPanel: (listener) => api.onDidAddPanel(listener),
    onDidRemovePanel: (listener) => api.onDidRemovePanel(listener),
    onDidLayoutChange: (listener) => api.onDidLayoutChange(listener),
    onDidLayoutFromJSON: (listener) => api.onDidLayoutFromJSON(listener),
    onDidActivePanelChange: (listener) => api.onDidActivePanelChange(listener),
  };
}

/** Host the production Dockview workspace with registered chat panels. */
export function DockviewWorkspace({
  openTabKeys: openTabKeysProp,
  activeTabKey,
  onPanelClose,
  onActivePanelChange,
  storageKey,
  handleRef,
  onHandleReady,
}: DockviewWorkspaceProps) {
  const controllerRef = useRef<DockviewController | null>(null);
  const canonicalKeys = useCanonicalOpenTabKeys();

  // Draft materialization keeps the SAME panel (and therefore the same live
  // runtime) across first send. The alias state machine maps the materialized
  // `chat:<id>` back to the stable `chat:new` panel id. `observeActiveKey` is
  // idempotent under StrictMode double-render.
  const aliasRef = useRef<DraftAlias | null>(null);
  if (!aliasRef.current) aliasRef.current = createDraftAlias();
  const alias = aliasRef.current;
  alias.observeActiveKey(activeTabKey);

  const panelIdFor = useCallback((key: string) => alias.panelIdFor(key), [alias]);
  const canonicalKeyFor = useCallback((panelId: string) => alias.canonicalKeyFor(panelId), [alias]);

  const openTabKeys = useMemo(() => {
    const keys = openTabKeysProp ?? canonicalKeys;
    return keys.map(panelIdFor);
  }, [openTabKeysProp, canonicalKeys, panelIdFor]);

  // Latest values without re-creating the controller on every render.
  const openTabKeysRef = useRef(openTabKeys);
  openTabKeysRef.current = openTabKeys;
  const onPanelCloseRef = useRef(onPanelClose);
  onPanelCloseRef.current = onPanelClose;
  const onActivePanelChangeRef = useRef(onActivePanelChange);
  onActivePanelChangeRef.current = onActivePanelChange;
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;
  const activeTabKeyRef = useRef(activeTabKey);
  activeTabKeyRef.current = activeTabKey;

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const controller = new DockviewController({
        api: toControllerApi(event.api),
        openTabKeys: openTabKeysRef.current,
        onPanelClose: (panelId) => {
          // M1: canonicalize before applying close semantics. After first-send
          // materialization the live panel id is still `chat:new`, but the
          // canonical conversation is `chat:<id>`. Closing the aliased panel
          // must take the shared-close path for that conversation, not merely
          // clear draft-local state.
          const canonicalKey = canonicalKeyFor(panelId);
          if (panelId === DRAFT_PANEL_ID && alias.materializedKey) {
            // A genuine close ends the materialization identity. Drop the alias
            // so a later fresh draft cannot inherit a stale canonical key.
            alias.clear();
          }
          const handler = onPanelCloseRef.current;
          if (handler) handler(canonicalKey);
          else useChatTabsStore.getState().close(canonicalKey);
        },
        onActivePanelChange: (panelId, origin) => {
          const canonicalKey = canonicalKeyFor(panelId ?? "");
          // A conversation becoming the active Dockview panel is a genuine new
          // user visit for history recovery — including API-driven focus from
          // route navigation and Chat Threads, not just user tab clicks. This
          // is activation, NOT visibility: split layouts keep several panels
          // visible, but only the activated one is a visit. Repeated focus of
          // the already-active conversation is a no-op in the activation store.
          const parsed = parseTabKey(canonicalKey);
          // Direct history recovery stays chat-only and unchanged. Workspace
          // runtime activation is a separate contract and covers BOTH engines;
          // the helper itself ignores the draft tab and malformed keys.
          if (parsed?.kind === "chat" && parsed.ref !== NEW_DRAFT_TAB_ID) {
            activateHistoryConversation(parsed.ref);
          }
          // Remember the panel-id -> canonical-key mapping so a materialized
          // draft's unmount disposes `chat:<id>`, not the immutable `chat:new`.
          registerPanelCanonicalKey(panelId ?? "", canonicalKey);
          // Only intentional focus starts a runtime. A user click is always
          // intentional; programmatic focus is intentional only when it matches
          // the window-level active key (deep link / route / Chat Threads).
          // dockview-core makes every added panel active with origin 'api', so
          // transient activations during startup/reconciliation carry a
          // non-intended key here and must stay dormant. The activeTabKey effect
          // below is the safety net for an already-active intended panel.
          if (origin === "user" || canonicalKey === activeTabKeyRef.current) {
            activateWorkspacePanel(canonicalKey);
          }
          onActivePanelChangeRef.current?.(canonicalKey, origin);
        },
        persist: (layout) => saveLayout(layout, storageKeyRef.current),
        restore: () => loadLayout(storageKeyRef.current, openTabKeysRef.current),
        debounceMs: DOCKVIEW_LAYOUT_PERSIST_DEBOUNCE_MS,
      });
      controllerRef.current = controller;
      if (handleRef) {
        handleRef.current = { focusOrOpen: (tabKey) => controller.focusOrOpen(panelIdFor(tabKey)) };
      }
      // Notify the focus controller that the handle is now usable so a deep
      // link set before onReady can be re-driven (the one-shot effect may have
      // run while handleRef.current was still null).
      onHandleReady?.();
      controller.start();
      // A deep link may have set localActiveKey before the Dockview API existed.
      // Converge the initially restored/created layout onto that selection.
      const initial = activeTabKeyRef.current;
      if (initial) controller.focusOrOpen(panelIdFor(initial));
    },
    [canonicalKeyFor, panelIdFor, handleRef, alias, onHandleReady],
  );

  // Activate the window-level selected panel on initial restore, deep-link
  // convergence and route navigation. `onActivePanelChange` above covers user
  // clicks and API focus, but can miss a selection whose panel is already active
  // (no Dockview event) — notably first-send draft materialization, where the
  // `chat:new` panel stays active while the canonical key becomes `chat:<id>`.
  // Register the mapping here too so that transition's later disposal resolves
  // the materialized key. Repeated activation of a started panel is a no-op.
  useEffect(() => {
    if (!activeTabKey) return;
    registerPanelCanonicalKey(panelIdFor(activeTabKey), activeTabKey);
    activateWorkspacePanel(activeTabKey);
  }, [activeTabKey, panelIdFor]);

  useEffect(() => {
    controllerRef.current?.setOpenTabKeys(openTabKeys);
    // Reconciliation adds panels in a microtask; Dockview makes the last added
    // panel active. Re-assert the canonical active key AFTER that settles so a
    // deep link to A is not overridden by a shared tab B added afterwards.
    if (activeTabKey) {
      const key = activeTabKey;
      queueMicrotask(() => {
        queueMicrotask(() => controllerRef.current?.focusOrOpen(panelIdFor(key)));
      });
    }
  }, [openTabKeys, activeTabKey, panelIdFor]);

  // A fresh draft opened after the previous one materialized must get a NEW
  // runtime. The `chat:new` panel id is stable, so replace the existing host
  // (close semantics suppressed) and let reconciliation mount a fresh one.
  // This is the ONLY transition that calls replacePanel — materialization
  // itself keeps the panel (and its runtime) mounted.
  useEffect(() => {
    if (activeTabKey === DRAFT_PANEL_ID && alias.materializedKey) {
      alias.clear();
      controllerRef.current?.replacePanel(DRAFT_PANEL_ID);
    }
  }, [activeTabKey, alias]);

  useEffect(() => {
    return () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      if (handleRef) handleRef.current = null;
    };
  }, [handleRef]);

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden"
      data-testid="dockview-workspace"
    >
      <div className="min-h-0 min-w-0 flex-1">
        <DockviewReact theme={tbaiTheme} components={COMPONENTS} onReady={onReady} />
      </div>
    </div>
  );
}

/** Derive canonical open tab keys from chatTabs + shared membership (drafts included). */
function useCanonicalOpenTabKeys(): string[] {
  const tabState = useChatTabsStore(
    useShallow((s) => ({
      localActiveKey: s.localActiveKey,
      hasLocalDraft: s.hasLocalDraft,
      detachedRefs: s.detachedRefs,
    })),
  );
  const sharedTabs = usePreferencesStore((s) => s.snapshot?.sharedTabs);
  return useMemo(
    () => visibleTabs({ ...tabState, sharedTabs: sharedTabs ?? [] }).map((t) => t.key),
    [tabState, sharedTabs],
  );
}
