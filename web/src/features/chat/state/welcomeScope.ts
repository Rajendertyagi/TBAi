import { create } from "zustand";
import {
  DEFAULT_QUICK_ACTION_TAB,
  isQuickActionTabId,
  type QuickActionTabId,
} from "@/config/welcome";
import type { WorkspaceMode } from "@/types";
import { logger } from "@/lib/logger";
import { usePreferencesStore } from "../../preferences/state/preferencesStore";

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

export const useWelcomeScopeStore = create<WelcomeScopeState>((set) => ({
  // Defaults before hydration; SQLite authoritative state applied by usePreferencesSync.
  scope: { mode: "simple", folderId: null },
  quickActionTab: DEFAULT_QUICK_ACTION_TAB,
  setScope: (scope) => {
    const next: WelcomeScope =
      scope.mode === "project" && scope.folderId
        ? { mode: "project", folderId: scope.folderId }
        : { mode: "simple", folderId: null };
    const prev = useWelcomeScopeStore.getState().scope;
    if (prev.mode !== next.mode || prev.folderId !== next.folderId) {
      if (next.mode === "project" && next.folderId) {
        logger.info("folders.ui", "workspace.bind", {
          workspaceId: next.folderId,
        });
      } else {
        logger.info("folders.ui", "workspace.unbind", {
          from: prev.mode,
        });
      }
    }
    set({ scope: next });
    void usePreferencesStore
      .getState()
      .patchPreferences({ welcome: { scopeMode: next.mode, folderId: next.folderId } })
      .catch(() => {});
  },
  setQuickActionTab: (tab) => {
    const next = isQuickActionTabId(tab) ? tab : DEFAULT_QUICK_ACTION_TAB;
    set({ quickActionTab: next });
    void usePreferencesStore
      .getState()
      .patchPreferences({ welcome: { quickActionTab: next } })
      .catch(() => {});
  },
  validateAgainstFolderIds: (_liveIds) => {
    // Soft reference: preserve missing folder IDs.
  },
}));

/** Snapshot for non-React callers (adapter initialize). */
export function getWelcomeScopeSnapshot(): WelcomeScope {
  return useWelcomeScopeStore.getState().scope;
}
