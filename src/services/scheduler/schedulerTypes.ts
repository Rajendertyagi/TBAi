/**
 * Built-in TBAi scheduler types.
 *
 * SQLite (`scheduler_jobs` / `scheduler_runs`) is the source of truth.
 * In-memory timer handles are an execution cache only.
 */

export type ScheduleType = "once" | "cron";
export type OverlapPolicy = "skip_if_running";
export type ConversationPolicy = "dedicated_thread" | "existing_thread";
export type ThinkingLevel = "off" | "low" | "medium" | "high";

export type JobStatus =
  | "active"
  | "paused"
  | "completed"
  | "missed"
  | "failed"
  | "cancelled"
  | "deleted";

export type RunStatus =
  | "scheduled"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "interrupted"
  | "missed"
  | "cancelled";

export interface SchedulerJob {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  scheduleType: ScheduleType;
  cronExpression: string | null;
  execAt: number | null;
  timezone: string;
  providerId: string;
  modelId: string;
  thinkingLevel: ThinkingLevel | null;
  workspacePath: string;
  prompt: string;
  conversationPolicy: ConversationPolicy;
  conversationId: string | null;
  overlapPolicy: OverlapPolicy;
  maxRetries: number;
  retryDelaySeconds: number;
  timeoutSeconds: number;
  missedGraceSeconds: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
}

export interface SchedulerRun {
  id: string;
  jobId: string;
  occurrenceId: string;
  requestId: string | null;
  startedAt: number;
  completedAt: number | null;
  status: RunStatus;
  error: string | null;
  outputExcerpt: string | null;
  providerId: string;
  modelId: string;
  workspacePath: string;
  conversationId: string | null;
  attempt: number;
  durationMs: number | null;
  createdAt: number;
}

export const TERMINAL_JOB_STATUSES: JobStatus[] = [
  "completed",
  "missed",
  "cancelled",
  "deleted",
];

export function isTerminalJobStatus(status: JobStatus): boolean {
  return (TERMINAL_JOB_STATUSES as string[]).includes(status);
}
