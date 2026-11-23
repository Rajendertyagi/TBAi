/**
 * TBAi-owned Dockview theme.
 *
 * Dockview themes are CSS-variable sets applied through a class name. This
 * theme maps Dockview's `--dv-*` variables onto TBAi's own theme tokens
 * (`--background`, `--border`, `--foreground`, ...) in `styles/globals.css`.
 * Because those tokens are redefined by `:root`, `.dark`, and
 * `html[data-tbai-theme="..."]`, the workspace follows the app's light/dark
 * mode and every custom palette automatically — no JS theme switching and no
 * hardcoded vendor palette.
 *
 * `colorScheme` is deliberately omitted: it is consumer metadata (Dockview
 * does not apply it as CSS `color-scheme`), and the app already sets
 * `color-scheme` on `:root`/`.dark`, which the Dockview container inherits.
 * Hardcoding it here would pin one mode and break the other.
 *
 * `tabGroupIndicator: "none"` preserves the flat tab-group indicator of the
 * previously used `themeAbyss` and matches the app's flat `border-b` chrome.
 */
import type { DockviewTheme } from "dockview-react";

/** The single Dockview theme used by the production workspace. */
export const tbaiTheme: DockviewTheme = {
  name: "tbai",
  className: "dockview-theme-tbai",
  tabGroupIndicator: "none",
};
