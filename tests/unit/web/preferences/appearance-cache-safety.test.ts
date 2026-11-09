import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../../helpers/repo-root";

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("appearance pre-paint cache safety (narrow exception)", () => {
  it("theme provider uses defaults before hydration and does not read localStorage as authority", () => {
    const src = read("web/src/components/theme-provider.tsx");
    expect(src).toContain("Defaults before hydration");
    expect(src).not.toContain("readMode(");
    expect(src).not.toContain("readThemeIds(");
    expect(src).not.toContain("writeMode(");
    expect(src).not.toContain("writeThemeId(");
    expect(src).not.toContain('localStorage.getItem("tbai-theme")');
  });

  it("typography module does not read/write localStorage as authority", () => {
    const src = read("web/src/features/appearance/typography.ts");
    expect(src).not.toContain("localStorage.getItem");
    expect(src).not.toContain("localStorage.setItem");
    expect(src).toContain("SQLite is authoritative");
    expect(src).toContain("patchPreferences");
  });

  it("usePreferencesSync writes appearance pre-paint cache only as mirror after authoritative state", () => {
    const src = read("web/src/features/preferences/state/usePreferencesSync.ts");
    expect(src).toContain("writeAppearancePrepaintCache");
    expect(src).toContain('hydration !== "ready"');
    // Logical theme is mirrored as-is (including "system"); typography default removes stale cache.
    expect(src).toContain('localStorage.setItem("tbai-theme", input.themeMode)');
    expect(src).toContain('localStorage.removeItem("tbai-typography")');
    expect(src).toContain("DEFAULT_TYPOGRAPHY");
    expect(src).toContain("applyTypographyToDom(DEFAULT_TYPOGRAPHY)");
    // Must not read cache to seed SQLite / must not treat cache as authority.
    expect(src).not.toContain("readAppearanceCache");
    expect(src).not.toContain("localStorage.getItem");
  });

  it("index.html pre-paint cache is a temporary visual hint only (no DB transfer)", () => {
    const html = read("web/index.html");
    expect(html).toContain('localStorage.getItem("tbai-theme")');
    expect(html).toContain('localStorage.getItem("tbai-typography")');
    expect(html).toContain('t === "system"');
    expect(html).toContain("prefers-color-scheme: dark");
    // No fetch/API calls that would seed SQLite from cache.
    expect(html).not.toContain("/api/preferences");
    expect(html).not.toContain("fetch(");
  });
});
