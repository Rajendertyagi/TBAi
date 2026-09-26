import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * One collapsible sidebar section (Folders / Chats / Recent / Archived).
 * Header is a full-width button (label + rotating chevron); collapsed state
 * is owned by the caller (persisted store), so this stays a controlled shadcn
 * `Collapsible` with no local state.
 *
 * When `actions` is provided, those buttons render at the right edge of the
 * header row, revealed only on hover/focus (and always on touch). They are
 * siblings of — not nested in — the toggle button, so clicking an action
 * never toggles the section.
 */
export function SidebarSection({
  id,
  label,
  expanded,
  onExpandedChange,
  actions,
  children,
}: {
  id: string;
  label: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Collapsible
      open={expanded}
      onOpenChange={onExpandedChange}
      className="flex flex-col"
    >
      <div className="group/section relative">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={`sidebar-section-${id}`}
            className={cn(
              "flex w-full items-center justify-between rounded-md px-3 py-1.5",
              "text-[13px] font-semibold text-foreground/90 tracking-wide",
              "transition-colors hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            )}
          >
            <span>{label}</span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-3.5 transition-transform duration-150",
                !expanded && "-rotate-90",
              )}
            />
          </button>
        </CollapsibleTrigger>
        {actions && (
          <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-px opacity-0 transition-opacity duration-150 group-hover/section:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            {actions}
          </div>
        )}
      </div>
      <CollapsibleContent
        id={`sidebar-section-${id}`}
        className="flex flex-col gap-0.5"
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
