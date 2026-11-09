import { describe, it, expect, beforeEach } from "bun:test";
import { usePreferencesStore } from "@web/features/preferences/state/preferencesStore";
import { useChatTabsStore, chatKey } from "@web/features/chat/state/chatTabs";

const originalCloseSharedTab = usePreferencesStore.getState().closeSharedTab;
const originalCloseSharedTabsBatch = usePreferencesStore.getState().closeSharedTabsBatch;
const originalWaitForHydratedSnapshot = usePreferencesStore.getState().waitForHydratedSnapshot;

function snap(sharedTabs: Array<{ kind: "chat" | "agent"; ref: string }>, revision = 2) {
  return {
    revision,
    sharedTabs,
    preferences: {
      appearance: { themeMode: "system", lightTheme: "default", darkTheme: "default", typography: "default" },
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
      welcome: { engine: "direct", quickActionTab: "coding", scopeMode: "simple", folderId: null },
      navigation: { selectedFolderId: null, folderExpanded: {} },
    },
  } as any;
}

function reset() {
  useChatTabsStore.setState({
    localActiveKey: undefined,
    hasLocalDraft: false,
    detachedRefs: {},
    membershipFailures: {},
    suppressedDelayedAdds: {},
  });
  usePreferencesStore.setState({
    snapshot: snap([{ kind: "chat", ref: "a" }, { kind: "chat", ref: "b" }], 1),
    hydration: "ready",
    hydrationError: null,
    mutationQueue: Promise.resolve(),
    closeSharedTab: originalCloseSharedTab,
    closeSharedTabsBatch: originalCloseSharedTabsBatch,
    waitForHydratedSnapshot: originalWaitForHydratedSnapshot,
  } as any);
}

describe("requestSharedClose result semantics", () => {
  beforeEach(reset);

  it("navigates locally only on confirmed success with conversation absent from resulting snapshot", async () => {
    useChatTabsStore.setState({ localActiveKey: chatKey("a") });
    usePreferencesStore.setState({
      closeSharedTab: async () => ({ ok: true, snapshot: snap([{ kind: "chat", ref: "b" }]) }),
    } as any);
    await useChatTabsStore.getState().requestSharedClose("a");
    expect(useChatTabsStore.getState().localActiveKey).toBe(chatKey("b"));
  });

  it("stale 409 conflict preserves local route/active conversation (no false navigation)", async () => {
    useChatTabsStore.setState({ localActiveKey: chatKey("a") });
    usePreferencesStore.setState({
      closeSharedTab: async () => ({
        ok: false,
        reason: "conflict",
        snapshot: snap([{ kind: "chat", ref: "a" }, { kind: "chat", ref: "b" }], 5),
      }),
    } as any);
    await useChatTabsStore.getState().requestSharedClose("a");
    expect(useChatTabsStore.getState().localActiveKey).toBe(chatKey("a"));
  });

  it("network/5xx error preserves local route/active conversation", async () => {
    useChatTabsStore.setState({ localActiveKey: chatKey("a") });
    usePreferencesStore.setState({
      closeSharedTab: async () => ({
        ok: false,
        reason: "error",
        error: "server error",
        snapshot: snap([{ kind: "chat", ref: "a" }, { kind: "chat", ref: "b" }], 1),
      }),
    } as any);
    await useChatTabsStore.getState().requestSharedClose("a");
    expect(useChatTabsStore.getState().localActiveKey).toBe(chatKey("a"));
  });

  it("successful idempotent close (already absent) does not falsely navigate when not active target context requires absence", async () => {
    useChatTabsStore.setState({ localActiveKey: chatKey("b") });
    usePreferencesStore.setState({
      closeSharedTab: async () => ({ ok: true, snapshot: snap([{ kind: "chat", ref: "b" }]) }),
    } as any);
    await useChatTabsStore.getState().requestSharedClose("a");
    expect(useChatTabsStore.getState().localActiveKey).toBe(chatKey("b"));
  });
});

describe("requestSharedCloseBatch result semantics", () => {
  beforeEach(reset);

  it("conflict preserves local route/active conversation", async () => {
    useChatTabsStore.setState({ localActiveKey: chatKey("a") });
    usePreferencesStore.setState({
      closeSharedTabsBatch: async () => ({
        ok: false,
        reason: "conflict",
        snapshot: snap([{ kind: "chat", ref: "a" }, { kind: "chat", ref: "b" }], 5),
      }),
    } as any);
    await useChatTabsStore.getState().requestSharedCloseBatch({ mode: "all" });
    expect(useChatTabsStore.getState().localActiveKey).toBe(chatKey("a"));
  });
});

describe("close methods return explicit error on hydration failure (no unhandled rejection)", () => {
  beforeEach(reset);

  it("closeSharedTab returns error result when hydration failed", async () => {
    // Fix C: hydration wait is inside close error handling; returns explicit failure (no throw/navigation).
    usePreferencesStore.setState({
      waitForHydratedSnapshot: async () => {
        throw new Error("prefs unavailable");
      },
      mutationQueue: Promise.resolve(),
    } as any);
    const result = await usePreferencesStore.getState().closeSharedTab("a");
    expect(result.ok).toBe(false);
    if (result.ok === false && result.reason === "error") {
      expect(result.error).toContain("prefs unavailable");
    }
  });

  it("closeSharedTabsBatch returns error result when hydration failed", async () => {
    usePreferencesStore.setState({
      waitForHydratedSnapshot: async () => {
        throw new Error("prefs unavailable");
      },
      mutationQueue: Promise.resolve(),
    } as any);
    const result = await usePreferencesStore.getState().closeSharedTabsBatch({ mode: "all" });
    expect(result.ok).toBe(false);
    if (result.ok === false && result.reason === "error") {
      expect(result.error).toContain("prefs unavailable");
    }
  });

  it("chatTabs requestSharedClose handles hydration-failure error result without navigation", async () => {
    useChatTabsStore.setState({ localActiveKey: chatKey("a") });
    usePreferencesStore.setState({
      closeSharedTab: async () => ({
        ok: false,
        reason: "error",
        error: "prefs unavailable",
        snapshot: undefined,
      }),
    } as any);
    await useChatTabsStore.getState().requestSharedClose("a");
    expect(useChatTabsStore.getState().localActiveKey).toBe(chatKey("a"));
  });
});
