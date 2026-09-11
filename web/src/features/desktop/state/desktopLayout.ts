import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Desktop chrome layout preferences (VS Code–like). UI-only state per
 * AGENTS.md (Zustand = shared UI state, not the persistence layer); persisted
 * to localStorage so the user's window layout survives restarts. Browser build
 * ignores this store (the chrome is Tauri-only), but the values default on so
 * the desktop shell shows the full chrome automatically.
 */
interface DesktopLayoutState {
  /** Left navigation/conversation sidebar. */
  sidebarVisible: boolean;
  /** Bottom status bar (provider/model + connection). */
  statusBarVisible: boolean;
  toggleSidebar: () => void;
  toggleStatusBar: () => void;
  setSidebar: (v: boolean) => void;
  setStatusBar: (v: boolean) => void;
}

export const useDesktopLayout = create<DesktopLayoutState>()(
  persist(
    (set) => ({
      sidebarVisible: true,
      statusBarVisible: true,
      toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
      toggleStatusBar: () => set((s) => ({ statusBarVisible: !s.statusBarVisible })),
      setSidebar: (v) => set({ sidebarVisible: v }),
      setStatusBar: (v) => set({ statusBarVisible: v }),
    }),
    { name: "tbai:desktopLayout" },
  ),
);
