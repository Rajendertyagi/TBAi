import { Fragment, useState, type ElementType } from "react";
import { Copy, Loader2, MoreHorizontal, Pencil, Play, Power, PowerOff, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { schedulerViewConfig } from "@/config/scheduler";
import { formatRelative, formatRelativePast } from "@/features/scheduler/lib/scheduler-format";
import { jobDotClass } from "@/features/scheduler/components/SchedulerStatus";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { SchedulerJobPublic } from "@/types";

interface RowAction {
  key: string;
  icon: React.ReactNode;
  label: string;
  onSelect: () => void;
  variant?: "default" | "destructive";
  separatorBefore?: boolean;
}

/**
 * One scheduler job as a pill row (codeg `AutomationListItem` parity):
 * status dot + name + relative time (spinner while running), hover ⋯ menu.
 * The ⋯ dropdown and the right-click menu render the SAME action list from
 * one definition. Delete confirms via dialog (opened on a tick so menu
 * focus-restoration can't self-dismiss it).
 */
export function JobListItem({
  job,
  running,
  now,
  selected,
  onSelect,
  onRunNow,
  onToggleEnabled,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  job: SchedulerJobPublic;
  running: boolean;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onRunNow: () => void;
  onToggleEnabled: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const copy = schedulerViewConfig.copy;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const timeLabel = running
    ? null
    : job.enabled && job.nextRunAt
      ? formatRelative(job.nextRunAt, now)
      : job.lastRunAt
        ? formatRelativePast(job.lastRunAt, now)
        : null;

  const actions: RowAction[] = [
    {
      key: "run",
      icon: <Play aria-hidden="true" className="size-4" />,
      label: copy.runNow,
      onSelect: onRunNow,
    },
    {
      key: "toggle",
      icon: job.enabled ? (
        <PowerOff aria-hidden="true" className="size-4" />
      ) : (
        <Power aria-hidden="true" className="size-4" />
      ),
      label: job.enabled ? copy.disable : copy.enable,
      onSelect: onToggleEnabled,
    },
    {
      key: "edit",
      icon: <Pencil aria-hidden="true" className="size-4" />,
      label: copy.edit,
      onSelect: onEdit,
    },
    {
      key: "duplicate",
      icon: <Copy aria-hidden="true" className="size-4" />,
      label: copy.duplicate,
      onSelect: onDuplicate,
    },
    {
      key: "delete",
      icon: <Trash2 aria-hidden="true" className="size-4" />,
      label: copy.delete,
      onSelect: () => setTimeout(() => setConfirmOpen(true), 0),
      variant: "destructive",
      separatorBefore: true,
    },
  ];

  const renderActions = (Item: ElementType, Separator: ElementType) =>
    actions.map((a) => (
      <Fragment key={a.key}>
        {a.separatorBefore ? <Separator /> : null}
        <Item variant={a.variant} onSelect={a.onSelect}>
          {a.icon}
          {a.label}
        </Item>
      </Fragment>
    ));

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              // Border always in the box (transparent when unselected) so
              // selecting never shifts row height.
              "group flex h-8 w-full items-center rounded-full border pr-1 transition-colors",
              selected
                ? "border-border bg-accent"
                : "border-transparent hover:bg-accent/60",
            )}
          >
            <button
              type="button"
              onClick={onSelect}
              title={job.name}
              className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-full pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "block size-1.5 shrink-0 rounded-full ring-2 ring-background",
                  jobDotClass(job.enabled, running ? "running" : null),
                )}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  job.enabled
                    ? "font-medium"
                    : "font-normal text-muted-foreground",
                )}
              >
                {job.name}
              </span>
            </button>

            <div className="flex shrink-0 items-center gap-0.5 pl-1">
              {/* Time yields to the ⋯ affordance on hover / focus / open. */}
              <span
                className={cn(
                  "flex items-center group-hover:hidden group-focus-within:hidden",
                  menuOpen && "hidden",
                )}
              >
                {running ? (
                  <Loader2
                    aria-hidden="true"
                    className="size-3.5 animate-spin text-amber-600 dark:text-amber-400"
                  />
                ) : timeLabel ? (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
                    {timeLabel}
                  </span>
                ) : null}
              </span>

              <DropdownMenu onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="hidden justify-end text-muted-foreground/80 hover:bg-transparent hover:text-foreground group-hover:flex group-focus-within:flex data-[state=open]:flex dark:hover:bg-transparent"
                    aria-label={copy.moreActions}
                  >
                    <MoreHorizontal aria-hidden="true" className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  {renderActions(DropdownMenuItem, DropdownMenuSeparator)}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </ContextMenuTrigger>
        {/* Right-click anywhere on the row opens the same actions as ⋯. */}
        <ContextMenuContent className="w-40">
          {renderActions(ContextMenuItem, ContextMenuSeparator)}
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {copy.deleteDescription(job.name)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete}>
              {copy.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
