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
import { DEFAULT_CHAT_WIDTH, type ChatWidth } from "../../../config/chat";
import { moveSectionInOrder } from "./sidebarSections";
import { usePreferencesStore } from "../../preferences/state/preferencesStore";

function patchDesktop(desktop: Record<string, unknown>): void {
  void usePreferencesStore
    .getState()
    .patchPreferences({ desktop })
    .catch(() => {});
}

/**
 * Desktop chrome layout + sidebar view preferences.
 * SQLite is authoritative for shared portable desktop fields; this store holds
 * current UI state and patches SQLite on user changes. Only `sidebarWidth` is
 * persisted locally (device-specific). Before hydration, defaults are used.
 */
interface DesktopLayoutState {
  sidebarVisible: boolean;
  statusBarVisible: boolean;
  /** Local/device-only (persisted). */
  sidebarWidth: number;
  chatWidth: ChatWidth;
  sidebarSort: SidebarSortMode;
  sectionOrder: readonly SidebarSectionId[];
  sectionCollapsed: SidebarSectionCollapsed;
  showCompleted: boolean;
  spellCheck: boolean;
  /** Transient search UI (never persisted). */
  searchInput: string;
  searchQuery: string;
  searchOpen: boolean;
  searchFocusRequest: number;
  toggleSidebar: () => void;
  toggleStatusBar: () => void;
  setSidebar: (v: boolean) => void;
  setStatusBar: (v: boolean) => void;
  setSidebarWidth: (w: number) => void;
  setChatWidth: (w: ChatWidth) => void;
  setSidebarSort: (sort: SidebarSortMode) => void;
  moveSection: (id: SidebarSectionId, delta: number) => void;
  setSectionCollapsed: (id: SidebarSectionId, collapsed: boolean) => void;
  setAllSectionsCollapsed: (collapsed: boolean) => void;
  setShowCompleted: (v: boolean) => void;
  setSpellCheck: (v: boolean) => void;
  setSearchInput: (q: string) => void;
  setSearchQuery: (q: string) => void;
  setSearchOpen: (open: boolean) => void;
  requestSearchFocus: () => void;
}

interface PersistedLayoutLocal {
  sidebarWidth: number;
}

const STORE_VERSION = 2;

let searchSettleTimer: ReturnType<typeof setTimeout> | null = null;

function cancelSearchSettle(): void {
  if (searchSettleTimer === null) return;
  clearTimeout(searchSettleTimer);
  searchSettleTimer = null;
}

function defaultState(): Omit<
  DesktopLayoutState,
  | "toggleSidebar"
  | "toggleStatusBar"
  | "setSidebar"
  | "setStatusBar"
  | "setSidebarWidth"
  | "setChatWidth"
  | "setSidebarSort"
  | "moveSection"
  | "setSectionCollapsed"
  | "setAllSectionsCollapsed"
  | "setShowCompleted"
  | "setSpellCheck"
  | "setSearchInput"
  | "setSearchQuery"
  | "setSearchOpen"
  | "requestSearchFocus"
> {
  return {
    sidebarVisible: true,
    statusBarVisible: true,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    chatWidth: DEFAULT_CHAT_WIDTH,
    sidebarSort: sidebarConfig.defaultSort,
    sectionOrder: sidebarConfig.defaultSectionOrder,
    sectionCollapsed: {},
    showCompleted: false,
    spellCheck: true,
    searchInput: "",
    searchQuery: "",
    searchOpen: false,
    searchFocusRequest: 0,
  };
}

export function migratePersisted(persisted: unknown): { sidebarWidth: number } {
  if (typeof persisted !== "object" || persisted === null) {
    return { sidebarWidth: SIDEBAR_DEFAULT_WIDTH };
  }
  const p = persisted as Record<string, unknown>;
  return {
    sidebarWidth:
      typeof p.sidebarWidth === "number" && Number.isFinite(p.sidebarWidth)
        ? clamp(p.sidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
        : SIDEBAR_DEFAULT_WIDTH,
  };
}

export const useDesktopLayout = create<DesktopLayoutState>()(
  persist<DesktopLayoutState, [], [], PersistedLayoutLocal>(
    (set) => ({
      ...defaultState(),
      toggleSidebar: () =>
        set((s) => {
          const sidebarVisible = !s.sidebarVisible;
          patchDesktop({ sidebarVisible });
          return { sidebarVisible };
        }),
      toggleStatusBar: () =>
        set((s) => {
          const statusBarVisible = !s.statusBarVisible;
          patchDesktop({ statusBarVisible });
          return { statusBarVisible };
        }),
      setSidebar: (v) => {
        set({ sidebarVisible: v });
        patchDesktop({ sidebarVisible: v });
      },
      setStatusBar: (v) => {
        set({ statusBarVisible: v });
        patchDesktop({ statusBarVisible: v });
      },
      setSidebarWidth: (w) => set({ sidebarWidth: clamp(w, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH) }),
      setChatWidth: (w) => {
        set({ chatWidth: w });
        patchDesktop({ chatWidth: w });
      },
      setSidebarSort: (sort) => {
        set({ sidebarSort: sort });
        patchDesktop({ sidebarSort: sort });
      },
      moveSection: (id, delta) =>
        set((s) => {
          const sectionOrder = moveSectionInOrder(s.sectionOrder, id, delta);
          if (sectionOrder === s.sectionOrder) return s;
          patchDesktop({ sectionOrder });
          return { sectionOrder };
        }),
      setSectionCollapsed: (id, collapsed) =>
        set((s) => {
          const sectionCollapsed = { ...s.sectionCollapsed, [id]: collapsed };
          patchDesktop({ sectionCollapsed });
          return { sectionCollapsed };
        }),
      setAllSectionsCollapsed: (collapsed) =>
        set((s) => {
          const next: SidebarSectionCollapsed = {};
          for (const id of s.sectionOrder) next[id] = collapsed;
          patchDesktop({ sectionCollapsed: next });
          return { sectionCollapsed: next };
        }),
      setShowCompleted: (v) => {
        set({ showCompleted: v });
        patchDesktop({ showCompleted: v });
      },
      setSpellCheck: (v) => {
        set({ spellCheck: v });
        patchDesktop({ spellCheck: v });
      },
      setSearchInput: (q) => {
        set({ searchInput: q });
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
      requestSearchFocus: () => set((s) => ({ searchFocusRequest: s.searchFocusRequest + 1 })),
    }),
    {
      name: "tbai:desktopLayout",
      version: STORE_VERSION,
      migrate: (persisted) => migratePersisted(persisted),
      // Only sidebarWidth is local/device-specific.
      partialize: (s) => ({
        sidebarWidth: s.sidebarWidth,
      }),
      merge: (persisted, current) => {
        const local = migratePersisted(persisted);
        return { ...current, sidebarWidth: local.sidebarWidth };
      },
    },
  ),
);
