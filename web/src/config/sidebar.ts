/**
 * Single source of truth for the conversation sidebar experience.
 *
 * Numbers, limits, defaults, section order, and copy live here — components
 * must reference these (or the CSS tokens they map to) instead of inline
 * literals, per the configuration-first rule.
 */

export type SidebarSectionId = "folders" | "chats";

export type SidebarSortMode = "updated" | "created";

/** All reorderable sections, in default top-to-bottom order. */
export const SIDEBAR_SECTION_IDS: readonly SidebarSectionId[] = ["folders", "chats"];

export const DEFAULT_SECTION_ORDER: readonly SidebarSectionId[] = SIDEBAR_SECTION_IDS;

export const DEFAULT_SORT_MODE: SidebarSortMode = "updated";

/** Section collapsed map. Absent key = expanded (the default). */
export type SidebarSectionCollapsed = Partial<Record<SidebarSectionId, boolean>>;

export interface SidebarConfig {
  /** Top-to-bottom section order default (persisted per user after). */
  defaultSectionOrder: readonly SidebarSectionId[];
  /** Default thread sort. `updated` matches the server's newest-first order. */
  defaultSort: SidebarSortMode;
  /** Page size for a folder's conversation list; the tail row grows it. */
  folderChatLimit: number;
  /** Initial page size for the global search results list (grows via Load more). */
  searchResultLimit: number;
  /**
   * Hard ceiling on rows a single sidebar list request may ask for. The lists
   * grow `limit` with each "Load more" (offset stays 0), so without a ceiling a
   * long session eventually asks for more than the server accepts and gets a
   * 400. MUST stay <= the `limit` maximum in the server's
   * `conversationsListQuerySchema`.
   */
  maxListPageSize: number;
  /** Debounce for the chrome search box before hitting the server. */
  searchDebounceMs: number;
  /** Minimum query length before server-side search fires. */
  searchMinLength: number;
  /** Copy (i18n-ready: no component literals). */
  copy: {
    newChat: string;
    newProjectChat: string;
    /**
     * Copies the captured page selection. Present because the page menu
     * replaced the browser's own, which used to provide this.
     */
    copy: string;
    toggleSidebar: string;
    toggleStatusBar: string;
    openSettings: string;
    hideSidebar: string;
    showSidebar: string;
    searchPlaceholder: string;
    searchLabel: string;
    searchShortcutHint: string;
    chats: string;
    folders: string;
    /** Label for the section header's single `+` menu. */
    addToSection: string;
    /** "Open folder" item in the Folders section's `+` menu. */
    openFolder: string;
    /** Folder row menu: copies the folder's absolute path. */
    copyFolderPath: string;
    /** Folder row menu: starts a conversation scoped to this folder. */
    newChatInFolder: string;
    /** Folder row menu: opens the display-name dialog. */
    renameFolder: string;
    /** Title of that dialog. */
    renameFolderTitle: string;
    /** Folder row menu: opens the managed-links surface. */
    manageLinks: string;
    /** Folder row menu: opens the colour submenu. */
    setColor: string;
    /** Folder row menu: opens the folder in the OS file manager (desktop only). */
    openInExplorer: string;
    /** Toast when the desktop file manager cannot be reached. */
    openInExplorerFailed: string;
    /** Folder row menu: detaches the folder from the workspace. */
    removeFromWorkspace: string;
    searchResults: string;
    archived: string;
    viewOptions: string;
    listOptions: string;
    showCompleted: string;
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
    /** Chats section is scoped to non-folder chats, so its empty copy must not
     *  claim the user has never had a conversation. */
    noNonFolderChats: string;
    noMatches: string;
    clearSearch: string;
    showMore: (remaining: number) => string;
    loadMore: string;
    backToChats: string;
    rename: string;
    /** Title of the rename dialog (the menu label carries an ellipsis). */
    renameTitle: string;
    archive: string;
    unarchive: string;
    delete: string;
    /** Chat row menu label: opens the delete confirmation. */
    deleteMenuItem: string;
    /** Confirmation button inside that dialog. */
    deleteAction: string;
    copyId: string;
    copyUrl: string;
    openInNewTab: string;
    /** Accessible name for the row's `⋯` menu trigger. */
    moreOptions: string;
    deleteTitle: string;
    deleteDescription: (title: string) => string;
    cancel: string;
    save: string;
    threadRunning: string;
    shortcuts: {
      newChat: string;
      copy: string;
      toggleSidebar: string;
      toggleStatusBar: string;
      openSettings: string;
    };
  };
}

export const sidebarConfig: SidebarConfig = {
  defaultSectionOrder: DEFAULT_SECTION_ORDER,
  defaultSort: DEFAULT_SORT_MODE,
  folderChatLimit: 8,
  searchResultLimit: 20,
  maxListPageSize: 500,
  searchDebounceMs: 300,
  searchMinLength: 1,
  copy: {
    newChat: "New Chat",
    newProjectChat: "New Project Chat",
    copy: "Copy",
    toggleSidebar: "Toggle Sidebar",
    toggleStatusBar: "Toggle Status Bar",
    openSettings: "Open Settings",
    hideSidebar: "Hide sidebar",
    showSidebar: "Show sidebar",
    searchPlaceholder: "Search conversations…",
    searchLabel: "Search conversations",
    searchShortcutHint: "Ctrl K",
    chats: "Chats",
    folders: "Folders",
    addToSection: "Add to section",
    openFolder: "Open folder",
    copyFolderPath: "Copy folder path",
    newChatInFolder: "New chat in this folder",
    renameFolder: "Rename folder…",
    renameFolderTitle: "Rename folder",
    manageLinks: "Manage links…",
    setColor: "Set color",
    openInExplorer: "Open folder in Explorer",
    openInExplorerFailed: "Could not open the folder in Explorer.",
    removeFromWorkspace: "Remove from workspace",
    searchResults: "Search results",
    archived: "Archived",
    viewOptions: "View options",
    listOptions: "List",
    showCompleted: "Show archived conversations",
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
    noNonFolderChats: "No chats outside folders yet.",
    noMatches: "No conversations match your search.",
    clearSearch: "Clear search",
    showMore: (remaining: number) => `Show ${remaining} more`,
    loadMore: "Load more",
    backToChats: "Back to conversations",
    rename: "Rename…",
    renameTitle: "Rename conversation",
    archive: "Archive",
    unarchive: "Unarchive",
    delete: "Delete",
    deleteMenuItem: "Delete…",
    deleteAction: "Delete",
    copyId: "Copy chat ID",
    copyUrl: "Copy URL",
    openInNewTab: "Open in new tab",
    moreOptions: "More options",
    deleteTitle: "Delete conversation?",
    deleteDescription: (title: string) =>
      `"${title}" will be permanently deleted. This cannot be undone.`,
    cancel: "Cancel",
    save: "Save",
    threadRunning: "Generating response",
    shortcuts: {
      // Only `newChat` and `copy` correspond to a key the user can actually
      // press: ChromeShortcuts.tsx binds Ctrl/Cmd+T, and Copy is the browser's
      // own Ctrl+C on the captured selection.
      //
      // The three below are NOT bound by anything. They render as visible hints
      // only, which is why PageContextMenu gives them no `aria-keyshortcuts` —
      // that attribute is for shortcuts the app actually implements, and
      // claiming an unbound key to assistive tech is the opposite of the truth.
      // A guard in web/tests/context-menu-copy.test.ts pins the page menu to
      // exactly 2 aria-keyshortcuts claims, so adding a fourth without binding
      // the key fails the fast tier. The maintainer decision these still need:
      // bind the key, or drop the label.
      newChat: "Ctrl+T",
      copy: "Ctrl+C",
      toggleSidebar: "Ctrl+B",
      toggleStatusBar: "Ctrl+Shift+S",
      openSettings: "Ctrl+,",
    },
  },
};

/** Section id → copy label. */
export function sectionLabel(id: SidebarSectionId): string {
  switch (id) {
    case "folders":
      return sidebarConfig.copy.folders;
    case "chats":
      return sidebarConfig.copy.chats;
  }
}

/**
 * Copy for the conversation breadcrumb header (`ChatHeader`, rendered above
 * the transcript on chat routes). Separate block — not sidebar list copy.
 */
export const chatHeaderConfig = {
  copy: {
    workspaceFallback: "Workspace",
    temporaryWorkspace: "Temporary workspace",
    newChat: "New Chat",
    newProjectChat: "New Project Chat",
    newChatTitle: "New chat",
    untitled: "Untitled",
    moreActions: "More actions",
    newConversation: "New chat",
    rename: "Rename",
    renameTitle: "Rename conversation",
    archive: "Archive",
    unarchive: "Unarchive",
    copyId: "Copy ID",
    openInCode: "Open in Code",
    delete: "Delete",
    deleteTitle: "Delete conversation?",
    deleteDescription: (title: string) =>
      `“${title}” will be permanently deleted. This cannot be undone.`,
    cancel: "Cancel",
    save: "Save",
  },
};
