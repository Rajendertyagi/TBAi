/**
 * Shared workspace membership invariants (delayed add / explicit close races).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { usePreferencesStore } from "@web/features/preferences/state/preferencesStore";
import { PreferencesConflictError } from "@web/features/preferences/api/preferences";
import { useChatTabsStore } from "@web/features/chat/state/chatTabs";

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
  } as any);
}

describe("requestDelayedSharedOpen", () => {
  beforeEach(reset);

  it("does not auto-retry with fresh revision on stale 409; refreshes and records recoverable failure", async () => {
    let openCalls = 0;
    let refreshCalls = 0;
    usePreferencesStore.setState({
      openSharedTab: async () => {
        openCalls++;
        throw new PreferencesConflictError({
          error: "conflict",
          conflict: true,
          revision: 2,
          snapshot: usePreferencesStore.getState().snapshot!,
        });
      },
      refresh: async () => {
        refreshCalls++;
        return usePreferencesStore.getState().snapshot;
      },
    } as any);

    useChatTabsStore.getState().requestDelayedSharedOpen("c1", "chat");
    await new Promise((r) => setTimeout(r, 20));

    expect(openCalls).toBe(1); // MUST NOT auto-retry
    expect(refreshCalls).toBeGreaterThan(0);
    expect(useChatTabsStore.getState().membershipFailures.c1?.message).toContain(
      "Workspace changed",
    );
  });

  it("is suppressed when user explicitly closed before commit", async () => {
    let openCalls = 0;
    let closeCalls = 0;
    usePreferencesStore.setState({
      openSharedTab: async () => {
        openCalls++;
        // Simulate close happening before commit resolves in this window.
        useChatTabsStore.setState((s) => ({
          suppressedDelayedAdds: { ...s.suppressedDelayedAdds, c1: Date.now() },
        }));
        return usePreferencesStore.getState().snapshot;
      },
      closeSharedTab: async () => {
        closeCalls++;
        const snap = usePreferencesStore.getState().snapshot!;
        return { ok: true, snapshot: snap };
      },
      refresh: async () => usePreferencesStore.getState().snapshot,
    } as any);

    useChatTabsStore.getState().requestDelayedSharedOpen("c1", "chat");
    await new Promise((r) => setTimeout(r, 20));

    expect(openCalls).toBe(1);
    expect(closeCalls).toBe(1); // preserves explicit close
  });
});

describe("batch close suppresses delayed membership additions (race)", () => {
  beforeEach(reset);

  function snapWithTabs(tabs: Array<{ kind: "chat" | "agent"; ref: string }>, revision = 1) {
    const base = usePreferencesStore.getState().snapshot!;
    return { ...base, revision, sharedTabs: tabs };
  }

  it("Close All suppresses delayed add that enters after batch close", async () => {
    usePreferencesStore.setState({
      snapshot: snapWithTabs([{ kind: "chat", ref: "a" }, { kind: "chat", ref: "b" }]),
    } as any);
    let openCalls = 0;
    let batchCalls = 0;
    let releaseBatch: (() => void) | null = null;
    usePreferencesStore.setState({
      openSharedTab: async () => {
        openCalls++;
        return snapWithTabs([{ kind: "chat", ref: "a" }], 3);
      },
      closeSharedTabsBatch: async () => {
        batchCalls++;
        await new Promise<void>((r) => {
          releaseBatch = r;
        });
        return { ok: true, snapshot: snapWithTabs([], 2) };
      },
      refresh: async () => usePreferencesStore.getState().snapshot,
    } as any);

    const batchP = useChatTabsStore.getState().requestSharedCloseBatch({ mode: "all" });
    // Delayed add for a tab being removed starts while batch is in flight.
    useChatTabsStore.getState().requestDelayedSharedOpen("a", "chat");
    await new Promise((r) => setTimeout(r, 10));
    releaseBatch?.();
    await batchP;
    await new Promise((r) => setTimeout(r, 20));

    expect(batchCalls).toBe(1);
    expect(openCalls).toBe(0); // suppressed by batch close intent
  });

  it("Close Others suppresses delayed add for removed tab but not anchor", async () => {
    usePreferencesStore.setState({
      snapshot: snapWithTabs([
        { kind: "chat", ref: "a" },
        { kind: "chat", ref: "b" },
        { kind: "chat", ref: "c" },
      ]),
    } as any);
    const opened: string[] = [];
    usePreferencesStore.setState({
      openSharedTab: async (id: string) => {
        opened.push(id);
        return snapWithTabs([{ kind: "chat", ref: "b" }, { kind: "chat", ref: id }], 3);
      },
      closeSharedTabsBatch: async () => ({
        ok: true,
        snapshot: snapWithTabs([{ kind: "chat", ref: "b" }], 2),
      }),
      refresh: async () => usePreferencesStore.getState().snapshot,
    } as any);

    await useChatTabsStore.getState().requestSharedCloseBatch({ mode: "others", anchorConversationId: "b" });
    useChatTabsStore.getState().requestDelayedSharedOpen("a", "chat"); // removed
    useChatTabsStore.getState().requestDelayedSharedOpen("c", "chat"); // removed
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toEqual([]);
  });

  it("Close Right suppresses delayed add for tabs after anchor", async () => {
    usePreferencesStore.setState({
      snapshot: snapWithTabs([
        { kind: "chat", ref: "a" },
        { kind: "chat", ref: "b" },
        { kind: "chat", ref: "c" },
      ]),
    } as any);
    const opened: string[] = [];
    usePreferencesStore.setState({
      openSharedTab: async (id: string) => {
        opened.push(id);
        return snapWithTabs([{ kind: "chat", ref: "a" }, { kind: "chat", ref: "b" }, { kind: "chat", ref: id }], 3);
      },
      closeSharedTabsBatch: async () => ({
        ok: true,
        snapshot: snapWithTabs([{ kind: "chat", ref: "a" }, { kind: "chat", ref: "b" }], 2),
      }),
      refresh: async () => usePreferencesStore.getState().snapshot,
    } as any);

    await useChatTabsStore.getState().requestSharedCloseBatch({ mode: "right", anchorConversationId: "b" });
    useChatTabsStore.getState().requestDelayedSharedOpen("c", "chat"); // removed (right of b)
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toEqual([]);
  });
});
