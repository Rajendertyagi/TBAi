import type { ReactNode } from "react";
import { ChevronDown, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/**
 * One collapsible sidebar section (Folders / Chats).
 *
 * The header is a 24px row: a chevron-first toggle that takes the remaining
 * width, and — when `actions` is provided — the section's actions as INLINE
 * trailing siblings. They used to be absolutely positioned over the right edge,
 * which put them directly on top of the chevron: clicking where the disclosure
 * arrow appeared could open a menu instead of toggling the section.
 *
 * Actions reveal on hover/focus (and always on touch). They are siblings of —
 * not nested in — the toggle button, so clicking an action never toggles.
 */
export function SidebarSection({
  id,
  label,
  count,
  expanded,
  onExpandedChange,
  actions,
  children,
}: {
  id: string;
  label: string;
  /** Total rows in this section (not the loaded page); omitted while unknown. */
  count?: number;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Collapsible open={expanded} onOpenChange={onExpandedChange} className="flex flex-col">
      <div className="group/section flex h-6 items-center gap-0.5">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={`sidebar-section-${id}`}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1 rounded-md py-0.5 pl-1.5 pr-1",
              "text-[13px] font-semibold text-foreground/90 tracking-wide",
              "transition-colors hover:text-foreground",
              "outline-none focus-visible:ring-1 focus-visible:ring-ring",
            )}
          >
            <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center">
              {id === "chats" ? (
                <>
                  <MessageSquare
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground/80 transition-opacity duration-150 group-hover/section:opacity-0 group-focus-within/section:opacity-0"
                  />
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      "absolute inset-0 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-all duration-150 group-hover/section:opacity-100 group-focus-within/section:opacity-100",
                      !expanded && "-rotate-90",
                    )}
                  />
                </>
              ) : (
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 shrink-0 transition-transform duration-150",
                    !expanded && "-rotate-90",
                  )}
                />
              )}
            </span>
            <span className="min-w-0 truncate">{label}</span>
            {count !== undefined && (
              <span className="ml-0.5 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-muted/70 px-1 text-3xs font-semibold tabular-nums text-muted-foreground">
                {count}
              </span>
            )}
          </button>
        </CollapsibleTrigger>
        {actions && (
          <div className="flex shrink-0 items-center pr-0.5 opacity-0 transition-opacity duration-150 group-hover/section:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            {actions}
          </div>
        )}
      </div>
      <CollapsibleContent id={`sidebar-section-${id}`} className="flex flex-col gap-0.5">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
