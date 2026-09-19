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
    // Backend availability (Phase 3.3): cached state is never presented as
    // authoritative — offline/degraded copy always says what is shown is stale.
    availabilityOnline: "Local",
    availabilityOnlineTitle: "Backend available",
    availabilityDegraded: "Reconnecting…",
    availabilityDegradedTitle: "Backend degraded — showing last known state",
    availabilityOffline: "Offline",
    availabilityOfflineTitle: "Backend unavailable — showing last known state",
    availabilityUnknown: "Local",
    availabilityUnknownTitle: "Backend status unknown",
    noProvider: "No provider configured",
    openProviders: "Open provider settings",
  },
};
