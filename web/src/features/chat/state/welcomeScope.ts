import { create } from "zustand";
import {
  DEFAULT_QUICK_ACTION_TAB,
  isQuickActionTabId,
  welcomeConfig,
  type QuickActionTabId,
} from "@/config/welcome";
import type { WorkspaceMode } from "@/types";

export interface WelcomeScope {
  mode: WorkspaceMode;
  folderId: string | null;
}

interface WelcomeScopeState {
  scope: WelcomeScope;
  quickActionTab: QuickActionTabId;
  setScope: (scope: WelcomeScope) => void;
  setQuickActionTab: (tab: QuickActionTabId) => void;
  /** Drop a folder that no longer exists (edge: deleted after selection). */
  validateAgainstFolderIds: (liveIds: readonly string[]) => void;
}

function loadScope(): WelcomeScope {
  const fallback: WelcomeScope = { mode: "simple", folderId: null };
  try {
    const raw = window.localStorage.getItem(welcomeConfig.storage.scopeKey);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<WelcomeScope>;
    if (parsed.mode === "project" && typeof parsed.folderId === "string" && parsed.folderId.length > 0) {
      return { mode: "project", folderId: parsed.folderId };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function loadTab(): QuickActionTabId {
  try {
    const raw = window.localStorage.getItem(welcomeConfig.storage.tabKey);
    return isQuickActionTabId(raw) ? raw : DEFAULT_QUICK_ACTION_TAB;
  } catch {
    return DEFAULT_QUICK_ACTION_TAB;
  }
}

function persistScope(scope: WelcomeScope): void {
  try {
    window.localStorage.setItem(
      welcomeConfig.storage.scopeKey,
      JSON.stringify(scope),
    );
  } catch {
    /* storage unavailable — session-only */
  }
}

function persistTab(tab: QuickActionTabId): void {
  try {
    window.localStorage.setItem(welcomeConfig.storage.tabKey, tab);
  } catch {
    /* ignore */
  }
}

export const useWelcomeScopeStore = create<WelcomeScopeState>((set) => ({
  scope: loadScope(),
  quickActionTab: loadTab(),
  setScope: (scope) => {
    const next: WelcomeScope =
      scope.mode === "project" && scope.folderId
        ? { mode: "project", folderId: scope.folderId }
        : { mode: "simple", folderId: null };
    persistScope(next);
    set({ scope: next });
  },
  setQuickActionTab: (tab) => {
    persistTab(tab);
    set({ quickActionTab: tab });
  },
  validateAgainstFolderIds: (liveIds) =>
    set((state) => {
      if (state.scope.mode !== "project" || !state.scope.folderId) return state;
      if (liveIds.includes(state.scope.folderId)) return state;
      const next: WelcomeScope = { mode: "simple", folderId: null };
      persistScope(next);
      return { scope: next };
    }),
}));

/** Snapshot for non-React callers (adapter initialize). */
export function getWelcomeScopeSnapshot(): WelcomeScope {
  return useWelcomeScopeStore.getState().scope;
}
