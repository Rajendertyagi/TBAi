import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Fixed sidebar action row (codeg `SidebarNavButton` geometry): full-width
 * pill, muted icon + truncated label, hover-revealed trailing element
 * (shortcut hint or count badge). One geometry for every fixed row.
 */
export function SidebarNavButton({
  className,
  active,
  ...props
}: ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex h-8 w-full items-center gap-2 rounded-full py-0 pl-2 pr-1.5",
        "text-sm font-semibold text-sidebar-foreground outline-none",
        "transition-colors duration-150 hover:bg-sidebar-accent",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        active && "bg-sidebar-primary/10",
        className,
      )}
      {...props}
    />
  );
}
