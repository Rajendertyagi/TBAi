import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { REPO_ROOT } from "../../helpers/repo-root";
import path from "node:path";

const { subscribeDraftPickLifecycle } = await import(
  "@web/features/chat/state/useDraftPickLifecycle"
);
const { useSettingsStore } = await import("@web/features/providers/state/providersStore");
const { chatKey, NEW_DRAFT_TAB_ID, useChatTabsStore } = await import(
  "@web/features/chat/state/chatTabs"
);

describe("TabStrip architectural guard (Step 1A)", () => {
  let source = "";

  beforeAll(async () => {
    source = await Bun.file(path.join(REPO_ROOT, "web/src/components/TabStrip.tsx")).text();
  });

  it("does not import or call assistant-ui hooks", () => {
    expect(source).not.toContain("@assistant-ui/react");
    expect(source).not.toContain("useAuiState");
    expect(source).not.toContain("useAui");
    expect(source).not.toContain("ThreadListPrimitive");
    expect(source).not.toContain("AssistantRuntimeProvider");
  });

  it("uses TBAi threadListAdapter for conversation metadata", () => {
    expect(source).toContain("threadListAdapter");
  });
});

describe("draft one-shot pick lifecycle", () => {
  beforeEach(() => {
    useSettingsStore.getState().revertChatTarget();
    useChatTabsStore.setState({ localActiveKey: undefined });
  });

  it("discards the pick when leaving the draft for another tab", () => {
    const unsubscribe = subscribeDraftPickLifecycle();
    try {
      useChatTabsStore.setState({ localActiveKey: chatKey(NEW_DRAFT_TAB_ID) });
      useSettingsStore.getState().selectChatTarget("prov-a", "model-a");
      expect(useSettingsStore.getState().selectedProviderId).toBe("prov-a");

      useChatTabsStore.getState().selectLocal(chatKey("conv-existing"));
      expect(useSettingsStore.getState().selectedProviderId).toBeNull();
      expect(useSettingsStore.getState().selectedModelId).toBeNull();
    } finally {
      unsubscribe();
    }
  });

  it("preserves the pick when the already-active draft tab is clicked", () => {
    const unsubscribe = subscribeDraftPickLifecycle();
    try {
      useChatTabsStore.setState({ localActiveKey: chatKey(NEW_DRAFT_TAB_ID) });
      useSettingsStore.getState().selectChatTarget("prov-a", "model-a");

      // Re-selecting the same key produces no store change, so no clear.
      useChatTabsStore.getState().selectLocal(chatKey(NEW_DRAFT_TAB_ID));
      expect(useSettingsStore.getState().selectedProviderId).toBe("prov-a");
    } finally {
      unsubscribe();
    }
  });

  it("covers navigation paths that bypass the tab strip (presentChat)", () => {
    const unsubscribe = subscribeDraftPickLifecycle();
    try {
      useChatTabsStore.setState({ localActiveKey: chatKey(NEW_DRAFT_TAB_ID) });
      useSettingsStore.getState().selectChatTarget("prov-a", "model-a");

      // Sidebar / browser-history navigation goes through presentChat, not
      // TabStrip.select — the store subscription must still clear the pick.
      useChatTabsStore.getState().presentChat("conv-from-sidebar");
      expect(useSettingsStore.getState().selectedProviderId).toBeNull();
    } finally {
      unsubscribe();
    }
  });
});
