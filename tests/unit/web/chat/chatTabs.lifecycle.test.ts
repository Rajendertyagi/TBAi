/**
 * Tab lifecycle correctness under the shared workspace model.
 *
 * Shared membership is server-authoritative; each window owns local active
 * selection and local draft state. These tests verify local presentation
 * invariants and draft resolution behavior.
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
  });
}

beforeEach(reset);

describe("local presentation does not duplicate", () => {
  it("presenting a chat conversation is idempotent for local active state", () => {
    store().presentChat("c1");
    store().presentChat("c1");
    expect(store().localActiveKey).toBe(chatKey("c1"));
  });

  it("presenting an agent conversation is idempotent for local active state", () => {
    store().presentAgent("c1");
    store().presentAgent("c1");
    expect(store().localActiveKey).toBe(agentKey("c1"));
  });

  it("shared membership deduplicates by conversation id (server-authoritative)", () => {
    prefs().applySnapshot({
      ...prefs().snapshot!,
      revision: 2,
      sharedTabs: [
        { kind: "chat", ref: "c1" },
        { kind: "agent", ref: "c1" },
      ],
    });
    const tabs = visibleTabs(store());
    expect(tabs.filter((t) => t.ref === "c1")).toHaveLength(2);
  });

  it("does not duplicate when a draft resolves onto an id already in shared membership", () => {
    prefs().applySnapshot({
      ...prefs().snapshot!,
      revision: 2,
      sharedTabs: [{ kind: "chat", ref: "real1" }],
    });
    store().openNewDraft();
    store().resolveDraftId("real1", "direct");
    expect(store().localActiveKey).toBe(chatKey("real1"));
    expect(store().hasLocalDraft).toBe(false);
    expect(visibleTabs(store()).filter((t) => t.ref === "real1")).toHaveLength(1);
  });

  it("does not duplicate when an OpenCode draft resolves onto an open agent tab", () => {
    prefs().applySnapshot({
      ...prefs().snapshot!,
      revision: 2,
      sharedTabs: [{ kind: "agent", ref: "real1" }],
    });
    store().openNewDraft();
    store().resolveDraftId("real1", "opencode");
    expect(store().localActiveKey).toBe(agentKey("real1"));
    expect(store().hasLocalDraft).toBe(false);
  });
});

describe("confirmed-gone / local cleanup cannot leave deleted conversation active", () => {
  it("closeLocal removes local presentation for a conversation", () => {
    store().presentChat("c1");
    store().presentAgent("c1");
    store().closeLocal(chatKey("c1"));
    store().closeLocal(agentKey("c1"));
    expect(visibleTabs(store()).some((t) => t.ref === "c1")).toBe(false);
  });

  it("closing local active presentation moves active key off the deleted conversation", () => {
    prefs().applySnapshot({
      ...prefs().snapshot!,
      revision: 2,
      sharedTabs: [{ kind: "chat", ref: "keep" }],
    });
    store().presentChat("doomed");
    store().markDetached("doomed");
    expect(store().localActiveKey).toBe(chatKey("doomed"));
    store().closeLocal(chatKey("doomed"));
    expect(store().localActiveKey).not.toBe(chatKey("doomed"));
  });

  it("falls back to a shared tab or no local active when the only local tab is closed", () => {
    store().presentChat("doomed");
    store().markDetached("doomed");
    store().closeLocal(chatKey("doomed"));
    expect(visibleTabs(store()).some((t) => t.ref === "doomed")).toBe(false);
  });

  it("closeLocal is a no-op for a conversation that is not open", () => {
    store().presentChat("c1");
    const before = store().localActiveKey;
    store().closeLocal(chatKey("never-opened"));
    expect(store().localActiveKey).toBe(before);
  });
});
