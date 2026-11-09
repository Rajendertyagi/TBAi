import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import {
  DEFAULT_THEME_ID,
  getTheme,
  THEMES,
  type ThemeDefinition,
} from "../features/appearance/theme-data";
import { applyThemeToDom, THEME_ATTRIBUTE } from "../features/appearance/theme-dom";
import { DEFAULT_MODE, type ThemeMode } from "../features/appearance/theme-storage";
import { consumeAppearancePatchSuppression } from "../features/appearance/appearance-patch-guard";
import { usePreferencesStore } from "../features/preferences/state/preferencesStore";

/**
 * Colour theme state. SQLite is authoritative for shared appearance.
 * Before hydration, application state uses defaults (index.html may apply a
 * pre-paint cache hint; React state does not read localStorage as authority).
 * Once SQLite loads, usePreferencesSync applies authoritative state and writes
 * the pre-paint cache (mirror only).
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
  // Defaults before hydration; authoritative SQLite state applied by usePreferencesSync.
  const [theme, setThemeState] = useState<Theme>(DEFAULT_MODE);
  const [themeIds, setThemeIds] = useState<{ light: string; dark: string }>({
    light: DEFAULT_THEME_ID,
    dark: DEFAULT_THEME_ID,
  });

  // One effect for the whole DOM write, so class and attribute can never disagree.
  useEffect(() => {
    applyThemeToDom(theme, themeIds[theme]);
  }, [theme, themeIds]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    if (!consumeAppearancePatchSuppression()) {
      void usePreferencesStore
        .getState()
        .patchPreferences({ appearance: { themeMode: next } })
        .catch(() => {});
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      if (!consumeAppearancePatchSuppression()) {
        void usePreferencesStore
          .getState()
          .patchPreferences({ appearance: { themeMode: next } })
          .catch(() => {});
      }
      return next;
    });
  }, []);

  const setThemeId = useCallback((mode: ThemeMode, id: string) => {
    if (!getTheme(id)) return;
    setThemeIds((prev) => {
      if (prev[mode] === id) return prev;
      if (!consumeAppearancePatchSuppression()) {
        const key = mode === "light" ? "lightTheme" : "darkTheme";
        void usePreferencesStore
          .getState()
          .patchPreferences({ appearance: { [key]: id } })
          .catch(() => {});
      }
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
