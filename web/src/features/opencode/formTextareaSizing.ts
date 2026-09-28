/**
 * Height arithmetic for a free-text answer that grows with what is typed.
 *
 * WHY A PURE FUNCTION. The height is read from the element, so the only testable
 * part is the mapping from scrollHeight to a pixel value. Keeping that mapping
 * pure means the growth rule is pinned by unit tests instead of by opening a
 * browser, and it means the numbers below live in exactly one place.
 *
 * The rule: never shorter than {@link FORM_TEXTAREA_MIN_LINES} lines (a one-line
 * box looks like an input and invites single-line answers), never taller than
 * {@link FORM_TEXTAREA_MAX_LINES} (past that it stops being an answer field and
 * starts fighting the transcript for space). Beyond the cap the caller switches
 * to scrolling rather than growing.
 */

/** Line height of the answer textarea, in pixels. */
export const FORM_TEXTAREA_LINE_HEIGHT_PX = 20;

/** The textarea never collapses below this many lines. */
export const FORM_TEXTAREA_MIN_LINES = 2;

/** The textarea grows to at most this many lines, then scrolls. */
export const FORM_TEXTAREA_MAX_LINES = 10;

/** The tallest the answer textarea may get, in pixels. */
export const FORM_TEXTAREA_MAX_HEIGHT_PX = FORM_TEXTAREA_LINE_HEIGHT_PX * FORM_TEXTAREA_MAX_LINES;

/** Whether a textarea that has reached the cap should scroll instead of grow. */
export function formTextareaOverflows(heightPx: number): boolean {
  return heightPx >= FORM_TEXTAREA_MAX_HEIGHT_PX;
}

/**
 * The height a free-text answer should take, in pixels.
 *
 * @param scrollHeight - The element's natural content height.
 * @returns The clamped height to apply, in pixels.
 */
export function formTextareaHeight(scrollHeight: number): number {
  const min = FORM_TEXTAREA_LINE_HEIGHT_PX * FORM_TEXTAREA_MIN_LINES;
  // NaN means the measurement failed; the box must still get a usable height,
  // or it collapses and the answer becomes invisible. Infinity means "taller
  // than we can lay out", so it clamps to the cap like any huge measurement.
  if (Number.isNaN(scrollHeight)) return min;
  if (scrollHeight <= min) return min;
  return Math.min(Math.ceil(scrollHeight), FORM_TEXTAREA_MAX_HEIGHT_PX);
}
