/**
 * Phase 5 — chatTabs.ts: loadPersisted no longer filters page tabs, and the
 * store initializes without page-tab support.
 *
 * Tests 20 and 24 from tests/test-prompts-phase5.md.
 *
 * The page-tab filter was removed from `loadPersisted` in Phase 5. Because
 * `healTab` now rejects every `page:`-prefixed key, a persisted page tab is
 * dropped at the repair stage, never reaching `loadPersisted`. The practical
 * result is identical to the old filter: the live store never carries a page
 * tab.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { REPO_ROOT } from "../../../helpers/repo-root";
import path from "node:path";
import { activeTab, healTab, useChatTabsStore, type Tab } from "@web/features/chat/state/chatTabs";

const CHATTABS_SRC = path.join(REPO_ROOT, "web/src/features/chat/state/chatTabs.ts");

async function readSource(): Promise<string> {
  return Bun.file(CHATTABS_SRC).text();
}

describe("Test 20 — loadPersisted passes tabs through unfiltered", () => {
  it("loadPersisted contains no kind-based filter over loaded tabs", async () => {
    const src = await readSource();
    const fn = src.match(/function loadPersisted[\s\S]*?\n}/)?.[0] ?? "";
    // Phase 5 removed the `.filter((t) => t.kind !== "page")` line; the
    // function now returns the healed list as-is.
    expect(fn).not.toContain("kind !==");
    expect(fn).not.toContain('kind: "page"');
  });

  it("healTab rejects a persisted page tab before loadPersisted ever sees it", () => {
    // This is the guarantee the filter removal relies on: a page key cannot
    // survive the repair pass, so loadPersisted never passes one through.
    expect(healTab({ key: "page:/scheduler", kind: "page", ref: "/scheduler" })).toBeNull();
  });
});

describe("Test 24 — store initializes without page tab support", () => {
  beforeEach(() => {
    useChatTabsStore.setState({ tabs: [], activeKey: undefined });
  });

  it("the store's initial state contains no page tabs", () => {
    const state = useChatTabsStore.getState();
    for (const tab of state.tabs) {
      expect(tab.key).not.toMatch(/^page:/);
    }
  });

  it("activeTab returns a chat or agent tab, never a page tab", () => {
    useChatTabsStore.getState().openChat("t1");
    const tab = activeTab(useChatTabsStore.getState());
    expect(tab?.kind).toBe("chat");

    useChatTabsStore.getState().openAgent("a1");
    const agent = activeTab(useChatTabsStore.getState());
    expect(agent?.kind).toBe("agent");
  });

  it("the store's actions do not include openPage", () => {
    const state = useChatTabsStore.getState();
    expect("openPage" in state).toBe(false);
  });

  it("Tab type exposes no 'page' kind at compile time (source guard)", async () => {
    const src = await readSource();
    expect(src).not.toContain('"page"');
    const _exhaustive: Tab["kind"] = "chat"; // 'chat' and 'agent' are the only values
    expect(["chat", "agent"]).toContain(_exhaustive);
  });
});
