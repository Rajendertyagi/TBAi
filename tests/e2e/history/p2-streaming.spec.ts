import { expect, test, type Page } from "@playwright/test";
import { startControlledProvider, type ControlledProvider } from "../helpers/controlledProvider.ts";

/**
 * P2 streaming behaviour through the VIRTUALIZED production path.
 *
 * ## The fixture matters
 *
 * This deliberately does NOT intercept `/api/chat`. Holding the browser request
 * delivers bytes the app's own backend never produced and the run never becomes
 * a real run; `helpers/controlledProvider.ts` documents that this exact mistake
 * produced "deterministic failures that said nothing about the app". Instead a
 * real OpenAI-compatible provider is registered through the app's own API and the
 * real backend streams from it over a real socket, so the run is genuinely in
 * flight and genuinely mid-stream.
 *
 * The provider HOLDS the response open, which is what makes the central
 * assertion possible: the viewport is moved away WHILE the run is in flight, so
 * the question "does streaming steal the read position" is actually asked.
 */

const scroller = (page: Page) => page.locator('[data-testid="virtual-transcript-scroller"]');
const rows = (page: Page) => page.locator("[data-row-key]");

async function distanceFromEnd(page: Page): Promise<number> {
  return scroller(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

/** A conversation with enough text that the transcript genuinely overflows. */
async function seedScrollableConversation(
  request: import("@playwright/test").APIRequestContext,
  paragraphs: number,
): Promise<string> {
  const created = await request.post("/api/conversations", {
    data: { title: `p2 stream ${Date.now()}`, workspaceMode: "simple", engine: "direct" },
  });
  const { id } = (await created.json()) as { id: string };
  for (let i = 0; i < paragraphs; i += 1) {
    await request.post(`/api/conversations/${id}/messages`, {
      data: {
        message: {
          id: `seed-${i}`,
          parent_id: i === 0 ? null : `seed-${i - 1}`,
          format: "ai-sdk/v6",
          content: {
            role: i % 2 === 0 ? "user" : "assistant",
            parts: [
              {
                type: "text",
                text: `history paragraph ${i} ${"filler sentence to give the row real height. ".repeat(12)}`,
              },
            ],
          },
        },
      },
    });
  }
  return id;
}

test.describe("P2 streaming behaviour (virtualized path)", () => {
  /**
   * One controlled provider per test.
   *
   * Provider names are UNIQUE and the E2E database is per spec FILE, so this file
   * registering two providers needs distinct names. That is the helper's job now
   * (`nextProviderName`), NOT a delete dance here: `DELETE /api/providers/:id`
   * deliberately refuses while conversations still reference the provider, and
   * these specs deliberately leave such conversations behind - so the delete
   * returned 400, the name stayed taken, and the second registration 500'd.
   */
  let provider: ControlledProvider;

  test.beforeEach(async ({ request }) => {
    provider?.stop();
    provider = await startControlledProvider(request);
  });

  test.afterEach(() => {
    provider?.stop();
  });

  test("L/M: a run started while scrolled away does not steal the read position", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const conversationId = await seedScrollableConversation(request, 24);

    try {
      await page.goto(`/#/chat/${conversationId}`);
      await expect(scroller(page)).toBeVisible({ timeout: 30000 });
      await expect(page.getByText(/history paragraph 23/).first()).toBeVisible({
        timeout: 30000,
      });
      // Real scroll room, or "scrolled away" means nothing.
      await expect
        .poll(async () => scroller(page).evaluate((el) => el.scrollHeight - el.clientHeight), {
          timeout: 20000,
        })
        .toBeGreaterThan(200);

      const box = page.getByRole("textbox", { name: /Send a message/i }).first();
      await box.click();
      await box.pressSequentially("start a run while I read history", { delay: 5 });
      await page.locator('button[type="submit"]').click();

      // The run is genuinely in flight: the provider received the request and has
      // emitted a frame, and it is being held open.
      await expect.poll(() => provider.requestCount, { timeout: 60000 }).toBeGreaterThan(0);
      await expect(page.getByRole("button", { name: /Stop generating/i })).toBeVisible({
        timeout: 30000,
      });

      // Park ~400px from the live edge WHILE the run is still in flight, using a
      // REAL wheel gesture rather than a programmatic scrollTop write. A real
      // gesture is what a user produces, and it is the only input that reliably
      // marks "I am reading history" to any auto-follow implementation.
      const scrollerBox = await scroller(page).boundingBox();
      if (!scrollerBox) throw new Error("the transcript has no box");

      await page.mouse.move(
        scrollerBox.x + scrollerBox.width / 2,
        scrollerBox.y + scrollerBox.height / 2,
      );
      await page.mouse.wheel(0, -400);

      // The browser animates wheel scrolling, so a single immediate read catches
      // the gesture mid-flight (it measured 24px of a 400px wheel). Poll until
      // the gesture settles rather than asserting on a partial frame - the
      // assertion below is still a strict ">200px away", never a relaxed bound.
      await expect.poll(() => distanceFromEnd(page), { timeout: 10_000 }).toBeGreaterThan(200);

      // Let the held run stream and finish.
      provider.complete();
      await expect
        .poll(() => page.getByRole("button", { name: /Stop generating/i }).count(), {
          timeout: 60000,
        })
        .toBe(0);
      await page.waitForTimeout(800);

      // THE ACCEPTANCE: a reader who scrolled away during a run is not dragged back.
      expect(
        await distanceFromEnd(page),
        "streaming must not return the viewport to the live edge while scrolled away",
      ).toBeGreaterThan(200);

      // No duplicate rows were produced by the run.
      const keys = await rows(page).evaluateAll((els) =>
        els.map((e) => e.getAttribute("data-row-key")),
      );
      expect(new Set(keys).size, "no duplicate virtual row keys").toBe(keys.length);

      // Returning to the live edge re-arms following for the next run.
      await page.getByRole("button", { name: /scroll to bottom/i }).click();
      await expect.poll(() => distanceFromEnd(page), { timeout: 8000 }).toBeLessThanOrEqual(80);
    } finally {
      await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
    }
  });

  test("L: a run started at the live edge follows the output", async ({ page, request }) => {
    test.setTimeout(180_000);
    const conversationId = await seedScrollableConversation(request, 24);

    try {
      await page.goto(`/#/chat/${conversationId}`);
      await expect(scroller(page)).toBeVisible({ timeout: 30000 });
      await expect(page.getByText(/history paragraph 23/).first()).toBeVisible({
        timeout: 30000,
      });

      const box = page.getByRole("textbox", { name: /Send a message/i }).first();
      await box.click();
      await box.pressSequentially("follow the live edge", { delay: 5 });
      await page.locator('button[type="submit"]').click();

      await expect.poll(() => provider.requestCount, { timeout: 60000 }).toBeGreaterThan(0);
      provider.complete();
      await expect
        .poll(() => page.getByRole("button", { name: /Stop generating/i }).count(), {
          timeout: 60000,
        })
        .toBe(0);

      // A run started at the live edge leaves the user at the live edge, and the
      // reply is actually on screen.
      await expect.poll(() => distanceFromEnd(page), { timeout: 30000 }).toBeLessThanOrEqual(80);
      await expect(page.getByText(/history paragraph 23/).first()).toBeVisible();
    } finally {
      await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
    }
  });
});
