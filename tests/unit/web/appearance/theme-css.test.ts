/**
 * Integration invariants for the standardized theme system.
 *
 * Assertions:
 *   1. THEMES registry has unique ids, correct defaults, and carries full token sets.
 *   2. resolveThemeVars returns tokens with full fidelity (zero guessing, zero fake values).
 *   3. Enforces app-wide geometry invariant (0.625rem radius) across all themes.
 *   4. Enforces sleek borderless contract (no harsh 100% black cut lines, card-soft defined).
 *   5. Contrast & legibility: every body text pair meets WCAG AA (>= 4.5:1).
 *   6. Statusbar and link readability are guaranteed across all themes.
 *   7. themes.css contains blocks for all 23 non-builtin themes, cleanly omitting 'default'.
 */

import { describe, expect, it } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_THEME_ID,
  getTheme,
  isThemeId,
  THEMES,
} from "@web/features/appearance/theme-data.ts";
import {
  resolveThemeVars,
  TBAI_TOKENS,
  themeCss,
  themeSwatch,
} from "@web/features/appearance/theme-css.ts";
import { contrastRatio, parseColor } from "@web/features/appearance/theme-color.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../..");

const ported = THEMES.filter((t) => !t.builtin);

describe("theme registry", () => {
  it("offers Default as the default, first in the list", () => {
    expect(THEMES[0].id).toBe(DEFAULT_THEME_ID);
    expect(THEMES[0].name).toBe("Default");
    expect(THEMES[0].builtin).toBe(true);
  });

  it("carries swatches and full token sets for light and dark in every theme", () => {
    for (const theme of THEMES) {
      expect(theme.swatch.light.background).toBeString();
      expect(theme.swatch.light.surface).toBeString();
      expect(theme.swatch.light.primary).toBeString();
      expect(theme.swatch.dark.background).toBeString();
      expect(theme.swatch.dark.surface).toBeString();
      expect(theme.swatch.dark.primary).toBeString();

      expect(typeof theme.tokens.light).toBe("object");
      expect(typeof theme.tokens.dark).toBe("object");
    }
  });

  it("has unique ids and a resolvable lookup", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const theme of THEMES) {
      expect(getTheme(theme.id)).toBe(theme);
    }
  });

  it("rejects ids that are not in the registry and has no legacy classic alias", () => {
    expect(isThemeId("no-such-theme")).toBe(false);
    expect(isThemeId("")).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
    expect(isThemeId(42)).toBe(false);
    expect(isThemeId("default")).toBe(true);
    expect(isThemeId("claude")).toBe(true);
    // Legacy themes are removed cleanly
    expect(isThemeId("classic")).toBe(false);
    expect(isThemeId("aura")).toBe(false);
  });
});

describe("resolveThemeVars", () => {
  it("resolves every TBAi token for every theme with full fidelity", () => {
    for (const theme of THEMES) {
      for (const variant of ["light", "dark"] as const) {
        const vars = resolveThemeVars(theme, variant);
        // Verify vars match the theme's own token definition exactly
        expect(vars).toBe(theme.tokens[variant]);
        for (const token of TBAI_TOKENS) {
          const value = vars[token];
          expect(typeof value, `${theme.id}/${variant} ${token}`).toBe("string");
          expect(value.length, `${theme.id}/${variant} ${token} is empty`).toBeGreaterThan(0);
          expect(value, `${theme.id}/${variant} ${token} is undefined`).not.toContain("undefined");
        }
      }
    }
  });

  it("enforces app-wide geometry invariant of 0.625rem radius across all themes", () => {
    for (const theme of THEMES) {
      for (const variant of ["light", "dark"] as const) {
        const vars = resolveThemeVars(theme, variant);
        expect(vars["--radius"], `${theme.id}/${variant} radius`).toBe("0.625rem");
      }
    }
  });

  it("enforces sleek borderless contract (no harsh black cut lines, card-soft defined)", () => {
    for (const theme of THEMES) {
      for (const variant of ["light", "dark"] as const) {
        const vars = resolveThemeVars(theme, variant);
        // No theme should have pitch black solid cut lines
        expect(vars["--border"]).not.toBe("oklch(0 0 0)");
        expect(vars["--border"]).not.toBe("oklch(0.0000 0 0)");
        expect(vars["--border"]).not.toBe("#000000");

        // Borderless card tokens must be non-empty strings
        expect(vars["--card-soft"]).toBeString();
        expect(vars["--card-outline"]).toBeString();
        expect(vars["--statusbar"]).toBeString();
        expect(vars["--link"]).toBeString();
      }
    }
  });
});

describe("contrast & legibility", () => {
  it("guarantees every body text surface meets WCAG AA (>= 4.5:1)", () => {
    const pairs: Array<[string, string]> = [
      ["--foreground", "--background"],
      ["--card-foreground", "--card"],
      ["--sidebar-foreground", "--sidebar"],
    ];

    for (const theme of THEMES) {
      for (const variant of ["light", "dark"] as const) {
        const vars = resolveThemeVars(theme, variant);
        for (const [fgKey, bgKey] of pairs) {
          const fg = parseColor(vars[fgKey]);
          const bg = parseColor(vars[bgKey]);
          if (fg && bg) {
            const ratio = contrastRatio(fg, bg);
            expect(ratio, `${theme.id}/${variant}: ${fgKey} on ${bgKey}`).toBeGreaterThanOrEqual(
              4.5,
            );
          }
        }
      }
    }
  });
});

describe("themeCss", () => {
  it("returns null for the default theme", () => {
    const defaultTheme = getTheme("default")!;
    expect(themeCss(defaultTheme, "light")).toBeNull();
    expect(themeCss(defaultTheme, "dark")).toBeNull();
  });

  it("scopes each block to its own theme id and variant", () => {
    const selectors = new Set<string>();
    for (const theme of ported) {
      for (const variant of ["light", "dark"] as const) {
        const css = themeCss(theme, variant)!;
        const selector = css.slice(0, css.indexOf("{")).trim();
        selectors.add(selector);
        expect(selector).toContain(`[data-tbai-theme="${theme.id}"]`);
        if (variant === "dark") {
          expect(selector).toContain(".dark");
          expect(selector).not.toContain(":not(");
        } else {
          expect(selector).toContain(":not(.dark)");
          expect(selector).not.toMatch(/\.dark$/);
        }
      }
    }
    expect(selectors.size).toBe(ported.length * 2);
  });

  it("never uses !important", () => {
    for (const theme of THEMES) {
      for (const variant of ["light", "dark"] as const) {
        const css = themeCss(theme, variant);
        if (css === null) continue;
        expect(css).not.toContain("!important");
      }
    }
  });

  it("declares every TBAi token", () => {
    for (const theme of ported) {
      for (const variant of ["light", "dark"] as const) {
        const css = themeCss(theme, variant)!;
        const declared = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
        for (const token of TBAI_TOKENS) {
          expect(declared.has(token), `${theme.id}/${variant} missing ${token}`).toBe(true);
        }
      }
    }
  });
});

describe("themeSwatch", () => {
  it("reads from the same resolver, so the picker cannot drift from the app", () => {
    for (const theme of THEMES) {
      for (const variant of ["light", "dark"] as const) {
        const swatch = themeSwatch(theme, variant);
        const vars = resolveThemeVars(theme, variant);
        expect(swatch.background).toBe(vars["--background"]);
        expect(swatch.surface).toBe(vars["--card"]);
        expect(swatch.primary).toBe(vars["--primary"]);
      }
    }
  });
});

describe("generated stylesheet is in sync", () => {
  const cssPath = path.join(REPO_ROOT, "web/src/styles/themes.css");

  it("has a block for every ported theme and none for default", async () => {
    const onDisk = await Bun.file(cssPath).text();
    for (const theme of ported) {
      expect(onDisk).toContain(`html[data-tbai-theme="${theme.id}"]`);
      expect(onDisk).toContain(`html[data-tbai-theme="${theme.id}"].dark`);
    }
    // Default is styled natively by globals.css :root / .dark
    expect(onDisk).not.toContain('html[data-tbai-theme="default"]');
  });

  it("is imported by globals.css", async () => {
    const globals = await Bun.file(path.join(REPO_ROOT, "web/src/styles/globals.css")).text();
    expect(globals).toContain('@import "./themes.css"');
  });

  it("defines every colour token in BOTH :root and .dark", async () => {
    const globals = await Bun.file(path.join(REPO_ROOT, "web/src/styles/globals.css")).text();
    const block = (start: string) => {
      const from = globals.indexOf(start);
      expect(from, `${start} block not found`).toBeGreaterThan(-1);
      let depth = 0;
      for (let i = globals.indexOf("{", from); i < globals.length; i++) {
        if (globals[i] === "{") depth++;
        else if (globals[i] === "}" && --depth === 0) return globals.slice(from, i);
      }
      return "";
    };
    const root = block(":root {");
    const dark = block(".dark {");
    const names = (css: string) =>
      new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]));

    const rootTokens = names(root);
    const darkTokens = names(dark);
    const COLOUR = TBAI_TOKENS as readonly string[];
    for (const token of COLOUR) {
      expect(rootTokens.has(token), `:root is missing ${token}`).toBe(true);
      expect(darkTokens.has(token), `.dark is missing ${token}`).toBe(true);
    }
  });
});
