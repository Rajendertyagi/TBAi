/**
 * Theme persistence.
 *
 * Three independent decisions are stored, because they are independent:
 *
 *   tbai-theme        light | dark   — which mode (pre-existing key, unchanged)
 *   tbai-theme-light  family id      — palette used while in light mode
 *   tbai-theme-dark   family id      — palette used while in dark mode
 *
 * Two slots rather than one is what OpenChamber does, and it is the reason a theme
 * can be warm in one mode and cool in the other. Keeping `tbai-theme` on its own
 * key means an existing install keeps its light/dark choice untouched, and an
 * install with no stored palette keeps TBAi's existing look — the theme ids
 * default to `classic`, which generates no CSS at all.
 *
 * Reads are total: an unknown, corrupt or partial value falls back to the default
 * rather than throwing, because a bad key must never be able to brick the shell.
 */

import { DEFAULT_THEME_ID, isThemeId } from "./theme-data";

export type ThemeMode = "light" | "dark";

const MODE_KEY = "tbai-theme";
const LIGHT_KEY = "tbai-theme-light";
const DARK_KEY = "tbai-theme-dark";

export const DEFAULT_MODE: ThemeMode = "dark";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the theme still applies for this session */
  }
}

export function readMode(): ThemeMode {
  const stored = read(MODE_KEY);
  return stored === "light" || stored === "dark" ? stored : DEFAULT_MODE;
}

export function writeMode(mode: ThemeMode): void {
  write(MODE_KEY, mode);
}

export function readThemeId(mode: ThemeMode): string {
  const stored = read(mode === "dark" ? DARK_KEY : LIGHT_KEY);
  return isThemeId(stored) ? stored : DEFAULT_THEME_ID;
}

export function writeThemeId(mode: ThemeMode, id: string): void {
  if (!isThemeId(id)) return;
  write(mode === "dark" ? DARK_KEY : LIGHT_KEY, id);
}

/** Both palette slots at once, for the settings page. */
export function readThemeIds(): { light: string; dark: string } {
  return { light: readThemeId("light"), dark: readThemeId("dark") };
}