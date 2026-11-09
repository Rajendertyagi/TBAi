import { describe, it, expect, beforeEach } from "bun:test";
import { usePreferencesStore } from "@web/features/preferences/state/preferencesStore";
import {
  activeTab,
  agentKey,
  chatKey,
  threadUrl,
  urlForTab,
  useChatTabsStore,
  visibleTabs,
  type Tab,
} from "@web/features/chat/state/chatTabs.ts";

/**
 * Regression tests for tab shape/URL safety under the shared workspace model.
 * Local presentation must never produce colon-prefixed refs or wrong routes.
 */

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

function noColonRefs(tabs: Tab[]): boolean {
  return tabs.every((t) => !t.ref.startsWith(":"));
}

describe("agent/chat presentation — shape safety", () => {
  beforeEach(reset);

  it("presentAgent creates a clean local agent presentation", () => {
    useChatTabsStore.getState().presentAgent("vuvg19b9ep437ry4bt4jgfvk");
    expect(useChatTabsStore.getState().localActiveKey).toBe("agent:vuvg19b9ep437ry4bt4jgfvk");
    const tab = activeTab(useChatTabsStore.getState());
    expect(tab).toEqual({
      key: "agent:vuvg19b9ep437ry4bt4jgfvk",
      kind: "agent",
      ref: "vuvg19b9ep437ry4bt4jgfvk",
      detached: true,
    });
  });

  it("presentChat creates a clean local chat presentation", () => {
    useChatTabsStore.getState().presentChat("thread1");
    expect(useChatTabsStore.getState().localActiveKey).toBe("chat:thread1");
  });

  it("agent tabs route to /code/<id>, never /chat/:<id>", () => {
    useChatTabsStore.getState().presentAgent("vuvg19b9ep437ry4bt4jgfvk");
    const tab = activeTab(useChatTabsStore.getState());
    expect(tab).toBeDefined();
    expect(urlForTab(tab as Tab)).toBe("/code/vuvg19b9ep437ry4bt4jgfvk");
  });

  it("no tab ref ever starts with a colon across local flows", () => {
    const s = useChatTabsStore.getState();
    s.presentChat("t1");
    s.presentAgent("a1");
    s.openNewDraft();
    s.selectLocal(agentKey("a1"));
    s.selectLocal(chatKey("t1"));
    s.closeLocal(agentKey("a1"));
    expect(noColonRefs(visibleTabs(useChatTabsStore.getState()))).toBe(true);
  });
});

describe("threadUrl — engine-aware thread opening", () => {
  it("routes opencode conversations to the Code surface", () => {
    expect(threadUrl("abc", "opencode")).toBe("/code/abc");
  });

  it("routes direct, missing, and null engines to the chat surface", () => {
    expect(threadUrl("abc", "direct")).toBe("/chat/abc");
    expect(threadUrl("abc", undefined)).toBe("/chat/abc");
    expect(threadUrl("abc", null)).toBe("/chat/abc");
  });

  it("never produces a colon-prefixed route", () => {
    for (const engine of ["direct", "opencode", undefined, null, "bogus"]) {
      expect(threadUrl("abc", engine)).not.toContain("/:");
    }
  });
});
