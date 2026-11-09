/**
 * Shared workspace preferences types (canonical).
 *
 * SQLite `app_settings` is authoritative for the shared workspace snapshot.
 * Each window owns its own active conversation/URL locally; this snapshot
 * contains only shared membership/order and allowlisted portable preferences.
 * No shared active pointer, no migration/profile state.
 */

export type SharedTabKind = "chat" | "agent";

export interface SharedTabRef {
  /** Conversation ID (canonical snapshot field name). */
  ref: string;
  kind: SharedTabKind;
}

export interface PortablePreferences {
  appearance: {
    themeMode: "light" | "dark" | "system";
    lightTheme: string;
    darkTheme: string;
    typography: string;
  };
  desktop: {
    sidebarVisible: boolean;
    statusBarVisible: boolean;
    chatWidth: "narrow" | "comfortable" | "wide";
    sidebarSort: "updated" | "created";
    /** Stored value; effective order is normalized (missing/null/[] => default order). */
    sectionOrder: string[];
    sectionCollapsed: Record<string, boolean>;
    showCompleted: boolean;
    spellCheck: boolean;
  };
  welcome: {
    engine: "direct" | "opencode";
    quickActionTab: string;
    scopeMode: "simple" | "project";
    folderId: string | null;
  };
  navigation: {
    selectedFolderId: string | null;
    folderExpanded: Record<string, boolean>;
  };
}

export interface WorkspacePreferencesSnapshot {
  revision: number;
  sharedTabs: SharedTabRef[];
  preferences: PortablePreferences;
}

export interface PreferencesConflict {
  conflict: true;
  revision: number;
  snapshot: WorkspacePreferencesSnapshot;
}

export type PreferencesPatchResult =
  | { conflict: false; snapshot: WorkspacePreferencesSnapshot }
  | PreferencesConflict;

/** Thrown when the stored snapshot row is corrupt/invalid. The row is preserved. */
export class WorkspacePreferencesCorruptError extends Error {
  readonly code = "WORKSPACE_PREFERENCES_CORRUPT" as const;
  constructor(message = "Workspace preferences snapshot is corrupt or invalid") {
    super(message);
    this.name = "WorkspacePreferencesCorruptError";
  }
}
