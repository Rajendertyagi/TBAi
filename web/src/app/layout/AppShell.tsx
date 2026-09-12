import { Outlet } from "react-router";
import { Sidebar } from "../../components/Sidebar";
import { StatusBar } from "../../components/StatusBar";
import { ActivityBar } from "../../components/ActivityBar";
import { TabStrip } from "../../components/TabStrip";
import { LeftEdgeChrome } from "../../components/LeftEdgeChrome";
import { RightEdgeChrome } from "../../components/RightEdgeChrome";
import { WindowControls } from "../../components/WindowControls";
import { WindowResizeHandles } from "../../components/WindowResizeHandles";
import { ChromeShortcuts } from "../../components/ChromeShortcuts";
import { TabUrlSync } from "../TabUrlSync";
import { isTauri } from "../../lib/platform";
import { useDesktopLayout } from "../../features/desktop/state/desktopLayout";

/**
 * Single application shell for BOTH the browser and the Tauri desktop. There is
 * no `if (desktop) … else …` layout fork: the same tree renders everywhere, and
 * only Tauri-only leaves self-gate via `isTauri()` (OS window controls, the
 * drag-region reserves, and the edge resize grips). This mirrors codeg's
 * `FolderLayoutShell` (`!isMobile` branch): the chat tabs live in a `h-10` strip
 * at the top of the content area, the sidebar-toggle / status / settings live in
 * fixed corner overlays, and the native window controls float as a top-right
 * overlay that is simply absent in the browser.
 *
 * The shell must render inside AssistantRuntimeProvider (the sidebar thread list,
 * tab titles, and all views consume the ambient runtime).
 */
export function AppShell() {
  const sidebarVisible = useDesktopLayout((s) => s.sidebarVisible);
  const statusBarVisible = useDesktopLayout((s) => s.statusBarVisible);

  return (
    <div className="relative flex h-screen flex-col bg-background text-foreground">
      <div className="relative flex min-w-0 flex-1 flex-row overflow-hidden">
        <ActivityBar />
        {sidebarVisible && <Sidebar />}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* codeg-style content-area tab strip (top of the conversation column) */}
          <div className="relative flex h-10 shrink-0 items-stretch border-b border-border bg-muted/40">
            {!sidebarVisible && (
              <div data-tauri-drag-region className="h-full w-20 shrink-0" />
            )}
            <TabStrip />
            {/* Reserve the right overlay cluster (always) + caption buttons (Tauri) */}
            <div
              data-tauri-drag-region
              className={
                isTauri()
                  ? "h-full w-[218px] shrink-0"
                  : "h-full w-20 shrink-0"
              }
            />
          </div>
          <Outlet />
        </main>
      </div>

      {statusBarVisible && <StatusBar />}

      {/* Corner overlays — rendered in BOTH web + desktop (codeg pattern). Only
          the OS window controls self-null in the browser. */}
      <div className="absolute left-12 top-0 z-50 h-10 w-20">
        <LeftEdgeChrome />
      </div>
      <div
        className="absolute top-0 z-50 h-10"
        style={{ right: isTauri() ? 138 : 0 }}
      >
        <RightEdgeChrome />
      </div>
      <div className="absolute right-0 top-0 z-50 h-10">
        <WindowControls />
      </div>

      {/* Tauri-only window edge resize grips */}
      {isTauri() && <WindowResizeHandles />}
      {/* Desktop keyboard shortcuts (self-gates on isTauri) */}
      <ChromeShortcuts />
      <TabUrlSync />
    </div>
  );
}
