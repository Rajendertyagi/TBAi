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
import type {
  PreferencesCloseResult,
  PreferencesHydrationStatus,
  SharedTabKind,
  WorkspacePreferencesSnapshot,
} from "./types";

interface PreferencesState {
  snapshot: WorkspacePreferencesSnapshot | null;
  hydration: PreferencesHydrationStatus;
  hydrationError: string | null;
  /** Monotonic guard: ignore stale refresh responses. */
  refreshSeq: number;
  /** Same-window shared mutation serialization. */
  mutationQueue: Promise<void>;
  /** Incremented when a failed optimistic patch requires authoritative UI reapply (same revision). */
  authoritativeReapplySeq: number;
  start: () => void;
  stop: () => void;
  refresh: () => Promise<WorkspacePreferencesSnapshot | null>;
  /** Waits for authoritative hydration; throws on hydration failure with no snapshot. */
  waitForHydratedSnapshot: () => Promise<WorkspacePreferencesSnapshot>;
  applySnapshot: (snapshot: WorkspacePreferencesSnapshot) => void;
  patchPreferences: (preferences: Record<string, unknown>) => Promise<WorkspacePreferencesSnapshot>;
  openSharedTab: (
    conversationId: string,
    kind: SharedTabKind,
  ) => Promise<WorkspacePreferencesSnapshot>;
  closeSharedTab: (conversationId: string) => Promise<PreferencesCloseResult>;
  closeSharedTabsBatch: (input: {
    mode: "others" | "right" | "all";
    anchorConversationId?: string;
  }) => Promise<PreferencesCloseResult>;
  reorderSharedTab: (
    conversationId: string,
    toIndex: number,
  ) => Promise<WorkspacePreferencesSnapshot>;
}

let eventSource: EventSource | null = null;
let started = false;
let hasConnectedSseOnce = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 1000;
let hydrationPromise: Promise<WorkspacePreferencesSnapshot | null> | null = null;

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

function onVisibilityChange(): void {
  if (typeof document !== "undefined" && document.visibilityState === "visible") scheduleRefresh();
}

function connectSse(): void {
  if (eventSource) return;
  try {
    const url = resolveApiUrl("/api/preferences/stream");
    const source = new EventSource(url);
    eventSource = source;
    source.onopen = () => {
      reconnectDelayMs = 1000;
      // Authoritative refresh after (re)connection; coalesced with other refreshes.
      if (hasConnectedSseOnce) {
        scheduleRefresh();
      } else {
        hasConnectedSseOnce = true;
        // Initial connection: refresh path is fine (coalesced with start() refresh).
        scheduleRefresh();
      }
    };
    source.addEventListener("preferences.changed", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          revision?: number;
          originWindowId?: string;
        };
        const known = usePreferencesStore.getState().snapshot?.revision ?? -1;
        if (typeof data.revision === "number" && data.revision <= known) return;
        // Skip self-origin only when local snapshot already has this revision or newer.
        if (
          data.originWindowId &&
          data.originWindowId === originWindowId &&
          typeof data.revision === "number" &&
          known >= data.revision
        ) {
          return;
        }
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
  hasConnectedSseOnce = false;
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
  authoritativeReapplySeq: 0,

  start: () => {
    if (started) return;
    started = true;
    void get().refresh();
    connectSse();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", scheduleRefresh);
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
  },

  stop: () => {
    started = false;
    disconnectSse();
    hydrationPromise = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", scheduleRefresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  },

  refresh: async () => {
    const seq = get().refreshSeq + 1;
    set((s) => ({
      refreshSeq: seq,
      hydration: s.snapshot ? s.hydration : "loading",
      hydrationError: null,
    }));
    let promise!: Promise<WorkspacePreferencesSnapshot | null>;
    promise = (async () => {
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
      } finally {
        if (hydrationPromise === promise) hydrationPromise = null;
      }
    })();
    hydrationPromise = promise;
    return promise;
  },

  waitForHydratedSnapshot: async () => {
    const existing = get().snapshot;
    if (existing) return existing;
    if (hydrationPromise) {
      const snap = await hydrationPromise;
      if (snap) return snap;
    }
    if (get().hydration === "error" && !get().snapshot) {
      throw new Error(get().hydrationError ?? "Preferences hydration failed");
    }
    const snap = await get().refresh();
    if (snap) return snap;
    const after = get().snapshot;
    if (after) return after;
    throw new Error(get().hydrationError ?? "Preferences hydration failed");
  },

  applySnapshot: (snapshot) => {
    const known = get().snapshot?.revision ?? -1;
    if (snapshot.revision < known) return;
    set({ snapshot, hydration: "ready", hydrationError: null });
  },

  patchPreferences: (preferences) =>
    runSerialized(async () => {
      const base = await get().waitForHydratedSnapshot();
      try {
        const snapshot = await apiPatchPreferences({ baseRevision: base.revision, preferences });
        get().applySnapshot(snapshot);
        return snapshot;
      } catch (err) {
        if (err instanceof PreferencesConflictError) {
          get().applySnapshot(err.snapshot);
          throw err;
        }
        await get().refresh();
        // Failed optimistic patch: restore authoritative UI even if revision unchanged.
        set((s) => ({ authoritativeReapplySeq: s.authoritativeReapplySeq + 1 }));
        throw err;
      }
    }),

  openSharedTab: (conversationId, kind) =>
    runSerialized(async () => {
      const base = await get().waitForHydratedSnapshot();
      try {
        const snapshot = await apiOpenSharedTab({
          baseRevision: base.revision,
          conversationId,
          kind,
        });
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
      try {
        const base = await get().waitForHydratedSnapshot();
        try {
          const snapshot = await apiCloseSharedTab({ baseRevision: base.revision, conversationId });
          get().applySnapshot(snapshot);
          return { ok: true, snapshot };
        } catch (err) {
          if (err instanceof PreferencesConflictError) {
            get().applySnapshot(err.snapshot);
            return { ok: false, reason: "conflict", snapshot: err.snapshot };
          }
          await get().refresh();
          return {
            ok: false,
            reason: "error",
            error: err instanceof Error ? err.message : "Failed to close shared tab",
            snapshot: get().snapshot ?? undefined,
          };
        }
      } catch (err) {
        return {
          ok: false,
          reason: "error",
          error: err instanceof Error ? err.message : "Preferences hydration failed",
          snapshot: get().snapshot ?? undefined,
        };
      }
    }),

  closeSharedTabsBatch: (input) =>
    runSerialized(async () => {
      try {
        const base = await get().waitForHydratedSnapshot();
        try {
          const snapshot = await apiCloseSharedTabsBatch({ baseRevision: base.revision, ...input });
          get().applySnapshot(snapshot);
          return { ok: true, snapshot };
        } catch (err) {
          if (err instanceof PreferencesConflictError) {
            get().applySnapshot(err.snapshot);
            return { ok: false, reason: "conflict", snapshot: err.snapshot };
          }
          await get().refresh();
          return {
            ok: false,
            reason: "error",
            error: err instanceof Error ? err.message : "Failed to close shared tabs",
            snapshot: get().snapshot ?? undefined,
          };
        }
      } catch (err) {
        return {
          ok: false,
          reason: "error",
          error: err instanceof Error ? err.message : "Preferences hydration failed",
          snapshot: get().snapshot ?? undefined,
        };
      }
    }),

  reorderSharedTab: (conversationId, toIndex) =>
    runSerialized(async () => {
      const base = await get().waitForHydratedSnapshot();
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
          throw err;
        }
        await get().refresh();
        throw err;
      }
    }),
}));
