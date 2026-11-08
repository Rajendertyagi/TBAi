import { expect, test, type Page } from "@playwright/test";
import {
  SCROLLER,
  SCROLL_END_THRESHOLD_PX,
  seedTextConversation,
  waitForStableScrollHeight,
} from "./transcriptAnchoring.ts";

/**
 * The floating composer overlay, and an append while the reader is pinned.
 *
 * ## The two claims
 *
 * 1. The transcript's scrollport reaches the bottom of the chat surface, and
 *    its live end stops ABOVE the composer overlay by a clear gap, with the
 *    fade band dissolving empty space rather than the newest line. The overlay
 *    is measured by assistant-ui's `ViewportFooter`, the reserve adds the tail
 *    gap, and the sum is fed back to the virtualizer as `paddingEnd`.
 * 2. Appending to the thread while the reader is pinned leaves the reader
 *    pinned, with that reserve in place.
 *
 * ## What the negative controls actually showed about `followOnAppend`
 *
 * This file was written to isolate `followOnAppend` (TanStack issue #1258: does
 * `paddingEnd` break the follow gate?). Measured, it does not isolate it, and
 * the result is recorded here rather than overclaimed by the title:
 *
 *   - with the app's pin observer active (the shipped code): setting
 *     `followOnAppend: false` STILL PASSES. The observer pins the scroller, so
 *     the library option is not what holds this reader;
 *   - with the pin observer disabled and `followOnAppend: true` (also with the
 *     custom `scrollToFn` replaced by the library default): the reader is left
 *     390px from the end. The library's follow gate alone does not hold the pin
 *     through this append, because the gate requires `isAtEnd` at the moment the
 *     options are applied and the appended content moves that answer.
 *   - with the reserve removed (`paddingEnd={0}`): the end sits inside the
 *     dock. That is the guarantee this spec owns, and it fails loudly when the
 *     reserve goes away.
 *
 * So this file guards the OVERLAY GEOMETRY and the user-visible pin, not the
 * library option. `#1258`'s mechanism is absent from the installed
 * virtual-core 3.19.6 (`getDistanceFromEnd` is element-based; the gate keys on
 * edge-key changes) — that is a source finding, and no browser run here can
 * confirm or deny it, because the component's own observer answers first.
 *
 * ## Why a send, and why a LONG reply
 *
 * A follow-on-append only happens when rows are appended, which only a real run
 * does. The reply is deliberately tall: a broken follow strands the reader by
 * the height of the appended content, so the guard has something unmistakable to
 * fail on. A short reply could sit inside the 80px pin threshold and mask it.
 *
 * ## What this spec does NOT assert
 *
 * It does not sample per frame. `run-start-scroll.spec.ts` owns that question
 * and carries a known, separately tracked start-of-run excursion; this spec
 * asserts the SETTLED end state, which is the contract the overlay depends on.
 */

/** Enough history that the transcript is genuinely scrollable and starts pinned. */
const SEEDED_MESSAGES = 40;

/** Unique prefix so the reply can be found without matching seeded bodies. */
const REPLY_TOKEN = "stub-overlay-reply";

/** Tall enough that a broken follow cannot hide inside the pin threshold. */
const LONG_REPLY = `${REPLY_TOKEN} ${"overflow filler paragraph text ".repeat(60)}`;

const FOOTER = "[data-composer-footer]";
const FADE = "[data-composer-fade]";

/**
 * The newest line must clear the fade band by at least one line of body text.
 * A reserve equal to the overlay's own height measures 0 here and fails — that
 * is the state the gap was added to fix.
 */
const MIN_TAIL_CLEARANCE_PX = 24;

/** The dissolve needs a real ramp; a hairline band reads as a hard edge. */
const MIN_FADE_RAMP_PX = 40;

interface OverlayGeometry {
  readonly distanceFromEnd: number;
  /** footerTop - last content row bottom. Positive means the transcript ends above the composer. */
  readonly endGap: number;
  /** scrollerBottom - footerBottom. Zero means the scrollport reaches the overlay's bottom edge. */
  readonly bottomGap: number;
  /** Height of the gradient band in the footer. */
  readonly fadeHeight: number;
  readonly scrollHeight: number;
  readonly contentRows: number;
}

async function readOverlayGeometry(page: Page): Promise<OverlayGeometry> {
  return page.evaluate(
    ({ scrollerSelector, footerSelector, fadeSelector }) => {
      const scroller = document.querySelector(scrollerSelector);
      const footer = document.querySelector(footerSelector);
      const fade = document.querySelector(fadeSelector);
      if (!scroller || !footer || !fade) {
        throw new Error("composer overlay probe: scroller, footer or fade is not mounted");
      }
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-row-key]"));
      // A turn-end row renders null and has no box, so the transcript's end is
      // the last row that actually renders something.
      let lastBottom = Number.NEGATIVE_INFINITY;
      let contentRows = 0;
      for (const row of rows) {
        if (row.childElementCount === 0) continue;
        contentRows += 1;
        // Absolute rows with translateY: the rect bottom is the on-screen edge.
        lastBottom = Math.max(lastBottom, row.getBoundingClientRect().bottom);
      }
      const scrollRect = scroller.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      return {
        distanceFromEnd: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        endGap: footerRect.top - lastBottom,
        bottomGap: scrollRect.bottom - footerRect.bottom,
        fadeHeight: fade.getBoundingClientRect().height,
        scrollHeight: scroller.scrollHeight,
        contentRows,
      };
    },
    { scrollerSelector: SCROLLER, footerSelector: FOOTER, fadeSelector: FADE },
  );
}

/** Serve a tall, already-complete reply through the real chat route. */
async function stubLongReply(page: Page): Promise<{ count: () => number }> {
  let submissions = 0;
  const frame = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`;
  await page.route("**/api/chat", async (route) => {
    submissions += 1;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "x-vercel-ai-ui-message-stream": "v1" },
      body:
        frame({ type: "start", messageId: "stub-overlay-1" }) +
        frame({ type: "start-step" }) +
        frame({ type: "text-start", id: "t1" }) +
        frame({ type: "text-delta", id: "t1", delta: LONG_REPLY }) +
        frame({ type: "text-end", id: "t1" }) +
        frame({ type: "finish-step" }) +
        frame({ type: "finish" }),
    });
  });
  return { count: () => submissions };
}

test("the composer overlay reserves the transcript's end and an append keeps a pinned reader pinned", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);

  const conversationId = await seedTextConversation(
    request,
    `overlay follow ${Date.now()}`,
    SEEDED_MESSAGES,
  );
  await page.goto(`/#/chat/${conversationId}`);
  await page.waitForSelector(SCROLLER);
  await expect(page.getByText(`seeded-body-${SEEDED_MESSAGES - 1}`)).toBeVisible({
    timeout: 30_000,
  });
  const settledHeight = await waitForStableScrollHeight(page);
  expect(settledHeight, "the transcript has scrollable content").toBeGreaterThan(2000);

  // ── 1. The overlay is mounted and the scrollport reaches it. ──
  await expect(page.locator(FOOTER), "the composer overlay is measured").toHaveCount(1);

  const before = await readOverlayGeometry(page);
  expect(before.bottomGap, "the scrollport reaches the overlay's bottom edge").toBeLessThanOrEqual(
    1,
  );
  expect(before.distanceFromEnd, "the reader starts at the live end").toBeLessThanOrEqual(
    SCROLL_END_THRESHOLD_PX,
  );
  // The end clears the composer by real air, and the band it clears is a
  // gradual ramp rather than a hard line.
  expect(before.fadeHeight, "the fade band is a paragraph-line ramp").toBeGreaterThanOrEqual(
    MIN_FADE_RAMP_PX,
  );
  expect(
    before.endGap,
    "the transcript's end keeps clear air above the fade band",
  ).toBeGreaterThanOrEqual(MIN_TAIL_CLEARANCE_PX);
  expect(
    before.endGap,
    "the transcript's end is not stranded above the overlay",
  ).toBeLessThanOrEqual(SCROLL_END_THRESHOLD_PX);

  // ── 2. Append while pinned: the reader stays pinned. ──
  const transport = await stubLongReply(page);
  const composer = page.getByRole("textbox", { name: /Send a message/i }).first();
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await expect(composer).toBeEnabled();
  await composer.fill("overlay follow probe");
  await composer.press("Enter");
  await expect.poll(() => transport.count(), { timeout: 30_000 }).toBe(1);
  await expect(page.getByText(REPLY_TOKEN)).toBeVisible({ timeout: 30_000 });
  // Let the measured rows, the appended turn-end row and the follow correction land.
  await page.waitForTimeout(2_500);

  const after = await readOverlayGeometry(page);
  test.info().annotations.push({
    type: "overlay-follow",
    description:
      `before dist=${Math.round(before.distanceFromEnd)} gap=${Math.round(before.endGap)} ` +
      `after dist=${Math.round(after.distanceFromEnd)} gap=${Math.round(after.endGap)} ` +
      `fade ${Math.round(before.fadeHeight)} ` +
      `scrollHeight ${Math.round(before.scrollHeight)}->${Math.round(after.scrollHeight)} ` +
      `rows ${before.contentRows}->${after.contentRows}`,
  });

  // Proof the append happened at all: without this the next assertion could pass
  // because nothing was added.
  expect(after.scrollHeight, "content was appended").toBeGreaterThan(before.scrollHeight + 100);

  expect(
    after.distanceFromEnd,
    "follow-on-append kept the reader at the live end",
  ).toBeLessThanOrEqual(SCROLL_END_THRESHOLD_PX);
  expect(
    after.endGap,
    "follow-on-append kept the newest line clear of the fade band",
  ).toBeGreaterThanOrEqual(MIN_TAIL_CLEARANCE_PX);
  expect(after.endGap, "the new end is not stranded above the overlay").toBeLessThanOrEqual(
    SCROLL_END_THRESHOLD_PX,
  );
});
