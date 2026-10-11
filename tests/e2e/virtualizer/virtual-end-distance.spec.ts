/**
 * R1b - CLOSURE PROOF for the `wasAtEnd` end-distance divergence.
 *
 * ## The defect this used to demonstrate
 *
 * virtual-core keeps two end-distance functions that must agree, and did not:
 *
 *   index.js:1016  getDistanceFromEnd()       = (scrollHeight - clientHeight) - scrollOffset
 *   index.js:1010  getVirtualDistanceFromEnd() = (getTotalSize() - size) - scrollOffset
 *
 * `isAtEnd()` (index.js:1019) uses the first. `resizeItem`'s `wasAtEnd`
 * (index.js:919) branches on the SECOND, so the resize path took the pin-to-end
 * branch while the viewport was genuinely not at the end.
 *
 * They diverged by whatever the scrollport held in its scrollable overflow that
 * the virtualizer's total size cannot see. Two contributors, both removed:
 *
 *   1. the sticky header - `position: sticky` stays in NORMAL FLOW, so its height
 *      joined `scrollHeight`. Now absolutely positioned: contributes 0.
 *   2. the scrollport's `py-6 pb-4` - padding on a scroll container is part of its
 *      scrollable overflow. Now `mt-6 mb-4`: margin is outside the border box and
 *      contributes nothing. Same spacing, identical visually.
 *
 * ## What this asserts now
 *
 * Not that the defect exists - that was the old version of this file, and a green
 * run there meant the bug was still present. This asserts CLOSURE:
 *
 *   - `scrollHeight === getTotalSize()`, i.e. the two functions share a space;
 *   - across a sweep of scroll positions, including BOTH threshold boundaries,
 *     `wasAtEnd === isAtEnd` and the two distances are equal.
 *
 * If either contributor returns, the sweep fails.
 *
 * This test says nothing about the 256px reset. It changes no row height, so it
 * cannot observe that race either way.
 */
import { expect, test } from "@playwright/test";
import { SCROLLER, seedTurnConversation, waitForStableScrollHeight } from "./transcriptAnchoring";

/** Mirrors web/src/config/virtualization.ts:SCROLL_END_THRESHOLD_PX. */
const SCROLL_END_THRESHOLD_PX = 80;

/** Half a pixel of slack; the numbers are pixel-rounded reads of the same quantity. */
const TOLERANCE_PX = 1;

interface EndDistanceReading {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly totalSize: number;
  readonly size: number;
  readonly virtualDistanceFromEnd: number;
  readonly distanceFromEnd: number;
  readonly wasAtEnd: boolean;
  readonly isAtEnd: boolean;
}

async function measureEndDistance(page: import("@playwright/test").Page): Promise<EndDistanceReading> {
  return page.evaluate((scrollerSelector) => {
    const scroller = document.querySelector(scrollerSelector) as HTMLElement;
    const view = scroller.getBoundingClientRect();
    const rows = document.querySelectorAll<HTMLElement>("[data-row-key]");
    // Rows are position:absolute inside the total-size container, so their
    // offsetParent is exactly the element the component sized from
    // virtualizer.getTotalSize().
    const container = rows[0]?.offsetParent as HTMLElement | undefined;
    const totalSize = container ? container.getBoundingClientRect().height : 0;
    const size = view.height;
    const scrollTop = scroller.scrollTop;

    const distanceFromEnd = Math.max(scroller.scrollHeight - scroller.clientHeight - scrollTop, 0);
    const virtualDistanceFromEnd = Math.max(totalSize - size - scrollTop, 0);

    return {
      scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      totalSize,
      size,
      virtualDistanceFromEnd,
      distanceFromEnd,
      wasAtEnd: virtualDistanceFromEnd <= 80,
      isAtEnd: distanceFromEnd <= 80,
    };
  }, SCROLLER);
}

async function scrollToOffset(
  page: import("@playwright/test").Page,
  offset: number,
): Promise<void> {
  await page.evaluate(
    ({ scrollerSelector, value }) => {
      const scroller = document.querySelector(scrollerSelector) as HTMLElement;
      scroller.scrollTop = Math.max(0, Math.min(value, scroller.scrollHeight - scroller.clientHeight));
    },
    { scrollerSelector: SCROLLER, value: offset },
  );
  await page.waitForTimeout(250);
}

test.describe("virtual end-distance closes on the DOM end-distance", () => {
  test("the scrollport and the virtualizer share one coordinate space", async ({ page, request }) => {
    test.setTimeout(240_000);
    const cid = await seedTurnConversation(
      request,
      `enddist-closed ${Date.now()}`,
      {
        totalMessages: 150,
        turnIndex: 136,
        turnParts: [{ type: "text", text: "seeded turn for end-distance reading" }],
      },
    );
    await page.goto(`/#/chat/${cid}`);
    await page.getByText("seeded-body-149").first().waitFor({ timeout: 30_000 }).catch(() => {});
    await waitForStableScrollHeight(page);
    await page.waitForTimeout(1500);

    const base = await measureEndDistance(page);

    // THE closure condition. While any content sits in the scrollport's scrollable
    // overflow that getTotalSize() cannot see, the two distance functions differ
    // by exactly that much, and wasAtEnd is wrong by exactly that much.
    expect(
      Math.abs(base.scrollHeight - base.totalSize),
      `scrollHeight must equal getTotalSize(): scrollHeight=${base.scrollHeight} totalSize=${base.totalSize}`,
    ).toBeLessThanOrEqual(TOLERANCE_PX);

    expect(
      base.scrollHeight - base.clientHeight,
      "the transcript must be long enough to sweep across both threshold boundaries",
    ).toBeGreaterThan(SCROLL_END_THRESHOLD_PX * 4);

    const maxScrollOffset = base.scrollHeight - base.clientHeight;

    // A sweep that straddles BOTH boundaries of the threshold: inside it (the
    // range where the old defect produced a false "at end"), exactly at it, and
    // well outside it in both directions.
    const offsets = [
      maxScrollOffset,
      maxScrollOffset - Math.round(SCROLL_END_THRESHOLD_PX / 2),
      maxScrollOffset - SCROLL_END_THRESHOLD_PX,
      maxScrollOffset - SCROLL_END_THRESHOLD_PX - 37,
      maxScrollOffset - SCROLL_END_THRESHOLD_PX * 3,
      0,
    ];

    const sweep: string[] = [];
    const readings: EndDistanceReading[] = [];
    let sawInsideThreshold = false;
    let sawOutsideThreshold = false;
    for (const offset of offsets) {
      await scrollToOffset(page, offset);
      const r = await measureEndDistance(page);
      readings.push(r);

      // The defect, stated as a failure: the two functions must agree everywhere.
      expect(
        Math.abs(r.distanceFromEnd - r.virtualDistanceFromEnd),
        `end-distances disagree at scrollTop=${Math.round(r.scrollTop)}: ` +
          `dom=${Math.round(r.distanceFromEnd)} virtual=${Math.round(r.virtualDistanceFromEnd)}`,
      ).toBeLessThanOrEqual(TOLERANCE_PX);
      expect(
        r.wasAtEnd,
        `resizeItem's wasAtEnd disagrees with isAtEnd at scrollTop=${Math.round(r.scrollTop)} ` +
          `(dom=${Math.round(r.distanceFromEnd)} <= ${SCROLL_END_THRESHOLD_PX} is ` +
          `${r.distanceFromEnd <= SCROLL_END_THRESHOLD_PX})`,
      ).toBe(r.isAtEnd);

      if (r.isAtEnd) sawInsideThreshold = true;
      else sawOutsideThreshold = true;

      sweep.push(
        `top=${Math.round(r.scrollTop)} dom=${Math.round(r.distanceFromEnd)} ` +
          `virtual=${Math.round(r.virtualDistanceFromEnd)} ` +
          `isAtEnd=${r.isAtEnd} wasAtEnd=${r.wasAtEnd}`,
      );
    }

    // Agreement is only meaningful if the sweep actually CROSSED the threshold.
    // Without this, every position could sit on one side and the assertions would
    // pass while proving nothing about the boundary - which is where the original
    // defect lived.
    expect(
      sawInsideThreshold && sawOutsideThreshold,
      `the sweep must straddle the threshold (inside=${sawInsideThreshold} ` +
        `outside=${sawOutsideThreshold}); readings:\n${sweep.join("\n")}`,
    ).toBe(true);

    // And specifically INSIDE but not at the end: the range in which the defect
    // produced a false "at end". Agreement there is the specific claim.
    expect(
      readings.some((r) => r.distanceFromEnd > 0 && r.distanceFromEnd <= SCROLL_END_THRESHOLD_PX),
      `the sweep must include a position strictly inside the threshold, not just the end ` +
        `(readings:\n${sweep.join("\n")})`,
    ).toBe(true);

    console.log(
      `  [end-distance-closed] scrollHeight=${base.scrollHeight} totalSize=${base.totalSize} ` +
        `gap=${Math.round(base.scrollHeight - base.totalSize)} threshold=${SCROLL_END_THRESHOLD_PX}`,
    );
    for (const line of sweep) console.log(`    ${line}`);
  });
});
