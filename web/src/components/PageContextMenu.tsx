import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Copy, PanelBottom, PanelLeft, Settings, SquarePen } from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "./ui/context-menu";
import { sidebarConfig } from "../config/sidebar";
import { lastSettingsRoute } from "../config/navigation";
import { useDesktopLayout } from "../features/desktop/state/desktopLayout";
import { copyTextFromMenu } from "../lib/clipboard";
import { canCopySelection, readPageSelection } from "../lib/page-selection";
import { logger } from "../lib/logger";

/**
 * Page-level (right-click on the content area) context menu. A desktop-chrome
 * concern kept as its own component so `AppShell` only composes chrome and never
 * implements a feature's menu markup. Radix suppresses the native browser menu
 * itself, so no manual `preventDefault` is needed (and adding one would set
 * `defaultPrevented` before Radix's handler and stop the menu from opening).
 *
 * The menu replaced the browser's own, which used to offer Copy for a page
 * selection, so that item is restored here. The selection is captured on open
 * rather than read on click: opening a Radix menu moves focus and collapses the
 * browser selection, so a click-time read would find nothing. Radix's
 * `onOpenChange` runs before that focus shift, which makes it the right capture
 * point. Copy is disabled when nothing was highlighted, rather than hidden, so
 * the menu's shape does not change depending on where the user right-clicked.
 *
 * Labels come from `sidebarConfig.copy`, the settings target from
 * `appConfig.settingsIndexRoute` — no literals live here.
 */
export function PageContextMenu({ children }: { children: ReactNode }) {
  const copy = sidebarConfig.copy;
  const shortcuts = sidebarConfig.copy.shortcuts;
  const toggleSidebar = useDesktopLayout((s) => s.toggleSidebar);
  const toggleStatusBar = useDesktopLayout((s) => s.toggleStatusBar);
  const navigate = useNavigate();
  const [selectedText, setSelectedText] = useState("");

  /**
   * Captures the page selection at the moment the menu opens.
   *
   * This must not be deferred to click time: Radix takes focus when the menu
   * opens, which collapses the browser selection, so a later read would find
   * nothing to copy. `onOpenChange` fires before that focus shift, which makes
   * it the only point where the text is still available.
   */
  const handleOpenChange = (open: boolean) => {
    if (!open) return;
    setSelectedText(readPageSelection(window.getSelection()));
  };

  const handleNewChat = () => {
    navigate("/chat/new");
  };

  /**
   * Copies the selection captured at menu-open, never a re-read of the live one.
   */
  const handleCopySelection = async () => {
    if (!canCopySelection(selectedText)) return;
    const ok = await copyTextFromMenu(selectedText);
    if (!ok) {
      logger.warn("page_menu", "clipboard_write_failed", {
        message: copy.copy,
      });
    }
  };

  const handleOpenSettings = () => {
    navigate(lastSettingsRoute());
  };

  return (
    <ContextMenu modal={false} onOpenChange={handleOpenChange}>
      <ContextMenuTrigger asChild>
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[13rem]">
        <ContextMenuItem
          textValue={copy.newChat}
          aria-keyshortcuts="Control+T"
          onSelect={handleNewChat}
        >
          <SquarePen aria-hidden="true" className="size-4 text-muted-foreground" />
          <span>{copy.newChat}</span>
          <ContextMenuShortcut>{shortcuts.newChat}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          textValue={copy.copy}
          aria-keyshortcuts="Control+C"
          disabled={!canCopySelection(selectedText)}
          onSelect={() => void handleCopySelection()}
        >
          <Copy aria-hidden="true" className="size-4 text-muted-foreground" />
          <span>{copy.copy}</span>
          <ContextMenuShortcut>{shortcuts.copy}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* No `aria-keyshortcuts` on the two toggles or on Settings: nothing
            binds those keys (see `ChromeShortcuts.tsx`, which handles only
            Ctrl/Cmd+T, +W, +Tab and +1..9). Declaring a shortcut the app does
            not implement would tell assistive tech the opposite of the truth.
            The visible hints are inherited from `config/sidebar.ts` and are
            flagged there for a maintainer decision. */}
        <ContextMenuItem textValue={copy.toggleSidebar} onSelect={() => toggleSidebar()}>
          <PanelLeft aria-hidden="true" className="size-4 text-muted-foreground" />
          <span>{copy.toggleSidebar}</span>
          <ContextMenuShortcut>{shortcuts.toggleSidebar}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem textValue={copy.toggleStatusBar} onSelect={() => toggleStatusBar()}>
          <PanelBottom aria-hidden="true" className="size-4 text-muted-foreground" />
          <span>{copy.toggleStatusBar}</span>
          <ContextMenuShortcut>{shortcuts.toggleStatusBar}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem textValue={copy.openSettings} onSelect={handleOpenSettings}>
          <Settings aria-hidden="true" className="size-4 text-muted-foreground" />
          <span>{copy.openSettings}</span>
          <ContextMenuShortcut>{shortcuts.openSettings}</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
