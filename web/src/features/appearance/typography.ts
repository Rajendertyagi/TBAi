/**
 * Typography configuration, storage, and DOM application for TBAi.
 *
 * Follows the existing theme-storage.ts and theme-dom.ts conventions:
 * - Single persistent JSON object under `tbai-typography`
 * - Resilient total reads falling back safely to defaults
 * - Single framework-free DOM applicator writing root CSS custom properties and zoom
 */

export interface TypographyConfig {
  version: 1;
  fontFamily: string;
  monoFontFamily: string;
  fontWeight: number;
  baseSize: number;
  lineHeight: number;
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

export const DEFAULT_TYPOGRAPHY: TypographyConfig = {
  version: 1,
  fontFamily: "inter",
  monoFontFamily: "jetbrains-mono",
  fontWeight: 400,
  baseSize: 16,
  lineHeight: 1.5,
};

export const UI_FONTS: readonly FontDefinition[] = [
  {
    id: "inter",
    label: "Inter (Default)",
    stack:
      '"Inter Variable", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
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
    category: "sans",
    weights: "continuous",
    minWeight: 100,
    maxWeight: 900,
  },
  {
    id: "roboto",
    label: "Roboto",
    stack: '"Roboto Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    category: "sans",
    weights: "continuous",
    minWeight: 100,
    maxWeight: 900,
  },
  {
    id: "open-sans",
    label: "Open Sans",
    stack: '"Open Sans Variable", -apple-system, BlinkMacSystemFont, sans-serif',
    category: "sans",
    weights: "continuous",
    minWeight: 300,
    maxWeight: 800,
  },
  {
    id: "source-sans-3",
    label: "Source Sans 3",
    stack: '"Source Sans 3 Variable", -apple-system, BlinkMacSystemFont, sans-serif',
    category: "sans",
    weights: "continuous",
    minWeight: 200,
    maxWeight: 900,
  },
  {
    id: "plus-jakarta-sans",
    label: "Plus Jakarta Sans",
    stack: '"Plus Jakarta Sans Variable", -apple-system, BlinkMacSystemFont, sans-serif',
    category: "sans",
    weights: "continuous",
    minWeight: 200,
    maxWeight: 800,
  },
  {
    id: "outfit",
    label: "Outfit",
    stack: '"Outfit Variable", -apple-system, BlinkMacSystemFont, sans-serif',
    category: "sans",
    weights: "continuous",
    minWeight: 100,
    maxWeight: 900,
  },
  {
    id: "figtree",
    label: "Figtree",
    stack: '"Figtree Variable", -apple-system, BlinkMacSystemFont, sans-serif',
    category: "sans",
    weights: "continuous",
    minWeight: 300,
    maxWeight: 900,
  },
  {
    id: "lato",
    label: "Lato",
    stack: '"Lato", -apple-system, BlinkMacSystemFont, sans-serif',
    category: "sans",
    weights: [100, 300, 400, 700, 900],
  },
  {
    id: "system",
    label: "System Sans",
    stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
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

export const SCALE_CONFIG = {
  min: 12,
  max: 24,
  default: 16,
  presets: [13, 14, 15, 16, 18, 20] as const,
};

export const LINE_HEIGHTS = [
  { id: "compact", value: 1.35, label: "Compact (1.35)" },
  { id: "balanced", value: 1.5, label: "Balanced (1.5 - Default)" },
  { id: "relaxed", value: 1.65, label: "Relaxed (1.65)" },
] as const;

const STORAGE_KEY = "tbai-typography";

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

/**
 * Safely reads typography configuration from localStorage.
 */
export function readTypography(): TypographyConfig {
  if (typeof window === "undefined") return DEFAULT_TYPOGRAPHY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TYPOGRAPHY;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_TYPOGRAPHY;

    const fontFamily = UI_FONTS.some((f) => f.id === parsed.fontFamily)
      ? parsed.fontFamily
      : DEFAULT_TYPOGRAPHY.fontFamily;
    const monoFontFamily = MONO_FONTS.some((f) => f.id === parsed.monoFontFamily)
      ? parsed.monoFontFamily
      : DEFAULT_TYPOGRAPHY.monoFontFamily;
    const fontWeight =
      typeof parsed.fontWeight === "number" && parsed.fontWeight >= 100 && parsed.fontWeight <= 900
        ? parsed.fontWeight
        : DEFAULT_TYPOGRAPHY.fontWeight;
    const baseSize =
      typeof parsed.baseSize === "number" &&
      parsed.baseSize >= SCALE_CONFIG.min &&
      parsed.baseSize <= SCALE_CONFIG.max
        ? parsed.baseSize
        : DEFAULT_TYPOGRAPHY.baseSize;
    const lineHeight =
      typeof parsed.lineHeight === "number" && parsed.lineHeight >= 1.2 && parsed.lineHeight <= 2.0
        ? parsed.lineHeight
        : DEFAULT_TYPOGRAPHY.lineHeight;

    return {
      version: 1,
      fontFamily,
      monoFontFamily,
      fontWeight,
      baseSize,
      lineHeight,
    };
  } catch {
    return DEFAULT_TYPOGRAPHY;
  }
}

/**
 * Safely writes typography configuration to localStorage.
 */
export function writeTypography(config: TypographyConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Applies typography configuration directly to the document root element.
 */
export function applyTypographyToDom(config: TypographyConfig): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  // Resolve fonts
  const uiFont = getFont(config.fontFamily) || getFont(DEFAULT_TYPOGRAPHY.fontFamily);
  const monoFont = getFont(config.monoFontFamily) || getFont(DEFAULT_TYPOGRAPHY.monoFontFamily);

  if (uiFont) root.style.setProperty("--font-sans", uiFont.stack);
  if (monoFont) root.style.setProperty("--font-mono", monoFont.stack);

  // Clamped weight calculation
  const clampedWeight = uiFont ? clampWeightForFont(config.fontWeight, uiFont) : config.fontWeight;
  root.style.setProperty("--font-weight-base", String(clampedWeight));

  // Line height
  root.style.setProperty("--font-line-height", String(config.lineHeight));

  // Application scale / zoom (16px base = 100% zoom)
  const scale = config.baseSize / 16;
  if (scale === 1) {
    root.style.removeProperty("zoom");
  } else {
    // Note: TypeScript CSSStyleDeclaration may not type zoom directly in all standard libs
    (root.style as unknown as Record<string, string>).zoom = String(scale);
  }
}

/**
 * Resets typography configuration to factory defaults.
 */
export function resetTypography(): TypographyConfig {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
  applyTypographyToDom(DEFAULT_TYPOGRAPHY);
  return DEFAULT_TYPOGRAPHY;
}
