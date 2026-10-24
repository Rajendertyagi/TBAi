import { useCallback, useEffect, useMemo } from "react";
import { Outlet } from "react-router";
import {
  AssistantRuntimeProvider,
  AuiConfig,
  Tools,
  Suggestions,
  makeAssistantDataUI,
} from "@assistant-ui/react";
import { Sidebar } from "../../components/Sidebar";
import { StatusBar } from "../../components/StatusBar";
import { ActivityBar } from "../../components/ActivityBar";
import { TabStrip } from "../../components/TabStrip";
import { LeftEdgeChrome } from "../../components/LeftEdgeChrome";
import { RightEdgeChrome } from "../../components/RightEdgeChrome";
import { WindowControls } from "../../components/WindowControls";
import { ChromeShortcuts } from "../../components/ChromeShortcuts";
import { PageContextMenu } from "../../components/PageContextMenu";
import { TabUrlSync } from "../TabUrlSync";
import { RouteObserver } from "../RouteObserver";
import { isTauri } from "../../lib/platform";
import { syncChromeVars } from "../../lib/chrome-vars";
import { useDesktopLayout } from "../../features/desktop/state/desktopLayout";
import { useAvailabilityStore } from "../../features/availability/availabilityStore";
import { registerAvailabilityRecovery } from "../../features/availability/recovery";
import { registerTabReconciliation } from "../../features/chat/state/tabReconciliation";
import { useAppChatRuntime } from "../../runtime";
import { threadListAdapter } from "../adapter";
import { useSettingsStore } from "@/features/providers/state/providersStore";
import { NEW_DRAFT_TAB_ID, activeTab, useChatTabsStore } from "../../features/chat/state/chatTabs";
import { getWelcomeEngineSnapshot } from "../../features/chat/state/welcomeEngine";
import { peekMaterializedEngine } from "../../features/chat/state/materializeDraft";
import { appToolkit } from "../../tools/toolkit";
import { ProgressStages } from "../../components/assistant-ui/elements/progress-stages";
import { CompactionDivider } from "../../components/assistant-ui/elements/compaction-divider";
import { DIRECT_COMPACT_DATA_NAME } from "../../features/chat/compactCommand";
import { logger } from "../../lib/logger";

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
  const sidebarVisible = useDesktopLayout((s) => s.sidebarVisible);
  const statusBarVisible = useDesktopLayout((s) => s.statusBarVisible);
  const sidebarWidth = useDesktopLayout((s) => s.sidebarWidth);
  const searchOpen = useDesktopLayout((s) => s.searchOpen);

  const active = useChatTabsStore(activeTab);
  const runtimeThreadId =
    active?.kind === "chat" && active.ref !== NEW_DRAFT_TAB_ID ? active.ref : undefined;

  const handleThreadIdChange = useCallback((id: string | undefined) => {
    if (!id) return;
    const state = useChatTabsStore.getState();
    const current = activeTab(state);
    logger.info("app", "runtime.bind", { threadId: id });
    if (current?.kind === "chat" && current.ref === NEW_DRAFT_TAB_ID) {
      state.resolveDraftId(id, peekMaterializedEngine(id) ?? getWelcomeEngineSnapshot().engine);
    } else if (!state.tabs.some((t) => t.kind === "chat" && t.ref === id)) {
      state.openChat(id);
    }
  }, []);

  const runtime = useAppChatRuntime(threadListAdapter, runtimeThreadId, handleThreadIdChange);

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
  // token layer in `lib/window-chrome.ts` via `syncChromeVars`).
  useEffect(() => {
    syncChromeVars({ sidebarWidth, searchOpen, captionStrip });
  }, [sidebarWidth, searchOpen, captionStrip]);

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
              {/* Reserve the right overlay cluster + caption buttons (Tauri). */}
              <div
                data-tauri-drag-region
                className="h-full w-[var(--right-chrome-reserve)] shrink-0"
              />
            </div>

            {/* Page-level context menu is its own chrome component; the shell only
                composes it around the routed content. */}
            <PageContextMenu>
              <Outlet />
            </PageContextMenu>
          </main>
        </div>

        {statusBarVisible && <StatusBar />}

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
        <TabUrlSync />
        {/* Route transitions are part of every operation's story — recorded once,
            for both shells, since both render through this component. */}
        <RouteObserver />
      </div>
    </AssistantRuntimeProvider>
  );
}
