import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
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
  Copy,
  History,
  MessageSquare,
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

function toDateTimeStrings(d: Date): { date: string; time: string } {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
    time: `${p2(d.getHours())}:${p2(d.getMinutes())}`,
  };
}

/** Default one-time slot: right now (user expectation on create). */
function defaultOnceSlot(): { date: string; time: string } {
  const d = new Date();
  d.setSeconds(0, 0);
  return toDateTimeStrings(d);
}

function blankDraft(providerId: string, modelId: string): SchedulerJobDraft {
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
    conversationPolicy: job.conversationPolicy,
    conversationId: job.conversationId,
    maxRetries: job.maxRetries,
    retryDelaySeconds: job.retryDelaySeconds,
    timeoutSeconds: job.timeoutSeconds,
    missedGraceSeconds: job.missedGraceSeconds,
  };
}

interface JobTemplate {
  name: string;
  description: string;
  prompt: string;
  scheduleType: "once" | "cron";
  /** Repeat mode the template selects (fixes silent-overwrite: the mode is
   * part of the template, not left on whatever the form had). */
  mode: RepeatPreset;
  cronExpression: string;
  minutes?: number;
  hour?: number;
  minute?: number;
  weekday?: number;
  monthDay?: number;
}

/** One-click starters (codeg parity: template gallery instead of blank form). */
const JOB_TEMPLATES: JobTemplate[] = [
  {
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
    name: "Business-hours watch",
    description: "Every half hour, 9–17 on all days",
    prompt:
      "Check the workspace for errors, failures, or stuck work and report briefly. Stay silent-equivalent: one short paragraph.",
    scheduleType: "cron",
    mode: "advanced",
    cronExpression: "0,30 9-17 * * *",
  },
  {
    name: "Security sweep",
    description: "Weekly scan for obvious risks",
    prompt:
      "Scan the workspace for obvious security risks (secrets in files, unsafe scripts, suspicious dependencies) and report findings. Do not change any files.",
    scheduleType: "cron",
    mode: "advanced",
    cronExpression: "@weekly",
  },
];

function applyTemplate(
  t: JobTemplate,
  setDraft: (updater: (d: SchedulerJobDraft) => SchedulerJobDraft) => void,
  setPreset: (mode: RepeatPreset) => void,
  setters: {
    setMinutes: (n: number) => void;
    setHour: (n: number) => void;
    setMinute: (n: number) => void;
    setWeekday: (n: number) => void;
    setMonthDay: (n: number) => void;
  },
): void {
  setDraft((d) => ({
    ...d,
    name: d.name || t.name,
    description: t.description,
    prompt: t.prompt,
    scheduleType: t.scheduleType,
    cronExpression: t.cronExpression,
  }));
  setPreset(t.mode);
  if (t.minutes !== undefined) setters.setMinutes(t.minutes);
  if (t.hour !== undefined) setters.setHour(t.hour);
  if (t.minute !== undefined) setters.setMinute(t.minute);
  if (t.weekday !== undefined) setters.setWeekday(t.weekday);
  if (t.monthDay !== undefined) setters.setMonthDay(t.monthDay);
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
  conversationPolicy: "dedicated_thread" | "existing_thread";
  conversationId: string | null;
  maxRetries: number;
  retryDelaySeconds: number;
  timeoutSeconds: number;
  missedGraceSeconds: number;
}

function formatTime(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

/** Last-seen timestamp for the failure badge (codeg: cleared on view). */
function readSeenTs(): number {
  try {
    return Number(window.localStorage.getItem("tbai:schedSeenTs") ?? 0) || 0;
  } catch {
    return 0;
  }
}

function formatRelative(ms: number | null): string {
  if (!ms) return "—";
  const diff = ms - Date.now();
  if (diff <= 0) return "due now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "in seconds";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
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
  const navigate = useNavigate();
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
    runsNext24h?: number;
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [historyJobId, setHistoryJobId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<SchedulerRun | null>(null);
  const [saving, setSaving] = useState(false);
  const [conversations, setConversations] = useState<
    Array<{ id: string; title: string }>
  >([]);
  const [problems, setProblems] = useState<
    Array<{
      id: string;
      jobId: string;
      jobName: string | null;
      status: string;
      startedAt: number;
      error: string | null;
    }>
  >([]);
  const [seenTs, setSeenTs] = useState<number>(readSeenTs);
  const [runningByJob, setRunningByJob] = useState<
    Record<string, { runId: string; startedAt: number }>
  >({});
  const historyJobIdRef = useRef<string | null>(null);
  historyJobIdRef.current = historyJobId;

  useEffect(() => {
    loadJobs();
    loadProviders();
    schedulerApi<{
      problemRuns: Array<{
        id: string;
        jobId: string;
        jobName: string | null;
        status: string;
        startedAt: number;
        error: string | null;
      }>;
    }>("/summary").then(
      (res) => {
        if (!res.ok) return;
        setProblems(res.data.problemRuns);
        // Codeg parity: opening the page marks failures seen.
        if (res.data.problemRuns.some((p) => p.startedAt > readSeenTs())) {
          markSeen();
        }
      },
      () => {},
    );
    fetch("/api/conversations?status=regular")
      .then((r) => r.json())
      .then(
        (data) =>
          setConversations(
            (data as { threads: Array<{ id: string; title: string }> }).threads ??
              [],
          ),
      )
      .catch(() => {});
  }, [loadJobs, loadProviders]);

  // Live running state (5s poll, page-local): disables Run-now while a
  // run is in flight and refreshes a job's history the moment it settles.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      schedulerApi<{
        running: Array<{ jobId: string; runId: string; startedAt: number }>;
      }>("/summary").then(
        (res) => {
          if (cancelled || !res.ok) return;
          const map: Record<string, { runId: string; startedAt: number }> = {};
          for (const r of res.data.running) {
            map[r.jobId] = { runId: r.runId, startedAt: r.startedAt };
          }
          setRunningByJob((prev) => {
            for (const jobId of Object.keys(prev)) {
              if (!map[jobId] && historyJobIdRef.current === jobId) {
                void loadRuns(jobId);
              }
            }
            return map;
          });
        },
        () => {},
      );
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loadRuns]);

  useEffect(() => {
    if (historyJobId) loadRuns(historyJobId);
  }, [historyJobId, loadRuns]);

  const historyRuns = historyJobId ? runsByJob[historyJobId] ?? [] : [];
  // Auto-select the latest run when a job's history opens, so the detail
  // shows without a mandatory row click. Manual collapse still works
  // (tracked per job, not per render).
  const autoSelectedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!historyJobId) {
      autoSelectedFor.current = null;
      return;
    }
    if (historyRuns.length > 0 && autoSelectedFor.current !== historyJobId) {
      autoSelectedFor.current = historyJobId;
      setSelectedRun(historyRuns[0]);
    }
  }, [historyJobId, historyRuns]);
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

  async function openEdit(job: SchedulerJobPublic) {
    // The list omits full prompts (preview only) — fetch the complete job
    // first, otherwise the form would open with an empty prompt and saving
    // would wipe it. This mirrors codeg's editor binding to the full draft.
    setIsAdding(false);
    setPreview(null);
    setPreviewError(null);
    const res = await schedulerApi<SchedulerJob>(`/jobs/${job.id}`);
    if (!res.ok) {
      setError(res.error ?? "Failed to load job");
      return;
    }
    setEditingId(job.id);
    setDraft(draftFromJob(res.data));
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
      conversationPolicy: draft.conversationPolicy,
      conversationId: draft.conversationId,
      maxRetries: draft.maxRetries,
      retryDelaySeconds: draft.retryDelaySeconds,
      timeoutSeconds: draft.timeoutSeconds,
      missedGraceSeconds: draft.missedGraceSeconds,
    };
  }

  /** Schedule-only preview input (works with a half-filled form — the
   * live "Runs every…" sentence must not wait for name/AI/prompt). */
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
    if (!isAdding && editingId === null) return;
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
          setPreviewError(res.error ?? "Preview failed");
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
    isAdding,
    editingId,
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

  async function handleCancelRun(jobId: string, runId: string) {
    const res = await schedulerApi<{ cancelled: boolean }>(
      `/jobs/${jobId}/runs/${runId}/cancel`,
      { method: "POST" },
    );
    if (!res.ok) {
      setError(res.error ?? "Cancel failed");
      return;
    }
    await loadRuns(jobId);
    setSelectedRun(null);
  }

  function markSeen() {
    const now = Date.now();
    setSeenTs(now);
    try {
      window.localStorage.setItem("tbai:schedSeenTs", String(now));
    } catch {
      /* ignore */
    }
  }

  const unseenCount = problems.filter((p) => p.startedAt > seenTs).length;

  async function handleDuplicate(job: SchedulerJobPublic) {
    // "Use again": copy the full config into a fresh form. Terminal jobs
    // (completed/missed/expired/failed) cannot be revived, so duplication
    // is the honest path — the user reviews and saves a new job.
    const res = await schedulerApi<SchedulerJob>(`/jobs/${job.id}`);
    if (!res.ok) {
      setError(res.error ?? "Failed to load job");
      return;
    }
    const full = res.data;
    const slot = defaultOnceSlot();
    setEditingId(null);
    setDraft({
      ...draftFromJob(full),
      name: `${full.name} (copy)`,
      enabled: true,
      execAtDate: full.scheduleType === "once" ? slot.date : "",
      execAtTime: full.scheduleType === "once" ? slot.time : "",
    });
    // Cron duplicates keep the exact expression (advanced shows it verbatim).
    setPreset("advanced");
    setPreview(null);
    setPreviewError(null);
    setIsAdding(true);
  }

  const TERMINAL_STATUSES = ["completed", "missed", "expired", "failed"];

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
      toast.success(editingId ? "Job updated" : "Job created");
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
    toast.success(`Run started: ${job.name}`, {
      description: `Run ID: ${res.data.runId}`,
    });
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
      {/* Title lives in the breadcrumb strip above; this lead explains the
          page. Keep it so the content still introduces itself. */}
      <div className="space-y-1">
        <p className="text-xs leading-5 text-muted-foreground">
          One-time and recurring automated runs. Timers rebuild from the
          database on restart; destructive tools always require approval.
        </p>
      </div>
      <div className="flex justify-end gap-2">
        {unseenCount > 0 && (
          <Button size="sm" variant="ghost" onClick={markSeen} title="Mark all failures seen">
            {unseenCount} unseen failure{unseenCount === 1 ? "" : "s"} · Mark seen
          </Button>
        )}
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
              <th className="p-2">Conv.</th>
              <th className="p-2">Next Run</th>
              <th className="p-2">Status</th>
              <th className="p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
              {jobs.map((job) => {
                // A spent one-time date cannot be revived, so offering the
                // schedule switch there is a trap (it only errors). Show a
                // spent marker instead; Run now + Use again stay available.
                const spent =
                  job.scheduleType === "once" &&
                  TERMINAL_STATUSES.includes(job.status);
                return (
                <tr key={job.id} className="border-b border-border last:border-0">
                <td className="p-2">
                  <input
                    type="checkbox"
                    checked={job.enabled}
                    disabled={spent}
                    onChange={() => handleToggle(job)}
                    aria-label={
                      spent
                        ? "Schedule spent — nothing to disable"
                        : job.enabled
                          ? "Disable job"
                          : "Enable job"
                    }
                    title={
                      spent
                        ? "Schedule spent — this job is already off. Use Run now or Use again."
                        : job.enabled
                          ? "Disable job"
                          : "Enable job"
                    }
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
                <td className="p-2 text-xs">
                  {job.conversationId ? (
                    <button
                      className="text-sky-500 hover:underline"
                      title={`Open thread ${job.conversationId}`}
                      onClick={() => navigate(`/chat/${job.conversationId}`)}
                    >
                      {job.conversationPolicy === "existing_thread"
                        ? "🔗 linked"
                        : "📋 thread"}
                    </button>
                  ) : (
                    <span title="Thread is created on the first run">—</span>
                  )}
                </td>
                <td
                  className="p-2 text-xs"
                  title={job.nextRunAt ? formatTime(job.nextRunAt) : undefined}
                >
                  {formatRelative(job.nextRunAt)}
                </td>
                <td className={cn("p-2 text-xs font-medium", statusClass(job.status))}>
                  <span className="inline-flex items-center gap-1.5">
                    {runningByJob[job.id] && (
                      <span
                        className="inline-block size-2 animate-pulse rounded-full bg-amber-500"
                        title={`Run started ${new Date(runningByJob[job.id].startedAt).toLocaleTimeString()}`}
                      />
                    )}
                    {runningByJob[job.id] ? "running" : job.status}
                  </span>
                </td>
                <td className="p-2">
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      title={
                        runningByJob[job.id]
                          ? "A run is in progress"
                          : "Run now (works even on finished jobs)"
                      }
                      disabled={!!runningByJob[job.id]}
                      onClick={() => handleRunNow(job)}
                    >
                      <Play className="h-4 w-4" />
                    </Button>
                    {!spent && (
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
                    )}
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
                    {TERMINAL_STATUSES.includes(job.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Use again (duplicate with fresh date)"
                        onClick={() => handleDuplicate(job)}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    )}
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
                );
              })}
            {!loading && jobs.length === 0 && (
              <tr>
                <td colSpan={10} className="p-4 text-center text-muted-foreground">
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
          {!editingId && (
            <div className="space-y-2">
              <div className={labelClass}>Start from a template</div>
              <div className="grid grid-cols-2 gap-1">
                {JOB_TEMPLATES.map((t) => (
                  <button
                    key={t.name}
                    type="button"
                    title={t.description}
                    onClick={() =>
                      applyTemplate(t, setDraft, setPreset, {
                        setMinutes: setPresetMinutes,
                        setHour: setPresetHour,
                        setMinute: setPresetMinute,
                        setWeekday: setPresetWeekday,
                        setMonthDay: setPresetMonthDay,
                      })
                    }
                    className="rounded-md border border-border p-2 text-left transition-colors hover:bg-muted"
                  >
                    <div className="text-xs font-medium">{t.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {t.description}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
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
              <div className="space-y-2">
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
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    ["+1h", () => new Date(Date.now() + 3600_000)],
                    ["Tomorrow 9:00", () => {
                      const d = new Date();
                      d.setDate(d.getDate() + 1);
                      d.setHours(9, 0, 0, 0);
                      return d;
                    }],
                    ["Next Mon 9:00", () => {
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
                    size="sm"
                    variant="ghost"
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
              <div className="space-y-2">
                <div className="space-y-1">
                  <div className={labelClass}>Repeat</div>
                  <div className="flex flex-wrap gap-1">
                    {(
                      [
                        ["minutes", "Every few minutes"],
                        ["hourly", "Hourly"],
                        ["daily", "Daily"],
                        ["weekdays", "Weekdays"],
                        ["weekly", "Weekly"],
                        ["monthly", "Monthly"],
                        ["advanced", "Custom"],
                      ] as Array<[RepeatPreset, string]>
                    ).map(([value, label]) => (
                      <Button
                        key={value}
                        size="sm"
                        variant={preset === value ? "default" : "ghost"}
                        onClick={() => setPreset(value)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>
                {preset === "minutes" && (
                  <div className="space-y-1">
                    <div className={labelClass}>Every N minutes (1-59)</div>
                    <div className="flex flex-wrap items-center gap-1">
                      {[1, 5, 15, 30].map((n) => (
                        <Button
                          key={n}
                          size="sm"
                          variant={presetMinutes === n ? "default" : "ghost"}
                          onClick={() => setPresetMinutes(n)}
                        >
                          {n} min
                        </Button>
                      ))}
                      <Input
                        type="number"
                        min={1}
                        max={59}
                        className="w-20"
                        value={presetMinutes}
                        onChange={(e) =>
                          setPresetMinutes(Number(e.target.value) || 1)
                        }
                      />
                    </div>
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
                      Custom expression (minute hour day month weekday —
                      @daily/@weekly/@monthly/@yearly/@hourly also work)
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
                <div className="space-y-1">
                  <div className={labelClass}>Popular patterns</div>
                  <div className="flex flex-wrap gap-1">
                    {(
                      [
                        ["*/5 * * * *", "Every 5 min"],
                        ["*/15 * * * *", "Every 15 min"],
                        ["0 9 * * MON-FRI", "Weekdays 9:00"],
                        ["0,30 9-17 * * *", "Business hrs"],
                        ["@daily", "@daily"],
                        ["@weekly", "@weekly"],
                        ["@monthly", "@monthly"],
                      ] as Array<[string, string]>
                    ).map(([expr, label]) => (
                      <Button
                        key={expr}
                        size="sm"
                        variant="ghost"
                        title={expr}
                        onClick={() => {
                          setPreset("advanced");
                          setDraft({ ...draft, cronExpression: expr });
                        }}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>
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
            <div className="text-xs">
              {previewError && (
                <span className="text-red-600 dark:text-red-400">
                  {previewError}
                </span>
              )}
              {!previewError && preview && (
                <span className="text-muted-foreground">
                  Runs {preview.description.charAt(0).toLowerCase() +
                    preview.description.slice(1)}{" "}
                  ·{" "}
                  {preview.nextRuns
                    .map((t) => new Date(t).toLocaleString())
                    .join(" · ")}
                  {typeof preview.runsNext24h === "number" && (
                    <> · {preview.runsNext24h} run(s) in next 24h</>
                  )}
                </span>
              )}
              {!previewError && !preview && (
                <span className="text-muted-foreground">
                  {draft.scheduleType === "once"
                    ? "Pick a date and time to see the schedule."
                    : "Adjust the repeat settings to see the schedule."}
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

          {/* CONVERSATION POLICY */}
          <div className="space-y-2">
            <div className={sectionClass}>Conversation</div>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
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
                <span>New dedicated chat</span>
                <span className="text-xs text-muted-foreground">
                  (auto-create and reuse)
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
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
                <span>Existing chat</span>
              </label>
              {draft.conversationPolicy === "existing_thread" && (
                <div className="ml-6 space-y-1">
                  <div className={labelClass}>Select conversation</div>
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
                    <option value="">— Select a conversation —</option>
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
            <div className="flex items-center gap-1">
              {historyJob?.conversationId && (
                <Button
                  size="sm"
                  variant="ghost"
                  title="Open thread"
                  onClick={() =>
                    navigate(`/chat/${historyJob.conversationId}`)
                  }
                >
                  <MessageSquare className="h-4 w-4" />
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setHistoryJobId(null)}
                aria-label="Close history"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
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
                      <span
                        className="inline-flex items-center gap-1"
                        title={
                          run.occurrenceId.startsWith("manual-")
                            ? "Manual run"
                            : "Scheduled run"
                        }
                      >
                        {run.occurrenceId.startsWith("manual-") ? (
                          <Play className="h-3 w-3 text-muted-foreground" />
                        ) : (
                          <Clock className="h-3 w-3 text-muted-foreground" />
                        )}
                        {new Date(run.startedAt).toLocaleString()}
                      </span>
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
              <div className="flex items-center justify-between">
                <span className="font-medium">Run detail</span>
                {selectedRun.status === "running" && historyJobId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleCancelRun(historyJobId, selectedRun.id)}
                  >
                    Cancel run
                  </Button>
                )}
              </div>
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
              {selectedRun.conversationId && (
                <div>
                  <span className="text-muted-foreground">thread:</span>{" "}
                  <button
                    className="text-blue-600 underline"
                    onClick={() =>
                      navigate(`/chat/${selectedRun.conversationId}`)
                    }
                  >
                    Open thread
                  </button>
                </div>
              )}
            </div>
          )}
        </SettingsSection>
      )}
    </div>
  );
}
