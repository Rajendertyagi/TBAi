/**
 * Folder colour palette (codeg parity). These are user data: the picked value
 * is stored on the folder row and read back as-is, so they are literals rather
 * than theme tokens — a folder must keep the colour the user chose even when
 * the active theme changes.
 */
export const FOLDER_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  "#ec4899",
  "#f43f5e",
] as const;

/**
 * The sentinel a folder carries when the user has not picked one.
 *
 * Named because it is used by the write, the swatch, and the "is this the
 * default?" comparison. The comparison is what makes a typo silent: a near-miss
 * literal still renders a plausible swatch and simply never matches, so the
 * checkmark quietly stops appearing.
 */
export const DEFAULT_FOLDER_COLOR = "#6b7280";
