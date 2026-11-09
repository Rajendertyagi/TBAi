import { describe, it, expect, beforeEach } from "bun:test";
import { welcomeConfig, isQuickActionTabId } from "@web/config/welcome";
import { useWelcomeScopeStore } from "@web/features/chat/state/welcomeScope.ts";

describe("welcome config — no hardcoded UI values", () => {
  it("exposes copy, layout tokens, and three quick-action tabs", () => {
    expect(welcomeConfig.tabs.map((t) => t.id)).toEqual(["coding", "office", "research"]);
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

describe("welcome scope store — canonical (SQLite authoritative, soft folder refs)", () => {
  beforeEach(() => {
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

  it("preserves a missing folder ID as a soft reference (no silent substitution)", () => {
    useWelcomeScopeStore.getState().setScope({ mode: "project", folderId: "gone" });
    useWelcomeScopeStore.getState().validateAgainstFolderIds(["kept"]);
    expect(useWelcomeScopeStore.getState().scope).toEqual({
      mode: "project",
      folderId: "gone",
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

  it("does not use localStorage as authority", async () => {
    const src = await Bun.file(
      new URL("../../../../web/src/features/chat/state/welcomeScope.ts", import.meta.url),
    ).text();
    expect(src).not.toContain("tbai:welcome-scope");
    expect(src).not.toContain("localStorage");
  });
});
