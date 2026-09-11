import { useEffect, useMemo, useState } from "react";
import { Button, Input, Textarea } from "./ui";
import { useSchedulerStore, schedulerApi } from "../stores/schedulerStore";
import { useSettingsStore } from "../stores";
import { cn } from "../lib/utils";
import { SettingsError, SettingsSection } from "./shared/settings";
import type {
  SchedulerJob,
  SchedulerJobDraft,
  SchedulerJobPublic,
  SchedulerRun,
} from "../types";
import {
  Plus,
  Trash2,
  Pencil,
  X,
  Play,
  Pause,
  Clock,
  History,
} from "lucide-react";

type RepeatPreset =
  | "minutes"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "advanced";

const selectClass =
  "w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm";
const labelClass = "text-xs font-medium text-muted-foreground";
const sectionClass = "text-sm font-semibold";

function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function blankDraft(providerId: string, modelId: string): SchedulerJobDraft {
  return {
    name: "",
    description: "",
    enabled: true,
    scheduleType: "once",
    cronExpression: "0 9 * * *",
    execAtDate: "",
    execAtTime: "",
    timezone: systemTimezone(),
    providerId,
    modelId,
    thinkingLevel: "off",
    workspacePath: "",
    prompt: "",
    maxRetries: 0,
    retryDelaySeconds: 60,
    timeoutSeconds: 600,
    missedGraceSeconds: 600,
  };
}

function draftFromJob(job: SchedulerJob): SchedulerJobDraft {
  let execAtDate = "";
  let execAtTime = "";
  if (job.scheduleType === "once" && job.execAt) {
    const d = new Date(job.execAt);
    const p2 = (n: number): string => String(n).padStart(2, "0");
    execAtDate = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    execAtTime = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
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
    providerId: job.providerId,
    modelId: job.modelId,
    thinkingLevel: job.thinkingLevel ?? "off",
    workspacePath: job.workspacePath,
    prompt: job.prompt ?? "",
    maxRetries: job.maxRetries,
    retryDelaySeconds: job.retryDelaySeconds,
    timeoutSeconds: job.timeoutSeconds,
    missedGraceSeconds: job.missedGraceSeconds,
  };
}

function presetToCron(
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
  maxRetries: number;
  retryDelaySeconds: number;
  timeoutSeconds: number;
  missedGraceSeconds: number;
}

function formatTime(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

function statusClass(status: string): string {
  switch (status) {
    case "active":
    case "completed":
      return "text-green-600 dark:text-green-400";
    case "running":
    case "scheduled":
      return "text-blue-600 dark:text-blue-400";
    case "failed":
    case "missed":
    case "expired":
      return "text-red-600 dark:text-red-400";
    case "skipped":
    case "interrupted":
    case "paused":
    case "cancelled":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-muted-foreground";
  }
}

export function SchedulerPanel() {
  const { jobs, runsByJob, loading, error, loadJobs, loadRuns, setError } =
    useSchedulerStore();
  const { providers, loadProviders } = useSettingsStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [draft, setDraft] = useState<SchedulerJobDraft>(() =>
    blankDraft(providers[0]?.id ?? "", providers[0]?.model ?? ""),
  );
  const [preset, setPreset] = useState<RepeatPreset>("daily");
  const [presetMinutes, setPresetMinutes] = useState(15);
  const [presetHour, setPresetHour] = useState(9);
  const [presetMinute, setPresetMinute] = useState(0);
  const [presetWeekday, setPresetWeekday] = useState(1);
  const [presetMonthDay, setPresetMonthDay] = useState(1);
  const [preview, setPreview] = useState<{
    description: string;
    nextRuns: number[];
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [historyJobId, setHistoryJobId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<SchedulerRun | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadJobs();
    loadProviders();
  }, [loadJobs, loadProviders]);

  useEffect(() => {
    if (historyJobId) loadRuns(historyJobId);
  }, [historyJobId, loadRuns]);

  const historyRuns = historyJobId ? runsByJob[historyJobId] ?? [] : [];
  const historyJob = useMemo(
    () => jobs.find((j) => j.id === historyJobId) ?? null,
    [jobs, historyJobId],
  );

  function openAdd() {
    setEditingId(null);
    setDraft(
      blankDraft(providers[0]?.id ?? "", providers[0]?.model ?? ""),
    );
    setPreset("daily");
    setPreview(null);
    setPreviewError(null);
    setIsAdding(true);
  }

  function openEdit(job: SchedulerJobPublic) {
    setIsAdding(false);
    setEditingId(job.id);
    setDraft(draftFromJob(job as unknown as SchedulerJob));
    setPreview(null);
    setPreviewError(null);
  }

  function buildPayload(): JobPayload | { error: string } {
    if (!draft.name.trim()) return { error: "Name is required" };
    if (!draft.providerId) return { error: "Provider is required" };
    if (!draft.modelId.trim()) return { error: "Model is required" };
    if (!draft.workspacePath.trim()) return { error: "Workspace path is required" };
    if (!draft.prompt.trim()) return { error: "Prompt is required" };
    if (draft.scheduleType === "once") {
      if (!draft.execAtDate || !draft.execAtTime) {
        return { error: "Date and time are required for a one-time job" };
      }
      const execAt = new Date(
        `${draft.execAtDate}T${draft.execAtTime}:00`,
      ).getTime();
      if (!Number.isFinite(execAt)) return { error: "Invalid date/time" };
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
    if (!cron) return { error: "A cron expression is required" };
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
      maxRetries: draft.maxRetries,
      retryDelaySeconds: draft.retryDelaySeconds,
      timeoutSeconds: draft.timeoutSeconds,
      missedGraceSeconds: draft.missedGraceSeconds,
    };
  }

  async function handlePreview() {
    const payload = buildPayload();
    if ("error" in payload) {
      setPreviewError(payload.error);
      setPreview(null);
      return;
    }
    const res = await schedulerApi<{
      description: string;
      nextRuns: number[];
    }>("/preview", {
      method: "POST",
      body: JSON.stringify({
        scheduleType: payload.scheduleType,
        cronExpression: payload.cronExpression ?? null,
        execAt: payload.execAt ?? null,
        timezone: payload.timezone,
        count: 3,
      }),
    });
    if (!res.ok) {
      setPreviewError(res.error ?? "Preview failed");
      setPreview(null);
      return;
    }
    setPreviewError(null);
    setPreview(res.data);
  }

  async function handleSave() {
    const payload = buildPayload();
    if ("error" in payload) {
      setError(payload.error);
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
        setError(res.error ?? "Save failed");
        return;
      }
      setIsAdding(false);
      setEditingId(null);
      await loadJobs();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this scheduled job? Run history is removed too.")) {
      return;
    }
    const res = await schedulerApi(`/jobs/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError(res.error ?? "Delete failed");
      return;
    }
    if (historyJobId === id) setHistoryJobId(null);
    await loadJobs();
  }

  async function handleToggle(job: SchedulerJobPublic) {
    const action = job.enabled ? "disable" : "enable";
    const res = await schedulerApi(`/jobs/${job.id}/${action}`, {
      method: "POST",
    });
    if (!res.ok) {
      setError(res.error ?? `${action} failed`);
      return;
    }
    await loadJobs();
  }

  async function handleRunNow(job: SchedulerJobPublic) {
    const res = await schedulerApi<{ runId: string }>(`/jobs/${job.id}/run`, {
      method: "POST",
    });
    if (!res.ok) {
      setError(res.error ?? "Run failed");
      return;
    }
    setHistoryJobId(job.id);
    await loadRuns(job.id);
  }

  function scheduleLabel(job: SchedulerJobPublic): string {
    if (job.scheduleType === "once") {
      return job.execAt ? `Once at ${formatTime(job.execAt)}` : "Once";
    }
    return job.cronExpression ?? "Cron";
  }

  const providerModels = useMemo(() => {
    const p = providers.find((x) => x.id === draft.providerId);
    if (!p) return [];
    const ids = new Set<string>();
    if (p.model) ids.add(p.model);
    for (const m of p.models ?? []) ids.add(m.id);
    return [...ids];
  }, [providers, draft.providerId]);

  return (
    <div className="h-full space-y-4 overflow-y-auto p-4">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <Clock className="h-5 w-5" /> Scheduler
        </h1>
        <p className="text-xs leading-5 text-muted-foreground">
          One-time and recurring automated runs. Timers rebuild from the
          database on restart; destructive tools always require approval.
        </p>
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={openAdd}>
          <Plus className="h-4 w-4 mr-1" /> New Job
        </Button>
      </div>

      {error && (
        <SettingsError>
          <span className="flex-1">{error}</span>
          <Button size="sm" variant="ghost" onClick={() => setError(null)} aria-label="Dismiss error">
            <X className="h-4 w-4" />
          </Button>
        </SettingsError>
      )}

      {/* Job table */}
      <SettingsSection
        title="Scheduled jobs"
        icon={Clock}
        description={jobs.length === 0 ? undefined : `${jobs.length} job(s)`}
      >
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b border-border">
              <th className="p-2">Enabled</th>
              <th className="p-2">Name</th>
              <th className="p-2">Schedule</th>
              <th className="p-2">AI</th>
              <th className="p-2">Thinking</th>
              <th className="p-2">Workspace</th>
              <th className="p-2">Next Run</th>
              <th className="p-2">Status</th>
              <th className="p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} className="border-b border-border last:border-0">
                <td className="p-2">
                  <input
                    type="checkbox"
                    checked={job.enabled}
                    onChange={() => handleToggle(job)}
                    aria-label={job.enabled ? "Disable job" : "Enable job"}
                  />
                </td>
                <td className="p-2 font-medium">{job.name}</td>
                <td className="p-2 text-xs">{scheduleLabel(job)}</td>
                <td className="p-2 text-xs">
                  {providers.find((p) => p.id === job.providerId)?.name ??
                    job.providerId}
                  {" / "}
                  {job.modelId}
                </td>
                <td className="p-2 text-xs">{job.thinkingLevel ?? "off"}</td>
                <td
                  className="p-2 text-xs max-w-40 truncate"
                  title={job.workspacePath}
                >
                  {job.workspacePath}
                </td>
                <td className="p-2 text-xs">{formatTime(job.nextRunAt)}</td>
                <td className={cn("p-2 text-xs font-medium", statusClass(job.status))}>
                  {job.status}
                </td>
                <td className="p-2">
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Run now"
                      disabled={!job.enabled}
                      onClick={() => handleRunNow(job)}
                    >
                      <Play className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title={job.enabled ? "Disable" : "Enable"}
                      onClick={() => handleToggle(job)}
                    >
                      {job.enabled ? (
                        <Pause className="h-4 w-4" />
                      ) : (
                        <Clock className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title="History"
                      onClick={() =>
                        setHistoryJobId(historyJobId === job.id ? null : job.id)
                      }
                    >
                      <History className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Edit"
                      onClick={() => openEdit(job)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Delete"
                      onClick={() => handleDelete(job.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && jobs.length === 0 && (
              <tr>
                <td colSpan={9} className="p-4 text-center text-muted-foreground">
                  No scheduled jobs yet. Create one with “New Job”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      </SettingsSection>

      {/* Create/Edit form */}
      {(isAdding || editingId !== null) && (
        <SettingsSection
          title={editingId ? "Edit Job" : "New Job"}
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setIsAdding(false);
                setEditingId(null);
              }}
              aria-label="Close form"
            >
              <X className="h-4 w-4" />
            </Button>
          }
        >
        <div className="space-y-4">

          {/* GENERAL */}
          <div className="space-y-2">
            <div className={sectionClass}>General</div>
            <Input
              placeholder="Job name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <Input
              placeholder="Description (optional)"
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
          </div>

          {/* WHEN */}
          <div className="space-y-2">
            <div className={sectionClass}>When</div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={draft.scheduleType === "once" ? "default" : "ghost"}
                onClick={() => setDraft({ ...draft, scheduleType: "once" })}
              >
                Once
              </Button>
              <Button
                size="sm"
                variant={draft.scheduleType === "cron" ? "default" : "ghost"}
                onClick={() => setDraft({ ...draft, scheduleType: "cron" })}
              >
                Repeat
              </Button>
            </div>
            {draft.scheduleType === "once" ? (
              <div className="flex gap-2">
                <div className="flex-1 space-y-1">
                  <div className={labelClass}>Date</div>
                  <Input
                    type="date"
                    value={draft.execAtDate}
                    onChange={(e) =>
                      setDraft({ ...draft, execAtDate: e.target.value })
                    }
                  />
                </div>
                <div className="flex-1 space-y-1">
                  <div className={labelClass}>Time</div>
                  <Input
                    type="time"
                    value={draft.execAtTime}
                    onChange={(e) =>
                      setDraft({ ...draft, execAtTime: e.target.value })
                    }
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="space-y-1">
                  <div className={labelClass}>Repeat</div>
                  <select
                    className={selectClass}
                    value={preset}
                    onChange={(e) => setPreset(e.target.value as RepeatPreset)}
                  >
                    <option value="minutes">Every N minutes</option>
                    <option value="hourly">Hourly</option>
                    <option value="daily">Daily</option>
                    <option value="weekdays">Weekdays</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="advanced">Advanced Cron</option>
                  </select>
                </div>
                {preset === "minutes" && (
                  <div className="space-y-1">
                    <div className={labelClass}>Every N minutes (1-59)</div>
                    <Input
                      type="number"
                      min={1}
                      max={59}
                      value={presetMinutes}
                      onChange={(e) =>
                        setPresetMinutes(Number(e.target.value) || 1)
                      }
                    />
                  </div>
                )}
                {(preset === "hourly" ||
                  preset === "daily" ||
                  preset === "weekdays" ||
                  preset === "weekly" ||
                  preset === "monthly") && (
                  <div className="flex gap-2">
                    <div className="flex-1 space-y-1">
                      <div className={labelClass}>Hour (0-23)</div>
                      <Input
                        type="number"
                        min={0}
                        max={23}
                        value={presetHour}
                        onChange={(e) =>
                          setPresetHour(Number(e.target.value) || 0)
                        }
                      />
                    </div>
                    <div className="flex-1 space-y-1">
                      <div className={labelClass}>Minute (0-59)</div>
                      <Input
                        type="number"
                        min={0}
                        max={59}
                        value={presetMinute}
                        onChange={(e) =>
                          setPresetMinute(Number(e.target.value) || 0)
                        }
                      />
                    </div>
                    {preset === "weekly" && (
                      <div className="flex-1 space-y-1">
                        <div className={labelClass}>Day</div>
                        <select
                          className={selectClass}
                          value={presetWeekday}
                          onChange={(e) =>
                            setPresetWeekday(Number(e.target.value))
                          }
                        >
                          <option value={0}>Sunday</option>
                          <option value={1}>Monday</option>
                          <option value={2}>Tuesday</option>
                          <option value={3}>Wednesday</option>
                          <option value={4}>Thursday</option>
                          <option value={5}>Friday</option>
                          <option value={6}>Saturday</option>
                        </select>
                      </div>
                    )}
                    {preset === "monthly" && (
                      <div className="flex-1 space-y-1">
                        <div className={labelClass}>Day (1-28)</div>
                        <Input
                          type="number"
                          min={1}
                          max={28}
                          value={presetMonthDay}
                          onChange={(e) =>
                            setPresetMonthDay(Number(e.target.value) || 1)
                          }
                        />
                      </div>
                    )}
                  </div>
                )}
                {preset === "advanced" && (
                  <div className="space-y-1">
                    <div className={labelClass}>
                      Cron expression (minute hour day month weekday)
                    </div>
                    <Input
                      placeholder="0 9 * * *"
                      value={draft.cronExpression}
                      onChange={(e) =>
                        setDraft({ ...draft, cronExpression: e.target.value })
                      }
                    />
                  </div>
                )}
              </div>
            )}
            <div className="space-y-1">
              <div className={labelClass}>Timezone</div>
              <Input
                placeholder="Asia/Kolkata"
                value={draft.timezone}
                onChange={(e) =>
                  setDraft({ ...draft, timezone: e.target.value })
                }
              />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={handlePreview}>
                Preview schedule
              </Button>
              {previewError && (
                <span className="text-xs text-red-600 dark:text-red-400">
                  {previewError}
                </span>
              )}
              {preview && (
                <span className="text-xs text-muted-foreground">
                  {preview.description} ·{" "}
                  {preview.nextRuns
                    .map((t) => new Date(t).toLocaleString())
                    .join(" · ")}
                </span>
              )}
            </div>
          </div>

          {/* AI */}
          <div className="space-y-2">
            <div className={sectionClass}>AI</div>
            <div className="flex gap-2">
              <div className="flex-1 space-y-1">
                <div className={labelClass}>Provider</div>
                <select
                  className={selectClass}
                  value={draft.providerId}
                  onChange={(e) => {
                    const p = providers.find((x) => x.id === e.target.value);
                    setDraft({
                      ...draft,
                      providerId: e.target.value,
                      modelId: p?.model ?? "",
                    });
                  }}
                >
                  <option value="">Select provider…</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-1 space-y-1">
                <div className={labelClass}>Model</div>
                <select
                  className={selectClass}
                  value={draft.modelId}
                  onChange={(e) =>
                    setDraft({ ...draft, modelId: e.target.value })
                  }
                >
                  <option value="">Select model…</option>
                  {providerModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-1 space-y-1">
                <div className={labelClass}>Thinking</div>
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
                  <option value="off">Off</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
            </div>
          </div>

          {/* WORKSPACE */}
          <div className="space-y-2">
            <div className={sectionClass}>Workspace</div>
            <Input
              placeholder="Absolute folder path inside the TBAi workspace root"
              value={draft.workspacePath}
              onChange={(e) =>
                setDraft({ ...draft, workspacePath: e.target.value })
              }
            />
          </div>

          {/* PROMPT */}
          <div className="space-y-2">
            <div className={sectionClass}>Prompt</div>
            <Textarea
              placeholder="What should the scheduled run do?"
              rows={5}
              value={draft.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            />
          </div>

          {/* EXECUTION */}
          <div className="space-y-2">
            <div className={sectionClass}>Execution</div>
            <div className="flex gap-2">
              <div className="flex-1 space-y-1">
                <div className={labelClass}>Max retries (0-10)</div>
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
                <div className={labelClass}>Retry delay (s)</div>
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
                <div className={labelClass}>Timeout (s)</div>
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
                <div className={labelClass}>Missed grace (s)</div>
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
            <div className="text-xs text-muted-foreground">
              Overlap: skip if a previous run is still running. Destructive
              tools always require interactive approval and refuse in scheduled
              runs.
            </div>
          </div>

          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : editingId ? "Save" : "Create"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setIsAdding(false);
                setEditingId(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
        </SettingsSection>
      )}

      {/* Run history */}
      {historyJob && (
        <SettingsSection
          title={`History — ${historyJob.name}`}
          icon={History}
          action={
            <Button size="sm" variant="ghost" onClick={() => setHistoryJobId(null)} aria-label="Close history">
              <X className="h-4 w-4" />
            </Button>
          }
        >
          <div className="rounded-md border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="p-2">Time</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Duration</th>
                  <th className="p-2">AI</th>
                  <th className="p-2">Attempt</th>
                  <th className="p-2">Error</th>
                </tr>
              </thead>
              <tbody>
                {historyRuns.map((run) => (
                  <tr
                    key={run.id}
                    className={cn(
                      "border-b border-border last:border-0 cursor-pointer hover:bg-muted/50",
                      selectedRun?.id === run.id && "bg-muted/50",
                    )}
                    onClick={() =>
                      setSelectedRun(selectedRun?.id === run.id ? null : run)
                    }
                  >
                    <td className="p-2 text-xs">
                      {new Date(run.startedAt).toLocaleString()}
                    </td>
                    <td className={cn("p-2 text-xs font-medium", statusClass(run.status))}>
                      {run.status}
                    </td>
                    <td className="p-2 text-xs">
                      {run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : "—"}
                    </td>
                    <td className="p-2 text-xs">{run.modelId}</td>
                    <td className="p-2 text-xs">{run.attempt}</td>
                    <td className="p-2 text-xs max-w-60 truncate" title={run.error ?? ""}>
                      {run.error ?? "—"}
                    </td>
                  </tr>
                ))}
                {historyRuns.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-4 text-center text-muted-foreground">
                      No runs yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {selectedRun && (
            <div className="text-xs space-y-1 rounded-md bg-muted/50 p-2">
              <div>
                <span className="text-muted-foreground">runId:</span>{" "}
                {selectedRun.id}
              </div>
              <div>
                <span className="text-muted-foreground">occurrenceId:</span>{" "}
                {selectedRun.occurrenceId}
              </div>
              <div>
                <span className="text-muted-foreground">requestId:</span>{" "}
                {selectedRun.requestId ?? "—"}
              </div>
              <div>
                <span className="text-muted-foreground">started:</span>{" "}
                {new Date(selectedRun.startedAt).toLocaleString()}
                {" · "}
                <span className="text-muted-foreground">completed:</span>{" "}
                {selectedRun.completedAt
                  ? new Date(selectedRun.completedAt).toLocaleString()
                  : "—"}
              </div>
              <div>
                <span className="text-muted-foreground">provider/model:</span>{" "}
                {selectedRun.providerId} / {selectedRun.modelId}
              </div>
              <div>
                <span className="text-muted-foreground">workspace:</span>{" "}
                {selectedRun.workspacePath}
              </div>
              {selectedRun.error && (
                <div>
                  <span className="text-muted-foreground">error:</span>{" "}
                  {selectedRun.error}
                </div>
              )}
              {selectedRun.outputExcerpt && (
                <div>
                  <span className="text-muted-foreground">output:</span>{" "}
                  {selectedRun.outputExcerpt.slice(0, 500)}
                </div>
              )}
            </div>
          )}
        </SettingsSection>
      )}
    </div>
  );
}
