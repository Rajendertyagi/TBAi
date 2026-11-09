import { describe, it, expect, beforeEach } from "bun:test";
import { usePreferencesStore } from "@web/features/preferences/state/preferencesStore";
import { useChatTabsStore, visibleTabs } from "@web/features/chat/state/chatTabs";

function reset(sharedTabs: Array<{ ref: string; kind: "chat" | "agent" }> = []) {
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
      sharedTabs,
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

describe("detached conversations (local presentation)", () => {
  beforeEach(() => reset());

  it("keeps a locally presented conversation visible as detached when not in shared membership", () => {
    useChatTabsStore.getState().presentChat("c1");
    useChatTabsStore.getState().markDetached("c1");
    const tabs = visibleTabs(useChatTabsStore.getState());
    expect(tabs.some((t) => t.ref === "c1" && t.detached)).toBe(true);
  });

  it("remote/shared membership removal does not require local route change; detached marker is local-only", () => {
    reset([{ ref: "c1", kind: "chat" }]);
    useChatTabsStore.getState().presentChat("c1");
    // Simulate remote close reflected in authoritative snapshot.
    usePreferencesStore.getState().applySnapshot({
      ...usePreferencesStore.getState().snapshot!,
      revision: 2,
      sharedTabs: [],
    });
    useChatTabsStore.getState().markDetached("c1");
    expect(useChatTabsStore.getState().localActiveKey).toBe("chat:c1");
    expect(useChatTabsStore.getState().detachedRefs.c1).toBe(true);
  });

  it("explicit shared open clears detached marker on success", async () => {
    useChatTabsStore.getState().presentChat("c1");
    useChatTabsStore.getState().markDetached("c1");
    usePreferencesStore.setState({
      openSharedTab: async (conversationId: string, kind: "chat" | "agent") => {
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
    expect(useChatTabsStore.getState().detachedRefs.c1).toBeUndefined();
  });
});
