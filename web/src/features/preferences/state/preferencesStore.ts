import { create } from "zustand";
import { resolveApiUrl } from "../../../lib/platform";
import { logger } from "../../../lib/logger";
import {
  closeSharedTab as apiCloseSharedTab,
  closeSharedTabsBatch as apiCloseSharedTabsBatch,
  fetchPreferences,
  openSharedTab as apiOpenSharedTab,
  originWindowId,
  patchPreferences as apiPatchPreferences,
  PreferencesConflictError,
  reorderSharedTab as apiReorderSharedTab,
} from "../api/preferences";
import type { PreferencesHydrationStatus, SharedTabKind, WorkspacePreferencesSnapshot } from "./types";

interface PreferencesState {
  snapshot: WorkspacePreferencesSnapshot | null;
  hydration: PreferencesHydrationStatus;
  hydrationError: string | null;
  /** Monotonic guard: ignore stale refresh responses. */
  refreshSeq: number;
  /** Same-window shared mutation serialization. */
  mutationQueue: Promise<void>;
  start: () => void;
  stop: () => void;
  refresh: () => Promise<WorkspacePreferencesSnapshot | null>;
  applySnapshot: (snapshot: WorkspacePreferencesSnapshot) => void;
  patchPreferences: (
    preferences: Record<string, unknown>,
  ) => Promise<WorkspacePreferencesSnapshot | null>;
  openSharedTab: (
    conversationId: string,
    kind: SharedTabKind,
  ) => Promise<WorkspacePreferencesSnapshot | null>;
  closeSharedTab: (conversationId: string) => Promise<WorkspacePreferencesSnapshot | null>;
  closeSharedTabsBatch: (input: {
    mode: "others" | "right" | "all";
    anchorConversationId?: string;
  }) => Promise<WorkspacePreferencesSnapshot | null>;
  reorderSharedTab: (
    conversationId: string,
    toIndex: number,
  ) => Promise<WorkspacePreferencesSnapshot | null>;
}

let eventSource: EventSource | null = null;
let started = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 1000;

function clearRefreshTimer(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleRefresh(): void {
  clearRefreshTimer();
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void usePreferencesStore.getState().refresh();
  }, 50);
}

function connectSse(): void {
  if (eventSource) return;
  try {
    const url = resolveApiUrl("/api/preferences/stream");
    const source = new EventSource(url);
    eventSource = source;
    source.onopen = () => {
      reconnectDelayMs = 1000;
    };
    source.addEventListener("preferences.changed", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          revision?: number;
          originWindowId?: string;
        };
        const known = usePreferencesStore.getState().snapshot?.revision ?? -1;
        if (typeof data.revision === "number" && data.revision <= known) return;
        // Originating window can skip redundant refetch if it already applied the mutation response.
        if (data.originWindowId && data.originWindowId === originWindowId) return;
      } catch {
        /* refresh anyway */
      }
      scheduleRefresh();
    });
    source.onerror = () => {
      source.close();
      if (eventSource === source) eventSource = null;
      if (started) {
        clearReconnectTimer();
        const delay = reconnectDelayMs;
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5000);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (started && !eventSource) connectSse();
        }, delay);
      }
    };
  } catch (err) {
    logger.debug("preferences", "sse_connect_failed", {
      errorType: err instanceof Error ? err.name : typeof err,
    });
  }
}

function disconnectSse(): void {
  clearRefreshTimer();
  clearReconnectTimer();
  reconnectDelayMs = 1000;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

async function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const state = usePreferencesStore.getState();
  const run = state.mutationQueue.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  usePreferencesStore.setState({ mutationQueue: settled });
  return run;
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  snapshot: null,
  hydration: "idle",
  hydrationError: null,
  refreshSeq: 0,
  mutationQueue: Promise.resolve(),

  start: () => {
    if (started) return;
    started = true;
    void get().refresh();
    connectSse();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", scheduleRefresh);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") scheduleRefresh();
      });
    }
  },

  stop: () => {
    started = false;
    disconnectSse();
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", scheduleRefresh);
    }
  },

  refresh: async () => {
    const seq = get().refreshSeq + 1;
    set((s) => ({
      refreshSeq: seq,
      hydration: s.snapshot ? s.hydration : "loading",
      hydrationError: null,
    }));
    try {
      const snapshot = await fetchPreferences();
      if (get().refreshSeq !== seq) return null;
      const known = get().snapshot?.revision ?? -1;
      if (snapshot.revision < known) return get().snapshot;
      set({ snapshot, hydration: "ready", hydrationError: null });
      return snapshot;
    } catch (err) {
      if (get().refreshSeq !== seq) return null;
      const message = err instanceof Error ? err.message : "Failed to load preferences";
      set((s) => ({
        hydration: s.snapshot ? "ready" : "error",
        hydrationError: s.snapshot ? s.hydrationError : message,
      }));
      return null;
    }
  },

  applySnapshot: (snapshot) => {
    const known = get().snapshot?.revision ?? -1;
    if (snapshot.revision < known) return;
    set({ snapshot, hydration: "ready", hydrationError: null });
  },

  patchPreferences: (preferences) =>
    runSerialized(async () => {
      const base = get().snapshot;
      if (!base) return null;
      try {
        const snapshot = await apiPatchPreferences({ baseRevision: base.revision, preferences });
        get().applySnapshot(snapshot);
        return snapshot;
      } catch (err) {
        if (err instanceof PreferencesConflictError) {
          get().applySnapshot(err.snapshot);
        } else {
          await get().refresh();
        }
        return null;
      }
    }),

  openSharedTab: (conversationId, kind) =>
    runSerialized(async () => {
      const base = get().snapshot;
      if (!base) return null;
      try {
        const snapshot = await apiOpenSharedTab({ baseRevision: base.revision, conversationId, kind });
        get().applySnapshot(snapshot);
        return snapshot;
      } catch (err) {
        if (err instanceof PreferencesConflictError) {
          get().applySnapshot(err.snapshot);
          throw err;
        }
        await get().refresh();
        throw err;
      }
    }),

  closeSharedTab: (conversationId) =>
    runSerialized(async () => {
      const base = get().snapshot;
      if (!base) return null;
      try {
        const snapshot = await apiCloseSharedTab({ baseRevision: base.revision, conversationId });
        get().applySnapshot(snapshot);
        return snapshot;
      } catch (err) {
        if (err instanceof PreferencesConflictError) {
          get().applySnapshot(err.snapshot);
        } else {
          await get().refresh();
        }
        return null;
      }
    }),

  closeSharedTabsBatch: (input) =>
    runSerialized(async () => {
      const base = get().snapshot;
      if (!base) return null;
      try {
        const snapshot = await apiCloseSharedTabsBatch({ baseRevision: base.revision, ...input });
        get().applySnapshot(snapshot);
        return snapshot;
      } catch (err) {
        if (err instanceof PreferencesConflictError) {
          get().applySnapshot(err.snapshot);
        } else {
          await get().refresh();
        }
        return null;
      }
    }),

  reorderSharedTab: (conversationId, toIndex) =>
    runSerialized(async () => {
      const base = get().snapshot;
      if (!base) return null;
      try {
        const snapshot = await apiReorderSharedTab({
          baseRevision: base.revision,
          conversationId,
          toIndex,
        });
        get().applySnapshot(snapshot);
        return snapshot;
      } catch (err) {
        if (err instanceof PreferencesConflictError) {
          get().applySnapshot(err.snapshot);
        } else {
          await get().refresh();
        }
        return null;
      }
    }),
}));
