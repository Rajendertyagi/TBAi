/**
 * Application-foundation unit tests (no DOM, no server).
 *
 * Covers: chat tab store (open/switch/close/draft/neighbor fallback),
 * tab URL mapping, and the settings-nav source of truth.
 * Written by the implementation agent; executed by the test agent
 * (`bun test`).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  NEW_DRAFT_TAB_ID,
  activeTab,
  chatKey,
  nextActiveAfterClose,
  urlForTab,
  useChatTabsStore,
  type Tab,
} from "../../web/src/features/chat/state/chatTabs";
import { getSettingsNav } from "../../web/src/config/navigation";

function resetStore(): void {
  useChatTabsStore.setState({ tabs: [], activeKey: undefined });
}

describe("unified tab store", () => {
  beforeEach(resetStore);

  it("opens a chat tab and makes it active", () => {
    useChatTabsStore.getState().openChat("abc");
    const s = useChatTabsStore.getState();
    expect(s.tabs).toEqual([{ key: "chat:abc", kind: "chat", ref: "abc" }]);
    expect(s.activeKey).toBe("chat:abc");
  });

  it("does not duplicate an already-open chat tab", () => {
    const api = useChatTabsStore.getState();
    api.openChat("abc");
    api.openChat("def");
    useChatTabsStore.getState().openChat("abc");
    expect(useChatTabsStore.getState().tabs.map((t) => t.key)).toEqual([
      "chat:abc",
      "chat:def",
    ]);
    expect(useChatTabsStore.getState().activeKey).toBe("chat:abc");
  });

  it("supports the unsent draft tab and attaches the real id", () => {
    const api = useChatTabsStore.getState();
    api.openChat(NEW_DRAFT_TAB_ID);
    expect(useChatTabsStore.getState().activeKey).toBe("chat:new");
    useChatTabsStore.getState().attachRealId(NEW_DRAFT_TAB_ID, "real-1");
    const s = useChatTabsStore.getState();
    expect(s.tabs).toEqual([{ key: "chat:real-1", kind: "chat", ref: "real-1" }]);
    expect(s.activeKey).toBe("chat:real-1");
  });

  it("closing the active tab falls back to the neighbor", () => {
    const api = useChatTabsStore.getState();
    api.openChat("a");
    api.openChat("b");
    api.openChat("c");
    useChatTabsStore.getState().close("chat:c");
    const s = useChatTabsStore.getState();
    expect(s.tabs.map((t) => t.key)).toEqual(["chat:a", "chat:b"]);
    expect(s.activeKey).toBe("chat:b");
  });

  it("closing the last tab opens a fresh draft (never zero tabs)", () => {
    useChatTabsStore.getState().openChat("only");
    useChatTabsStore.getState().close("chat:only");
    const s = useChatTabsStore.getState();
    expect(s.tabs).toEqual([
      { key: "chat:new", kind: "chat", ref: NEW_DRAFT_TAB_ID },
    ]);
    expect(s.activeKey).toBe("chat:new");
  });

  it("closing a background tab keeps the active tab", () => {
    const api = useChatTabsStore.getState();
    api.openChat("a");
    api.openChat("b");
    useChatTabsStore.getState().setActive("chat:a");
    useChatTabsStore.getState().close("chat:b");
    const s = useChatTabsStore.getState();
    expect(s.tabs.map((t) => t.key)).toEqual(["chat:a"]);
    expect(s.activeKey).toBe("chat:a");
  });

  it("activeTab resolves the active tab object", () => {
    useChatTabsStore.getState().openChat("abc");
    expect(activeTab(useChatTabsStore.getState())).toEqual({
      key: "chat:abc",
      kind: "chat",
      ref: "abc",
    });
  });
});

describe("tab keys and urls", () => {
  it("maps tabs to routes", () => {
    expect(chatKey("abc")).toBe("chat:abc");
    expect(
      urlForTab({ key: "chat:abc", kind: "chat", ref: "abc" }),
    ).toBe("/chat/abc");
    expect(
      urlForTab({ key: "chat:new", kind: "chat", ref: "new" }),
    ).toBe("/chat/new");
  });

  it("nextActiveAfterClose prefers the right neighbor", () => {
    const tabs: Tab[] = [
      { key: "chat:a", kind: "chat", ref: "a" },
      { key: "chat:b", kind: "chat", ref: "b" },
      { key: "chat:c", kind: "chat", ref: "c" },
    ];
    expect(nextActiveAfterClose(tabs, "chat:b")).toBe("chat:c");
    expect(nextActiveAfterClose(tabs, "chat:c")).toBe("chat:b");
    expect(
      nextActiveAfterClose(
        [{ key: "chat:a", kind: "chat", ref: "a" }],
        "chat:a",
      ),
    ).toBeUndefined();
  });
});

describe("settings nav source of truth", () => {
  it("lists every settings section exactly once, in order", () => {
    const routes = getSettingsNav().map((item) => item.route);
    // Order follows navigation.ts (the single source of truth); this test
    // guards the membership (no missing/duplicate sections).
    expect(routes).toEqual([
      "/providers",
      "/appearance",
      "/workspace",
      "/memory",
      "/mcp",
      "/scheduler",
      "/logs",
    ]);
  });
});
