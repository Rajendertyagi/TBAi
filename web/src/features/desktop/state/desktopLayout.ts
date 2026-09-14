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
import { normalizeSectionOrder } from "../../../lib/sidebar-sections";

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
  /** Whether the Archived section is expanded. */
  archivedExpanded: boolean;
  /** Live conversation-search query (transient, never persisted). */
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
  setArchivedExpanded: (v: boolean) => void;
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
  archivedExpanded: boolean;
}

const STORE_VERSION = 1;

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
    archivedExpanded: sidebarConfig.archivedExpandedByDefault,
  };
}

function isSortMode(value: unknown): value is SidebarSortMode {
  return value === "updated" || value === "created";
}

/** Merge an unknown persisted payload over defaults, field by field. */
function migratePersisted(persisted: unknown): DesktopLayoutState {
  const defaults = defaultPersisted();
  const transient = { searchQuery: "", searchOpen: false, searchFocusRequest: 0 };
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
    archivedExpanded:
      typeof p.archivedExpanded === "boolean"
        ? p.archivedExpanded
        : defaults.archivedExpanded,
  } as DesktopLayoutState;
}

export const useDesktopLayout = create<DesktopLayoutState>()(
  persist<DesktopLayoutState, [], [], PersistedLayout>(
    (set) => ({
      ...defaultPersisted(),
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
      moveSection: (id, delta) =>
        set((s) => {
          const order = s.sectionOrder.slice();
          const from = order.indexOf(id);
          if (from < 0) return s;
          const to = from + delta;
          if (to < 0 || to >= order.length || to === from) return s;
          order.splice(from, 1);
          order.splice(to, 0, id);
          return { sectionOrder: order };
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
      setArchivedExpanded: (v) => set({ archivedExpanded: v }),
      setSearchQuery: (q) => set({ searchQuery: q }),
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
        archivedExpanded: s.archivedExpanded,
      }),
    },
  ),
);
