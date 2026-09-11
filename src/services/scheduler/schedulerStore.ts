/**
 * Scheduler persistence: CRUD for jobs, claim/finish for runs.
 * The database is the source of truth; UNIQUE(job_id, occurrence_id)
 * is the duplicate-execution guard (no in-memory locking).
 */
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { db } from "../../db";
import { generateId } from "../../lib/utils";
import type {
  JobStatus,
  RunStatus,
  SchedulerJob,
  SchedulerRun,
} from "./schedulerTypes";

interface JobRow {
  id: string;
  name: string;
  description: string | null;
  enabled: number;
  schedule_type: string;
  cron_expression: string | null;
  exec_at: number | null;
  timezone: string;
  provider_id: string;
  model_id: string;
  thinking_level: string | null;
  workspace_path: string;
  prompt: string;
  conversation_policy: string;
  conversation_id: string | null;
  overlap_policy: string;
  max_retries: number;
  retry_delay_seconds: number;
  timeout_seconds: number;
  missed_grace_seconds: number;
  next_run_at: number | null;
  last_run_at: number | null;
  status: string;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  job_id: string;
  occurrence_id: string;
  request_id: string | null;
  started_at: number;
  completed_at: number | null;
  status: string;
  error: string | null;
  output_excerpt: string | null;
  provider_id: string;
  model_id: string;
  workspace_path: string;
  attempt: number;
  duration_ms: number | null;
  created_at: number;
}

function mapJob(row: JobRow): SchedulerJob {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    scheduleType: row.schedule_type as SchedulerJob["scheduleType"],
    cronExpression: row.cron_expression,
    execAt: row.exec_at,
    timezone: row.timezone,
    providerId: row.provider_id,
    modelId: row.model_id,
    thinkingLevel: row.thinking_level as SchedulerJob["thinkingLevel"],
    workspacePath: row.workspace_path,
    prompt: row.prompt,
    conversationPolicy:
      row.conversation_policy as SchedulerJob["conversationPolicy"],
    conversationId: row.conversation_id,
    overlapPolicy: row.overlap_policy as SchedulerJob["overlapPolicy"],
    maxRetries: row.max_retries,
    retryDelaySeconds: row.retry_delay_seconds,
    timeoutSeconds: row.timeout_seconds,
    missedGraceSeconds: row.missed_grace_seconds,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    status: row.status as JobStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: RunRow): SchedulerRun {
  return {
    id: row.id,
    jobId: row.job_id,
    occurrenceId: row.occurrence_id,
    requestId: row.request_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status as RunStatus,
    error: row.error,
    outputExcerpt: row.output_excerpt,
    providerId: row.provider_id,
    modelId: row.model_id,
    workspacePath: row.workspace_path,
    attempt: row.attempt,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

export interface JobCreate {
  name: string;
  description?: string | null;
  enabled?: boolean;
  scheduleType: "once" | "cron";
  cronExpression?: string | null;
  execAt?: number | null;
  timezone: string;
  providerId: string;
  modelId: string;
  thinkingLevel?: "off" | "low" | "medium" | "high" | null;
  workspacePath: string;
  prompt: string;
  conversationPolicy?: "dedicated_thread";
  overlapPolicy?: "skip_if_running";
  maxRetries?: number;
  retryDelaySeconds?: number;
  timeoutSeconds?: number;
  missedGraceSeconds?: number;
}

export type JobUpdate = Partial<JobCreate> & {
  status?: JobStatus;
  nextRunAt?: number | null;
  lastRunAt?: number | null;
  conversationId?: string | null;
};

const JOB_COLUMNS = `id, name, description, enabled, schedule_type, cron_expression,
  exec_at, timezone, provider_id, model_id, thinking_level, workspace_path, prompt,
  conversation_policy, conversation_id, overlap_policy, max_retries,
  retry_delay_seconds, timeout_seconds, missed_grace_seconds, next_run_at,
  last_run_at, status, created_at, updated_at`;

export const schedulerStore = {
  create(input: JobCreate, database: Database = db): SchedulerJob {
    const now = Date.now();
    const id = generateId();
    database.run(
      `INSERT INTO scheduler_jobs (${JOB_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.description ?? null,
        input.enabled === false ? 0 : 1,
        input.scheduleType,
        input.cronExpression ?? null,
        input.execAt ?? null,
        input.timezone,
        input.providerId,
        input.modelId,
        input.thinkingLevel ?? null,
        input.workspacePath,
        input.prompt,
        input.conversationPolicy ?? "dedicated_thread",
        null,
        input.overlapPolicy ?? "skip_if_running",
        input.maxRetries ?? 0,
        input.retryDelaySeconds ?? 60,
        input.timeoutSeconds ?? 600,
        input.missedGraceSeconds ?? 600,
        null,
        null,
        "active",
        now,
        now,
      ],
    );
    const created = this.get(id, database);
    if (!created) throw new Error("Failed to create scheduler job");
    return created;
  },

  get(id: string, database: Database = db): SchedulerJob | null {
    const row = database
      .query<JobRow, SQLQueryBindings[]>(
        `SELECT ${JOB_COLUMNS} FROM scheduler_jobs WHERE id = ?`,
      )
      .get(id);
    return row ? mapJob(row) : null;
  },

  list(database: Database = db): SchedulerJob[] {
    const rows = database
      .query<JobRow, SQLQueryBindings[]>(
        `SELECT ${JOB_COLUMNS} FROM scheduler_jobs ORDER BY created_at DESC`,
      )
      .all();
    return rows.map(mapJob);
  },

  listEnabled(database: Database = db): SchedulerJob[] {
    const rows = database
      .query<JobRow, SQLQueryBindings[]>(
        `SELECT ${JOB_COLUMNS} FROM scheduler_jobs WHERE enabled = 1 AND status = 'active' ORDER BY created_at DESC`,
      )
      .all();
    return rows.map(mapJob);
  },

  update(
    id: string,
    patch: JobUpdate,
    database: Database = db,
  ): SchedulerJob | null {
    const sets: string[] = [];
    const values: SQLQueryBindings[] = [];
    const push = (col: string, v: SQLQueryBindings): void => {
      sets.push(`${col} = ?`);
      values.push(v);
    };
    if (patch.name !== undefined) push("name", patch.name);
    if (patch.description !== undefined) push("description", patch.description);
    if (patch.enabled !== undefined) push("enabled", patch.enabled ? 1 : 0);
    if (patch.scheduleType !== undefined) push("schedule_type", patch.scheduleType);
    if (patch.cronExpression !== undefined) push("cron_expression", patch.cronExpression);
    if (patch.execAt !== undefined) push("exec_at", patch.execAt);
    if (patch.timezone !== undefined) push("timezone", patch.timezone);
    if (patch.providerId !== undefined) push("provider_id", patch.providerId);
    if (patch.modelId !== undefined) push("model_id", patch.modelId);
    if (patch.thinkingLevel !== undefined) push("thinking_level", patch.thinkingLevel);
    if (patch.workspacePath !== undefined) push("workspace_path", patch.workspacePath);
    if (patch.prompt !== undefined) push("prompt", patch.prompt);
    if (patch.conversationPolicy !== undefined) push("conversation_policy", patch.conversationPolicy);
    if (patch.conversationId !== undefined) push("conversation_id", patch.conversationId);
    if (patch.overlapPolicy !== undefined) push("overlap_policy", patch.overlapPolicy);
    if (patch.maxRetries !== undefined) push("max_retries", patch.maxRetries);
    if (patch.retryDelaySeconds !== undefined) push("retry_delay_seconds", patch.retryDelaySeconds);
    if (patch.timeoutSeconds !== undefined) push("timeout_seconds", patch.timeoutSeconds);
    if (patch.missedGraceSeconds !== undefined) push("missed_grace_seconds", patch.missedGraceSeconds);
    if (patch.nextRunAt !== undefined) push("next_run_at", patch.nextRunAt);
    if (patch.lastRunAt !== undefined) push("last_run_at", patch.lastRunAt);
    if (patch.status !== undefined) push("status", patch.status);
    push("updated_at", Date.now());
    values.push(id);
    database.run(
      `UPDATE scheduler_jobs SET ${sets.join(", ")} WHERE id = ?`,
      values,
    );
    return this.get(id, database);
  },

  remove(id: string, database: Database = db): void {
    database.run("DELETE FROM scheduler_runs WHERE job_id = ?", [id]);
    database.run("DELETE FROM scheduler_jobs WHERE id = ?", [id]);
  },

  /**
   * Atomically claim an occurrence. Returns the new run, or null when the
   * (job_id, occurrence_id) pair was already claimed (duplicate fire).
   */
  claimRun(
    job: SchedulerJob,
    occurrenceId: string,
    requestId: string,
    database: Database = db,
  ): SchedulerRun | null {
    const now = Date.now();
    const id = generateId();
    try {
      database.run(
        `INSERT INTO scheduler_runs
          (id, job_id, occurrence_id, request_id, started_at, completed_at, status,
           error, output_excerpt, provider_id, model_id, workspace_path, attempt,
           duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'running', NULL, NULL, ?, ?, ?, 0, NULL, ?)`,
        [
          id,
          job.id,
          occurrenceId,
          requestId,
          now,
          job.providerId,
          job.modelId,
          job.workspacePath,
          now,
        ],
      );
    } catch {
      // UNIQUE(job_id, occurrence_id) conflict → already claimed.
      return null;
    }
    const row = database
      .query<RunRow, SQLQueryBindings[]>(
        "SELECT * FROM scheduler_runs WHERE id = ?",
      )
      .get(id);
    return row ? mapRun(row) : null;
  },

  /** Insert a terminal informational run (skipped/missed/cancelled). */
  recordTerminalRun(
    job: SchedulerJob,
    occurrenceId: string,
    status: RunStatus,
    error: string | null,
    requestId: string | null = null,
    database: Database = db,
  ): SchedulerRun | null {
    const now = Date.now();
    const id = generateId();
    try {
      database.run(
        `INSERT INTO scheduler_runs
          (id, job_id, occurrence_id, request_id, started_at, completed_at, status,
           error, output_excerpt, provider_id, model_id, workspace_path, attempt,
           duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, 0, ?)`,
        [
          id,
          job.id,
          occurrenceId,
          requestId,
          now,
          now,
          status,
          error,
          job.providerId,
          job.modelId,
          job.workspacePath,
          now,
        ],
      );
    } catch {
      return null;
    }
    const row = database
      .query<RunRow, SQLQueryBindings[]>(
        "SELECT * FROM scheduler_runs WHERE id = ?",
      )
      .get(id);
    return row ? mapRun(row) : null;
  },

  updateRun(
    id: string,
    patch: Partial<Pick<
      SchedulerRun,
      "status" | "error" | "outputExcerpt" | "attempt" | "completedAt" | "durationMs"
    >>,
    database: Database = db,
  ): void {
    const sets: string[] = [];
    const values: SQLQueryBindings[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.error !== undefined) {
      sets.push("error = ?");
      values.push(patch.error);
    }
    if (patch.outputExcerpt !== undefined) {
      sets.push("output_excerpt = ?");
      values.push(patch.outputExcerpt);
    }
    if (patch.attempt !== undefined) {
      sets.push("attempt = ?");
      values.push(patch.attempt);
    }
    if (patch.completedAt !== undefined) {
      sets.push("completed_at = ?");
      values.push(patch.completedAt);
    }
    if (patch.durationMs !== undefined) {
      sets.push("duration_ms = ?");
      values.push(patch.durationMs);
    }
    if (sets.length === 0) return;
    values.push(id);
    database.run(
      `UPDATE scheduler_runs SET ${sets.join(", ")} WHERE id = ?`,
      values,
    );
  },

  getRun(id: string, database: Database = db): SchedulerRun | null {
    const row = database
      .query<RunRow, SQLQueryBindings[]>(
        "SELECT * FROM scheduler_runs WHERE id = ?",
      )
      .get(id);
    return row ? mapRun(row) : null;
  },

  listRuns(
    jobId: string,
    limit = 50,
    offset = 0,
    database: Database = db,
  ): { runs: SchedulerRun[]; total: number } {
    const rows = database
      .query<RunRow, SQLQueryBindings[]>(
        "SELECT * FROM scheduler_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?",
      )
      .all(jobId, limit, offset);
    const totalRow = database
      .query<{ c: number }, SQLQueryBindings[]>(
        "SELECT COUNT(*) as c FROM scheduler_runs WHERE job_id = ?",
      )
      .get(jobId);
    return {
      runs: rows.map(mapRun),
      total: totalRow?.c ?? 0,
    };
  },

  listRecentRuns(
    limit = 100,
    offset = 0,
    database: Database = db,
  ): { runs: SchedulerRun[]; total: number } {
    const rows = database
      .query<RunRow, SQLQueryBindings[]>(
        "SELECT * FROM scheduler_runs ORDER BY started_at DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset);
    const totalRow = database
      .query<{ c: number }, SQLQueryBindings[]>(
        "SELECT COUNT(*) as c FROM scheduler_runs",
      )
      .get();
    return {
      runs: rows.map(mapRun),
      total: totalRow?.c ?? 0,
    };
  },

  hasRunningRun(jobId: string, database: Database = db): boolean {
    const row = database
      .query<{ c: number }, SQLQueryBindings[]>(
        "SELECT COUNT(*) as c FROM scheduler_runs WHERE job_id = ? AND status = 'running'",
      )
      .get(jobId);
    return (row?.c ?? 0) > 0;
  },

  /** Mark runs orphaned by a previous shutdown as interrupted. Returns count. */
  markInterrupted(database: Database = db): number {
    const now = Date.now();
    database.run(
      "UPDATE scheduler_runs SET status = 'interrupted', completed_at = ?, error = 'Interrupted by server shutdown or restart' WHERE status IN ('running', 'scheduled')",
      [now],
    );
    // bun:sqlite reports changes via a follow-up query.
    const row = database
      .query<{ c: number }, SQLQueryBindings[]>(
        "SELECT COUNT(*) as c FROM scheduler_runs WHERE status = 'interrupted'",
      )
      .get();
    return row?.c ?? 0;
  },
};
