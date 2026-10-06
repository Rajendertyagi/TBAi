/**
 * Colour parsing, conversion and derivation for the theme generator.
 *
 * WHY OKLab AND OKLCH, NOT HEX.
 *
 * Two reasons, one correctness and one quality.
 *
 * Correctness: every contrast guarantee in this theme system is only worth
 * anything if the checker can read every colour the app can render. The
 * stylesheet's own dark palette is authored in `oklch()`, and a parser that
 * cannot read `oklch` silently skips half the default theme — which is exactly
 * what happened: Classic dark was never measured, and nothing complained.
 *
 * Quality: `mix()` blends two colours, and the generator uses it to nudge a
 * value toward its target. Blending in sRGB is not perceptually even — a
 * halfway blend between two colours of the same lightness lands on a visibly
 * different lightness depending on hue. Blending in OKLab is, which is the whole
 * reason OKLab exists. shadcn and Tailwind v4 both author in oklch for this
 * reason, so emitting hex here would have been the odd one out.
 *
 * Contrast itself is still computed the WCAG way, in linear sRGB, because that
 * is what the thresholds are defined against. OKLab is used for *blending*,
 * never for *measuring* — those are different jobs and mixing them up is how
 * contrast maths ends up subtly wrong.
 *
 * Matrices are Björn Ottosson's published linear-sRGB <-> OKLab constants.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface Oklab {
  L: number;
  a: number;
  b: number;
  alpha: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const clamp255 = (n: number) => clamp(n, 0, 255);
const clamp01 = (n: number) => clamp(n, 0, 1);

// --- transfer functions ----------------------------------------------------

/** sRGB channel (0–255) to linear-light (0–1). */
function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear-light (0–1) to sRGB channel (0–255). */
function linearToSrgb(linear: number): number {
  const c = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return c * 255;
}

// --- OKLab -----------------------------------------------------------------

function linearToOklab(r: number, g: number, b: number): { L: number; a: number; b: number } {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToLinear(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

// --- parsing ---------------------------------------------------------------

const HEX = /^#([0-9a-f]{3,8})$/i;
const FN_RGB = /^rgba?\(([^)]*)\)$/i;
const FN_HSL = /^hsla?\(([^)]*)\)$/i;
const FN_OKLCH = /^oklch\(([^)]*)\)$/i;
const FN_OKLAB = /^oklab\(([^)]*)\)$/i;

/** Split `1 2 3 / 50%` into three components and an alpha. */
function components(body: string): { parts: string[]; alpha: number } | null {
  const [head, tail] = body.includes("/") ? body.split("/") : [body, null];
  const parts = head.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  let alpha = 1;
  if (tail !== null) {
    const t = tail.trim();
    alpha = t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t);
  } else if (parts.length >= 4) {
    const t = parts[3];
    alpha = t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t);
  }
  return { parts, alpha: Number.isNaN(alpha) ? 1 : clamp01(alpha) };
}

/** Lightness: `0.5` or `50%` both mean the same thing. */
function lightness(token: string): number {
  const t = token.trim();
  const n = parseFloat(t);
  if (Number.isNaN(n)) return 0;
  return t.endsWith("%") ? n / 100 : n;
}

/** Chroma: `0.1` or `25%` (percentages are relative to 0.4 per CSS Color 4). */
function chroma(token: string): number {
  const t = token.trim();
  const n = parseFloat(t);
  if (Number.isNaN(n)) return 0;
  return t.endsWith("%") ? (n / 100) * 0.4 : n;
}

function hue(token: string): number {
  const n = parseFloat(token);
  if (Number.isNaN(n)) return 0;
  const deg = token.trim().endsWith("deg") ? n : parseFloat(token);
  return ((deg % 360) + 360) % 360;
}

/**
 * Parse any colour syntax the app or a palette can contain.
 *
 * Returns `null` for genuinely unknown syntax rather than guessing. `null` is
 * meaningful to every caller: it means "cannot measure this", and each one has a
 * documented fallback — which is the whole reason the parser never invents a
 * value.
 */
export function parseColor(input: string | undefined | null): Rgb | null {
  if (!input) return null;
  const value = input.trim();
  if (!value || value === "transparent") return null;

  const hex = HEX.exec(value);
  if (hex) {
    const h = hex[1];
    const expand = (s: string) => s.split("").map((c) => c + c).join("");
    if (h.length === 3 || h.length === 4) {
      const e = expand(h);
      return {
        r: parseInt(e.slice(0, 2), 16),
        g: parseInt(e.slice(2, 4), 16),
        b: parseInt(e.slice(4, 6), 16),
        a: h.length === 4 ? parseInt(e.slice(6, 8), 16) / 255 : 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }

  const rgb = FN_RGB.exec(value);
  if (rgb) {
    const c = components(rgb[1]);
    if (!c) return null;
    return {
      r: clamp255(parseFloat(c.parts[0])),
      g: clamp255(parseFloat(c.parts[1])),
      b: clamp255(parseFloat(c.parts[2])),
      a: c.alpha,
    };
  }

  const hsl = FN_HSL.exec(value);
  if (hsl) {
    const c = components(hsl[1]);
    if (!c) return null;
    const h = hue(c.parts[0]) / 30;
    const sat = clamp01(parseFloat(c.parts[1]) / 100);
    const l = clamp01(parseFloat(c.parts[2]) / 100);
    const chromaValue = (1 - Math.abs(2 * l - 1)) * sat;
    const x = chromaValue * (1 - Math.abs((h % 2) - 1));
    const m = l - chromaValue / 2;
    const table: Array<[number, number, number]> = [
      [chromaValue, x, 0],
      [x, chromaValue, 0],
      [0, chromaValue, x],
      [0, x, chromaValue],
      [x, 0, chromaValue],
      [chromaValue, 0, x],
    ];
    const [r1, g1, b1] = table[Math.floor(h) % 6];
    return { r: clamp255((r1 + m) * 255), g: clamp255((g1 + m) * 255), b: clamp255((b1 + m) * 255), a: c.alpha };
  }

  const oklch = FN_OKLCH.exec(value);
  if (oklch) {
    const c = components(oklch[1]);
    if (!c) return null;
    const L = lightness(c.parts[0]);
    const C = chroma(c.parts[1]);
    const H = (hue(c.parts[2]) * Math.PI) / 180;
    return oklabToRgb(L, C * Math.cos(H), C * Math.sin(H), c.alpha);
  }

  const oklab = FN_OKLAB.exec(value);
  if (oklab) {
    const c = components(oklab[1]);
    if (!c) return null;
    return oklabToRgb(lightness(c.parts[0]), chroma(c.parts[1]), chroma(c.parts[2]), c.alpha);
  }

  return null;
}

function oklabToRgb(L: number, a: number, b: number, alpha: number): Rgb {
  const { r, g, b: bl } = oklabToLinear(L, a, b);
  // OKLab covers colours wider than sRGB, so a conversion can land outside the
  // display gamut. Clamping matches what the browser will do with the same
  // declaration, which is the behaviour we want: the generator predicts the
  // rendered result rather than a mathematical ideal the screen cannot show.
  return { r: clamp255(linearToSrgb(r)), g: clamp255(linearToSrgb(g)), b: clamp255(linearToSrgb(bl)), a: alpha };
}

// --- formatting ------------------------------------------------------------

function rgbToOklab(c: Rgb): Oklab {
  const { L, a, b } = linearToOklab(
    srgbToLinear(c.r),
    srgbToLinear(c.g),
    srgbToLinear(c.b),
  );
  return { L, a, b, alpha: c.a };
}

function oklabToRgbRoundtrip(lab: Oklab): Rgb {
  return oklabToRgb(lab.L, lab.a, lab.b, lab.alpha);
}

/**
 * Serialise as `oklch()`, the format shadcn and Tailwind v4 author in.
 *
 * Precision is trimmed to what is visually stable — four decimals of lightness
 * is far below a perceptible step — so the generated stylesheet stays readable
 * and diffs stay small.
 */
export function formatColor(color: string | Rgb): string {
  const c = typeof color === "string" ? parseColor(color) : color;
  if (!c) return String(color);
  const { L, a, b, alpha } = rgbToOklab(c);
  const C = Math.sqrt(a * a + b * b);
  // Hue is meaningless for a neutral (chroma ~0) and is unstable there, so it is
  // dropped rather than emitted as noise that would churn every diff.
  const H = C < 1e-6 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  const l = Number(L.toFixed(4));
  const chromaOut = Number(C.toFixed(4));
  const alphaOut = Number(alpha.toFixed(3));
  const core = `oklch(${l} ${chromaOut} ${C < 1e-6 ? 0 : Number(H.toFixed(1))}`;
  return alphaOut >= 1 ? `${core})` : `${core} / ${alphaOut})`;
}

// --- contrast --------------------------------------------------------------

/** WCAG relative luminance. Linear sRGB, because that is what WCAG defines. */
export function relativeLuminance(color: Rgb): number {
  return (
    0.2126 * srgbToLinear(color.r) +
    0.7152 * srgbToLinear(color.g) +
    0.0722 * srgbToLinear(color.b)
  );
}

/** WCAG contrast ratio, 1–21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Pick whichever candidate reads best on `background`.
 *
 * Used only where a colour has no identity to preserve — a foreground whose
 * palette value was missing. It returns black or white for a saturated input,
 * which is why it must NOT be used for something that has to *be* a colour; see
 * `theme-css.ts`'s `ensureForeground` for that case.
 */
export function readableForeground(
  background: string,
  candidates: readonly string[],
  fallback: string,
): string {
  const bg = parseColor(background);
  if (!bg) return fallback;
  const usable = candidates.map(parseColor).filter((c): c is Rgb => c !== null);
  if (usable.length === 0) return fallback;
  let best = usable[0];
  let bestRatio = contrastRatio(bg, best);
  for (const candidate of usable.slice(1)) {
    const ratio = contrastRatio(bg, candidate);
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
  }
  return candidates[usable.indexOf(best)] ?? fallback;
}

// --- derivation ------------------------------------------------------------

/**
 * Blend `color` toward `target` by `amount` (0–1), in OKLab.
 *
 * Blending in OKLab rather than sRGB is what keeps a halfway mix at the halfway
 * *perceived* lightness. In sRGB, halfway between a blue and a yellow passes
 * through a noticeably darker or lighter midpoint depending on hue; in OKLab it
 * does not. The generator leans on this constantly — nudging a fill toward the
 * foreground by a few percent — so a muddy midpoint would show up as every
 * derived colour looking slightly wrong in a way that is hard to name.
 *
 * Returns the input unchanged when either side cannot be parsed.
 */
export function mix(color: string, target: string, amount: number): string {
  const a = parseColor(color);
  const b = parseColor(target);
  if (!a || !b) return color;
  const t = clamp01(amount);
  const from = rgbToOklab(a);
  const to = rgbToOklab(b);
  // Alpha is interpolated too: compositing twice must not re-solidify a tint.
  const alpha = from.alpha + (to.alpha - from.alpha) * t;
  return formatColor(
    oklabToRgbRoundtrip({
      L: from.L + (to.L - from.L) * t,
      a: from.a + (to.a - from.a) * t,
      b: from.b + (to.b - from.b) * t,
      alpha,
    }),
  );
}

/** Re-alpha a colour. The original alpha is multiplied, not replaced. */
export function withAlpha(color: string, alpha: number): string {
  const parsed = parseColor(color);
  if (!parsed) return color;
  return formatColor({ ...parsed, a: clamp01(parsed.a * clamp01(alpha)) });
}

/**
 * Composite a possibly-translucent `color` over an opaque `base`, opaque result.
 *
 * Palette `selection`/`hover` values are often translucent on purpose — a tinted
 * wash that lets the surface beneath show through. That is correct for a border,
 * but wrong for a fill: TBAi uses `bg-accent` as a solid row highlight, and an
 * alpha token there renders as a hole. Flattening keeps the tint and guarantees
 * a real fill. Compositing happens in linear light, matching how a browser does
 * it, rather than in OKLab, which is for blending not compositing.
 */
export function compositeOver(color: string, base: string): string {
  const over = parseColor(color);
  const under = parseColor(base);
  if (!over || !under) return color;
  if (over.a >= 1) return color;
  const a = clamp01(over.a);
  return formatColor({
    r: under.r + (over.r - under.r) * a,
    g: under.g + (over.g - under.g) * a,
    b: under.b + (over.b - under.b) * a,
    a: 1,
  });
}

/** Pick black or white, whichever is more legible on `background`. */
export function onColor(background: string): string {
  return readableForeground(background, ["#ffffff", "#000000"], "#ffffff");
}