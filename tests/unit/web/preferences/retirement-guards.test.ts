import { describe, expect, it } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../../helpers/repo-root";

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("preferences retirement guards (canonical contract)", () => {
  it("removes retired shared-active/legacy-import/migration source files", () => {
    const removed = [
      "web/src/features/preferences/components/LegacyTabImportDialog.tsx",
      "web/src/features/preferences/components/PortablePrefsMigrationDialog.tsx",
      "web/src/features/preferences/components/SharedActivationIndicator.tsx",
      "web/src/features/preferences/lib/localPortablePrefs.ts",
      "web/src/features/preferences/components/PreferencesAppearanceSync.tsx",
      "web/src/features/preferences/components/PreferencesDesktopSync.tsx",
      "web/src/features/preferences/components/PreferencesNavigationSync.tsx",
      "web/src/features/preferences/components/PreferencesWelcomeSync.tsx",
    ];
    for (const rel of removed) {
      expect(existsSync(path.join(REPO_ROOT, rel))).toBe(false);
    }
  });

  it("does not expose retired preferences endpoints in routes", () => {
    const routes = read("src/routes/preferences.ts");
    expect(routes).not.toContain("/tabs/activate");
    expect(routes).not.toContain("/tabs/import-legacy");
    expect(routes).not.toContain("/tabs/mark-initialized");
    expect(routes).not.toContain("/migrate");
    expect(routes).not.toContain("activateSharedTab");
    expect(routes).not.toContain("importLegacySharedTabs");
    expect(routes).not.toContain("markSharedTabsInitialized");
    expect(routes).not.toContain("migratePortablePreferences");
  });

  it("does not keep retired shared-active/legacy symbols in core preferences/chat state", () => {
    const files = [
      "src/services/preferences/service.ts",
      "src/services/preferences/types.ts",
      "src/services/preferences/registry.ts",
      "web/src/features/preferences/state/preferencesStore.ts",
      "web/src/features/preferences/api/preferences.ts",
      "web/src/features/chat/state/chatTabs.ts",
      "web/src/app/layout/AppShell.tsx",
    ];
    for (const rel of files) {
      const src = read(rel);
      expect(src).not.toContain("sharedActiveConversationId");
      expect(src).not.toContain("requestSharedActivate");
      expect(src).not.toContain("activateSharedTab");
      expect(src).not.toContain("LEGACY_OPEN_TABS_STORAGE_KEY");
      expect(src).not.toContain("readLegacyOpenTabs");
      expect(src).not.toContain("importLegacySharedTabs");
      expect(src).not.toContain("markSharedTabsInitialized");
      expect(src).not.toContain("migratePortablePreferences");
      expect(src).not.toContain("localPortablePrefs");
    }
  });

  it("preserves OpenCode Import Chat paths (separate from Legacy Import Open Tabs)", () => {
    expect(
      existsSync(path.join(REPO_ROOT, "web/src/features/opencode/OpenCodeImportDialog.tsx")),
    ).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, "web/src/features/opencode/opencodeImportApi.ts"))).toBe(
      true,
    );
    expect(existsSync(path.join(REPO_ROOT, "src/services/opencode/import.ts"))).toBe(true);
    const opencodeRoutes = read("src/routes/opencode.ts");
    expect(opencodeRoutes).toContain('/importable"');
    expect(opencodeRoutes).toContain('/import"');
    expect(opencodeRoutes).toContain("listImportableOpenCodeSessions");
    expect(opencodeRoutes).toContain("importOpenCodeSession");
    const sidebar = read("web/src/components/Sidebar.tsx");
    expect(sidebar).toContain("OpenCodeImportDialog");
  });
});
