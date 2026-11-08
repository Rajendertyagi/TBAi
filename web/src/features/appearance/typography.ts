/**
 * Typography configuration, storage, and DOM application for TBAi.
 *
 * Follows the existing theme-storage.ts and theme-dom.ts conventions:
 * - Single persistent JSON object under `tbai-typography`
 * - Resilient total reads falling back safely to defaults
 * - Single framework-free DOM applicator writing root CSS custom properties and root rem font-size
 *
 * v3 (2026-11-06): Interface Size controls root rem scaling (14–24px).
 * Independent ownership per rendering context — Interface, Code, Terminal, and Reading.
 * `--font-mono` is the fixed generic monospace stack and is NEVER written by a setting;
 * code surfaces use `--code-font-family`, terminal output uses `--terminal-font-family`.
 */

export interface TypographyConfig {
  version: 3;
  // Interface
  interfaceFontFamily: string;
  interfaceFontSize: number;
  interfaceFontWeight: number;
  // Code
  codeFontFamily: string;
  codeFontSize: number;
  codeFontWeight: number;
  codeWordWrap: boolean;
  // Terminal
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalFontWeight: number;
  terminalWrap: boolean;
  // Reading
  readingLineHeight: number;
}

export interface FontDefinition {
  id: string;
  label: string;
  stack: string;
  category: "sans" | "mono";
  weights: "continuous" | readonly number[];
  minWeight?: number;
  maxWeight?: number;
}

export interface UIFontDefinition extends FontDefinition {
  readonly rendererFamily: string;
}

export const DEFAULT_TYPOGRAPHY: TypographyConfig = {
  version: 3,
  interfaceFontFamily: "inter",
  interfaceFontSize: 15,
  interfaceFontWeight: 300,
  codeFontFamily: "jetbrains-mono",
  codeFontSize: 13,
  codeFontWeight: 400,
  codeWordWrap: false,
  terminalFontFamily: "jetbrains-mono",
  terminalFontSize: 12,
  terminalFontWeight: 400,
  terminalWrap: true,
  readingLineHeight: 1.5,
};

export const UI_FONTS: readonly UIFontDefinition[] = [
  {
    id: "inter",
    label: "Inter (Default)",
    stack:
      '"Inter Variable", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    rendererFamily: "Inter Variable",
    category: "sans",
    weights: "continuous",
    minWeight: 100,
    maxWeight: 900,
  },
  {
    id: "sf-pro",
    label: "SF Pro / Apple System",
    stack:
      '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif',
    rendererFamily: "SF Pro Display",
    category: "sans",
    weights: "continuous",
    minWeight: 100,
    maxWeight: 900,
  },
  {
    id: "roboto",
    label: "Roboto",
    stack: '"Roboto Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    rendererFamily: "Roboto Variable",
    category: "sans",
    weights: "continuous",
    minWeight: 100,
    maxWeight: 900,
  },
  {
    id: "open-sans",
    label: "Open Sans",
    stack: '"Open Sans Variable", -apple-system, BlinkMacSystemFont, sans-serif',
    rendererFamily: "Open Sans Variable",
    category: "sans",
    weights: "continuous",
    minWeight: 300,
    maxWeight: 800,
  },
  {
    id: "source-sans-3",
    label: "Source Sans 3",
    stack: '"Source Sans 3 Variable", -apple-system, BlinkMacSystemFont, sans-serif',
    rendererFamily: "Source Sans 3 Variable",
    category: "sans",
    weights: "continuous",
    minWeight: 200,
    maxWeight: 900,
  },
  {
    id: "plus-jakarta-sans",
    label: "Plus Jakarta Sans",
    stack: '"Plus Jakarta Sans Variable", -apple-system, BlinkMacSystemFont, sans-serif',
    rendererFamily: "Plus Jakarta Sans Variable",
    category: "sans",
    weights: "continuous",
    minWeight: 200,
    maxWeight: 800,
  },
  {
    id: "outfit",
    label: "Outfit",
    stack: '"Outfit Variable", -apple-system, BlinkMacSystemFont, sans-serif',
    rendererFamily: "Outfit Variable",
    category: "sans",
    weights: "continuous",
    minWeight: 100,
    maxWeight: 900,
  },
  {
    id: "figtree",
    label: "Figtree",
    stack: '"Figtree Variable", -apple-system, BlinkMacSystemFont, sans-serif',
    rendererFamily: "Figtree Variable",
    category: "sans",
    weights: "continuous",
    minWeight: 300,
    maxWeight: 900,
  },
  {
    id: "lato",
    label: "Lato",
    stack: '"Lato", -apple-system, BlinkMacSystemFont, sans-serif',
    rendererFamily: "Lato",
    category: "sans",
    weights: [100, 300, 400, 700, 900],
  },
  {
    id: "system",
    label: "System Sans",
    stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    rendererFamily: "system-ui",
    category: "sans",
    weights: "continuous",
    minWeight: 100,
    maxWeight: 900,
  },
] as const;

export const MONO_FONTS: readonly FontDefinition[] = [
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono (Default)",
    stack:
      '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    category: "mono",
    weights: "continuous",
    minWeight: 100,
    maxWeight: 800,
  },
  {
    id: "fira-code",
    label: "Fira Code",
    stack: '"Fira Code Variable", ui-monospace, monospace',
    category: "mono",
    weights: "continuous",
    minWeight: 300,
    maxWeight: 700,
  },
  {
    id: "source-code-pro",
    label: "Source Code Pro",
    stack: '"Source Code Pro Variable", ui-monospace, monospace',
    category: "mono",
    weights: "continuous",
    minWeight: 200,
    maxWeight: 900,
  },
  {
    id: "sf-mono",
    label: "SF Mono / Consolas",
    stack: '"SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
    category: "mono",
    weights: "continuous",
    minWeight: 100,
    maxWeight: 900,
  },
  {
    id: "system-mono",
    label: "System Monospace",
    stack:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    category: "mono",
    weights: "continuous",
    minWeight: 100,
    maxWeight: 900,
  },
] as const;

export const COMMON_WEIGHTS = [
  { value: 100, label: "100 - Thin" },
  { value: 200, label: "200 - Extra Light" },
  { value: 300, label: "300 - Light" },
  { value: 400, label: "400 - Regular" },
  { value: 500, label: "500 - Medium" },
  { value: 600, label: "600 - Semi Bold" },
  { value: 700, label: "700 - Bold" },
  { value: 800, label: "800 - Extra Bold" },
  { value: 900, label: "900 - Black" },
] as const;

export const INTERFACE_FONT_SIZE_CONFIG = {
  min: 12,
  max: 24,
  default: 15,
};

export const CODE_FONT_SIZE_CONFIG = {
  min: 11,
  max: 20,
  default: 13,
};

export const TERMINAL_FONT_SIZE_CONFIG = {
  min: 10,
  max: 20,
  default: 12,
};

export const LINE_HEIGHTS = [
  { id: "compact", value: 1.35, label: "Compact (1.35)" },
  { id: "balanced", value: 1.5, label: "Balanced (1.5 - Default)" },
  { id: "relaxed", value: 1.65, label: "Relaxed (1.65)" },
] as const;

const STORAGE_KEY = "tbai-typography";

// Minimal typed external store subscription for Interface Font changes only.
// Used by components that need to re-render when the primary interface font changes (e.g. Mermaid).
type FontListener = (fontId: string) => void;
const fontListeners = new Set<FontListener>();

// Initialized strictly from persisted configuration on startup so initial state matches storage.
let lastNotifiedFontId: string | null = null;

export function subscribeInterfaceFont(listener: FontListener): () => void {
  fontListeners.add(listener);
  return () => {
    fontListeners.delete(listener);
  };
}

export function getFont(id: string): FontDefinition | undefined {
  return UI_FONTS.find((f) => f.id === id) || MONO_FONTS.find((f) => f.id === id);
}

/**
 * Clamps a desired weight to the nearest supported native weight for a given font.
 */
export function clampWeightForFont(weight: number, font: FontDefinition): number {
  if (font.weights === "continuous") {
    const min = font.minWeight ?? 100;
    const max = font.maxWeight ?? 900;
    return Math.max(min, Math.min(max, weight));
  }
  // Discrete static weights: find the closest weight in the array
  const weights = font.weights;
  if (!weights.length) return 400;
  return weights.reduce((prev, curr) =>
    Math.abs(curr - weight) < Math.abs(prev - weight) ? curr : prev,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 100 && value <= 900;
}

function isValidRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isValidUiFontId(value: unknown): value is string {
  return typeof value === "string" && UI_FONTS.some((f) => f.id === value);
}

/**
 * Resolves a stored interface font size. A value outside 12-24 is discarded to the
 * default, exactly as before.
 */
function normalizeInterfaceFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TYPOGRAPHY.interfaceFontSize;
  }
  if (value < INTERFACE_FONT_SIZE_CONFIG.min || value > INTERFACE_FONT_SIZE_CONFIG.max) {
    return DEFAULT_TYPOGRAPHY.interfaceFontSize;
  }
  return value;
}

function isValidMonoFontId(value: unknown): value is string {
  return typeof value === "string" && MONO_FONTS.some((f) => f.id === value);
}

/**
 * Migrates a v1 record (either historical shape) to v2.
 *
 * `baseSize` (12–24px) maps to `appScale` as `baseSize / 16`. Every legacy
 * value is a sixteenth and exactly representable in binary floating point, so
 * the conversion is lossless: 13 → 0.8125 (81.25%), 14 → 0.875 (87.5%),
 * 15 → 0.9375 (93.75%), 18 → 1.125 (112.5%).
 */
function migrateV1(parsed: Record<string, unknown>): TypographyConfig {
  const legacyBase = isValidRange(parsed.baseSize, 12, 24)
    ? parsed.baseSize
    : DEFAULT_TYPOGRAPHY.interfaceFontSize;

  const legacyWeight = isValidWeight(parsed.fontWeight)
    ? parsed.fontWeight
    : DEFAULT_TYPOGRAPHY.interfaceFontWeight;

  const legacyMonoWeight = isValidWeight(parsed.monoFontWeight)
    ? parsed.monoFontWeight
    : isValidWeight(parsed.fontWeight)
      ? parsed.fontWeight
      : DEFAULT_TYPOGRAPHY.codeFontWeight;

  const uiFont = (isValidUiFontId(parsed.fontFamily) && getFont(parsed.fontFamily)) || UI_FONTS[0]!;
  const codeFont =
    (isValidMonoFontId(parsed.monoFontFamily) && getFont(parsed.monoFontFamily)) || MONO_FONTS[0]!;

  return {
    version: 3,
    interfaceFontFamily: uiFont.id,
    interfaceFontSize: legacyBase,
    interfaceFontWeight: clampWeightForFont(legacyWeight, uiFont),
    codeFontFamily: codeFont.id,
    codeFontSize: isValidRange(
      parsed.codeFontSize,
      CODE_FONT_SIZE_CONFIG.min,
      CODE_FONT_SIZE_CONFIG.max,
    )
      ? parsed.codeFontSize
      : DEFAULT_TYPOGRAPHY.codeFontSize,
    codeFontWeight: clampWeightForFont(legacyMonoWeight, codeFont),
    codeWordWrap: false,
    terminalFontFamily: DEFAULT_TYPOGRAPHY.terminalFontFamily,
    terminalFontSize: DEFAULT_TYPOGRAPHY.terminalFontSize,
    terminalFontWeight: DEFAULT_TYPOGRAPHY.terminalFontWeight,
    terminalWrap: DEFAULT_TYPOGRAPHY.terminalWrap,
    readingLineHeight: isValidRange(parsed.lineHeight, 1.2, 2.0)
      ? parsed.lineHeight
      : DEFAULT_TYPOGRAPHY.readingLineHeight,
  };
}

function migrateV2(parsed: Record<string, unknown>): TypographyConfig {
  const normUi = normalizeInterfaceFontSize(parsed.interfaceFontSize);
  const appScale = isValidRange(parsed.appScale, 0.75, 1.5) ? parsed.appScale : 1;
  const effectiveSize = Math.min(24, Math.max(12, Math.round(normUi * appScale)));

  const uiFont =
    (isValidUiFontId(parsed.interfaceFontFamily) && getFont(parsed.interfaceFontFamily)) ||
    UI_FONTS[0]!;
  const codeFont =
    (isValidMonoFontId(parsed.codeFontFamily) && getFont(parsed.codeFontFamily)) || MONO_FONTS[0]!;
  const terminalFont =
    (isValidMonoFontId(parsed.terminalFontFamily) && getFont(parsed.terminalFontFamily)) ||
    MONO_FONTS[0]!;

  const reqUiWeight = isValidWeight(parsed.interfaceFontWeight)
    ? parsed.interfaceFontWeight
    : DEFAULT_TYPOGRAPHY.interfaceFontWeight;
  const reqCodeWeight = isValidWeight(parsed.codeFontWeight)
    ? parsed.codeFontWeight
    : DEFAULT_TYPOGRAPHY.codeFontWeight;
  const reqTermWeight = isValidWeight(parsed.terminalFontWeight)
    ? parsed.terminalFontWeight
    : DEFAULT_TYPOGRAPHY.terminalFontWeight;

  return {
    version: 3,
    interfaceFontFamily: uiFont.id,
    interfaceFontSize: effectiveSize,
    interfaceFontWeight: clampWeightForFont(reqUiWeight, uiFont),
    codeFontFamily: codeFont.id,
    codeFontSize: isValidRange(
      parsed.codeFontSize,
      CODE_FONT_SIZE_CONFIG.min,
      CODE_FONT_SIZE_CONFIG.max,
    )
      ? parsed.codeFontSize
      : DEFAULT_TYPOGRAPHY.codeFontSize,
    codeFontWeight: clampWeightForFont(reqCodeWeight, codeFont),
    codeWordWrap: parsed.codeWordWrap === true,
    terminalFontFamily: terminalFont.id,
    terminalFontSize: isValidRange(
      parsed.terminalFontSize,
      TERMINAL_FONT_SIZE_CONFIG.min,
      TERMINAL_FONT_SIZE_CONFIG.max,
    )
      ? parsed.terminalFontSize
      : DEFAULT_TYPOGRAPHY.terminalFontSize,
    terminalFontWeight: clampWeightForFont(reqTermWeight, terminalFont),
    terminalWrap:
      typeof parsed.terminalWrap === "boolean"
        ? parsed.terminalWrap
        : DEFAULT_TYPOGRAPHY.terminalWrap,
    readingLineHeight: isValidRange(parsed.readingLineHeight, 1.2, 2.0)
      ? parsed.readingLineHeight
      : DEFAULT_TYPOGRAPHY.readingLineHeight,
  };
}

function readV3(parsed: Record<string, unknown>): TypographyConfig {
  const uiFont =
    (isValidUiFontId(parsed.interfaceFontFamily) && getFont(parsed.interfaceFontFamily)) ||
    UI_FONTS[0]!;
  const codeFont =
    (isValidMonoFontId(parsed.codeFontFamily) && getFont(parsed.codeFontFamily)) || MONO_FONTS[0]!;
  const terminalFont =
    (isValidMonoFontId(parsed.terminalFontFamily) && getFont(parsed.terminalFontFamily)) ||
    MONO_FONTS[0]!;

  const reqUiWeight = isValidWeight(parsed.interfaceFontWeight)
    ? parsed.interfaceFontWeight
    : DEFAULT_TYPOGRAPHY.interfaceFontWeight;
  const reqCodeWeight = isValidWeight(parsed.codeFontWeight)
    ? parsed.codeFontWeight
    : DEFAULT_TYPOGRAPHY.codeFontWeight;
  const reqTermWeight = isValidWeight(parsed.terminalFontWeight)
    ? parsed.terminalFontWeight
    : DEFAULT_TYPOGRAPHY.terminalFontWeight;

  return {
    version: 3,
    interfaceFontFamily: uiFont.id,
    interfaceFontSize: normalizeInterfaceFontSize(parsed.interfaceFontSize),
    interfaceFontWeight: clampWeightForFont(reqUiWeight, uiFont),
    codeFontFamily: codeFont.id,
    codeFontSize: isValidRange(
      parsed.codeFontSize,
      CODE_FONT_SIZE_CONFIG.min,
      CODE_FONT_SIZE_CONFIG.max,
    )
      ? parsed.codeFontSize
      : DEFAULT_TYPOGRAPHY.codeFontSize,
    codeFontWeight: clampWeightForFont(reqCodeWeight, codeFont),
    codeWordWrap:
      typeof parsed.codeWordWrap === "boolean"
        ? parsed.codeWordWrap
        : DEFAULT_TYPOGRAPHY.codeWordWrap,
    terminalFontFamily: terminalFont.id,
    terminalFontSize: isValidRange(
      parsed.terminalFontSize,
      TERMINAL_FONT_SIZE_CONFIG.min,
      TERMINAL_FONT_SIZE_CONFIG.max,
    )
      ? parsed.terminalFontSize
      : DEFAULT_TYPOGRAPHY.terminalFontSize,
    terminalFontWeight: clampWeightForFont(reqTermWeight, terminalFont),
    terminalWrap:
      typeof parsed.terminalWrap === "boolean"
        ? parsed.terminalWrap
        : DEFAULT_TYPOGRAPHY.terminalWrap,
    readingLineHeight: isValidRange(parsed.readingLineHeight, 1.2, 2.0)
      ? parsed.readingLineHeight
      : DEFAULT_TYPOGRAPHY.readingLineHeight,
  };
}

export function migrateTypography(raw: unknown): TypographyConfig {
  if (!isRecord(raw)) return DEFAULT_TYPOGRAPHY;
  if (raw.version === 3) return readV3(raw);
  if (raw.version === 2) return migrateV2(raw);
  return migrateV1(raw);
}

/**
 * Safely reads typography configuration from localStorage.
 * Handles v1 configurations (both historical shapes) and v2 configurations by migrating to v3.
 */
export function readTypography(): TypographyConfig {
  if (typeof window === "undefined") return DEFAULT_TYPOGRAPHY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      if (lastNotifiedFontId === null) {
        lastNotifiedFontId = DEFAULT_TYPOGRAPHY.interfaceFontFamily;
      }
      return DEFAULT_TYPOGRAPHY;
    }
    const parsed: unknown = JSON.parse(raw);
    const config = migrateTypography(parsed);
    // Initialize baseline tracking to the active interface font so migration doesn't falsely notify
    if (lastNotifiedFontId === null) {
      lastNotifiedFontId = config.interfaceFontFamily;
    }
    // If parsed was not already v3, persist migrated v3 once for idempotence
    if (isRecord(parsed) && parsed.version !== 3) {
      writeTypography(config);
    }
    return config;
  } catch {
    if (lastNotifiedFontId === null) {
      lastNotifiedFontId = DEFAULT_TYPOGRAPHY.interfaceFontFamily;
    }
    return DEFAULT_TYPOGRAPHY;
  }
}

/**
 * Safely writes typography configuration to localStorage.
 */
export function writeTypography(config: TypographyConfig): void {
  const newFont = config.interfaceFontFamily;
  const fontChanged = lastNotifiedFontId !== null ? newFont !== lastNotifiedFontId : false;
  lastNotifiedFontId = newFont;

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      /* storage unavailable — live listeners still get notified */
    }
  }

  if (fontChanged) {
    for (const listener of fontListeners) {
      try {
        listener(newFont);
      } catch {
        /* listener error ignored */
      }
    }
  }
}

/**
 * Applies typography configuration directly to the document root element.
 * Never writes `--font-mono` — that is the fixed generic monospace stack.
 */
export function applyTypographyToDom(config: TypographyConfig): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  // Resolve fonts
  const uiFont =
    getFont(config.interfaceFontFamily) || getFont(DEFAULT_TYPOGRAPHY.interfaceFontFamily);
  const codeFont = getFont(config.codeFontFamily) || getFont(DEFAULT_TYPOGRAPHY.codeFontFamily);
  const terminalFont =
    getFont(config.terminalFontFamily) || getFont(DEFAULT_TYPOGRAPHY.terminalFontFamily);

  if (uiFont) root.style.setProperty("--font-sans", uiFont.stack);

  // Single Interface Size drives root font-size directly via rem scaling!
  root.style.fontSize = `${(config.interfaceFontSize / 16) * 100}%`;

  const clampedUiWeight = uiFont
    ? clampWeightForFont(config.interfaceFontWeight, uiFont)
    : config.interfaceFontWeight;
  root.style.setProperty("--font-weight-base", String(clampedUiWeight));

  if (codeFont) root.style.setProperty("--code-font-family", codeFont.stack);
  root.style.setProperty("--code-font-size", `${config.codeFontSize}px`);
  const clampedCodeWeight = codeFont
    ? clampWeightForFont(config.codeFontWeight, codeFont)
    : config.codeFontWeight;
  root.style.setProperty("--code-font-weight", String(clampedCodeWeight));

  if (terminalFont) root.style.setProperty("--terminal-font-family", terminalFont.stack);
  root.style.setProperty("--terminal-font-size", `${config.terminalFontSize}px`);
  const clampedTerminalWeight = terminalFont
    ? clampWeightForFont(config.terminalFontWeight, terminalFont)
    : config.terminalFontWeight;
  root.style.setProperty("--terminal-font-weight", String(clampedTerminalWeight));

  root.style.setProperty("--reading-line-height", String(config.readingLineHeight));

  // No application-level zoom writers!
  root.style.removeProperty("zoom");

  root.setAttribute("data-code-wrap", config.codeWordWrap ? "on" : "off");
  root.setAttribute("data-terminal-wrap", config.terminalWrap ? "on" : "off");
}

function persist(updated: TypographyConfig): TypographyConfig {
  writeTypography(updated);
  applyTypographyToDom(updated);
  return updated;
}

/**
 * Scoped reset: restores Interface Typography defaults, preserving all other groups.
 */
export function resetInterfaceTypography(current: TypographyConfig): TypographyConfig {
  return persist({
    ...current,
    interfaceFontFamily: DEFAULT_TYPOGRAPHY.interfaceFontFamily,
    interfaceFontSize: DEFAULT_TYPOGRAPHY.interfaceFontSize,
    interfaceFontWeight: DEFAULT_TYPOGRAPHY.interfaceFontWeight,
  });
}

/**
 * Scoped reset: restores Code Typography defaults, preserving all other groups.
 */
export function resetCodeTypography(current: TypographyConfig): TypographyConfig {
  return persist({
    ...current,
    codeFontFamily: DEFAULT_TYPOGRAPHY.codeFontFamily,
    codeFontSize: DEFAULT_TYPOGRAPHY.codeFontSize,
    codeFontWeight: DEFAULT_TYPOGRAPHY.codeFontWeight,
    codeWordWrap: DEFAULT_TYPOGRAPHY.codeWordWrap,
  });
}

/**
 * Scoped reset: restores Terminal Typography defaults, preserving all other groups.
 */
export function resetTerminalTypography(current: TypographyConfig): TypographyConfig {
  return persist({
    ...current,
    terminalFontFamily: DEFAULT_TYPOGRAPHY.terminalFontFamily,
    terminalFontSize: DEFAULT_TYPOGRAPHY.terminalFontSize,
    terminalFontWeight: DEFAULT_TYPOGRAPHY.terminalFontWeight,
    terminalWrap: DEFAULT_TYPOGRAPHY.terminalWrap,
  });
}

/**
 * Scoped reset: restores Reading Typography defaults, preserving all other groups.
 */
export function resetReadingTypography(current: TypographyConfig): TypographyConfig {
  return persist({
    ...current,
    readingLineHeight: DEFAULT_TYPOGRAPHY.readingLineHeight,
  });
}

/**
 * Master reset: resets typography configuration to factory defaults.
 */
export function resetTypography(): TypographyConfig {
  return persist(DEFAULT_TYPOGRAPHY);
}
