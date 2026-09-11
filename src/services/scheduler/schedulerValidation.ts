/**
 * Scheduler input validation shared by the REST boundary (routes/scheduler.ts)
 * and the AI-tool handlers (services/scheduler/schedulerTools.ts). Keeping these
 * here means a model-driven job and a UI-created job validate through the exact
 * same rules — no drift between the two entry points.
 */
import { db } from "../../db";
import { registry } from "../../config/providers";
import { conversationService } from "../storage";
import { assertValidTimezone, isValidCron, expandMacro } from "./cron";
import type { SchedulerJob } from "./schedulerTypes";

/** Validate schedule shape (timezone, cron/once exclusivity). Sync. */
export function checkScheduleFields(value: {
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

/** Validate that a referenced provider exists. Sync. */
export function checkProvider(value: {
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

/**
 * When targeting an existing thread, fail fast if the conversation does not
 * resolve (deleted/archived). Returns null when valid, else an error string.
 */
export async function checkExistingThread(value: {
  conversationPolicy?: string;
  conversationId?: string | null;
}): Promise<string | null> {
  if (
    (value.conversationPolicy ?? "dedicated_thread") === "existing_thread" &&
    value.conversationId
  ) {
    const target = await conversationService.get(value.conversationId);
    if (!target) {
      return "Target conversation not found. Pick an existing thread.";
    }
  }
  return null;
}

/** Normalize a cron macro to canonical 5-field form, if present. */
export function normalizeCron(cronExpression: string | null | undefined): string | null {
  return cronExpression ? expandMacro(cronExpression) : null;
}

export type ScheduleValidationValue = Parameters<typeof checkScheduleFields>[0];
export type { SchedulerJob };
