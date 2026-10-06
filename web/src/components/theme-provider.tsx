import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { DEFAULT_THEME_ID, getTheme, THEMES, type ThemeDefinition } from "../features/appearance/theme-data";
import { applyThemeToDom, THEME_ATTRIBUTE } from "../features/appearance/theme-dom";
import {
  DEFAULT_MODE,
  readMode,
  readThemeIds,
  writeMode,
  writeThemeId,
  type ThemeMode,
} from "../features/appearance/theme-storage";

/**
 * Colour theme state: a light/dark mode, plus one palette per mode.
 *
 * Two palette slots rather than one because they are genuinely independent — a
 * warm palette in light and a cool one in dark is a legitimate choice, and it is
 * how OpenChamber models it. Keeping them separate means picking a theme for
 * dark mode cannot disturb light mode, or the reverse.
 *
 * Backwards compatible by construction: `theme`/`setTheme`/`toggleTheme` behave
 * exactly as before, and an install with nothing stored keeps TBAi's existing
 * look because both slots default to `classic`, which has no generated CSS and
 * therefore lets the stylesheet's own colours stand.
 */

export type Theme = ThemeMode;

interface ThemeContextValue {
  /** Current mode. */
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  /** Palette family id for each mode. */
  themeIds: { light: string; dark: string };
  /** Change the palette used in one mode only. */
  setThemeId: (mode: ThemeMode, id: string) => void;
  /** The palette currently in effect, resolved for the active mode. */
  activeTheme: ThemeDefinition;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readMode);
  const [themeIds, setThemeIds] = useState(readThemeIds);

  // One effect for the whole DOM write, so class and attribute can never disagree.
  useEffect(() => {
    applyThemeToDom(theme, themeIds[theme]);
  }, [theme, themeIds]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    writeMode(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      writeMode(next);
      return next;
    });
  }, []);

  const setThemeId = useCallback((mode: ThemeMode, id: string) => {
    if (!getTheme(id)) return;
    setThemeIds((prev) => {
      if (prev[mode] === id) return prev;
      writeThemeId(mode, id);
      return { ...prev, [mode]: id };
    });
  }, []);

  const activeTheme = useMemo(
    () => getTheme(themeIds[theme]) ?? getTheme(DEFAULT_THEME_ID)!,
    [theme, themeIds],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, toggleTheme, themeIds, setThemeId, activeTheme }),
    [theme, setTheme, toggleTheme, themeIds, setThemeId, activeTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider");
  return value;
}

export { THEMES, THEME_ATTRIBUTE, DEFAULT_MODE };