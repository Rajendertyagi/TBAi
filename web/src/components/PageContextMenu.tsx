import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "./ui/context-menu";
import { sidebarConfig } from "../config/sidebar";
import { lastSettingsRoute } from "../config/navigation";
import { useDesktopLayout } from "../features/desktop/state/desktopLayout";

/**
 * Page-level (right-click on the content area) context menu. A desktop-chrome
 * concern kept as its own component so `AppShell` only composes chrome and never
 * implements a feature's menu markup. Radix suppresses the native browser menu
 * itself, so no manual `preventDefault` is needed (and adding one would set
 * `defaultPrevented` before Radix's handler and stop the menu from opening).
 *
 * Labels come from `sidebarConfig.copy`, the settings target from
 * `appConfig.settingsIndexRoute` — no literals live here.
 */
export function PageContextMenu({ children }: { children: ReactNode }) {
  const copy = sidebarConfig.copy;
  const toggleSidebar = useDesktopLayout((s) => s.toggleSidebar);
  const toggleStatusBar = useDesktopLayout((s) => s.toggleStatusBar);
  const navigate = useNavigate();

  const handleNewChat = () => {
    navigate("/chat/new");
  };

  const handleOpenSettings = () => {
    navigate(lastSettingsRoute());
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={handleNewChat}>{copy.newChat}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => toggleSidebar()}>
          {copy.toggleSidebar}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => toggleStatusBar()}>
          {copy.toggleStatusBar}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={handleOpenSettings}>
          {copy.openSettings}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
