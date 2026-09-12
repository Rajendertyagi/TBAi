import { useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router";
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
import { isTauri } from "../../lib/platform";
import { syncChromeVars } from "../../lib/chrome-vars";
import { isSettingsRoute } from "../../config/navigation";
import { useDesktopLayout } from "../../features/desktop/state/desktopLayout";

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
 * The shell must render inside AssistantRuntimeProvider (the sidebar thread list,
 * tab titles, and all views consume the ambient runtime).
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
  const { pathname } = useLocation();
  const inSettings = isSettingsRoute(pathname);
  const wasInSettings = useRef(inSettings);

  // De-cramp settings pages: entering a settings route stashes the sidebar
  // visibility and collapses it (freeing ~224px next to the sub-sidebar);
  // leaving restores the stash — but only if the user didn't manually
  // toggle the sidebar meanwhile (manual choice always wins).
  useEffect(() => {
    if (inSettings === wasInSettings.current) return;
    wasInSettings.current = inSettings;
    const state = useDesktopLayout.getState();
    if (inSettings) {
      state.setSettingsStash(state.sidebarVisible);
      if (state.sidebarVisible) state.setSidebar(false);
    } else {
      if (state.settingsStash === true && !state.sidebarVisible) {
        state.setSidebar(true);
      }
      state.setSettingsStash(null);
    }
  }, [inSettings]);

  // The frameless Windows caption strip exists only in the Tauri desktop;
  // the browser reserves just the button cluster.
  const captionStrip = isTauri();

  // Publish chrome geometry as CSS variables (single source of truth = the
  // token layer in `lib/window-chrome.ts` via `syncChromeVars`).
  useEffect(() => {
    syncChromeVars({ sidebarWidth, searchOpen, captionStrip });
  }, [sidebarWidth, searchOpen, captionStrip]);

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
    </div>
  );
}
