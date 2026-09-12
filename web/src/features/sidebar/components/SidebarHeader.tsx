import { ChevronsDownUp, ChevronsUpDown, Crosshair } from "lucide-react";
import { sidebarConfig } from "@/config/sidebar";
import { SidebarViewMenu } from "@/features/sidebar/components/SidebarViewMenu";

const HEADER_BUTTON_CLASS =
  "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/**
 * The sidebar's fixed `h-10` header (codeg geometry): a window-drag filler
 * plus locate-active, expand/collapse-all, and the view-options menu. Left
 * padding clears the floating corner overlay via `--left-chrome-width`.
 */
export function SidebarHeader({
  listRef,
  allExpanded,
  onToggleExpandAll,
}: {
  listRef: React.RefObject<HTMLDivElement | null>;
  allExpanded: boolean;
  onToggleExpandAll: () => void;
}) {
  const copy = sidebarConfig.copy;

  const scrollToActive = () => {
    const active = listRef.current?.querySelector("[data-active]");
    active?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  return (
    <div className="flex h-[var(--title-bar-height)] shrink-0 items-center gap-0.5 border-b border-sidebar-border py-0 pl-[var(--left-chrome-width)] pr-2">
      {/* Draggable filler — the header is the window's top edge here. */}
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
      <button
        type="button"
        onClick={scrollToActive}
        title={copy.locateActive}
        aria-label={copy.locateActive}
        className={HEADER_BUTTON_CLASS}
      >
        <Crosshair aria-hidden="true" className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onToggleExpandAll}
        title={allExpanded ? copy.collapseAll : copy.expandAll}
        aria-label={allExpanded ? copy.collapseAll : copy.expandAll}
        className={HEADER_BUTTON_CLASS}
      >
        {allExpanded ? (
          <ChevronsDownUp aria-hidden="true" className="size-3.5" />
        ) : (
          <ChevronsUpDown aria-hidden="true" className="size-3.5" />
        )}
      </button>
      <SidebarViewMenu />
    </div>
  );
}
