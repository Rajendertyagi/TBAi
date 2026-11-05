import { describe, expect, it, beforeEach } from "bun:test";
import {
  clampWeightForFont,
  DEFAULT_TYPOGRAPHY,
  getFont,
  readTypography,
  resetCodeTypography,
  resetDisplayScale,
  resetInterfaceTypography,
  resetTypography,
  writeTypography,
  type TypographyConfig,
} from "../../../web/src/features/appearance/typography";

describe("Typography config, storage & scoped resets", () => {
  beforeEach(() => {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
  });

  it("returns default typography when storage is empty", () => {
    expect(DEFAULT_TYPOGRAPHY.fontFamily).toBe("inter");
    expect(DEFAULT_TYPOGRAPHY.monoFontFamily).toBe("jetbrains-mono");
    expect(DEFAULT_TYPOGRAPHY.baseSize).toBe(16);
    expect(DEFAULT_TYPOGRAPHY.fontWeight).toBe(400);
    expect(DEFAULT_TYPOGRAPHY.monoFontWeight).toBe(400);
    expect(DEFAULT_TYPOGRAPHY.codeFontSize).toBe(13);
    expect(DEFAULT_TYPOGRAPHY.lineHeight).toBe(1.5);
  });

  it("migrates legacy configuration missing monoFontWeight and codeFontSize", () => {
    if (typeof window !== "undefined" && window.localStorage) {
      const legacy = {
        version: 1,
        fontFamily: "roboto",
        monoFontFamily: "fira-code",
        fontWeight: 600,
        baseSize: 18,
        lineHeight: 1.65,
      };
      window.localStorage.setItem("tbai-typography", JSON.stringify(legacy));
      const config = readTypography();
      expect(config.fontFamily).toBe("roboto");
      expect(config.monoFontFamily).toBe("fira-code");
      expect(config.fontWeight).toBe(600);
      // monoFontWeight falls back to parsed.fontWeight
      expect(config.monoFontWeight).toBe(600);
      // codeFontSize falls back to default 13
      expect(config.codeFontSize).toBe(13);
      expect(config.baseSize).toBe(18);
    }
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

  it("resetInterfaceTypography preserves code and scale settings", () => {
    const custom: TypographyConfig = {
      version: 1,
      fontFamily: "roboto",
      monoFontFamily: "fira-code",
      fontWeight: 700,
      monoFontWeight: 300,
      baseSize: 18,
      codeFontSize: 16,
      lineHeight: 1.65,
    };
    const reset = resetInterfaceTypography(custom);
    expect(reset.fontFamily).toBe(DEFAULT_TYPOGRAPHY.fontFamily);
    expect(reset.fontWeight).toBe(DEFAULT_TYPOGRAPHY.fontWeight);
    // Preserved:
    expect(reset.monoFontFamily).toBe("fira-code");
    expect(reset.monoFontWeight).toBe(300);
    expect(reset.codeFontSize).toBe(16);
    expect(reset.baseSize).toBe(18);
    expect(reset.lineHeight).toBe(1.65);
  });

  it("resetCodeTypography preserves interface and scale settings", () => {
    const custom: TypographyConfig = {
      version: 1,
      fontFamily: "roboto",
      monoFontFamily: "fira-code",
      fontWeight: 700,
      monoFontWeight: 300,
      baseSize: 18,
      codeFontSize: 16,
      lineHeight: 1.65,
    };
    const reset = resetCodeTypography(custom);
    // Reset:
    expect(reset.monoFontFamily).toBe(DEFAULT_TYPOGRAPHY.monoFontFamily);
    expect(reset.monoFontWeight).toBe(DEFAULT_TYPOGRAPHY.monoFontWeight);
    expect(reset.codeFontSize).toBe(DEFAULT_TYPOGRAPHY.codeFontSize);
    // Preserved:
    expect(reset.fontFamily).toBe("roboto");
    expect(reset.fontWeight).toBe(700);
    expect(reset.baseSize).toBe(18);
    expect(reset.lineHeight).toBe(1.65);
  });

  it("resetDisplayScale preserves interface and code settings", () => {
    const custom: TypographyConfig = {
      version: 1,
      fontFamily: "roboto",
      monoFontFamily: "fira-code",
      fontWeight: 700,
      monoFontWeight: 300,
      baseSize: 18,
      codeFontSize: 16,
      lineHeight: 1.65,
    };
    const reset = resetDisplayScale(custom);
    // Reset:
    expect(reset.baseSize).toBe(DEFAULT_TYPOGRAPHY.baseSize);
    expect(reset.lineHeight).toBe(DEFAULT_TYPOGRAPHY.lineHeight);
    // Preserved:
    expect(reset.fontFamily).toBe("roboto");
    expect(reset.fontWeight).toBe(700);
    expect(reset.monoFontFamily).toBe("fira-code");
    expect(reset.monoFontWeight).toBe(300);
    expect(reset.codeFontSize).toBe(16);
  });

  it("resetTypography restores all factory defaults", () => {
    const custom: TypographyConfig = {
      version: 1,
      fontFamily: "roboto",
      monoFontFamily: "fira-code",
      fontWeight: 700,
      monoFontWeight: 300,
      baseSize: 18,
      codeFontSize: 16,
      lineHeight: 1.65,
    };
    writeTypography(custom);
    const reset = resetTypography();
    expect(reset).toEqual(DEFAULT_TYPOGRAPHY);
  });

  it("safely recovers from corrupted storage", () => {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem("tbai-typography", "{ corrupted_json: ... ");
      const config = readTypography();
      expect(config.fontFamily).toBe(DEFAULT_TYPOGRAPHY.fontFamily);
      expect(config.baseSize).toBe(DEFAULT_TYPOGRAPHY.baseSize);
      expect(config.codeFontSize).toBe(DEFAULT_TYPOGRAPHY.codeFontSize);
    }
  });
});
