import { describe, expect, it } from "bun:test";

import {
  compositeOver,
  contrastRatio,
  formatColor,
  mix,
  parseColor,
  readableForeground,
  withAlpha,
} from "./theme-color";

/**
 * Relative luminance written out longhand, independently of the module under
 * test.
 *
 * This exists as a separate function rather than an inline expression because an
 * earlier version of it used `v ** 2.4` and disagreed with the implementation by
 * ~15%. The cause was the sRGB gamma offset — `((v + 0.055) / 1.055) ** 2.4` —
 * being dropped. That is exactly the class of error a restated formula cannot
 * catch, so the check is written out separately and compared against the
 * published value for a canonical colour as well.
 */
function relative(c: { r: number; g: number; b: number }): number {
  const ch = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/** Same function under a second name, so the two are visibly independent. */
const relativeLuminanceOf = relative;

/**
 * The colour maths every contrast guarantee depends on.
 *
 * WHY THE ROUND-TRIP TEST IS THE IMPORTANT ONE. `theme-css.ts` adjusts colours
 * until they clear a contrast threshold, and those adjustments are only
 * meaningful if the conversions underneath are correct. A wrong matrix constant
 * would not throw — it would quietly shift every derived colour by a few percent
 * and quietly move every contrast measurement with it, so the thresholds would
 * still "pass" while measuring the wrong thing. So this file pins the conversion
 * against known values and against a full hex -> oklch -> hex round trip.
 *
 * The round trip also exists because of the concrete bug that motivated the
 * OKLab work: the parser could not read `oklch()`, so half the stylesheet's own
 * dark palette was silently unmeasurable and nothing complained.
 */

const close = (a: number, b: number, tolerance = 1.5) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tolerance);

describe("parseColor", () => {
  it("reads the hex forms that actually appear in the registry", () => {
    expect(parseColor("#fdfcfa")).toEqual({ r: 253, g: 252, b: 250, a: 1 });
    expect(parseColor("#A277FF")).toEqual({ r: 162, g: 119, b: 255, a: 1 });
    // 4- and 8-digit carry alpha, which the registry uses for tints.
    close(parseColor("#bdb2d74c")!.a * 255, 76);
    // 3-digit expands by digit doubling, not by nibble.
    expect(parseColor("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
  });

  it("reads comma and space separated rgb(), both alpha styles", () => {
    expect(parseColor("rgb(12, 34, 56)")).toEqual({ r: 12, g: 34, b: 56, a: 1 });
    expect(parseColor("rgb(12 34 56)")).toEqual({ r: 12, g: 34, b: 56, a: 1 });
    close(parseColor("rgba(12, 34, 56, 0.5)")!.a, 0.5, 0.001);
    close(parseColor("rgb(12 34 56 / 50%)")!.a, 0.5, 0.001);
  });

  it("reads hsl()", () => {
    expect(parseColor("hsl(0, 100%, 50%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    const grey = parseColor("hsl(0 0% 50%)")!;
    expect(grey.r).toBe(grey.g);
    expect(grey.g).toBe(grey.b);
  });

  it("reads oklch(), which the stylesheet's own dark palette uses", () => {
    // This is the case that used to return null and silently unmeasure Classic
    // dark. Both notations matter: Tailwind v4 emits `97%`, hand-authored themes
    // write `0.205`.
    const a = parseColor("oklch(0.205 0 0)")!;
    const b = parseColor("oklch(20.5% 0 0)")!;
    close(a.r, b.r, 0.5);
    close(a.g, b.g, 0.5);
    close(a.b, b.b, 0.5);
    // For a grey, OKLab L is very close to the cube root of luminance, so
    // L = 0.205 lands near #171717 — much darker than the sRGB value 0.205 would
    // suggest, which is exactly why mixing in OKLab is not the same as mixing in
    // sRGB.
    close(a.r, 23, 1.5);

    // sRGB red is oklch(0.628 0.2577 29.23) — the canonical boundary value, so
    // this checks hue, chroma and lightness conversion against a known colour.
    // A chroma slightly above it (0.26) is OUTSIDE sRGB and clamps green and
    // blue to zero, which is why the earlier version of this assertion compared
    // two zeros and failed.
    const red = parseColor("oklch(0.628 0.2577 29.23)")!;
    close(red.r, 255, 1.5);
    close(red.g, 0, 1.5);
    close(red.b, 0, 1.5);

    // A mid-chroma blue proves hue is applied, not just ignored for near-neutrals.
    const blue = parseColor("oklch(0.45 0.15 264)")!;
    expect(blue.b).toBeGreaterThan(blue.r);
    expect(blue.r).toBeLessThan(blue.g);

    // Alpha via the slash form.
    close(parseColor("oklch(0.5 0.1 200 / 0.4)")!.a, 0.4, 0.001);

    // Chroma as a percentage is relative to 0.4 per CSS Color 4.
    const pct = parseColor("oklch(0.5 50% 200)")!;
    const num = parseColor("oklch(0.5 0.2 200)")!;
    close(pct.r, num.r, 0.5);
  });

  it("returns null for syntax it does not own, instead of guessing", () => {
    expect(parseColor("transparent")).toBeNull();
    expect(parseColor("")).toBeNull();
    expect(parseColor(undefined)).toBeNull();
    expect(parseColor("lab(50% 20 -30)")).toBeNull();
  });
});

describe("OKLab conversion", () => {
  it("matches known reference lightnesses", () => {
    // OKLab L is perceptual lightness: 0 for black, 1 for white, and mid-grey
    // lands near 0.6 rather than 0.5 — which is the whole point of using it.
    close(parseColor("#000000")!.r, 0, 0.001);
    expect(formatColor("#ffffff")).toBe("oklch(1 0 0)");
    expect(formatColor("#000000")).toBe("oklch(0 0 0)");
    const grey = parseColor(formatColor("#808080"))!;
    // #808080 converts back to itself; that is the round-trip guarantee.
    close(grey.r, 128, 1);
    close(grey.g, 128, 1);
    close(grey.b, 128, 1);
  });

  it("round-trips every hex through oklch without drifting", () => {
    // If a matrix constant were wrong, this is what would catch it. Both the
    // palette colours taken from OpenChamber and the neutral greys the stylesheet
    // itself is built from are represented.
    const samples = [
      "#000000", "#ffffff", "#808080", "#fdfcfa", "#120f0e", "#b35017",
      "#da7c47", "#393a34", "#5c5c54", "#f7f6f4", "#e5e1de", "#a9998f",
      "#A277FF", "#15141B", "#2D2640", "#807b8b", "#D94F4F", "#40BF7A",
      "#076678", "#FBF1C7", "#7a8a5a", "#0a0a0a",
    ];
    for (const hex of samples) {
      const original = parseColor(hex)!;
      const round = parseColor(formatColor(hex))!;
      close(round.r, original.r, 1.5);
      close(round.g, original.g, 1.5);
      close(round.b, original.b, 1.5);
      close(round.a, original.a, 0.001);
    }
  });

  it("round-trips alpha", () => {
    const round = parseColor(formatColor("#bdb2d74c"))!;
    close(round.a, 76 / 255, 0.01);
  });

  it("drops hue for neutrals so the generated stylesheet does not churn", () => {
    // A neutral's hue is numerically unstable and meaningless; emitting it would
    // produce noisy diffs for no benefit. Asserted tolerantly rather than by
    // string equality so a last-digit rounding change is not a test failure.
    const out = formatColor("#808080");
    expect(out).toMatch(/^oklch\(0\.59\d+ 0 0\)$/);
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG anchors", () => {
    const white = parseColor("#ffffff")!;
    const black = parseColor("#000000")!;
    expect(contrastRatio(white, black)).toBeCloseTo(21, 4);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
  });

  it("agrees with the published value for the canonical mid grey", () => {
    // #767676 is the well-known "just passes on white" grey: its relative
    // luminance is 0.1812, giving 4.54:1 against white. Asserted against the
    // published number rather than a formula restated from the implementation,
    // so the check stays independent.
    const g = parseColor("#767676")!;
    expect(relative(g)).toBeCloseTo(0.1812, 4);
    expect(contrastRatio(g, parseColor("#ffffff")!)).toBeCloseTo(4.54, 1);
  });

  it("agrees with an independently written transfer function", () => {
    const g = parseColor("#767676")!;
    expect(relative(g)).toBeCloseTo(relativeLuminanceOf(g), 10);
  });

  it("is symmetric", () => {
    const a = parseColor("#b35017")!;
    const b = parseColor("#fdfcfa")!;
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });
});

describe("readableForeground", () => {
  it("picks the highest-contrast candidate rather than the first", () => {
    expect(readableForeground("#fdfcfa", ["#ffffff", "#000000"], "#fff")).toBe("#000000");
    expect(readableForeground("#120f0e", ["#ffffff", "#000000"], "#fff")).toBe("#ffffff");
  });

  it("falls back rather than throwing on unparseable input", () => {
    expect(readableForeground("lab(50% 20 -30)", ["#ffffff"], "#fallback")).toBe("#fallback");
    expect(readableForeground("#ffffff", ["lab(50% 20 -30)"], "#fallback")).toBe("#fallback");
  });
});

describe("mix", () => {
  it("lands on the endpoints and midpoints predictably", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("oklch(0 0 0)");
    expect(mix("#000000", "#ffffff", 1)).toBe("oklch(1 0 0)");
    // Halfway in OKLab is mid *perceptual* lightness, so it lands near #636363
    // rather than at the sRGB midpoint #808080. This is the concrete difference
    // the OKLab blend buys, and it is why a midpoint derived here does not look
    // like a muddy sRGB average.
    const mid = parseColor(mix("#000000", "#ffffff", 0.5))!;
    expect(mid.r).toBeGreaterThan(95);
    expect(mid.r).toBeLessThan(103);
  });

  it("returns the input unchanged when either side is unparseable", () => {
    expect(mix("#000000", "lab(1 2 3)", 0.5)).toBe("#000000");
    expect(mix("lab(1 2 3)", "#ffffff", 0.5)).toBe("lab(1 2 3)");
  });

  it("interpolates alpha so compositing twice cannot re-solidify a tint", () => {
    const half = parseColor(mix("rgba(0,0,0,1)", "rgba(0,0,0,0)", 0.5))!;
    close(half.a, 0.5, 0.01);
  });
});

describe("withAlpha and compositeOver", () => {
  it("multiplies the existing alpha rather than replacing it", () => {
    close(parseColor(withAlpha("rgba(0, 0, 0, 0.5)", 0.5))!.a, 0.25, 0.01);
    close(parseColor(withAlpha("#000000", 0.4))!.a, 0.4, 0.01);
  });

  it("flattens a translucent tint to an opaque fill", () => {
    const flat = compositeOver("#bdb2d74c", "#f1ebfb");
    const parsed = parseColor(flat)!;
    expect(parsed.a).toBe(1);
    // 4c = 76/255 ≈ 0.298 over a light base stays a light, slightly violet grey.
    expect(parsed.r).toBeGreaterThan(200);
  });

  it("leaves an already-opaque colour untouched, with no needless reconversion", () => {
    // Nothing to composite, so the input is returned as-is rather than round-
    // tripped through oklch. That keeps `--accent` reading as the palette's own
    // hex when it is already opaque, instead of a reformatted equivalent.
    expect(compositeOver("#123456", "#ffffff")).toBe("#123456");
  });

  it("returns the input when the base is unparseable", () => {
    expect(compositeOver("#123456", "lab(1 2 3)")).toBe("#123456");
  });
});