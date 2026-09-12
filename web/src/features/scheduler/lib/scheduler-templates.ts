import {
  Briefcase,
  MoonStar,
  ShieldCheck,
  Sunrise,
  Sunset,
  Timer,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { SchedulerJob, SchedulerJobDraft } from "@/types";
import { blankDraft, draftFromJob, defaultOnceSlot } from "./scheduler-draft";

/**
 * Pure scheduler view logic: repeat presets, one-click starter templates,
 * draft factories. No store, no JSX (icons ride as component references, as
 * in codeg`s automation-templates). Unit-tested.
 */

export type RepeatPreset =
  | "minutes"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "advanced";

export interface JobTemplate {
  id: string;
  icon: LucideIcon;
  name: string;
  description: string;
  prompt: string;
  scheduleType: "once" | "cron";
  /** Repeat mode the template selects (fixes silent-overwrite: the mode is
   *  part of the template, not left on whatever the form had). */
  mode: RepeatPreset;
  cronExpression: string;
  minutes?: number;
  hour?: number;
  minute?: number;
  weekday?: number;
  monthDay?: number;
}

/** One-click starters (codeg parity: template gallery instead of blank form). */
export const JOB_TEMPLATES: JobTemplate[] = [
  {
    id: "morning-brief",
    icon: Sunrise,
    name: "Morning brief",
    description: "Weekday 9:00 summary of the workspace",
    prompt:
      "Summarize the current state of the workspace: recent files, open TODOs, and anything that looks unfinished. Keep it short.",
    scheduleType: "cron",
    mode: "weekdays",
    cronExpression: "0 9 * * MON-FRI",
    hour: 9,
    minute: 0,
  },
  {
    id: "hourly-pulse",
    icon: Timer,
    name: "Hourly pulse",
    description: "Quick check every hour",
    prompt:
      "Briefly report anything new or broken in the workspace since the last check. One paragraph max.",
    scheduleType: "cron",
    mode: "hourly",
    cronExpression: "0 * * * *",
    minute: 0,
  },
  {
    id: "every-5-minutes",
    icon: Zap,
    name: "Every 5 minutes",
    description: "Frequent lightweight watch",
    prompt:
      "Check the workspace for errors or stuck work and report in one short paragraph.",
    scheduleType: "cron",
    mode: "minutes",
    cronExpression: "*/5 * * * *",
    minutes: 5,
  },
  {
    id: "daily-summary",
    icon: Sunset,
    name: "Daily summary",
    description: "End-of-day recap at midnight",
    prompt:
      "Write a short end-of-day summary of workspace activity and notable changes.",
    scheduleType: "cron",
    mode: "daily",
    cronExpression: "@daily",
    hour: 0,
    minute: 0,
  },
  {
    id: "weekly-review",
    icon: MoonStar,
    name: "Weekly review",
    description: "Monday 9:00 week-in-review",
    prompt:
      "Review the workspace and produce a weekly report: progress, risks, and suggested next steps.",
    scheduleType: "cron",
    mode: "weekly",
    cronExpression: "0 9 * * MON",
    hour: 9,
    minute: 0,
    weekday: 1,
  },
  {
    id: "business-hours-watch",
    icon: Briefcase,
    name: "Business-hours watch",
    description: "Every half hour, 9–17 on all days",
    prompt:
      "Check the workspace for errors, failures, or stuck work and report briefly. Stay silent-equivalent: one short paragraph.",
    scheduleType: "cron",
    mode: "advanced",
    cronExpression: "0,30 9-17 * * *",
  },
  {
    id: "security-sweep",
    icon: ShieldCheck,
    name: "Security sweep",
    description: "Weekly scan for obvious risks",
    prompt:
      "Scan the workspace for obvious security risks (secrets in files, unsafe scripts, suspicious dependencies) and report findings. Do not change any files.",
    scheduleType: "cron",
    mode: "advanced",
    cronExpression: "@weekly",
  },
];

export function presetToCron(
  preset: RepeatPreset,
  opts: { minutes: number; hour: number; minute: number; weekday: number; monthDay: number },
): string {
  switch (preset) {
    case "minutes":
      return opts.minutes <= 1 ? "* * * * *" : `*/${opts.minutes} * * * *`;
    case "hourly":
      return `${opts.minute} * * * *`;
    case "daily":
      return `${opts.minute} ${opts.hour} * * *`;
    case "weekdays":
      return `${opts.minute} ${opts.hour} * * 1-5`;
    case "weekly":
      return `${opts.minute} ${opts.hour} * * ${opts.weekday}`;
    case "monthly":
      return `${opts.minute} ${opts.hour} ${opts.monthDay} * *`;
    case "advanced":
      throw new Error("Advanced cron is taken from the form field");
  }
}

/** Editor seed produced from a template (gallery → editor, no setters). */
export interface TemplateSeed {
  draft: SchedulerJobDraft;
  preset: RepeatPreset;
  minutes: number;
  hour: number;
  minute: number;
  weekday: number;
  monthDay: number;
}

/**
 * Seed a fresh editor draft from a template. Repeat-mode defaults mirror the
 * editor's own initial state so unset fields can't leak a stale form.
 */
export function seedDraftFromTemplate(
  t: JobTemplate,
  providerId: string,
  modelId: string,
): TemplateSeed {
  const draft = blankDraft(providerId, modelId);
  return {
    draft: {
      ...draft,
      name: t.name,
      description: t.description,
      prompt: t.prompt,
      scheduleType: t.scheduleType,
      cronExpression: t.cronExpression,
    },
    preset: t.mode,
    minutes: t.minutes ?? 15,
    hour: t.hour ?? 9,
    minute: t.minute ?? 0,
    weekday: t.weekday ?? 1,
    monthDay: t.monthDay ?? 1,
  };
}

/** Blank editor seed (gallery blank card). */
export function blankSeed(providerId: string, modelId: string): TemplateSeed {
  return {
    draft: blankDraft(providerId, modelId),
    preset: "daily",
    minutes: 15,
    hour: 9,
    minute: 0,
    weekday: 1,
    monthDay: 1,
  };
}

/**
 * "Use again" seed: copy a full job into a fresh draft. Terminal jobs cannot
 * be revived, so duplication is the honest path — the user reviews and saves
 * a new job. Cron duplicates keep the exact expression (advanced shows it
 * verbatim); one-time duplicates get a fresh slot.
 */
export function duplicateSeed(full: SchedulerJob): TemplateSeed {
  const slot = defaultOnceSlot();
  return {
    draft: {
      ...draftFromJob(full),
      name: `${full.name} (copy)`,
      enabled: true,
      execAtDate: full.scheduleType === "once" ? slot.date : "",
      execAtTime: full.scheduleType === "once" ? slot.time : "",
    },
    preset: "advanced",
    minutes: 15,
    hour: 9,
    minute: 0,
    weekday: 1,
    monthDay: 1,
  };
}
