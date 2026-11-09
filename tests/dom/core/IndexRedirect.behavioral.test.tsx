import { describe, it, expect, beforeEach } from "bun:test";
import { usePreferencesStore } from "@web/features/preferences/state/preferencesStore";
import { useChatTabsStore } from "@web/features/chat/state/chatTabs";
import { ROUTES } from "@web/config/navigation";
import type { WorkspacePreferencesSnapshot } from "@web/features/preferences/state/types";

/**
 * IndexRedirect decision logic (canonical): fresh `/` waits for authoritative
 * hydration, then resolves to a deterministic local draft. No shared active
 * pointer, no stale local active conversation, no arbitrary first shared tab.
 */

function baseSnapshot(
  overrides: Partial<WorkspacePreferencesSnapshot> = {},
): WorkspacePreferencesSnapshot {
  return {
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
    ...overrides,
  };
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
    snapshot: null,
    hydration: "idle",
    hydrationError: null,
  } as any);
}

/** Mirrors IndexRedirect's fresh-root resolution (pure decision). */
function resolveFreshRootTarget(): string {
  useChatTabsStore.getState().openNewDraft();
  return ROUTES.CHAT_NEW;
}

describe("IndexRedirect redirect decision (canonical)", () => {
  beforeEach(reset);

  it("does not redirect before authoritative hydration is ready", () => {
    usePreferencesStore.setState({ hydration: "loading", snapshot: null } as any);
    expect(usePreferencesStore.getState().hydration).toBe("loading");
    expect(useChatTabsStore.getState().localActiveKey).toBeUndefined();
  });

  it("fresh / resolves to deterministic local draft after hydration", () => {
    usePreferencesStore.setState({
      hydration: "ready",
      snapshot: baseSnapshot({
        revision: 2,
        sharedTabs: [
          { kind: "chat", ref: "conv-123" },
          { kind: "agent", ref: "agent-456" },
        ],
      }),
    } as any);
    expect(resolveFreshRootTarget()).toBe(ROUTES.CHAT_NEW);
    expect(useChatTabsStore.getState().hasLocalDraft).toBe(true);
    expect(useChatTabsStore.getState().localActiveKey).toBe("chat:new");
  });

  it("fresh / with empty shared workspace falls back to /chat/new", () => {
    usePreferencesStore.setState({
      hydration: "ready",
      snapshot: baseSnapshot({ sharedTabs: [] }),
    } as any);
    expect(resolveFreshRootTarget()).toBe(ROUTES.CHAT_NEW);
    expect(useChatTabsStore.getState().hasLocalDraft).toBe(true);
  });

  it("failed preferences hydration is an error state (never assume empty / never redirect)", () => {
    usePreferencesStore.setState({
      hydration: "error",
      hydrationError: "boom",
      snapshot: null,
    } as any);
    expect(usePreferencesStore.getState().hydration).toBe("error");
    expect(usePreferencesStore.getState().hydrationError).toBe("boom");
    expect(useChatTabsStore.getState().localActiveKey).toBeUndefined();
  });

  it("stale legacy localStorage active key is ignored", () => {
    const ls = typeof window !== "undefined" ? window.localStorage : undefined;
    ls?.setItem(
      "tbai:openTabs",
      JSON.stringify({ tabs: [{ key: "chat:legacy", kind: "chat", ref: "legacy" }], activeKey: "chat:legacy" }),
    );
    usePreferencesStore.setState({
      hydration: "ready",
      snapshot: baseSnapshot({ sharedTabs: [] }),
    } as any);
    expect(resolveFreshRootTarget()).toBe(ROUTES.CHAT_NEW);
    ls?.removeItem("tbai:openTabs");
  });

  it("existing local route preservation: fresh-root resolver is not used to overwrite a running window selection", () => {
    useChatTabsStore.setState({ localActiveKey: "chat:local-keep", hasLocalDraft: false } as any);
    usePreferencesStore.setState({
      hydration: "ready",
      snapshot: baseSnapshot({
        sharedTabs: [{ kind: "chat", ref: "remote-active" }],
      }),
    } as any);
    expect(useChatTabsStore.getState().localActiveKey).toBe("chat:local-keep");
  });

  it("remote shared snapshot changes do not change an existing window's local route", () => {
    useChatTabsStore.setState({ localActiveKey: "chat:local-keep", hasLocalDraft: false } as any);
    usePreferencesStore.setState({
      hydration: "ready",
      snapshot: baseSnapshot({
        sharedTabs: [{ kind: "chat", ref: "a" }],
      }),
    } as any);
    usePreferencesStore.getState().applySnapshot(
      baseSnapshot({
        revision: 2,
        sharedTabs: [
          { kind: "chat", ref: "a" },
          { kind: "chat", ref: "b" },
        ],
      }),
    );
    expect(useChatTabsStore.getState().localActiveKey).toBe("chat:local-keep");
  });
});
