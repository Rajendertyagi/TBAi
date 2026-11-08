/**
 * P2: a FAILED Direct history load must recover on SPA re-entry, and ordinary
 * navigation must never reload history.
 *
 * ## Why this file exists
 *
 * `useExternalHistory` loads once per mount and latches `loadedRef` forever
 * (never re-armed). A same-hash navigation does not remount, so the failed load
 * was never retried: the only recovery was a full page reload. Measured before
 * the fix — retrying via `page.goto()` to the SAME hash url issued ZERO
 * `/messages/window` requests, while `page.reload()` issued exactly 1.
 *
 * Recovery is now driven by the failure signal: the adapter marks a failed load,
 * and leaving that conversation changes the `runtimeHook` identity, which bumps
 * assistant-ui's `hookEpoch` and re-keys the thread resources so the history load
 * runs again.
 *
 * ## What makes this hard to assert honestly
 *
 * The guard in the adapter is `if (controller.rows().length === 0)`. A HEALTHY
 * conversation and a FAILED conversation BOTH have zero rows, so the row count
 * alone cannot tell them apart — that is exactly why the failure flag exists.
 * These tests therefore assert REQUEST COUNTS, not just rendered output: a
 * recovery that re-fetched needlessly would look identical on screen.
 *
 * ## Why counts are polled, and why zeros need a settle
 *
 * The composer (`textarea`) is visible long before history is requested, so
 * asserting a count straight after it appears reads 0 and is a race — measured,
 * not assumed. Positive counts are therefore awaited with `expect.poll`, which
 * also fails on OVERSHOOT, so "exactly one" stays exactly one.
 *
 * A zero count is the negative case: absence can only be proven by waiting
 * through the window in which a request would have appeared. `SETTLE_MS` is that
 * window, not a tolerance.
 *
 * ## Counting
 *
 * "SPA re-entry" means a hash-route change with NO document reload: open A,
 * navigate to B, navigate back to A. `page.reload()` and `page.goto()` to the
 * current url are deliberately NOT used — both would prove a remount that
 * recovery does not depend on.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/** The Direct history page API. Recovery must move exactly this. */
const WINDOW_ROUTE = "**/messages/window*";

/**
 * How long to wait through when asserting that NO request happened. Long enough
 * to cover the load that a healthy or failed thread would otherwise perform.
 */
const SETTLE_MS = 2_500;

async function createConversation(request: APIRequestContext, title: string): Promise<string> {
  const created = await request.post("/api/conversations", {
    data: { title, workspaceMode: "simple", engine: "direct" },
  });
  return ((await created.json()) as { id: string }).id;
}

/**
 * Seed a linear parent chain.
 *
 * `messages.id` is globally UNIQUE, so `tag` must be unique per test: two
 * workers sharing seed ids silently hijack each other's rows.
 */
async function seedChain(
  request: APIRequestContext,
  conversationId: string,
  count: number,
  tag: string,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await request.post(`/api/conversations/${conversationId}/messages`, {
      data: {
        message: {
          id: `${tag}-${i}`,
          parent_id: i === 0 ? null : `${tag}-${i - 1}`,
          format: "ai-sdk/v6",
          content: {
            role: i % 2 === 0 ? "user" : "assistant",
            parts: [{ type: "text", text: `rec-${tag}-${i} ${"row filler. ".repeat(6)}` }],
          },
        },
      },
    });
  }
}

/**
 * Records every Direct history page request. Registered before any navigation so
 * the FIRST load is captured too.
 */
function trackWindowRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/messages/window")) seen.push(r.url());
  });
  return seen;
}

/** Await the composer, which proves the thread shell mounted. */
async function expectShell(page: Page): Promise<void> {
  await expect(page.locator("textarea").first()).toBeVisible({ timeout: 30_000 });
}

/** Await a conversation's tip row, which proves its history actually loaded. */
async function expectTipLoaded(page: Page, text: string): Promise<void> {
  await expect(page.getByText(text)).toBeVisible({ timeout: 30_000 });
}

test.describe("P2: failed history load recovers on SPA re-entry", () => {
  test.setTimeout(600_000);

  test("K-I1: a failed load gets ONE bounded attempt per visit, and a new visit gets a fresh one", async ({
    page,
    request,
  }) => {
    const tag = `i1-${Date.now()}`;
    const failed = await createConversation(request, `rec ${tag} A`);
    const other = await createConversation(request, `rec ${tag} B`);
    await seedChain(request, failed, 12, `${tag}-a`);
    await seedChain(request, other, 12, `${tag}-b`);
    const requests = trackWindowRequests(page);

    try {
      // --- visit 1: the history route is broken, so the load fails ------------
      await page.route(WINDOW_ROUTE, (route) => route.abort("failed"));
      await page.goto(`/#/chat/${failed}`);
      await expectShell(page);

      // ONE initial attempt plus AT MOST ONE automatic recovery, and no more.
      // `DirectViewportBridge` performs the recovery in an effect after the
      // adapter records the failure, and latches on `recoveryAttempted`, so a
      // persistently broken route must not turn this into a retry loop.
      await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(2);
      await page.waitForTimeout(SETTLE_MS);
      expect(requests.length, "recovery must stay bounded while the route stays broken").toBe(2);

      await page.unroute(WINDOW_ROUTE);

      // --- the thread is still MOUNTED after a switch, so re-entry does not
      // --- re-run its history load on its own. That is the installed runtime's
      // --- contract (`startedIds` is additive: switching never detaches a
      // --- thread), which is exactly why an exhausted budget must be re-armed
      // --- by the arrival itself rather than by a silent re-fetch.
      await page.goto(`/#/chat/${other}`);
      await expectTipLoaded(page, `rec-${tag}-b-11`);

      requests.length = 0;
      await page.goto(`/#/chat/${failed}`);

      // Arriving again is a NEW USER INTENT, so it earns a fresh — still
      // bounded — attempt. The backend is healthy now, so that attempt must
      // SUCCEED and the history must actually render.
      //
      // This assertion is the regression guard for the re-arm. Disabling the
      // new-visit branch makes the tip below time out with the conversation
      // rendering empty: the spent budget is inherited from the previous visit,
      // and the arriving user gets nothing for it.
      await expectTipLoaded(page, `rec-${tag}-a-11`);
      expect(
        requests.length,
        "a new visit must recover, and must not retry beyond its own budget",
      ).toBe(1);
    } finally {
      await page.unroute(WINDOW_ROUTE).catch(() => undefined);
      await request.delete(`/api/conversations/${failed}`).catch(() => undefined);
      await request.delete(`/api/conversations/${other}`).catch(() => undefined);
    }
  });

  test("K-I1b: a TRANSIENT failure recovers and the history actually renders", async ({
    page,
    request,
  }) => {
    const tag = `i1b-${Date.now()}`;
    const target = await createConversation(request, `rec ${tag} A`);
    await seedChain(request, target, 12, `${tag}-a`);
    const requests = trackWindowRequests(page);

    try {
      // Fail ONLY the first window request. The automatic recovery then runs
      // against a healthy route, which is the case that actually matters: a
      // reader whose history failed must get their history back without a
      // reload.
      let blocked = true;
      await page.route(WINDOW_ROUTE, async (route) => {
        if (blocked) {
          blocked = false;
          await route.abort("failed");
          return;
        }
        await route.continue();
      });

      await page.goto(`/#/chat/${target}`);
      await expectShell(page);

      // The proof of recovery: the seeded tip row renders.
      await expectTipLoaded(page, `rec-${tag}-a-11`);
      await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(2);
      expect(requests.length, "recovery must stop once the retry has succeeded").toBe(2);
    } finally {
      await page.unroute(WINDOW_ROUTE).catch(() => undefined);
      await request.delete(`/api/conversations/${target}`).catch(() => undefined);
    }
  });

  test("K-I2: a HEALTHY thread re-entry issues ZERO requests", async ({ page, request }) => {
    const tag = `i2-${Date.now()}`;
    const target = await createConversation(request, `rec ${tag} A`);
    const other = await createConversation(request, `rec ${tag} B`);
    await seedChain(request, target, 12, `${tag}-a`);
    await seedChain(request, other, 12, `${tag}-b`);
    const requests = trackWindowRequests(page);

    try {
      await page.goto(`/#/chat/${target}`);
      await expectTipLoaded(page, `rec-${tag}-a-11`);
      await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(1);

      // Ordinary navigation: no failure was recorded, so nothing may reload.
      await page.goto(`/#/chat/${other}`);
      await expectTipLoaded(page, `rec-${tag}-b-11`);

      requests.length = 0;
      await page.goto(`/#/chat/${target}`);
      await expectTipLoaded(page, `rec-${tag}-a-11`);
      await page.waitForTimeout(SETTLE_MS);

      expect(
        requests.length,
        "a healthy thread must NOT re-fetch history on ordinary navigation",
      ).toBe(0);
    } finally {
      await request.delete(`/api/conversations/${target}`).catch(() => undefined);
      await request.delete(`/api/conversations/${other}`).catch(() => undefined);
    }
  });

  test("K-I3: an EMPTY conversation is never treated as a failed load", async ({
    page,
    request,
  }) => {
    const tag = `i3-${Date.now()}`;
    const empty = await createConversation(request, `rec ${tag} empty`);
    const other = await createConversation(request, `rec ${tag} B`);
    await seedChain(request, other, 12, `${tag}-b`);
    const requests = trackWindowRequests(page);

    try {
      // An empty conversation is a SUCCESSFUL zero-row answer, not a failure.
      await page.goto(`/#/chat/${empty}`);
      await expectShell(page);
      await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(1);
      await expect.poll(() => page.locator("[data-row-key]").count(), { timeout: 30_000 }).toBe(0);

      // The visible failure state must agree: a conversation that genuinely holds
      // nothing must NOT be told its history could not be loaded. Counting
      // requests alone would not catch a row rendered on some path that happens
      // not to retry.
      await expect(page.getByTestId("history-load-failed")).toHaveCount(0);

      await page.goto(`/#/chat/${other}`);
      await expectTipLoaded(page, `rec-${tag}-b-11`);

      requests.length = 0;
      await page.goto(`/#/chat/${empty}`);
      await expectShell(page);
      await page.waitForTimeout(SETTLE_MS);

      expect(
        requests.length,
        "an empty conversation must never be retried as if it had failed",
      ).toBe(0);
    } finally {
      await request.delete(`/api/conversations/${empty}`).catch(() => undefined);
      await request.delete(`/api/conversations/${other}`).catch(() => undefined);
    }
  });

  test("K-I4: recovery is bounded per visit, re-arms on a new one, and goes silent once healthy", async ({
    page,
    request,
  }) => {
    const tag = `i4-${Date.now()}`;
    const target = await createConversation(request, `rec ${tag} A`);
    const other = await createConversation(request, `rec ${tag} B`);
    await seedChain(request, target, 12, `${tag}-a`);
    await seedChain(request, other, 12, `${tag}-b`);
    const requests = trackWindowRequests(page);

    try {
      // The whole lifecycle, and the safety property that matters most is that
      // it never becomes a retry loop:
      //
      //   1. broken route      one initial attempt + AT MOST one automatic
      //                        recovery, and the count must then stay put no
      //                        matter how long the route stays broken
      //   2. healthy re-visit  the arrival re-arms the exhausted budget, runs
      //                        that one attempt against a healthy backend, and
      //                        the history actually renders
      //   3. further re-visits the history is already in the runtime, so a
      //                        REPEAT visit must issue NOTHING — a spent budget
      //                        must not turn every navigation into a fetch, and
      //                        recovery must not fire once there is no failure
      //
      // Each count is measured after resetting the counter, so any growth across
      // the phases shows up as a per-phase count above these numbers rather than
      // hiding inside a running total.
      await page.route(WINDOW_ROUTE, (route) => route.abort("failed"));
      requests.length = 0;
      await page.goto(`/#/chat/${target}`);
      await expectShell(page);

      // --- 1. bounded while the route stays broken ---------------------------
      await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(2);
      await page.waitForTimeout(SETTLE_MS);
      expect(requests.length, "a route that stays broken must not become a retry loop").toBe(2);

      await page.unroute(WINDOW_ROUTE);

      // --- 2. a new visit re-arms the budget and recovers --------------------
      await page.goto(`/#/chat/${other}`);
      await expectTipLoaded(page, `rec-${tag}-b-11`);
      requests.length = 0;
      await page.goto(`/#/chat/${target}`);
      await expectTipLoaded(page, `rec-${tag}-a-11`);
      await page.waitForTimeout(SETTLE_MS);
      expect(requests.length, "a new visit must re-arm the budget, and stop once it succeeds").toBe(
        1,
      );

      // --- 3. once healthy, further visits must be silent --------------------
      for (const revisit of [1, 2]) {
        requests.length = 0;
        await page.goto(`/#/chat/${other}`);
        await expectTipLoaded(page, `rec-${tag}-b-11`);
        await page.goto(`/#/chat/${target}`);
        await expectTipLoaded(page, `rec-${tag}-a-11`);
        await page.waitForTimeout(SETTLE_MS);
        expect(
          requests.length,
          `revisit ${revisit}: a healthy thread must not re-fetch, and recovery must not fire without a failure`,
        ).toBe(0);
      }
    } finally {
      await page.unroute(WINDOW_ROUTE).catch(() => undefined);
      await request.delete(`/api/conversations/${target}`).catch(() => undefined);
      await request.delete(`/api/conversations/${other}`).catch(() => undefined);
    }
  });

  test("K-I5: leaving DURING an in-flight load is recorded, and the next visit recovers it", async ({
    page,
    request,
  }) => {
    const tag = `i5-${Date.now()}`;
    const target = await createConversation(request, `rec ${tag} A`);
    const other = await createConversation(request, `rec ${tag} B`);
    await seedChain(request, target, 12, `${tag}-a`);
    await seedChain(request, other, 12, `${tag}-b`);
    const requests = trackWindowRequests(page);

    try {
      // Hold A's history request open so the load is provably still in flight
      // when the user navigates away, then fail it. The abort has to happen
      // while the handler is STILL installed: unrouting first would let the
      // held request fall through to a healthy backend, so the load would
      // succeed and there would be no failure to recover from at all.
      await page.route(WINDOW_ROUTE, async (route) => {
        await new Promise((r) => setTimeout(r, 2500));
        await route.abort("failed").catch(() => undefined);
      });

      await page.goto(`/#/chat/${target}`);
      await expectShell(page);
      await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(1);

      // Leave while the delayed request is still outstanding, and wait past the
      // hold so the in-flight load is recorded as FAILED while we are away.
      await page.goto(`/#/chat/${other}`);
      await page.waitForTimeout(SETTLE_MS);
      await page.unroute(WINDOW_ROUTE);

      // Switching threads never detaches a STARTED thread (`startedIds` is
      // additive), so re-entering A returns to the SAME mounted runtime whose
      // load already ran and failed. Nothing re-runs it on its own — which is
      // why the budget has to be re-armed by the arrival. That re-armed attempt
      // runs exactly once, against the now-healthy route, and the history the
      // user came back for is what finally renders.
      requests.length = 0;
      await page.goto(`/#/chat/${target}`);
      await expectTipLoaded(page, `rec-${tag}-a-11`);
      await page.waitForTimeout(SETTLE_MS);
      expect(
        requests.length,
        "the re-armed attempt must run once — not a duplicate, not a loop",
      ).toBe(1);
    } finally {
      await page.unroute(WINDOW_ROUTE).catch(() => undefined);
      await request.delete(`/api/conversations/${target}`).catch(() => undefined);
      await request.delete(`/api/conversations/${other}`).catch(() => undefined);
    }
  });

  test("K-I6: a failed load is VISIBLE, and Retry recovers it without a reload", async ({
    page,
    request,
  }) => {
    // The blank-transcript defect: a failed load left nothing on screen, so the
    // user could not tell a missing history from an empty conversation. This
    // pins the visible failure state and the explicit recovery action.
    const tag = `i6-${Date.now()}`;
    const target = await createConversation(request, `rec ${tag} A`);
    await seedChain(request, target, 12, `${tag}-a`);
    const requests = trackWindowRequests(page);
    const failureRow = page.getByTestId("history-load-failed");

    try {
      // --- break the load -----------------------------------------------------
      await page.route(WINDOW_ROUTE, (route) => route.abort("failed"));
      await page.goto(`/#/chat/${target}`);

      // The failure must be VISIBLE, not inferred from an empty transcript.
      await expect(failureRow, "a failed history load must say so").toBeVisible({
        timeout: 60_000,
      });

      // And the bounded automatic contract is unchanged: one initial attempt plus
      // at most one automatic recovery, then silence.
      await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(2);
      await page.waitForTimeout(SETTLE_MS);
      expect(requests.length, "automatic recovery must stay bounded at two").toBe(2);

      // --- heal the fault, then retry explicitly ------------------------------
      await page.unroute(WINDOW_ROUTE);
      requests.length = 0;

      await page.getByTestId("history-retry").click();

      // A GENUINE new history request, not a cached repaint: the whole point is
      // recovery without a document reload.
      await expectTipLoaded(page, `rec-${tag}-a-11`);
      expect(requests.length, "Retry must issue exactly one fresh window request").toBe(1);

      // And the failure state clears, so the row must not linger over a
      // recovered conversation.
      await expect(failureRow).toHaveCount(0);
    } finally {
      await page.unroute(WINDOW_ROUTE).catch(() => undefined);
      await request.delete(`/api/conversations/${target}`).catch(() => undefined);
    }
  });

  test("K-I7: repeated Retry clicks cannot start overlapping loads", async ({ page, request }) => {
    // Overlapping loads are not merely wasteful. `useExternalHistory` loads with
    // no abort signal, and a completed load calls `thread.import(...)`, so the
    // last one to finish overwrites the others' messages. The single-flight
    // latch is what keeps exactly one load alive.
    const tag = `i7-${Date.now()}`;
    const target = await createConversation(request, `rec ${tag} A`);
    await seedChain(request, target, 12, `${tag}-a`);
    const requests = trackWindowRequests(page);

    try {
      // The fault is DELIBERATELY LEFT IN PLACE for the whole test.
      //
      // An earlier version healed the backend before clicking, which made the
      // test measure something no user can do: the row unmounts the moment a
      // retry succeeds, so a real second click has nothing to land on. Forced
      // clicks on a vanishing control then restarted the runtime a second time
      // and destroyed the history the first retry had just loaded — a test
      // artefact, not a product defect.
      //
      // Keeping the fault means every attempt fails, the row STAYS put and
      // enabled, and all three clicks are ones a user could genuinely make.
      //
      // The abort is DELAYED on purpose. The property under test is OVERLAPPING
      // loads, and an instant abort cannot produce them: each load settles before
      // the next click lands, so the single-flight latch is correctly released in
      // between and each click becomes its own sequential retry. A load still in
      // flight when the second and third clicks arrive is what actually exercises
      // the guards — and a real network is never instantaneous.
      //
      // WHAT THIS PINS, precisely: the user-visible invariant that repeated Retry
      // clicks produce ONE history load. It deliberately does NOT claim to pin
      // either guard individually — measured, not assumed: with the latch removed
      // this test still passes (the `thread.isLoading` gate covers these clicks),
      // and with that gate removed it still passes (the latch covers them). The
      // two cover different windows and are redundant for this scenario, and the
      // same-tick window the latch exists for cannot be produced through
      // Playwright's sequential clicks at all. Each guard is pinned on its own by
      // the DOM cases in direct-history-load-failed-identity.test.ts.
      await page.route(WINDOW_ROUTE, async (route) => {
        await new Promise((r) => setTimeout(r, 2000));
        await route.abort("failed").catch(() => undefined);
      });
      await page.goto(`/#/chat/${target}`);
      await expect(page.getByTestId("history-load-failed")).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => requests.length, { timeout: 60_000 }).toBe(2);

      // Let the automatic recovery settle, so the clicks below race only EACH
      // OTHER and not the recovery that is already finishing.
      const retry = page.getByTestId("history-retry");
      await expect(retry, "Retry must be offered once the failure has settled").toBeEnabled({
        timeout: 30_000,
      });
      requests.length = 0;

      // Three clicks in quick succession. Each observes the thread as idle, so
      // only the synchronous latch can stop the second and third.
      await retry.click();
      await retry.click({ force: true }).catch(() => undefined);
      await retry.click({ force: true }).catch(() => undefined);

      // Exactly ONE reload may have started, and it fails like the others, so the
      // row is still there afterwards.
      await expect
        .poll(() => requests.length, { timeout: 30_000, message: "no retry request was issued" })
        .toBeGreaterThan(0);
      await page.waitForTimeout(SETTLE_MS);
      expect(
        requests.length,
        "repeated Retry clicks must not start overlapping history loads",
      ).toBe(1);
      await expect(page.getByTestId("history-load-failed")).toBeVisible();
    } finally {
      await page.unroute(WINDOW_ROUTE).catch(() => undefined);
      await request.delete(`/api/conversations/${target}`).catch(() => undefined);
    }
  });

  test("K-I8: after a successful load, an outage re-issues NO request and keeps the messages", async ({
    page,
    request,
  }) => {
    // Retained-history behaviour, on the case that is actually reachable.
    //
    // The adapter short-circuits the fetch when the controller already holds
    // rows, so once a conversation has loaded, a later outage is never even
    // observed: no request, no failure recorded, messages intact. That is worth
    // pinning, because it is the reason a "failed load with retained messages"
    // state does not exist and must not be simulated.
    //
    // NOTE what this does NOT claim: nothing here proves an outage was DETECTED.
    // It proves the outage was never seen, which is the correct behaviour.
    const tag = `i8-${Date.now()}`;
    const target = await createConversation(request, `rec ${tag} A`);
    await seedChain(request, target, 12, `${tag}-a`);
    const requests = trackWindowRequests(page);

    try {
      await page.goto(`/#/chat/${target}`);
      await expectTipLoaded(page, `rec-${tag}-a-11`);
      await page.waitForTimeout(SETTLE_MS);
      expect(requests.length, "the initial load must reach the backend").toBe(1);

      // Now take the backend away and re-enter the conversation.
      await page.route(WINDOW_ROUTE, (route) => route.abort("failed"));
      requests.length = 0;
      await page.goto(`/#/chat/${target}`);

      // The window is already held, so no fetch is attempted and nothing fails.
      await page.waitForTimeout(SETTLE_MS);
      expect(requests.length, "a held window must not re-fetch during an outage").toBe(0);
      await expect(page.getByTestId("history-load-failed")).toHaveCount(0);

      // And the user's messages are still there throughout.
      //
      // The transcript is VIRTUALIZED: only rows inside the mounted window are
      // in the DOM. The oldest message is therefore asserted by scrolling to
      // it, which is what proves the runtime still holds it - "the whole
      // conversation is rendered at once" is not the claim and is not true.
      // This assertion previously passed only because the seeded conversation
      // happened to fit one 1280x720 window; the assertion, not the transcript,
      // is what that depended on (it fails at the base commit too, with a
      // 480px-tall viewport).
      await expectTipLoaded(page, `rec-${tag}-a-11`);

      // Scrolling up is a real user gesture, and the height comes from measured
      // rows, so one wheel delta only lands partway up.
      const scroller = page.locator('[data-testid="virtual-transcript-scroller"]');
      const box = await scroller.boundingBox();
      if (!box) throw new Error("the virtualized transcript has no box");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await expect
        .poll(
          async () => {
            await page.mouse.wheel(0, -20_000);
            await page.waitForTimeout(120);
            return scroller.evaluate((el) => el.scrollTop);
          },
          { timeout: 20_000 },
        )
        .toBe(0);
      await expectTipLoaded(page, `rec-${tag}-a-0`);
    } finally {
      await page.unroute(WINDOW_ROUTE).catch(() => undefined);
      await request.delete(`/api/conversations/${target}`).catch(() => undefined);
    }
  });
});
