import { PanelLeft, PanelBottom } from "lucide-react";
import { WindowControls } from "./WindowControls";
import { appConfig } from "../config/navigation";
import { cn } from "../lib/utils";
import { useDesktopLayout } from "../features/desktop/state/desktopLayout";

/**
 * Custom (non-native) title bar. The entire left + middle region is one
 * `data-tauri-drag-region` that stretches full height (parent is items-stretch),
 * so the window drags from anywhere on the bar except the controls. The layout
 * toggle buttons and window controls are siblings OUTSIDE the drag region so
 * clicking them never starts a drag.
 */
export function DesktopTitleBar() {
  const sidebarVisible = useDesktopLayout((s) => s.sidebarVisible);
  const statusBarVisible = useDesktopLayout((s) => s.statusBarVisible);
  const toggleSidebar = useDesktopLayout((s) => s.toggleSidebar);
  const toggleStatusBar = useDesktopLayout((s) => s.toggleStatusBar);

  return (
    <div className="flex h-9 shrink-0 select-none items-stretch border-b border-border bg-muted/40 px-2">
      <div
        data-tauri-drag-region
        className="flex flex-1 items-center gap-2 pl-1"
      >
        <div
          data-tauri-drag-region
          className="flex h-4 w-4 items-center justify-center rounded-sm bg-foreground"
        >
          <span data-tauri-drag-region className="text-[9px] font-bold text-background">
            {appConfig.branding.logoText}
          </span>
        </div>
        <span data-tauri-drag-region className="text-xs font-medium text-muted-foreground">
          {appConfig.branding.appName}
        </span>
      </div>
      <div className="flex items-center gap-0.5 pr-1">
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
          <PanelLeft className="h-3.5 w-3.5" />
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
          <PanelBottom className="h-3.5 w-3.5" />
        </button>
      </div>
      <WindowControls />
    </div>
  );
}
