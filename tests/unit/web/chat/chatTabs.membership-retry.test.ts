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

describe("shared membership failure and explicit retry", () => {
  beforeEach(reset);

  it("records transient failure on non-409 error and retry performs only membership op", async () => {
    let openCalls = 0;
    usePreferencesStore.setState({
      openSharedTab: async (conversationId: string, kind: "chat" | "agent") => {
        openCalls++;
        if (openCalls === 1) throw new Error("network down");
        const snap = usePreferencesStore.getState().snapshot!;
        const next = {
          ...snap,
          revision: snap.revision + 1,
          sharedTabs: [...snap.sharedTabs, { ref: conversationId, kind }],
        };
        usePreferencesStore.setState({ snapshot: next } as any);
        return next;
      },
    } as any);

    await useChatTabsStore.getState().requestSharedOpen("c1", "chat");
    expect(openCalls).toBe(1);
    expect(useChatTabsStore.getState().membershipFailures.c1?.message).toContain("network down");
    // Conversation remains locally selectable (detached/local presentation path).
    expect(useChatTabsStore.getState().localActiveKey).toBe("chat:c1");

    await useChatTabsStore.getState().retrySharedOpen("c1", "chat");
    expect(openCalls).toBe(2); // only membership op retried
    expect(useChatTabsStore.getState().membershipFailures.c1).toBeUndefined();
    expect(usePreferencesStore.getState().snapshot?.sharedTabs).toEqual([{ ref: "c1", kind: "chat" }]);
  });

  it("stale 409 on explicit retry refreshes authoritative state and does not auto-retry with fresh revision", async () => {
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

    await useChatTabsStore.getState().retrySharedOpen("c1", "chat");
    expect(openCalls).toBe(1);
    expect(refreshCalls).toBeGreaterThan(0);
    expect(useChatTabsStore.getState().membershipFailures.c1).toBeTruthy();
  });
});
