import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import {
  DEFAULT_THEME_ID,
  getTheme,
  THEMES,
  type ThemeDefinition,
} from "../features/appearance/theme-data";
import {
  applyThemeToDom,
  resolveEffectiveThemeMode,
  THEME_ATTRIBUTE,
  type EffectiveThemeMode,
} from "../features/appearance/theme-dom";
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
  /** Logical mode (light/dark/system), persisted in SQLite. */
  theme: Theme;
  /** Effective rendered mode (light/dark). */
  resolvedTheme: EffectiveThemeMode;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  /** Palette family id for each mode. */
  themeIds: { light: string; dark: string };
  /** Change the palette used in one mode only. */
  setThemeId: (mode: "light" | "dark", id: string) => void;
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
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  const resolvedTheme: EffectiveThemeMode =
    theme === "system" ? (systemPrefersDark ? "dark" : "light") : theme;

  // Listen for OS preference changes; updates rendered mode only (never writes SQLite).
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setSystemPrefersDark("matches" in e ? e.matches : mql.matches);
    };
    // Sync current value in case it changed before listener attached.
    setSystemPrefersDark(mql.matches);
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange as EventListener);
      return () => mql.removeEventListener("change", onChange as EventListener);
    }
    // Safari fallback
    mql.addListener(onChange as any);
    return () => mql.removeListener(onChange as any);
  }, []);

  // One effect for the whole DOM write, so class and attribute can never disagree.
  useEffect(() => {
    applyThemeToDom(theme, themeIds[resolvedTheme]);
  }, [theme, themeIds, resolvedTheme]);

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
      const effective = resolveEffectiveThemeMode(prev);
      const next: Theme = effective === "dark" ? "light" : "dark";
      if (!consumeAppearancePatchSuppression()) {
        void usePreferencesStore
          .getState()
          .patchPreferences({ appearance: { themeMode: next } })
          .catch(() => {});
      }
      return next;
    });
  }, []);

  const setThemeId = useCallback((mode: "light" | "dark", id: string) => {
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
    () => getTheme(themeIds[resolvedTheme]) ?? getTheme(DEFAULT_THEME_ID)!,
    [themeIds, resolvedTheme],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme, themeIds, setThemeId, activeTheme }),
    [theme, resolvedTheme, setTheme, toggleTheme, themeIds, setThemeId, activeTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider");
  return value;
}

export { THEMES, THEME_ATTRIBUTE, DEFAULT_MODE, resolveEffectiveThemeMode };
