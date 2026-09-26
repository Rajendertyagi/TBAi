"use client";

import { useMemo, useState } from "react";
import { CheckCircle2Icon, ChevronDown, ChevronRight, CircleIcon, ListTodo, LoaderIcon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOptionalV2RuntimeExtras } from "./v2RuntimeExtras";
import type { OpenCodeTodo } from "./v2Todos";
import { cn } from "@/lib/utils";

function TaskStatusIcon({ status }: { status: OpenCodeTodo["status"] }) {
  if (status === "in_progress") return <LoaderIcon className="h-3.5 w-3.5 animate-spin text-primary shrink-0" aria-label="In progress" />;
  if (status === "completed") return <CheckCircle2Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-label="Completed" />;
  if (status === "cancelled") return <XCircleIcon className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" aria-label="Cancelled" />;
  return <CircleIcon className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" aria-label="Pending" />;
}

/** Ambient task tracker derived from the latest native todowrite tool call. */
export function OpenCodeTodoTracker({ className }: { sessionId?: string; className?: string }) {
  const extras = useOptionalV2RuntimeExtras();
  const [expanded, setExpanded] = useState(true);
  const todos = extras?.todos ?? [];
  const stats = useMemo(() => ({ completed: todos.filter((todo) => todo.status === "completed").length, inProgress: todos.filter((todo) => todo.status === "in_progress").length, cancelled: todos.filter((todo) => todo.status === "cancelled").length, total: todos.length }), [todos]);
  if (!extras || todos.length === 0) return null;
  const allCompleted = stats.completed === stats.total;
  return <div className={cn("mx-auto w-full max-w-3xl px-4 py-1.5", className)}><div className="rounded-lg border border-border/70 bg-card/60 p-2.5 text-xs shadow-xs transition-colors"><div className="flex items-center justify-between gap-2"><Button type="button" variant="ghost" size="xs" onClick={() => setExpanded((open) => !open)} className="h-auto -ml-1 gap-1.5 p-1 text-xs font-medium text-foreground hover:bg-accent/50" aria-expanded={expanded} aria-label={`Toggle task list: ${stats.completed}/${stats.total} completed`}>{allCompleted ? <CheckCircle2Icon className="size-3.5 text-muted-foreground shrink-0" /> : stats.inProgress > 0 ? <LoaderIcon className="size-3.5 animate-spin text-primary shrink-0" /> : <ListTodo className="size-3.5 text-muted-foreground shrink-0" />}<span>Tasks · {stats.completed}/{stats.total}</span>{stats.cancelled > 0 && <span className="text-[11px] text-muted-foreground/70">({stats.cancelled} cancelled)</span>}{expanded ? <ChevronDown className="size-3 text-muted-foreground/60 shrink-0" /> : <ChevronRight className="size-3 text-muted-foreground/60 shrink-0" />}</Button><span className="text-[10px] tabular-nums text-muted-foreground">{stats.completed}/{stats.total} completed</span></div>{expanded && <div className="mt-2 border-t border-border/40 pt-2"><ul className="max-h-56 space-y-1 overflow-y-auto pr-1">{todos.map((item, index) => <li key={`${item.content}:${index}`} className="flex items-center gap-2 text-xs"><TaskStatusIcon status={item.status} /><span className={cn("break-words", item.status === "completed" && "line-through text-muted-foreground/60", item.status === "cancelled" && "line-through text-muted-foreground/40 italic", item.status === "in_progress" && "font-medium text-foreground", item.status === "pending" && "text-foreground/90")}>{item.content}</span></li>)}</ul></div>}</div></div>;
}
