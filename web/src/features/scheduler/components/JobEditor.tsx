import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { X, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { schedulerViewConfig } from "@/config/scheduler";
import { schedulerApi } from "@/stores/schedulerStore";
import type { ProviderConfig } from "@/types";
import type { SchedulerJob } from "@/types";
import type { SchedulerJobDraft } from "@/types";
import {
  blankDraft,
  draftFromJob,
  systemTimezone,
  toDateTimeStrings,
} from "@/features/scheduler/lib/scheduler-draft";
import { formatTime } from "@/features/scheduler/lib/scheduler-format";
import {
  presetToCron,
  type RepeatPreset,
  type TemplateSeed,
} from "@/features/scheduler/lib/scheduler-templates";

const labelClass = "text-xs font-medium text-muted-foreground";
const microLabelClass =
  "text-xs font-medium uppercase tracking-wide text-muted-foreground";
const selectClass =
  "w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm";

/** Locale-aware weekday names (2024-01-07 was a Sunday) — never literals. */
function weekdayName(n: number): string {
  return new Date(2024, 0, 7 + n).toLocaleDateString(undefined, {
    weekday: "long",
  });
}

/** Compact inline HH:MM pair for the sentence-style schedule row. */
function TimeFields({
  hour,
  minute,
  hourLabel,
  minuteLabel,
  onHour,
  onMinute,
}: {
  hour: number;
  minute: number;
  hourLabel: string;
  minuteLabel: string;
  onHour: (v: number) => void;
  onMinute: (v: number) => void;
}) {
  const fieldClass = "h-8 w-14 px-1 text-center tabular-nums";
  return (
    <span className="inline-flex items-center gap-1">
      <Input
        type="number"
        min={0}
        max={23}
        className={fieldClass}
        value={hour}
        onChange={(e) => onHour(Number(e.target.value) || 0)}
        aria-label={hourLabel}
      />
      <span aria-hidden="true" className="text-muted-foreground">
        :
      </span>
      <Input
        type="number"
        min={0}
        max={59}
        className={fieldClass}
        value={minute}
        onChange={(e) => onMinute(Number(e.target.value) || 0)}
        aria-label={minuteLabel}
      />
    </span>
  );
}

interface JobPayload {
  name: string;
  description: string | null;
  enabled: boolean;
  scheduleType: "once" | "cron";
  cronExpression: string | null;
  execAt: number | null;
  timezone: string;
  providerId: string;
  modelId: string;
  thinkingLevel: "off" | "low" | "medium" | "high";
  workspacePath: string;
  prompt: string;
  conversationPolicy: "dedicated_thread" | "existing_thread";
  conversationId: string | null;
  maxRetries: number;
  retryDelaySeconds: number;
  timeoutSeconds: number;
  missedGraceSeconds: number;
}

/**
 * Job editor form (create + edit). Self-contained: owns the draft, repeat
 * controls, live schedule preview, and save. The parent remounts it (via
 * `key`) per target, so `useState` initializers from props are sufficient —
 * no prop-sync effects. Template seeding arrives as a ready `seed`
 * (gallery); the in-form template grid is gone.
 */
export function JobEditor({
  seed,
  editingJob,
  defaultProviderId,
  defaultModelId,
  providers,
  conversations,
  onSaved,
  onError,
  onCancel,
  onBackToTemplates,
  startScheduleCollapsed,
}: {
  seed: TemplateSeed | null;
  editingJob: SchedulerJob | null;
  defaultProviderId: string;
  defaultModelId: string;
  providers: ProviderConfig[];
  conversations: Array<{ id: string; title: string }>;
  onSaved: (job: SchedulerJob) => void;
  onError: (message: string) => void;
  onCancel: () => void;
  onBackToTemplates?: () => void;
  /**
   * Start with the schedule section collapsed to a summary line (seeded
   * flows: the template/duplicate already decided the schedule). Blank and
   * edit flows start expanded. Parent remounts per target, so the initial
   * value sticks.
   */
  startScheduleCollapsed?: boolean;
}) {
  const ec = schedulerViewConfig.copy.editor;
  const copy = schedulerViewConfig.copy;
  const editingId = editingJob?.id ?? null;

  const [draft, setDraft] = useState<SchedulerJobDraft>(() => {
    if (editingJob) return draftFromJob(editingJob);
    if (seed) return seed.draft;
    return blankDraft(defaultProviderId, defaultModelId);
  });
  const [preset, setPreset] = useState<RepeatPreset>(() => {
    if (editingJob) return "advanced";
    return seed?.preset ?? "daily";
  });
  const [presetMinutes, setPresetMinutes] = useState(seed?.minutes ?? 15);
  const [presetHour, setPresetHour] = useState(seed?.hour ?? 9);
  const [presetMinute, setPresetMinute] = useState(seed?.minute ?? 0);
  const [presetWeekday, setPresetWeekday] = useState(seed?.weekday ?? 1);
  const [presetMonthDay, setPresetMonthDay] = useState(seed?.monthDay ?? 1);
  const [preview, setPreview] = useState<{
    description: string;
    nextRuns: number[];
    runsNext24h?: number;
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [scheduleCollapsed, setScheduleCollapsed] = useState(
    !!startScheduleCollapsed,
  );

  const pad2 = (n: number): string => String(n).padStart(2, "0");

  /** One-line schedule summary for the collapsed seeded state. */
  const scheduleSummary = (): string => {
    if (draft.scheduleType === "once") {
      if (draft.execAtDate && draft.execAtTime) {
        const ms = new Date(
          `${draft.execAtDate}T${draft.execAtTime}:00`,
        ).getTime();
        if (Number.isFinite(ms)) return formatTime(ms);
      }
      return copy.repeatOnce;
    }
    const hm = `${pad2(presetHour)}:${pad2(presetMinute)}`;
    switch (preset) {
      case "minutes":
        return `${copy.repeatMinutes} (${presetMinutes} ${ec.minutesUnit})`;
      case "hourly":
        return `${copy.repeatHourly} (:${pad2(presetMinute)})`;
      case "daily":
        return `${copy.repeatDaily} (${hm})`;
      case "weekdays":
        return `${copy.repeatWeekdays} (${hm})`;
      case "weekly":
        return `${copy.repeatWeekly} (${weekdayName(presetWeekday)}, ${hm})`;
      case "monthly":
        return `${copy.repeatMonthly} (${presetMonthDay}, ${hm})`;
      case "advanced":
        return `${copy.repeatAdvanced} (${draft.cronExpression || "—"})`;
    }
  };

  const providerModels = useMemo(() => {
    const p = providers.find((x) => x.id === draft.providerId);
    if (!p) return [];
    const ids = new Set<string>();
    if (p.model) ids.add(p.model);
    for (const m of p.models ?? []) ids.add(m.id);
    return [...ids];
  }, [providers, draft.providerId]);

  // Thinking is a per-provider capability (registry-driven): only offered
  // where the provider declares a non-off level.
  const thinkingOffered =
    (providers.find((x) => x.id === draft.providerId)?.thinking ?? "off") !==
    "off";

  function buildPayload(): JobPayload | { error: string } {
    if (!draft.name.trim()) return { error: ec.errName };
    if (!draft.providerId) return { error: ec.errProvider };
    if (!draft.modelId.trim()) return { error: ec.errModel };
    if (!draft.workspacePath.trim()) return { error: ec.errWorkspace };
    if (!draft.prompt.trim()) return { error: ec.errPrompt };
    if (draft.scheduleType === "once") {
      if (!draft.execAtDate || !draft.execAtTime) {
        return { error: ec.errDate };
      }
      const execAt = new Date(
        `${draft.execAtDate}T${draft.execAtTime}:00`,
      ).getTime();
      if (!Number.isFinite(execAt)) return { error: ec.errDateInvalid };
      return {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        enabled: draft.enabled,
        scheduleType: "once",
        cronExpression: null,
        execAt,
        timezone: draft.timezone,
        providerId: draft.providerId,
        modelId: draft.modelId.trim(),
        thinkingLevel: draft.thinkingLevel,
        workspacePath: draft.workspacePath.trim(),
        prompt: draft.prompt,
        conversationPolicy: draft.conversationPolicy,
        conversationId: draft.conversationId,
        maxRetries: draft.maxRetries,
        retryDelaySeconds: draft.retryDelaySeconds,
        timeoutSeconds: draft.timeoutSeconds,
        missedGraceSeconds: draft.missedGraceSeconds,
      };
    }
    const cron =
      preset === "advanced"
        ? draft.cronExpression.trim()
        : presetToCron(preset, {
            minutes: presetMinutes,
            hour: presetHour,
            minute: presetMinute,
            weekday: presetWeekday,
            monthDay: presetMonthDay,
          });
    if (!cron) return { error: ec.errCron };
    return {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      enabled: draft.enabled,
      scheduleType: "cron",
      cronExpression: cron,
      execAt: null,
      timezone: draft.timezone,
      providerId: draft.providerId,
      modelId: draft.modelId.trim(),
      thinkingLevel: draft.thinkingLevel,
      workspacePath: draft.workspacePath.trim(),
      prompt: draft.prompt,
      conversationPolicy: draft.conversationPolicy,
      conversationId: draft.conversationId,
      maxRetries: draft.maxRetries,
      retryDelaySeconds: draft.retryDelaySeconds,
      timeoutSeconds: draft.timeoutSeconds,
      missedGraceSeconds: draft.missedGraceSeconds,
    };
  }

  /** Schedule-only preview input (works with a half-filled form — the live
   *  "Runs every…" sentence must not wait for name/AI/prompt). */
  function schedulePreviewInput(): {
    scheduleType: "once" | "cron";
    cronExpression?: string | null;
    execAt?: number | null;
    timezone: string;
  } | null {
    const timezone = draft.timezone.trim() || systemTimezone();
    if (draft.scheduleType === "once") {
      if (!draft.execAtDate || !draft.execAtTime) return null;
      const execAt = new Date(
        `${draft.execAtDate}T${draft.execAtTime}:00`,
      ).getTime();
      if (!Number.isFinite(execAt)) return null;
      return { scheduleType: "once", execAt, timezone };
    }
    let expr: string;
    try {
      expr =
        preset === "advanced"
          ? draft.cronExpression.trim()
          : presetToCron(preset, {
              minutes: presetMinutes,
              hour: presetHour,
              minute: presetMinute,
              weekday: presetWeekday,
              monthDay: presetMonthDay,
            });
    } catch {
      return null;
    }
    if (!expr) return null;
    return { scheduleType: "cron", cronExpression: expr, timezone };
  }

  // Live schedule sentence: recomputed (debounced) on every When-field
  // change. No Preview button — the sentence IS the preview.
  useEffect(() => {
    const input = schedulePreviewInput();
    if (!input) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      schedulerApi<{
        description: string;
        nextRuns: number[];
        runsNext24h?: number;
      }>("/preview", {
        method: "POST",
        body: JSON.stringify({ ...input, count: 3 }),
      }).then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setPreviewError(res.error ?? ec.errPreview);
          setPreview(null);
          return;
        }
        setPreviewError(null);
        setPreview(res.data);
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    draft.scheduleType,
    draft.execAtDate,
    draft.execAtTime,
    draft.timezone,
    draft.cronExpression,
    preset,
    presetMinutes,
    presetHour,
    presetMinute,
    presetWeekday,
    presetMonthDay,
  ]);

  async function handleSave() {
    const payload = buildPayload();
    if ("error" in payload) {
      onError(payload.error);
      return;
    }
    setSaving(true);
    try {
      const res = editingId
        ? await schedulerApi<SchedulerJob>(`/jobs/${editingId}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          })
        : await schedulerApi<SchedulerJob>("/jobs", {
            method: "POST",
            body: JSON.stringify(payload),
          });
      if (!res.ok) {
        onError(res.error ?? ec.errSave);
        return;
      }
      toast.success(editingId ? ec.jobUpdated : ec.jobCreated);
      onSaved(res.data);
    } finally {
      setSaving(false);
    }
  }

  const repeatModes: Array<[RepeatPreset, string]> = [
    ["minutes", copy.repeatMinutes],
    ["hourly", copy.repeatHourly],
    ["daily", copy.repeatDaily],
    ["weekdays", copy.repeatWeekdays],
    ["weekly", copy.repeatWeekly],
    ["monthly", copy.repeatMonthly],
    ["advanced", copy.repeatAdvanced],
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {onBackToTemplates && (
            <Button size="sm" variant="ghost" onClick={onBackToTemplates}>
              {schedulerViewConfig.copy.backToTemplates}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onCancel}
            aria-label={ec.closeForm}
            title={ec.closeForm}
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </div>

      {/* Title + subtitle — one unit, no boxes or section label. */}
      <div className="space-y-1">
        <Input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder={ec.jobNamePlaceholder}
          aria-label={ec.jobNamePlaceholder}
          className="h-auto border-0 bg-transparent px-0 text-lg font-semibold tracking-tight shadow-none outline-none placeholder:font-normal placeholder:text-muted-foreground/50 focus-visible:ring-0"
        />
        <Input
          value={draft.description}
          onChange={(e) =>
            setDraft({ ...draft, description: e.target.value })
          }
          placeholder={ec.descriptionPlaceholder}
          aria-label={ec.descriptionPlaceholder}
          className="h-auto border-0 bg-transparent px-0 text-sm shadow-none outline-none placeholder:text-muted-foreground/50 focus-visible:ring-0"
        />
      </div>

      {/* WHEN — segmented trigger group + schedule card (codeg trigger grammar).
          Seeded flows start collapsed to a summary line (the template already
          decided the schedule); expanding reveals the full controls. */}
      <div className="flex flex-col gap-2">
        <h3 className={microLabelClass}>{ec.when}</h3>
        {scheduleCollapsed ? (
          <button
            type="button"
            onClick={() => setScheduleCollapsed(false)}
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-card/40 px-3 py-2 text-left outline-none transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <span className="min-w-0 truncate text-sm">{scheduleSummary()}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {ec.change}
            </span>
          </button>
        ) : (
          <>
        <div
          role="group"
          aria-label={ec.when}
          className="inline-flex w-fit rounded-lg border border-border bg-card/40 p-0.5"
        >
          {(
            [
              { value: "once", label: ec.once },
              { value: "cron", label: ec.repeat },
            ] as Array<{ value: "once" | "cron"; label: string }>
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={draft.scheduleType === opt.value}
              onClick={() => setDraft({ ...draft, scheduleType: opt.value })}
              className={
                draft.scheduleType === opt.value
                  ? "rounded-md bg-background px-3 py-1 text-xs font-medium text-foreground shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  : "rounded-md px-3 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              }
            >
              {opt.label}
            </button>
          ))}
        </div>
        {draft.scheduleType === "once" ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-3">
            <div className="flex gap-2">
              <div className="flex-1 space-y-1">
                <div className={labelClass}>{ec.date}</div>
                <Input
                  type="date"
                  value={draft.execAtDate}
                  onChange={(e) =>
                    setDraft({ ...draft, execAtDate: e.target.value })
                  }
                />
              </div>
              <div className="flex-1 space-y-1">
                <div className={labelClass}>{ec.time}</div>
                <Input
                  type="time"
                  value={draft.execAtTime}
                  onChange={(e) =>
                    setDraft({ ...draft, execAtTime: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  [ec.quickSlot1h, () => new Date(Date.now() + 3600_000)],
                  [ec.quickSlotTomorrow, () => {
                    const d = new Date();
                    d.setDate(d.getDate() + 1);
                    d.setHours(9, 0, 0, 0);
                    return d;
                  }],
                  [ec.quickSlotNextMon, () => {
                    const d = new Date();
                    const delta = ((8 - d.getDay()) % 7) || 7;
                    d.setDate(d.getDate() + delta);
                    d.setHours(9, 0, 0, 0);
                    return d;
                  }],
                ] as Array<[string, () => Date]>
              ).map(([label, make]) => (
                <Button
                  key={label}
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    const slot = toDateTimeStrings(make());
                    setDraft({
                      ...draft,
                      execAtDate: slot.date,
                      execAtTime: slot.time,
                    });
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-3">
            <div className="flex flex-wrap gap-1">
              {repeatModes.map(([value, label]) => (
                <Button
                  key={value}
                  size="xs"
                  variant={preset === value ? "default" : "outline"}
                  onClick={() => setPreset(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
            {/* Sentence-style schedule row: one dynamic line per mode with
                only its inputs inline (labels would restate the mode chip). */}
            {preset === "minutes" && (
              <div className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="text-muted-foreground">{ec.sentenceEvery}</span>
                <Input
                  type="number"
                  min={1}
                  max={59}
                  className="h-8 w-16"
                  value={presetMinutes}
                  onChange={(e) =>
                    setPresetMinutes(Number(e.target.value) || 1)
                  }
                  aria-label={ec.everyNMinutes}
                />
                <span className="text-muted-foreground">{ec.minutesUnit}</span>
              </div>
            )}
            {preset === "hourly" && (
              <div className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="text-muted-foreground">{ec.sentenceAt}</span>
                <Input
                  type="number"
                  min={0}
                  max={59}
                  className="h-8 w-16"
                  value={presetMinute}
                  onChange={(e) =>
                    setPresetMinute(Number(e.target.value) || 0)
                  }
                  aria-label={ec.minute}
                />
                <span className="text-muted-foreground">{ec.minutePast}</span>
              </div>
            )}
            {(preset === "daily" || preset === "weekdays") && (
              <div className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="text-muted-foreground">{ec.sentenceAt}</span>
                <TimeFields
                  hour={presetHour}
                  minute={presetMinute}
                  hourLabel={ec.hour}
                  minuteLabel={ec.minute}
                  onHour={(v) => setPresetHour(v)}
                  onMinute={(v) => setPresetMinute(v)}
                />
                {preset === "weekdays" && (
                  <span className="text-xs text-muted-foreground">
                    ({ec.weekdaysHint})
                  </span>
                )}
              </div>
            )}
            {preset === "weekly" && (
              <div className="flex flex-wrap items-center gap-1.5 text-sm">
                <select
                  className={selectClass}
                  value={presetWeekday}
                  onChange={(e) =>
                    setPresetWeekday(Number(e.target.value))
                  }
                  aria-label={ec.day}
                >
                  {[0, 1, 2, 3, 4, 5, 6].map((n) => (
                    <option key={n} value={n}>
                      {weekdayName(n)}
                    </option>
                  ))}
                </select>
                <span className="text-muted-foreground">{ec.sentenceAt}</span>
                <TimeFields
                  hour={presetHour}
                  minute={presetMinute}
                  hourLabel={ec.hour}
                  minuteLabel={ec.minute}
                  onHour={(v) => setPresetHour(v)}
                  onMinute={(v) => setPresetMinute(v)}
                />
              </div>
            )}
            {preset === "monthly" && (
              <div className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="text-muted-foreground">{ec.day}</span>
                <Input
                  type="number"
                  min={1}
                  max={28}
                  className="h-8 w-16"
                  value={presetMonthDay}
                  onChange={(e) =>
                    setPresetMonthDay(Number(e.target.value) || 1)
                  }
                  aria-label={ec.monthDay}
                />
                <span className="text-muted-foreground">{ec.sentenceAt}</span>
                <TimeFields
                  hour={presetHour}
                  minute={presetMinute}
                  hourLabel={ec.hour}
                  minuteLabel={ec.minute}
                  onHour={(v) => setPresetHour(v)}
                  onMinute={(v) => setPresetMinute(v)}
                />
              </div>
            )}
            {preset === "advanced" && (
              <div className="space-y-1">
                <div className={labelClass}>{ec.customExpression}</div>
                <Input
                  placeholder={ec.cronPlaceholder}
                  value={draft.cronExpression}
                  onChange={(e) =>
                    setDraft({ ...draft, cronExpression: e.target.value })
                  }
                  className="font-mono"
                />
              </div>
            )}
            {preset === "advanced" && (
              <div className="space-y-1">
                <div className={labelClass}>{ec.popularPatterns}</div>
                <div className="flex flex-wrap gap-1">
                  {copy.patternList.map(([expr, label]) => (
                    <Button
                      key={expr}
                      size="xs"
                      variant="outline"
                      title={expr}
                      onClick={() => {
                        setDraft({ ...draft, cronExpression: expr });
                      }}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
          </>
        )}
        <div className="space-y-1">
          <div className={labelClass}>{ec.timezone}</div>
          <Input
            placeholder={ec.timezonePlaceholder}
            value={draft.timezone}
            onChange={(e) =>
              setDraft({ ...draft, timezone: e.target.value })
            }
          />
        </div>
        <div className="text-xs">
          {previewError && (
            <span className="text-destructive">{previewError}</span>
          )}
          {!previewError && preview && (
            <span className="text-muted-foreground">
              Runs {preview.description.charAt(0).toLowerCase() +
                preview.description.slice(1)}{" "}
              ·{" "}
              {preview.nextRuns
                .map((t) => new Date(t).toLocaleString())
                .join(" · ")}
              {typeof preview.runsNext24h === "number" &&
                ec.runsIn24h(preview.runsNext24h)}
            </span>
          )}
          {!previewError && !preview && (
            <span className="text-muted-foreground">
              {draft.scheduleType === "once"
                ? ec.pickDateHintOnce
                : ec.pickDateHintRepeat}
            </span>
          )}
        </div>
      </div>

      {/* AI */}
      <div className="space-y-2">
        <h3 className={microLabelClass}>{ec.ai}</h3>
        <div className="flex gap-2">
          <div className="flex-1 space-y-1">
            <div className={labelClass}>{ec.provider}</div>
            <select
              className={selectClass}
              value={draft.providerId}
              onChange={(e) => {
                const p = providers.find((x) => x.id === e.target.value);
                setDraft({
                  ...draft,
                  providerId: e.target.value,
                  modelId: p?.model ?? "",
                  thinkingLevel:
                    p?.thinking && p.thinking !== "off"
                      ? draft.thinkingLevel
                      : "off",
                });
              }}
            >
              <option value="">{ec.selectProvider}</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1 space-y-1">
            <div className={labelClass}>{ec.model}</div>
            <select
              className={selectClass}
              value={draft.modelId}
              onChange={(e) =>
                setDraft({ ...draft, modelId: e.target.value })
              }
            >
              <option value="">{ec.selectModel}</option>
              {providerModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          {thinkingOffered && (
          <div className="flex-1 space-y-1">
            <div className={labelClass}>{ec.thinking}</div>
            <select
              className={selectClass}
              value={draft.thinkingLevel}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  thinkingLevel: e.target.value as SchedulerJobDraft["thinkingLevel"],
                })
              }
            >
              <option value="off">{ec.thinkingOff}</option>
              <option value="low">{ec.thinkingLow}</option>
              <option value="medium">{ec.thinkingMedium}</option>
              <option value="high">{ec.thinkingHigh}</option>
            </select>
          </div>
          )}
        </div>
      </div>

      {/* WORKSPACE */}
      <div className="space-y-2">
        <h3 className={microLabelClass}>{ec.workspace}</h3>
        <Input
          placeholder={ec.workspacePlaceholder}
          value={draft.workspacePath}
          onChange={(e) =>
            setDraft({ ...draft, workspacePath: e.target.value })
          }
        />
      </div>

      {/* PROMPT */}
      <div className="space-y-2">
        <h3 className={microLabelClass}>{ec.prompt}</h3>
        <Textarea
          placeholder={ec.promptPlaceholder}
          rows={3}
          value={draft.prompt}
          onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
        />
      </div>

      {/* CONVERSATION */}
      <div className="space-y-2">
        <h3 className={microLabelClass}>{ec.conversation}</h3>
        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="radio"
              name="conversationPolicy"
              checked={draft.conversationPolicy === "dedicated_thread"}
              onChange={() =>
                setDraft({
                  ...draft,
                  conversationPolicy: "dedicated_thread",
                  conversationId: null,
                })
              }
            />
            <span>{ec.newDedicated}</span>
            <span className="text-xs text-muted-foreground">
              {ec.newDedicatedHint}
            </span>
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="radio"
              name="conversationPolicy"
              checked={draft.conversationPolicy === "existing_thread"}
              onChange={() =>
                setDraft({
                  ...draft,
                  conversationPolicy: "existing_thread",
                })
              }
            />
            <span>{ec.existingChat}</span>
          </label>
          {draft.conversationPolicy === "existing_thread" && (
            <div className="ml-6 space-y-1">
              <div className={labelClass}>{ec.selectConversation}</div>
              <select
                className={selectClass}
                value={draft.conversationId ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    conversationId: e.target.value || null,
                  })
                }
              >
                <option value="">{ec.selectConversationPlaceholder}</option>
                {conversations.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* EXECUTION — rarely touched tuning behind a disclosure (values
          still load, validate, and save; only the chrome collapses). */}
      <Collapsible>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-1.5 rounded-md outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring [&[data-state=open]>svg]:rotate-180"
          >
            <span className={microLabelClass}>{ec.advancedOptions}</span>
            <ChevronDown
              aria-hidden="true"
              className="size-3.5 text-muted-foreground transition-transform duration-150"
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-2">
        <div className="flex gap-2">
          <div className="flex-1 space-y-1">
            <div className={labelClass}>{ec.maxRetries}</div>
            <Input
              type="number"
              min={0}
              max={10}
              value={draft.maxRetries}
              onChange={(e) =>
                setDraft({ ...draft, maxRetries: Number(e.target.value) || 0 })
              }
            />
          </div>
          <div className="flex-1 space-y-1">
            <div className={labelClass}>{ec.retryDelay}</div>
            <Input
              type="number"
              min={0}
              max={3600}
              value={draft.retryDelaySeconds}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  retryDelaySeconds: Number(e.target.value) || 0,
                })
              }
            />
          </div>
          <div className="flex-1 space-y-1">
            <div className={labelClass}>{ec.timeout}</div>
            <Input
              type="number"
              min={10}
              max={7200}
              value={draft.timeoutSeconds}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  timeoutSeconds: Number(e.target.value) || 600,
                })
              }
            />
          </div>
          <div className="flex-1 space-y-1">
            <div className={labelClass}>{ec.missedGrace}</div>
            <Input
              type="number"
              min={0}
              max={86400}
              value={draft.missedGraceSeconds}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  missedGraceSeconds: Number(e.target.value) || 0,
                })
              }
            />
          </div>
        </div>
        <div className="text-xs text-muted-foreground">{ec.overlapNote}</div>
        </CollapsibleContent>
      </Collapsible>

      <div className="flex gap-2">
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? ec.saving : editingId ? ec.save : ec.create}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {ec.cancel}
        </Button>
      </div>
    </div>
  );
}
