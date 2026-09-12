import {
  ACTIVITY_BAR_WIDTH,
  CAPTION_BUTTON_WIDTH,
  TITLE_BAR_HEIGHT,
  leftChromeWidth,
  rightChromeReserve,
} from "./window-chrome";

/**
 * Writes chrome geometry CSS variables from the token layer
 * (`window-chrome.ts`). Components size themselves with
 * `w-[var(--…)]` / `h-[var(--…)]` / `right-[var(--…)]` classes — this module
 * is the only place that turns token numbers into styles, so no inline
 * `style=` props or hardcoded widths leak into components.
 *
 * Variables owned here:
 * - `--sidebar-width` — resizable conversation sidebar.
 * - `--left-chrome-width` — left overlay (toggle + search) + the in-strip
 *   spacer that clears it when the sidebar is hidden.
 * - `--right-chrome-reserve` — right overlay cluster + caption buttons.
 * - `--title-bar-height` — h-10 band shared by the strip, sidebar header,
 *   and corner overlays.
 * - `--activity-bar-width` — left icon rail (overlay anchor).
 * - `--caption-button-width` — one caption button (3 × = controls strip).
 */
export interface ChromeVars {
  sidebarWidth: number;
  searchOpen: boolean;
  /** Frameless Windows caption-button strip (Tauri only). */
  captionStrip: boolean;
}

export function syncChromeVars(vars: ChromeVars): void {
  const root = document.documentElement.style;
  root.setProperty("--sidebar-width", `${vars.sidebarWidth}px`);
  root.setProperty(
    "--left-chrome-width",
    `${leftChromeWidth(vars.searchOpen)}px`,
  );
  root.setProperty(
    "--right-chrome-reserve",
    `${rightChromeReserve(vars.captionStrip)}px`,
  );
  root.setProperty("--title-bar-height", `${TITLE_BAR_HEIGHT}px`);
  root.setProperty("--activity-bar-width", `${ACTIVITY_BAR_WIDTH}px`);
  root.setProperty("--caption-button-width", `${CAPTION_BUTTON_WIDTH}px`);
}
