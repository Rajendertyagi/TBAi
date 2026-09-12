/**
 * Single source of truth for status-bar copy. Components reference this —
 * no literals live in `StatusBar.tsx` / `StatusBarQuickActions.tsx`. Settings
 * area labels come from `navigation.ts` (not duplicated here).
 */
export const statusBarConfig = {
  copy: {
    quickActions: "Quick actions",
    newChat: "New chat",
    toggleSidebar: "Toggle sidebar",
    toggleStatusBar: "Toggle status bar",
    connectionLocal: "Local",
    connectionTitle: "Local connection",
    noProvider: "No provider configured",
    openProviders: "Open provider settings",
  },
};
