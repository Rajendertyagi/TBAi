import { describe, it, expect, beforeEach } from "bun:test";
import { usePreferencesStore } from "@web/features/preferences/state/preferencesStore";
import { useChatTabsStore, chatKey } from "@web/features/chat/state/chatTabs";

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
