import { useEffect, useRef } from "react";
import { PanelLeft, Search, X } from "lucide-react";
import { TooltipIconButton } from "./assistant-ui/elements/tooltip-icon-button";
import { Input } from "./ui/input";
import { sidebarConfig } from "../config/sidebar";
import { historyConfig } from "../config/history";
import { useDesktopLayout } from "../features/desktop/state/desktopLayout";

/**
 * Top-LEFT floating corner cluster (mirrors codeg's `LeftEdgeChrome`): the
 * sidebar toggle + conversation search. Rendered in BOTH the browser and the
 * Tauri desktop; the empty tail is a window-drag region (Tauri only).
 *
 * Search lives here — not in the sidebar — precisely because this overlay
 * never unmounts: the sidebar does, which used to leave `Ctrl/⌘K` as the only
 * path to search while collapsed. Opening search also opens the sidebar so
 * the filtered list is visible. Widths come from `--left-chrome-width`
 * (`lib/chrome-vars.ts`); no literals live here.
 */
export function LeftEdgeChrome() {
  const copy = sidebarConfig.copy;
  const sidebarVisible = useDesktopLayout((s) => s.sidebarVisible);
  const toggleSidebar = useDesktopLayout((s) => s.toggleSidebar);
  const setSidebar = useDesktopLayout((s) => s.setSidebar);
  const searchOpen = useDesktopLayout((s) => s.searchOpen);
  const searchInput = useDesktopLayout((s) => s.searchInput);
  const searchFocusRequest = useDesktopLayout((s) => s.searchFocusRequest);
  const setSearchInput = useDesktopLayout((s) => s.setSearchInput);
  const setSearchQuery = useDesktopLayout((s) => s.setSearchQuery);
  const setSearchOpen = useDesktopLayout((s) => s.setSearchOpen);
  const requestSearchFocus = useDesktopLayout((s) => s.requestSearchFocus);
  const inputRef = useRef<HTMLInputElement>(null);

  const openSearch = () => {
    setSidebar(true);
    setSearchOpen(true);
    requestSearchFocus();
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
  };

  // Focus the input on open / shortcut request (the overlay re-renders, so
  // autoFocus alone is not enough for repeat shortcut presses).
  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen, searchFocusRequest]);

  // Global conversation-search shortcut (Ctrl/⌘K). Ignored while typing in an
  // editable element so composer/input shortcuts keep working.
  useEffect(() => {
    if (!historyConfig.searchEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      openSearch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full w-full items-center gap-1 pl-3">
      <TooltipIconButton
        tooltip={sidebarVisible ? copy.hideSidebar : copy.showSidebar}
        side="bottom"
        onClick={toggleSidebar}
        aria-pressed={sidebarVisible}
      >
        <PanelLeft className="size-3.5" />
      </TooltipIconButton>
      {historyConfig.searchEnabled &&
        (searchOpen ? (
          <>
            <Input
              ref={inputRef}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") closeSearch();
              }}
              placeholder={copy.searchPlaceholder}
              aria-label={copy.searchLabel}
              className="h-6 min-w-0 flex-1 border-transparent bg-transparent px-1.5 text-xs shadow-none focus-visible:border-ring"
            />
            <TooltipIconButton
              tooltip={copy.clearSearch}
              side="bottom"
              onClick={closeSearch}
            >
              <X className="size-3.5" />
            </TooltipIconButton>
          </>
        ) : (
          <TooltipIconButton
            tooltip={`${copy.searchLabel} (${copy.searchShortcutHint})`}
            side="bottom"
            onClick={openSearch}
            aria-label={copy.searchLabel}
          >
            <Search className="size-3.5" />
          </TooltipIconButton>
        ))}
      {/* Empty tail is a window-drag region (Tauri only). */}
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
    </div>
  );
}
