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
  cancelRun,
  isSchedulerReady,
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
  checkOpenCodeFields,
  checkProvider,
  checkScheduleFields,
  normalizeCron,
} from "../services/scheduler/schedulerValidation";
import { folderService } from "../services/folders";
import { resolveConversationWorkspace } from "../services/workspace";
import type { SchedulerJob } from "../services/scheduler/schedulerTypes";

const app = new Hono();

/**
 * Readiness gate: essential boot recovery (interrupted-run reconciliation +
 * timer rebuild) must complete before scheduler-dependent routes are served.
 * The window is milliseconds on a normal boot, but a request landing inside
 * it would otherwise observe partially initialized scheduler state.
 */
app.use(async (c, next) => {
  if (!isSchedulerReady()) {
    return c.json({ error: "Scheduler is still recovering; try again shortly" }, 503);
  }
  await next();
});

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
    return c.json({ error: "Invalid scheduler job", issues: parsed.error.issues }, 400);
  }
  const v = parsed.data;
  const scheduleErr = checkScheduleFields({
    scheduleType: v.scheduleType,
    cronExpression: v.cronExpression ?? null,
    execAt: v.execAt ?? null,
    timezone: v.timezone,
  });
  if (scheduleErr) return c.json({ error: scheduleErr }, 400);

  const engine = v.engine ?? "direct";
  let resolvedWorkspacePath = v.workspacePath;

  if (engine === "direct") {
    if (!v.providerId || !v.modelId) {
      return c.json({ error: "providerId and modelId are required for direct jobs" }, 400);
    }
    if (!resolvedWorkspacePath) {
      return c.json({ error: "workspacePath is required for direct jobs" }, 400);
    }
    await registry.loadFromDb(db);
    const providerErr = checkProvider({
      providerId: v.providerId,
      modelId: v.modelId,
      engine: "direct",
    });
    if (providerErr) return c.json({ error: providerErr }, 400);

    const threadErr = await checkExistingThread({
      conversationPolicy: v.conversationPolicy,
      conversationId: v.conversationId ?? null,
      engine: "direct",
    });
    if (threadErr) return c.json({ error: threadErr }, 400);
  } else {
    const openCodeErr = checkOpenCodeFields({
      engine: "opencode",
      opencodeSessionStrategy: v.opencodeSessionStrategy ?? "fresh",
      workspaceFolderId: v.workspaceFolderId ?? null,
      workspacePath: resolvedWorkspacePath ?? null,
      conversationId: v.conversationId ?? null,
    });
    if (openCodeErr) return c.json({ error: openCodeErr }, 400);

    if (!resolvedWorkspacePath && v.workspaceFolderId) {
      const folder = await folderService.get(v.workspaceFolderId);
      if (folder) resolvedWorkspacePath = folder.path;
    }
    if (!resolvedWorkspacePath && v.conversationId) {
      try {
        resolvedWorkspacePath = (await resolveConversationWorkspace(v.conversationId)).dir;
      } catch {}
    }
    if (!resolvedWorkspacePath) {
      return c.json({ error: "Could not resolve workspace path for OpenCode job" }, 400);
    }

    const threadErr = await checkExistingThread({
      conversationId: v.conversationId ?? null,
      engine: "opencode",
      opencodeSessionStrategy: v.opencodeSessionStrategy ?? "fresh",
      workspaceFolderId: v.workspaceFolderId ?? null,
      workspacePath: resolvedWorkspacePath ?? null,
    });
    if (threadErr) return c.json({ error: threadErr }, 400);
  }

  const created = schedulerStore.create(
    {
      name: v.name,
      description: v.description ?? null,
      enabled: v.enabled ?? true,
      scheduleType: v.scheduleType,
      cronExpression:
        v.scheduleType === "cron" && v.cronExpression ? normalizeCron(v.cronExpression) : null,
      execAt: v.execAt ?? null,
      timezone: v.timezone,
      engine,
      providerId: engine === "opencode" ? (v.providerId ?? "opencode") : v.providerId!,
      modelId: engine === "opencode" ? (v.modelId ?? v.opencodeModel ?? "default") : v.modelId!,
      thinkingLevel: v.thinkingLevel ?? null,
      workspacePath: resolvedWorkspacePath!,
      prompt: v.prompt,
      conversationPolicy: v.conversationPolicy ?? "dedicated_thread",
      conversationId: v.conversationId ?? null,
      overlapPolicy: v.overlapPolicy ?? "skip_if_running",
      maxRetries: v.maxRetries ?? 0,
      retryDelaySeconds: v.retryDelaySeconds ?? 60,
      timeoutSeconds: v.timeoutSeconds ?? 600,
      missedGraceSeconds: v.missedGraceSeconds ?? 600,
      opencodeSessionStrategy: engine === "opencode" ? (v.opencodeSessionStrategy ?? "fresh") : null,
      opencodeAgent: engine === "opencode" ? (v.opencodeAgent ?? null) : null,
      opencodeModel: engine === "opencode" ? (v.opencodeModel ?? null) : null,
      opencodeVariant: engine === "opencode" ? (v.opencodeVariant ?? null) : null,
      opencodePermissions: engine === "opencode" ? (v.opencodePermissions ?? "autonomous_coding") : null,
      workspaceFolderId: engine === "opencode" ? (v.workspaceFolderId ?? null) : null,
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
    schedulerStore.update(created.id, { enabled: false, status: "failed", nextRunAt: null }, db);
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
    return c.json({ error: "Invalid scheduler job", issues: parsed.error.issues }, 400);
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

  const mergedEngine = v.engine ?? existing.engine;
  const patch: Record<string, unknown> = { ...v };

  if (mergedEngine === "direct") {
    if (v.providerId !== undefined || v.modelId !== undefined) {
      await registry.loadFromDb(db);
      const providerErr = checkProvider({
        providerId: v.providerId ?? existing.providerId,
        modelId: v.modelId ?? existing.modelId,
        engine: "direct",
      });
      if (providerErr) return c.json({ error: providerErr }, 400);
    }
    const mergedPolicy = v.conversationPolicy ?? existing.conversationPolicy;
    const mergedConversationId =
      v.conversationId !== undefined ? v.conversationId : existing.conversationId;
    const threadErr = await checkExistingThread({
      conversationPolicy: mergedPolicy,
      conversationId: mergedConversationId,
      engine: "direct",
    });
    if (threadErr) return c.json({ error: threadErr }, 400);
  } else {
    const mergedStrategy =
      v.opencodeSessionStrategy !== undefined ? v.opencodeSessionStrategy : existing.opencodeSessionStrategy;
    const mergedFolderId =
      v.workspaceFolderId !== undefined ? v.workspaceFolderId : existing.workspaceFolderId;
    const mergedConvId =
      v.conversationId !== undefined ? v.conversationId : existing.conversationId;

    const openCodeErr = checkOpenCodeFields({
      engine: "opencode",
      opencodeSessionStrategy: mergedStrategy,
      workspaceFolderId: mergedFolderId,
      workspacePath: v.workspacePath ?? existing.workspacePath,
      conversationId: mergedConvId,
    });
    if (openCodeErr) return c.json({ error: openCodeErr }, 400);

    if (v.workspaceFolderId && v.workspaceFolderId !== existing.workspaceFolderId && !v.workspacePath) {
      const folder = await folderService.get(v.workspaceFolderId);
      if (folder) patch.workspacePath = folder.path;
    }

    const strategyChanged =
      v.opencodeSessionStrategy !== undefined &&
      v.opencodeSessionStrategy !== existing.opencodeSessionStrategy;
    const modelChanged =
      v.opencodeModel !== undefined && v.opencodeModel !== existing.opencodeModel;
    const agentChanged =
      v.opencodeAgent !== undefined && v.opencodeAgent !== existing.opencodeAgent;
    const variantChanged =
      v.opencodeVariant !== undefined && v.opencodeVariant !== existing.opencodeVariant;
    const permsChanged =
      v.opencodePermissions !== undefined &&
      v.opencodePermissions !== existing.opencodePermissions;
    const folderChanged =
      v.workspaceFolderId !== undefined &&
      v.workspaceFolderId !== existing.workspaceFolderId;
    const pathChanged =
      v.workspacePath !== undefined && v.workspacePath !== existing.workspacePath;

    if (
      (existing.opencodeSessionStrategy === "persistent" ||
        v.opencodeSessionStrategy === "persistent") &&
      (strategyChanged ||
        modelChanged ||
        agentChanged ||
        variantChanged ||
        permsChanged ||
        folderChanged ||
        pathChanged)
    ) {
      patch.conversationId = null;
    }

    const threadErr = await checkExistingThread({
      conversationId: mergedConvId,
      engine: "opencode",
      opencodeSessionStrategy: mergedStrategy,
      workspaceFolderId: mergedFolderId,
      workspacePath: v.workspacePath ?? existing.workspacePath,
    });
    if (threadErr) return c.json({ error: threadErr }, 400);
  }
  // Switching schedule type clears the other type's field; editing a
  // terminal one-time job back to a live state requires a future exec_at.
  if (typeof patch.cronExpression === "string") {
    patch.cronExpression = normalizeCron(patch.cronExpression);
  }
  if (v.scheduleType !== undefined && v.scheduleType !== existing.scheduleType) {
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
    schedulerStore.update(id, { enabled: false, status: "failed", nextRunAt: null }, db);
    return c.json({ error: err instanceof Error ? err.message : "Failed to schedule job" }, 400);
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
    return c.json({ error: "This job was deleted. Duplicate it to run again." }, 400);
  }
  if (existing.scheduleType === "once" && (existing.execAt ?? 0) <= Date.now()) {
    return c.json(
      {
        error:
          "This one-time run already passed. Duplicate the job with a new date, or edit it to pick a new date first.",
      },
      400,
    );
  }
  const updated = schedulerStore.update(id, { enabled: true, status: "active" }, db);
  logger.info("scheduler", "scheduler.admin", { action: "enabled", jobId: id });
  if (updated) {
    try {
      scheduleJob(updated);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to schedule job" }, 400);
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
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 7), 1), 30);
  const problems = schedulerStore.listProblemRuns(Date.now() - days * 24 * 3600_000, 50, db);
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
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
  return c.json(schedulerStore.listRuns(id, limit, offset, db));
});

app.get("/runs", (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 200);
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
    return c.json({ error: "Invalid preview request", issues: parsed.error.issues }, 400);
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
        return c.json({ error: "A valid 5-field cron expression is required" }, 400);
      }
      const nextRuns = computeNextRuns(v.cronExpression, v.timezone, Date.now(), v.count ?? 3);
      return c.json({
        description: describeCron(v.cronExpression),
        timezone: v.timezone,
        nextRuns,
        runsNext24h: countUpcoming(v.cronExpression, v.timezone),
      });
    }
    if (typeof v.execAt !== "number" || v.execAt <= 0) {
      return c.json({ error: "An absolute execAt timestamp is required" }, 400);
    }
    return c.json({
      description: `Once at ${new Date(v.execAt).toISOString()}`,
      timezone: v.timezone,
      nextRuns: [v.execAt],
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Preview failed" }, 400);
  }
});

app.post("/compute-next-run", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = schedulerPreviewSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", issues: parsed.error.issues }, 400);
  }
  const v = parsed.data;
  try {
    assertValidTimezone(v.timezone);
    if (v.scheduleType === "cron") {
      if (!v.cronExpression || !isValidCron(v.cronExpression)) {
        return c.json({ error: "A valid 5-field cron expression is required" }, 400);
      }
      const [nextRun] = computeNextRuns(v.cronExpression, v.timezone, Date.now(), 1);
      return c.json({ nextRun });
    }
    if (typeof v.execAt !== "number" || v.execAt <= 0) {
      return c.json({ error: "An absolute execAt timestamp is required" }, 400);
    }
    return c.json({ nextRun: v.execAt });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Computation failed" }, 400);
  }
});

export default app;
