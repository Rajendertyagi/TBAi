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
 * real height as it mounts. TanStack's own guidance recommends estimating the
 * largest plausible size when measuring dynamically, because an undersized
 * estimate costs a correction frame for every row that mounts.
 *
 * ## Status: 320 is retained BY DEFAULT, not proven superior to 200
 *
 * This value was previously justified with two claims. Both have since been
 * checked, and neither survives:
 *
 *  1. "320 over-estimates the initial range by ~18-19%." That figure came from
 *     `initial-scroll-range.spec.ts`, which samples the container height after
 *     `waitForSelector` — i.e. usually AFTER rows have been measured, so it does
 *     not measure the estimate at all. Repeated runs of the same fixture
 *     reported 0.0%, 18.0% and 89.6% for identical input. The percentage is a
 *     sampling artifact and has been withdrawn.
 *  2. "200 breaks R2/R3, therefore 320." Also unsupported. Substituting 200 did
 *     make R2 and R3 fail with `distanceFromEnd 0`, but R2 subsequently failed
 *     at 320 too, before any estimate change, for an unrelated reason (the
 *     parking precondition depended on transcript height modulo the wheel step).
 *     The comparison never isolated the estimate.
 *
 * So there is currently NO evidence that 320 is better than 200, and none that it
 * is worse. 320 is simply the value that was in place, and changing it now would
 * be churn justified by nothing.
 *
 * ## What would actually settle it
 *
 * A deterministic sample taken BEFORE the first `measureElement` call corrects
 * the range — not after it — across enough conversations to matter. Until that
 * exists, do not tune this number from percentages, and do not cite the withdrawn
 * figures above. Re-derive the history-parking precondition onto a fraction of
 * the current scroll range at the same time, so the comparison cannot be
 * confounded by whether the reader is able to park mid-history at all.
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
  readonly renderRow: NonNullable<React.ComponentProps<typeof ThreadPrimitive.Row>["children"]>;
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
  const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows]);

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

  // ── No run-start jump, deliberately ──
  //
  // assistant-ui's official virtualization guide lists a "run-start jump": jump to
  // the bottom when `thread.isRunning` flips true "so a just-sent message never
  // flashes below the fold". P2 REBASE 2 removed it with the rest of the
  // hand-rolled following, and that removal is correct: the guide's version is
  // UNCONDITIONAL, and `R2` parks the reader ~4,200px from the end, sends, and
  // asserts the read position does NOT move. An unconditional jump fails R2.
  //
  // It was also TRIED here in a narrower form — jump only when the reader was
  // already within `scrollEndThreshold` of the end — and then removed again.
  // The guard was right (R2 passed 2/2, `scrollTopDeltaPx 0`), but it fixed
  // nothing: the start-of-run excursion persisted unchanged (3 pass / 3 fail
  // with the jump, versus 1 pass / 5 fail without). Keeping a change that adds a
  // scroll write and demonstrably helps nothing is worse than not having it.
  //
  // The excursion is real and is tracked in `run-start-scroll.spec.ts`
  // (`test.fixme`): ~316px away from the live end at frame 3 of ~150, settling
  // to ~22px. That is ≈ `ESTIMATED_ROW_SIZE_PX`, so the likely cause is one
  // unmeasured row's estimate landing before `followOnAppend` compensates.
  // The sent message itself was on screen in 150/150 frames, so the guide's
  // stated failure mode does not occur here.
  //

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

          ONE MORE THING THIS COMMENT HAS TO BE HONEST ABOUT: the equality of the
          two distances is NOT something TanStack Virtual guarantees. The library
          reads `scrollHeight` and `getTotalSize()` independently and never
          reconciles them; it will not warn if they diverge. `scrollHeight` is
          whatever the browser computes. So `scrollHeight === getTotalSize()` is
          an invariant TBAi OWNS and must keep maintaining - which is why the
          scrollport uses margin rather than padding (padding on a scroll
          container is part of its scrollable overflow), and why the header stays
          outside it. Treat any future CSS change to that scrollport as a change
          to this invariant until proven otherwise.

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
          <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
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
    throw new Error("useTranscriptVirtualizer must be used inside a <VirtualizedTranscript>.");
  }
  return value;
}
