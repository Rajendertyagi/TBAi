import { useEffect } from "react";
import { Outlet } from "react-router";
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
 * The shell navigation (Sidebar, TabStrip, ActivityBar, StatusBar) does NOT
 * depend on an assistant-ui execution runtime — chat/code execution runtimes
 * are isolated to their respective route surfaces (/chat, /code).
 *
 * Chrome geometry (sidebar width, overlay reserves, band heights) is published
 * as CSS variables by `syncChromeVars` and consumed via `var(--…)` classes —
 * components never carry inline `style=` reserves.
 *
 * The shell only *composes* chrome. Feature menus (e.g. the page-level context
 * menu) live in their own chrome components so this file stays a thin layout.
 */
export interface AppShellProps {
  children?: React.ReactNode;
}

export function AppShell({ children }: AppShellProps = {}) {
  const sidebarVisible = useDesktopLayout((s) => s.sidebarVisible);
  const statusBarVisible = useDesktopLayout((s) => s.statusBarVisible);
  const sidebarWidth = useDesktopLayout((s) => s.sidebarWidth);
  const searchOpen = useDesktopLayout((s) => s.searchOpen);

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
  useEffect(() => {
    const unregister = registerAvailabilityRecovery();
    useAvailabilityStore.getState().start();
    return () => {
      unregister();
      useAvailabilityStore.getState().stop();
    };
  }, []);

  return (
    <div className="relative flex h-screen flex-col bg-background text-foreground">
      <div className="relative flex min-w-0 flex-1 flex-row overflow-hidden">
        <ActivityBar />
        {sidebarVisible && <Sidebar />}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* codeg-style content-area tab strip (top of the conversation column) */}
          <div className="relative flex h-[var(--title-bar-height)] shrink-0 items-stretch border-b border-border bg-muted/40">
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
            {children ?? <Outlet />}
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
  );
}
