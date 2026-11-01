import type { CSSProperties } from "react";
import { DEFAULT_FOLDER_COLOR } from "../lib/folder-colors";
import { folderTileLetter, folderTileLetterColor } from "../lib/folder-tile";

/**
 * A folder's leading tile: its colour as a square, with the first letter of
 * its display name. Replaces the grey open/closed folder glyph, which ignored
 * the folder's colour — which is why two folders used to look identical.
 *
 * The two colours are passed as custom properties because they are data
 * (a palette entry stored on the folder), not theme tokens.
 */
export function FolderTile({ label, color }: { label: string; color: string }) {
  const background = color || DEFAULT_FOLDER_COLOR;
  return (
    <span
      aria-hidden="true"
      data-folder-tile
      className="folder-tile"
      style={
        {
          "--folder-tile-bg": background,
          "--folder-tile-fg": folderTileLetterColor(background),
        } as CSSProperties
      }
    >
      {folderTileLetter(label)}
    </span>
  );
}
