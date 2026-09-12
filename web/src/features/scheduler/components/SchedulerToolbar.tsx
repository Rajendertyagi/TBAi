import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { schedulerViewConfig } from "@/config/scheduler";

export type JobStatusFilter = "all" | "enabled" | "disabled";

/**
 * Scheduler page toolbar (codeg `PageToolbar` parity): borderless row —
 * status filter pills left, pill New Job right (detail mode only; the
 * gallery IS the creation flow and the editor has its own exits, so offering
 * New there would silently discard a draft). Title lives in the breadcrumb
 * strip above.
 */
export function SchedulerToolbar({
  statusFilter,
  onStatusFilter,
  showNew,
  onNew,
  unseenCount,
  onMarkSeen,
}: {
  statusFilter: JobStatusFilter;
  onStatusFilter: (v: JobStatusFilter) => void;
  showNew: boolean;
  onNew: () => void;
  unseenCount: number;
  onMarkSeen: () => void;
}) {
  const copy = schedulerViewConfig.copy;
  const pills: Array<{ id: JobStatusFilter; label: string }> = [
    { id: "all", label: copy.toolbarAll },
    { id: "enabled", label: copy.toolbarEnabled },
    { id: "disabled", label: copy.toolbarDisabled },
  ];

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-2 pt-4">
      <div role="group" aria-label={copy.toolbarAll} className="flex items-center gap-1">
        {pills.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onStatusFilter(p.id)}
            aria-pressed={statusFilter === p.id}
            className={cn(
              "h-8 rounded-full px-3 text-xs font-medium outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              statusFilter === p.id
                ? "bg-accent text-accent-foreground"
                : "bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex-1" />
      {unseenCount > 0 && (
        <button
          type="button"
          onClick={onMarkSeen}
          title={copy.markSeen}
          className="flex h-8 items-center rounded-full px-3 text-xs font-medium text-destructive outline-none transition-colors hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {copy.unseenFailures(unseenCount)} · {copy.markSeen}
        </button>
      )}
      {showNew && (
        <button
          type="button"
          onClick={onNew}
          className="flex h-8 items-center gap-1 rounded-full bg-primary px-3.5 text-xs font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <Plus aria-hidden="true" className="size-4" />
          {copy.newJob}
        </button>
      )}
    </div>
  );
}
