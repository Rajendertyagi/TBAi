/**
 * AI-controlled scheduler tools.
 *
 * These are the `execute` implementations for the six scheduler entries in the
 * native toolkit (`src/tools/index.ts`). They reuse the existing scheduler
 * service layer — `schedulerStore` (persistence) and `scheduler.ts`
 * (timers/fire) — so there is exactly ONE scheduler, driven by both the REST
 * API and the model. No approval layer yet (deferred); these tools run when the
 * model calls them.
 *
 * Each handler returns a JSON-serializable summary; on failure it throws an
 * Error whose message is surfaced to the model as the tool result.
 */
import { db } from "../../db";
import { registry } from "../../config/providers";
import { logger, newRequestId } from "../../lib/logger";
import type { JobCreate } from "./schedulerStore";
import { schedulerStore } from "./schedulerStore";
import { runJobNow, scheduleJob, unscheduleJob } from "./scheduler";
import {
  checkExistingThread,
  checkProvider,
  checkScheduleFields,
  normalizeCron,
} from "./schedulerValidation";
import type { SchedulerJob } from "./schedulerTypes";

/** Concise, prompt-free summary used by list/get/create/update. */
function toJobSummary(job: SchedulerJob) {
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled,
    status: job.status,
    scheduleType: job.scheduleType,
    cronExpression: job.cronExpression,
    execAt: job.execAt,
    timezone: job.timezone,
    providerId: job.providerId,
    modelId: job.modelId,
    thinkingLevel: job.thinkingLevel,
    workspacePath: job.workspacePath,
    conversationPolicy: job.conversationPolicy,
    conversationId: job.conversationId,
    overlapPolicy: job.overlapPolicy,
    nextRunAt: job.nextRunAt,
    lastRunAt: job.lastRunAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export const schedulerToolHandlers = {
  async create(args: Record<string, unknown>) {
    const requestId = newRequestId();
    const v = args as Partial<JobCreate> & { scheduleType?: string; timezone?: string };

    const scheduleErr = checkScheduleFields({
      scheduleType: v.scheduleType,
      cronExpression: v.cronExpression ?? null,
      execAt: v.execAt ?? null,
      timezone: v.timezone,
    });
    if (scheduleErr) throw new Error(scheduleErr);

    await registry.loadFromDb(db);
    const providerErr = checkProvider({
      providerId: v.providerId,
      modelId: v.modelId,
    });
    if (providerErr) throw new Error(providerErr);

    const threadErr = await checkExistingThread({
      conversationPolicy: v.conversationPolicy,
      conversationId: v.conversationId ?? null,
    });
    if (threadErr) throw new Error(threadErr);

    const created = schedulerStore.create(
      {
        name: v.name!,
        description: v.description ?? null,
        enabled: v.enabled ?? true,
        scheduleType: v.scheduleType as "once" | "cron",
        cronExpression:
          v.scheduleType === "cron"
            ? normalizeCron(v.cronExpression ?? null)
            : null,
        execAt: v.execAt ?? null,
        timezone: v.timezone!,
        providerId: v.providerId!,
        modelId: v.modelId!,
        thinkingLevel: v.thinkingLevel ?? null,
        workspacePath: v.workspacePath!,
        prompt: v.prompt!,
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
    logger.info("scheduler", "scheduler.job_created", {
      requestId,
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
      throw new Error(
        err instanceof Error ? err.message : "Failed to schedule job",
      );
    }
    return { created: true, job: toJobSummary(created) };
  },

  async list() {
    const jobs = schedulerStore.list(db);
    return {
      count: jobs.length,
      jobs: jobs.map(toJobSummary),
    };
  },

  async get(args: { id: string }) {
    const job = schedulerStore.get(args.id, db);
    if (!job) throw new Error(`Scheduler job not found: ${args.id}`);
    // Full detail (including the prompt) — the caller explicitly asked for it.
    return { job: { ...toJobSummary(job), prompt: job.prompt } };
  },

  async update(args: Record<string, unknown>) {
    const id = String(args.id ?? "");
    if (!id) throw new Error("update_scheduled_job requires an id");
    const existing = schedulerStore.get(id, db);
    if (!existing) throw new Error(`Scheduler job not found: ${id}`);

    const merged = {
      scheduleType:
        (args.scheduleType as string | undefined) ?? existing.scheduleType,
      cronExpression:
        args.cronExpression !== undefined
          ? (args.cronExpression as string | null)
          : existing.cronExpression,
      execAt:
        args.execAt !== undefined
          ? (args.execAt as number | null)
          : existing.execAt,
      timezone: (args.timezone as string | undefined) ?? existing.timezone,
    };
    const scheduleErr = checkScheduleFields(merged);
    if (scheduleErr) throw new Error(scheduleErr);

    if (args.providerId !== undefined || args.modelId !== undefined) {
      await registry.loadFromDb(db);
      const providerErr = checkProvider({
        providerId: (args.providerId as string) ?? existing.providerId,
        modelId: (args.modelId as string) ?? existing.modelId,
      });
      if (providerErr) throw new Error(providerErr);
    }

    const mergedPolicy =
      (args.conversationPolicy as string) ?? existing.conversationPolicy;
    const mergedConversationId =
      args.conversationId !== undefined
        ? (args.conversationId as string | null)
        : existing.conversationId;
    const threadErr = await checkExistingThread({
      conversationPolicy: mergedPolicy,
      conversationId: mergedConversationId,
    });
    if (threadErr) throw new Error(threadErr);

    const patch: Record<string, unknown> = { ...args };
    delete patch.id;
    if (typeof patch.cronExpression === "string") {
      patch.cronExpression = normalizeCron(patch.cronExpression);
    }
    if (
      args.scheduleType !== undefined &&
      args.scheduleType !== existing.scheduleType
    ) {
      if (args.scheduleType === "cron") patch.execAt = null;
      else patch.cronExpression = null;
    }

    const updated = schedulerStore.update(
      id,
      patch as Parameters<typeof schedulerStore.update>[1],
      db,
    );
    if (!updated) throw new Error(`Scheduler job not found: ${id}`);
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
      throw new Error(
        err instanceof Error ? err.message : "Failed to schedule job",
      );
    }
    return { updated: true, job: toJobSummary(updated) };
  },

  async delete(args: { id: string }) {
    const existing = schedulerStore.get(args.id, db);
    if (!existing) throw new Error(`Scheduler job not found: ${args.id}`);
    unscheduleJob(args.id);
    schedulerStore.softDelete(args.id, db);
    logger.info("scheduler", "scheduler.job_deleted", {
      jobId: args.id,
      message: existing.name,
    });
    return { deleted: true, id: args.id };
  },

  async runNow(args: { id: string }) {
    const result = await runJobNow(args.id);
    if ("error" in result) throw new Error(result.error);
    return { triggered: true, runId: result.runId, jobId: args.id };
  },
};
