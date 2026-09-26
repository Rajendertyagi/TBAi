import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  SIDEBAR_DEFAULT_WIDTH,
  clamp,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from "../../../lib/window-chrome";
import {
  sidebarConfig,
  type SidebarSectionCollapsed,
  type SidebarSectionId,
  type SidebarSortMode,
} from "../../../config/sidebar";
import {
  moveSectionInOrder,
  normalizeSectionOrder,
} from "../../../lib/sidebar-sections";

/**
 * Desktop chrome layout + sidebar view preferences (VS Code–like). UI-only
 * state per AGENTS.md (Zustand = shared UI state, not the persistence layer);
 * layout preferences persist to localStorage so the user's chrome survives
 * restarts. Transient search UI (query/open/focus) lives here for cross-chrome
 * sharing (overlay input ↔ sidebar list) but is excluded from persistence.
 *
 * Versioned (`STORE_VERSION` + `migrate`) so future preference additions never
 * reset existing users, and corrupt payloads fall back to defaults field by
 * field instead of crashing.
 */
interface DesktopLayoutState {
  /** Left navigation/conversation sidebar. */
  sidebarVisible: boolean;
  /** Bottom status bar (provider/model + connection). */
  statusBarVisible: boolean;
  /** Conversation sidebar width in px (user-resizable, clamped). */
  sidebarWidth: number;
  /** Thread sort for the sidebar lists. */
  sidebarSort: SidebarSortMode;
  /** Top-to-bottom sidebar section order (always a full permutation). */
  sectionOrder: readonly SidebarSectionId[];
  /** Per-section collapsed flags. Absent = expanded. */
  sectionCollapsed: SidebarSectionCollapsed;
  /** Whether the Recent section renders. */
  showRecent: boolean;
  /** Whether archived conversations are shown in the sidebar lists. */
  showCompleted: boolean;
  /**
   * Raw search box contents, one write per keystroke (transient). Consumers must
   * read `searchQuery` instead — this exists only so the controlled input stays
   * responsive while the query is still settling.
   */
  searchInput: string;
  /**
   * Settled conversation-search query (transient, never persisted). Written
   * `sidebarConfig.searchDebounceMs` after `searchInput` stops changing, so one
   * keystroke burst produces ONE list request instead of one per keystroke per
   * sidebar section (the folder list alone fetches once per registered folder).
   */
  searchQuery: string;
  /** Whether the chrome search input is expanded (transient). */
  searchOpen: boolean;
  /** Bump to request focus of the chrome search input (transient). */
  searchFocusRequest: number;
  toggleSidebar: () => void;
  toggleStatusBar: () => void;
  setSidebar: (v: boolean) => void;
  setStatusBar: (v: boolean) => void;
  setSidebarWidth: (w: number) => void;
  setSidebarSort: (sort: SidebarSortMode) => void;
  moveSection: (id: SidebarSectionId, delta: number) => void;
  setSectionCollapsed: (id: SidebarSectionId, collapsed: boolean) => void;
  setAllSectionsCollapsed: (collapsed: boolean) => void;
  setShowRecent: (v: boolean) => void;
  setShowCompleted: (v: boolean) => void;
  /** Record a keystroke; `searchQuery` settles after the debounce. */
  setSearchInput: (q: string) => void;
  /** Set input + query together, cancelling any pending settle. */
  setSearchQuery: (q: string) => void;
  setSearchOpen: (open: boolean) => void;
  requestSearchFocus: () => void;
}

/** The durable subset of the store (transient search UI excluded). */
interface PersistedLayout {
  sidebarVisible: boolean;
  statusBarVisible: boolean;
  sidebarWidth: number;
  sidebarSort: SidebarSortMode;
  sectionOrder: readonly SidebarSectionId[];
  sectionCollapsed: SidebarSectionCollapsed;
  showRecent: boolean;
  showCompleted: boolean;
}

const STORE_VERSION = 1;

/**
 * Pending `searchInput` -> `searchQuery` settle. Module scope (not state) so it
 * never reaches persistence or triggers a render on its own.
 */
let searchSettleTimer: ReturnType<typeof setTimeout> | null = null;

/** Cancel a pending settle so an immediate `setSearchQuery` wins the race. */
function cancelSearchSettle(): void {
  if (searchSettleTimer === null) return;
  clearTimeout(searchSettleTimer);
  searchSettleTimer = null;
}

function defaultPersisted(): PersistedLayout {
  return {
    sidebarVisible: true,
    statusBarVisible: true,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    sidebarSort: sidebarConfig.defaultSort,
    sectionOrder: sidebarConfig.defaultSectionOrder,
    sectionCollapsed: {},
    showRecent: sidebarConfig.showRecentByDefault,
    showCompleted: false,
  };
}

function isSortMode(value: unknown): value is SidebarSortMode {
  return value === "updated" || value === "created";
}

/** Merge an unknown persisted payload over defaults, field by field. */
function migratePersisted(persisted: unknown): DesktopLayoutState {
  const defaults = defaultPersisted();
  const transient = {
    searchInput: "",
    searchQuery: "",
    searchOpen: false,
    searchFocusRequest: 0,
  };
  if (typeof persisted !== "object" || persisted === null) {
    return { ...defaults, ...transient } as DesktopLayoutState;
  }
  const p = persisted as Record<string, unknown>;
  // Actions are re-created by the initializer; migrate only returns state.
  // The `as DesktopLayoutState` cast is safe: every field is defaulted above.
  return {
    ...defaults,
    ...transient,
    sidebarVisible:
      typeof p.sidebarVisible === "boolean"
        ? p.sidebarVisible
        : defaults.sidebarVisible,
    statusBarVisible:
      typeof p.statusBarVisible === "boolean"
        ? p.statusBarVisible
        : defaults.statusBarVisible,
    sidebarWidth:
      typeof p.sidebarWidth === "number" && Number.isFinite(p.sidebarWidth)
        ? clamp(p.sidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
        : defaults.sidebarWidth,
    sidebarSort: isSortMode(p.sidebarSort) ? p.sidebarSort : defaults.sidebarSort,
    sectionOrder: normalizeSectionOrder(p.sectionOrder),
    sectionCollapsed:
      typeof p.sectionCollapsed === "object" && p.sectionCollapsed !== null
        ? (p.sectionCollapsed as SidebarSectionCollapsed)
        : defaults.sectionCollapsed,
    showRecent:
      typeof p.showRecent === "boolean" ? p.showRecent : defaults.showRecent,
    showCompleted:
      typeof p.showCompleted === "boolean"
        ? p.showCompleted
        : defaults.showCompleted,
  } as DesktopLayoutState;
}

export const useDesktopLayout = create<DesktopLayoutState>()(
  persist<DesktopLayoutState, [], [], PersistedLayout>(
    (set) => ({
      ...defaultPersisted(),
      searchInput: "",
      searchQuery: "",
      searchOpen: false,
      searchFocusRequest: 0,
      toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
      toggleStatusBar: () =>
        set((s) => ({ statusBarVisible: !s.statusBarVisible })),
      setSidebar: (v) => set({ sidebarVisible: v }),
      setStatusBar: (v) => set({ statusBarVisible: v }),
      setSidebarWidth: (w) =>
        set({ sidebarWidth: clamp(w, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH) }),
      setSidebarSort: (sort) => set({ sidebarSort: sort }),
      // Reorder through the shared pure helper so the store and the sidebar
      // cannot drift on edge cases (out-of-range delta, unknown id). The helper
      // returns the SAME array on a no-op, so returning `s` there keeps zustand
      // from notifying subscribers for a move that changed nothing.
      moveSection: (id, delta) =>
        set((s) => {
          const sectionOrder = moveSectionInOrder(s.sectionOrder, id, delta);
          return sectionOrder === s.sectionOrder ? s : { sectionOrder };
        }),
      setSectionCollapsed: (id, collapsed) =>
        set((s) => ({
          sectionCollapsed: { ...s.sectionCollapsed, [id]: collapsed },
        })),
      setAllSectionsCollapsed: (collapsed) =>
        set((s) => {
          const next: SidebarSectionCollapsed = {};
          for (const id of s.sectionOrder) next[id] = collapsed;
          return { sectionCollapsed: next };
        }),
      setShowRecent: (v) => set({ showRecent: v }),
      setShowCompleted: (v) => set({ showCompleted: v }),
      setSearchInput: (q) => {
        set({ searchInput: q });
        // Clearing is not a search — settle it now so the sections come back
        // immediately instead of lingering for the debounce window.
        if (q === "") {
          cancelSearchSettle();
          set({ searchQuery: "" });
          return;
        }
        cancelSearchSettle();
        searchSettleTimer = setTimeout(() => {
          searchSettleTimer = null;
          set({ searchQuery: q });
        }, sidebarConfig.searchDebounceMs);
      },
      setSearchQuery: (q) => {
        cancelSearchSettle();
        set({ searchInput: q, searchQuery: q });
      },
      setSearchOpen: (open) => set({ searchOpen: open }),
      requestSearchFocus: () =>
        set((s) => ({ searchFocusRequest: s.searchFocusRequest + 1 })),
    }),
    {
      name: "tbai:desktopLayout",
      version: STORE_VERSION,
      migrate: (persisted) => migratePersisted(persisted),
      // Transient search UI never hits storage.
      partialize: (s) => ({
        sidebarVisible: s.sidebarVisible,
        statusBarVisible: s.statusBarVisible,
        sidebarWidth: s.sidebarWidth,
        sidebarSort: s.sidebarSort,
        sectionOrder: s.sectionOrder,
        sectionCollapsed: s.sectionCollapsed,
        showRecent: s.showRecent,
        showCompleted: s.showCompleted,
      }),
    },
  ),
);
