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
    /**
     * Shown when paging back fails. Deliberately NOT the initial-load copy:
     * the transcript is still populated in this state, so telling the user
     * "history could not be loaded" would be false.
     */
    loadEarlierFailed: string;
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
    loadEarlierFailed: "Could not load earlier messages. Try again.",
  },
};

/**
 * Hard deadline for ONE Direct history window request.
 *
 * This is a liveness bound, not a tolerance. A window request that never settles
 * leaves the thread's `load()` pending forever: `markHistoryLoadFailed` only runs
 * on a settled outcome, and the Retry control stays disabled while
 * `thread.isLoading` is true. Neither automatic recovery nor a manual Retry can
 * proceed, so an unbounded request makes the conversation permanently
 * unrecoverable without a page reload.
 *
 * Scoped to the window request deliberately: no other fetch in the app changes.
 */
export const HISTORY_WINDOW_FETCH_TIMEOUT_MS = 15_000;
