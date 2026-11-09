/**
 * Shared workspace model: legacy localStorage is migration source only.
 * The store no longer initializes from or persists shared tab authority to
 * `tbai:openTabs`, and page tabs are not supported.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { REPO_ROOT } from "../../../helpers/repo-root";
import path from "node:path";
import {
  activeTab,
  useChatTabsStore,
  visibleTabs,
  type Tab,
} from "@web/features/chat/state/chatTabs";
import { usePreferencesStore } from "@web/features/preferences/state/preferencesStore";

const CHATTABS_SRC = path.join(REPO_ROOT, "web/src/features/chat/state/chatTabs.ts");

async function readSource(): Promise<string> {
  return Bun.file(CHATTABS_SRC).text();
}

describe("shared workspace tab model", () => {
  beforeEach(() => {
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
  });

  it("does not use tbai:openTabs as shared authority or migration source", async () => {
    const src = await readSource();
    expect(src).not.toContain("LEGACY_OPEN_TABS_STORAGE_KEY");
    expect(src).not.toContain("readLegacyOpenTabs");
    expect(src).not.toContain("tbai:openTabs");
    expect(src).not.toContain('window.addEventListener("storage"');
  });

  it("visible tabs contain no page tabs", () => {
    useChatTabsStore.getState().presentChat("t1");
    for (const tab of visibleTabs(useChatTabsStore.getState())) {
      expect(tab.key).not.toMatch(/^page:/);
    }
  });

  it("activeTab returns a chat or agent tab, never a page tab", () => {
    useChatTabsStore.getState().presentChat("t1");
    expect(activeTab(useChatTabsStore.getState())?.kind).toBe("chat");
    useChatTabsStore.getState().presentAgent("a1");
    expect(activeTab(useChatTabsStore.getState())?.kind).toBe("agent");
  });

  it("Tab type exposes no 'page' kind at compile time (source guard)", async () => {
    const src = await readSource();
    expect(src).not.toContain('"page"');
    const _exhaustive: Tab["kind"] = "chat";
    expect(["chat", "agent"]).toContain(_exhaustive);
  });
});
