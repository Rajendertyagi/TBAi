/**
 * Shared geometry for the Windows desktop window-chrome corner overlays.
 * Single source of truth so the floating corner clusters (sidebar toggle /
 * search / status / settings / window controls) and the column reservations
 * that clear them always agree — and so no layout magic numbers live inline
 * in components.
 *
 * Windows-only: the app ships as a frameless (`decorations: false`) Windows
 * x64 window, so there are no macOS traffic lights or Linux resize grips to
 * account for. Reserves are computed from these tokens and published as CSS
 * variables by `lib/chrome-vars.ts`; components consume `var(--…)` classes.
 */

/** Height of the title / tab strip band. */
export const TITLE_BAR_HEIGHT = 40;

/** Width of the ActivityBar (the left icon rail). */
export const ACTIVITY_BAR_WIDTH = 48;

/** Width of one native-style caption button (min / max / close). */
export const CAPTION_BUTTON_WIDTH = 46;

/** Combined width of the three caption buttons (3 × 46px). */
export const WINDOW_CONTROLS_WIDTH = 138;

/** Caption-button strip occupying the window's top-right (Tauri only). */
export const WINDOW_CAPTION_WIDTH = 138;

/** Left cluster: sidebar toggle + search (two icon buttons + padding). */
export const LEFT_CHROME_CLUSTER = 80;

/** Right cluster: status + settings (two icon buttons + padding). */
export const RIGHT_CHROME_CLUSTER = 80;

/** Default / bounds for the conversation sidebar width (px). */
export const SIDEBAR_DEFAULT_WIDTH = 224;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;

/**
 * Expanded width of the left chrome overlay while the conversation search
 * input is open (toggle button + input + clear button + padding). Consumed
 * via the `--left-chrome-width` CSS variable — never referenced as a literal
 * in components.
 */
export const CHROME_SEARCH_EXPANDED_WIDTH = 240;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Width the window's left-edge column reserves for the left overlay
 * (toggle + search cluster).
 */
export function leftChromeReserve(): number {
  return LEFT_CHROME_CLUSTER;
}

/**
 * Full width of the left overlay: the reserved cluster, or the expanded
 * search width while the conversation search input is open (whichever is
 * wider). Single place that decides the overlay geometry; components consume
 * it through `--left-chrome-width`.
 */
export function leftChromeWidth(searchOpen: boolean): number {
  if (!searchOpen) return leftChromeReserve();
  return Math.max(LEFT_CHROME_CLUSTER, CHROME_SEARCH_EXPANDED_WIDTH);
}

/**
 * Width the window's right-edge column reserves for the right overlay.
 * `captionStrip` adds the native caption-button strip (frameless Windows
 * desktop); the browser reserves only the button cluster.
 */
export function rightChromeReserve(captionStrip: boolean): number {
  return RIGHT_CHROME_CLUSTER + (captionStrip ? WINDOW_CAPTION_WIDTH : 0);
}
