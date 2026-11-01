/**
 * Folder-tile colour rule.
 *
 * The tile's fill is the folder's own colour — user data read back out of
 * storage — so it is applied as a CSS custom property instead of a theme
 * token. The letter has to stay legible on every palette entry, so its colour
 * is chosen by WCAG relative luminance rather than assumed to be white: a white
 * letter on the sidebar's yellow swatch is unreadable, and that is exactly the
 * swatch someone picks first.
 */

/** The only two letter colours the tile may use. */
export const FOLDER_TILE_LIGHT_LETTER = "#ffffff";
export const FOLDER_TILE_DARK_LETTER = "#111827";

/** WCAG relative luminance of a `#rgb` / `#rrggbb` colour; 0 for anything else. */
export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (rgb === null) return 0;
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two relative luminances. */
export function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** The letter colour with the higher contrast against `background`. */
export function folderTileLetterColor(background: string): string {
  const bg = relativeLuminance(background);
  const light = contrastRatio(bg, relativeLuminance(FOLDER_TILE_LIGHT_LETTER));
  const dark = contrastRatio(bg, relativeLuminance(FOLDER_TILE_DARK_LETTER));
  return light >= dark ? FOLDER_TILE_LIGHT_LETTER : FOLDER_TILE_DARK_LETTER;
}

/** The tile's letter: first character of the display name, uppercased. */
export function folderTileLetter(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
}

/** `[r, g, b]` for `#rgb` / `#rrggbb`, or null when the value is not a hex colour. */
function parseHex(hex: string): [number, number, number] | null {
  const value = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(value)) {
    const [r, g, b] = value;
    return [
      Number.parseInt(`${r}${r}`, 16),
      Number.parseInt(`${g}${g}`, 16),
      Number.parseInt(`${b}${b}`, 16),
    ];
  }
  if (/^[0-9a-f]{6}$/i.test(value)) {
    return [
      Number.parseInt(value.slice(0, 2), 16),
      Number.parseInt(value.slice(2, 4), 16),
      Number.parseInt(value.slice(4, 6), 16),
    ];
  }
  return null;
}
