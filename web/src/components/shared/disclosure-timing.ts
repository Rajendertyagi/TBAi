/**
 * Collapse/expand duration shared by the three disclosure elements: `reasoning`,
 * `tool-group` and `tool-fallback`.
 *
 * ONE owner for the value. The animation itself is timed in CSS by the
 * `aui-disclosure-timing` utility in `styles/globals.css`, which defines
 * `--animation-duration`; the elements read it through the ordinary
 * `duration-(--animation-duration)` / `animation-duration-(--animation-duration)`
 * utilities. That covers the styling, and the elements no longer set the
 * variable through an inline `style`.
 *
 * What CSS cannot cover is `useScrollLock`, which needs the same number as a JS
 * argument. That is what this constant is: the single JS-side copy. Before it
 * existed the literal `200` was declared in three element files plus the
 * stylesheet, and a retune was a four-file edit that could silently half-apply.
 *
 * The two sides are still two literals — CSS cannot read a TS constant, and TS
 * cannot read a custom property at module scope without a layout read that would
 * be wrong on the server. They are pinned together by
 * `tests/unit/web/components/disclosure-timing.test.ts`, which fails if either
 * moves without the other, so the coupling is enforced rather than promised in a
 * comment.
 */

/** Collapse/expand duration in milliseconds. Keep in step with `--animation-duration` in `styles/globals.css`. */
export const DISCLOSURE_ANIMATION_DURATION_MS = 200;
