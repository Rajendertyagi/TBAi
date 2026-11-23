import { useCallback, useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router";
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
import { RouteObserver } from "../RouteObserver";
import { isTauri } from "../../lib/platform";
import { syncChromeVars } from "../../lib/chrome-vars";
import { chatColumnWidth } from "../../config/chat";
import { useDesktopLayout } from "../../features/desktop/state/desktopLayout";
import { useAvailabilityStore } from "../../features/availability/availabilityStore";
import { registerAvailabilityRecovery } from "../../features/availability/recovery";
import { registerTabReconciliation } from "../../features/chat/state/tabReconciliation";
import { useDraftPickLifecycle } from "../../features/chat/state/useDraftPickLifecycle";
import { useChatTabsStore, parseTabKey } from "../../features/chat/state/chatTabs";
import {
  DockviewWorkspace,
  type DockviewWorkspaceHandle,
} from "../../features/workspace/components/DockviewWorkspace";
import { useWorkspaceFocusSync } from "../../features/workspace/state/useWorkspaceFocusSync";
import {
  isChatSurfacePath,
  routeSurfaceClass,
  workspaceSurfaceClass,
} from "../../features/workspace/routeFocus";

/**
 * Single application shell for BOTH the browser and the Windows desktop.
 *
 * Phase E: AppShell is the persistent composition root. It mounts the
 * `DockviewWorkspace` ONCE as the chat surface layer and keeps it mounted across
 * navigation to settings/scheduler/other pages — only visibility changes, so
 * per-host runtimes, streams, composers and scroll state survive. Route pages
 * render as an alternate surface through `<Outlet />`; chat/code route views
 * are thin focus/open triggers with no chat host of their own.
 *
 * The root `AssistantRuntimeProvider` was removed in Phase E (see
 * `docs/workspace-redesign/PROVIDER_AUDIT.md`): every assistant-ui consumer is
 * now host-isolated behind a per-host provider, and the Sidebar reads the
 * HTTP-owned activity projection instead of ambient runtime state.
 *
 * Chrome geometry (sidebar width, overlay reserves, band heights) is published
 * as CSS variables by `syncChromeVars` and consumed via `var(--…)` classes —
 * components never carry inline `style=` reserves.
 */
export function AppShell() {
  // Draft one-shot picks are scoped to the unsent draft by a single store
  // subscription, so every navigation path (strip, keyboard, sidebar, history)
  // discards them on leave. See useDraftPickLifecycle.
  useDraftPickLifecycle();

  const location = useLocation();
  const isChatSurface = isChatSurfacePath(location.pathname);

  const sidebarVisible = useDesktopLayout((s) => s.sidebarVisible);
  const statusBarVisible = useDesktopLayout((s) => s.statusBarVisible);
  const sidebarWidth = useDesktopLayout((s) => s.sidebarWidth);
  const chatWidth = useDesktopLayout((s) => s.chatWidth);
  const searchOpen = useDesktopLayout((s) => s.searchOpen);

  const localActiveKey = useChatTabsStore((s) => s.localActiveKey);
  const sharedTabs = usePreferencesStore((s) => s.snapshot?.sharedTabs);

  // The single URL ↔ focused-panel convergence controller. AppShell owns the
  // imperative handle and shares it with the persistent Dockview instance.
  const dockviewHandleRef = useRef<DockviewWorkspaceHandle | null>(null);
  const { onDockviewActivePanelChange, refocus } = useWorkspaceFocusSync(dockviewHandleRef);

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
    if (!sharedTabs || !localActiveKey) return;
    const parsed = parseTabKey(localActiveKey);
    if (!parsed || parsed.ref === "new") return;
    const isMember = sharedTabs.some((t) => t.ref === parsed.ref);
    const tabs = useChatTabsStore.getState();
    if (!isMember) tabs.markDetached(parsed.ref);
    else tabs.clearDetached(parsed.ref);
  }, [sharedTabs, localActiveKey]);

  // Stable callback identity for the Dockview close seam (the adapter falls
  // back to the canonical chatTabs close when no override is supplied).
  const onPanelClose = useCallback((tabKey: string) => {
    useChatTabsStore.getState().close(tabKey);
  }, []);

  return (
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
            <div className="relative flex h-full min-h-0 flex-row">
              {/* Persistent Dockview layer — mounted once, never unmounted on
                  navigation. It is absolutely positioned at inset-0 so it keeps
                  the parent's full size even while visually hidden; `hidden`
                  (display:none) would collapse Dockview to zero and it could
                  not recover on re-show (audit M2). */}
              <div
                className={workspaceSurfaceClass(isChatSurface)}
                data-testid="workspace-surface"
                aria-hidden={!isChatSurface}
              >
                <DockviewWorkspace
                  handleRef={dockviewHandleRef}
                  activeTabKey={localActiveKey}
                  onPanelClose={onPanelClose}
                  onActivePanelChange={onDockviewActivePanelChange}
                  onHandleReady={refocus}
                />
              </div>
              {/* Route pages: thin focus triggers for chat/code, real pages for
                  settings/scheduler/etc. Layered above the workspace; on chat
                  surfaces it is empty and pointer-transparent so the workspace
                  stays interactive. */}
              <div className={routeSurfaceClass(isChatSurface)} data-testid="route-surface">
                <Outlet />
              </div>
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
      {/* Route transitions are part of every operation's story — recorded once,
          for both shells, since both render through this component. */}
      <RouteObserver />
    </div>
  );
}
