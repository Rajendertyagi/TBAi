/**
 * How tall the question dock's body may get.
 *
 * ## What this encodes
 *
 * The reference client (`D:\Temp\openchamber`, `FormDock.tsx` +
 * `useMobileAutocompleteMaxHeight.ts`) answers "how tall?" in three steps, and
 * this is those three steps, unchanged:
 *
 *   1. measure   available = max(0, floor(body.bottom - boundaryTop - 8))
 *   2. decide    next      = available < 320 ? max(120, available) : undefined
 *   3. apply     maxHeight = next === undefined ? undefined : max(120, next - 96)
 *
 * plus a CSS cap of `max-h-1/2` that step 2 only overrides when 320px genuinely
 * does not fit.
 *
 * ## The shape this produces
 *
 * The body GROWS to fit its content and is only ever capped. It is never given a
 * fixed height — that is what makes a two-option question look like a form that
 * needs scrolling. So the answer to "shrink to fit, or keep a fixed height?" in
 * this codebase is the third option: shrink to fit, with a 120px floor.
 *
 * ## Why the two subtractions are not decoration
 *
 * `-8` is the gap kept between the dock and the top of the conversation.
 *
 * `-96` is the chrome the scroll body does not own: the title, the progress, the
 * step dots above it and the Back/Next/Submit row below it. The body sits between
 * them, so it can only claim the room left over once that chrome is accounted
 * for. Omitting it lets a long option list push the title off the top of the
 * screen — which is the very failure the cap exists to prevent.
 *
 * ## Why a pure function
 *
 * The measurement is DOM work and cannot be unit tested; the three decisions
 * built on it are arithmetic and must be. Each is one exported function so a
 * silent change to any of the four numbers is visible in review.
 */

/** The CSS cap, left to CSS in the normal case so it tracks the viewport. */
export const FORM_DOCK_CSS_MAX_HEIGHT_CLASS = "max-h-1/2";

/** Gap kept between the dock and the top of the conversation, in pixels. */
export const FORM_DOCK_BOUNDARY_GAP_PX = 8;

/**
 * The height compared against in step 2. The reference client pairs this with a
 * `max-h-1/2` body, so the inline override only engages when half the viewport
 * genuinely does not fit.
 */
export const FORM_DOCK_NORMAL_MAX_HEIGHT_PX = 320;

/**
 * The smallest the body may get, in pixels — applied twice by the reference, once
 * as the floor in step 2 and again in step 3.
 *
 * Browser keyboard panning can put the dock's anchor above the boundary being
 * measured against, for a frame or for a whole pan. Without a floor that would
 * collapse the body to zero and the question would become invisible. A short
 * body that slightly overlaps the conversation beats no question at all.
 */
export const FORM_DOCK_MIN_HEIGHT_PX = 120;

/**
 * The chrome the scroll body does not own: title, progress and dots above it,
 * and the Back/Next/Submit row below it. Subtracted in step 3.
 */
export const FORM_DOCK_CHROME_PX = 96;

/**
 * Step 1 — the room between the dock's anchor and the top of the conversation.
 *
 * @param bodyBottomPx - The body's bottom edge, which is its anchor.
 * @param boundaryTopPx - The lower of the conversation's top and the visual
 *   viewport's top, already resolved by the caller.
 * @returns The available height in pixels, never negative.
 */
export function formDockAvailablePx(
  bodyBottomPx: number,
  boundaryTopPx: number,
): number {
  return Math.max(0, Math.floor(bodyBottomPx - boundaryTopPx - FORM_DOCK_BOUNDARY_GAP_PX));
}

/**
 * Step 2 — whether the measured room is small enough to override the CSS cap.
 *
 * @param availablePx - The result of {@link formDockAvailablePx}.
 * @returns The floored room, or `undefined` to leave the CSS cap alone.
 */
export function formDockMeasuredMaxHeight(availablePx: number): number | undefined {
  // A measurement that is not a usable number must not become `NaN` in an inline
  // style, which browsers drop and which would silently uncap the body.
  if (!Number.isFinite(availablePx)) return undefined;
  if (availablePx >= FORM_DOCK_NORMAL_MAX_HEIGHT_PX) return undefined;
  return Math.max(FORM_DOCK_MIN_HEIGHT_PX, availablePx);
}

/**
 * Step 3 — the inline `max-height` for the body.
 *
 * @param measured - The result of {@link formDockMeasuredMaxHeight}.
 * @returns A pixel cap, or `undefined` to let CSS decide.
 */
export function formDockBodyMaxHeight(measured: number | undefined): number | undefined {
  if (measured === undefined) return undefined;
  return Math.max(FORM_DOCK_MIN_HEIGHT_PX, measured - FORM_DOCK_CHROME_PX);
}
