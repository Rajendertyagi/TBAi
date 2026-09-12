import { PanelLeft, PanelBottom } from "lucide-react";
import { WindowControls } from "./WindowControls";
import { TabStrip } from "./TabStrip";
import { cn } from "../lib/utils";
import { useDesktopLayout } from "../features/desktop/state/desktopLayout";

/**
 * Single VS Code–style top band (`h-10`) that replaces the old two-row
 * title-bar + tab-strip. Mirrors codeg: the chat tabs fill the middle, the
 * layout toggles sit in the left corner, and the native window controls float
 * as an absolute overlay in the right corner. The window is dragged via explicit
 * `data-tauri-drag-region` spacer divs (never over the tabs/buttons), so a
 * click on a tab or control never starts a drag. The band is rendered to the
 * RIGHT of the ActivityBar (which owns the full-height left rail + logo).
 */
export function TopBand() {
  const sidebarVisible = useDesktopLayout((s) => s.sidebarVisible);
  const statusBarVisible = useDesktopLayout((s) => s.statusBarVisible);
  const toggleSidebar = useDesktopLayout((s) => s.toggleSidebar);
  const toggleStatusBar = useDesktopLayout((s) => s.toggleStatusBar);

  return (
    <div className="relative flex h-10 shrink-0 select-none items-stretch border-b border-border bg-muted/40">
      <div className="flex shrink-0 items-center gap-0.5 px-2">
        <button
          type="button"
          onClick={toggleSidebar}
          title="Toggle sidebar"
          aria-pressed={sidebarVisible}
          className={cn(
            "rounded p-1 transition-colors hover:bg-muted",
            sidebarVisible ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={toggleStatusBar}
          title="Toggle status bar"
          aria-pressed={statusBarVisible}
          className={cn(
            "rounded p-1 transition-colors hover:bg-muted",
            statusBarVisible ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <PanelBottom className="h-4 w-4" />
        </button>
      </div>

      <div className="relative flex min-w-0 flex-1 items-stretch">
        <TabStrip />
        {/* Reserve exactly the window-controls width so tabs never render
            underneath them; also a window-drag region (codeg right-reserve). */}
        <div data-tauri-drag-region className="h-full w-[138px] shrink-0" />
      </div>

      <div className="absolute inset-y-0 right-0 z-30 flex items-stretch">
        <WindowControls />
      </div>
    </div>
  );
}
