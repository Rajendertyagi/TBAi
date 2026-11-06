import { describe, expect, it, beforeEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  APP_SCALE_CONFIG,
  clampWeightForFont,
  DEFAULT_TYPOGRAPHY,
  formatAppScale,
  getFont,
  INTERFACE_FONT_SIZE_CONFIG,
  MONO_FONTS,
  readTypography,
  resetApplicationScale,
  resetCodeTypography,
  resetInterfaceTypography,
  resetReadingTypography,
  resetTerminalTypography,
  resetTypography,
  UI_FONTS,
  writeTypography,
  type TypographyConfig,
} from "../../../web/src/features/appearance/typography";
import { REPO_ROOT } from "../../helpers/repo-root";

const STORAGE_KEY = "tbai-typography";

function customConfig(overrides: Partial<TypographyConfig> = {}): TypographyConfig {
  return {
    version: 2,
    interfaceFontFamily: "roboto",
    interfaceFontSize: 18,
    interfaceFontWeight: 700,
    codeFontFamily: "fira-code",
    codeFontSize: 16,
    codeFontWeight: 300,
    codeWordWrap: true,
    terminalFontFamily: "source-code-pro",
    terminalFontSize: 14,
    terminalFontWeight: 600,
    terminalWrap: false,
    readingLineHeight: 1.65,
    appScale: 1.125,
    ...overrides,
  };
}

/**
 * Reads a stored record through the production `readTypography()` path.
 *
 * The canonical unit run has no DOM, so `window` is supplied for the duration
 * of the read and the previous descriptor is restored afterwards. The module
 * reads `window.localStorage` at call time, which is why this works without a
 * second storage implementation.
 */
function readStoredTypography(record: unknown): TypographyConfig {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const raw = JSON.stringify(record);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => (key === STORAGE_KEY ? raw : null),
        setItem: () => {},
      },
    },
  });
  try {
    return readTypography();
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

describe("Typography config, storage & scoped resets (v2)", () => {
  beforeEach(() => {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
  });

  it("returns default typography when storage is empty", () => {
    expect(DEFAULT_TYPOGRAPHY.version).toBe(2);
    expect(DEFAULT_TYPOGRAPHY.interfaceFontFamily).toBe("inter");
    expect(DEFAULT_TYPOGRAPHY.interfaceFontSize).toBe(16);
    expect(DEFAULT_TYPOGRAPHY.interfaceFontWeight).toBe(400);
    expect(DEFAULT_TYPOGRAPHY.codeFontFamily).toBe("jetbrains-mono");
    expect(DEFAULT_TYPOGRAPHY.codeFontSize).toBe(13);
    expect(DEFAULT_TYPOGRAPHY.codeFontWeight).toBe(400);
    expect(DEFAULT_TYPOGRAPHY.codeWordWrap).toBe(false);
    expect(DEFAULT_TYPOGRAPHY.terminalFontFamily).toBe("jetbrains-mono");
    expect(DEFAULT_TYPOGRAPHY.terminalFontSize).toBe(12);
    expect(DEFAULT_TYPOGRAPHY.terminalFontWeight).toBe(400);
    expect(DEFAULT_TYPOGRAPHY.terminalWrap).toBe(true);
    expect(DEFAULT_TYPOGRAPHY.readingLineHeight).toBe(1.5);
    expect(DEFAULT_TYPOGRAPHY.appScale).toBe(1);
  });

  it("migrates the first v1 shape (no monoFontWeight / codeFontSize) losslessly", () => {
    if (typeof window === "undefined" || !window.localStorage) return;
    const legacy = {
      version: 1,
      fontFamily: "roboto",
      monoFontFamily: "fira-code",
      fontWeight: 600,
      baseSize: 18,
      lineHeight: 1.65,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));
    const config = readTypography();
    expect(config.version).toBe(2);
    expect(config.interfaceFontFamily).toBe("roboto");
    expect(config.interfaceFontWeight).toBe(600);
    expect(config.codeFontFamily).toBe("fira-code");
    // monoFontWeight falls back to fontWeight
    expect(config.codeFontWeight).toBe(600);
    expect(config.codeFontSize).toBe(13);
    expect(config.readingLineHeight).toBe(1.65);
    // 18 / 16 = 1.125 exactly
    expect(config.appScale).toBe(1.125);
    // New fields take defaults
    expect(config.interfaceFontSize).toBe(16);
    expect(config.codeWordWrap).toBe(false);
    expect(config.terminalFontFamily).toBe("jetbrains-mono");
    expect(config.terminalFontSize).toBe(12);
    expect(config.terminalFontWeight).toBe(400);
    expect(config.terminalWrap).toBe(true);
  });

  it("migrates the second v1 shape (with monoFontWeight / codeFontSize) losslessly", () => {
    if (typeof window === "undefined" || !window.localStorage) return;
    const legacy = {
      version: 1,
      fontFamily: "outfit",
      monoFontFamily: "source-code-pro",
      fontWeight: 700,
      monoFontWeight: 300,
      baseSize: 13,
      codeFontSize: 15,
      lineHeight: 1.35,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));
    const config = readTypography();
    expect(config.interfaceFontFamily).toBe("outfit");
    expect(config.interfaceFontWeight).toBe(700);
    expect(config.codeFontFamily).toBe("source-code-pro");
    expect(config.codeFontWeight).toBe(300);
    expect(config.codeFontSize).toBe(15);
    expect(config.readingLineHeight).toBe(1.35);
    // 13 / 16 = 0.8125 exactly (81.25%)
    expect(config.appScale).toBe(0.8125);
  });

  it("maps every legacy baseSize to its exact factor", () => {
    if (typeof window === "undefined" || !window.localStorage) return;
    const expected: Record<number, number> = {
      12: 0.75,
      13: 0.8125,
      14: 0.875,
      15: 0.9375,
      16: 1,
      17: 1.0625,
      18: 1.125,
      19: 1.1875,
      20: 1.25,
      21: 1.3125,
      22: 1.375,
      23: 1.4375,
      24: 1.5,
    };
    for (const [baseSize, appScale] of Object.entries(expected)) {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 1, baseSize: Number(baseSize) }),
      );
      expect(readTypography().appScale).toBe(appScale);
    }
  });

  it("validates appScale strictly (NaN, out-of-range, wrong type → default)", () => {
    if (typeof window === "undefined" || !window.localStorage) return;
    for (const bad of [Number.NaN, 0.5, 2, "1.25", null, undefined, Number.POSITIVE_INFINITY]) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, appScale: bad }));
      expect(readTypography().appScale).toBe(1);
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, appScale: 1.25 }));
    expect(readTypography().appScale).toBe(1.25);
  });

  it("validates every v2 field independently", () => {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        interfaceFontFamily: "not-a-font",
        interfaceFontSize: 99,
        interfaceFontWeight: 42,
        codeFontFamily: "not-a-mono",
        codeFontSize: 99,
        codeFontWeight: 42,
        codeWordWrap: "yes",
        terminalFontFamily: "not-a-mono",
        terminalFontSize: 99,
        terminalFontWeight: 42,
        terminalWrap: "yes",
        readingLineHeight: 99,
        appScale: 99,
      }),
    );
    const config = readTypography();
    expect(config.interfaceFontFamily).toBe(DEFAULT_TYPOGRAPHY.interfaceFontFamily);
    expect(config.interfaceFontSize).toBe(16);
    expect(config.interfaceFontWeight).toBe(400);
    expect(config.codeFontFamily).toBe(DEFAULT_TYPOGRAPHY.codeFontFamily);
    expect(config.codeFontSize).toBe(13);
    expect(config.codeFontWeight).toBe(400);
    expect(config.codeWordWrap).toBe(false);
    expect(config.terminalFontFamily).toBe(DEFAULT_TYPOGRAPHY.terminalFontFamily);
    expect(config.terminalFontSize).toBe(12);
    expect(config.terminalFontWeight).toBe(400);
    expect(config.terminalWrap).toBe(true);
    expect(config.readingLineHeight).toBe(1.5);
    expect(config.appScale).toBe(1);
  });

  it("clamps interface and code weights independently", () => {
    const openSans = getFont("open-sans")!;
    expect(openSans).toBeDefined();
    // Open Sans is 300 to 800
    expect(clampWeightForFont(100, openSans)).toBe(300);
    expect(clampWeightForFont(400, openSans)).toBe(400);
    expect(clampWeightForFont(900, openSans)).toBe(800);

    const jetbrainsMono = getFont("jetbrains-mono")!;
    expect(jetbrainsMono).toBeDefined();
    // JetBrains Mono is 100 to 800
    expect(clampWeightForFont(100, jetbrainsMono)).toBe(100);
    expect(clampWeightForFont(900, jetbrainsMono)).toBe(800);

    const firaCode = getFont("fira-code")!;
    expect(firaCode).toBeDefined();
    // Fira Code is 300 to 700
    expect(clampWeightForFont(200, firaCode)).toBe(300);
    expect(clampWeightForFont(800, firaCode)).toBe(700);
  });

  it("clamps weights correctly for static discrete fonts (Lato)", () => {
    const lato = getFont("lato")!;
    expect(lato).toBeDefined();
    expect(clampWeightForFont(200, lato)).toBe(100);
    expect(clampWeightForFont(500, lato)).toBe(400);
    expect(clampWeightForFont(600, lato)).toBe(700);
  });

  it("formatAppScale trims trailing zeros", () => {
    expect(formatAppScale(0.75)).toBe("75%");
    expect(formatAppScale(0.8125)).toBe("81.25%");
    expect(formatAppScale(0.875)).toBe("87.5%");
    expect(formatAppScale(0.9375)).toBe("93.75%");
    expect(formatAppScale(1)).toBe("100%");
    expect(formatAppScale(1.0625)).toBe("106.25%");
    expect(formatAppScale(1.125)).toBe("112.5%");
    expect(formatAppScale(1.25)).toBe("125%");
    expect(formatAppScale(1.5)).toBe("150%");
  });

  it("APP_SCALE_CONFIG step reaches every legacy value exactly", () => {
    expect(APP_SCALE_CONFIG.min).toBe(0.75);
    expect(APP_SCALE_CONFIG.max).toBe(1.5);
    expect(APP_SCALE_CONFIG.step).toBe(0.0625);
    for (
      let scale = APP_SCALE_CONFIG.min;
      scale <= APP_SCALE_CONFIG.max + 1e-9;
      scale += APP_SCALE_CONFIG.step
    ) {
      const rounded = Math.round(scale * 16) / 16;
      expect(Math.abs(rounded - scale)).toBeLessThan(1e-9);
    }
  });

  it("resetInterfaceTypography preserves code, terminal, reading and scale settings", () => {
    const reset = resetInterfaceTypography(customConfig());
    expect(reset.interfaceFontFamily).toBe(DEFAULT_TYPOGRAPHY.interfaceFontFamily);
    expect(reset.interfaceFontSize).toBe(DEFAULT_TYPOGRAPHY.interfaceFontSize);
    expect(reset.interfaceFontWeight).toBe(DEFAULT_TYPOGRAPHY.interfaceFontWeight);
    // Preserved:
    expect(reset.codeFontFamily).toBe("fira-code");
    expect(reset.codeFontSize).toBe(16);
    expect(reset.codeFontWeight).toBe(300);
    expect(reset.codeWordWrap).toBe(true);
    expect(reset.terminalFontFamily).toBe("source-code-pro");
    expect(reset.terminalFontSize).toBe(14);
    expect(reset.terminalFontWeight).toBe(600);
    expect(reset.terminalWrap).toBe(false);
    expect(reset.readingLineHeight).toBe(1.65);
    expect(reset.appScale).toBe(1.125);
  });

  it("resetCodeTypography preserves interface, terminal, reading and scale settings", () => {
    const reset = resetCodeTypography(customConfig());
    expect(reset.codeFontFamily).toBe(DEFAULT_TYPOGRAPHY.codeFontFamily);
    expect(reset.codeFontSize).toBe(DEFAULT_TYPOGRAPHY.codeFontSize);
    expect(reset.codeFontWeight).toBe(DEFAULT_TYPOGRAPHY.codeFontWeight);
    expect(reset.codeWordWrap).toBe(DEFAULT_TYPOGRAPHY.codeWordWrap);
    // Preserved:
    expect(reset.interfaceFontFamily).toBe("roboto");
    expect(reset.interfaceFontSize).toBe(18);
    expect(reset.interfaceFontWeight).toBe(700);
    expect(reset.terminalFontFamily).toBe("source-code-pro");
    expect(reset.terminalFontSize).toBe(14);
    expect(reset.terminalFontWeight).toBe(600);
    expect(reset.terminalWrap).toBe(false);
    expect(reset.readingLineHeight).toBe(1.65);
    expect(reset.appScale).toBe(1.125);
  });

  it("resetTerminalTypography preserves interface, code, reading and scale settings", () => {
    const reset = resetTerminalTypography(customConfig());
    expect(reset.terminalFontFamily).toBe(DEFAULT_TYPOGRAPHY.terminalFontFamily);
    expect(reset.terminalFontSize).toBe(DEFAULT_TYPOGRAPHY.terminalFontSize);
    expect(reset.terminalFontWeight).toBe(DEFAULT_TYPOGRAPHY.terminalFontWeight);
    expect(reset.terminalWrap).toBe(DEFAULT_TYPOGRAPHY.terminalWrap);
    // Preserved:
    expect(reset.interfaceFontFamily).toBe("roboto");
    expect(reset.interfaceFontSize).toBe(18);
    expect(reset.interfaceFontWeight).toBe(700);
    expect(reset.codeFontFamily).toBe("fira-code");
    expect(reset.codeFontSize).toBe(16);
    expect(reset.codeFontWeight).toBe(300);
    expect(reset.codeWordWrap).toBe(true);
    expect(reset.readingLineHeight).toBe(1.65);
    expect(reset.appScale).toBe(1.125);
  });

  it("resetReadingTypography preserves interface, code, terminal and scale settings", () => {
    const reset = resetReadingTypography(customConfig());
    expect(reset.readingLineHeight).toBe(DEFAULT_TYPOGRAPHY.readingLineHeight);
    // Preserved:
    expect(reset.interfaceFontFamily).toBe("roboto");
    expect(reset.codeFontFamily).toBe("fira-code");
    expect(reset.terminalFontFamily).toBe("source-code-pro");
    expect(reset.appScale).toBe(1.125);
  });

  it("resetApplicationScale preserves interface, code, terminal and reading settings", () => {
    const reset = resetApplicationScale(customConfig());
    expect(reset.appScale).toBe(DEFAULT_TYPOGRAPHY.appScale);
    // Preserved:
    expect(reset.interfaceFontFamily).toBe("roboto");
    expect(reset.interfaceFontSize).toBe(18);
    expect(reset.codeFontFamily).toBe("fira-code");
    expect(reset.terminalFontFamily).toBe("source-code-pro");
    expect(reset.readingLineHeight).toBe(1.65);
  });

  it("resetTypography restores all factory defaults", () => {
    writeTypography(customConfig());
    const reset = resetTypography();
    expect(reset).toEqual(DEFAULT_TYPOGRAPHY);
  });

  it("safely recovers from corrupted storage", () => {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(STORAGE_KEY, "{ corrupted_json: ... ");
    const config = readTypography();
    expect(config).toEqual(DEFAULT_TYPOGRAPHY);
  });

  it("safely recovers from a non-object payload", () => {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(readTypography()).toEqual(DEFAULT_TYPOGRAPHY);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify("nope"));
    expect(readTypography()).toEqual(DEFAULT_TYPOGRAPHY);
  });
});

describe("index.html bootstrap parity", () => {
  const html = readFileSync(path.join(REPO_ROOT, "web", "index.html"), "utf8");

  function extractMap(
    name: "FONT_MAP" | "MONO_MAP",
  ): Record<string, { stack: string; min?: number; max?: number; weights?: number[] }> {
    const match = html.match(new RegExp(`var ${name} = (\\{[\\s\\S]*?\\});`));
    if (!match) throw new Error(`${name} not found in web/index.html`);
    // The map is a static object literal authored in this repo; evaluate it.
    return new Function(`return (${match[1]});`)() as Record<
      string,
      { stack: string; min?: number; max?: number; weights?: number[] }
    >;
  }

  it("FONT_MAP matches UI_FONTS (stacks and weight ranges)", () => {
    const map = extractMap("FONT_MAP");
    expect(Object.keys(map).sort()).toEqual(UI_FONTS.map((f) => f.id).sort());
    for (const font of UI_FONTS) {
      const entry = map[font.id];
      expect(entry, `FONT_MAP missing ${font.id}`).toBeDefined();
      expect(entry.stack).toBe(font.stack);
      if (font.weights === "continuous") {
        expect(entry.min).toBe(font.minWeight ?? 100);
        expect(entry.max).toBe(font.maxWeight ?? 900);
      } else {
        expect(entry.weights).toEqual([...font.weights]);
      }
    }
  });

  it("MONO_MAP matches MONO_FONTS (stacks and weight ranges)", () => {
    const map = extractMap("MONO_MAP");
    expect(Object.keys(map).sort()).toEqual(MONO_FONTS.map((f) => f.id).sort());
    for (const font of MONO_FONTS) {
      const entry = map[font.id];
      expect(entry, `MONO_MAP missing ${font.id}`).toBeDefined();
      expect(entry.stack).toBe(font.stack);
      if (font.weights === "continuous") {
        expect(entry.min).toBe(font.minWeight ?? 100);
        expect(entry.max).toBe(font.maxWeight ?? 900);
      } else {
        expect(entry.weights).toEqual([...font.weights]);
      }
    }
  });

  it("bootstrap never writes --font-mono (the fixed generic stack)", () => {
    expect(html).not.toContain('setProperty("--font-mono"');
    expect(html).not.toContain("setProperty('--font-mono'");
  });

  it("bootstrap writes the v2 variables and factor zoom", () => {
    for (const variable of [
      "--font-sans",
      "--interface-font-size",
      "--font-weight-base",
      "--code-font-family",
      "--code-font-size",
      "--code-font-weight",
      "--terminal-font-family",
      "--terminal-font-size",
      "--terminal-font-weight",
      "--reading-line-height",
    ]) {
      expect(html).toContain(variable);
    }
    expect(html).toContain("data-code-wrap");
    expect(html).toContain("data-terminal-wrap");
    expect(html).toContain("appScale");
  });
});

/**
 * The interface minimum is 14px (D-2 option A).
 *
 * A stored 12 or 13 is a LEGACY value, not an invalid one: it migrates to the
 * new minimum instead of being reset to the 16px default, so a user who chose
 * the smallest size keeps the smallest size. 11 and 25 were never selectable
 * and still fall back to the default.
 */
describe("interface font-size minimum and the 12/13 migration", () => {
  it("declares a 14px minimum and drops the 13px preset", () => {
    expect(INTERFACE_FONT_SIZE_CONFIG.min).toBe(14);
    expect(INTERFACE_FONT_SIZE_CONFIG.max).toBe(24);
    expect([...INTERFACE_FONT_SIZE_CONFIG.presets]).not.toContain(13);
    expect([...INTERFACE_FONT_SIZE_CONFIG.presets]).toContain(14);
  });

  it("clamps a stored 12 or 13 to 14 and preserves every other field", () => {
    for (const stored of [12, 13]) {
      const config = readStoredTypography(customConfig({ interfaceFontSize: stored }));
      expect(config.interfaceFontSize, `stored ${stored} must migrate to 14`).toBe(14);
      expect({ ...config, interfaceFontSize: 16 }).toEqual({
        ...customConfig(),
        interfaceFontSize: 16,
      });
    }
  });

  it("preserves every selectable size from 14 through 24", () => {
    for (let size = 14; size <= 24; size++) {
      expect(
        readStoredTypography(customConfig({ interfaceFontSize: size })).interfaceFontSize,
      ).toBe(size);
    }
  });

  it("resets 11 and 25 to the 16px default", () => {
    for (const stored of [11, 25]) {
      expect(
        readStoredTypography(customConfig({ interfaceFontSize: stored })).interfaceFontSize,
      ).toBe(DEFAULT_TYPOGRAPHY.interfaceFontSize);
    }
  });
});

/**
 * Lato advertises five static weights. Only the 400 face was imported, so
 * `font-weight` 100/300/700/900 silently rendered at 400 (M-4 measured
 * identical widths for all five). The package ships one CSS entry point per
 * weight; both the import and the file must exist.
 */
describe("Lato ships every weight it advertises", () => {
  const globalsCss = readFileSync(
    path.join(REPO_ROOT, "web", "src", "styles", "globals.css"),
    "utf8",
  );
  const lato = UI_FONTS.find((font) => font.id === "lato");
  const declaredWeights = lato && lato.weights !== "continuous" ? lato.weights : [];

  it("declares five static weights", () => {
    expect(declaredWeights).toEqual([100, 300, 400, 700, 900]);
  });

  it("imports a stylesheet for every declared weight", () => {
    for (const weight of declaredWeights) {
      expect(globalsCss, `missing @fontsource/lato/${weight}.css`).toContain(
        `@import "@fontsource/lato/${weight}.css";`,
      );
    }
  });

  it("has every imported weight file installed", () => {
    for (const weight of declaredWeights) {
      const file = path.join(
        REPO_ROOT,
        "web",
        "node_modules",
        "@fontsource",
        "lato",
        `${weight}.css`,
      );
      expect(existsSync(file), `@fontsource/lato/${weight}.css is not installed`).toBe(true);
    }
  });
});
