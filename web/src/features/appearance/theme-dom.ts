/**
 * The single place that writes theme state to the DOM.
 *
 * Deliberately tiny and framework-free, because two very different callers must
 * agree exactly:
 *
 *   - the pre-paint bootstrap in `index.html`, which sets the class and the
 *     attribute before React exists so the first paint is already correct, and
 *   - `ThemeProvider`, which re-applies on every change.
 *
 * Because the colours live in a stylesheet (`styles/themes.css`) rather than being
 * generated at runtime, all this has to do is flip two things: the mode class and
 * the `data-tbai-theme` attribute. That is the whole contract, and it is why the
 * bootstrap cannot drift from the provider — neither one carries colour logic.
 */

import { getTheme } from "./theme-data";
import { resolveThemeVars } from "./theme-css";
import type { ThemeMode } from "./theme-storage";

/** Attribute the generated blocks are keyed on. */
export const THEME_ATTRIBUTE = "data-tbai-theme";

/**
 * Apply a mode + palette pair to the document.
 *
 * `themeId` may be any known family id; the built-in `classic` has no generated
 * block, so applying it means *removing* the attribute, which lets the
 * stylesheet's own `:root`/`.dark` values take over again.
 */
export function applyThemeToDom(mode: ThemeMode, themeId: string): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  root.classList.remove("light", "dark");
  root.classList.add(mode);

  const theme = getTheme(themeId);
  if (theme?.builtin) {
    root.removeAttribute(THEME_ATTRIBUTE);
  } else {
    root.setAttribute(THEME_ATTRIBUTE, themeId);
  }

  // Browser chrome (address bar on mobile, title bar on desktop) should match the
  // app background rather than the hardcoded value in index.html.
  if (theme) {
    const background = resolveThemeVars(theme, mode)["--background"];
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && background) meta.setAttribute("content", background);
  }
}