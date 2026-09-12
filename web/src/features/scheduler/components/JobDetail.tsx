import { useState } from "react";
import {
  Bot,
  CalendarClock,
  Clock,
  Copy,
  History,
  MessageSquare,
  Pencil,
  Play,
  FolderCog,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { schedulerViewConfig } from "@/config/scheduler";
import {
  formatDuration,
  formatRelative,
  formatRelativePast,
  formatTime,
} from "@/features/scheduler/lib/scheduler-format";
import {
  JobStatusChip,
  RunStatusChip,
  runNodeRing,
} from "@/features/scheduler/components/SchedulerStatus";
import { Button } from "@/components/ui/button";
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
import type { SchedulerJobPublic, SchedulerRun } from "@/types";

/** One fact — icon + uppercase label over the value. Deliberately not a card. */
function StatItem({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1.5 text-muted-foreground [&>svg]:size-3.5">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">
          {label}
        </span>
      </div>
      <div className="min-w-0 truncate text-sm">{children}</div>
    </div>
  );
}

function scheduleText(job: SchedulerJobPublic): string {
  if (job.scheduleType === "once") {
    return job.execAt ? formatTime(job.execAt) : "Once";
  }
  return job.cronExpression ?? "Repeat";
}

/**
 * Detail pane for the selected job (codeg `AutomationDetail` parity): stat
 * facts, actions, and the full run timeline with per-run detail. Blocks are
 * separated by rules, never nested cards.
 */
export function JobDetail({
  job,
  runs,
  running,
  now,
  aiLabel,
  conversationLabel,
  conversationId,
  loadingRuns,
  selectedRunId,
  onSelectRun,
  onEdit,
  onRunNow,
  onToggleEnabled,
  onDuplicate,
  onDelete,
  onCancelRun,
  onRefreshHistory,
  onOpenThread,
}: {
  job: SchedulerJobPublic;
  runs: SchedulerRun[];
  running: boolean;
  now: number;
  aiLabel: string;
  conversationLabel: string | null;
  conversationId: string | null;
  loadingRuns: boolean;
  selectedRunId: string | null;
  onSelectRun: (run: SchedulerRun | null) => void;
  onEdit: () => void;
  onRunNow: () => void;
  onToggleEnabled: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onCancelRun: (runId: string) => void;
  onRefreshHistory: () => void;
  onOpenThread: (conversationId: string) => void;
}) {
  const copy = schedulerViewConfig.copy;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const lastRun = runs[0] ?? null;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      {/* Header: name + status + actions */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
          {job.name}
        </h2>
        <JobStatusChip status={job.status} />
        {!job.enabled && (
          <span className="text-xs text-muted-foreground">({copy.disabledSuffix})</span>
        )}
      </div>
      {job.description && (
        <p className="-mt-2 text-sm text-muted-foreground">{job.description}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onRunNow} disabled={running}>
          <Play aria-hidden="true" className="size-3.5" />
          {copy.runNow}
        </Button>
        <Button size="sm" variant="outline" onClick={onEdit}>
          <Pencil aria-hidden="true" className="size-3.5" />
          {copy.edit}
        </Button>
        <Button size="sm" variant="ghost" onClick={onToggleEnabled}>
          {job.enabled ? copy.disable : copy.enable}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDuplicate}>
          <Copy aria-hidden="true" className="size-3.5" />
          {copy.duplicate}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() => setTimeout(() => setConfirmOpen(true), 0)}
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
          {copy.delete}
        </Button>
      </div>

      {/* Facts */}
      <section className="grid grid-cols-2 gap-3 border-t border-border pt-4 sm:grid-cols-3">
        <StatItem icon={<Clock aria-hidden="true" />} label={copy.factsSchedule}>
          <span title={scheduleText(job)}>{scheduleText(job)}</span>
        </StatItem>
        <StatItem icon={<CalendarClock aria-hidden="true" />} label={copy.factsNextRun}>
          {job.enabled && job.nextRunAt ? formatRelative(job.nextRunAt, now) : "—"}
        </StatItem>
        <StatItem icon={<History aria-hidden="true" />} label={copy.factsLastRun}>
          <span className="inline-flex items-center gap-1.5">
            {lastRun ? formatRelativePast(lastRun.startedAt, now) : "—"}
            {lastRun && <RunStatusChip status={lastRun.status} />}
          </span>
        </StatItem>
        <StatItem icon={<Bot aria-hidden="true" />} label={copy.factsAi}>
          <span title={aiLabel}>{aiLabel}</span>
        </StatItem>
        <StatItem icon={<FolderCog aria-hidden="true" />} label={copy.factsWorkspace}>
          <span title={job.workspacePath}>{job.workspacePath}</span>
        </StatItem>
        <StatItem icon={<MessageSquare aria-hidden="true" />} label={copy.factsConversation}>
          {conversationId ? (
            <button
              type="button"
              onClick={() => onOpenThread(conversationId)}
              title={conversationLabel ?? conversationId}
              className="truncate rounded text-primary underline outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {conversationLabel ?? conversationId}
            </button>
          ) : (
            <span>{conversationLabel ?? copy.factsDedicatedThread}</span>
          )}
        </StatItem>
      </section>

      {/* Run history timeline */}
      <section className="flex min-h-0 flex-col gap-3 border-t border-border pt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {copy.historyTitle}
          </h3>
          <Button
            size="sm"
            variant="ghost"
            onClick={onRefreshHistory}
            title={copy.historyRefresh}
            aria-label={copy.historyRefresh}
          >
            <History aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
        {loadingRuns && runs.length === 0 ? (
          <div className="space-y-2" aria-label="Loading runs">
            {[0, 1].map((i) => (
              <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{copy.historyEmpty}</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {runs.map((run) => {
              const manual = run.occurrenceId.startsWith("manual-");
              const selected = run.id === selectedRunId;
              return (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => onSelectRun(selected ? null : run)}
                    aria-expanded={selected}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs outline-none transition-colors hover:bg-muted/60",
                      "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      selected && "bg-muted/60",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-full border bg-background",
                        runNodeRing(run.status),
                      )}
                      title={manual ? copy.runManual : copy.runScheduled}
                    >
                      {manual ? (
                        <Play className="size-3" />
                      ) : (
                        <Clock className="size-3" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate tabular-nums">
                        {formatTime(run.startedAt)}
                      </span>
                      <span className="block truncate text-muted-foreground">
                        {formatDuration(run.durationMs)}
                        {run.error ? ` · ${run.error}` : ""}
                      </span>
                    </span>
                    <RunStatusChip status={run.status} />
                  </button>
                  {selected && (
                    <div className="ml-4 space-y-1 border-l border-border py-2 pl-4 text-xs">
                      <div>
                        <span className="text-muted-foreground">runId: </span>
                        <span className="break-all">{run.id}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">occurrence: </span>
                        {run.occurrenceId}
                      </div>
                      {run.error && (
                        <div>
                          <span className="text-muted-foreground">{copy.runError}: </span>
                          <span className="break-words text-destructive">{run.error}</span>
                        </div>
                      )}
                      {run.outputExcerpt && (
                        <div>
                          <span className="text-muted-foreground">{copy.runOutput}: </span>
                          <span className="break-words">
                            {run.outputExcerpt.slice(0, 500)}
                          </span>
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <span className="text-muted-foreground">
                          {copy.runAttempt(run.attempt)}
                        </span>
                        {run.conversationId && (
                          <button
                            type="button"
                            onClick={() => onOpenThread(run.conversationId as string)}
                            className="rounded text-primary underline outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            {copy.openThread}
                          </button>
                        )}
                        {run.status === "running" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onCancelRun(run.id)}
                          >
                            {copy.cancelRun}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

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
    </div>
  );
}
