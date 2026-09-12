/**
 * Scheduler view-logic unit tests (no DOM, no server): presets, templates,
 * draft factories, and time formatting from `features/scheduler/lib`.
 * Executed with `bun test`.
 */
import { describe, it, expect } from "bun:test";
import {
  JOB_TEMPLATES,
  presetToCron,
  seedDraftFromTemplate,
} from "../../web/src/features/scheduler/lib/scheduler-templates";
import {
  blankDraft,
  draftFromJob,
  toDateTimeStrings,
} from "../../web/src/features/scheduler/lib/scheduler-draft";
import {
  formatDuration,
  formatRelative,
  formatRelativePast,
  formatTime,
} from "../../web/src/features/scheduler/lib/scheduler-format";
import type { SchedulerJob, SchedulerJobDraft } from "../../web/src/types";

describe("presetToCron", () => {
  const opts = { minutes: 15, hour: 9, minute: 30, weekday: 1, monthDay: 15 };
  it("renders every preset", () => {
    expect(presetToCron("minutes", opts)).toBe("*/15 * * * *");
    expect(presetToCron("minutes", { ...opts, minutes: 1 })).toBe("* * * * *");
    expect(presetToCron("hourly", opts)).toBe("30 * * * *");
    expect(presetToCron("daily", opts)).toBe("30 9 * * *");
    expect(presetToCron("weekdays", opts)).toBe("30 9 * * 1-5");
    expect(presetToCron("weekly", opts)).toBe("30 9 * * 1");
    expect(presetToCron("monthly", opts)).toBe("30 9 15 * *");
  });

  it("throws for advanced (taken from the form field)", () => {
    expect(() => presetToCron("advanced", opts)).toThrow();
  });
});

describe("seedDraftFromTemplate", () => {
  it("seeds name/prompt/schedule and fixes the repeat mode", () => {
    const tpl = JOB_TEMPLATES.find((t) => t.id === "morning-brief")!;
    const seed = seedDraftFromTemplate(tpl, "p1", "m1");
    expect(seed.draft.name).toBe("Morning brief");
    expect(seed.draft.prompt).toContain("Summarize");
    expect(seed.draft.scheduleType).toBe("cron");
    expect(seed.draft.providerId).toBe("p1");
    expect(seed.preset).toBe("weekdays");
    expect(seed.hour).toBe(9);
    expect(seed.draft.cronExpression).toBe("0 9 * * MON-FRI");
  });

  it("falls back to editor defaults for unset repeat fields", () => {
    const tpl = JOB_TEMPLATES.find((t) => t.id === "security-sweep")!;
    const seed = seedDraftFromTemplate(tpl, "", "");
    expect(seed.preset).toBe("advanced");
    expect(seed.minutes).toBe(15);
    expect(seed.hour).toBe(9);
    expect(seed.weekday).toBe(1);
  });

  it("gallery covers blank + every template with unique ids", () => {
    const ids = JOB_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of JOB_TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.prompt.length).toBeGreaterThan(0);
    }
  });
});

describe("draft factories", () => {
  it("blankDraft defaults to a one-time dedicated-thread draft", () => {
    const d = blankDraft("p1", "m1");
    expect(d.scheduleType).toBe("once");
    expect(d.enabled).toBe(true);
    expect(d.conversationPolicy).toBe("dedicated_thread");
    expect(d.providerId).toBe("p1");
    expect(d.execAtDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("draftFromJob round-trips a job", () => {
    const job = {
      id: "j",
      name: "N",
      description: null,
      enabled: false,
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      execAt: null,
      timezone: "UTC",
      providerId: "p",
      modelId: "m",
      thinkingLevel: null,
      workspacePath: "/w",
      prompt: "hi",
      conversationPolicy: "dedicated_thread",
      conversationId: null,
      maxRetries: 1,
      retryDelaySeconds: 60,
      timeoutSeconds: 600,
      missedGraceSeconds: 600,
    } as SchedulerJob;
    const d = draftFromJob(job);
    expect(d.name).toBe("N");
    expect(d.enabled).toBe(false);
    expect(d.thinkingLevel).toBe("off");
    expect(d.execAtDate).toBe("");
  });

  it("toDateTimeStrings pads parts", () => {
    const { date, time } = toDateTimeStrings(new Date(2026, 0, 5, 9, 7));
    expect(date).toBe("2026-01-05");
    expect(time).toBe("09:07");
  });
});

describe("scheduler time formatting", () => {
  const NOW = Date.parse("2026-09-12T12:00:00Z");

  it("formatTime handles null", () => {
    expect(formatTime(null)).toBe("—");
    expect(formatTime(0)).toBe("—");
    expect(formatTime(NOW)).toContain("2026");
  });

  it("formatRelative counts forward", () => {
    expect(formatRelative(null, NOW)).toBe("—");
    expect(formatRelative(NOW - 1000, NOW)).toBe("due now");
    expect(formatRelative(NOW + 30_000, NOW)).toBe("in seconds");
    expect(formatRelative(NOW + 5 * 60_000, NOW)).toBe("in 5m");
    expect(formatRelative(NOW + 3 * 3_600_000, NOW)).toBe("in 3h");
    expect(formatRelative(NOW + 2 * 86_400_000, NOW)).toBe("in 2d");
  });

  it("formatRelativePast counts back compactly", () => {
    expect(formatRelativePast(null, NOW)).toBe("—");
    expect(formatRelativePast(NOW - 10_000, NOW)).toBe("now");
    expect(formatRelativePast(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(formatRelativePast(NOW - 2 * 3_600_000, NOW)).toBe("2h");
    expect(formatRelativePast(NOW - 10 * 86_400_000, NOW)).toBe("10d");
  });

  it("formatDuration renders spans", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(192_000)).toBe("3m 12s");
    expect(formatDuration(7_500_000)).toBe("2h 5m");
  });
});
