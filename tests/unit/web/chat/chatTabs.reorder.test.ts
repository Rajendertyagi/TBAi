/**
 * Shared tab reorder (server-authoritative, CAS).
 *
 * Reorder is an explicit user action that mutates shared membership/order via
 * the preferences service. Local active state must be preserved.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { usePreferencesStore } from "@web/features/preferences/state/preferencesStore";
import {
  agentKey,
  chatKey,
  useChatTabsStore,
  visibleTabs,
} from "@web/features/chat/state/chatTabs.ts";

const store = () => useChatTabsStore.getState();
const prefs = () => usePreferencesStore.getState();

function reset(sharedTabs: Array<{ kind: "chat" | "agent"; ref: string }> = []) {
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
      sharedTabs,
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
    // Mock shared mutation to update snapshot locally (simulates committed CAS).
    reorderSharedTab: async (conversationId: string, toIndex: number) => {
      const snap = usePreferencesStore.getState().snapshot!;
      const fromIndex = snap.sharedTabs.findIndex((t) => t.ref === conversationId);
      if (fromIndex < 0) return snap;
      const sharedTabs = snap.sharedTabs.slice();
      const [moved] = sharedTabs.splice(fromIndex, 1);
      if (!moved) return snap;
      sharedTabs.splice(Math.max(0, Math.min(toIndex, sharedTabs.length)), 0, moved);
      const next = { ...snap, revision: snap.revision + 1, sharedTabs };
      usePreferencesStore.setState({ snapshot: next });
      return next;
    },
  } as any);
}

function order(): string[] {
  return (prefs().snapshot?.sharedTabs ?? []).map((t) =>
    t.kind === "agent" ? agentKey(t.ref) : chatKey(t.ref),
  );
}

describe("requestSharedReorder moves a shared tab and preserves local active state", () => {
  beforeEach(() => {
    reset([
      { kind: "chat", ref: "A" },
      { kind: "chat", ref: "B" },
      { kind: "chat", ref: "C" },
    ]);
    store().presentChat("B");
  });

  it("moves the tab at from to to, keeping every other tab's relative order", async () => {
    await store().requestSharedReorder("A", 2);
    expect(order()).toEqual([chatKey("B"), chatKey("C"), chatKey("A")]);
  });

  it("moves backwards as well as forwards", async () => {
    await store().requestSharedReorder("C", 0);
    expect(order()).toEqual([chatKey("C"), chatKey("A"), chatKey("B")]);
  });

  it("preserves local active key when the moved tab is not active", async () => {
    expect(store().localActiveKey).toBe(chatKey("B"));
    await store().requestSharedReorder("A", 2);
    expect(store().localActiveKey).toBe(chatKey("B"));
  });

  it("preserves local active key when the moved tab is active", async () => {
    await store().requestSharedReorder("B", 2);
    expect(store().localActiveKey).toBe(chatKey("B"));
    expect(order()[2]).toBe(chatKey("B"));
  });

  it("reorders across engine kinds without converting either one", async () => {
    reset([
      { kind: "chat", ref: "chat1" },
      { kind: "agent", ref: "code1" },
      { kind: "chat", ref: "chat2" },
    ]);
    await store().requestSharedReorder("chat2", 0);
    expect(prefs().snapshot?.sharedTabs).toEqual([
      { kind: "chat", ref: "chat2" },
      { kind: "chat", ref: "chat1" },
      { kind: "agent", ref: "code1" },
    ]);
  });

  it("visible tabs reflect shared order", async () => {
    await store().requestSharedReorder("A", 2);
    expect(visibleTabs(store()).map((t) => t.ref)).toEqual(["B", "C", "A"]);
  });
});
