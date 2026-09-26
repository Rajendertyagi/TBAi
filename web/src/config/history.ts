/**
 * Configuration for the conversation history experience.
 * Keeps history behavior configurable in one place instead of hardcoding it
 * across components (per the architecture rules: config-driven UI).
 */
export interface HistoryConfig {
  /** Page size requested from the backend list endpoint. */
  pageSize: number;
  /** Show the search box. */
  searchEnabled: boolean;
  /** Show archive / unarchive actions and an Archived section. */
  archiveEnabled: boolean;

  /** Show the rename action in the item menu. */
  renameEnabled: boolean;
  /** Show the delete action in the item menu. */
  deleteEnabled: boolean;
  /** Copy (i18n-ready: no component literals). */
  copy: {
    /** Accessible label / text for the persisted-thread boot skeleton. */
    loadingConversation: string;
  };
}

export const historyConfig: HistoryConfig = {
  pageSize: 20,
  searchEnabled: true,
  archiveEnabled: true,
  renameEnabled: true,
  deleteEnabled: true,
  copy: {
    loadingConversation: "Loading conversation…",
  },
};
