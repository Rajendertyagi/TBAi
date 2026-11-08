import { expect, test, type Page } from "@playwright/test";
import {
  REASONING_TRIGGER,
  ROW,
  SCROLL_END_THRESHOLD_PX,
  firstFullyVisibleRow,
  mountRow,
  parkMidHistory,
  parkRowAboveFold,
  px,
  readGeometry,
  reasoningParts,
  rowByKey,
  seedTextConversation,
  seedTurnConversation,
  stubChatTransport,
  switchThread,
  toggleDisclosureInPlace,
  waitForRowGrowth,
} from "./transcriptAnchoring.ts";

/**
 * Scroll anchoring regressions for the virtualized transcript.
 *
 * Four claims, all of them about GEOMETRY, all of them browser-level.
 *
 * Why browser-level and not jsdom: the DOM harness recorded a measured
 * mutation-gate finding that anchorTo has no observable effect without a real
 * scroll element (tests/dom/virtualizer/virtual-transcript-harness.test.ts).
 * jsdom has no layout, so it has no scrollTop, no scrollHeight and therefore no
 * anchor. Whether a reader's position survives a row resize, an append or a
 * recovery can only be established against a real engine, which is what these
 * four do.
 *
 *   R1  a row positioned ABOVE the viewport grows, and the row the reader is
 *       looking at below it does not move.
 *   R2  content is appended while the reader has scrolled up, and the read
 *       position does not jump down.
 *   R3  a coordinated availability recovery runs while parked mid-history, and
 *       the read position survives it.
 *   R4  measurements survive a thread switch and a remount: the transcript
 *       comes back with correct geometry, not with stale offsets.
 *
 * Every number is read from the live page (getBoundingClientRect, scrollTop,
 * scrollHeight) and every test prints its report, so a green run states its
 * evidence rather than merely its verdict.
 */

/** Tolerance for "the reader's position did not move", matching the history specs. */
const ANCHOR_TOLERANCE_PX = 48;

const rows = (page: Page) => page.locator(ROW);

/** Open a conversation and let its measured row heights settle before reading anything. */
async function openConversation(
  page: Page,
  conversationId: string,
  newestBody: string,
  settleMs = 2000,
): Promise<void> {
  await page.goto(`/#/chat/${conversationId}`);
  // Wait on the newest turn's TEXT, not on a row: the last row of a thread is
  // often a turn-end row, which TBAi renders empty, so it has no box.
  await expect(page.getByText(newestBody)).toBeVisible({ timeout: 30000 });
  // Row heights are MEASURED, not estimated: let the correction frames land
  // before any position is taken as a baseline.
  await page.waitForTimeout(settleMs);
}

function report(name: string, data: Record<string, unknown>): void {
  console.log(`[${name}] ${JSON.stringify(data)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// R1 — a dynamic height change ABOVE the viewport must not move the reader.
//
// CURRENTLY FAILING, and that is the finding. Measured on this build, with a
// settled reasoning panel collapsed to 64px and parked 40px entirely above the
// fold, expanding it to 320px moves the anchor row down by EXACTLY the 256px
// growth while scrollTop does not move at all (33975 -> 33975). Reproduced
// identically across three separate runs of this file and once more in an
// isolated single-test spec, and unchanged when the reader is parked 900px,
// 1400px and 1900px from the live end instead of 130px. virtual-core 3.18.0
// gates the compensation on `itemStart + itemSize <= scrollOffset &&
// scrollDirection !== "backward"` (dist/esm/index.js:936) and neither branch
// fires here, so nothing absorbs the growth. The assertion below states the
// property a reader is entitled to, not the current behaviour; it is left
// failing rather than relaxed to whatever the code happens to produce.
// ─────────────────────────────────────────────────────────────────────────────

test("R1: a row that grows entirely above the fold leaves the reader's anchor row in place", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);

  // The reasoning turn sits inside the bounded window (the window is the last
  // 100 messages) and leaves THIRTEEN turns after it. The trailing turns are
  // load-bearing geometry, not filler: a browser clamps scrollTop, so a row can
  // only be held above the fold while there is more content below it than the
  // viewport is tall. Thirteen turns of content is ~600px against a 454px
  // viewport, which is what puts the row ~30px above the fold AND leaves the
  // reader genuinely off the live end.
  const conversationId = await seedTurnConversation(request, `r1 above-fold growth ${Date.now()}`, {
    totalMessages: 150,
    turnIndex: 136,
    turnParts: reasoningParts(14),
  });

  try {
    await openConversation(page, conversationId, "seeded-body-149");

    // The transcript is genuinely virtualized, so a small mounted footprint is
    // what makes "this row is still mounted while scrolled out of view above the
    // fold" a meaningful precondition rather than a claim about the whole list.
    const mountedAtTip = await rows(page).count();
    expect(mountedAtTip).toBeGreaterThan(0);
    expect(mountedAtTip).toBeLessThan(150);

    // The reasoning disclosure is ChatWindow's own collapsing panel for a settled
    // reasoning part, and it opens expanded. The row lives well above the tip,
    // outside the mounted range there, so it is mounted by scrolling to it first;
    // the collapse then happens where the reader can see it happen.
    const reasoningKey = await mountRow(page, REASONING_TRIGGER);
    const expanded = rowByKey(await readGeometry(page), reasoningKey);
    expect(expanded, "the seeded reasoning part rendered a disclosure").not.toBeNull();
    expect(expanded!.height, "the panel opens expanded in a reloaded history").toBeGreaterThan(
      ANCHOR_TOLERANCE_PX,
    );

    expect(
      await toggleDisclosureInPlace(page, {
        rowKey: reasoningKey,
        triggerSelector: REASONING_TRIGGER,
      }),
      "the reasoning disclosure was collapsed",
    ).toBe(true);
    await page.waitForTimeout(1200);

    const collapsed = await readGeometry(page);
    const collapsedRow = rowByKey(collapsed, reasoningKey);
    expect(collapsedRow, "the reasoning row is mounted after collapsing").not.toBeNull();
    expect(collapsedRow!.height, "the panel really collapsed").toBeLessThan(expanded!.height - 40);

    // Park: the collapsed row is ENTIRELY above the fold, and the row the reader
    // is looking at is fully visible below it.
    const park = await parkRowAboveFold(page, {
      targetSelector: REASONING_TRIGGER,
      minGapPx: 30,
    });
    const before = await readGeometry(page);
    const targetBefore = rowByKey(before, park.targetKey);
    const anchorBefore = rowByKey(before, park.anchorKey);

    // The corrected shape of the claim, asserted rather than assumed.
    expect(targetBefore, "the growing row is still mounted").not.toBeNull();
    expect(anchorBefore, "the anchor row is visible").not.toBeNull();
    expect(targetBefore!.bottom).toBeLessThanOrEqual(before.viewTop);
    expect(anchorBefore!.top).toBeGreaterThanOrEqual(before.viewTop - 1);
    expect(anchorBefore!.bottom).toBeLessThanOrEqual(before.viewBottom);
    expect(anchorBefore!.key).not.toBe(targetBefore!.key);
    // The growing row is ABOVE the anchor, not merely different from it.
    expect(anchorBefore!.top).toBeGreaterThanOrEqual(targetBefore!.bottom);

    // Expand it. HTMLElement.click() is used instead of a Playwright click
    // because Playwright scrolls its target into view first, which would move
    // the very position under test.
    expect(
      await toggleDisclosureInPlace(page, {
        rowKey: park.targetKey,
        triggerSelector: REASONING_TRIGGER,
      }),
      "the reasoning disclosure was expanded in place",
    ).toBe(true);

    // The row must ACTUALLY grow, or the anchoring assertion below is vacuous:
    // nothing happened, so nothing moved.
    await waitForRowGrowth(page, park.targetKey, targetBefore!.height + 80);
    // The disclosure animates open; wait past its duration before reading.
    await page.waitForTimeout(800);

    const after = await readGeometry(page);
    const anchorAfter = rowByKey(after, park.anchorKey);
    const targetAfter = rowByKey(after, park.targetKey);
    expect(anchorAfter, "the anchor row is still mounted after the growth").not.toBeNull();
    expect(targetAfter, "the grown row is still mounted").not.toBeNull();

    const anchorDelta = Math.abs(anchorAfter!.top - anchorBefore!.top);
    const scrollDelta = after.scrollTop - before.scrollTop;
    const growth = targetAfter!.height - targetBefore!.height;

    report("R1", {
      targetKey: park.targetKey,
      targetHeightBefore: px(targetBefore!.height),
      targetHeightAfter: px(targetAfter!.height),
      growthPx: px(growth),
      targetBottomBefore: px(targetBefore!.bottom),
      targetBottomAfter: px(targetAfter!.bottom),
      viewTop: px(before.viewTop),
      anchorKey: park.anchorKey,
      anchorTopBefore: px(anchorBefore!.top),
      anchorTopAfter: px(anchorAfter!.top),
      anchorDeltaPx: px(anchorDelta),
      scrollTopBefore: px(before.scrollTop),
      scrollTopAfter: px(after.scrollTop),
      scrollTopDeltaPx: px(scrollDelta),
      distanceFromEndBefore: px(before.distanceFromEnd),
      distanceFromEndAfter: px(after.distanceFromEnd),
    });

    // The row really expanded.
    expect(growth, "the collapsed disclosure genuinely grew").toBeGreaterThanOrEqual(80);

    // THE CLAIM. A row entirely above the fold changed size; the row the reader
    // is looking at must not move. Without virtual-core's
    // shouldAdjustScrollPositionOnItemSizeChange compensation, every row below
    // the growth is pushed down by the full growth, so the observed delta is
    // the growth itself rather than something near zero.
    expect(
      anchorDelta,
      "a row growing entirely above the fold must not move the anchor row the reader is looking at",
    ).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);
  } finally {
    await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// R2 — an append while the reader has scrolled up must not pull them down.
// ─────────────────────────────────────────────────────────────────────────────

test("R2: an append while the reader is scrolled up does not jump the read position down", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);

  const conversationId = await seedTextConversation(
    request,
    `r2 append while up ${Date.now()}`,
    150,
  );

  try {
    await openConversation(page, conversationId, "seeded-body-149");

    const transport = await stubChatTransport(page);
    const before = await parkMidHistory(page, { targetDistanceFromEnd: 4000 });

    // The precondition, in the app's own terms: isTranscriptAtEnd reads
    // virtualizer.isAtEnd(SCROLL_END_THRESHOLD_PX), and isAtEnd is exactly
    // "distance from the live end is within the threshold". Well above the
    // threshold is therefore isAtEnd() === false, with room to spare.
    expect(before.scrollTop, "the reader is scrolled away from the top").toBeGreaterThan(0);
    expect(
      before.distanceFromEnd,
      "the timeline is NOT at the live end, so followOnAppend is disarmed",
    ).toBeGreaterThan(SCROLL_END_THRESHOLD_PX * 4);

    const anchorBefore = firstFullyVisibleRow(before);
    expect(anchorBefore, "a row is visible to anchor the read position").not.toBeNull();

    // A real send, so the append is a real one: the composer submits, the
    // runtime persists the user turn and appends the assistant reply.
    const composer = page.getByRole("textbox", { name: /Send a message/i }).first();
    await expect(composer).toBeVisible({ timeout: 20000 });
    await expect(composer).toBeEnabled();
    await composer.fill("appended while the reader was scrolled up");
    await composer.press("Enter");
    await expect.poll(() => transport.count(), { timeout: 30000 }).toBe(1);
    // The stub answers in one response; this is the settle that lets the
    // stream, the appended rows and any follow-on-append adjustment all land.
    await page.waitForTimeout(2500);

    const after = await readGeometry(page);
    const anchorAfter = rowByKey(after, anchorBefore!.key);

    const scrollDelta = after.scrollTop - before.scrollTop;
    const anchorDelta = anchorAfter ? Math.abs(anchorAfter.top - anchorBefore!.top) : null;

    report("R2", {
      mountedRows: after.rows.length,
      scrollTopBefore: px(before.scrollTop),
      scrollTopAfter: px(after.scrollTop),
      scrollTopDeltaPx: px(scrollDelta),
      scrollHeightBefore: px(before.scrollHeight),
      scrollHeightAfter: px(after.scrollHeight),
      distanceFromEndBefore: px(before.distanceFromEnd),
      distanceFromEndAfter: px(after.distanceFromEnd),
      anchorKeyBefore: anchorBefore!.key,
      anchorKeyAfter: anchorAfter?.key ?? null,
      anchorTopBefore: px(anchorBefore!.top),
      anchorTopAfter: anchorAfter ? px(anchorAfter.top) : null,
      anchorDeltaPx: anchorDelta === null ? null : px(anchorDelta),
    });

    // Proof that an append actually happened, read from the geometry: content
    // BELOW the viewport grew. Without this the next assertion could pass simply
    // because nothing was added.
    expect(after.distanceFromEnd, "content was appended below the read position").toBeGreaterThan(
      before.distanceFromEnd,
    );

    // THE CLAIM, in the container's own coordinate. The reader asked to read
    // history, so the tail must not be pulled into view under them. Nothing
    // about this append changes the height of the transcript (rows are only
    // added at the end, below the fold), so scrollTop itself is the invariant
    // here and it is asserted absolutely.
    expect(
      Math.abs(scrollDelta),
      "an append must not pull a scrolled-up reader down to the live end",
    ).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);

    // THE CLAIM, as geometry rather than as an offset. Asserted whenever the
    // anchor survived the append; its absence is reported rather than hidden,
    // because scrollTop above is then the whole of the evidence.
    if (anchorAfter) {
      expect(
        anchorDelta!,
        "the row the reader was looking at must not move when output is appended",
      ).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);
    } else {
      console.log("[R2] the anchor row unmounted after the append; scrollTop is the evidence");
    }
  } finally {
    await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// R3 — a coordinated availability recovery must not move the read position.
// ─────────────────────────────────────────────────────────────────────────────

test("R3: an availability recovery preserves the reader's scroll position", async ({
  page,
  request,
}) => {
  // The availability poller only probes every 15s while healthy and backs off
  // (jittered, 0-4s) while not, so reaching offline and then online is a
  // real-time sequence rather than an instant one.
  test.setTimeout(300_000);

  const conversationId = await seedTextConversation(request, `r3 recovery ${Date.now()}`, 150);

  try {
    await openConversation(page, conversationId, "seeded-body-149");

    const before = await parkMidHistory(page, { targetDistanceFromEnd: 4000 });
    expect(before.scrollTop, "the reader is scrolled away from the top").toBeGreaterThan(0);
    expect(before.distanceFromEnd, "the reader is parked mid-history").toBeGreaterThan(
      SCROLL_END_THRESHOLD_PX * 4,
    );
    const anchorBefore = firstFullyVisibleRow(before);
    expect(anchorBefore, "a row is visible to anchor the read position").not.toBeNull();

    // Only /readyz is aborted. Every other API call keeps working, so this is an
    // availability outage rather than a dead backend: the transcript is expected
    // to survive it, so a data wipe or a jump to the live end would be a real
    // finding and not an artifact of the outage.
    await page.route("**/readyz", (route) => route.abort());

    await expect(page.getByTitle("Backend unavailable — showing last known state")).toBeVisible({
      timeout: 90000,
    });

    const offline = await readGeometry(page);
    const anchorOffline = rowByKey(offline, anchorBefore!.key);

    // Restore readiness. The probe that answers online after a non-online state
    // is the one that bumps recoveryEpoch and runs the single coordinated
    // recovery sequence (history + thread-list cache invalidation, providers
    // reload, tab-mirror reconciliation), so reaching "available" IS the
    // recovery, not merely the end of the outage.
    await page.unroute("**/readyz");
    await expect(page.getByTitle("Backend available")).toBeVisible({ timeout: 120000 });
    // Let the recovery sequence's own work settle before reading the position.
    await page.waitForTimeout(2500);

    const after = await readGeometry(page);
    const anchorAfter = rowByKey(after, anchorBefore!.key);

    const scrollDelta = after.scrollTop - before.scrollTop;
    const scrollHeightDelta = after.scrollHeight - before.scrollHeight;
    const anchorDelta = anchorAfter ? Math.abs(anchorAfter.top - anchorBefore!.top) : null;
    const distanceDelta = Math.abs(after.distanceFromEnd - before.distanceFromEnd);

    report("R3", {
      scrollTopBefore: px(before.scrollTop),
      scrollTopOffline: px(offline.scrollTop),
      scrollTopAfter: px(after.scrollTop),
      scrollTopDeltaPx: px(scrollDelta),
      scrollHeightBefore: px(before.scrollHeight),
      scrollHeightAfter: px(after.scrollHeight),
      scrollHeightDeltaPx: px(scrollHeightDelta),
      offlineAnchorTop: px(anchorOffline?.top ?? Number.NaN),
      offlineScrollTop: px(offline.scrollTop),
      distanceFromEndBefore: px(before.distanceFromEnd),
      distanceFromEndAfter: px(after.distanceFromEnd),
      distanceFromEndDeltaPx: px(distanceDelta),
      anchorKey: anchorBefore!.key,
      anchorTopBefore: px(anchorBefore!.top),
      anchorTopAfter: anchorAfter ? px(anchorAfter.top) : null,
      anchorDeltaPx: anchorDelta === null ? null : px(anchorDelta),
    });

    // THE CLAIM, as the anchor row's geometry, which is absolute: it does not
    // depend on the container's total height at all. An unmounted anchor is
    // itself the failure - with the position preserved and nothing above it
    // resized, a fully visible row stays mounted, so unmounting means the
    // reader moved.
    expect(
      anchorAfter,
      "the anchor row survived the recovery; if it unmounted, the read position moved",
    ).not.toBeNull();
    expect(
      anchorDelta!,
      "the row the reader was looking at must be at the same offset after a recovery",
    ).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);

    // The reader is left with the same amount of conversation below them. This
    // is the read position stated in the container's own coordinate, and it is
    // what says the recovery did not silently drop or re-fetch the buffer.
    expect(
      distanceDelta,
      "a recovery must not change how much conversation lies below the reader",
    ).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);

    // scrollTop is an offset INTO the transcript, and the transcript's total
    // height is still converging here: rows that are not mounted carry the
    // 320px estimate until they are measured, and recovery mounts more of them.
    // So scrollTop is allowed to track that total exactly, and must not move by
    // anything the total does not explain. A reader actually being yanked - the
    // failure this guards against - moves scrollTop with no matching change in
    // scrollHeight and fails this immediately.
    expect(
      Math.abs(scrollDelta - scrollHeightDelta),
      "the reader's offset into the CONTENT must not move across a recovery",
    ).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);
  } finally {
    await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// R4 — measurements must survive a thread switch, a recovery and a remount.
// ─────────────────────────────────────────────────────────────────────────────

test("R4: measurements survive a thread switch and a remount, and come back current", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);

  const label = Date.now();
  const conversationA = await seedTextConversation(request, `r4 thread a ${label}`, 150);
  const conversationB = await seedTextConversation(request, `r4 thread b ${label}`, 40);

  try {
    await openConversation(page, conversationA, "seeded-body-149");
    const first = await readGeometry(page);

    // Navigate between threads INSIDE the SPA (location.hash), so this is a
    // runtime remount rather than a full document reload, and so whatever the
    // virtualizer keeps across a remount is genuinely exercised.
    await switchThread(page, conversationB);
    await expect(page.getByText("seeded-body-39")).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(1500);
    const other = await readGeometry(page);

    await switchThread(page, conversationA);
    await expect(page.getByText("seeded-body-149")).toBeVisible({ timeout: 30000 });
    // Measurement correction frames after a remount: a row starts on the
    // estimate and is corrected a frame later, so a reading taken immediately
    // would be measuring the settling rather than the result.
    await page.waitForTimeout(2500);
    const back = await readGeometry(page);

    // Rows in virtual index order. The renderer emits them in that order; this
    // asserts it rather than relying on it.
    const ordered = [...back.rows].sort((a, b) => a.index - b.index);
    const indicesAscend = ordered.every((row, i) => i === 0 || row.index > ordered[i - 1]!.index);
    const contentRows = ordered.filter((row) => row.hasContent);
    const zeroHeightContentRows = contentRows.filter((row) => row.height <= 0);

    // The stale-measurement detector. A row is absolutely positioned at the
    // virtualizer's cached start; its rendered height is whatever the DOM says
    // it is. When the cache is current the two agree exactly and each row begins
    // where the previous one ended. When it is stale-small the row is painted
    // TALLER than the space it was allotted and the next row overlaps it;
    // stale-large leaves a gap. So "correct final geometry" is exactly "every
    // row starts where the previous one ended", and it is asserted in BOTH
    // directions rather than as a one-sided overlap check.
    const spacingErrors: Array<Record<string, number | string>> = [];
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1]!;
      const next = ordered[i]!;
      // next.top - prev.top is the space the virtualizer allotted prev; prev.height
      // is the space prev actually occupies. Positive means the cache is stale-small.
      const errorPx = prev.height - (next.top - prev.top);
      if (Math.abs(errorPx) > 1) {
        spacingErrors.push({
          prevIndex: prev.index,
          nextIndex: next.index,
          prevTop: px(prev.top),
          prevHeight: px(prev.height),
          nextTop: px(next.top),
          allottedPx: px(next.top - prev.top),
          errorPx: px(errorPx),
        });
      }
    }

    report("R4", {
      mountedRowsFirst: first.rows.length,
      mountedRowsOther: other.rows.length,
      mountedRowsBack: back.rows.length,
      scrollHeightFirst: px(first.scrollHeight),
      scrollHeightBack: px(back.scrollHeight),
      scrollHeightDelta: px(back.scrollHeight - first.scrollHeight),
      containerHeightBack: px(back.containerHeight),
      clientHeightBack: px(back.clientHeight),
      scrollTopBack: px(back.scrollTop),
      distanceFromEndBack: px(back.distanceFromEnd),
      minContentRowHeight: contentRows.length
        ? px(Math.min(...contentRows.map((row) => row.height)))
        : null,
      maxContentRowHeight: contentRows.length
        ? px(Math.max(...contentRows.map((row) => row.height)))
        : null,
      indicesAscend,
      zeroHeightContentRows: zeroHeightContentRows.length,
      spacingErrors: spacingErrors.length,
      spacingErrorSample: spacingErrors.slice(0, 3),
    });

    // The transcript really came back: rows render, and they render content.
    expect(back.rows.length).toBeGreaterThan(0);
    expect(contentRows.length).toBeGreaterThan(0);

    // Measurements are CURRENT, not left at zero: every mounted row that renders
    // content has a positive measured height.
    expect(
      zeroHeightContentRows.length,
      "every mounted row that renders content has a measured height above zero",
    ).toBe(0);

    // Row order is the virtualizer's own, ascending.
    expect(indicesAscend, "mounted rows keep their virtual index order").toBe(true);

    // THE CLAIM. A stale measurement cache would leave every row painted at a
    // height its own position does not agree with.
    expect(
      spacingErrors,
      "after a remount every row must start exactly where the previous one ended (stale measurements)",
    ).toEqual([]);

    // A thread opens at its latest message, and that is only true if the total
    // size the virtualizer scrolls to agrees with the real rendered height: a
    // total that is too large lands the reader short of the live edge.
    expect(
      back.distanceFromEnd,
      "a remounted thread opens at its live end, which requires current measurements",
    ).toBeLessThanOrEqual(SCROLL_END_THRESHOLD_PX);

    // The total-size container is the virtualizer's coordinate space and it is
    // real, not a collapsed or unpopulated box: it exists, and the transcript is
    // genuinely scrollable rather than one screenful.
    expect(back.containerHeight, "the total-size container has a real height").toBeGreaterThan(0);
    expect(
      back.scrollHeight,
      "a 150-turn conversation is far taller than the viewport",
    ).toBeGreaterThan(back.clientHeight * 4);

    // NOT asserted: that the total height after the remount EQUALS the total
    // height on the first visit. TanStack deliberately reuses measurements
    // cached by stable item key, and a remount mounts a different set of rows
    // than a cold load does, so the two totals legitimately differ by however
    // many rows each pass had measured. The delta is recorded above; equality
    // would be asserting which rows happen to be measured, not whether the
    // geometry that resulted is correct.
  } finally {
    await request.delete(`/api/conversations/${conversationA}`).catch(() => undefined);
    await request.delete(`/api/conversations/${conversationB}`).catch(() => undefined);
  }
});
