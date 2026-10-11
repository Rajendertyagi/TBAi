/**
 * P2d - PRODUCTION REACHABILITY of the stale-publication sequence.
 *
 * §15.1 of `docs/2026-10-10-history-lifecycle-plan.md` reproduces the unguarded
 * publish with an INJECTED controller. That does not prove a browser reaches the
 * ordering. This file forces the ordering through the real lifecycle and then
 * looks for an OBSERVABLE failure:
 *
 *   1. the thread's window load is issued and held in flight
 *   2. availability goes unknown -> degraded -> online, which fires the recovery
 *      listener (`availabilityStore.ts:162` -> `recovery.ts:44`) and drops every
 *      window controller
 *   3. the held window response is released and the ORIGINAL load completes
 *   4. `publishWindowUi` runs from the controller that step 2 dropped
 *
 * ## What counts as an observable failure here
 *
 * `DirectViewportBridge.tsx:206` renders "Load earlier" purely from `hasEarlier`,
 * which the stale publish supplies. But `onLoadEarlier` (:134) returns immediately
 * when `controller` is null, and the controller IS null after the drop. So the
 * observable is a paging control that is VISIBLE and SILENTLY DOES NOTHING - the
 * exact failure recorded as defect S in the plan's summary table.
 *
 * A no-op is only evidence if a working control does issue a request, so the
 * second test pins that comparison. Neither test asserts the race happens in
 * production on its own: it asserts what happens IF the ordering occurs, measured
 * through the real adapter, the real store, and the real component.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const WINDOW_ROUTE = "**/messages/window*";
const READYZ_ROUTE = "**/readyz*";
/** Absence can only be proven by waiting through the window a request would appear in. */
const SETTLE_MS = 2_500;

async function createConversation(request: APIRequestContext, title: string): Promise<string> {
  const created = await request.post("/api/conversations", {
    data: { title, workspaceMode: "simple", engine: "direct" },
  });
  if (!created.ok()) throw new Error(`seed conversation failed: ${created.status()}`);
  return ((await created.json()) as { id: string }).id;
}

/**
 * Seed a linear chain long enough that the initial bounded window (limit 100)
 * genuinely has history before it, so `hasMoreBefore` is true.
 */
async function seedChain(
  request: APIRequestContext,
  conversationId: string,
  count: number,
  tag: string,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const res = await request.post(`/api/conversations/${conversationId}/messages`, {
      data: {
        message: {
          id: `${tag}-${i}`,
          parent_id: i === 0 ? null : `${tag}-${i - 1}`,
          format: "ai-sdk/v6",
          content: {
            role: i % 2 === 0 ? "user" : "assistant",
            parts: [{ type: "text", text: `reach-${tag}-${i} ${"row filler. ".repeat(6)}` }],
          },
        },
      },
    });
    if (!res.ok()) throw new Error(`seed message ${i} failed: ${res.status()}`);
  }
}

/** Count every Direct history page request, registered before any navigation. */
function trackWindowRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/messages/window")) seen.push(r.url());
  });
  return seen;
}

const loadEarlier = (page: Page) => page.getByRole("button", { name: /Load earlier/i });

test.describe("P2d: stale publication reaches production", () => {
  test("control - an uninvalidated load paginates and issues a request", async ({ page, request }) => {
    test.setTimeout(180_000);
    const tag = `ctl-${Date.now()}`;
    const cid = await createConversation(request, `reach-control-${tag}`);
    await seedChain(request, cid, 150, tag);

    const requests = trackWindowRequests(page);
    await page.goto(`/#/chat/${cid}`);
    await loadEarlier(page).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1_500);

    const before = requests.length;
    await loadEarlier(page).click();
    await expect
      .poll(() => requests.length, { timeout: SETTLE_MS })
      .toBeGreaterThan(before);
  });

  test("recovery during an in-flight load leaves paging intact and working", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    const tag = `rcv-${Date.now()}`;
    const cid = await createConversation(request, `reach-recovery-${tag}`);
    await seedChain(request, cid, 150, tag);

    let releaseWindow: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseWindow = resolve;
    });
    let held = 0;
    await page.route(WINDOW_ROUTE, async (route) => {
      held += 1;
      await gate;
      await route.continue();
    });

    // First probe reports "reachable but not ready" (degraded); later probes pass
    // through, so the transition degraded -> online fires the recovery listener.
    let readyzHits = 0;
    await page.route(READYZ_ROUTE, async (route) => {
      readyzHits += 1;
      if (readyzHits === 1) {
        await route.fulfill({ status: 503, contentType: "text/plain", body: "not ready" });
        return;
      }
      await route.continue();
    });

    const requests = trackWindowRequests(page);
    await page.goto(`/#/chat/${cid}`);
    await page.locator("textarea").first().waitFor({ timeout: 30_000 });

    // (1) the load is issued and held in flight.
    await expect.poll(() => held, { timeout: 30_000 }).toBeGreaterThan(0);

    // (2) availability leaves a non-online state and comes back, firing recovery.
    await expect.poll(() => readyzHits, { timeout: 60_000 }).toBeGreaterThan(1);
    await page.waitForTimeout(2_000);

    // (3) release the ORIGINAL load so it completes against the dropped controller.
    releaseWindow!();
    await page.waitForTimeout(3_000);

    // (4) The conversation must still be pageable. The old failure was a VISIBLE
    // control that issued nothing. The naive opposite fix - refusing the publish
    // outright - would hide the control and leave the transcript permanently
    // unpageable, which is the same user harm in a different shape. So the
    // assertion is that the control exists AND works.
    const control = loadEarlier(page);
    await control.waitFor({ timeout: 15_000 });

    const before = requests.length;
    await control.click();
    await expect.poll(() => requests.length, { timeout: SETTLE_MS }).toBeGreaterThan(before);

    console.log(
      `  [reach] readyzHits=${readyzHits} held=${held} controlVisible=true controlIssuesRequest=true`,
    );
  });
});

/**
 * Defect L through the real lifecycle.
 *
 * The first window request is held past the configured deadline, so the client
 * abandons it. The load must SETTLE as a failure - that is what arms the Retry
 * control, which was previously unreachable because nothing ever settled.
 */
test("a window request past its deadline fails visibly and Retry then recovers", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const tag = `to-${Date.now()}`;
  const cid = await createConversation(request, `timeout-${tag}`);
  await seedChain(request, cid, 20, tag);

  let releaseFirst: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  // EVERY window request is held, not just the first. Automatic recovery (K-I1)
  // retries on entering the conversation; if only the first were held that retry
  // would succeed and clear the failure before it could be observed. The point
  // here is the user-facing Retry control, so it has to be reachable.
  let released = false;
  await page.route(WINDOW_ROUTE, async (route) => {
    if (!released) {
      await gate;
      // The client has already aborted; continuing can legitimately fail.
      await route.continue().catch(() => undefined);
      return;
    }
    await route.continue();
  });

  await page.goto(`/#/chat/${cid}`);
  await page.locator("textarea").first().waitFor({ timeout: 30_000 });

  // The failure UI appears only because the request settled at its deadline. Retry
  // is `disabled` while `thread.isLoading` is true (DirectViewportBridge.tsx:253),
  // and automatic recovery (K-I1) starts its own attempt after the first failure -
  // which is held too, so it must settle at its own deadline before Retry is usable.
  const retry = page.getByTestId("history-retry");
  await retry.waitFor({ timeout: 60_000 });
  await expect(retry).toBeEnabled({ timeout: 90_000 });
  console.log("  [timeout] load settled and Retry is visible and enabled");

  // Let every held request go so nothing is left dangling.
  released = true;
  releaseFirst!();
  await page.waitForTimeout(500);

  const requests = trackWindowRequests(page);
  const before = requests.length;
  await retry.click();
  await expect.poll(() => requests.length, { timeout: SETTLE_MS }).toBeGreaterThan(before);

  // The conversation's history actually arrives, and the failure state clears.
  // The LAST seeded message is used because the transcript is scrolled to the live
  // end and the virtualizer never mounts rows above the viewport - asserting on
  // message 0 would wait forever for something that is correctly not rendered.
  await page.getByText(`reach-${tag}-19`, { exact: false }).first().waitFor({ timeout: 30_000 });
  await expect(page.getByTestId("history-load-failed")).toHaveCount(0, { timeout: 30_000 });
  console.log("  [timeout] retry issued a window request and history rendered");
});