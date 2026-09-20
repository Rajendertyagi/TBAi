/**
 * Tab lifecycle correctness: the rules that keep SQLite, chatTabs, the active
 * conversation and the URL converged on ONE conversation.
 *
 * These are pure store operations (no DOM, no React), which is what makes them
 * deterministic: the store is the single owner of open-tab layout, and every
 * conversation-level invariant here is decided inside it.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  NEW_DRAFT_TAB_ID,
  agentKey,
  chatKey,
  useChatTabsStore,
} from "./chatTabs";

const store = () => useChatTabsStore.getState();

beforeEach(() => {
  // The store is a module singleton: start every case from an empty strip so a
  // previous case can never masquerade as state under test.
  useChatTabsStore.setState({ tabs: [], activeKey: undefined });
});

describe("opening one conversation never duplicates a tab", () => {
  it("is idempotent for a chat tab", () => {
    store().openChat("c1");
    store().openChat("c1");
    store().openChat("c1");
    const tabs = store().tabs.filter((t) => t.key === chatKey("c1"));
    expect(tabs).toHaveLength(1);
    expect(store().activeKey).toBe(chatKey("c1"));
  });

  it("is idempotent for an agent tab", () => {
    store().openAgent("c1");
    store().openAgent("c1");
    expect(store().tabs.filter((t) => t.key === agentKey("c1"))).toHaveLength(1);
  });

  it("keeps the two engine surfaces as separate tabs (by design)", () => {
    store().openChat("c1");
    store().openAgent("c1");
    // Both surfaces may be open for one conversation; they are distinct tabs
    // and the wrong-kind one is closed by the surface reconciliation, not here.
    expect(store().tabs.map((t) => t.key).sort()).toEqual([agentKey("c1"), chatKey("c1")].sort());
  });

  it("does not duplicate when a draft resolves onto an id that is already open", () => {
    store().openChat("real1");
    store().openChat(NEW_DRAFT_TAB_ID);
    store().resolveDraftId("real1", "direct");
    const chatTabs = store().tabs.filter((t) => t.ref === "real1");
    expect(chatTabs).toHaveLength(1);
    expect(store().activeKey).toBe(chatKey("real1"));
  });

  it("does not duplicate when an OpenCode draft resolves onto an open agent tab", () => {
    store().openAgent("real1");
    store().openChat(NEW_DRAFT_TAB_ID);
    store().resolveDraftId("real1", "opencode");
    expect(store().tabs.filter((t) => t.key === agentKey("real1"))).toHaveLength(1);
    // The draft is consumed either way.
    expect(store().tabs.some((t) => t.ref === NEW_DRAFT_TAB_ID)).toBe(false);
  });
});

describe("closing a deleted conversation cannot leave it active", () => {
  it("closes both engine surfaces bound to one conversation", () => {
    store().openChat("c1");
    store().openAgent("c1");
    store().closeByRef("c1");
    expect(store().tabs.some((t) => t.ref === "c1")).toBe(false);
  });

  it("moves the active key off the deleted conversation", () => {
    store().openChat("keep");
    store().openChat("doomed");
    store().setActive(chatKey("doomed"));
    expect(store().activeKey).toBe(chatKey("doomed"));

    store().closeByRef("doomed");
    expect(store().tabs.some((t) => t.ref === "doomed")).toBe(false);
    // The active key now points at a tab that actually exists — never the
    // deleted id, which would leave the URL pointing at a nonexistent row.
    expect(store().activeKey).toBe(chatKey("keep"));
    expect(store().tabs.some((t) => t.key === store().activeKey)).toBe(true);
  });

  it("falls back to a fresh draft when the deleted conversation was the only tab", () => {
    store().openChat("doomed");
    store().closeByRef("doomed");
    expect(store().tabs).toHaveLength(1);
    expect(store().tabs[0].ref).toBe(NEW_DRAFT_TAB_ID);
    expect(store().activeKey).toBe(chatKey(NEW_DRAFT_TAB_ID));
    // Nothing references the deleted conversation any more.
    expect(store().tabs.some((t) => t.ref === "doomed")).toBe(false);
  });

  it("is a no-op for a conversation that is not open", () => {
    store().openChat("c1");
    const before = store().tabs.map((t) => t.key);
    store().closeByRef("never-opened");
    expect(store().tabs.map((t) => t.key)).toEqual(before);
    expect(store().activeKey).toBe(chatKey("c1"));
  });

  it("never leaves the strip empty (a closer cannot strand the workbench)", () => {
    store().closeByRef("anything");
    expect(store().tabs).toHaveLength(1);
    expect(store().tabs[0].ref).toBe(NEW_DRAFT_TAB_ID);
  });
});
