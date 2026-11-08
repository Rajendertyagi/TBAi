/**
 * Folder identity colors & deterministic derivation (Paseo parity).
 *
 * Muted, distinct tones calibrated to maintain high contrast with a white or
 * dark initial letter. Folders without an explicit custom color derive their
 * color deterministically from their ID or name so folders never render as
 * uniform dull grey.
 */

export const FOLDER_IDENTITY_COLORS = [
  "#7a6aa8", // violet
  "#3d7ea6", // sky
  "#388068", // emerald
  "#a4673a", // orange
  "#b05c80", // pink
  "#6a70b8", // indigo
  "#368080", // teal
  "#b06260", // red
  "#8f7838", // amber
  "#5179b0", // blue
] as const;

export function deriveFolderColor(key: string): string {
  if (!key) return FOLDER_IDENTITY_COLORS[0];
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return FOLDER_IDENTITY_COLORS[hash % FOLDER_IDENTITY_COLORS.length];
}
