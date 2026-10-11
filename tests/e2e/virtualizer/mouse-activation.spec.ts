/**
 * R1c - does the 256px reset survive a REAL pointer interaction?
 *
 * The earlier mouse attempts were invalid: they reused `parkRowAboveFold`, whose
 * contract is that the target sits ENTIRELY above the fold, so the trigger was off
 * screen and `document.elementFromPoint` could never resolve to it. A click aimed
 * at an off-screen row measures the harness, not the application.
 *
 * This uses `parkRowInView`, which refuses to return a park unless the target row
 * is fully inside the scrollport AND its trigger is hit-testable, so the geometry
 * is validated before any result is interpreted.
 *
 * Scope, deliberately narrow: this spec asserts the MEASUREMENT is valid (valid
 * park, the click did not move the scroller, the row really grew 64 -> 320) and
 * records the outcome. It does NOT assert that the defect is present or absent -
 * resolving the `wasAtEnd` coordinate divergence would not resolve the reset, and a
 * green run here must not be read as "no bug".
 */
import { expect, test } from "@playwright/test";
import {
  REASONING_TRIGGER,
  mountRow,
  parkRowInView,
  readGeometry,
  reasoningParts,
  rowByKey,
  seedTurnConversation,
  toggleDisclosureInPlace,
  waitForStableScrollHeight,
} from "./transcriptAnchoring";

const COLLAPSED_PX = 64;
const EXPECTED_GROWTH_PX = 256;
const TOLERANCE_PX = 24;

test.describe("real pointer interaction", () => {
  test("a real click on a reachable trigger records the anchor outcome", async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);
    const cid = await seedTurnConversation(request, `r1mouse ${Date.now()}`, {
      totalMessages: 150,
      turnIndex: 136,
      turnParts: reasoningParts(14),
    });
    await page.goto(`/#/chat/${cid}`);
    await page
      .getByText("seeded-body-149")
      .first()
      .waitFor({ timeout: 30_000 })
      .catch(() => {});
    await waitForStableScrollHeight(page);
    await page.waitForTimeout(1500);

    const rowKey = await mountRow(page, REASONING_TRIGGER);

    // Setup only: collapse the panel by the programmatic path so the CLICK under
    // test is the single interaction being measured.
    let collapsed = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const height = rowByKey(await readGeometry(page), rowKey)?.height ?? -1;
      if (Math.abs(height - COLLAPSED_PX) <= TOLERANCE_PX) {
        collapsed = true;
        break;
      }
      await toggleDisclosureInPlace(page, { rowKey, triggerSelector: REASONING_TRIGGER });
      await page.waitForTimeout(900);
    }
    expect(collapsed, "the panel must start collapsed for the growth under test to be +256px").toBe(
      true,
    );

    // Throws unless the row is fully inside the scrollport and its trigger is
    // hit-testable - which is what makes any result below interpretable.
    const park = await parkRowInView(page, { targetSelector: REASONING_TRIGGER });

    const before = await readGeometry(page);
    const heightBefore = rowByKey(before, park.targetKey)?.height ?? -1;
    expect(
      Math.abs(heightBefore - COLLAPSED_PX),
      `the parked row must be collapsed (reading: ${JSON.stringify(park.rowBox)})`,
    ).toBeLessThanOrEqual(TOLERANCE_PX);

    // The invariant is measured on a row BELOW the growing one. Measuring the
    // growing row's own top would prove nothing: a panel that expands downward
    // leaves its own top exactly where it was whether or not anything compensates.
    // A row below only stays put if the growth is compensated for.
    const anchorKeyBefore = before.rows.find(
      (row) => row.key !== park.targetKey && row.height > 0 && row.top >= park.rowBox.bottom,
    )?.key;
    expect(
      anchorKeyBefore,
      "a row below the growing one must be mounted to observe the anchor",
    ).toBeDefined();

    const anchorTopBefore = rowByKey(before, anchorKeyBefore!)?.top ?? -1;
    const scrollTopBefore = before.scrollTop;

    // A trusted pointer event at the trigger's own centre - the exact point
    // parkRowInView proved is hit-testable.
    await page.mouse.click(
      (park.triggerBox.left + park.triggerBox.right) / 2,
      (park.triggerBox.top + park.triggerBox.bottom) / 2,
    );

    const afterClick = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      const el = document.querySelector(
        '[data-testid="virtual-transcript-scroller"]',
      ) as HTMLElement;
      return {
        scrollTop: el.scrollTop,
        active:
          active && active !== document.body
            ? `${active.tagName.toLowerCase()}/${active.getAttribute("data-slot") ?? "-"}`
            : "none",
      };
    });
    expect(
      Math.abs(afterClick.scrollTop - scrollTopBefore),
      "a click on a reachable trigger must not itself scroll the transcript",
    ).toBeLessThanOrEqual(1);
    expect(
      afterClick.active,
      "a trusted pointer click must focus the trigger, proving the event was real",
    ).toContain("reasoning-trigger");

    // The reset window.
    await page.waitForTimeout(1600);

    const after = await readGeometry(page);
    const heightAfter = rowByKey(after, park.targetKey)?.height ?? -1;
    const growth = heightAfter - heightBefore;
    expect(
      Math.abs(growth - EXPECTED_GROWTH_PX),
      `the row must have grown ${EXPECTED_GROWTH_PX}px (reading: ${heightBefore} -> ${heightAfter})`,
    ).toBeLessThanOrEqual(TOLERANCE_PX);

    const anchorTopAfter = rowByKey(after, anchorKeyBefore!)?.top ?? -1;
    const anchorDelta = anchorTopAfter - anchorTopBefore;
    const held = Math.abs(anchorDelta) <= 48;

    console.log(
      `  [mouse] park=${JSON.stringify(park.triggerBox)} view=${JSON.stringify(park.viewBox)} ` +
        `growth=${growth} active=${afterClick.active} anchorRow=${anchorKeyBefore} ` +
        `anchorDelta=${Math.round(anchorDelta)} scrollTop ${scrollTopBefore}->${after.scrollTop} ` +
        `${held ? "HELD" : "MOVED"}`,
    );
  });
});
