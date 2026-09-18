import { describe, it, expect, beforeEach } from "bun:test";
import {
  NEW_DRAFT_TAB_ID,
  agentKey,
  chatKey,
  useChatTabsStore,
} from "./chatTabs";
import { threadEngine } from "../../../adapters/remoteThreadListAdapter";

/**
 * First-send id binding (`resolveDraftId`) + row-engine read (`threadEngine`).
 *
 * The draft tab always starts as a chat tab; the row's engine decides the
 * destination: Direct rewrites the key in place, OpenCode swaps the draft
 * for an agent tab (which drives TabUrlSync to the Code surface).
 */
function resetToDraft(): void {
  useChatTabsStore.setState({
    tabs: [{ key: chatKey(NEW_DRAFT_TAB_ID), kind: "chat", ref: NEW_DRAFT_TAB_ID }],
    activeKey: chatKey(NEW_DRAFT_TAB_ID),
  });
}

describe("resolveDraftId", () => {
  beforeEach(resetToDraft);

  it("binds a Direct first send by rewriting the draft key in place", () => {
    useChatTabsStore.getState().resolveDraftId("real-1", "direct");
    const state = useChatTabsStore.getState();
    expect(state.tabs.map((t) => t.key)).toEqual([chatKey("real-1")]);
    expect(state.tabs[0]).toMatchObject({ kind: "chat", ref: "real-1" });
    expect(state.activeKey).toBe(chatKey("real-1"));
  });

  it("binds an OpenCode first send by swapping the draft for an agent tab", () => {
    useChatTabsStore.getState().resolveDraftId("real-2", "opencode");
    const state = useChatTabsStore.getState();
    expect(state.tabs.map((t) => t.key)).toEqual([agentKey("real-2")]);
    expect(state.tabs[0]).toMatchObject({ kind: "agent", ref: "real-2" });
    expect(state.activeKey).toBe(agentKey("real-2"));
  });

  it("treats unknown engine as Direct (legacy rows predate the column)", () => {
    useChatTabsStore.getState().resolveDraftId("real-3", null);
    const state = useChatTabsStore.getState();
    expect(state.tabs.map((t) => t.key)).toEqual([chatKey("real-3")]);
    expect(state.activeKey).toBe(chatKey("real-3"));
  });

  it("keeps other open tabs untouched in both branches", () => {
    useChatTabsStore.setState((s) => ({
      tabs: [...s.tabs, { key: chatKey("other"), kind: "chat", ref: "other" }],
    }));
    useChatTabsStore.getState().resolveDraftId("real-4", "opencode");
    const keys = useChatTabsStore.getState().tabs.map((t) => t.key);
    expect(keys).toContain(chatKey("other"));
    expect(keys).toContain(agentKey("real-4"));
    expect(keys).not.toContain(chatKey(NEW_DRAFT_TAB_ID));
  });
});

describe("threadEngine", () => {
  it("reads opencode from the row", () => {
    expect(threadEngine({ custom: { engine: "opencode" } })).toBe("opencode");
  });

  it("reads direct from the row", () => {
    expect(threadEngine({ custom: { engine: "direct" } })).toBe("direct");
  });

  it("defaults absent engine to direct (legacy rows)", () => {
    expect(threadEngine({ custom: {} })).toBe("direct");
    expect(threadEngine({})).toBe("direct");
  });

  it("defaults unexpected values to direct (never strand on a bad surface)", () => {
    expect(threadEngine({ custom: { engine: "warp" } })).toBe("direct");
  });
});
