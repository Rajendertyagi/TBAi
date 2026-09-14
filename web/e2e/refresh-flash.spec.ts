import { expect, test } from "@playwright/test";

/**
 * Refresh-flash regression: reloading a started (bound) thread must never
 * mount the welcome screen — not even transiently while history loads —
 * and exactly one composer must exist at every instant.
 */
test("refresh of a started thread never flashes welcome", async ({ page }) => {
  await page.goto("/#/chat/new");
  await expect(
    page.getByRole("heading", { name: /what do you want to build/i }),
  ).toBeVisible({ timeout: 15000 });

  const list = await page.request.get("/api/conversations?status=all&limit=5");
  expect(list.ok()).toBe(true);
  const data = (await list.json()) as { threads: Array<{ id: string }> };
  test.skip(data.threads.length === 0, "no existing thread in this database");
  const threadId = data.threads[0].id;

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
  await page.screenshot({ path: "e2e/refresh-thread.png" });
});

