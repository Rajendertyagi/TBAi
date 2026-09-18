"use client";

import { useMemo, useState } from "react";
import { CheckCircle2Icon, ChevronDown, ChevronRight, CircleIcon, ListTodo, LoaderIcon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOpenCodeTodos, type OpenCodeTodo } from "./todoState";
import { cn } from "@/lib/utils";

/**
 * Status icon using the official assistant-ui todo-list visual language:
 * pending -> CircleIcon
 * in_progress -> LoaderIcon (animate-spin)
 * completed -> CheckCircle2Icon
 * cancelled -> XCircleIcon
 */
function TaskStatusIcon({ status }: { status: OpenCodeTodo["status"] }) {
  switch (status) {
    case "in_progress":
      return <LoaderIcon className="h-3.5 w-3.5 animate-spin text-primary shrink-0" aria-label="In progress" />;
    case "completed":
      return <CheckCircle2Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-label="Completed" />;
    case "cancelled":
      return <XCircleIcon className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" aria-label="Cancelled" />;
    case "pending":
    default:
      return <CircleIcon className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" aria-label="Pending" />;
  }
}

interface OpenCodeTodoTrackerProps {
  sessionId: string | undefined;
  className?: string;
}

/**
 * Ambient task progress tracker for the active OpenCode session.
 *
 * Invariant:
 * - Unidirectional flow: reads `useOpenCodeTodos(sessionId)` ONLY.
 * - Distinct states:
 *   - undefined -> not loaded yet -> renders null
 *   - [] -> loaded and authoritative empty -> renders null
 *   - non-empty -> directly visible task list in session UI (no popover needed)
 * - Directly incorporates assistant-ui element visual conventions (elements/todo-list.tsx).
 * - Shows progress count: "Tasks · X/Y".
 * - Default expanded, with collapse toggle.
 */
export function OpenCodeTodoTracker({ sessionId, className }: OpenCodeTodoTrackerProps) {
  const todos = useOpenCodeTodos(sessionId);
  const [expanded, setExpanded] = useState(true);

  const stats = useMemo(() => {
    // Explicitly distinguish undefined (not loaded) and [] (empty):
    if (todos === undefined || todos.length === 0) return null;
    const completed = todos.filter((t) => t.status === "completed").length;
    const inProgress = todos.filter((t) => t.status === "in_progress").length;
    const cancelled = todos.filter((t) => t.status === "cancelled").length;
    const total = todos.length;
    return { completed, inProgress, cancelled, total };
  }, [todos]);

  // If not loaded yet (undefined) or authoritatively empty ([]), render nothing
  if (!todos || todos.length === 0 || !stats) {
    return null;
  }

  const allCompleted = stats.completed === stats.total;
  const hasActive = stats.inProgress > 0;

  return (
    <div
      className={cn(
        "mx-auto w-full max-w-3xl px-4 py-1.5",
        className,
      )}
    >
      <div className="rounded-lg border border-border/70 bg-card/60 p-2.5 text-xs shadow-xs transition-colors">
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setExpanded((open) => !open)}
            className="h-auto -ml-1 gap-1.5 p-1 text-xs font-medium text-foreground hover:bg-accent/50"
            aria-expanded={expanded}
            aria-label={`Toggle task list: ${stats.completed}/${stats.total} completed`}
          >
            {allCompleted ? (
              <CheckCircle2Icon className="size-3.5 text-muted-foreground shrink-0" />
            ) : hasActive ? (
              <LoaderIcon className="size-3.5 animate-spin text-primary shrink-0" />
            ) : (
              <ListTodo className="size-3.5 text-muted-foreground shrink-0" />
            )}
            <span>Tasks · {stats.completed}/{stats.total}</span>
            {stats.cancelled > 0 && (
              <span className="text-[11px] text-muted-foreground/70">
                ({stats.cancelled} cancelled)
              </span>
            )}
            {expanded ? (
              <ChevronDown className="size-3 text-muted-foreground/60 shrink-0" />
            ) : (
              <ChevronRight className="size-3 text-muted-foreground/60 shrink-0" />
            )}
          </Button>

          <span className="text-[10px] tabular-nums text-muted-foreground">
            {stats.completed}/{stats.total} completed
          </span>
        </div>

        {expanded && (
          <div className="mt-2 border-t border-border/40 pt-2">
            <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
              {todos.map((item, idx) => (
                <li key={idx} className="flex items-center gap-2 text-xs">
                  <TaskStatusIcon status={item.status} />
                  <span
                    className={cn(
                      "break-words",
                      item.status === "completed" && "line-through text-muted-foreground/60",
                      item.status === "cancelled" && "line-through text-muted-foreground/40 italic",
                      item.status === "in_progress" && "text-foreground font-medium",
                      item.status === "pending" && "text-foreground/90",
                    )}
                  >
                    {item.content}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
