import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import {
  sectionLabel,
  sidebarConfig,
  type SidebarSectionId,
} from "@/config/sidebar";
import { useDesktopLayout } from "@/features/desktop/state/desktopLayout";

/**
 * The "Section order" block of the sidebar's view-options menu: one row per
 * reorderable section in current top-to-bottom order, each with move up/down
 * affordances. Rows keep the menu open (iterative action); keyboard users move
 * with Alt+↑/↓ on the focused row. Hidden sections (Recent off) stay listed
 * and reorderable, dimmed — hiding keeps its slot.
 */
export function SidebarSectionOrderControl() {
  const copy = sidebarConfig.copy;
  const order = useDesktopLayout((s) => s.sectionOrder);
  const showRecent = useDesktopLayout((s) => s.showRecent);
  const moveSection = useDesktopLayout((s) => s.moveSection);
  const rowRefs = useRef(new Map<SidebarSectionId, HTMLDivElement | null>());
  // Set just before a keyboard-driven move so focus is restored onto the row
  // after it changes slots (DOM moves don't guarantee focus retention).
  const pendingFocusRef = useRef<SidebarSectionId | null>(null);

  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    rowRefs.current.get(pending)?.focus();
  }, [order]);

  const move = (id: SidebarSectionId, delta: number, viaKeyboard: boolean) => {
    if (viaKeyboard) pendingFocusRef.current = id;
    moveSection(id, delta);
  };

  return (
    <>
      {order.map((id, index) => {
        const first = index === 0;
        const last = index === order.length - 1;
        const hidden = id === "recent" && !showRecent;
        const name = sectionLabel(id);
        return (
          <DropdownMenuItem
            key={id}
            ref={(node) => {
              rowRefs.current.set(id, node);
            }}
            // Keep the menu open: reordering is iterative; closing per nudge
            // would force a reopen per slot.
            onSelect={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              if (!event.altKey) return;
              if (event.ctrlKey || event.metaKey || event.shiftKey) return;
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              const delta = event.key === "ArrowUp" ? -1 : 1;
              if ((delta < 0 && first) || (delta > 0 && last)) return;
              event.preventDefault();
              move(id, delta, true);
            }}
            aria-label={`${name} — ${index + 1} of ${order.length}`}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            className={cn("gap-2 py-1.5", hidden && "opacity-50")}
          >
            <span
              aria-hidden="true"
              className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded bg-primary/10 px-1 font-mono text-xs font-medium leading-none tabular-nums text-primary"
            >
              {index + 1}
            </span>
            <span aria-hidden="true" className="min-w-0 flex-1 truncate">
              {name}
            </span>
            {hidden && (
              <EyeOff aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                disabled={first}
                onClick={(event) => {
                  event.stopPropagation();
                  move(id, -1, false);
                }}
                title={copy.sectionMoveUp}
                aria-label={`${name} — ${copy.sectionMoveUp}`}
                className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-25"
              >
                <ChevronUp className="size-3.5" />
              </button>
              <button
                type="button"
                disabled={last}
                onClick={(event) => {
                  event.stopPropagation();
                  move(id, 1, false);
                }}
                title={copy.sectionMoveDown}
                aria-label={`${name} — ${copy.sectionMoveDown}`}
                className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-25"
              >
                <ChevronDown className="size-3.5" />
              </button>
            </span>
          </DropdownMenuItem>
        );
      })}
      <DropdownMenuShortcut className="px-3 pb-1 pt-0.5 text-right">
        {copy.sectionOrderHint}
      </DropdownMenuShortcut>
    </>
  );
}
