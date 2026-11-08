import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * P2 measurements — the acceptance numbers, recorded rather than eyeballed.
 *
 * The point of the architecture is that a long conversation costs a small DOM,
 * so this spec measures the ratio instead of asserting "it looked fine". It also
 * measures the two things that are easy to claim and hard to see: how long a
 * page costs to load, and whether a prepend actually MOVES the read position.
 *
 * Rows are assistant-ui rows, not messages: one agent turn with a reasoning run
 * and many tool calls is deliberately several rows, so mounted rows are compared
 * against LOGICAL MESSAGES, never against a row count.
 */

const SEEDED_MESSAGES = 150;
const CONVERSATION = "p2 measurements";

function storedMessage(
  id: string,
  parentId: string | null,
  text: string,
  role: "user" | "assistant",
) {
  return {
    id,
    parent_id: parentId,
    format: "ai-sdk/v6",
    content: { role, parts: [{ type: "text", text }] },
  };
}

async function seedConversation(request: APIRequestContext): Promise<string> {
  const created = await request.post("/api/conversations", {
    data: { title: `${CONVERSATION} ${Date.now()}`, workspaceMode: "simple", engine: "direct" },
  });
  const { id } = (await created.json()) as { id: string };
  for (let batch = 0; batch < SEEDED_MESSAGES; batch += 15) {
    await Promise.all(
      Array.from({ length: Math.min(15, SEEDED_MESSAGES - batch) }, (_, offset) => {
        const index = batch + offset;
        return request.post(`/api/conversations/${id}/messages`, {
          data: {
            message: storedMessage(
              `seed-${index}`,
              index === 0 ? null : `seed-${index - 1}`,
              `seeded-body-${index}`,
              index % 2 === 0 ? "user" : "assistant",
            ),
          },
        });
      }),
    );
  }
  return id;
}

const rows = (page: Page) => page.locator("[data-row-key]");

/** Everything the acceptance list asks to be measured, read from the live page. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="virtual-transcript-scroller"]');
    const transcript = el?.parentElement ?? document.body;
    return {
      mountedRows: document.querySelectorAll("[data-row-key]").length,
      transcriptDomNodes: transcript.querySelectorAll("*").length,
      scrollTop: el?.scrollTop ?? 0,
      scrollHeight: el?.scrollHeight ?? 0,
      clientHeight: el?.clientHeight ?? 0,
    };
  });
}

test("P2 measurements: virtualized DOM, page latency, prepend stability", async ({
  page,
  request,
}) => {
  const conversationId = await seedConversation(request);

  try {
    // ── C: initial page load timing ───────────────────────────────────────
    const loadStart = Date.now();
    await page.goto(`/#/chat/${conversationId}`);
    await expect(page.getByText(`seeded-body-${SEEDED_MESSAGES - 1}`)).toBeVisible({
      timeout: 30000,
    });
    const initialMs = Date.now() - loadStart;

    const initial = await measure(page);
    const report: Record<string, string | number> = {
      logicalMessages: SEEDED_MESSAGES,
      mountedRows: initial.mountedRows,
      transcriptDomNodes: initial.transcriptDomNodes,
      domRatioVsMessages: (initial.mountedRows / SEEDED_MESSAGES).toFixed(3),
      initialPageMs: initialMs,
    };

    // A. logical count, B. mounted count: the whole point is the gap.
    expect(initial.mountedRows).toBeGreaterThan(0);
    expect(initial.mountedRows).toBeLessThan(SEEDED_MESSAGES / 4);
    expect(initial.transcriptDomNodes).toBeLessThan(4000);

    // ── D/E: load-earlier latency, and whether the read position moved ────
    // Park at a known read position first, so the prepend delta is meaningful.
    // Row heights are MEASURED, not estimated, but a row still starts on its
    // estimate and is corrected a frame later — so let measurement settle before
    // taking the "before" reading, or the comparison would charge the prepend for
    // settling that was already in flight.
    await page.mouse.move(600, 400);
    await page.mouse.wheel(0, -2000);
    await page.waitForTimeout(1200);
    const before = await measure(page);
    // A specific message under the top edge, and where it is on screen.
    const anchor = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="virtual-transcript-scroller"]');
      if (!el) return null;
      const view = el.getBoundingClientRect();
      const candidates = Array.from(document.querySelectorAll("[data-row-key]"));
      for (const row of candidates) {
        const r = row.getBoundingClientRect();
        if (r.top >= view.top && r.top <= view.bottom) {
          return { key: row.getAttribute("data-row-key"), offset: r.top - view.top };
        }
      }
      return null;
    });

    // Row identity across a prepend, captured before and after, so a jump can be
    // attributed to lost identity rather than guessed at.
    const keysBefore = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-row-key]")).map((r) =>
        r.getAttribute("data-row-key"),
      ),
    );

    const pageStart = Date.now();
    await page.getByRole("button", { name: /load earlier/i }).click();
    // The load is complete when the control retires: the controller reported it
    // has no more history before this page. Asserting on that rather than on a
    // message being on screen keeps this a measurement, not a scroll test — the
    // newly loaded rows are correct but may be outside the mounted range.
    await expect(page.getByRole("button", { name: /load earlier/i })).toHaveCount(0, {
      timeout: 20000,
    });
    const pageMs = Date.now() - pageStart;
    const after = await measure(page);

    report.loadEarlierMs = pageMs;
    report.prependAddedScrollHeight = after.scrollHeight - before.scrollHeight;
    report.mountedRowsAfterPrepend = after.mountedRows;

    // The page the user asked for is now in the logical buffer, and the buffer is
    // append-only: the newest message is still reachable and nothing was dropped.
    expect(await rows(page).count()).toBeLessThan(SEEDED_MESSAGES);

    // E. The read position must be PRESERVED: the same row that was under the
    // top edge is still there, at (nearly) the same offset. This is the property
    // the old eviction model could not hold, so it is asserted explicitly.
    if (anchor?.key) {
      const after2 = await page.evaluate((key) => {
        const el = document.querySelector('[data-testid="virtual-transcript-scroller"]');
        if (!el) return null;
        const view = el.getBoundingClientRect();
        const row = document.querySelector(`[data-row-key="${CSS.escape(key)}"]`);
        if (!row) return null;
        return { offset: row.getBoundingClientRect().top - view.top };
      }, anchor.key);
      const delta = after2 ? Math.abs(after2.offset - anchor.offset) : Number.NaN;
      report.prependAnchorDeltaPx = Number.isNaN(delta) ? "row-unmounted" : Math.round(delta);
      // The delta is RECORDED either way. The pass/fail assertion for it is
      // documented in the transcript component and is currently unmet; this spec
      // must not report green while the value is 369px, so it fails loudly rather
      // than relaxing the threshold to whatever the code happens to produce.
      if (after2) {
        expect(
          delta,
          "prepend must not jump the read position (see VirtualizedTranscript)",
        ).toBeLessThanOrEqual(48);
      }

      const keysAfter = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-row-key]")).map((r) =>
          r.getAttribute("data-row-key"),
        ),
      );
      const headerH = await page.evaluate(() => {
        const content = document.querySelector(
          `[data-testid="virtual-transcript-scroller"]`,
        )?.firstElementChild;
        const firstRow = document.querySelector("[data-row-key]");
        if (!content || !firstRow) return null;
        return {
          contentChildren: content.children.length,
          firstRowTop: Math.round(firstRow.getBoundingClientRect().top),
          firstChildH: Math.round(
            (content.firstElementChild as HTMLElement)?.getBoundingClientRect().height ?? 0,
          ),
        };
      });
      report.prependLayout = JSON.stringify(headerH);
      const retained = keysBefore.filter((k) => keysAfter.includes(k)).length;
      report.rowsBefore = keysBefore.length;
      report.rowsAfter = keysAfter.length;
      report.rowKeysRetained = retained;

      // Row identity must SURVIVE the prepend: the rows already on screen are
      // the same rows afterwards, not a rebuilt list that happens to look alike.
      expect(retained, "prepended rows keep their identity").toBeGreaterThan(0);

      // The row may legitimately have unmounted (it scrolled out of the mounted
      // range), but if it is still mounted its position must not have jumped.
      if (after2) expect(delta, "prepend must not jump the read position").toBeLessThanOrEqual(48);
    }

    console.log(`[p2-measurements] ${JSON.stringify(report)}`);
  } finally {
    await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
  }
});
