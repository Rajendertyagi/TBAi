import { describe, it, expect, beforeEach } from "bun:test";
import { usePreferencesStore } from "@web/features/preferences/state/preferencesStore";
import { agentKey, chatKey, useChatTabsStore } from "@web/features/chat/state/chatTabs";

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
  });
}

describe("resolveDraftId", () => {
  beforeEach(reset);

  it("resolves a local draft to a direct chat tab", () => {
    useChatTabsStore.getState().openNewDraft();
    useChatTabsStore.getState().resolveDraftId("real-1", "direct");
    expect(useChatTabsStore.getState().localActiveKey).toBe(chatKey("real-1"));
    expect(useChatTabsStore.getState().hasLocalDraft).toBe(false);
  });

  it("resolves a local draft to an agent tab for opencode", () => {
    useChatTabsStore.getState().openNewDraft();
    useChatTabsStore.getState().resolveDraftId("real-2", "opencode");
    expect(useChatTabsStore.getState().localActiveKey).toBe(agentKey("real-2"));
    expect(useChatTabsStore.getState().hasLocalDraft).toBe(false);
  });

  it("does not steal local active key when draft was not active", () => {
    usePreferencesStore.getState().applySnapshot({
      ...usePreferencesStore.getState().snapshot!,
      revision: 2,
      sharedTabs: [{ kind: "chat", ref: "keep" }],
    });
    useChatTabsStore.getState().presentChat("keep");
    useChatTabsStore.getState().openNewDraft();
    useChatTabsStore.getState().selectLocal(chatKey("keep"));
    useChatTabsStore.getState().resolveDraftId("real-3", "direct");
    expect(useChatTabsStore.getState().localActiveKey).toBe(chatKey("keep"));
  });
});
