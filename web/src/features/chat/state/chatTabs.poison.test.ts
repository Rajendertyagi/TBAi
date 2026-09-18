import { describe, it, expect, beforeEach } from "bun:test";
import {
  NEW_DRAFT_TAB_ID,
  activeTab,
  agentKey,
  chatKey,
  healTab,
  threadUrl,
  urlForTab,
  useChatTabsStore,
  type Tab,
} from "./chatTabs";

/**
 * Regression tests for the poisoned agent-tab defect: older builds created
 * Code tabs via a key factory that only understood chat:/page:, so every
 * agent:<id> key became { kind: "chat", ref: ":<id>" } — wrong kind plus a
 * colon-prefixed ref that 404-looped on /api/conversations/:<id> and stuck
 * around via persistence. Covers the fixed factory, the load-time healing,
 * and the no-colon invariant across store flows.
 *
 * Store hygiene mirrors welcomeEngine.test.ts: reset tabs/activeKey per test.
 * (The module's import-time loadPersisted ran with storage unavailable, so
 * initial state is empty — load-healing itself is covered via healTab.)
 */

const STORAGE_KEY = "tbai:openTabs";

function resetTabs() {
  useChatTabsStore.setState({ tabs: [], activeKey: undefined });
}

function currentTabs(): Tab[] {
  return useChatTabsStore.getState().tabs;
}

function noColonRefs(tabs: Tab[]): boolean {
  return tabs.every((t) => !t.ref.startsWith(":"));
}

describe("agent tabs — factory shape (poison regression)", () => {
  beforeEach(() => {
    resetTabs();
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage shim absent — store-only assertions still hold */
    }
  });

  it("openAgent creates a kind:agent tab with the bare conversation id", () => {
    useChatTabsStore.getState().openAgent("vuvg19b9ep437ry4bt4jgfvk");
    const tabs = currentTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toEqual({
      key: "agent:vuvg19b9ep437ry4bt4jgfvk",
      kind: "agent",
      ref: "vuvg19b9ep437ry4bt4jgfvk",
    });
  });

  it("activating an agent key materializes the same clean shape", () => {
    useChatTabsStore.getState().setActive(agentKey("abc123"));
    const tab = activeTab(useChatTabsStore.getState());
    expect(tab).toEqual({ key: "agent:abc123", kind: "agent", ref: "abc123" });
  });

  it("openChat still creates clean chat tabs (no regression)", () => {
    useChatTabsStore.getState().openChat("thread1");
    expect(currentTabs()[0]).toEqual({
      key: "chat:thread1",
      kind: "chat",
      ref: "thread1",
    });
  });

  it("agent tabs route to /code/<id>, never /chat/:<id>", () => {
    useChatTabsStore.getState().openAgent("vuvg19b9ep437ry4bt4jgfvk");
    const tab = activeTab(useChatTabsStore.getState());
    expect(tab).toBeDefined();
    expect(urlForTab(tab as Tab)).toBe("/code/vuvg19b9ep437ry4bt4jgfvk");
  });

  it("no tab ref ever starts with a colon across open/switch/close flows", () => {
    const s = useChatTabsStore.getState();
    s.openChat("t1");
    s.openAgent("a1");
    s.openChat(NEW_DRAFT_TAB_ID);
    s.setActive(agentKey("a1"));
    s.setActive(chatKey("t1"));
    s.close(agentKey("a1"));
    expect(noColonRefs(currentTabs())).toBe(true);
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

describe("healTab — persisted poison repair", () => {
  it("repairs a poisoned agent entry (chat kind + colon ref) by key", () => {
    expect(
      healTab({ key: "agent:abc", kind: "chat", ref: ":abc" }),
    ).toEqual({ key: "agent:abc", kind: "agent", ref: "abc" });
  });

  it("keeps well-formed chat/agent/page tabs byte-identical", () => {
    const good: Tab[] = [
      { key: "chat:t1", kind: "chat", ref: "t1" },
      { key: "agent:a1", kind: "agent", ref: "a1" },
      { key: "page:/scheduler", kind: "page", ref: "/scheduler" },
    ];
    for (const t of good) expect(healTab(t)).toEqual(t);
  });

  it("drops empty refs and bare colon refs (unrepairable)", () => {
    expect(healTab({ key: "chat:", kind: "chat", ref: "" })).toBeNull();
    expect(healTab({ key: "agent:", kind: "chat", ref: ":" })).toBeNull();
    expect(healTab({ key: "mystery", kind: "chat", ref: "mystery" })).toBeNull();
  });

  it("drops non-objects and keyless entries", () => {
    expect(healTab(null)).toBeNull();
    expect(healTab("agent:a1")).toBeNull();
    expect(healTab({ kind: "agent", ref: "a1" })).toBeNull();
  });
});
