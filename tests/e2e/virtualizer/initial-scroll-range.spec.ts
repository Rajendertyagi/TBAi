/**
 * Initial scroll-range accuracy: how wrong is the estimate, and does it matter?
 *
 * ## Why this file exists
 *
 * `ESTIMATED_ROW_SIZE_PX` in `VirtualizedTranscript.tsx` is the single number
 * that decides the scrollbar the reader sees BEFORE any row has been measured.
 * A conversation opens with every row at its estimate, so the thumb size and the
 * scroll range are derived from that one value; measured rows then correct it as
 * they mount.
 *
 * A prior study compared candidates on three usable conversations and reported
 * 200px substantially beating 320px on initial error, but was NOT adopted
 * because it broke two anchoring regressions. That evidence was thin and the
 * note defending 320px had an internal contradiction (it compared "200" against
 * "19%/7%/3% at 200"), so neither number was actually justified on the record.
 *
 * ## What this asserts, and what it only reports
 *
 * ASSERTED - the property that actually matters, independent of the estimate:
 *   - true bottom is reachable: jumping to the end leaves the reader AT the end,
 *     not near it. An estimate that is too small is the dangerous direction here,
 *     because it shortens the scroll range and can strand the last row.
 *   - the range converges: once rows are measured, the scrollport's scrollable
 *     height equals the virtualizer's total size.
 *
 * REPORTED, not asserted - the estimate's initial error. Mean row height is not
 * a stable target (TBAi rows are messages AND parts AND turn-ends, so the mix
 * moves per conversation), and pinning an assertion to a percentage would just
 * re-freeze the guess this file exists to keep honest. The numbers are printed
 * so the estimate can be re-chosen against real data instead of folklore.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  SCROLLER,
  seedTextConversation,
  waitForStableScrollHeight,
} from "./transcriptAnchoring";

interface RangeSample {
  readonly scrollHeight: number;
  readonly containerHeight: number;
}

/** Read the scrollable height and the virtualizer's total size, before they settle. */
async function readRange(page: Page): Promise<RangeSample> {
  return page.evaluate((scrollerSelector) => {
    const scroller = document.querySelector(scrollerSelector);
    if (!scroller) throw new Error("the virtualized transcript scroller is not mounted");
    const rows = document.querySelectorAll<HTMLElement>("[data-row-key]");
    const container = rows[0]?.offsetParent as HTMLElement | undefined;
    return {
      scrollHeight: scroller.scrollHeight,
      containerHeight: container ? container.getBoundingClientRect().height : 0,
    };
  }, SCROLLER);
}

test.describe("initial scroll range", () => {
  for (const turns of [6, 12, 24]) {
    test(`true bottom stays reachable in a ${turns}-turn conversation`, async ({
      page,
      request,
    }) => {
      test.setTimeout(180_000);
      const conversationId = await seedTextConversation(
        request,
        `range-${turns}`,
        turns * 2,
      );

      await page.goto(`/#/chat/${conversationId}`);
      await page.waitForSelector(SCROLLER);

      // Sample as early as the scrollport exists: this is the reader's FIRST
      // impression of the scrollbar, before measurement has corrected anything.
      const first = await readRange(page);
      const settledHeight = await waitForStableScrollHeight(page);
      const settled = await readRange(page);

      const errorPct =
        settled.containerHeight === 0
          ? 0
          : ((first.containerHeight - settled.containerHeight) / settled.containerHeight) * 100;
      test.info().annotations.push({
        type: "estimate-study",
        description:
          `turns=${turns} initial=${Math.round(first.containerHeight)} ` +
          `settled=${Math.round(settled.containerHeight)} ` +
          `error=${errorPct.toFixed(1)}% scrollHeight=${settled.scrollHeight}`,
      });
      // Printed for the record; the assertion below is the real invariant.
      console.log(
        `[range] turns=${turns} initial=${Math.round(first.containerHeight)} ` +
          `settled=${Math.round(settled.containerHeight)} error=${errorPct.toFixed(1)}% ` +
          `scrollHeight=${settled.scrollHeight}`,
      );

      // The range CONVERGES: once rows are measured the two heights agree, which
      // is what lets `isAtEnd` and `resizeItem`'s `wasAtEnd` agree too.
      expect(settledHeight).toBeGreaterThan(0);
      expect(Math.abs(settled.scrollHeight - settled.containerHeight)).toBeLessThanOrEqual(1);

      // TRUE BOTTOM IS REACHABLE. This is the property an over-small estimate
      // breaks and the one that matters to a reader: after scrolling to the end,
      // the reader must actually BE at the end. An estimate that under-shrinks
      // the range strands the last row outside the reachable area.
      const atEnd = await page.evaluate((scrollerSelector) => {
        const scroller = document.querySelector(scrollerSelector) as HTMLElement;
        scroller.scrollTop = scroller.scrollHeight;
        return new Promise<number>((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              resolve(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight);
            }),
          );
        });
      }, SCROLLER);
      expect(
        atEnd,
        "the reader could not reach the true bottom of the transcript",
      ).toBeLessThanOrEqual(1);
    });
  }
});