import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { X } from "lucide-react";
import { schedulerViewConfig } from "../../config/scheduler";
import { useSchedulerStore, schedulerApi } from "../../stores/schedulerStore";
import { useSettingsStore } from "../../stores";
import { SchedulerTitleStrip } from "./components/SchedulerTitleStrip";
import { SchedulerToolbar, type JobStatusFilter } from "./components/SchedulerToolbar";
import { JobListItem } from "./components/JobListItem";
import { JobDetail } from "./components/JobDetail";
import { TemplateGallery } from "./components/TemplateGallery";
import { JobEditor } from "./components/JobEditor";
import {
  blankSeed,
  duplicateSeed,
  seedDraftFromTemplate,
  type JobTemplate,
  type TemplateSeed,
} from "./lib/scheduler-templates";
import type { SchedulerJob, SchedulerRun } from "../../types";

type Mode = "detail" | "gallery" | "editor";
type EditorTarget =
  | { kind: "seed"; seed: TemplateSeed }
  | { kind: "edit"; job: SchedulerJob };

/** Last-seen timestamp for the failure badge (cleared on view). */
function readSeenTs(): number {
  try {
    return Number(window.localStorage.getItem("tbai:schedSeenTs") ?? 0) || 0;
  } catch {
    return 0;
  }
}

/**
 * Dedicated Scheduler page (codeg automations-route parity): borderless
 * toolbar (filters + New) above a two-column shell (job list | detail).
 * Empty state and the New flow show the template gallery; the editor is a
 * detail-pane mode with keyed remounts. Store/API untouched — this owns
 * view state (selection, modes, filters, polls) only.
 */
export function SchedulerPage() {
  const copy = schedulerViewConfig.copy;
  const navigate = useNavigate();
  const { jobs, runsByJob, loading, error, loadJobs, loadRuns, setError } =
    useSchedulerStore();
  const { providers, loadProviders } = useSettingsStore();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("detail");
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<
    Array<{ id: string; title: string }>
  >([]);
  const [problems, setProblems] = useState<
    Array<{ id: string; jobId: string; startedAt: number }>
  >([]);
  const [seenTs, setSeenTs] = useState<number>(readSeenTs);
  const [runningByJob, setRunningByJob] = useState<Record<string, boolean>>({});
  // Frozen at mount — relative labels ("in 3h") anchor to when the page
  // opened, and the page remounts on each route entry.
  const [now] = useState(() => Date.now());

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  // Entry loads: jobs, providers, failure summary (+ auto-mark seen, so the
  // rail badge stops nagging while the failures are on screen), thread list
  // (existing-thread picker + labels).
  useEffect(() => {
    loadJobs();
    loadProviders();
    schedulerApi<{
      problemRuns: Array<{ id: string; jobId: string; startedAt: number }>;
    }>("/summary").then(
      (res) => {
        if (!res.ok) return;
        setProblems(res.data.problemRuns);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live running state (5s poll, page-local): spinner on rows, Run-now
  // gating in detail, and history refresh the moment a run settles while
  // its job is selected.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      schedulerApi<{
        running: Array<{ jobId: string; runId: string; startedAt: number }>;
      }>("/summary").then(
        (res) => {
          if (cancelled || !res.ok) return;
          const next: Record<string, boolean> = {};
          for (const r of res.data.running) next[r.jobId] = true;
          setRunningByJob((prev) => {
            for (const jobId of Object.keys(prev)) {
              if (!next[jobId] && selectedRef.current === jobId) {
                void loadRuns(jobId);
              }
            }
            return next;
          });
        },
        () => {},
      );
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Runs for the selected job (reset the selected run on switch).
  useEffect(() => {
    setSelectedRunId(null);
    if (selectedId) void loadRuns(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  function markSeen() {
    const nowMs = Date.now();
    setSeenTs(nowMs);
    try {
      window.localStorage.setItem("tbai:schedSeenTs", String(nowMs));
    } catch {
      /* ignore */
    }
  }

  const unseenCount = problems.filter((p) => p.startedAt > seenTs).length;
  const hasJobs = jobs.length > 0;
  // The shown job: explicit selection, else the first row, so the detail
  // pane is never blank when jobs exist. Derived (no effect) so a deleted
  // selection cleanly falls back instead of dangling.
  const current =
    jobs.find((j) => j.id === selectedId) ?? jobs[0] ?? null;
  const visibleJobs = jobs.filter(
    (j) =>
      statusFilter === "all" ||
      (statusFilter === "enabled" ? j.enabled : !j.enabled),
  );
  const runs = current ? (runsByJob[current.id] ?? []) : [];

  const defaultProviderId = providers[0]?.id ?? "";
  const defaultModelId = providers[0]?.model ?? "";

  const aiLabel = (job: { providerId: string; modelId: string }): string => {
    const p = providers.find((x) => x.id === job.providerId);
    return `${p?.name ?? job.providerId} · ${job.modelId}`;
  };

  const conversationLabel = (job: {
    conversationPolicy: string;
    conversationId: string | null;
  }): string | null => {
    if (job.conversationPolicy !== "existing_thread") return null;
    if (!job.conversationId) return null;
    return (
      conversations.find((c) => c.id === job.conversationId)?.title ??
      job.conversationId
    );
  };

  const openGallery = () => {
    setEditorTarget(null);
    setMode("gallery");
  };
  const closeToDetail = () => {
    setEditorTarget(null);
    setMode("detail");
  };
  const openEditorSeed = (seed: TemplateSeed) => {
    setEditorTarget({ kind: "seed", seed });
    setEditorKey((k) => k + 1);
    setMode("editor");
  };
  const pickTemplate = (tpl: JobTemplate | null) => {
    if (!tpl) {
      openEditorSeed(blankSeed(defaultProviderId, defaultModelId));
    } else {
      openEditorSeed(seedDraftFromTemplate(tpl, defaultProviderId, defaultModelId));
    }
  };
  const selectJob = (id: string) => {
    setSelectedId(id);
    setEditorTarget(null);
    setMode("detail");
  };

  async function runAction(fn: () => Promise<unknown>) {
    try {
      await fn();
      await loadJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const handleRunNow = (job: { id: string; name: string }) =>
    runAction(async () => {
      const res = await schedulerApi<{ runId: string }>(`/jobs/${job.id}/run`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(res.error ?? "Run failed");
      toast.success(copy.runStarted(job.name), {
        description: `Run ID: ${res.data.runId}`,
      });
      setSelectedId(job.id);
      setMode("detail");
      await loadRuns(job.id);
    });

  const handleToggle = (job: { id: string; enabled: boolean }) =>
    runAction(async () => {
      const action = job.enabled ? "disable" : "enable";
      const res = await schedulerApi(`/jobs/${job.id}/${action}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(res.error ?? `${action} failed`);
    });

  const handleEdit = async (id: string) => {
    // The list omits full prompts — fetch the complete job first, otherwise
    // the form would open with an empty prompt and saving would wipe it.
    const res = await schedulerApi<SchedulerJob>(`/jobs/${id}`);
    if (!res.ok) {
      setError(res.error ?? "Failed to load job");
      return;
    }
    setEditorTarget({ kind: "edit", job: res.data });
    setEditorKey((k) => k + 1);
    setMode("editor");
  };

  const handleDuplicate = async (id: string) => {
    const res = await schedulerApi<SchedulerJob>(`/jobs/${id}`);
    if (!res.ok) {
      setError(res.error ?? "Failed to load job");
      return;
    }
    openEditorSeed(duplicateSeed(res.data));
  };

  const handleDelete = async (id: string) => {
    const res = await schedulerApi(`/jobs/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError(res.error ?? "Delete failed");
      return;
    }
    if (selectedId === id) {
      setSelectedId(null);
      setMode("detail");
    }
    await loadJobs();
  };

  const handleCancelRun = async (runId: string) => {
    if (!current) return;
    const res = await schedulerApi<{ cancelled: boolean }>(
      `/jobs/${current.id}/runs/${runId}/cancel`,
      { method: "POST" },
    );
    if (!res.ok) {
      setError(res.error ?? "Cancel failed");
      return;
    }
    setSelectedRunId(null);
    await loadRuns(current.id);
  };

  const handleSaved = async (job: SchedulerJob) => {
    await loadJobs();
    setSelectedId(job.id);
    setEditorTarget(null);
    setMode("detail");
  };

  const openThread = (conversationId: string) =>
    navigate(`/chat/${conversationId}`);

  const editorPane =
    editorTarget != null ? (
      <JobEditor
        key={
          editorTarget.kind === "edit"
            ? `edit-${editorTarget.job.id}-${editorKey}`
            : `create-${editorKey}`
        }
        seed={editorTarget.kind === "seed" ? editorTarget.seed : null}
        editingJob={editorTarget.kind === "edit" ? editorTarget.job : null}
        defaultProviderId={defaultProviderId}
        defaultModelId={defaultModelId}
        providers={providers}
        conversations={conversations}
        onSaved={handleSaved}
        onError={setError}
        onCancel={closeToDetail}
        onBackToTemplates={
          editorTarget.kind === "seed" ? openGallery : undefined
        }
      />
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SchedulerTitleStrip />
      {error && (
        <div className="shrink-0 px-4 pt-2">
          <div
            role="alert"
            className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label={copy.dismissError}
              className="shrink-0 rounded px-1 outline-none hover:bg-destructive/10 focus-visible:ring-1 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        </div>
      )}
      {hasJobs ? (
        <>
          <SchedulerToolbar
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
            showNew={mode === "detail"}
            onNew={openGallery}
            unseenCount={unseenCount}
            onMarkSeen={markSeen}
          />
          <div className="min-h-0 flex-1 px-4 pb-4 pt-2">
            <div className="flex h-full overflow-hidden rounded-2xl border border-border">
              <div className="h-full w-[32%] min-w-52 shrink-0 border-r border-border bg-muted/50">
                <div className="h-full overflow-y-auto">
                  {visibleJobs.length === 0 ? (
                    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                      {copy.noMatches}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-0.5 p-2">
                      {visibleJobs.map((j) => (
                        <JobListItem
                          key={j.id}
                          job={j}
                          running={!!runningByJob[j.id]}
                          now={now}
                          selected={mode === "detail" && current?.id === j.id}
                          onSelect={() => selectJob(j.id)}
                          onRunNow={() => void handleRunNow(j)}
                          onToggleEnabled={() => void handleToggle(j)}
                          onEdit={() => void handleEdit(j.id)}
                          onDuplicate={() => void handleDuplicate(j.id)}
                          onDelete={() => void handleDelete(j.id)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              <div className="h-full min-w-0 flex-1 bg-card/50">
                {mode === "editor" && editorTarget ? (
                  <div className="h-full overflow-y-auto">
                    <div className="mx-auto w-full max-w-2xl p-4">
                      {editorPane}
                    </div>
                  </div>
                ) : mode === "gallery" ? (
                  <div className="h-full overflow-y-auto">
                    <TemplateGallery
                      onboarding={false}
                      onPick={pickTemplate}
                      onCancel={closeToDetail}
                    />
                  </div>
                ) : current ? (
                  <JobDetail
                    job={current}
                    runs={runs}
                    running={!!runningByJob[current.id]}
                    now={now}
                    aiLabel={aiLabel(current)}
                    conversationLabel={conversationLabel(current)}
                    conversationId={current.conversationId}
                    loadingRuns={loading}
                    selectedRunId={selectedRunId}
                    onSelectRun={(run: SchedulerRun | null) =>
                      setSelectedRunId(run?.id ?? null)
                    }
                    onEdit={() => void handleEdit(current.id)}
                    onRunNow={() => void handleRunNow(current)}
                    onToggleEnabled={() => void handleToggle(current)}
                    onDuplicate={() => void handleDuplicate(current.id)}
                    onDelete={() => void handleDelete(current.id)}
                    onCancelRun={(runId) => void handleCancelRun(runId)}
                    onRefreshHistory={() => void loadRuns(current.id)}
                    onOpenThread={openThread}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
                    {copy.selectHint}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 p-4">
          <div className="flex h-full overflow-hidden rounded-2xl border border-border bg-card/50">
            <div className="min-w-0 flex-1 overflow-y-auto">
              {mode === "editor" && editorTarget ? (
                <div className="mx-auto w-full max-w-2xl p-4">{editorPane}</div>
              ) : (
                <TemplateGallery onboarding onPick={pickTemplate} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
