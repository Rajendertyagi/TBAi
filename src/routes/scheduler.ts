/**
 * Built-in scheduler REST boundary: /api/scheduler/* (Zod-validated).
 * The browser never sends secrets or timer state — only job configuration.
 */
import { Hono } from "hono";
import { db } from "../db";
import { registry } from "../config/providers";
import { logger } from "../lib/logger";
import {
  schedulerJobCreateSchema,
  schedulerJobUpdateSchema,
  schedulerPreviewSchema,
} from "../lib/validation";
import { schedulerStore } from "../services/scheduler/schedulerStore";
import type { JobCreate } from "../services/scheduler/schedulerStore";
import {
  runJobNow,
  scheduleJob,
  unscheduleJob,
} from "../services/scheduler/scheduler";
import {
  assertValidTimezone,
  computeNextRuns,
  describeCron,
  isValidCron,
} from "../services/scheduler/cron";
import { isTerminalJobStatus } from "../services/scheduler/schedulerTypes";
import type { SchedulerJob } from "../services/scheduler/schedulerTypes";

const app = new Hono();

/** List/detail views never dump full prompts — preview + length only. */
function toJobPublic(job: SchedulerJob) {
  const { prompt, ...rest } = job;
  return {
    ...rest,
    promptPreview: prompt.slice(0, 200),
    promptLength: prompt.length,
  };
}

function fullJobPublic(job: SchedulerJob) {
  return { ...job };
}

function checkScheduleFields(value: {
  scheduleType?: string;
  cronExpression?: string | null;
  execAt?: number | null;
  timezone?: string;
}): string | null {
  if (value.timezone !== undefined) {
    try {
      assertValidTimezone(value.timezone);
    } catch {
      return `Invalid IANA timezone: "${value.timezone}"`;
    }
  }
  if (value.scheduleType === "cron") {
    if (!value.cronExpression || !isValidCron(value.cronExpression)) {
      return "A valid 5-field cron expression is required for recurring jobs";
    }
    if (value.execAt != null) {
      return "One-time execAt must not be set on a recurring job";
    }
  }
  if (value.scheduleType === "once") {
    if (typeof value.execAt !== "number" || value.execAt <= 0) {
      return "An absolute execAt timestamp is required for one-time jobs";
    }
    if (value.cronExpression != null) {
      return "A cron expression must not be set on a one-time job";
    }
  }
  return null;
}

function checkProvider(value: {
  providerId?: string;
  modelId?: string;
}): string | null {
  if (value.providerId === undefined) return null;
  if (!registry.get(value.providerId)) {
    return `Provider "${value.providerId}" does not exist`;
  }
  if (value.modelId !== undefined && value.modelId.length === 0) {
    return "modelId must not be empty";
  }
  return null;
}

// ---- Jobs ----

app.get("/jobs", (c) => {
  const jobs = schedulerStore.list(db).map(toJobPublic);
  return c.json(jobs);
});

app.post("/jobs", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = schedulerJobCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid scheduler job", issues: parsed.error.issues },
      400,
    );
  }
  const v = parsed.data;
  const scheduleErr = checkScheduleFields({
    scheduleType: v.scheduleType,
    cronExpression: v.cronExpression ?? null,
    execAt: v.execAt ?? null,
    timezone: v.timezone,
  });
  if (scheduleErr) return c.json({ error: scheduleErr }, 400);
  await registry.loadFromDb(db);
  const providerErr = checkProvider({
    providerId: v.providerId,
    modelId: v.modelId,
  });
  if (providerErr) return c.json({ error: providerErr }, 400);

  const created = schedulerStore.create(
    {
      name: v.name,
      description: v.description ?? null,
      enabled: v.enabled ?? true,
      scheduleType: v.scheduleType,
      cronExpression: v.cronExpression ?? null,
      execAt: v.execAt ?? null,
      timezone: v.timezone,
      providerId: v.providerId,
      modelId: v.modelId,
      thinkingLevel: v.thinkingLevel ?? null,
      workspacePath: v.workspacePath,
      prompt: v.prompt,
      conversationPolicy: v.conversationPolicy ?? "dedicated_thread",
      overlapPolicy: v.overlapPolicy ?? "skip_if_running",
      maxRetries: v.maxRetries ?? 0,
      retryDelaySeconds: v.retryDelaySeconds ?? 60,
      timeoutSeconds: v.timeoutSeconds ?? 600,
      missedGraceSeconds: v.missedGraceSeconds ?? 600,
    } satisfies JobCreate,
    db,
  );
  logger.info("scheduler", "scheduler.job_created", {
    jobId: created.id,
    message: created.name,
  });
  try {
    scheduleJob(created);
  } catch (err) {
    schedulerStore.update(
      created.id,
      { enabled: false, status: "failed", nextRunAt: null },
      db,
    );
    return c.json(
      {
        error: err instanceof Error ? err.message : "Failed to schedule job",
      },
      400,
    );
  }
  const fresh = schedulerStore.get(created.id, db);
  return c.json(fullJobPublic(fresh ?? created), 201);
});

app.get("/jobs/:id", (c) => {
  const job = schedulerStore.get(c.req.param("id"), db);
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(fullJobPublic(job));
});

app.patch("/jobs/:id", async (c) => {
  const id = c.req.param("id");
  const existing = schedulerStore.get(id, db);
  if (!existing) return c.json({ error: "Job not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = schedulerJobUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid scheduler job", issues: parsed.error.issues },
      400,
    );
  }
  const v = parsed.data;
  const merged = {
    scheduleType: v.scheduleType ?? existing.scheduleType,
    cronExpression: v.cronExpression !== undefined ? v.cronExpression : existing.cronExpression,
    execAt: v.execAt !== undefined ? v.execAt : existing.execAt,
    timezone: v.timezone ?? existing.timezone,
  };
  const scheduleErr = checkScheduleFields(merged);
  if (scheduleErr) return c.json({ error: scheduleErr }, 400);
  if (v.providerId !== undefined || v.modelId !== undefined) {
    await registry.loadFromDb(db);
    const providerErr = checkProvider({
      providerId: v.providerId ?? existing.providerId,
      modelId: v.modelId ?? existing.modelId,
    });
    if (providerErr) return c.json({ error: providerErr }, 400);
  }
  // Switching schedule type clears the other type's field; editing a
  // terminal one-time job back to a live state requires a future exec_at.
  const patch: Record<string, unknown> = { ...v };
  if (
    v.scheduleType !== undefined &&
    v.scheduleType !== existing.scheduleType
  ) {
    if (v.scheduleType === "cron") patch.execAt = null;
    else patch.cronExpression = null;
  }
  const updated = schedulerStore.update(
    id,
    patch as Parameters<typeof schedulerStore.update>[1],
    db,
  );
  if (!updated) return c.json({ error: "Job not found" }, 404);
  logger.info("scheduler", "scheduler.job_updated", {
    jobId: id,
    message: updated.name,
  });
  try {
    scheduleJob(updated);
  } catch (err) {
    schedulerStore.update(
      id,
      { enabled: false, status: "failed", nextRunAt: null },
      db,
    );
    return c.json(
      { error: err instanceof Error ? err.message : "Failed to schedule job" },
      400,
    );
  }
  const fresh = schedulerStore.get(id, db);
  return c.json(fullJobPublic(fresh ?? updated));
});

app.delete("/jobs/:id", (c) => {
  const id = c.req.param("id");
  const existing = schedulerStore.get(id, db);
  if (!existing) return c.json({ error: "Job not found" }, 404);
  unscheduleJob(id);
  schedulerStore.remove(id, db);
  logger.info("scheduler", "scheduler.job_deleted", {
    jobId: id,
    message: existing.name,
  });
  return c.json({ success: true });
});

app.post("/jobs/:id/enable", (c) => {
  const id = c.req.param("id");
  const existing = schedulerStore.get(id, db);
  if (!existing) return c.json({ error: "Job not found" }, 404);
  if (isTerminalJobStatus(existing.status)) {
    return c.json(
      { error: `Job is ${existing.status} and cannot be re-enabled` },
      400,
    );
  }
  const updated = schedulerStore.update(
    id,
    { enabled: true, status: "active" },
    db,
  );
  logger.info("scheduler", "scheduler.job_enabled", { jobId: id });
  if (updated) {
    try {
      scheduleJob(updated);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to schedule job" },
        400,
      );
    }
  }
  const fresh = schedulerStore.get(id, db);
  return c.json(fresh ? fullJobPublic(fresh) : { success: true });
});

app.post("/jobs/:id/disable", (c) => {
  const id = c.req.param("id");
  const existing = schedulerStore.get(id, db);
  if (!existing) return c.json({ error: "Job not found" }, 404);
  unscheduleJob(id);
  const updated = schedulerStore.update(
    id,
    { enabled: false, status: "paused", nextRunAt: null },
    db,
  );
  logger.info("scheduler", "scheduler.job_disabled", { jobId: id });
  return c.json(updated ? fullJobPublic(updated) : { success: true });
});

app.post("/jobs/:id/run", async (c) => {
  const id = c.req.param("id");
  const result = await runJobNow(id);
  if ("error" in result) return c.json({ error: result.error }, 409);
  return c.json({ runId: result.runId }, 202);
});

// ---- Runs ----

app.get("/jobs/:id/runs", (c) => {
  const id = c.req.param("id");
  const existing = schedulerStore.get(id, db);
  if (!existing) return c.json({ error: "Job not found" }, 404);
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? 50), 1),
    200,
  );
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
  return c.json(schedulerStore.listRuns(id, limit, offset, db));
});

app.get("/runs", (c) => {
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? 100), 1),
    200,
  );
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
  return c.json(schedulerStore.listRecentRuns(limit, offset, db));
});

app.get("/runs/:id", (c) => {
  const run = schedulerStore.getRun(c.req.param("id"), db);
  if (!run) return c.json({ error: "Run not found" }, 404);
  return c.json(run);
});

// ---- Preview / next-run ----

app.post("/preview", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = schedulerPreviewSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid preview request", issues: parsed.error.issues },
      400,
    );
  }
  const v = parsed.data;
  try {
    assertValidTimezone(v.timezone);
  } catch {
    return c.json({ error: `Invalid IANA timezone: "${v.timezone}"` }, 400);
  }
  try {
    if (v.scheduleType === "cron") {
      if (!v.cronExpression || !isValidCron(v.cronExpression)) {
        return c.json(
          { error: "A valid 5-field cron expression is required" },
          400,
        );
      }
      const nextRuns = computeNextRuns(
        v.cronExpression,
        v.timezone,
        Date.now(),
        v.count ?? 3,
      );
      return c.json({
        description: describeCron(v.cronExpression),
        timezone: v.timezone,
        nextRuns,
      });
    }
    if (typeof v.execAt !== "number" || v.execAt <= 0) {
      return c.json(
        { error: "An absolute execAt timestamp is required" },
        400,
      );
    }
    return c.json({
      description: `Once at ${new Date(v.execAt).toISOString()}`,
      timezone: v.timezone,
      nextRuns: [v.execAt],
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Preview failed" },
      400,
    );
  }
});

app.post("/compute-next-run", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = schedulerPreviewSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid request", issues: parsed.error.issues },
      400,
    );
  }
  const v = parsed.data;
  try {
    assertValidTimezone(v.timezone);
    if (v.scheduleType === "cron") {
      if (!v.cronExpression || !isValidCron(v.cronExpression)) {
        return c.json(
          { error: "A valid 5-field cron expression is required" },
          400,
        );
      }
      const [nextRun] = computeNextRuns(
        v.cronExpression,
        v.timezone,
        Date.now(),
        1,
      );
      return c.json({ nextRun });
    }
    if (typeof v.execAt !== "number" || v.execAt <= 0) {
      return c.json({ error: "An absolute execAt timestamp is required" }, 400);
    }
    return c.json({ nextRun: v.execAt });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Computation failed" },
      400,
    );
  }
});

export default app;
