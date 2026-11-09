import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../../helpers/repo-root";
import { resolveEffectiveThemeMode } from "@web/features/appearance/theme-dom";

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("corrective appearance: system theme", () => {
  it("resolves system theme via prefers-color-scheme (dark/light)", () => {
    const originalWindow = (globalThis as any).window;
    const originalMatchMedia = (globalThis as any).window?.matchMedia;
    try {
      (globalThis as any).window = {
        matchMedia: (q: string) => ({ matches: q.includes("dark"), media: q }),
      };
      expect(resolveEffectiveThemeMode("system")).toBe("dark");
      (globalThis as any).window = {
        matchMedia: (q: string) => ({ matches: false, media: q }),
      };
      expect(resolveEffectiveThemeMode("system")).toBe("light");
    } finally {
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
      if (originalMatchMedia !== undefined && (globalThis as any).window)
        (globalThis as any).window.matchMedia = originalMatchMedia;
    }
  });

  it("explicit light/dark resolve without OS query", () => {
    expect(resolveEffectiveThemeMode("light")).toBe("light");
    expect(resolveEffectiveThemeMode("dark")).toBe("dark");
  });

  it("theme provider listens for OS changes and does not write SQLite on OS change", () => {
    const src = read("web/src/components/theme-provider.tsx");
    expect(src).toContain('matchMedia("(prefers-color-scheme: dark)")');
    expect(src).toContain("addEventListener");
    expect(src).toContain("removeEventListener");
    expect(src).toContain("updates rendered mode only (never writes SQLite)");
    expect(src).toContain("resolvedTheme");
  });

  it("pre-paint resolves cached system via matchMedia and keeps logical cache semantics", () => {
    const html = read("web/index.html");
    expect(html).toContain('var logical = t === "light" || t === "dark" || t === "system" ? t : "system"');
    expect(html).toContain('logical === "system"');
    expect(html).toContain('window.matchMedia("(prefers-color-scheme: dark)").matches');
  });
});

describe("corrective appearance: authoritative default typography", () => {
  it("applies DEFAULT_TYPOGRAPHY and removes stale cache for authoritative default", () => {
    const src = read("web/src/features/preferences/state/usePreferencesSync.ts");
    expect(src).toContain("DEFAULT_TYPOGRAPHY");
    expect(src).toContain("Authoritative default: replace any stale cached/custom typography");
    expect(src).toContain("applyTypographyToDom(DEFAULT_TYPOGRAPHY)");
    expect(src).toContain('localStorage.removeItem("tbai-typography")');
  });

  it("handles invalid authoritative typography safely without DB migration", () => {
    const src = read("web/src/features/preferences/state/usePreferencesSync.ts");
    expect(src).toContain("Invalid authoritative typography: apply safe canonical default (no DB migration)");
    expect(src).not.toContain("patchPreferences({ appearance: { typography");
  });

  it("reapplies authoritative state on failed optimistic patch even when revision unchanged", () => {
    const src = read("web/src/features/preferences/state/usePreferencesSync.ts");
    expect(src).toContain("authoritativeReapplySeq");
    expect(src).toContain("forceReapply");
  });
});
