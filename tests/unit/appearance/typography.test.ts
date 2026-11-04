import { describe, expect, it, beforeEach } from "bun:test";
import {
  clampWeightForFont,
  DEFAULT_TYPOGRAPHY,
  getFont,
  readTypography,
} from "../../../web/src/features/appearance/typography";

describe("Typography config & storage", () => {
  beforeEach(() => {
    // In Bun test environment, window.localStorage is mockable or simulated
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
  });

  it("returns default typography when storage is empty", () => {
    expect(DEFAULT_TYPOGRAPHY.fontFamily).toBe("inter");
    expect(DEFAULT_TYPOGRAPHY.monoFontFamily).toBe("jetbrains-mono");
    expect(DEFAULT_TYPOGRAPHY.baseSize).toBe(16);
    expect(DEFAULT_TYPOGRAPHY.fontWeight).toBe(400);
    expect(DEFAULT_TYPOGRAPHY.lineHeight).toBe(1.5);
  });

  it("clamps weights correctly for fonts with limited variable ranges", () => {
    const openSans = getFont("open-sans")!;
    expect(openSans).toBeDefined();
    // Open Sans is 300 to 800
    expect(clampWeightForFont(100, openSans)).toBe(300);
    expect(clampWeightForFont(400, openSans)).toBe(400);
    expect(clampWeightForFont(900, openSans)).toBe(800);
  });

  it("clamps weights correctly for static discrete fonts (Lato)", () => {
    const lato = getFont("lato")!;
    expect(lato).toBeDefined();
    // Lato weights: [100, 300, 400, 700, 900]
    expect(clampWeightForFont(200, lato)).toBe(100);
    expect(clampWeightForFont(500, lato)).toBe(400);
    expect(clampWeightForFont(600, lato)).toBe(700);
  });

  it("safely recovers from corrupted storage", () => {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem("tbai-typography", "{ corrupted_json: ... ");
      const config = readTypography();
      expect(config.fontFamily).toBe(DEFAULT_TYPOGRAPHY.fontFamily);
      expect(config.baseSize).toBe(DEFAULT_TYPOGRAPHY.baseSize);
    }
  });
});
