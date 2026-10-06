/**
 * Build the TBAi theme layer.
 *
 * Reads OpenChamber's compiled theme registry, extracts the palettes the
 * maintainer asked for, and writes two committed artefacts:
 *
 *   src/features/appearance/theme-data.ts   palettes + types (picked from)
 *   src/styles/themes.css                   the custom-property blocks (picked into)
 *
 * Why generate CSS rather than inject it at runtime:
 *
 * - The stylesheet is render-blocking, so a theme can never flash the wrong
 *   colours. A runtime-injected <style> lands after first paint.
 * - No `!important` and no specificity war: the blocks address
 *   `html[data-tbai-theme=…]`, which outranks the stylesheet's own `:root`/`.dark`
 *   on specificity alone, so it does not matter where the file is imported.
 * - The runtime then only has to set two attributes, which means the pre-paint
 *   bootstrap in index.html stays trivial and cannot drift from the provider.
 *
 * The palette -> token mapping lives in exactly one place,
 * `src/features/appearance/theme-css.ts`, and is imported by this script. Adding a
 * theme is: add its data, re-run this script, commit both files.
 *
 * Usage:  bun scripts/build-themes.mjs [path-to-openchamber-web-dist-assets]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoWeb = resolve(here, "..");

const ASSETS =
  process.argv[2] ??
  "D:/IT/Coding/OpenChamber/resources/web-dist/assets";
const BUNDLE = resolve(ASSETS, "useAppFontEffects-09IWGVUq.js");

/** Families to port, with the display name the picker should show. */
const WANTED = [
  ["aura", "Aura"],
  ["ayu", "Ayu"],
  ["carbonfox", "Carbonfox"],
  ["catppuccin", "Catppuccin"],
  ["cursor", "Cursor"],
  ["fields-of-the-shire", "Fields of the Shire"],
  ["gruvbox", "Gruvbox"],
  ["jetbrains", "JetBrains"],
  ["openchamber", "OpenChamber"],
  ["vesper", "Vesper"],
];

/** Fields kept per group — only what TBAi has a token for. */
const GROUPS = {
  primary: ["base", "foreground", "hover", "active", "muted"],
  surface: [
    "background",
    "foreground",
    "muted",
    "mutedForeground",
    "elevated",
    "elevatedForeground",
    "overlay",
    "subtle",
  ],
  interactive: [
    "border",
    "borderHover",
    "selection",
    "selectionForeground",
    "hover",
    "active",
    "focusRing",
  ],
  status: [
    "error",
    "errorForeground",
    "warning",
    "warningForeground",
    "success",
    "successForeground",
  ],
  // Re-added after the first pass dropped it. A rendered audit then measured
  // markdown links at 2.61:1 because TBAi coloured them with `--primary` — a fill
  // colour meant to sit behind `--primary-foreground`, not to be read as text.
  // Upstream carries a dedicated link colour for exactly this, in all 20 palettes.
  markdown: ["link", "linkHover"],
};

// ---------------------------------------------------------------------------
// 1. Extract palettes from the bundle.
// ---------------------------------------------------------------------------

const code = readFileSync(BUNDLE, "utf8");

/** Index every top-level `NAME={…}` definition by its balanced-brace extent. */
function indexDefinitions() {
  const out = new Map();
  for (const m of code.matchAll(/([A-Za-z0-9_$]+)=\{/g)) {
    const name = m[1];
    const start = m.index + m[0].length - 1;
    let depth = 0;
    let quote = null;
    for (let i = start; i < code.length; i++) {
      const ch = code[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        out.set(name, code.slice(start, i + 1));
        break;
      }
    }
  }
  return out;
}

const defs = indexDefinitions();

/**
 * The bundler emits `{metadata:X, colors:Y}` for each theme. Resolving those
 * references is exact; scanning for `id:"…"` is not, because field order varies
 * between themes and some put `id` last.
 */
const extracted = new Map();
for (const m of code.matchAll(/\{metadata:([A-Za-z0-9_$]+),colors:([A-Za-z0-9_$]+)/g)) {
  const metaText = defs.get(m[1]);
  const colorsText = defs.get(m[2]);
  if (!metaText || !colorsText) continue;
  const id = /id:"([^"]+)"/.exec(metaText)?.[1];
  const variant = /variant:"(light|dark)"/.exec(metaText)?.[1];
  const author = /author:"([^"]+)"/.exec(metaText)?.[1] ?? null;
  if (!id || !variant) continue;
  let colors;
  try {
    colors = new Function(`return (${colorsText})`)();
  } catch {
    continue;
  }
  if (!colors?.primary || !colors?.surface) continue;
  extracted.set(id, { variant, author, colors });
}

const palettes = new Map();
const authors = new Map();
for (const [family] of WANTED) {
  const entry = {};
  let author = null;
  for (const variant of ["light", "dark"]) {
    const found = extracted.get(`${family}-${variant}`);
    if (!found) {
      console.error(`missing ${family}/${variant} in ${BUNDLE}`);
      process.exit(1);
    }
    author ??= found.author;
    const picked = {};
    for (const group of Object.keys(GROUPS)) {
      const values = {};
      for (const key of GROUPS[group]) {
        const value = found.colors[group]?.[key];
        if (typeof value === "string") values[key] = value;
      }
      if (Object.keys(values).length) picked[group] = values;
    }
    entry[variant] = picked;
  }
  palettes.set(family, entry);
  authors.set(family, author);
}

console.log(`extracted ${palettes.size} families x 2 variants from ${BUNDLE}`);

// ---------------------------------------------------------------------------
// 2. Classic — TBAi's own palette, mirrored so the picker can show a swatch.
//    `builtin: true` means no CSS is emitted for it: these colours already live
//    in globals.css, and re-emitting them would create a second source of truth.
// ---------------------------------------------------------------------------

const CLASSIC = {
  light: {
    primary: { base: "#18181b", foreground: "#fafafa" },
    surface: {
      background: "#ffffff",
      foreground: "#09090b",
      muted: "#f4f4f5",
      mutedForeground: "#71717a",
      elevated: "#ffffff",
      subtle: "#f4f4f5",
    },
    interactive: { border: "#e4e4e7", selection: "#f4f4f5", focusRing: "#a1a1aa" },
    status: {
      error: "#ef4444",
      errorForeground: "#fafafa",
      warning: "#d97706",
      warningForeground: "#fafafa",
      success: "#16a34a",
      successForeground: "#fafafa",
    },
  },
  dark: {
    primary: { base: "oklch(0.87 0 0)", foreground: "oklch(0.205 0 0)" },
    surface: {
      background: "#0a0a0a",
      foreground: "oklch(0.985 0 0)",
      muted: "oklch(0.269 0 0)",
      mutedForeground: "oklch(0.708 0 0)",
      elevated: "oklch(0.205 0 0)",
      subtle: "oklch(0.371 0 0)",
    },
    interactive: {
      border: "oklch(1 0 0 / 10%)",
      selection: "oklch(0.371 0 0)",
      focusRing: "oklch(0.556 0 0)",
    },
    status: {
      error: "oklch(0.704 0.191 22.216)",
      errorForeground: "#fafafa",
      warning: "#fbbf24",
      warningForeground: "#0a0a0a",
      success: "#4ade80",
      successForeground: "#0a0a0a",
    },
  },
};

// ---------------------------------------------------------------------------
// 3. Emit theme-data.ts
// ---------------------------------------------------------------------------

const banner = `/**
 * DO NOT EDIT BY HAND — generated by \`scripts/build-themes.mjs\`.
 *
 * Re-run:  bun scripts/build-themes.mjs
 *
 * PROVENANCE AND LICENCE. The palettes below are extracted verbatim from
 * OpenChamber's compiled theme registry (github.com/openchamber/openchamber),
 * which is MIT licensed — Copyright (c) 2025 Bohdan Triapitsyn. MIT permits
 * reuse and redistribution provided the notice is retained, which is why this
 * banner and \`docs/2026-10-03-theme-system.md\` both carry it. Several palettes
 * credit their own upstream author on the \`author\` field; those credits are kept
 * so a future licence change has the provenance it would need.
 *
 * Field presence is deliberately uneven, because upstream is uneven:
 *
 *   surface.elevatedForeground  absent from all 20 palettes
 *   primary.foreground          absent from 5
 *   status.errorForeground      absent from 6
 *   surface.subtle              absent from 6
 *
 * \`theme-css.ts\` derives every absent value from colours the palette does
 * provide, which is why no placeholder hexes appear below.
 */`;

function emitPaletteObject(value, pad) {
  const lines = [];
  for (const group of Object.keys(GROUPS)) {
    const source = value[group];
    if (!source) continue;
    const entries = GROUPS[group]
      .filter((key) => typeof source[key] === "string")
      .map((key) => `${pad}    ${key}: ${JSON.stringify(source[key])},`);
    if (!entries.length) continue;
    lines.push(`${pad}  ${group}: {`, ...entries, `${pad}  },`);
  }
  return `{\n${lines.join("\n")}\n${pad}}`;
}

const dataLines = [];
dataLines.push(banner);
dataLines.push(`
/** A palette in the subset TBAi maps onto its own tokens. Missing keys are derived. */
export interface ThemePalette {
  primary?: {
    base?: string;
    foreground?: string;
    hover?: string;
    active?: string;
    muted?: string;
  };
  surface?: {
    background?: string;
    foreground?: string;
    muted?: string;
    mutedForeground?: string;
    elevated?: string;
    elevatedForeground?: string;
    overlay?: string;
    subtle?: string;
  };
  interactive?: {
    border?: string;
    borderHover?: string;
    selection?: string;
    selectionForeground?: string;
    hover?: string;
    active?: string;
    focusRing?: string;
  };
  status?: {
    error?: string;
    errorForeground?: string;
    warning?: string;
    warningForeground?: string;
    success?: string;
    successForeground?: string;
  };
  markdown?: {
    link?: string;
    linkHover?: string;
  };
}

export type ThemeVariant = "light" | "dark";

export interface ThemeDefinition {
  /** Stable family id. Also the \`data-tbai-theme\` attribute value. */
  readonly id: string;
  /** Name shown in the picker. */
  readonly name: string;
  /** Upstream author of the palette, as credited by OpenChamber. */
  readonly author: string | null;
  /**
   * True only for \`classic\`. Its colours ship in \`globals.css\` as \`:root\`/\`.dark\`,
   * so no block is generated for it — that is what keeps TBAi's current look the
   * default rather than a re-derivation of itself.
   */
  readonly builtin: boolean;
  readonly light: ThemePalette;
  readonly dark: ThemePalette;
}

const CLASSIC_LIGHT: ThemePalette = ${emitPaletteObject(CLASSIC.light, "  ")};

const CLASSIC_DARK: ThemePalette = ${emitPaletteObject(CLASSIC.dark, "  ")};

/** The theme used when nothing is stored, and what a reset returns to. */
export const DEFAULT_THEME_ID = "classic";

/** Every selectable theme. \`classic\` is first because it is the default. */
export const THEMES: readonly ThemeDefinition[] = [
  {
    id: "classic",
    name: "Classic",
    author: null,
    builtin: true,
    light: CLASSIC_LIGHT,
    dark: CLASSIC_DARK,
  },`);

for (const [family, name] of WANTED) {
  const entry = palettes.get(family);
  dataLines.push(`
  {
    id: ${JSON.stringify(family)},
    name: ${JSON.stringify(name)},
    author: ${JSON.stringify(authors.get(family) ?? null)},
    builtin: false,
    light: ${emitPaletteObject(entry.light, "    ")},
    dark: ${emitPaletteObject(entry.dark, "    ")},
  },`);
}

dataLines.push(`] as const;

const BY_ID = new Map<string, ThemeDefinition>(THEMES.map((theme) => [theme.id, theme]));

export function getTheme(id: string): ThemeDefinition | undefined {
  return BY_ID.get(id);
}

export function isThemeId(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}
`);

const dataPath = resolve(repoWeb, "src/features/appearance/theme-data.ts");
writeFileSync(dataPath, dataLines.join("\n"));
console.log(`wrote ${dataPath}`);

// ---------------------------------------------------------------------------
// 4. Emit themes.css, using the app's own mapping so there is one source.
//    Imported dynamically because it reads the file just written above.
// ---------------------------------------------------------------------------

const { themeCss } = await import(
  pathToFileURL(resolve(repoWeb, "src/features/appearance/theme-css.ts")).href
);

const cssLines = [];
cssLines.push(`/**
 * DO NOT EDIT BY HAND — generated by \`scripts/build-themes.mjs\`.
 *
 * One block per theme family, split by variant. Specificity is the mechanism:
 *
 *   html[data-tbai-theme="x"]        (0,1,1)  beats  :root   (0,1,0)
 *   html[data-tbai-theme="x"].dark   (0,2,1)  beats  .dark   (0,1,0)
 *
 * so these win wherever \`globals.css\` is imported, with no \`!important\` and no
 * dependence on source order. With no attribute present, \`:root\`/\`.dark\` stand —
 * which is TBAi's existing look, and the reason it stays the default.
 *
 * Only colour tokens appear here. Shape (--radius, glass, elevation) is
 * deliberately theme-independent.
 *
 * Provenance: palettes extracted from OpenChamber (MIT, (c) 2025 Bohdan
 * Triapitsyn). See src/features/appearance/theme-data.ts for the full notice.
 */`);

const byId = new Map();
for (const [family] of WANTED) byId.set(family, { id: family, builtin: false });

for (const [family] of WANTED) {
  cssLines.push("");
  const stub = {
    id: family,
    name: family,
    builtin: false,
    light: palettes.get(family).light,
    dark: palettes.get(family).dark,
  };
  for (const variant of ["light", "dark"]) {
    const text = themeCss(stub, variant);
    cssLines.push(text);
    cssLines.push("");
  }
}

const cssPath = resolve(repoWeb, "src/styles/themes.css");
writeFileSync(cssPath, cssLines.join("\n").replace(/\n{3,}/g, "\n\n"));
console.log(`wrote ${cssPath}`);