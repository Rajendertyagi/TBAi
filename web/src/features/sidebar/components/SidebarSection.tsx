import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * One collapsible sidebar section (Chats / Recent / Archived). Header is a
 * full-width button (label + rotating chevron); collapsed state is owned by
 * the caller (persisted store), so this stays a controlled shadcn
 * `Collapsible` with no local state.
 */
export function SidebarSection({
  id,
  label,
  expanded,
  onExpandedChange,
  children,
}: {
  id: string;
  label: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible
      open={expanded}
      onOpenChange={onExpandedChange}
      className="flex flex-col"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`sidebar-section-${id}`}
          className={cn(
            "flex w-full items-center justify-between rounded-md px-3 py-1.5",
            "text-xs font-medium text-muted-foreground",
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
      <CollapsibleContent
        id={`sidebar-section-${id}`}
        className="flex flex-col gap-0.5"
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
