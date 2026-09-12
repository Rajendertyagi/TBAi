import { PanelBottom } from "lucide-react";
import { useDesktopLayout } from "../features/desktop/state/desktopLayout";
import { cn } from "../lib/utils";

/**
 * Top-RIGHT floating corner cluster: the status-bar toggle. Rendered in BOTH
 * the browser and the Tauri desktop; only its leading `data-tauri-drag-region`
 * is meaningful inside Tauri. (Settings lives behind the rail's single gear
 * now — no second gear here.)
 */
export function RightEdgeChrome() {
  const statusBarVisible = useDesktopLayout((s) => s.statusBarVisible);
  const toggleStatusBar = useDesktopLayout((s) => s.toggleStatusBar);

  return (
    <div className="flex h-full items-center gap-1 pr-3">
      {/* Empty head is a window-drag region; buttons stay flush right. */}
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
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
  );
}
