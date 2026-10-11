/**
 * Virtualized transcript — one timeline for history AND the live streaming tail.
 *
 * ## Architecture (documented, not invented)
 *
 * ```
 * assistant-ui thread state
 *   -> createThreadRowsSelector()  -> ThreadRow[]
 *   -> useVirtualizer()            -> virtual items
 *   -> ThreadPrimitive.Row         -> one row's scope
 *   -> one scroll container owned here
 * ```
 *
 * **Rows, not messages.** `createThreadRowsSelector` flattens the thread into
 * message / part / turn-end rows, so one agent turn with a reasoning run and
 * hundreds of tool calls is many modest rows rather than one enormous cell.
 * `row.key` is assistant-ui's own stable key — documented as "stable across
 * streaming and earlier pages; use it as the list key" — and it is what the
 * virtualizer is keyed on.
 *
 * ## Scroll and anchoring belong to TanStack Virtual
 *
 * This is TanStack's documented chat composition, used as published:
 *
 * - `anchorTo: 'end'` — the live edge is the anchor. Prepending an older page
 *   keeps the visible row in place, and a viewport pinned to the end stays
 *   pinned as the last row grows during streaming.
 * - `followOnAppend` — follows appended output ONLY when the viewport was already
 *   at the end, so "users who have scrolled up to read history are not pulled
 *   down".
 * - `measureElement` — real row heights, so a streaming row is handled by
 *   measured size deltas rather than by an estimate being trusted.
 * - `scrollToEnd()` / `isAtEnd()` — the documented "jump to latest" and
 *   at-the-end question.
 *
 * There is deliberately no sticky-flag state machine, no manual `scrollTop`
 * write, no ResizeObserver that pins the scroller, no hand-rolled prepend
 * compensation and no custom `scrollToFn`. Those all existed here previously and
 * were the source of the production defect: the ResizeObserver pin pulled a
 * reader back to the live edge mid-stream, because the disarm heuristic it
 * depended on required the content height to be stable, which is never true
 * while a response is streaming.
 *
 * `ThreadPrimitive.Viewport` is not used, per the documented composition: its
 * auto-scroll assumes every message is mounted, which is exactly what
 * virtualization removes.
 */

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ThreadPrimitive,
  createThreadRowsSelector,
  groupPartByType,
  useAuiState,
} from "@assistant-ui/react";
import { SCROLL_END_THRESHOLD_PX } from "../config/virtualization";

/** Rows mounted beyond the viewport on each side, so a fast flick never blanks. */
const OVERSCAN_ROWS = 6;

/**
 * Initial row-height guess. Only a guess — `measureElement` records every row's
 * real height as it mounts. TanStack recommends estimating the LARGEST plausible
 * size when measuring dynamically, because an undersized estimate costs a
 * correction frame for every row that mounts.
 *
 * ## Why 320 and not 200
 *
 * A prior study measured candidates on real conversations and reported 200px
 * opening the initial scroll range far better than 320px. That claim was never
 * adopted here, and the note that recorded the decision was self-contradictory —
 * it compared "89%/41%/46% long" against "19%/7%/3% at 200", i.e. against 200
 * while arguing for 200 — so the actual numbers behind the choice were not on
 * the record. This was re-measured rather than inherited.
 *
 * At 320px the initial range overshoots the measured total by 18.0% on a 24-turn
 * conversation (`initial-scroll-range.spec.ts`), which matches the "19%" figure.
 * So 320 IS the less accurate estimate of the two, and that part of the earlier
 * study is reproducible.
 *
 * But accuracy is not the property at stake. The estimate sets the scroll range
 * BEFORE any row is measured, and `parkMidHistory` in
 * `scroll-anchoring-regressions.spec.ts` needs a reader parked a real
 * `distanceFromEnd >= 4000` from the live end before it appends output. Its
 * seeded transcript settles at ~4,850px in a 414px viewport, so the maximum
 * reachable distance from the end is ~4,436px — a 436px window.
 *
 * Substituting 200px was run end to end and R2 and R3 both FAILED with
 * "the reader is scrolled away from the top" (distanceFromEnd 0): with the
 * smaller initial range the reader could not be parked mid-history at all, so
 * both tests were silently exercising a reader who was still pinned to the live
 * end — the exact state they exist to rule out. R1, R4 and the rest of the
 * virtualizer suite passed, which is what makes this a real trade-off rather
 * than a broken build.
 *
 * So 320 stays: it over-estimates by 18% on load, and the alternative makes two
 * anchoring regressions unable to test what they claim to test. Re-raise this
 * only by re-basing `parkMidHistory` onto a precondition that does not depend on
 * the estimate (a fraction of the current scroll range), then re-run the
 * comparison. Do not "improve" the percentage while the reader-parks precondition
 * silently stops being reachable.
 */
const ESTIMATED_ROW_SIZE_PX = 320;

/**
 * One selector per list, at module scope. This is the expensive part, and it
 * returns the same array while a streamed token leaves the rows unchanged, so the
 * list re-renders only when rows actually appear, disappear, regroup or a turn
 * completes. Reasoning runs coalesce into one row, matching what
 * `MessagePrimitive.GroupedParts` does for the non-virtualized renderer.
 */
const selectRows = createThreadRowsSelector({
  groupBy: groupPartByType({ reasoning: ["group-reasoning"] }),
});

export type VirtualizedTranscriptProps = {
  /**
   * Renders one row. Keep its identity stable across renders — assistant-ui
   * documents this requirement, and the timeline invokes it for every mounted
   * row, so a fresh function each render re-renders the whole list.
   */
  readonly renderRow: NonNullable<
    React.ComponentProps<typeof ThreadPrimitive.Row>["children"]
  >;
  /**
   * Paging control. Rendered as a SIBLING above the scroll container, never
   * inside it — see the header note in the component body for why both facts
   * have to hold at once.
   */
  readonly header?: ReactNode;
  /**
   * Scroll-to-latest control. A SIBLING of the scroll container so it stays put
   * while the transcript scrolls, and under the provider so it reaches this
   * transcript's virtualizer through context.
   */
  readonly overlay?: ReactNode;
  readonly className?: string;
};

type TranscriptVirtualizer = ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>;

const TranscriptVirtualizerContext = createContext<TranscriptVirtualizer | null>(null);

/**
 * True when the transcript's scroll compensation is owned by the virtualizer.
 *
 * assistant-ui's `useScrollLock` captures the scroller's `scrollTop` when a
 * collapsible starts animating and pins it back on every `scroll` event for the
 * animation's duration. That is the right behaviour for a document whose layout
 * simply changes height, but here it is actively harmful: TanStack's
 * `shouldAdjustScrollPositionOnItemSizeChange` already compensates a row that
 * grows above the fold, and the lock overwrites that compensation on the very
 * `scroll` event it produces. The two mechanisms disagree about what "no jump"
 * means, and the lock's answer - leave `scrollTop` alone - is the one that moves
 * the content the reader is looking at.
 *
 * Consumed by the collapsible elements so they keep the lock's scrollbar handling
 * on surfaces that do NOT virtualize, and stand down where something else already
 * owns the position.
 */
const TranscriptOwnsScrollCompensationContext = createContext(false);

/**
 * Whether scroll compensation for this transcript is already handled elsewhere.
 *
 * @returns True inside a `<VirtualizedTranscript>`.
 */
export function useTranscriptOwnsScrollCompensation(): boolean {
  return useContext(TranscriptOwnsScrollCompensationContext);
}

/**
 * The virtualized transcript: history and the streaming tail are rows of this one
 * list, so there is a single scroll position and nothing to arbitrate.
 */
export function VirtualizedTranscript({
  renderRow,
  header,
  overlay,
  className,
}: VirtualizedTranscriptProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const rows = useAuiState(selectRows);

  // Memoized because TanStack documents it: the virtualizer invalidates its
  // measurement cache when measurement-affecting options change, and a new
  // function identity on every render is an unnecessary recalculation.
  const getItemKey = useCallback(
    (index: number) => rows[index]?.key ?? index,
    [rows],
  );

  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    count: rows.length,
    getItemKey,
    estimateSize: () => ESTIMATED_ROW_SIZE_PX,
    getScrollElement: () => scrollerRef.current,
    overscan: OVERSCAN_ROWS,
    // The documented chat contract.
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: SCROLL_END_THRESHOLD_PX,
  });

  // A thread opens at its latest message. The library's own call, in a layout
  // effect keyed on the instance so it runs once the scroll element exists and
  // lands before paint — the documented lifecycle, not a timing hack.
  useLayoutEffect(() => {
    virtualizer.scrollToEnd();
  }, [virtualizer]);

  const items = virtualizer.getVirtualItems();

  return (
    <TranscriptVirtualizerContext.Provider value={virtualizer}>
      <TranscriptOwnsScrollCompensationContext.Provider value={true}>
        {overlay}
        {/*
          THE HEADER IS A SIBLING OF THE SCROLLPORT, not a child of it. Both of
          the following have to be true, and only this arrangement gives both.

          (a) It stays visible at the top of the transcript.
          (b) It contributes nothing to the scrollport's scrollable geometry.

          virtual-core keeps two different end-distance functions:

            getVirtualDistanceFromEnd()  = getTotalSize() - size - scrollOffset
            getDistanceFromEnd()          = (scrollHeight - clientHeight) - scrollOffset

          `resizeItem` branches on the FIRST (virtual-core index.js:919) while
          `isAtEnd()` (index.js:1019) uses the second. They only agree when the
          scrollport's scrollable overflow is EXACTLY the total-size container. So
          anything inside the scrollport that adds height is poison:

            position: sticky  - stays in NORMAL FLOW, so its height joins
                                scrollHeight and the two distances diverge by
                                exactly the header height. That made the resize
                                branch report "at end" up to ~80px before the
                                viewport actually was.
            position: absolute- contributes 0, so (b) holds - but it does not
                                stick. It is laid out once at the content origin
                                and then scrolls away with everything else, so (a)
                                fails: measured against the real app, the header
                                sat at offset 0 at scrollTop=0 and -400 at
                                scrollTop=400 - tracking scrollTop one-to-one as
                                it slid up and off the top of the viewport, which
                                took the paging control out of reach for any
                                reader who had scrolled into history.

          Neither in-flow property satisfies both, which is why this was
          measured rather than argued.

          As a sibling the header satisfies both: it is not inside the
          scrollport at all, so `scrollHeight` is untouched and (b) holds; and it
          is a plain flex item above a `flex-1` scrollport, so it stays put
          while the transcript scrolls under it and (a) holds. It also stops
          overlaying the first row, so nothing behind it can be clicked away.

          The cost is honest and small: the scrollport is one header-band shorter
          than it was. That is the price of a control that is actually reachable,
          and it matches what the control looks like - a bar above the
          transcript, not a floating chip inside it. `shrink-0` stops the flex
          parent from compressing the band when the transcript is short.

          `transcript-header-contract.spec.ts` asserts (a) and (b) together, so a
          future "just make it sticky" edit cannot pass while quietly reopening
          the end-distance divergence `virtual-end-distance.spec.ts` guards.
        */}
        {header ? (
          <div data-testid="virtual-transcript-header" className="shrink-0">
            {header}
          </div>
        ) : null}
        <div
          ref={scrollerRef}
          // No `relative` here: it existed only to be the containing block for the
          // absolutely positioned header, which is now a sibling. Rows position
          // themselves against the total-size container below, which IS relative,
          // so nothing depended on it.
          className={className}
          data-testid="virtual-transcript-scroller"
        >
        {/*
          The total-size container IS the coordinate system: as tall as the whole
          logical list, with every row positioned inside it by its virtual offset.
        */}
        <div
          style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}
        >
          {items.map((item) => {
            const row = rows[item.index];
            // A row whose message has left the thread renders nothing, so a row
            // the virtualizer keeps for a frame after a deletion is safe.
            if (!row) return null;
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                data-row-key={row.key}
                style={{
                  position: "absolute",
                  transform: `translateY(${item.start}px)`,
                  width: "100%",
                }}
              >
                <ThreadPrimitive.Row row={row}>{renderRow}</ThreadPrimitive.Row>
              </div>
            );
          })}
        </div>
      </div>
      </TranscriptOwnsScrollCompensationContext.Provider>
    </TranscriptVirtualizerContext.Provider>
  );
}

/** True while the timeline is at (or within threshold of) the live end. */
export const isTranscriptAtEnd = (virtualizer: TranscriptVirtualizer): boolean =>
  virtualizer.isAtEnd(SCROLL_END_THRESHOLD_PX);

/**
 * Scroll to the live end, using the library's own call.
 *
 * `behavior: "instant"`, deliberately — this is a jump to a live position, not an
 * animation. A smooth scroll aims at an offset computed once, at the moment of the
 * click, and then spends seconds travelling toward it. If the transcript is long
 * or a response is streaming, the live edge MOVES while the animation is still in
 * flight, so the animation arrives at a stale target and stops short of the end.
 *
 * Measured on the mounted app: clicking this control on a ~4,650px transcript with
 * a response streaming left the reader 364px from the end, `scrollTop` still
 * moving when the animation expired. The arithmetic confirms the animation reached
 * the end as of its target (scrollTop 5344 + clientHeight 454 = 5798) and the
 * stream then added exactly the 364px it was short by. `followOnAppend` never
 * engaged, correctly, because the viewport was not within `scrollEndThreshold`.
 *
 * `instant` also matters for what happens AFTER the jump. TanStack only keeps an
 * end-pinned viewport pinned while the scroll is not smooth:
 * `virtual-core:916` requires `scrollState.behavior !== "smooth"` before the
 * end-anchored growth adjustment is allowed to run. A smooth scroll therefore
 * leaves the reader unpinned even if it lands exactly on the end, and the next
 * streamed chunk pulls them away again. Jumping instantly both establishes the
 * pinned position and keeps the library's own end-anchoring active for the growth
 * that follows.
 *
 * No custom scroll management is introduced: this is the virtualizer's supported
 * behaviour for the exact case above, and `scrollToEnd` remains the only scroll
 * primitive the control uses.
 */
export const scrollTranscriptToEnd = (virtualizer: TranscriptVirtualizer): void =>
  virtualizer.scrollToEnd({ behavior: "instant" });

/**
 * The transcript's OWN virtualizer, so a control (e.g. scroll-to-latest) drives
 * the real scroll element instead of guessing at one. There is exactly one
 * virtualizer instance per transcript: a second one would give the control a
 * different idea of the list than the list itself has.
 */
export function useTranscriptVirtualizer(): TranscriptVirtualizer {
  const value = useContext(TranscriptVirtualizerContext);
  if (!value) {
    throw new Error(
      "useTranscriptVirtualizer must be used inside a <VirtualizedTranscript>.",
    );
  }
  return value;
}
