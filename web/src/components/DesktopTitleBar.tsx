import { WindowControls } from "./WindowControls";
import { appConfig } from "../config/navigation";

/**
 * Custom (non-native) title bar. The whole bar is a Tauri drag region; the
 * window-control buttons sit at the right and opt out of dragging.
 */
export function DesktopTitleBar() {
  return (
    <div
      data-tauri-drag-region
      className="flex h-9 shrink-0 select-none items-center border-b border-border bg-muted/40 px-2"
    >
      <div data-tauri-drag-region className="flex items-center gap-2 pl-1">
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
      <div data-tauri-drag-region className="flex-1" />
      <WindowControls />
    </div>
  );
}
