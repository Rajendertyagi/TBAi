import { PanelBottom, Settings } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { appConfig } from "../config/navigation";
import { chromeConfig } from "../config/chrome";
import { openSettingsTab } from "../lib/settings-window";
import { isTauri, openSettingsWindow } from "../lib/platform";
import { useDesktopLayout } from "../features/desktop/state/desktopLayout";
import { cn } from "../lib/utils";

/**
 * Top-RIGHT floating corner cluster (mirrors codeg's `RightEdgeChrome`): the
 * status-bar toggle and a Settings button. Rendered in BOTH the browser and the
 * Tauri desktop (it sits at `right: isTauri() ? 138 : 0` in `AppShell`, to the
 * LEFT of the native caption buttons); only its leading `data-tauri-drag-region`
 * is meaningful inside Tauri.
 */
export function RightEdgeChrome() {
  const navigate = useNavigate();
  const statusBarVisible = useDesktopLayout((s) => s.statusBarVisible);
  const toggleStatusBar = useDesktopLayout((s) => s.toggleStatusBar);

  const openSettings = () => {
    // Dedicated surface: native window on desktop, named second tab on web
    // (in-app route only when the popup is blocked — never a dead click).
    if (isTauri()) {
      openSettingsWindow().catch(() => {
        toast.error(chromeConfig.copy.settingsOpenFailed);
        navigate(appConfig.settingsIndexRoute);
      });
    } else if (!openSettingsTab()) {
      navigate(appConfig.settingsIndexRoute);
    }
  };

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
      <button
        type="button"
        onClick={openSettings}
        title="Settings"
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Settings className="h-4 w-4" />
      </button>
    </div>
  );
}
