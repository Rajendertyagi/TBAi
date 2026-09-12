/**
 * Shared geometry for the desktop window-chrome corner overlays and resize
 * grips. Single source of truth so the floating corner clusters (sidebar toggle
 * / status / settings / window controls) and the column reservations that clear
 * them always agree — and so no layout magic numbers live inline in components.
 *
 * Mirrors codeg's `lib/window-chrome.ts`: reserves are computed from the active
 * platform and the app zoom level, never hardcoded at the call site.
 */

/** Height of the title / tab strip band (h-10). */
export const TITLE_BAR_HEIGHT = 40;

/** Width of the ActivityBar (the left icon rail). */
export const ACTIVITY_BAR_WIDTH = 48;

/** Combined width of the three caption buttons (3 × 46px). Exported so the
 *  Linux resize grips can carve this region out of the top edge. */
export const WINDOW_CONTROLS_WIDTH = 138;

/** Windows/Linux caption buttons (min / max / close) occupy the top-right. */
export const WINDOW_CAPTION_WIDTH = 138;

/** Clearance for the native macOS traffic lights (top-left, fixed inset). */
export const MAC_TRAFFIC_LIGHT_INSET = 76;

/** Left cluster: sidebar toggle + search (two icon buttons + padding). */
export const LEFT_CHROME_CLUSTER = 80;

/** Right cluster: status + settings (two icon buttons + padding). */
export const RIGHT_CHROME_CLUSTER = 80;

/** Thickness of the invisible edge resize borders. */
export const EDGE_GRIP = 4;

/** Size of the corner hit-zones. */
export const CORNER_GRIP = 14;

/**
 * Height of the window-controls strip — always 2rem (h-8), even when the title
 * bar is h-10 at narrow widths. The right edge starts below it. Uses rem (not a
 * fixed px) so it tracks the app zoom level; a px value would let the grip
 * overlap the close button at zoom levels above 100%.
 */
export const CONTROLS_HEIGHT = "2rem";

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
 * Scale a DOM button-cluster width by the app's rem-based zoom. The chrome
 * buttons are rem-sized, so their containers must grow by the same factor or the
 * buttons overflow at high zoom. The NATIVE insets (macOS traffic lights,
 * Windows/Linux captions) are fixed and added separately by the callers.
 */
function scaleCluster(px: number, zoom: number): number {
  return Math.round((px * zoom) / 100);
}

/**
 * Width the window's left-edge column reserves for the left overlay.
 * `macInset` adds the traffic-light clearance (desktop macOS only); `zoom` (a
 * percent, default 100) scales the rem-sized button cluster.
 */
export function leftChromeReserve(macInset: boolean, zoom = 100): number {
  return (macInset ? MAC_TRAFFIC_LIGHT_INSET : 0) + scaleCluster(LEFT_CHROME_CLUSTER, zoom);
}

/**
 * Full width of the left overlay: the reserved cluster, or the expanded
 * search width while the conversation search input is open (whichever is
 * wider). Single place that decides the overlay geometry; components consume
 * it through `--left-chrome-width`.
 */
export function leftChromeWidth(
  searchOpen: boolean,
  macInset: boolean,
  zoom = 100,
): number {
  const reserve = leftChromeReserve(macInset, zoom);
  if (!searchOpen) return reserve;
  return (
    (macInset ? MAC_TRAFFIC_LIGHT_INSET : 0) +
    Math.max(scaleCluster(LEFT_CHROME_CLUSTER, zoom), CHROME_SEARCH_EXPANDED_WIDTH)
  );
}

/**
 * Width the window's right-edge column reserves for the right overlay.
 * `winLinuxCaption` adds the native caption-button strip (desktop Win/Linux);
 * `zoom` (a percent, default 100) scales the rem-sized button cluster.
 */
export function rightChromeReserve(winLinuxCaption: boolean, zoom = 100): number {
  return scaleCluster(RIGHT_CHROME_CLUSTER, zoom) + (winLinuxCaption ? WINDOW_CAPTION_WIDTH : 0);
}

/**
 * The right-edge overlay's OWN width — just the (zoom-scaled) button cluster.
 * The native caption strip isn't part of this box; it's cleared by the
 * overlay's `right` offset, so only the cluster is measured here.
 */
export function rightChromeClusterWidth(zoom = 100): number {
  return scaleCluster(RIGHT_CHROME_CLUSTER, zoom);
}
