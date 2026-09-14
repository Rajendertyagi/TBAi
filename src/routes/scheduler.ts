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
import { conversationService } from "../services/storage";
import {
  cancelRun,
  runJobNow,
  scheduleJob,
  unscheduleJob,
} from "../services/scheduler/scheduler";
import {
  assertValidTimezone,
  computeNextRuns,
  countUpcoming,
  describeCron,
  isValidCron,
} from "../services/scheduler/cron";
import {
  checkExistingThread,
  checkProvider,
  checkScheduleFields,
  normalizeCron,
} from "../services/scheduler/schedulerValidation";
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
  // Fail fast when targeting an existing thread: a thread id that does not
  // resolve would otherwise fail silently at fire time (retargets used to
  // be stripped by validation and never saved at all).
  if (
    (v.conversationPolicy ?? "dedicated_thread") === "existing_thread" &&
    v.conversationId
  ) {
    const target = await conversationService.get(v.conversationId);
    if (!target) {
      return c.json(
        { error: "Target conversation not found. Pick an existing thread." },
        400,
      );
    }
  }

  const created = schedulerStore.create(
    {
      name: v.name,
      description: v.description ?? null,
      enabled: v.enabled ?? true,
      scheduleType: v.scheduleType,
      // Macros are normalized to canonical 5-field form so timers,
      // previews, and stored values always agree.
      cronExpression:
        v.scheduleType === "cron" && v.cronExpression
          ? normalizeCron(v.cronExpression)
          : null,
      execAt: v.execAt ?? null,
      timezone: v.timezone,
      providerId: v.providerId,
      modelId: v.modelId,
      thinkingLevel: v.thinkingLevel ?? null,
      workspacePath: v.workspacePath,
      prompt: v.prompt,
      conversationPolicy: v.conversationPolicy ?? "dedicated_thread",
      conversationId: v.conversationId ?? null,
      overlapPolicy: v.overlapPolicy ?? "skip_if_running",
      maxRetries: v.maxRetries ?? 0,
      retryDelaySeconds: v.retryDelaySeconds ?? 60,
      timeoutSeconds: v.timeoutSeconds ?? 600,
      missedGraceSeconds: v.missedGraceSeconds ?? 600,
    } satisfies JobCreate,
    db,
  );
  logger.info("scheduler", "scheduler.admin", {
    action: "created",
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
  const mergedPolicy =
    v.conversationPolicy ?? existing.conversationPolicy;
  const mergedConversationId =
    v.conversationId !== undefined ? v.conversationId : existing.conversationId;
  if (mergedPolicy === "existing_thread" && mergedConversationId) {
    const target = await conversationService.get(mergedConversationId);
    if (!target) {
      return c.json(
        { error: "Target conversation not found. Pick an existing thread." },
        400,
      );
    }
  }
  // Switching schedule type clears the other type's field; editing a
  // terminal one-time job back to a live state requires a future exec_at.
  const patch: Record<string, unknown> = { ...v };
  if (typeof patch.cronExpression === "string") {
    patch.cronExpression = normalizeCron(patch.cronExpression);
  }
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
  logger.info("scheduler", "scheduler.admin", {
    action: "updated",
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
  schedulerStore.softDelete(id, db);
  logger.info("scheduler", "scheduler.admin", {
    action: "deleted",
    jobId: id,
    message: existing.name,
  });
  return c.json({ success: true });
});

app.post("/jobs/:id/enable", (c) => {
  const id = c.req.param("id");
  const existing = schedulerStore.get(id, db);
  if (!existing) return c.json({ error: "Job not found" }, 404);
  // A spent one-time date cannot be revived: enabling it would only flip
  // straight to missed. Tell the user the real options instead.
  // Deleted jobs stay deleted (their history is retained, the job is gone).
  if (existing.status === "deleted") {
    return c.json(
      { error: "This job was deleted. Duplicate it to run again." },
      400,
    );
  }
  if (
    existing.scheduleType === "once" &&
    (existing.execAt ?? 0) <= Date.now()
  ) {
    return c.json(
      {
        error:
          "This one-time run already passed. Duplicate the job with a new date, or edit it to pick a new date first.",
      },
      400,
    );
  }
  const updated = schedulerStore.update(
    id,
    { enabled: true, status: "active" },
    db,
  );
  logger.info("scheduler", "scheduler.admin", { action: "enabled", jobId: id });
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
  logger.info("scheduler", "scheduler.admin", { action: "disabled", jobId: id });
  return c.json(updated ? fullJobPublic(updated) : { success: true });
});

app.post("/jobs/:id/run", async (c) => {
  const id = c.req.param("id");
  const result = await runJobNow(id);
  if ("error" in result) return c.json({ error: result.error }, 409);
  return c.json({ runId: result.runId }, 202);
});

app.post("/jobs/:id/runs/:runId/cancel", (c) => {
  const id = c.req.param("id");
  const runId = c.req.param("runId");
  const result = cancelRun(id, runId, db);
  if (result.ok === false) {
    const status = result.error === "Run not found" ? 404 : 409;
    return c.json({ error: result.error }, status as 404 | 409);
  }
  return c.json({ cancelled: true });
});

// ---- Runs ----

app.get("/summary", (c) => {
  const days = Math.min(
    Math.max(Number(c.req.query("days") ?? 7), 1),
    30,
  );
  const problems = schedulerStore.listProblemRuns(
    Date.now() - days * 24 * 3600_000,
    50,
    db,
  );
  const jobs = schedulerStore.list(db);
  return c.json({
    problemRuns: problems.map((r) => ({
      id: r.id,
      jobId: r.jobId,
      jobName: r.jobName,
      status: r.status,
      startedAt: r.startedAt,
      error: r.error ? r.error.slice(0, 200) : null,
    })),
    jobCount: jobs.length,
    enabledCount: jobs.filter((j) => j.enabled).length,
    running: schedulerStore.listRunning(db),
  });
});

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
        runsNext24h: countUpcoming(v.cronExpression, v.timezone),
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
