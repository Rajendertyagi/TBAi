"use client";

/**
 * Production Dockview workspace (Phase 2 core).
 *
 * This is a thin React adapter: it hosts `DockviewReact`, adapts the real
 * `DockviewApi` to the controller's structural surface, and wires persistence
 * and canonical-close defaults. All event handling, relocation detection,
 * definitive close confirmation, reconciliation and persistence gating live in
 * `dockviewController.ts`, which is driven by behavioral tests with a fake API.
 *
 * Dockview owns spatial layout only. Canonical identity stays in `chatTabs`;
 * panel ids are canonical tab keys and params carry only `{ tabKey,
 * contentType }`. Not mounted in AppShell until Phase E.
 */
import { useCallback, useEffect, useMemo, useRef, type FunctionComponent } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DockviewReact,
  themeAbyss,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type DockviewOrigin,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";

import {
  DIRECT_COMPONENT,
  OPENCODE_COMPONENT,
  type PanelParams,
} from "../dockviewParams";
import { DockviewController, type DockviewControllerApi } from "../dockviewController";
import {
  DOCKVIEW_LAYOUT_PERSIST_DEBOUNCE_MS,
  loadLayout,
  saveLayout,
} from "../state/layoutPersistence";
import { DirectPanel } from "./DirectPanel";
import { OpenCodePanel } from "./OpenCodePanel";
import {
  NEW_DRAFT_TAB_ID,
  useChatTabsStore,
  visibleTabs,
} from "../../chat/state/chatTabs";
import { usePreferencesStore } from "../../preferences/state/preferencesStore";

const COMPONENTS: Record<string, FunctionComponent<IDockviewPanelProps<PanelParams>>> = {
  [DIRECT_COMPONENT]: DirectPanel,
  [OPENCODE_COMPONENT]: OpenCodePanel,
};

export interface DockviewWorkspaceProps {
  /**
   * Override the canonical open tab keys (tests/harnesses). When omitted they
   * are derived from chatTabs + shared membership. Drafts are excluded from
   * auto-registration: first-send materialization belongs to the Phase 5a
   * draft-aware host, not a generic Direct host.
   */
  openTabKeys?: readonly string[];
  /** Called only after a panel is confirmed genuinely closed. */
  onPanelClose?: (tabKey: string) => void;
  /** Focus/URL seam for Phase E; `origin` avoids feedback loops. */
  onActivePanelChange?: (tabKey: string | undefined, origin: DockviewOrigin) => void;
  /** localStorage key override (tests). */
  storageKey?: string;
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
  onPanelClose,
  onActivePanelChange,
  storageKey,
}: DockviewWorkspaceProps) {
  const controllerRef = useRef<DockviewController | null>(null);
  const canonicalKeys = useCanonicalOpenTabKeys();
  const openTabKeys = useMemo(
    () => openTabKeysProp ?? canonicalKeys,
    [openTabKeysProp, canonicalKeys],
  );

  // Latest values without re-creating the controller on every render.
  const openTabKeysRef = useRef(openTabKeys);
  openTabKeysRef.current = openTabKeys;
  const onPanelCloseRef = useRef(onPanelClose);
  onPanelCloseRef.current = onPanelClose;
  const onActivePanelChangeRef = useRef(onActivePanelChange);
  onActivePanelChangeRef.current = onActivePanelChange;
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const controller = new DockviewController({
      api: toControllerApi(event.api),
      openTabKeys: openTabKeysRef.current,
      onPanelClose: (tabKey) => {
        const handler = onPanelCloseRef.current;
        if (handler) handler(tabKey);
        else useChatTabsStore.getState().close(tabKey);
      },
      onActivePanelChange: (tabKey, origin) =>
        onActivePanelChangeRef.current?.(tabKey, origin),
      persist: (layout) => saveLayout(layout, storageKeyRef.current),
      restore: () => loadLayout(storageKeyRef.current, openTabKeysRef.current),
      debounceMs: DOCKVIEW_LAYOUT_PERSIST_DEBOUNCE_MS,
    });
    controllerRef.current = controller;
    controller.start();
  }, []);

  useEffect(() => {
    controllerRef.current?.setOpenTabKeys(openTabKeys);
  }, [openTabKeys]);

  useEffect(() => {
    return () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, []);

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden"
      data-testid="dockview-workspace"
    >
      <div className="min-h-0 min-w-0 flex-1">
        <DockviewReact theme={themeAbyss} components={COMPONENTS} onReady={onReady} />
      </div>
    </div>
  );
}

/** Derive canonical open tab keys from chatTabs + shared membership, minus drafts. */
function useCanonicalOpenTabKeys(): string[] {
  const tabState = useChatTabsStore(
    useShallow((s) => ({
      localActiveKey: s.localActiveKey,
      hasLocalDraft: s.hasLocalDraft,
      detachedRefs: s.detachedRefs,
    })),
  );
  const sharedTabs = usePreferencesStore((s) => s.snapshot?.sharedTabs);
  return useMemo(() => {
    const tabs = visibleTabs({ ...tabState, sharedTabs: sharedTabs ?? [] });
    return tabs
      .filter((tab) => tab.ref !== NEW_DRAFT_TAB_ID)
      .map((tab) => tab.key);
  }, [tabState, sharedTabs]);
}
