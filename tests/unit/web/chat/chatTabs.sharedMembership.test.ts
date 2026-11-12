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

  it("in-flight delayed add + explicit single close: explicit close is the only close op (no second auto close/retry)", async () => {
    // Scenario A (deterministic, deferred): delayed add's openSharedTab is held pending;
    // user requests explicit close while in flight; open resolves after suppression is set.
    // The delayed-add suppression branch must NOT issue a second closeSharedTab.
    let resolveOpen!: (v: any) => void;
    const openPending = new Promise<any>((r) => {
      resolveOpen = r;
    });
    let openCalls = 0;
    let closeCalls = 0;
    const base = usePreferencesStore.getState().snapshot!;
    usePreferencesStore.setState({
      openSharedTab: async () => {
        openCalls++;
        return openPending;
      },
      closeSharedTab: async () => {
        closeCalls++;
        return { ok: true, snapshot: base };
      },
      refresh: async () => base,
    } as any);

    // 1. Start delayed membership addition (will await openSharedTab).
    useChatTabsStore.getState().requestDelayedSharedOpen("c1", "chat");
    await new Promise((r) => setTimeout(r, 0));
    expect(openCalls).toBe(1);

    // 2. Request explicit single close while add is in flight (sets suppression, queues close).
    const closeP = useChatTabsStore.getState().requestSharedClose("c1");
    await closeP;
    expect(closeCalls).toBe(1); // explicit close only

    // 3. Resolve the delayed add's open — suppression branch must not issue another close.
    resolveOpen({ ...base, revision: 2, sharedTabs: [{ kind: "chat", ref: "c1" }] });
    await new Promise((r) => setTimeout(r, 20));

    expect(openCalls).toBe(1);
    expect(closeCalls).toBe(1); // no second automatic close or retry
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
      snapshot: snapWithTabs([
        { kind: "chat", ref: "a" },
        { kind: "chat", ref: "b" },
      ]),
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
        return snapWithTabs(
          [
            { kind: "chat", ref: "b" },
            { kind: "chat", ref: id },
          ],
          3,
        );
      },
      closeSharedTabsBatch: async () => ({
        ok: true,
        snapshot: snapWithTabs([{ kind: "chat", ref: "b" }], 2),
      }),
      refresh: async () => usePreferencesStore.getState().snapshot,
    } as any);

    await useChatTabsStore
      .getState()
      .requestSharedCloseBatch({ mode: "others", anchorConversationId: "b" });
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
        return snapWithTabs(
          [
            { kind: "chat", ref: "a" },
            { kind: "chat", ref: "b" },
            { kind: "chat", ref: id },
          ],
          3,
        );
      },
      closeSharedTabsBatch: async () => ({
        ok: true,
        snapshot: snapWithTabs(
          [
            { kind: "chat", ref: "a" },
            { kind: "chat", ref: "b" },
          ],
          2,
        ),
      }),
      refresh: async () => usePreferencesStore.getState().snapshot,
    } as any);

    await useChatTabsStore
      .getState()
      .requestSharedCloseBatch({ mode: "right", anchorConversationId: "b" });
    useChatTabsStore.getState().requestDelayedSharedOpen("c", "chat"); // removed (right of b)
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toEqual([]);
  });

  it("in-flight delayed add + batch close conflict/error: no individual close auto-issued, batch remains failed (Scenario B)", async () => {
    // Deterministic, deferred: hold delayed add's openSharedTab pending; request Close All;
    // batch returns conflict; resolve delayed add. Must NOT issue individual closeSharedTab.
    usePreferencesStore.setState({
      snapshot: snapWithTabs(
        [
          { kind: "chat", ref: "a" },
          { kind: "chat", ref: "b" },
        ],
        1,
      ),
    } as any);

    let resolveOpen!: (v: any) => void;
    const openPending = new Promise<any>((r) => {
      resolveOpen = r;
    });
    let openCalls = 0;
    let individualCloseCalls = 0;
    let batchCalls = 0;
    const base = usePreferencesStore.getState().snapshot!;

    usePreferencesStore.setState({
      openSharedTab: async () => {
        openCalls++;
        return openPending;
      },
      closeSharedTab: async () => {
        individualCloseCalls++;
        return { ok: true, snapshot: base };
      },
      closeSharedTabsBatch: async () => {
        batchCalls++;
        return {
          ok: false,
          reason: "conflict",
          snapshot: snapWithTabs(
            [
              { kind: "chat", ref: "a" },
              { kind: "chat", ref: "b" },
            ],
            5,
          ),
        };
      },
      refresh: async () => usePreferencesStore.getState().snapshot,
    } as any);

    // 1. Start delayed membership addition and hold it pending.
    useChatTabsStore.getState().requestDelayedSharedOpen("a", "chat");
    await new Promise((r) => setTimeout(r, 0));
    expect(openCalls).toBe(1);

    // 2. Request Close All while add is in flight (sets suppression for removed tabs).
    const batchResultP = useChatTabsStore.getState().requestSharedCloseBatch({ mode: "all" });
    await batchResultP;
    expect(batchCalls).toBe(1);
    expect(individualCloseCalls).toBe(0);

    // 3. Resolve the delayed addition — suppression branch must not auto-issue individual close.
    resolveOpen(
      snapWithTabs(
        [
          { kind: "chat", ref: "a" },
          { kind: "chat", ref: "b" },
        ],
        2,
      ),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(batchCalls).toBe(1); // batch was the explicit operation
    expect(individualCloseCalls).toBe(0); // no individual close auto-issued
    // Failed batch remains failed (no silent outcome change); local state preserved by chatTabs handler.
  });

  it("in-flight delayed add + batch close server error: no individual close auto-issued (Scenario B variant)", async () => {
    usePreferencesStore.setState({
      snapshot: snapWithTabs([{ kind: "chat", ref: "a" }], 1),
    } as any);

    let resolveOpen!: (v: any) => void;
    const openPending = new Promise<any>((r) => {
      resolveOpen = r;
    });
    let individualCloseCalls = 0;
    let batchCalls = 0;

    usePreferencesStore.setState({
      openSharedTab: async () => openPending,
      closeSharedTab: async () => {
        individualCloseCalls++;
        return { ok: true, snapshot: snapWithTabs([], 9) };
      },
      closeSharedTabsBatch: async () => {
        batchCalls++;
        return {
          ok: false,
          reason: "error",
          error: "server error",
          snapshot: snapWithTabs([{ kind: "chat", ref: "a" }], 1),
        };
      },
      refresh: async () => usePreferencesStore.getState().snapshot,
    } as any);

    useChatTabsStore.getState().requestDelayedSharedOpen("a", "chat");
    await new Promise((r) => setTimeout(r, 0));
    await useChatTabsStore.getState().requestSharedCloseBatch({ mode: "all" });
    resolveOpen(snapWithTabs([{ kind: "chat", ref: "a" }], 2));
    await new Promise((r) => setTimeout(r, 20));

    expect(batchCalls).toBe(1);
    expect(individualCloseCalls).toBe(0);
  });
});
