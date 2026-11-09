/**
 * Shared workspace membership invariants (delayed add / explicit close races).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { usePreferencesStore } from "@web/features/preferences/state/preferencesStore";
import { PreferencesConflictError } from "@web/features/preferences/api/preferences";
import { useChatTabsStore } from "@web/features/chat/state/chatTabs";

function reset() {
  useChatTabsStore.setState({
    localActiveKey: undefined,
    hasLocalDraft: false,
    detachedRefs: {},
    membershipFailures: {},
    suppressedDelayedAdds: {},
  });
  usePreferencesStore.setState({
    snapshot: {
      revision: 1,
      sharedTabs: [],
      preferences: {
        appearance: {
          themeMode: "system",
          lightTheme: "default",
          darkTheme: "default",
          typography: "default",
        },
        desktop: {
          sidebarVisible: true,
          statusBarVisible: true,
          chatWidth: "comfortable",
          sidebarSort: "updated",
          sectionOrder: [],
          sectionCollapsed: {},
          showCompleted: false,
          spellCheck: true,
        },
        welcome: {
          engine: "direct",
          quickActionTab: "coding",
          scopeMode: "simple",
          folderId: null,
        },
        navigation: { selectedFolderId: null, folderExpanded: {} },
      },
    },
    hydration: "ready",
    hydrationError: null,
  } as any);
}

describe("requestDelayedSharedOpen", () => {
  beforeEach(reset);

  it("does not auto-retry with fresh revision on stale 409; refreshes and records recoverable failure", async () => {
    let openCalls = 0;
    let refreshCalls = 0;
    usePreferencesStore.setState({
      openSharedTab: async () => {
        openCalls++;
        throw new PreferencesConflictError({
          error: "conflict",
          conflict: true,
          revision: 2,
          snapshot: usePreferencesStore.getState().snapshot!,
        });
      },
      refresh: async () => {
        refreshCalls++;
        return usePreferencesStore.getState().snapshot;
      },
    } as any);

    useChatTabsStore.getState().requestDelayedSharedOpen("c1", "chat");
    await new Promise((r) => setTimeout(r, 20));

    expect(openCalls).toBe(1); // MUST NOT auto-retry
    expect(refreshCalls).toBeGreaterThan(0);
    expect(useChatTabsStore.getState().membershipFailures.c1?.message).toContain(
      "Workspace changed",
    );
  });

  it("is suppressed when user explicitly closed before commit", async () => {
    let openCalls = 0;
    let closeCalls = 0;
    usePreferencesStore.setState({
      openSharedTab: async () => {
        openCalls++;
        // Simulate close happening before commit resolves in this window.
        useChatTabsStore.setState((s) => ({
          suppressedDelayedAdds: { ...s.suppressedDelayedAdds, c1: Date.now() },
        }));
        return usePreferencesStore.getState().snapshot;
      },
      closeSharedTab: async () => {
        closeCalls++;
        return usePreferencesStore.getState().snapshot;
      },
      refresh: async () => usePreferencesStore.getState().snapshot,
    } as any);

    useChatTabsStore.getState().requestDelayedSharedOpen("c1", "chat");
    await new Promise((r) => setTimeout(r, 20));

    expect(openCalls).toBe(1);
    expect(closeCalls).toBe(1); // preserves explicit close
  });
});
