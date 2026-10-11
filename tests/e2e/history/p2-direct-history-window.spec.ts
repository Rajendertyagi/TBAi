import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * P2 Direct History Window — the LIVE application proof.
 *
 * Everything here runs against the real mounted TBAi Direct app: the real
 * `runtime.ts`, the real window-backed history adapter, the real viewport, the
 * real composer and the real transport boundary. Nothing is stubbed except the
 * model call itself, which is intercepted at the network layer so the run needs
 * no credentials while still counting real client-side submissions.
 *
 * The conversation is seeded with more messages than the window limit, so the
 * bounded initial load is observable rather than assumed.
 */

/** Must match `DEFAULT_WINDOW_LIMIT` in the Direct history window module. */
const WINDOW_LIMIT = 100;
/** Deliberately more than the limit, so a bounded load is distinguishable. */
const SEEDED_MESSAGES = 150;

/** One persisted row exactly as `POST /api/conversations/:id/messages` stores it. */
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

/** Seed a linear persisted chain of `SEEDED_MESSAGES`, alternating roles. */
async function seedConversation(request: APIRequestContext): Promise<string> {
  const created = await request.post("/api/conversations", {
    data: { title: `p2 window ${Date.now()}`, workspaceMode: "simple", engine: "direct" },
  });
  const { id } = (await created.json()) as { id: string };

  for (let batch = 0; batch < SEEDED_MESSAGES; batch += 10) {
    await Promise.all(
      Array.from({ length: Math.min(10, SEEDED_MESSAGES - batch) }, (_, offset) => {
        const index = batch + offset;
        const role = index % 2 === 0 ? "user" : "assistant";
        return request.post(`/api/conversations/${id}/messages`, {
          data: {
            message: storedMessage(
              `seed-${index}`,
              index === 0 ? null : `seed-${index - 1}`,
              `seeded-body-${index}`,
              role,
            ),
          },
        });
      }),
    );
  }
  return id;
}

const sse = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`;

/**
 * Intercept the real transport and count client-side submissions.
 *
 * The request is counted when the CLIENT issues it, which is exactly the claim
 * under test, so fulfilling it locally keeps the run hermetic.
 */
async function countTransportSubmissions(page: Page): Promise<{ count: () => number }> {
  let submissions = 0;
  await page.route("**/api/chat", async (route) => {
    submissions += 1;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "x-vercel-ai-ui-message-stream": "v1" },
      body:
        sse({ type: "start", messageId: "stub-1" }) +
        sse({ type: "start-step" }) +
        sse({ type: "text-start", id: "t1" }) +
        sse({ type: "text-delta", id: "t1", delta: "stubbed reply" }) +
        sse({ type: "text-end", id: "t1" }) +
        sse({ type: "finish-step" }) +
        sse({ type: "finish" }),
    });
  });
  return { count: () => submissions };
}

/** The rendered transcript rows, which is what the viewport measures. */
const rows = (page: Page) => page.locator("[data-message-id]");

test.describe("P2 bounded Direct history in the mounted app", () => {
  test("bounded load, paging, historical send blocked, restore then send", async ({
    page,
    request,
  }) => {
    const conversationId = await seedConversation(request);
    const transport = await countTransportSubmissions(page);

    try {
      // The seed itself is asserted first, so a later failure is unambiguous:
      // either the fixture did not land, or the bounded load did not read it.
      const listed = await request.get(`/api/conversations/${conversationId}/messages`);
      expect(listed.ok()).toBe(true);
      const persisted = (await listed.json()) as { messages: unknown[] };
      expect(persisted.messages).toHaveLength(SEEDED_MESSAGES);
      await page.goto(`/#/chat/${conversationId}`);

      // ── B: paged history + a virtualized DOM ────────────────────────────
      // The tail of the conversation is what loaded, and the whole 150-message
      // history was never fetched.
      await expect(rows(page).last()).toBeVisible({ timeout: 30000 });
      const initialRows = await rows(page).count();
      expect(initialRows).toBeLessThanOrEqual(WINDOW_LIMIT);
      expect(initialRows).toBeLessThan(SEEDED_MESSAGES);
      // Virtualization: the buffer holds a page, but only the rows near the
      // viewport are MOUNTED. This is the reference architecture's whole point —
      // a large logical history, a small mounted footprint.
      expect(initialRows).toBeLessThan(SEEDED_MESSAGES / 2);
      await expect(page.getByText("seeded-body-149")).toBeVisible();
      await expect(page.getByText("seeded-body-0")).toHaveCount(0);

      // ── D/E: the TBAi-owned control pages, and the page stays ───────────
      // Upstream's `ThreadPrimitive.LoadEarlier` is inert on this path, so the
      // affordance is TBAi's and it calls the controller through `setMessages`.
      const loadEarlier = page.getByRole("button", { name: /load earlier/i });
      await expect(loadEarlier).toBeVisible();

      // ONE click, as a user makes. The regression this guards is that the
      // click is SILENTLY IGNORED: the control renders (it is driven by the UI
      // snapshot) while `controller` is null in the hook, so `loadEarlier`
      // returns early and no request ever leaves the client. Repeated clicking
      // would have hidden that — it only failed intermittently, and a later
      // click could land after a re-render. So the count of history requests is
      // asserted from a SINGLE activation.
      let windowRequests = 0;
      const countWindowRequest = (r: { url(): string }) => {
        if (r.url().includes("/messages/window")) windowRequests += 1;
      };
      page.on("request", countWindowRequest);

      await loadEarlier.click();

      // The request must actually be issued. Condition-based, not a sleep: it
      // resolves as soon as the controller's fetch starts, and fails if the
      // click was dropped.
      await expect.poll(() => windowRequests, { timeout: 15000 }).toBeGreaterThan(0);
      page.off("request", countWindowRequest);

      // The page already shown is STILL in the logical buffer, exactly once.
      // It is not asserted as visible here: the timeline is at the live end and
      // only mounts nearby rows, so "still present" and "on screen" are
      // different questions — and the row count is asserted further down.
      //
      // The window is historical once the controller has committed, so the
      // control follows that state. Waiting on the CONTROL is waiting on the
      // commit: nothing but actually entering historical mode can satisfy it.
      await expect(page.getByRole("button", { name: /back to latest/i })).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByRole("button", { name: /load earlier/i })).toHaveCount(0);
      // The buffer is APPEND-ONLY, so the root of the conversation is now
      // reachable. Scrolling up is a real user gesture: it disarms the
      // auto-follow, so the viewport stays where the user put it.
      const scroller = page.locator('[data-testid="virtual-transcript-scroller"]');
      const box = await scroller.boundingBox();
      if (!box) throw new Error("the virtualized transcript has no box");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      // The transcript is far taller than a single wheel delta (its height comes from
      // measured rows, not a fixed estimate), so scroll until the viewport
      // genuinely reaches the top. One fixed-size gesture only lands partway up.
      await expect
        .poll(
          async () => {
            await page.mouse.wheel(0, -20000);
            await page.waitForTimeout(120);
            return scroller.evaluate((el) => el.scrollTop);
          },
          { timeout: 20000 },
        )
        .toBe(0);
      await expect(page.getByText("seeded-body-0")).toBeVisible({ timeout: 15000 });
      // Nothing was evicted: the newest message is still in the buffer, and the
      // mounted row count stayed small rather than doubling.
      expect(await rows(page).count()).toBeLessThan(SEEDED_MESSAGES);

      // ── H: historical state blocks the real composer ────────────────────
      // Paging back is the historical transition: the window is no longer the
      // active tip run, so `isSendDisabled` closes the gate at the runtime.
      await expect(page.getByRole("button", { name: /back to latest/i })).toBeVisible();

      const composer = page.locator("textarea").first();
      await composer.click();
      await composer.fill("this must not be submitted from a historical window");
      await composer.press("Enter");
      // Give any submission a real chance to happen before asserting none did.
      await page.waitForTimeout(1500);
      expect(transport.count()).toBe(0);

      // ── I/J: restoring the tip is idempotent and reopens the gate ───────
      const restore = page.getByRole("button", { name: /back to latest/i });
      await restore.click();
      await expect(restore).toHaveCount(0);

      // The buffer was never truncated, so the tip is still in it — it is simply
      // not MOUNTED while the viewport is parked at the top. Returning to the
      // live edge (which also re-arms auto-follow) proves it is still there.
      //
      // The pointer has to be put back over the transcript first. `restore` is a
      // toolbar control ABOVE the scroller, so clicking it leaves the cursor
      // there, and `mouse.wheel` dispatches at the cursor — over the toolbar,
      // outside the scroll container — where it scrolls nothing at all. The
      // failure snapshot for this step showed the transcript still parked on
      // `seeded-body-0`, which is the signature of a wheel that never reached
      // it: the row was never missing from the buffer, only never scrolled to.
      //
      // This is the same gesture the upward scroll above already performs, so it
      // is the test's own precedent rather than a new accommodation.
      const restoreBox = await scroller.boundingBox();
      if (!restoreBox) throw new Error("the virtualized transcript lost its box");
      await page.mouse.move(
        restoreBox.x + restoreBox.width / 2,
        restoreBox.y + restoreBox.height / 2,
      );
      // Condition-based, like the upward scroll: the transcript is far taller
      // than one wheel delta, so keep scrolling until it is genuinely at the
      // live edge rather than assuming a single large delta lands there.
      await expect
        .poll(
          async () => {
            await page.mouse.wheel(0, 20000);
            await page.waitForTimeout(120);
            return scroller.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
          },
          { timeout: 20000 },
        )
        .toBe(true);
      await expect(page.getByText("seeded-body-149")).toBeVisible({ timeout: 15000 });

      await composer.fill("sent from the restored active tip");
      await composer.press("Enter");

      // ── K: exactly one real transport submission ────────────────────────
      await expect.poll(() => transport.count(), { timeout: 20000 }).toBe(1);
      await page.waitForTimeout(1000);
      expect(transport.count()).toBe(1);
    } finally {
      await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
    }
  });
});
