/**
 * The transcript header's DOCUMENTED contract, asserted rather than assumed.
 *
 * ## Why this file exists
 *
 * `VirtualizedTranscript`'s header prop documents a control that "sticks to the
 * top of the transcript". The wrapper that renders it is `position: absolute`,
 * chosen so the header contributes nothing to `scrollHeight` and the two
 * end-distance functions in virtual-core keep agreeing.
 *
 * Those two goals are in tension, and only one of them was being checked.
 * `virtual-end-distance.spec.ts` proves the geometry half (scrollHeight equals
 * getTotalSize()). Nothing proved the sticking half - and `position: absolute`
 * does NOT stick. `position: sticky` is the property that pins an element to the
 * viewport edge while content scrolls under it; an absolutely positioned box is
 * laid out once in its containing block and then scrolls away with everything
 * else. So the header left the viewport the moment the reader scrolled.
 *
 * ## What this asserts
 *
 *  1. The header is VISIBLE AT ALL, and visible at the top of the viewport, at
 *     several scroll positions - including deep in history. This is the contract
 *     the prop documents.
 *  2. The header still contributes NOTHING to the scrollable geometry, so the
 *     closure `virtual-end-distance.spec.ts` proves is not traded away to buy
 *     (1).
 *
 * A header that satisfies only (1) would reintroduce the end-distance
 * divergence; one that satisfies only (2) is the defect this file was written to
 * catch. Both must hold together.
 */
import { expect, test, type Page } from "@playwright/test";
import { SCROLLER, seedTextConversation, waitForStableScrollHeight } from "./transcriptAnchoring";

const HEADER = '[data-testid="virtual-transcript-header"]';

/** Half a pixel of slack; these are pixel-rounded reads of the same quantity. */
const TOLERANCE_PX = 1;

interface HeaderReading {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly containerHeight: number;
  /** Distance from the scrollport's top edge to the header's top edge. */
  readonly headerOffsetFromViewTop: number;
  readonly headerHeight: number;
  readonly headerWidth: number;
}

async function readHeader(page: Page): Promise<HeaderReading> {
  return page.evaluate(
    ({ scrollerSelector, headerSelector }) => {
      const scroller = document.querySelector(scrollerSelector);
      if (!scroller) throw new Error("the virtualized transcript scroller is not mounted");
      const header = document.querySelector(headerSelector);
      if (!header) throw new Error("the transcript header is not mounted");
      const rows = document.querySelectorAll<HTMLElement>("[data-row-key]");
      // Rows are position:absolute inside the total-size container, so their
      // offsetParent IS the element the component sized from getTotalSize().
      const container = rows[0]?.offsetParent as HTMLElement | undefined;
      const view = scroller.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      return {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        containerHeight: container ? container.getBoundingClientRect().height : 0,
        headerOffsetFromViewTop: headerRect.top - view.top,
        headerHeight: headerRect.height,
        headerWidth: headerRect.width,
      };
    },
    { scrollerSelector: SCROLLER, headerSelector: HEADER },
  );
}

async function scrollTo(page: Page, offset: number): Promise<void> {
  await page.evaluate(
    ({ scrollerSelector, value }) => {
      const scroller = document.querySelector(scrollerSelector) as HTMLElement;
      scroller.scrollTop = Math.max(
        0,
        Math.min(value, scroller.scrollHeight - scroller.clientHeight),
      );
    },
    { scrollerSelector: SCROLLER, value: offset },
  );
  await page.waitForTimeout(250);
}

test.describe("transcript header contract", () => {
  test("the paging header stays at the top of the viewport without extending the scroll geometry", async ({
    request,
    page,
  }) => {
    test.setTimeout(180_000);
    // Well past the bounded history window (pageSize 20), so the window really is
    // exhausted and `hasEarlier` is true on arrival.
    const conversationId = await seedTextConversation(request, "header contract", 150);
    await page.goto(`/#/chat/${conversationId}`);
    await page.waitForSelector(SCROLLER);
    // Let the bounded history window finish loading first: the paging control
    // cannot render until `hasEarlier` is known, and asserting before then tests
    // the loader rather than the header.
    await waitForStableScrollHeight(page);

    // The header band must have real height, or every assertion below passes
    // vacuously - which is exactly the "green but proves nothing" trap. Matched
    // by accessible name, not visible text: `TooltipIconButton` composes its
    // name from the tooltip as well as the label.
    await expect(page.getByRole("button", { name: /Load earlier/i })).toBeVisible({
      timeout: 30_000,
    });
    await waitForStableScrollHeight(page);

    const scrollerBox = await page.locator(SCROLLER).boundingBox();
    if (!scrollerBox) throw new Error("the transcript has no box");

    const positions = [0, 400, 1500, 3000];
    const readings: HeaderReading[] = [];
    for (const offset of positions) {
      await scrollTo(page, offset);
      readings.push(await readHeader(page));
    }

    // ── (1) The documented contract: it sticks. ──
    //
    // "Sticks to the top" means the header does not MOVE when the transcript
    // scrolls. It does not mean offset === 0: the header is a sibling ABOVE the
    // scrollport, so its offset from the scrollport's top edge is a constant
    // NEGATIVE number (its own height, plus the scrollport's top margin). What
    // must hold is that the offset is the SAME at every scroll position.
    //
    // This is exactly what an absolutely positioned header fails. Measured on
    // that implementation, headerOffsetFromViewTop tracked scrollTop one-to-one:
    // 0 at scrollTop=0, then -400 at scrollTop=400 - the control sliding UP and
    // off the top of the viewport the moment the reader entered history, which
    // is precisely when "Load earlier" is most wanted. Asserting the offset is
    // CONSTANT is what separates a pinned control from a scrolled-away one, and
    // it is what an "absolute positioning is fine" regression would break.
    const baseline = readings[0]!.headerOffsetFromViewTop;
    for (const reading of readings) {
      expect(
        reading.headerOffsetFromViewTop,
        `the header moved with the content at scrollTop=${Math.round(reading.scrollTop)}: ` +
          `offset ${reading.headerOffsetFromViewTop}, but ${baseline} at scrollTop=0`,
      ).toBeCloseTo(baseline, 0);
    }
    // A band of real height, not a zero-height box that satisfies the above.
    expect(readings[0]!.headerHeight).toBeGreaterThan(8);
    // And it sits ABOVE the scrollport rather than floating over the rows: a
    // header that overlaid the transcript would report a POSITIVE offset and
    // would also cover the first row's content, making it unclickable.
    for (const reading of readings) {
      expect(
        reading.headerOffsetFromViewTop,
        "the header overlaps the scrolling rows instead of sitting above them",
      ).toBeLessThan(-1);
    }

    // ── (2) The geometry contract must survive fixing (1). ──
    //
    // If the header is made to stick by returning it to normal flow, its height
    // rejoins `scrollHeight` and the two end-distance functions diverge again -
    // the exact regression `virtual-end-distance.spec.ts` guards. Re-assert the
    // invariant here so a future "just make it sticky" edit cannot pass this file
    // while quietly reopening that one.
    for (const reading of readings) {
      expect(
        Math.abs(reading.scrollHeight - reading.containerHeight),
        `the header rejoined the scroll geometry at scrollTop=${Math.round(reading.scrollTop)}`,
      ).toBeLessThanOrEqual(TOLERANCE_PX);
    }

    // Nothing below the header may be unreachable behind it: the header is a
    // fixed-height band, and every row is still reachable by scrolling.
    const last = readings[readings.length - 1]!;
    expect(last.scrollTop).toBeGreaterThan(0);
  });
});
