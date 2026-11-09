/**
 * Tabs & Navigation lifecycle correctness (updated for shared workspace model).
 *
 * Shared membership/order is server-authoritative (preferences snapshot).
 * Each window owns local active selection and local draft state.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { usePreferencesStore } from "@web/features/preferences/state/preferencesStore";
import {
  NEW_DRAFT_TAB_ID,
  activeTab,
  agentKey,
  chatKey,
  routeStillReferencesRef,
  shouldNavigateToThread,
  threadUrl,
  urlForTab,
  useChatTabsStore,
  visibleTabs,
} from "@web/features/chat/state/chatTabs";

const store = () => useChatTabsStore.getState();
const prefs = () => usePreferencesStore.getState();

function reset(): void {
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

beforeEach(reset);

describe("routeStillReferencesRef — stale-completion guard (pure)", () => {
  it("holds while the route still names the conversation on either surface", () => {
    expect(routeStillReferencesRef("/chat/abc", "abc")).toBe(true);
    expect(routeStillReferencesRef("/code/abc", "abc")).toBe(true);
  });

  it("rejects once navigation moved on (stale completion must not redirect)", () => {
    expect(routeStillReferencesRef("/chat/B", "A")).toBe(false);
    expect(routeStillReferencesRef("/code/B", "A")).toBe(false);
    expect(routeStillReferencesRef("/code/A", "A")).toBe(true);
    expect(routeStillReferencesRef("/chat/A", "A")).toBe(true);
  });

  it("rejects non-conversation routes and near-misses", () => {
    expect(routeStillReferencesRef("/chat/new", "new")).toBe(true);
    expect(routeStillReferencesRef("/chat/new", "abc")).toBe(false);
    expect(routeStillReferencesRef("/scheduler", "abc")).toBe(false);
    expect(routeStillReferencesRef("/", "abc")).toBe(false);
    expect(routeStillReferencesRef("/chat/abc/def", "abc")).toBe(false);
    expect(routeStillReferencesRef("/chat/abc-def", "abc")).toBe(false);
  });
});

describe("shouldNavigateToThread — history-duplication guard (pure)", () => {
  it("is false when the route already shows the conversation", () => {
    expect(shouldNavigateToThread("/chat/c1", "c1", "direct")).toBe(false);
    expect(shouldNavigateToThread("/chat/c1", "c1", null)).toBe(false);
    expect(shouldNavigateToThread("/code/c1", "c1", "opencode")).toBe(false);
  });

  it("is true when opening a different conversation", () => {
    expect(shouldNavigateToThread("/chat/c1", "c2", "direct")).toBe(true);
    expect(shouldNavigateToThread("/scheduler", "c1", "direct")).toBe(true);
    expect(shouldNavigateToThread("/chat/new", "c1", "direct")).toBe(true);
  });

  it("treats the wrong engine surface as a real navigation", () => {
    expect(shouldNavigateToThread("/chat/c1", "c1", "opencode")).toBe(true);
    expect(shouldNavigateToThread("/code/c1", "c1", "direct")).toBe(true);
  });

  it("agrees with threadUrl (single home for open-URL rules)", () => {
    expect(threadUrl("c1", "opencode")).toBe("/code/c1");
    expect(shouldNavigateToThread(threadUrl("c1", "opencode"), "c1", "opencode")).toBe(false);
  });
});

describe("draft → persisted converges local presentation and URL projection", () => {
  it("direct resolution rewrites local active tab and projects /chat/<id>", () => {
    store().openNewDraft();
    store().resolveDraftId("real-1", "direct");
    const state = store();
    expect(state.localActiveKey).toBe(chatKey("real-1"));
    expect(state.hasLocalDraft).toBe(false);
    expect(urlForTab(activeTab(state)!)).toBe("/chat/real-1");
  });

  it("opencode resolution swaps to the agent tab and projects /code/<id>", () => {
    store().openNewDraft();
    store().resolveDraftId("real-2", "opencode");
    const state = store();
    expect(state.localActiveKey).toBe(agentKey("real-2"));
    expect(state.hasLocalDraft).toBe(false);
    expect(urlForTab(activeTab(state)!)).toBe("/code/real-2");
  });

  it("background draft resolution does not steal the local active tab", () => {
    prefs().applySnapshot({
      ...prefs().snapshot!,
      revision: 2,
      sharedTabs: [{ kind: "chat", ref: "keep" }],
    });
    store().presentChat("keep");
    store().openNewDraft();
    store().selectLocal(chatKey("keep"));
    store().resolveDraftId("real-3", "direct");
    expect(store().localActiveKey).toBe(chatKey("keep"));
    expect(urlForTab(activeTab(store())!)).toBe("/chat/keep");
  });
});

describe("local presentation is deterministic", () => {
  it("selecting a shared tab updates only local active state", () => {
    prefs().applySnapshot({
      ...prefs().snapshot!,
      revision: 2,
      sharedTabs: [
        { kind: "chat", ref: "a" },
        { kind: "chat", ref: "b" },
      ],
    });
    store().presentChat("a");
    store().selectLocal(chatKey("b"));
    expect(store().localActiveKey).toBe(chatKey("b"));
    expect(prefs().snapshot?.sharedTabs.map((t) => t.ref)).toEqual(["a", "b"]);
  });

  it("visible tabs include shared membership and local draft", () => {
    prefs().applySnapshot({
      ...prefs().snapshot!,
      revision: 2,
      sharedTabs: [{ kind: "chat", ref: "a" }],
    });
    store().openNewDraft();
    const tabs = visibleTabs(store());
    expect(tabs.some((t) => t.ref === "a")).toBe(true);
    expect(tabs.some((t) => t.ref === NEW_DRAFT_TAB_ID)).toBe(true);
  });

  it("a valid non-member active conversation appears as detached local presentation", () => {
    store().presentChat("detached-1");
    store().markDetached("detached-1");
    const tabs = visibleTabs(store());
    const tab = tabs.find((t) => t.ref === "detached-1");
    expect(tab?.detached).toBe(true);
  });
});

describe("open paths converge on local presentation (no duplicate local draft)", () => {
  it("presenting the same conversation updates local active key", () => {
    store().presentChat("c1");
    store().presentChat("c1");
    expect(store().localActiveKey).toBe(chatKey("c1"));
  });

  it("same conversation can be presented on either surface locally", () => {
    store().presentChat("c1");
    expect(store().localActiveKey).toBe(chatKey("c1"));
    store().presentAgent("c1");
    expect(store().localActiveKey).toBe(agentKey("c1"));
  });
});
