import path from "node:path";
import { registry } from "../../config/providers";
import { conversationService } from "../storage";
import { resolveConversationWorkspace } from "../workspace";
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
  engine?: string;
}): string | null {
  if (value.engine === "opencode") {
    // OpenCode jobs resolve their own models or defaults in OpenCode
    return null;
  }
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
 * resolve (deleted/archived/engine mismatch/folder mismatch). Returns null when valid, else an error string.
 */
export async function checkExistingThread(value: {
  conversationPolicy?: string;
  conversationId?: string | null;
  engine?: string;
  opencodeSessionStrategy?: string | null;
  workspaceFolderId?: string | null;
  workspacePath?: string | null;
}): Promise<string | null> {
  const isExisting =
    value.engine === "opencode"
      ? value.opencodeSessionStrategy === "existing_conversation"
      : (value.conversationPolicy ?? "dedicated_thread") === "existing_thread";

  if (isExisting && value.conversationId) {
    const target = await conversationService.get(value.conversationId);
    if (!target) {
      return value.engine === "opencode"
        ? "Target OpenCode conversation not found. Pick an existing conversation."
        : "Target conversation not found. Pick an existing thread.";
    }
    if (target.status === "archived") {
      return value.engine === "opencode"
        ? "Target OpenCode conversation is archived. Pick an active conversation."
        : "Target conversation is archived. Pick an active thread.";
    }
    if (value.engine === "opencode") {
      if (target.engine !== "opencode") {
        return "Target conversation does not belong to OpenCode engine. Pick an OpenCode conversation.";
      }
      // Resolve the authoritative directory via the existing workspace resolver.
      // Do not rely on opencodeDirectory being populated; never guess.
      let resolvedDir: string;
      try {
        const resolved = await resolveConversationWorkspace(target.id);
        resolvedDir = resolved.dir;
      } catch {
        return "Target OpenCode conversation's workspace folder is deleted or no longer resolvable.";
      }
      if (
        value.workspaceFolderId &&
        target.workspaceFolderId &&
        value.workspaceFolderId !== target.workspaceFolderId
      ) {
        return "Target OpenCode conversation belongs to a different workspace folder.";
      }
      // When folder metadata is absent on the job, fall back to the resolved dir.
      const jobDir = value.workspacePath ?? null;
      const targetDir = target.opencodeDirectory ?? resolvedDir;
      if (jobDir && targetDir) {
        if (path.resolve(jobDir) !== path.resolve(targetDir)) {
          return "Target OpenCode conversation belongs to a different workspace directory.";
        }
      }
      // If the job provides no directory identity and the target has no resolvable
      // directory, reject as ambiguous rather than guessing.
      if (!jobDir && !value.workspaceFolderId && !target.workspaceFolderId) {
        return "Target OpenCode conversation has no resolvable workspace identity.";
      }
    }
  }
  return null;
}

/** Validate engine-specific OpenCode configuration parameters. Sync. */
export function checkOpenCodeFields(value: {
  engine?: string;
  opencodeSessionStrategy?: string | null;
  workspaceFolderId?: string | null;
  workspacePath?: string | null;
  conversationId?: string | null;
}): string | null {
  if (value.engine !== "opencode") return null;
  if (!value.opencodeSessionStrategy) {
    return "opencodeSessionStrategy ('fresh' | 'persistent' | 'existing_conversation') is required for OpenCode jobs";
  }
  if (!["fresh", "persistent", "existing_conversation"].includes(value.opencodeSessionStrategy)) {
    return `Invalid opencodeSessionStrategy: "${value.opencodeSessionStrategy}"`;
  }
  if (value.opencodeSessionStrategy === "existing_conversation" && !value.conversationId) {
    return "conversationId is required for existing_conversation strategy";
  }
  if (
    (value.opencodeSessionStrategy === "fresh" || value.opencodeSessionStrategy === "persistent") &&
    !value.workspaceFolderId &&
    !value.workspacePath
  ) {
    return "workspaceFolderId or workspacePath is required for fresh/persistent OpenCode jobs";
  }
  return null;
}

/** Normalize a cron macro to canonical 5-field form, if present. */
export function normalizeCron(cronExpression: string | null | undefined): string | null {
  return cronExpression ? expandMacro(cronExpression) : null;
}

export type ScheduleValidationValue = Parameters<typeof checkScheduleFields>[0];
export type { SchedulerJob };
