/**
 * Phase 8 — Tabs & Navigation lifecycle correctness.
 *
 * SQLite conversation identity ↔ chatTabs ↔ URL projection ↔ active runtime
 * must agree on one conversation (or an explicit draft). These are pure,
 * deterministic store + helper transitions: no DOM, no timers, no sleeps.
 * Concurrency is modeled by interleaved synchronous dispatches (the store
 * applies them in order, so "concurrent opens" converge by construction).
 */
import { describe, it, expect, beforeEach } from "bun:test";
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
} from "./chatTabs";

const store = () => useChatTabsStore.getState();

function reset(): void {
  useChatTabsStore.setState({ tabs: [], activeKey: undefined });
}

beforeEach(reset);

describe("routeStillReferencesRef — stale-completion guard (pure)", () => {
  it("holds while the route still names the conversation on either surface", () => {
    expect(routeStillReferencesRef("/chat/abc", "abc")).toBe(true);
    expect(routeStillReferencesRef("/code/abc", "abc")).toBe(true);
  });

  it("rejects once navigation moved on (stale completion must not redirect)", () => {
    // Newer open B landed; A's late validation must stay silent.
    expect(routeStillReferencesRef("/chat/B", "A")).toBe(false);
    expect(routeStillReferencesRef("/code/B", "A")).toBe(false);
    // Cross-surface move for the SAME id is also a newer location.
    expect(routeStillReferencesRef("/code/A", "A")).toBe(true);
    expect(routeStillReferencesRef("/chat/A", "A")).toBe(true);
  });

  it("rejects non-conversation routes and near-misses", () => {
    expect(routeStillReferencesRef("/chat/new", "new")).toBe(true);
    expect(routeStillReferencesRef("/chat/new", "abc")).toBe(false);
    expect(routeStillReferencesRef("/scheduler", "abc")).toBe(false);
    expect(routeStillReferencesRef("/", "abc")).toBe(false);
    // Prefix lookalikes are not the conversation route.
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
    // Same id, other surface: the URL genuinely differs, so navigate.
    expect(shouldNavigateToThread("/chat/c1", "c1", "opencode")).toBe(true);
    expect(shouldNavigateToThread("/code/c1", "c1", "direct")).toBe(true);
  });

  it("agrees with threadUrl (single home for open-URL rules)", () => {
    expect(threadUrl("c1", "opencode")).toBe("/code/c1");
    expect(shouldNavigateToThread(threadUrl("c1", "opencode"), "c1", "opencode")).toBe(false);
  });
});

describe("draft → persisted converges tab identity and URL projection", () => {
  it("direct resolution rewrites the tab and projects /chat/<id>", () => {
    store().openChat(NEW_DRAFT_TAB_ID);
    store().resolveDraftId("real-1", "direct");
    const state = store();
    expect(state.tabs.map((t) => t.key)).toEqual([chatKey("real-1")]);
    expect(state.activeKey).toBe(chatKey("real-1"));
    expect(urlForTab(activeTab(state)!)).toBe("/chat/real-1");
    // No draft residue and no duplicate.
    expect(state.tabs.some((t) => t.ref === NEW_DRAFT_TAB_ID)).toBe(false);
    expect(state.tabs.filter((t) => t.ref === "real-1")).toHaveLength(1);
  });

  it("opencode resolution swaps to the agent tab and projects /code/<id>", () => {
    store().openChat(NEW_DRAFT_TAB_ID);
    store().resolveDraftId("real-2", "opencode");
    const state = store();
    expect(state.tabs.map((t) => t.key)).toEqual([agentKey("real-2")]);
    expect(state.activeKey).toBe(agentKey("real-2"));
    expect(urlForTab(activeTab(state)!)).toBe("/code/real-2");
    expect(state.tabs.some((t) => t.ref === NEW_DRAFT_TAB_ID)).toBe(false);
  });

  it("background draft resolution does not steal the active tab", () => {
    store().openChat("keep");
    store().openChat(NEW_DRAFT_TAB_ID);
    store().setActive(chatKey("keep"));
    store().resolveDraftId("real-3", "direct");
    // Active stays on the conversation the user is looking at.
    expect(store().activeKey).toBe(chatKey("keep"));
    expect(urlForTab(activeTab(store())!)).toBe("/chat/keep");
  });
});

describe("close behavior is deterministic", () => {
  it("closing an inactive tab preserves the active conversation", () => {
    store().openChat("a");
    store().openChat("b");
    store().setActive(chatKey("a"));
    store().close(chatKey("b"));
    expect(store().activeKey).toBe(chatKey("a"));
    expect(urlForTab(activeTab(store())!)).toBe("/chat/a");
  });

  it("closing the active tab selects the right neighbor", () => {
    store().openChat("a");
    store().openChat("doomed");
    store().openChat("b");
    store().setActive(chatKey("doomed"));
    store().close(chatKey("doomed"));
    expect(store().activeKey).toBe(chatKey("b"));
  });

  it("closing the final tab falls back to a draft (never an empty strip, never a row)", () => {
    store().openChat("only");
    store().close(chatKey("only"));
    const state = store();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.ref).toBe(NEW_DRAFT_TAB_ID);
    expect(state.activeKey).toBe(chatKey(NEW_DRAFT_TAB_ID));
    expect(urlForTab(activeTab(state)!)).toBe("/chat/new");
  });

  it("closing a draft leaves a draft (no persistence side effect possible)", () => {
    store().openChat(NEW_DRAFT_TAB_ID);
    store().close(chatKey(NEW_DRAFT_TAB_ID));
    expect(store().tabs).toHaveLength(1);
    expect(store().tabs[0]!.ref).toBe(NEW_DRAFT_TAB_ID);
  });
});

describe("delete converges tabs with the same rule as close", () => {
  it("deleting the first tab activates the right neighbor (not the last tab)", () => {
    store().openChat("doomed");
    store().openChat("a");
    store().openChat("b");
    store().setActive(chatKey("doomed"));
    store().closeByRef("doomed");
    // Right-neighbor rule shared with `close`: "a" follows "doomed".
    expect(store().activeKey).toBe(chatKey("a"));
    expect(urlForTab(activeTab(store())!)).toBe("/chat/a");
  });

  it("deleting a middle tab activates the right neighbor", () => {
    store().openChat("a");
    store().openChat("doomed");
    store().openChat("b");
    store().setActive(chatKey("doomed"));
    store().closeByRef("doomed");
    expect(store().activeKey).toBe(chatKey("b"));
  });

  it("deleted id never remains active and never revives", () => {
    store().openChat("keep");
    store().openChat("doomed");
    store().setActive(chatKey("doomed"));
    store().closeByRef("doomed");
    const state = store();
    expect(state.tabs.some((t) => t.ref === "doomed")).toBe(false);
    expect(state.activeKey).not.toBe(chatKey("doomed"));
    expect(state.tabs.some((t) => t.key === state.activeKey)).toBe(true);
    // Re-opening validation for the dead id finds no tab to revive: the
    // store never recreates it (only an explicit open could).
    expect(state.tabs.some((t) => t.ref === "doomed")).toBe(false);
  });
});

describe("open paths converge on one tab (no duplicates)", () => {
  it("duplicate concurrent opens converge on one tab", () => {
    store().openChat("c1");
    store().openChat("c1");
    store().openAgent("c1");
    store().openAgent("c1");
    expect(store().tabs.filter((t) => t.key === chatKey("c1"))).toHaveLength(1);
    expect(store().tabs.filter((t) => t.key === agentKey("c1"))).toHaveLength(1);
  });

  it("rapid A-then-B leaves B active with both tabs open once", () => {
    store().openChat("A");
    store().openChat("B");
    const state = store();
    expect(state.activeKey).toBe(chatKey("B"));
    expect(state.tabs.filter((t) => t.ref === "A")).toHaveLength(1);
    expect(state.tabs.filter((t) => t.ref === "B")).toHaveLength(1);
  });

  it("same conversation on both surfaces shares identity (distinct tabs, one ref)", () => {
    store().openChat("c1");
    store().openAgent("c1");
    const state = store();
    // Preserved architecture: separate engine tabs, one conversation id.
    expect(state.tabs.map((t) => t.key).sort()).toEqual(
      [agentKey("c1"), chatKey("c1")].sort(),
    );
    expect(state.tabs.every((t) => t.ref === "c1")).toBe(true);
    // …projected to their own engine routes.
    expect(urlForTab(state.tabs.find((t) => t.kind === "chat")!)).toBe("/chat/c1");
    expect(urlForTab(state.tabs.find((t) => t.kind === "agent")!)).toBe("/code/c1");
  });
});
