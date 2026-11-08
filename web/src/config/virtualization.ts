/**
 * Shared scroll-anchoring constants for virtualized lists.
 *
 * These live here because two independent surfaces need the same value, and
 * AGENTS §1 requires that a value used in two places has exactly one home. The
 * logs viewer and the chat transcript both answer the same question — "how close
 * to the live end still counts as pinned?" — and they must answer it identically,
 * or a control that reports "at the end" can disagree with the list it drives.
 */

/**
 * How close to the live end counts as "at the end", in pixels.
 *
 * Deliberately generous: it absorbs sub-pixel row-measurement correction
 * without disarming following, so a stream that grows the last row by a few
 * pixels still reads as pinned.
 *
 * Both surfaces use `this` as the `scrollEndThreshold` option, which the
 * end-anchor logic consults before following an append or holding position
 * through a measurement correction. Raise or lower it only with both surfaces'
 * behaviour re-verified — the reasoning and the open question about whether 80px
 * suits the logs viewer's much shorter rows are in `docs/decisions.md`, under
 * "Logs viewer: virtualizer consolidated onto TanStack Virtual".
 */
export const SCROLL_END_THRESHOLD_PX = 80;
