export type SharedTabKind = "chat" | "agent";

export interface SharedTabRef {
  /** Conversation ID. */
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

export type PreferencesHydrationStatus = "idle" | "loading" | "ready" | "error";

export type PreferencesCloseResult =
  | { ok: true; snapshot: WorkspacePreferencesSnapshot }
  | { ok: false; reason: "conflict"; snapshot: WorkspacePreferencesSnapshot }
  | { ok: false; reason: "error"; error: string; snapshot?: WorkspacePreferencesSnapshot };
