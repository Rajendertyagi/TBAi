import { create } from "zustand";
import type { SchedulerJobPublic, SchedulerRun } from "../types";

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

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text.slice(0, 300) || `HTTP ${response.status}` };
  }
}

function apiError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const e = (payload as { error: unknown }).error;
    if (typeof e === "string" && e) return e;
  }
  return fallback;
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) return value;
  return fallback;
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
      const response = await fetch("/api/scheduler/jobs");
      const payload = await readJson(response);
      if (!response.ok) {
        set({ error: apiError(payload, "Failed to load jobs"), loading: false });
        return;
      }
      set({ jobs: payload as SchedulerJobPublic[], loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to load jobs",
        loading: false,
      });
    }
  },
  loadRuns: async (jobId: string) => {
    try {
      const response = await fetch(
        `/api/scheduler/jobs/${encodeURIComponent(jobId)}/runs?limit=50`,
      );
      const payload = (await readJson(response)) as {
        runs?: SchedulerRun[];
        error?: unknown;
      };
      if (!response.ok) {
        set({ error: errorMessage(payload.error, "Failed to load runs") });
        return;
      }
      set((state) => ({
        runsByJob: { ...state.runsByJob, [jobId]: payload.runs ?? [] },
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to load runs" });
    }
  },
  loadRecentRuns: async () => {
    try {
      const response = await fetch("/api/scheduler/runs?limit=100");
      const payload = (await readJson(response)) as {
        runs?: SchedulerRun[];
        error?: unknown;
      };
      if (!response.ok) return;
      set({ recentRuns: payload.runs ?? [] });
    } catch {
      /* recent runs are best-effort */
    }
  },
  setError: (error) => set({ error }),
}));

export async function schedulerApi<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; data: T; error?: string }> {
  const response = await fetch(`/api/scheduler${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const payload = (await readJson(response)) as T & { error?: string };
  if (!response.ok) {
    return {
      ok: false,
      data: payload,
      error: apiError(payload, `HTTP ${response.status}`),
    };
  }
  return { ok: true, data: payload };
}
