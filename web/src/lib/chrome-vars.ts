import {
  leftChromeWidth,
  rightChromeReserve,
} from "./window-chrome";

/**
 * Writes chrome geometry CSS variables from the token layer
 * (`window-chrome.ts`). Components size themselves with
 * `w-[var(--…)]` / `right-[var(--…)]` classes — this module is the only place
 * that turns token numbers into styles, so no inline `style=` props or
 * hardcoded widths leak into components.
 *
 * Variables owned here:
 * - `--sidebar-width` — resizable conversation sidebar.
 * - `--left-chrome-width` — left overlay (toggle + search) + the in-strip
 *   spacer that clears it when the sidebar is hidden.
 * - `--right-chrome-reserve` — right overlay cluster + caption buttons.
 */
export interface ChromeVars {
  sidebarWidth: number;
  searchOpen: boolean;
  /** Desktop macOS traffic-light clearance. */
  macInset: boolean;
  /** Desktop Windows/Linux caption-button strip. */
  winLinuxCaption: boolean;
}

export function syncChromeVars(vars: ChromeVars): void {
  const root = document.documentElement.style;
  root.setProperty("--sidebar-width", `${vars.sidebarWidth}px`);
  root.setProperty(
    "--left-chrome-width",
    `${leftChromeWidth(vars.searchOpen, vars.macInset)}px`,
  );
  root.setProperty(
    "--right-chrome-reserve",
    `${rightChromeReserve(vars.winLinuxCaption)}px`,
  );
}
