import { describe, expect, it } from "bun:test";
import { DEFAULT_FOLDER_COLOR, FOLDER_COLORS } from "@web/features/sidebar/lib/folder-colors";
import {
  FOLDER_TILE_DARK_LETTER,
  FOLDER_TILE_LIGHT_LETTER,
  contrastRatio,
  folderTileLetter,
  folderTileLetterColor,
  relativeLuminance,
} from "@web/features/sidebar/lib/folder-tile";

const PALETTE: readonly string[] = [...FOLDER_COLORS, DEFAULT_FOLDER_COLOR];

/**
 * The tile draws a 10px letter on the folder's own colour. Every palette entry
 * is reachable in one click, so a rule that only works for dark swatches (white
 * letter) is a defect: the yellow swatch would render a near-invisible "P".
 */
describe("folder tile letter colour", () => {
  it("covers every colour the picker can store", () => {
    expect(PALETTE.length).toBe(13);
  });

  for (const background of PALETTE) {
    it(`picks the higher-contrast letter on ${background}`, () => {
      const chosen = folderTileLetterColor(background);
      expect([FOLDER_TILE_LIGHT_LETTER, FOLDER_TILE_DARK_LETTER]).toContain(chosen);

      const bg = relativeLuminance(background);
      const chosenRatio = contrastRatio(bg, relativeLuminance(chosen));
      const other =
        chosen === FOLDER_TILE_LIGHT_LETTER ? FOLDER_TILE_DARK_LETTER : FOLDER_TILE_LIGHT_LETTER;
      const otherRatio = contrastRatio(bg, relativeLuminance(other));

      expect(chosenRatio).toBeGreaterThanOrEqual(otherRatio);
      // Measured across the palette: the worst case is ~4.2:1 (#8b5cf6). The
      // assertion is 4.0 so a retune that drops noticeably below that fails
      // instead of silently shipping an unreadable tile.
      expect(chosenRatio).toBeGreaterThanOrEqual(4);
    });
  }

  it("flips to a dark letter on the light swatches", () => {
    expect(folderTileLetterColor("#eab308")).toBe(FOLDER_TILE_DARK_LETTER);
    expect(folderTileLetterColor("#22c55e")).toBe(FOLDER_TILE_DARK_LETTER);
  });

  it("keeps a white letter on the dark swatches", () => {
    expect(folderTileLetterColor("#111827")).toBe(FOLDER_TILE_LIGHT_LETTER);
    expect(folderTileLetterColor("#6b7280")).toBe(FOLDER_TILE_LIGHT_LETTER);
  });

  it("falls back to a white letter for a value that is not a hex colour", () => {
    expect(folderTileLetterColor("var(--nope)")).toBe(FOLDER_TILE_LIGHT_LETTER);
  });
});

describe("folder tile letter", () => {
  it("uppercases the first character", () => {
    expect(folderTileLetter("tbai")).toBe("T");
  });

  it("uses the first character of a multi-byte name, not a broken surrogate", () => {
    expect(folderTileLetter("Ωmega")).toBe("Ω");
  });

  it("ignores surrounding whitespace", () => {
    expect(folderTileLetter("  market hub ")).toBe("M");
  });

  it("never renders an empty tile", () => {
    expect(folderTileLetter("   ")).toBe("?");
  });
});
