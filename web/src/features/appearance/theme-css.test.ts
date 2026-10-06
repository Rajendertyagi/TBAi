import { describe, expect, it } from "bun:test";

import { contrastRatio, formatColor, parseColor } from "./theme-color";
import { DEFAULT_THEME_ID, getTheme, isThemeId, THEMES } from "./theme-data";
import { resolveThemeVars, themeCss, themeSwatch } from "./theme-css";

/**
 * The palette -> token mapping, checked against all 20 palettes.
 *
 * WHY THESE CASES EXIST. Every colour the app renders comes from here, and the
 * palettes are third-party data that is deliberately incomplete. Nothing about a
 * missing field is a type error, and nothing about a bad colour is a crash — a
 * theme that resolves `undefined` into a token, or that puts light text on a
 * light surface, fails silently and looks broken rather than erroring. So these
 * tests assert the two things a compiler cannot: that every token resolves for
 * every palette, and that the resolved pairs are actually legible.
 *
 * The contrast thresholds are the WCAG ones, relaxed only where WCAG relaxes
 * them: 4.5 for body text, 3.0 for large text and UI boundaries, which is what
 * status colours and `primary` are used for in this UI.
 */

/** Every colour token `globals.css` declares. A missing one is a rendering gap. */
const TBAI_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--link",
  "--link-hover",
  "--success",
  "--success-foreground",
  "--warning",
  "--warning-foreground",
  "--border",
  "--input",
  "--ring",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-ring",
  "--statusbar",
  "--card-soft",
  "--card-outline",
] as const;

/** Token pairs whose contrast is a legibility requirement, with their threshold. */
const CONTRAST_PAIRS: Array<[string, string, number]> = [
  ["--foreground", "--background", 4.5],
  ["--card-foreground", "--card", 4.5],
  ["--popover-foreground", "--popover", 4.5],
  ["--primary-foreground", "--primary", 3],
  ["--accent-foreground", "--accent", 4.5],
  ["--muted-foreground", "--background", 4.5],
  ["--muted-foreground", "--card", 4.5],
  ["--muted-foreground", "--muted", 4.5],
  ["--destructive-foreground", "--destructive", 3],
  ["--success-foreground", "--success", 3],
  ["--warning-foreground", "--warning", 3],
  ["--sidebar-foreground", "--sidebar", 4.5],
  ["--sidebar-accent-foreground", "--sidebar-accent", 4.5],
  ["--link", "--background", 4.5],
  ["--link", "--card", 4.5],
  ["--link-hover", "--background", 4.5],
  // Destructive is dual-use: a button fill AND menu-row text. The text use was
  // measured at 2.88:1 before destructive was held to the body-text threshold.
  ["--destructive", "--background", 4.5],
  ["--destructive", "--popover", 4.5],
  // Warning and success are the same story (1.68:1 and 2.10:1 as text).
  ["--warning", "--background", 4.5],
  ["--warning", "--popover", 4.5],
  ["--success", "--background", 4.5],
  ["--success", "--popover", 4.5],
];

/**
 * Fill-vs-behind separation: a fill that matches what is behind it is invisible,
 * which no text-contrast check can catch because there is no text involved.
 *
 * These minimums exist because the first pass shipped `--accent` at 1.01:1 against
 * a menu panel and `--muted` at 1.05:1 against the page — hovered and selected
 * rows gave no feedback, and inline code and table headers vanished. They were
 * found by `scripts/theme-audit.mjs` against a rendered page, not by reasoning
 * about the token values, which is why they are asserted here explicitly.
 */
const SURFACE_SEPARATION: Array<[string, string, number]> = [
  ["--accent", "--popover", 1.12],
  ["--accent", "--background", 1.12],
  ["--muted", "--background", 1.1],
  ["--muted", "--card", 1.1],
  ["--sidebar", "--background", 1.1],
  ["--statusbar", "--background", 1.1],
  // NOTE: `--card` and `--popover` are deliberately NOT listed. A floating surface
  // matching the page is correct here: Phase A made every elevated surface
  // borderless and carries the edge with a shadow plus a glass tint instead, so
  // demanding a fill difference would fight the thing Phase A was for. OpenChamber
  // sets several palettes' `elevated` equal to their `background` for the same
  // reason. The sidebar and status bar ARE required to differ, because nothing
  // else marks where a region ends.
];

const ported = THEMES.filter((theme) => !theme.builtin);

function ratioOf(a: string, b: string): number | null {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return null;
  return contrastRatio(ca, cb);
}

describe("theme registry", () => {
  it("offers Classic as the default, first in the list", () => {
    expect(DEFAULT_THEME_ID).toBe("classic");
    expect(THEMES[0]?.id).toBe("classic");
    expect(THEMES[0]?.builtin).toBe(true);
  });

  it("carries both variants for every ported theme", () => {
    // A family missing a variant would silently fall back to the stylesheet's
    // colours while the picker still showed a swatch for it.
    for (const theme of ported) {
      expect(theme.light, `${theme.id} light`).toBeDefined();
      expect(theme.dark, `${theme.id} dark`).toBeDefined();
    }
  });

  it("has unique ids and a resolvable lookup", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(isThemeId(id)).toBe(true);
      expect(getTheme(id)?.id).toBe(id);
    }
  });

  it("rejects ids that are not in the registry", () => {
    expect(isThemeId("no-such-theme")).toBe(false);
    expect(isThemeId("")).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
    expect(isThemeId(42)).toBe(false);
    // Classic is by far the most likely thing to be stored by an older build or a
    // hand-edited key, so it must never be treated as an unknown id.
    expect(isThemeId("classic")).toBe(true);
  });
});

describe("resolveThemeVars", () => {
  it("resolves every TBAi token for every palette", () => {
    for (const theme of THEMES) {
      for (const variant of ["light", "dark"] as const) {
        const vars = resolveThemeVars(theme, variant);
        for (const token of TBAI_TOKENS) {
          const value = vars[token];
          expect(typeof value, `${theme.id}/${variant} ${token}`).toBe("string");
          expect(value.length, `${theme.id}/${variant} ${token} is empty`).toBeGreaterThan(0);
          expect(value, `${theme.id}/${variant} ${token} is undefined`).not.toContain("undefined");
        }
        // Shape tokens must NOT come from a palette: radius, glass and elevation
        // are theme-independent by design, so a theme setting them would silently
        // undo the Phase A surface work.
        expect(vars["--radius"]).toBeUndefined();
        expect(vars["--glass-blur"]).toBeUndefined();
        expect(vars["--elevation-floating"]).toBeUndefined();
      }
    }
  });

  it("keeps foreground/background pairs legible in every palette", () => {
    const failures: string[] = [];
    for (const theme of THEMES) {
      for (const variant of ["light", "dark"] as const) {
        const vars = resolveThemeVars(theme, variant);
        for (const [fg, bg, min] of CONTRAST_PAIRS) {
          const ratio = ratioOf(vars[fg], vars[bg]);
          // A null ratio means an unparseable colour (an oklch value from the
          // built-in Classic palette). Those are the stylesheet's own values and
          // are verified by eye, not here.
          if (ratio === null) continue;
          // Classic keeps its own thresholds: it is the pre-existing look, and
          // these minimums describe what a derived palette must achieve.
          const limit = theme.builtin && min >= 4.5 ? 3 : min;
          if (ratio < limit) {
            failures.push(
              `${theme.id}/${variant} ${fg} on ${bg} = ${ratio.toFixed(2)} (needs ${limit})`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps every fill visibly distinct from what sits behind it", () => {
    // Ported palettes only. Classic is TBAi's own look: its values live in
    // `globals.css` and generate no CSS, so they are the status quo rather than
    // something this mapping can improve, and holding them to the new minimums
    // would mean silently changing the default look.
    const failures: string[] = [];
    for (const theme of ported) {
      for (const variant of ["light", "dark"] as const) {
        const vars = resolveThemeVars(theme, variant);
        for (const [fill, behind, min] of SURFACE_SEPARATION) {
          const ratio = ratioOf(vars[fill], vars[behind]);
          if (ratio === null) continue;
          if (ratio < min) {
            failures.push(
              `${theme.id}/${variant} ${fill} on ${behind} = ${ratio.toFixed(2)} (needs ${min})`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("never reduces a derived foreground to a pure neutral", () => {
    // The failure this pins is invisible to every contrast assertion: black on a
    // light surface genuinely passes 4.5:1, so a hue-destroying "pick the most
    // legible candidate" fallback produced perfect contrast while labelling every
    // card in a violet theme with black text. Legibility is necessary and not
    // sufficient — a foreground also has to belong to the theme.
    //
    // Scoped to the tokens this generator DERIVES from `surface.foreground`, and
    // only for palettes whose own foreground actually carries chroma. A theme
    // whose palette says `#FFFFFF` (Cursor does, for `primary.foreground`) has
    // made a deliberate choice, and overriding it would be the bug rather than
    // the fix.
    const chromaOf = (value: string): number => {
      const parsed = parseColor(value);
      if (!parsed) return 0;
      const m = /oklch\([^ ]+ ([0-9.]+)/.exec(formatColor(value));
      return m ? Number(m[1]) : 0;
    };

    const offenders: string[] = [];
    for (const theme of ported) {
      for (const variant of ["light", "dark"] as const) {
        const vars = resolveThemeVars(theme, variant);
        const source = (variant === "dark" ? theme.dark : theme.light).surface?.foreground;
        if (!source || chromaOf(source) <= 0.015) continue;
        const expected = chromaOf(source);
        for (const token of [
          "--card-foreground",
          "--popover-foreground",
          "--accent-foreground",
          "--sidebar-accent-foreground",
        ] as const) {
          const got = chromaOf(vars[token]);
          // Some chroma is expected to survive; a flat zero means the hue was
          // thrown away entirely and replaced with a neutral.
          if (got < 0.004) {
            offenders.push(
              `${theme.id}/${variant} ${token} lost its hue (${vars[token]}, source chroma ${expected})`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps a hover/selected fill distinguishable from a menu panel", () => {
    // The single worst defect of the first pass, pinned on its own: `--accent`
    // backs both hover and selected rows in every menu, popover and list.
    for (const theme of ported) {
      for (const variant of ["light", "dark"] as const) {
        const vars = resolveThemeVars(theme, variant);
        const ratio = ratioOf(vars["--accent"], vars["--popover"]);
        expect(ratio, `${theme.id}/${variant}`).not.toBeNull();
        expect(ratio!, `${theme.id}/${variant} accent vs popover`).toBeGreaterThanOrEqual(1.12);
      }
    }
  });

  it("repairs an upstream warning that would be unreadable", () => {
    // Carbonfox light ships a warning label at 1.68:1 against its own warning
    // colour, and the colour is also too weak to read as status text. Both are
    // corrected: the label gets a legible foreground, and the colour is nudged
    // toward the palette's own foreground until it clears the text threshold.
    // The hue survives — it is a darkening of Carbonfox's yellow, not a
    // replacement, which is what `readableForeground` alone would have done.
    const carbonfox = getTheme("carbonfox")!;
    const light = resolveThemeVars(carbonfox, "light");
    const paletteWarning = carbonfox.light.status?.warning;
    expect(paletteWarning).toBeDefined();

    const repaired = ratioOf(light["--warning-foreground"], light["--warning"]);
    expect(repaired).not.toBeNull();
    expect(repaired!).toBeGreaterThanOrEqual(3);

    // The colour moved...
    expect(light["--warning"]).not.toBe(paletteWarning as string);
    // ...but only enough to be legible, and only in lightness.
    const asText = ratioOf(light["--warning"], light["--background"]);
    expect(asText!).toBeGreaterThanOrEqual(4.5);
    expect(asText!).toBeLessThan(12);
    expect(light["--warning"]).not.toBe("#000000");
    expect(light["--warning"]).not.toBe("#ffffff");
  });

  it("keeps a legible upstream foreground rather than second-guessing it", () => {
    // The repair must not fire where the palette's choice was already fine, or
    // every theme would drift toward the same two colours.
    const gruvbox = getTheme("gruvbox")!;
    for (const variant of ["light", "dark"] as const) {
      const vars = resolveThemeVars(gruvbox, variant);
      const palettePrimaryFg = gruvbox[variant].primary?.foreground;
      const paletteSuccessFg = gruvbox[variant].status?.successForeground;
      expect(palettePrimaryFg).toBeDefined();
      expect(paletteSuccessFg).toBeDefined();
      expect(vars["--primary-foreground"]).toBe(palettePrimaryFg as string);
      expect(vars["--success-foreground"]).toBe(paletteSuccessFg as string);
    }
  });

  it("resolves --accent to an opaque fill in every ported palette", () => {
    // TBAi uses `bg-accent` as a solid row highlight. A translucent token there
    // would let the surface beneath show through as a hole.
    for (const theme of ported) {
      for (const variant of ["light", "dark"] as const) {
        const accent = resolveThemeVars(theme, variant)["--accent"];
        const parsed = parseColor(accent);
        expect(parsed, `${theme.id}/${variant} accent unparseable: ${accent}`).not.toBeNull();
        expect(parsed!.a, `${theme.id}/${variant} accent is translucent`).toBe(1);
      }
    }
  });

  it("keeps the borderless card wash translucent", () => {
    // The opposite invariant: --card-soft/--card-outline must stay a faint wash.
    // Omitting them would turn the tool and permission cards into solid blocks.
    for (const theme of ported) {
      const vars = resolveThemeVars(theme, "dark");
      for (const token of ["--card-soft", "--card-outline"]) {
        const parsed = parseColor(vars[token]);
        expect(parsed, `${theme.id} ${token}`).not.toBeNull();
        expect(parsed!.a, `${theme.id} ${token} must be translucent`).toBeLessThan(0.2);
      }
    }
  });

  it("keeps every ported palette's background distinct from its foreground", () => {
    for (const theme of ported) {
      for (const variant of ["light", "dark"] as const) {
        const vars = resolveThemeVars(theme, variant);
        const ratio = ratioOf(vars["--foreground"], vars["--background"]);
        expect(ratio, `${theme.id}/${variant}`).not.toBeNull();
        expect(ratio!, `${theme.id}/${variant}`).toBeGreaterThan(4.5);
      }
    }
  });
});

describe("themeCss", () => {
  it("emits nothing for Classic, so globals.css stays the single source", () => {
    const classic = getTheme(DEFAULT_THEME_ID)!;
    expect(themeCss(classic, "light")).toBeNull();
    expect(themeCss(classic, "dark")).toBeNull();
  });

  it("scopes each block to its own theme id and variant", () => {
    // If every block shared a selector, the last one written would win and ten
    // themes would render as one. This is the exact bug the scoping prevents.
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
    // The layers are separated by specificity on purpose. !important would make it
    // impossible for a component to override a token, which is a trap worth
    // failing loudly on.
    for (const theme of THEMES) {
      for (const variant of ["light", "dark"] as const) {
        const css = themeCss(theme, variant);
        if (css === null) continue;
        expect(css).not.toContain("!important");
      }
    }
  });

  it("declares every TBAi token, and nothing outside the colour set", () => {
    for (const theme of ported) {
      for (const variant of ["light", "dark"] as const) {
        const css = themeCss(theme, variant)!;
        const declared = [...css.matchAll(/^\s{2}(--[\w-]+):/gm)].map((m) => m[1]);
        expect(new Set(declared), `${theme.id}/${variant}`).toEqual(new Set(TBAI_TOKENS));
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
  const cssPath = new URL("../../styles/themes.css", import.meta.url);

  it("matches what the generator produces right now", async () => {
    // Guards the failure mode where `theme-data.ts` is edited or re-extracted but
    // `themes.css` is not regenerated, which would ship a palette the app never
    // applies. Both files are committed, so this is the only thing keeping them
    // paired — and it has already caught one real desync.
    const onDisk = await Bun.file(cssPath).text();
    // Skip the leading banner comment. Anchoring on `html[` would not do: the
    // comment quotes a selector in order to explain the specificity scheme.
    const bannerEnd = onDisk.indexOf("*/");
    expect(bannerEnd, "banner comment must be closed").toBeGreaterThan(-1);
    const body = onDisk.slice(bannerEnd + 2);

    const expected = ported
      .flatMap((theme) => (["light", "dark"] as const).map((variant) => themeCss(theme, variant)!))
      .join("\n\n");

    expect(body.replace(/\n{3,}/g, "\n\n").trim()).toBe(expected.trim());
  });

  it("has a block for every ported theme and no block for Classic", async () => {
    const onDisk = await Bun.file(cssPath).text();
    for (const theme of ported) {
      expect(onDisk).toContain(`html[data-tbai-theme="${theme.id}"]`);
      expect(onDisk).toContain(`html[data-tbai-theme="${theme.id}"].dark`);
    }
    expect(onDisk).not.toContain('data-tbai-theme="classic"');
  });

  it("is imported by globals.css", async () => {
    const globals = await Bun.file(new URL("../../styles/globals.css", import.meta.url)).text();
    expect(globals).toContain('@import "./themes.css"');
  });

  it("defines every colour token in BOTH :root and .dark", async () => {
    // A token added to `:root` but forgotten in `.dark` is invisible in dark mode,
    // and nothing else catches it: the ported themes define their own blocks, the
    // generated-CSS tests never look at Classic, and a token-vs-token test on the
    // light value still passes. `--link` shipped exactly that way and was only
    // caught by rendering the page.
    const globals = await Bun.file(new URL("../../styles/globals.css", import.meta.url)).text();
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
    // Shape tokens are legitimately one-sided (elevation and glass have distinct
    // light and dark values but share names); only the colour set must match.
    const COLOUR = TBAI_TOKENS as readonly string[];
    for (const token of COLOUR) {
      expect(rootTokens.has(token), `:root is missing ${token}`).toBe(true);
      expect(darkTokens.has(token), `.dark is missing ${token}`).toBe(true);
    }
  });
});