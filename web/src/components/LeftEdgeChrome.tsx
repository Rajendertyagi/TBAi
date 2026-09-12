import { PanelLeft } from "lucide-react";
import { useDesktopLayout } from "../features/desktop/state/desktopLayout";
import { cn } from "../lib/utils";

/**
 * Top-LEFT floating corner cluster (mirrors codeg's `LeftEdgeChrome`): the
 * sidebar toggle. Rendered in BOTH the browser and the Tauri desktop (it sits at
 * `left-12` over the Sidebar's top in `AppShell`); only its trailing
 * `data-tauri-drag-region` is meaningful inside Tauri. A click toggles the
 * sidebar panel; the empty tail lets the window be dragged.
 */
export function LeftEdgeChrome() {
  const sidebarVisible = useDesktopLayout((s) => s.sidebarVisible);
  const toggleSidebar = useDesktopLayout((s) => s.toggleSidebar);

  return (
    <div className="flex h-full items-center gap-1 pl-3">
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
      {/* Empty tail is a window-drag region (Tauri only). */}
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
    </div>
  );
}
