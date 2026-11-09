/**
 * Application-foundation unit tests (no DOM, no server).
 *
 * Covers: chat tab store (local presentation, draft, active resolution, close
 * behavior), tab URL mapping, and the settings-nav source of truth.
 *
 * Shared-workspace architecture: shared membership is server-authoritative;
 * each window owns local active selection/draft state. Close invariants that
 * were synchronous in the old unified store are exercised via
 * `requestSharedClose` with a mocked shared-membership mutation (the
 * authoritative close path). The old pure `nextActiveAfterClose` export was
 * removed; its right-neighbor invariant is preserved by the close tests below.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { usePreferencesStore } from "@web/features/preferences/state/preferencesStore";
import {
  NEW_DRAFT_TAB_ID,
  activeTab,
  chatKey,
  urlForTab,
  useChatTabsStore,
  visibleTabs,
} from "@web/features/chat/state/chatTabs.ts";
import { getRailNav, getSettingsNav } from "@web/config/navigation.ts";
import type { WorkspacePreferencesSnapshot } from "@web/features/preferences/state/types";

function baseSnapshot(
  overrides: Partial<WorkspacePreferencesSnapshot> = {},
): WorkspacePreferencesSnapshot {
  return {
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
    ...overrides,
  };
}

function resetStores(): void {
  useChatTabsStore.setState({
    localActiveKey: undefined,
    hasLocalDraft: false,
    detachedRefs: {},
    membershipFailures: {},
    suppressedDelayedAdds: {},
  });
  usePreferencesStore.setState({
    snapshot: baseSnapshot(),
    hydration: "ready",
    hydrationError: null,
    // Default: simulate authoritative shared close by removing the tab.
    closeSharedTab: async (conversationId: string) => {
      const cur = usePreferencesStore.getState().snapshot!;
      const sharedTabs = cur.sharedTabs.filter((t) => t.ref !== conversationId);
      const next = baseSnapshot({
        revision: cur.revision + 1,
        sharedTabs,
      });
      usePreferencesStore.getState().applySnapshot(next);
      return next;
    },
  } as any);
}

function setSharedTabs(ids: string[], activeLocal?: string): void {
  usePreferencesStore.getState().applySnapshot(
    baseSnapshot({
      revision: 2,
      sharedTabs: ids.map((id) => ({ kind: "chat" as const, ref: id })),
      }),
  );
  if (activeLocal) useChatTabsStore.setState({ localActiveKey: chatKey(activeLocal) });
}

describe("unified tab store (local presentation)", () => {
  beforeEach(resetStores);

  it("opens a chat tab and makes it active", () => {
    useChatTabsStore.getState().presentChat("abc");
    const s = useChatTabsStore.getState();
    expect(s.localActiveKey).toBe("chat:abc");
    expect(visibleTabs(s).some((t) => t.key === "chat:abc")).toBe(true);
  });

  it("does not duplicate an already-open chat tab", () => {
    const api = useChatTabsStore.getState();
    api.presentChat("abc");
    api.presentChat("def");
    api.presentChat("abc");
    const tabs = visibleTabs(useChatTabsStore.getState());
    expect(tabs.filter((t) => t.ref === "abc")).toHaveLength(1);
    expect(useChatTabsStore.getState().localActiveKey).toBe("chat:abc");
  });

  it("supports the unsent draft tab and attaches the real id", () => {
    const api = useChatTabsStore.getState();
    api.presentChat(NEW_DRAFT_TAB_ID);
    expect(useChatTabsStore.getState().localActiveKey).toBe("chat:new");
    useChatTabsStore.getState().resolveDraftId("real-1", "direct");
    const s = useChatTabsStore.getState();
    expect(s.localActiveKey).toBe("chat:real-1");
  });

  it("closing the active tab falls back to the neighbor", async () => {
    setSharedTabs(["a", "b", "c"], "c");
    await useChatTabsStore.getState().requestSharedClose("c");
    const s = useChatTabsStore.getState();
    expect(usePreferencesStore.getState().snapshot?.sharedTabs.map((t) => t.ref)).toEqual([
      "a",
      "b",
    ]);
    expect(s.localActiveKey).toBe("chat:b");
  });

  it("closing the last tab opens a fresh draft (never zero tabs)", async () => {
    setSharedTabs(["only"], "only");
    await useChatTabsStore.getState().requestSharedClose("only");
    const s = useChatTabsStore.getState();
    expect(usePreferencesStore.getState().snapshot?.sharedTabs).toEqual([]);
    expect(s.hasLocalDraft).toBe(true);
    expect(s.localActiveKey).toBe("chat:new");
  });

  it("closing a background tab keeps the active tab", async () => {
    setSharedTabs(["a", "b"], "a");
    await useChatTabsStore.getState().requestSharedClose("b");
    const s = useChatTabsStore.getState();
    expect(usePreferencesStore.getState().snapshot?.sharedTabs.map((t) => t.ref)).toEqual([
      "a",
    ]);
    expect(s.localActiveKey).toBe("chat:a");
  });

  it("activeTab resolves the active tab object", () => {
    useChatTabsStore.getState().presentChat("abc");
    expect(activeTab(useChatTabsStore.getState())?.key).toBe("chat:abc");
  });
});

describe("tab keys and urls", () => {
  it("maps tabs to routes", () => {
    expect(chatKey("abc")).toBe("chat:abc");
    expect(urlForTab({ key: "chat:abc", kind: "chat", ref: "abc" })).toBe("/chat/abc");
    expect(urlForTab({ key: "chat:new", kind: "chat", ref: "new" })).toBe("/chat/new");
  });

  it("nextActiveAfterClose prefers the right neighbor (invariant preserved by requestSharedClose)", async () => {
    // Old pure export `nextActiveAfterClose` was removed with the shared-workspace
    // architecture; the right-neighbor invariant is preserved by the authoritative
    // close path. Closing middle selects right neighbor; closing rightmost selects left.
    setSharedTabs(["a", "b", "c"], "b");
    await useChatTabsStore.getState().requestSharedClose("b");
    expect(useChatTabsStore.getState().localActiveKey).toBe("chat:c");

    resetStores();
    setSharedTabs(["a", "b", "c"], "c");
    await useChatTabsStore.getState().requestSharedClose("c");
    expect(useChatTabsStore.getState().localActiveKey).toBe("chat:b");

    resetStores();
    setSharedTabs(["a"], "a");
    await useChatTabsStore.getState().requestSharedClose("a");
    expect(useChatTabsStore.getState().localActiveKey).toBe("chat:new");
  });
});

describe("settings nav source of truth", () => {
  it("lists every settings section exactly once, in order", () => {
    const routes = getSettingsNav().map((item) => item.route);
    expect(routes).toEqual([
      "/providers",
      "/appearance",
      "/typography",
      "/workspace",
      "/opencode-config",
      "/folders",
      "/desktop",
      "/memory",
      "/quick-messages",
      "/mcp",
      "/logs",
    ]);
  });
});

describe("rail nav (single-gear rule)", () => {
  it("shows chat, scheduler, archived, and one settings gear — never settings-area icons", () => {
    const ids = getRailNav().map((item) => item.id);
    expect(ids).toEqual(["chat", "scheduler", "archived", "settings"]);
  });
});
