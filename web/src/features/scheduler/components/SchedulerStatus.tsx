import { cn } from "@/lib/utils";
import type { SchedulerJobStatus, SchedulerRunStatus } from "@/types";

/**
 * Status chip grammar for the scheduler (codeg `StatusChip` parity): one
 * pill shape, tone per status. Job statuses and run statuses share the
 * component; unknown statuses fall back to muted.
 */

const JOB_TONES: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  paused: "bg-muted text-muted-foreground",
  completed: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  missed: "bg-destructive/10 text-destructive",
  expired: "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground",
};

const RUN_TONES: Record<string, string> = {
  scheduled: "bg-muted text-muted-foreground",
  running: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  completed: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  skipped: "bg-muted text-muted-foreground",
  interrupted: "bg-destructive/10 text-destructive",
  missed: "bg-destructive/10 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};

function Chip({ tone, label }: { tone: string; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium",
        tone,
      )}
    >
      {label}
    </span>
  );
}

export function JobStatusChip({ status }: { status: SchedulerJobStatus }) {
  return (
    <Chip tone={JOB_TONES[status] ?? "bg-muted text-muted-foreground"} label={status} />
  );
}

export function RunStatusChip({ status }: { status: SchedulerRunStatus }) {
  return (
    <Chip tone={RUN_TONES[status] ?? "bg-muted text-muted-foreground"} label={status} />
  );
}

/** Dot color for list rows (muted when the job is disabled, else last-run tone). */
export function jobDotClass(enabled: boolean, lastRunStatus: string | null): string {
  if (!enabled) return "bg-muted-foreground/40";
  switch (lastRunStatus) {
    case "running":
      return "bg-amber-500";
    case "failed":
    case "interrupted":
    case "missed":
      return "bg-destructive";
    case "completed":
      return "bg-emerald-500";
    default:
      return "bg-emerald-500";
  }
}

/** Run-timeline node ring tint per status. */
export function runNodeRing(status: string): string {
  switch (status) {
    case "running":
      return "border-amber-500/50 text-amber-600 dark:text-amber-400";
    case "completed":
      return "border-emerald-500/50 text-emerald-600 dark:text-emerald-400";
    case "failed":
    case "interrupted":
    case "missed":
      return "border-destructive/50 text-destructive";
    default:
      return "border-border text-muted-foreground";
  }
}
