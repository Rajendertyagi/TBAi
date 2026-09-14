import { describe, it, expect, beforeEach } from "bun:test";
import { welcomeConfig, isQuickActionTabId } from "@/config/welcome";
import { useWelcomeScopeStore } from "./welcomeScope";

describe("welcome config — no hardcoded UI values", () => {
  it("exposes copy, layout tokens, and three quick-action tabs", () => {
    expect(welcomeConfig.tabs.map((t) => t.id)).toEqual([
      "coding",
      "office",
      "research",
    ]);
    for (const tab of welcomeConfig.tabs) {
      expect(tab.items.length).toBeGreaterThan(0);
      for (const item of tab.items) {
        expect(item.prompt.length).toBeGreaterThan(0);
      }
    }
    expect(welcomeConfig.copy.tips.length).toBeGreaterThan(0);
    expect(isQuickActionTabId("coding")).toBe(true);
    expect(isQuickActionTabId("nope")).toBe(false);
  });
});

describe("welcome scope store — durable folder selection", () => {
  beforeEach(() => {
    try {
      window.localStorage.removeItem(welcomeConfig.storage.scopeKey);
      window.localStorage.removeItem(welcomeConfig.storage.tabKey);
    } catch {
      /* ignore */
    }
    useWelcomeScopeStore.setState({
      scope: { mode: "simple", folderId: null },
      quickActionTab: "coding",
    });
  });

  it("defaults to a disposable workspace", () => {
    expect(useWelcomeScopeStore.getState().scope).toEqual({
      mode: "simple",
      folderId: null,
    });
  });

  it("normalizes a project scope without a folder back to simple", () => {
    useWelcomeScopeStore.getState().setScope({ mode: "project", folderId: null });
    expect(useWelcomeScopeStore.getState().scope.mode).toBe("simple");
  });

  it("drops a folder that no longer exists (deleted-folder edge)", () => {
    useWelcomeScopeStore.getState().setScope({ mode: "project", folderId: "gone" });
    useWelcomeScopeStore.getState().validateAgainstFolderIds(["kept"]);
    expect(useWelcomeScopeStore.getState().scope).toEqual({
      mode: "simple",
      folderId: null,
    });
  });

  it("keeps a live folder selection", () => {
    useWelcomeScopeStore.getState().setScope({ mode: "project", folderId: "kept" });
    useWelcomeScopeStore.getState().validateAgainstFolderIds(["kept", "other"]);
    expect(useWelcomeScopeStore.getState().scope).toEqual({
      mode: "project",
      folderId: "kept",
    });
  });
});
