import { expect, test } from "@playwright/test";
import {
  removeConversation,
  seedConversation,
} from "./helpers/seedConversation";

/**
 * Refresh-flash regression: reloading a started (bound) thread must never
 * mount the welcome screen — not even transiently while history loads —
 * and exactly one composer must exist at every instant.
 */
test("refresh of a started thread never flashes welcome", async ({ page }, testInfo) => {
  // The DOM sampler below has its own 30s fallback, and Playwright's default test
  // budget is also 30s, so that fallback could never fire before the test died.
  // This spec was never actually running - it skipped on an empty database - so
  // the mismatch was never observed. Budget must exceed the sampler's window.
  test.setTimeout(90_000);
  await page.goto("/#/chat/new");
  await expect(
    page.getByRole("heading", { name: /what do you want to build/i }),
  ).toBeVisible({ timeout: 15000 });

  // Seeded rather than borrowed. This used to read the conversation list and
  // skip when it was empty, which only ever worked because an earlier spec had
  // left a conversation behind. Under per-spec isolation the list is always
  // empty, so the spec skipped on every run while still reporting green.
  //
  // The turn is long enough that the thread paints real content: the sampler
  // keeps polling until document.body.innerText passes 500 chars, and a one-word
  // seed would never satisfy that, so it would always burn the full window.
  const { id: threadId } = await seedConversation(page.request, {
    withMessage: true,
    messageText:
      "This is an earlier turn in the conversation, seeded so the thread has " +
      "real content to paint. It is deliberately long enough that the rendered " +
      "body clears the sampler threshold in the reload check below, which polls " +
      "the DOM until the page has actually painted a conversation rather than " +
      "an empty shell.",
  });

  try {
    await page.goto(`/#/chat/${threadId}`);
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toHaveCount(1, { timeout: 15000 });
    await expect(
      page.getByRole("heading", { name: /what do you want to build/i }),
    ).toHaveCount(0);

    // Full reload, sampling the DOM from the earliest possible instant.
    await page.reload();
    const seen = await page.evaluate(
      () =>
        new Promise<{ welcome: boolean; counts: number[] }>((resolve) => {
          let welcome = false;
          const counts: number[] = [];
          const iv = setInterval(() => {
            if (
              [...document.querySelectorAll("h1")].some((e) =>
                /what do you want to build/i.test(e.textContent || ""),
              )
            ) {
              welcome = true;
            }
            counts.push(
              document.querySelectorAll('textarea:not([aria-hidden="true"])').length,
            );
            if (document.body.innerText.length > 500) {
              setTimeout(() => {
                clearInterval(iv);
                counts.push(
                  document.querySelectorAll('textarea:not([aria-hidden="true"])')
                    .length,
                );
                resolve({ welcome, counts });
              }, 800);
            }
          }, 100);
          setTimeout(() => {
            clearInterval(iv);
            resolve({ welcome, counts });
          }, 30000);
        }),
    );
    expect(seen.welcome, "welcome heading mounted on bound thread").toBe(false);
    expect(
      seen.counts.every((c) => c === 1),
      `textarea counts observed: ${seen.counts.join(",")}`,
    ).toBe(true);
    // Debug capture into Playwright's gitignored artifact dir rather than beside
    // the spec. This file was tracked at web/e2e/refresh-thread.png, and because
    // an entry in .gitignore cannot suppress an already-tracked path, any pixel
    // difference between runs dirtied the working tree.
    await page.screenshot({ path: testInfo.outputPath("refresh-thread.png") });
  } finally {
    await removeConversation(page.request, threadId);
  }
});
