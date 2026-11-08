import { create } from "zustand";
import { apiResult, errorFromPayload, errorText } from "../../../lib/api";
import type { SchedulerJobPublic, SchedulerRun } from "../../../types/index";

interface SchedulerState {
  jobs: SchedulerJobPublic[];
  runsByJob: Record<string, SchedulerRun[]>;
  recentRuns: SchedulerRun[];
  loading: boolean;
  error: string | null;
  loadJobs: () => Promise<void>;
  loadRuns: (jobId: string) => Promise<void>;
  loadRecentRuns: () => Promise<void>;
  setError: (error: string | null) => void;
}

export const useSchedulerStore = create<SchedulerState>((set) => ({
  jobs: [],
  runsByJob: {},
  recentRuns: [],
  loading: false,
  error: null,
  loadJobs: async () => {
    set({ loading: true, error: null });
    try {
      const result = await apiResult<SchedulerJobPublic[]>("/api/scheduler/jobs");
      if (!result.ok) {
        set({ error: result.error ?? "Failed to load jobs", loading: false });
        return;
      }
      set({ jobs: result.data, loading: false });
    } catch (err) {
      set({
        error: errorText(err, "Failed to load jobs"),
        loading: false,
      });
    }
  },
  loadRuns: async (jobId: string) => {
    try {
      const result = await apiResult<{ runs?: SchedulerRun[] }>(
        `/api/scheduler/jobs/${encodeURIComponent(jobId)}/runs?limit=50`,
      );
      if (!result.ok) {
        set({
          error: errorFromPayload(result.data, "Failed to load runs"),
        });
        return;
      }
      set((state) => ({
        runsByJob: { ...state.runsByJob, [jobId]: result.data.runs ?? [] },
      }));
    } catch (err) {
      set({ error: errorText(err, "Failed to load runs") });
    }
  },
  loadRecentRuns: async () => {
    try {
      const result = await apiResult<{ runs?: SchedulerRun[] }>("/api/scheduler/runs?limit=100");
      if (!result.ok) return;
      set({ recentRuns: result.data.runs ?? [] });
    } catch {
      /* recent runs are best-effort */
    }
  },
  setError: (error) => set({ error }),
}));

/**
 * Scheduler mutation helper: resolves to `{ ok, data, error }` rather than
 * throwing, so one failed row action never unmounts the list. `path` is
 * relative to `/api/scheduler`.
 */
export async function schedulerApi<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; data: T; error?: string }> {
  return apiResult<T>(`/api/scheduler${path}`, init);
}
