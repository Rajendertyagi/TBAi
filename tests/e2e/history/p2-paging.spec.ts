/**
 * P2: paging must keep working past the first page, and must not corrupt the
 * stored parent chain.
 *
 * ## What this locks down
 *
 * Paging prepends a page through the runtime, which PERSISTS it. The bounded
 * window's oldest row has no parent inside the window, so the repository seed
 * hands it `parentId: null` (`windowController.withBoundedRoot`). That synthesized
 * root used to reach `messageService.upsertStored`, whose write is
 * `ON CONFLICT(id) DO UPDATE SET parent_id`, and overwrite a real stored parent.
 *
 * Measured in the mounted app before the fix: after ONE "Load earlier" the stored
 * chain had a second root, so the backend correctly answered `n=0,
 * hasMoreBefore=false, complete=true` for every later cursor and the button kept
 * re-requesting the same anchor forever. The transcript simply stopped paging.
 *
 * So the assertions here are deliberately about PERSISTED STATE and long-run
 * progress, not about a single click succeeding:
 *
 *  - the stored chain keeps exactly ONE root across repeated paging,
 *  - the logical row count grows on every page until history is exhausted,
 *  - `hasEarlier` goes false exactly when the root is reached,
 *  - no duplicate row keys appear,
 *  - overlapping activations are DETERMINISTIC (the control disables, so the
 *    extra clicks cannot issue a second request for the same cursor).
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const scroller = (page: Page) => page.locator('[data-testid="virtual-transcript-scroller"]');
const loadEarlier = (page: Page) => page.getByRole("button", { name: /load earlier/i });

/** Pages beyond the first are what the defect broke; 260 needs all three. */
const SEEDED_MESSAGES = 260;
/** One bounded page is 100 messages, so 260 exercises tip + two prepended pages. */
const EXPECTED_PAGES = 3;
/**
 * The overlap case needs history to still exist after its activations. A forced
 * click that lands after the first request settles is a legitimate SECOND page
 * (not an overlap), so the seed must cover that too: at 100 messages per page,
 * two settled activations need more than 300 messages before the root is in
 * reach. At 260 the extra click simply exhausted history and the assertions
 * below were passing for the wrong reason.
 */
const OVERLAP_SEEDED_MESSAGES = 360;

async function seedChain(
  request: APIRequestContext,
  count: number,
  tag: string,
): Promise<string> {
  const created = await request.post("/api/conversations", {
    data: { title: `p2 paging ${Date.now()}`, workspaceMode: "simple", engine: "direct" },
  });
  const { id } = (await created.json()) as { id: string };
  for (let i = 0; i < count; i += 1) {
    await request.post(`/api/conversations/${id}/messages`, {
      data: {
        message: {
          id: `${tag}-${i}`,
          parent_id: i === 0 ? null : `${tag}-${i - 1}`,
          format: "ai-sdk/v6",
          content: {
            role: i % 2 === 0 ? "user" : "assistant",
            parts: [{ type: "text", text: `body ${i} ${"filler for real row height. ".repeat(10)}` }],
          },
        },
      },
    });
  }
  return id;
}

/**
 * The LOGICAL buffer size, not the mounted row count.
 *
 * `[data-row-key]` only exists for MOUNTED rows, and virtualization mounts only
 * what is near the viewport, so counting them says nothing about whether paging
 * accumulated. `data-index` spans the whole logical list, so the highest index
 * plus one is the real size.
 */
async function logicalRowCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const indexes = Array.from(document.querySelectorAll("[data-row-key]"))
      .map((r) => Number(r.getAttribute("data-index")))
      .filter((n) => Number.isFinite(n));
    return indexes.length > 0 ? Math.max(...indexes) + 1 : 0;
  });
}

/** Roots and broken links in the PERSISTED chain — the corruption itself. */
async function storedChainHealth(
  request: APIRequestContext,
  conversationId: string,
  expectedMessages: number,
  tag: string,
): Promise<{ roots: string[]; broken: string[]; rows: number }> {
  const res = await request.get(`/api/conversations/${conversationId}/messages`);
  const body = (await res.json()) as { messages: { id: string; parent_id: string | null }[] };
  const byId = new Map(body.messages.map((m) => [m.id, m.parent_id]));
  const roots: string[] = [];
  const broken: string[] = [];
  for (const message of body.messages) {
    if (message.parent_id === null) roots.push(message.id);
  }
  for (let i = 0; i < expectedMessages; i += 1) {
    const id = `${tag}-${i}`;
    const want = i === 0 ? null : `${tag}-${i - 1}`;
    if (!byId.has(id)) broken.push(`${id}:absent`);
    else if ((byId.get(id) ?? null) !== want) broken.push(`${id}:want=${want} got=${byId.get(id)}`);
  }
  return { roots, broken, rows: body.messages.length };
}

async function openConversation(page: Page, conversationId: string): Promise<void> {
  await page.goto(`/#/chat/${conversationId}`);
  await expect(scroller(page)).toBeVisible({ timeout: 30000 });
  await expect
    .poll(async () => scroller(page).evaluate((el) => el.scrollHeight - el.clientHeight), {
      timeout: 30000,
    })
    .toBeGreaterThan(200);
}

test.describe("P2 paging: multi-page progress and chain integrity", () => {
  test.setTimeout(600_000);

  test("keeps paging past the first page and never forks the stored chain", async ({
    page,
    request,
  }) => {
    const conversationId = await seedChain(request, SEEDED_MESSAGES, "main");
    try {
      await openConversation(page, conversationId);

      const before = await storedChainHealth(request, conversationId, SEEDED_MESSAGES, "main");
      expect(before.broken, "seeded chain is intact").toEqual([]);
      expect(before.roots, "seeded chain has exactly one root").toHaveLength(1);

      const counts: number[] = [await logicalRowCount(page)];
      for (let step = 0; step < EXPECTED_PAGES + 2; step += 1) {
        const button = loadEarlier(page);
        if ((await button.count()) === 0) break;
        const before = await logicalRowCount(page);
        await button.click();
        // Wait for the OUTCOME, not for the control's `disabled` flag.
        //
        // The flag is transient state that races React's re-render, and polling
        // it made this test fail ~50% of runs on a 20s timeout with the button
        // simply never observed in the expected state. The observable outcomes
        // are: the buffer grew, or the control disappeared because history is
        // genuinely exhausted (which is the truthful `hasEarlier`). Both mean
        // this activation is finished; neither depends on a transient.
        await expect
          .poll(
            async () => {
              if ((await logicalRowCount(page)) > before) return true;
              return (await loadEarlier(page).count()) === 0;
            },
            { timeout: 25000 },
          )
          .toBe(true);
        counts.push(await logicalRowCount(page));
      }

      // Every activation before exhaustion must ADD history. This is the
      // assertion the defect broke: page two and three produced nothing.
      for (let i = 1; i < counts.length; i += 1) {
        expect(
          counts[i]!,
          `activation ${i} added history (row counts: ${counts.join(" -> ")})`,
        ).toBeGreaterThan(counts[i - 1]!);
      }

      // The chain must still be a single unbroken line after all that paging.
      const after = await storedChainHealth(request, conversationId, SEEDED_MESSAGES, "main");
      expect(after.roots, "still exactly one root after paging").toHaveLength(1);
      expect(after.broken, "no stored link was re-rooted by a page").toEqual([]);

      // Exhaustion is reported truthfully: at the root there is nothing earlier.
      await expect(loadEarlier(page)).toHaveCount(0);

      // No duplicate rows were produced by any of the pages.
      const keys = await page
        .locator("[data-row-key]")
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-row-key")));
      expect(new Set(keys).size, "no duplicate virtual row keys").toBe(keys.length);
    } finally {
      await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
    }
  });

  test("overlapping activations are deterministic and issue one request", async ({
    page,
    request,
  }) => {
    // Two pages' worth: enough that `hasEarlier` survives the first activation,
    // without paying for a 260-message seed twice in one file.
    const conversationId = await seedChain(request, OVERLAP_SEEDED_MESSAGES, "ovl");
    const windowRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/messages/window")) windowRequests.push(r.url());
    });

    try {
      await openConversation(page, conversationId);
      const button = loadEarlier(page);
      await expect(button).toBeVisible();
      expect(await button.isDisabled(), "the control starts enabled").toBe(false);

      windowRequests.length = 0;

      // Observe the control from INSIDE the page, before the click, so no
      // transition can be missed. Sampling across CDP round-trips races React's
      // re-render and can easily read the flag after the work already finished.
      await page.evaluate(() => {
        const w = window as unknown as { __disabledSeen: boolean };
        w.__disabledSeen = false;
        const target = document.querySelector<HTMLButtonElement>(
          '[data-testid="load-earlier"], button[aria-label*="Load earlier" i]',
        ) ?? Array.from(document.querySelectorAll("button")).find((b) =>
          (b.textContent ?? "").includes("Load earlier"),
        );
        if (!target) throw new Error("load-earlier control not found");
        if (target.disabled) w.__disabledSeen = true;
        new MutationObserver(() => {
          if (target.disabled) w.__disabledSeen = true;
        }).observe(target, { attributes: true, attributeFilter: ["disabled"] });
      });

      await button.click();

      // ONE extra activation while the first may still be in flight. A DISABLED
      // button does not dispatch click, so this is expected to no-op; it is
      // bounded so a control that stays disabled fails rather than hangs. Kept to
      // a single extra click so 260 seeded messages still have a page left for
      // the "progress is still possible afterwards" assertion below.
      await button.click({ force: true, timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(1200);

      // Correct deduplication: the control disables itself, so the extra clicks
      // cannot produce a second request for the same cursor.
      const sawDisabledWhileBusy = await page.evaluate(
        () => (window as unknown as { __disabledSeen: boolean }).__disabledSeen,
      );
      expect(sawDisabledWhileBusy, "the control disables while a page is in flight").toBe(true);
      const cursors = windowRequests.map((u) => u.match(/anchorId=([^&]+)/)?.[1] ?? "null");
      expect(
        new Set(cursors).size,
        `one request per distinct cursor, got ${JSON.stringify(cursors)}`,
      ).toBe(cursors.length);

      // The user must not be stranded: keep activating until history is genuinely
      // exhausted, and require EVERY activation to add rows. Asserting the
      // control merely "re-enables" would depend on exact page arithmetic; what
      // matters is that the control still works and the buffer still grows.
      const counts: number[] = [await logicalRowCount(page)];
      for (let step = 0; step < 6; step += 1) {
        const b = loadEarlier(page);
        if ((await b.count()) === 0) break;
        const before = await logicalRowCount(page);
        await b.click();
        // Wait for the OUTCOME, not for the control's disabled flag: the flag is
        // a transient implementation detail that races React's re-render, while
        // "this activation added history" is the property under test.
        await expect
          .poll(() => logicalRowCount(page), { timeout: 25000 })
          .toBeGreaterThan(before);
        counts.push(await logicalRowCount(page));
      }
      for (let i = 1; i < counts.length; i += 1) {
        expect(counts[i]!, `post-overlap activation ${i} added history (${counts.join(" -> ")})`)
          .toBeGreaterThan(counts[i - 1]!);
      }
      expect(counts.length, "post-overlap paging made progress past the first page").toBeGreaterThan(1);
      await expect(loadEarlier(page), "history is exhausted at the root").toHaveCount(0);

      const after = await storedChainHealth(request, conversationId, OVERLAP_SEEDED_MESSAGES, "ovl");
      expect(after.roots, "overlap did not fork the chain").toHaveLength(1);
      expect(after.broken, "overlap did not re-root any link").toEqual([]);
    } finally {
      await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
    }
  });
});