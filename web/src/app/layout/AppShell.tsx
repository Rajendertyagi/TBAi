import { useCallback, useEffect, useMemo } from "react";
import { Outlet } from "react-router";
import { PanelRightOpen } from "lucide-react";
import {
  AssistantRuntimeProvider,
  AuiConfig,
  Tools,
  Suggestions,
  makeAssistantDataUI,
} from "@assistant-ui/react";
import { useShallow } from "zustand/react/shallow";
import { usePreferencesStore } from "../../features/preferences/state/preferencesStore";
import { usePreferencesSync } from "../../features/preferences/state/usePreferencesSync";
import { Sidebar } from "../../components/Sidebar";
import { StatusBar } from "../../components/StatusBar";
import { ActivityBar } from "../../components/ActivityBar";
import { TabStrip } from "../../components/TabStrip";
import { LeftEdgeChrome } from "../../components/LeftEdgeChrome";
import { CommandPalette } from "../../components/CommandPalette";
import { RightEdgeChrome } from "../../components/RightEdgeChrome";
import { WindowControls } from "../../components/WindowControls";
import { ChromeShortcuts } from "../../components/ChromeShortcuts";
import { ZoomController } from "../../components/ZoomController";
import { PageContextMenu } from "../../components/PageContextMenu";
import { TabUrlSync } from "../TabUrlSync";
import { RouteObserver } from "../RouteObserver";
import { isTauri } from "../../lib/platform";
import { syncChromeVars } from "../../lib/chrome-vars";
import { chatColumnWidth } from "../../config/chat";
import { useDesktopLayout } from "../../features/desktop/state/desktopLayout";
import { useAvailabilityStore } from "../../features/availability/availabilityStore";
import { registerAvailabilityRecovery } from "../../features/availability/recovery";
import { registerTabReconciliation } from "../../features/chat/state/tabReconciliation";
import { useDraftPickLifecycle } from "../../features/chat/state/useDraftPickLifecycle";
import { useAppChatRuntime } from "../../runtime";
import { threadListAdapter } from "../adapter";
import { useSettingsStore } from "@/features/providers/state/providersStore";
import {
  NEW_DRAFT_TAB_ID,
  activeTab,
  parseTabKey,
  useChatTabsStore,
  visibleTabs,
} from "../../features/chat/state/chatTabs";
import { getWelcomeEngineSnapshot } from "../../features/chat/state/welcomeEngine";
import { peekMaterializedEngine } from "../../features/chat/state/materializeDraft";
import { appToolkit } from "../../tools/toolkit";
import { ProgressStages } from "../../components/assistant-ui/elements/progress-stages";
import { CompactionDivider } from "../../components/assistant-ui/elements/compaction-divider";
import { DIRECT_COMPACT_DATA_NAME } from "../../features/chat/compactCommand";
import { logger } from "../../lib/logger";
import { WorkspaceSurface } from "../../features/workspace/components/WorkspaceSurface";
import { useWorkspacePanels } from "../../features/workspace/state/workspacePanels";

const TbaiProgressDataUI = makeAssistantDataUI({
  name: "tbai-progress",
  render: ProgressStages,
});

const TbaiCompactDataUI = makeAssistantDataUI({
  name: DIRECT_COMPACT_DATA_NAME,
  render: CompactionDivider,
});

/**
 * Single application shell for BOTH the browser and the Windows desktop.
 * There is no `if (desktop) … else …` layout fork: the same tree renders
 * everywhere, and only Tauri-only leaves self-gate via `isTauri()` (the
 * frameless caption buttons and the drag-region reserves). This mirrors
 * codeg's `FolderLayoutShell`: the chat tabs live in the title band at the
 * top of the content area, the sidebar-toggle / status / settings live in
 * fixed corner overlays, and the native-style caption buttons float as a
 * top-right overlay that is simply absent in the browser.
 *
 * AppShell hosts the root AssistantRuntimeProvider using the canonical
 * `threadListAdapter` singleton so the Sidebar (ThreadRunningDot, lastMessageAt)
 * and Chat share the official assistant-ui thread state without duplicate stores.
 * Code mode isolates via CodeShell and OpenCodeIsolationBoundary (<AuiProvider extends={null}>).
 *
 * Chrome geometry (sidebar width, overlay reserves, band heights) is published
 * as CSS variables by `syncChromeVars` and consumed via `var(--…)` classes —
 * components never carry inline `style=` reserves.
 *
 * The shell only *composes* chrome. Feature menus (e.g. the page-level context
 * menu) live in their own chrome components so this file stays a thin layout.
 */
export function AppShell() {
  // Draft one-shot picks are scoped to the unsent draft by a single store
  // subscription, so every navigation path (strip, keyboard, sidebar, history)
  // discards them on leave. See useDraftPickLifecycle.
  useDraftPickLifecycle();

  const sidebarVisible = useDesktopLayout((s) => s.sidebarVisible);
  const statusBarVisible = useDesktopLayout((s) => s.statusBarVisible);
  const sidebarWidth = useDesktopLayout((s) => s.sidebarWidth);
  const chatWidth = useDesktopLayout((s) => s.chatWidth);
  const searchOpen = useDesktopLayout((s) => s.searchOpen);

  const tabState = useChatTabsStore(
    useShallow((s) => ({
      localActiveKey: s.localActiveKey,
      hasLocalDraft: s.hasLocalDraft,
      detachedRefs: s.detachedRefs,
    })),
  );
  const sharedTabs = usePreferencesStore((s) => s.snapshot?.sharedTabs);
  const active = useMemo(() => {
    const tabs = visibleTabs({ ...tabState, sharedTabs: sharedTabs ?? [] });
    if (!tabState.localActiveKey) return tabs[0];
    return tabs.find((t) => t.key === tabState.localActiveKey) ?? tabs[0];
  }, [tabState, sharedTabs]);
  const runtimeThreadId =
    active?.kind === "chat" && active.ref !== NEW_DRAFT_TAB_ID ? active.ref : undefined;

  const handleThreadIdChange = useCallback((id: string | undefined) => {
    if (!id) return;
    const state = useChatTabsStore.getState();
    const current = activeTab(state);
    logger.info("app", "runtime.bind", { threadId: id });
    if (current?.kind === "chat" && current.ref === NEW_DRAFT_TAB_ID) {
      state.resolveDraftId(id, peekMaterializedEngine(id) ?? getWelcomeEngineSnapshot().engine);
    } else {
      // Presentation-only runtime binding; never mutates shared membership.
      state.presentChat(id);
    }
  }, []);

  const runtime = useAppChatRuntime(threadListAdapter, runtimeThreadId, handleThreadIdChange);

  // Open a DIFFERENT bound chat in an optional workspace panel. The panel owns
  // its own runtime host; the Primary Chat (Outlet) keeps the canonical shared
  // runtime the Sidebar reads from. We deliberately never panel the tab currently
  // bound to the primary runtime — that would create two live runtimes for the
  // same threadId. A draft is excluded too: materializing it must run through the
  // primary runtime's tab-store binding (resolveDraftId), which a panel host does
  // not own. Code content keeps its dedicated OpenCode surface/runtime.
  const openPanels = useWorkspacePanels(useShallow((s) => s.panels));
  const panelCandidate = useMemo(() => {
    const tabs = visibleTabs({ ...tabState, sharedTabs: sharedTabs ?? [] });
    const opened = new Set(openPanels.map((p) => p.tabKey));
    return tabs.find(
      (t) =>
        t.kind === "chat" &&
        t.ref !== NEW_DRAFT_TAB_ID &&
        t.key !== active?.key &&
        !opened.has(t.key),
    );
  }, [tabState, sharedTabs, active?.key, openPanels]);
  const openChatInPanel = useCallback(() => {
    if (!panelCandidate) return;
    useWorkspacePanels.getState().openPanel(panelCandidate.key);
  }, [panelCandidate]);

  const { loadProviders } = useSettingsStore();
  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  const config = useMemo(
    () =>
      AuiConfig({
        tools: Tools({ toolkit: appToolkit }),
        suggestions: Suggestions([
          "What can you help me with?",
          "Explain a concept",
          "Help me write code",
        ]),
      }),
    [],
  );

  // The frameless Windows caption strip exists only in the Tauri desktop;
  // the browser reserves just the button cluster.
  const captionStrip = isTauri();

  // Publish chrome geometry as CSS variables (single source of truth = the
  // token layer in `lib/window-chrome.ts` / `config/chat.ts` via
  // `syncChromeVars`).
  useEffect(() => {
    syncChromeVars({
      sidebarWidth,
      chatColumnWidth: chatColumnWidth(chatWidth),
      searchOpen,
      captionStrip,
    });
  }, [sidebarWidth, chatWidth, searchOpen, captionStrip]);

  // Global backend availability (Phase 3): exactly one readiness poller for
  // the whole app lifetime, plus the single coordinated recovery listener.
  // Both are idempotent singletons; StrictMode remounts cannot duplicate them.
  // The persisted tab mirror is reconciled here too, because boot is the one
  // moment the client owns the complete reference set and can settle it in a
  // single batch request; its retry rides the same recovery sequence.
  useEffect(() => {
    const unregister = registerAvailabilityRecovery();
    const unregisterTabs = registerTabReconciliation();
    useAvailabilityStore.getState().start();
    return () => {
      unregister();
      unregisterTabs();
      useAvailabilityStore.getState().stop();
    };
  }, []);

  // Authoritative shared workspace preferences (tabs/membership + portable prefs).
  useEffect(() => {
    usePreferencesStore.getState().start();
    return () => usePreferencesStore.getState().stop();
  }, []);

  // Single coordinated sync owner (authoritative snapshot apply + loop suppression).
  usePreferencesSync();

  // Remote shared-membership changes: if the local active conversation was
  // removed from shared tabs by another window, mark it detached locally.
  // Never navigate, never interrupt composer/runtime/focus/IME.
  useEffect(() => {
    const localActiveKey = tabState.localActiveKey;
    if (!sharedTabs || !localActiveKey) return;
    const parsed = parseTabKey(localActiveKey);
    if (!parsed || parsed.ref === "new") return;
    const isMember = sharedTabs.some((t) => t.ref === parsed.ref);
    const tabs = useChatTabsStore.getState();
    if (!isMember) tabs.markDetached(parsed.ref);
    else tabs.clearDetached(parsed.ref);
  }, [sharedTabs, tabState.localActiveKey]);

  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <TbaiProgressDataUI />
      <TbaiCompactDataUI />
      <div className="relative flex h-screen flex-col bg-background text-foreground">
        <div className="relative flex min-w-0 flex-1 flex-row overflow-hidden">
          <ActivityBar />
          {sidebarVisible && <Sidebar />}
          <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            {/* codeg-style content-area tab strip (top of the conversation column) */}
            <div className="relative flex h-[var(--title-bar-height)] shrink-0 items-stretch border-b border-border glass-surface">
              {!sidebarVisible && (
                <div
                  data-tauri-drag-region
                  className="h-full w-[var(--left-chrome-width)] shrink-0"
                />
              )}
              <TabStrip />
              {/* Open another bound chat in an optional panel (stable runtime host). */}
              <button
                type="button"
                onClick={openChatInPanel}
                disabled={!panelCandidate}
                title="Open another chat in a panel"
                aria-label="Open another chat in a workspace panel"
                data-testid="open-in-panel"
                className="flex h-full w-9 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
              >
                <PanelRightOpen className="size-4" />
              </button>
              {/* Reserve the right overlay cluster + caption buttons (Tauri). */}
              <div
                data-tauri-drag-region
                className="h-full w-[var(--right-chrome-reserve)] shrink-0"
              />
            </div>

            {/* Page-level context menu is its own chrome component; the shell only
                composes it around the routed content. */}
            <PageContextMenu>
              <div className="flex h-full min-h-0 flex-row">
                {/* Primary Chat keeps the canonical shared runtime (Outlet). */}
                <div className="flex min-w-0 flex-1 flex-col">
                  <Outlet />
                </div>
                {/* Optional panels: stable, keyed runtime hosts under one parent. */}
                <WorkspaceSurface activeTabKey={active?.key} />
              </div>
            </PageContextMenu>
          </main>
        </div>

        {statusBarVisible && <StatusBar />}
        <CommandPalette />

        {/* Corner overlays — rendered in BOTH web + desktop (codeg pattern). Only
            the caption buttons self-null in the browser. */}
        <div className="absolute top-0 z-50 h-[var(--title-bar-height)] w-[var(--left-chrome-width)] left-[var(--activity-bar-width)]">
          <LeftEdgeChrome />
        </div>
        <div className="absolute top-0 z-50 h-[var(--title-bar-height)] right-[var(--right-chrome-reserve)]">
          <RightEdgeChrome />
        </div>
        <div className="absolute right-0 top-0 z-50 h-[var(--title-bar-height)]">
          <WindowControls />
        </div>

        {/* Desktop keyboard shortcuts (self-gates on isTauri) */}
        <ChromeShortcuts />
        <ZoomController />
        <TabUrlSync />
        {/* Route transitions are part of every operation's story — recorded once,
            for both shells, since both render through this component. */}
        <RouteObserver />
      </div>
    </AssistantRuntimeProvider>
  );
}
