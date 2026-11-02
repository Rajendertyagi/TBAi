import type { SchedulerJob, SchedulerJobDraft } from "@/types";

/**
 * Pure draft factories + date helpers for the scheduler editor. No store,
 * no JSX. Unit-tested.
 */

export function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function toDateTimeStrings(d: Date): { date: string; time: string } {
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  };
}

/** Default one-time slot: right now (user expectation on create). */
export function defaultOnceSlot(): { date: string; time: string } {
  const d = new Date();
  d.setSeconds(0, 0);
  return toDateTimeStrings(d);
}

export function blankDraft(providerId: string, modelId: string): SchedulerJobDraft {
  const slot = defaultOnceSlot();
  return {
    name: "",
    description: "",
    enabled: true,
    scheduleType: "once",
    cronExpression: "0 9 * * *",
    execAtDate: slot.date,
    execAtTime: slot.time,
    timezone: systemTimezone(),
    engine: "direct",
    providerId,
    modelId,
    thinkingLevel: "off",
    workspacePath: "",
    prompt: "",
    conversationPolicy: "dedicated_thread",
    conversationId: null,
    maxRetries: 0,
    retryDelaySeconds: 60,
    timeoutSeconds: 600,
    missedGraceSeconds: 600,
    opencodeSessionStrategy: "fresh",
    opencodeAgent: "",
    opencodeModel: "",
    opencodeVariant: "",
    opencodePermissions: "autonomous_coding",
    workspaceFolderId: "",
  };
}

export function draftFromJob(job: SchedulerJob): SchedulerJobDraft {
  let execAtDate = "";
  let execAtTime = "";
  if (job.scheduleType === "once" && job.execAt) {
    const d = new Date(job.execAt);
    execAtDate = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    execAtTime = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  return {
    name: job.name,
    description: job.description ?? "",
    enabled: job.enabled,
    scheduleType: job.scheduleType,
    cronExpression: job.cronExpression ?? "0 9 * * *",
    execAtDate,
    execAtTime,
    timezone: job.timezone,
    engine: job.engine ?? "direct",
    providerId: job.providerId,
    modelId: job.modelId,
    thinkingLevel: job.thinkingLevel ?? "off",
    workspacePath: job.workspacePath,
    prompt: job.prompt ?? "",
    conversationPolicy: job.conversationPolicy,
    conversationId: job.conversationId,
    maxRetries: job.maxRetries,
    retryDelaySeconds: job.retryDelaySeconds,
    timeoutSeconds: job.timeoutSeconds,
    missedGraceSeconds: job.missedGraceSeconds,
    opencodeSessionStrategy: job.opencodeSessionStrategy ?? "fresh",
    opencodeAgent: job.opencodeAgent ?? "",
    opencodeModel: job.opencodeModel ?? "",
    opencodeVariant: job.opencodeVariant ?? "",
    opencodePermissions: job.opencodePermissions ?? "autonomous_coding",
    workspaceFolderId: job.workspaceFolderId ?? "",
  };
}
