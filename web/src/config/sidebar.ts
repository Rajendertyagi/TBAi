/**
 * Single source of truth for the conversation sidebar experience.
 *
 * Numbers, limits, defaults, section order, and copy live here — components
 * must reference these (or the CSS tokens they map to) instead of inline
 * literals, per the configuration-first rule.
 */

export type SidebarSectionId = "chats" | "recent" | "archived";

export type SidebarSortMode = "updated" | "created";

/** All reorderable sections, in default top-to-bottom order. */
export const SIDEBAR_SECTION_IDS: readonly SidebarSectionId[] = [
  "chats",
  "recent",
  "archived",
];

export const DEFAULT_SECTION_ORDER: readonly SidebarSectionId[] =
  SIDEBAR_SECTION_IDS;

export const DEFAULT_SORT_MODE: SidebarSortMode = "updated";

/** Section collapsed map. Absent key = expanded (the default). */
export type SidebarSectionCollapsed = Partial<Record<SidebarSectionId, boolean>>;

export interface SidebarConfig {
  /** Top-to-bottom section order default (persisted per user after). */
  defaultSectionOrder: readonly SidebarSectionId[];
  /** Default thread sort. `updated` matches the server's newest-first order. */
  defaultSort: SidebarSortMode;
  /** Whether the Recent section renders by default. */
  showRecentByDefault: boolean;
  /** Whether the Archived section starts expanded. */
  archivedExpandedByDefault: boolean;
  /** Flat item cap for the Recent section (Chats paginates via the runtime). */
  recentSectionLimit: number;
  /** Anti-flood page size for the Chats date-grouped list (session-only). */
  chatsPageSize: number;
  /** Debounce for the chrome search box before hitting the server. */
  searchDebounceMs: number;
  /** Minimum query length before server-side search fires. */
  searchMinLength: number;
  /** Copy (i18n-ready: no component literals). */
  copy: {
    newChat: string;
    toggleSidebar: string;
    toggleStatusBar: string;
    openSettings: string;
    hideSidebar: string;
    showSidebar: string;
    searchPlaceholder: string;
    searchLabel: string;
    searchShortcutHint: string;
    chats: string;
    recent: string;
    archived: string;
    viewOptions: string;
    listOptions: string;
    showRecent: string;
    sortBy: string;
    sortByUpdated: string;
    sortByCreated: string;
    sectionOrder: string;
    sectionMoveUp: string;
    sectionMoveDown: string;
    sectionOrderHint: string;
    locateActive: string;
    expandAll: string;
    collapseAll: string;
    noConversations: string;
    browseArchived: string;
    noMatches: string;
    clearSearch: string;
    showMore: (remaining: number) => string;
    loadMore: string;
    backToChats: string;
    rename: string;
    archive: string;
    unarchive: string;
    delete: string;
    copyId: string;
    openInNewTab: string;
  };
}

export const sidebarConfig: SidebarConfig = {
  defaultSectionOrder: DEFAULT_SECTION_ORDER,
  defaultSort: DEFAULT_SORT_MODE,
  showRecentByDefault: true,
  archivedExpandedByDefault: false,
  recentSectionLimit: 10,
  chatsPageSize: 20,
  searchDebounceMs: 300,
  searchMinLength: 1,
  copy: {
    newChat: "New Chat",
    toggleSidebar: "Toggle Sidebar",
    toggleStatusBar: "Toggle Status Bar",
    openSettings: "Open Settings",
    hideSidebar: "Hide sidebar",
    showSidebar: "Show sidebar",
    searchPlaceholder: "Search conversations…",
    searchLabel: "Search conversations",
    searchShortcutHint: "Ctrl K",
    chats: "Chats",
    recent: "Recent",
    archived: "Archived",
    viewOptions: "View options",
    listOptions: "List",
    showRecent: "Show Recent section",
    sortBy: "Sort by",
    sortByUpdated: "Last activity",
    sortByCreated: "Newest first",
    sectionOrder: "Section order",
    sectionMoveUp: "Move section up",
    sectionMoveDown: "Move section down",
    sectionOrderHint: "Alt+↑ / Alt+↓",
    locateActive: "Locate active conversation",
    expandAll: "Expand all sections",
    collapseAll: "Collapse all sections",
    noConversations: "No conversations yet.",
    browseArchived: "Browse archived",
    noMatches: "No conversations match your search.",
    clearSearch: "Clear search",
    showMore: (remaining: number) => `Show more (${remaining} more)`,
    loadMore: "Load more",
    backToChats: "Back to conversations",
    rename: "Rename",
    archive: "Archive",
    unarchive: "Unarchive",
    delete: "Delete",
    copyId: "Copy ID",
    openInNewTab: "Open in New Tab",
  },
};

/** Section id → copy label. */
export function sectionLabel(id: SidebarSectionId): string {
  switch (id) {
    case "chats":
      return sidebarConfig.copy.chats;
    case "recent":
      return sidebarConfig.copy.recent;
    case "archived":
      return sidebarConfig.copy.archived;
  }
}

/**
 * Copy for the conversation breadcrumb header (`ChatHeader`, rendered above
 * the transcript on chat routes). Separate block — not sidebar list copy.
 */
export const chatHeaderConfig = {
  copy: {
    workspaceFallback: "Workspace",
    newChatTitle: "New chat",
    untitled: "Untitled",
    moreActions: "More actions",
    newConversation: "New chat",
    rename: "Rename",
    renameTitle: "Rename conversation",
    archive: "Archive",
    unarchive: "Unarchive",
    copyId: "Copy ID",
    delete: "Delete",
    deleteTitle: "Delete conversation?",
    deleteDescription: (title: string) =>
      `“${title}” will be permanently deleted. This cannot be undone.`,
    cancel: "Cancel",
    save: "Save",
  },
};
