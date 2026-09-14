import { expect, test } from "@playwright/test";

/**
 * Boot-state regression: with history deliberately throttled, a persisted
 * thread must render the boot skeleton (never Welcome) with exactly one
 * composer; after history resolves, messages appear, boot disappears,
 * composer stays exactly one.
 */
test("persisted thread shows boot skeleton while history loads", async ({
  page,
}) => {
  await page.goto("/#/chat/new");
  await expect(
    page.getByRole("heading", { name: /what do you want to build/i }),
  ).toBeVisible({ timeout: 15000 });

  const list = await page.request.get("/api/conversations?status=all&limit=5");
  expect(list.ok()).toBe(true);
  const data = (await list.json()) as { threads: Array<{ id: string }> };
  test.skip(data.threads.length === 0, "no existing thread in this database");
  const threadId = data.threads[0].id;

  // Hold the history request so the loading window is observable.
  let releaseHistory!: () => void;
  const historyHeld = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  await page.route("**/messages", async (route) => {
    await historyHeld;
    await route.continue();
  });

  await page.goto(`/#/chat/${threadId}`);

  // During the delay: no welcome, one composer, boot visible.
  await expect(page.getByTestId("thread-boot")).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.getByRole("heading", { name: /what do you want to build/i }),
  ).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /Send a message/ })).toHaveCount(1);

  releaseHistory();

  // After history resolves: messages appear, boot disappears, composer once.
  await expect(page.getByTestId("thread-boot")).toHaveCount(0, {
    timeout: 15000,
  });
  await expect(page.getByRole("textbox", { name: /Send a message/ })).toHaveCount(1);
  const body = await page.locator("main").innerText();
  expect(body.length).toBeGreaterThan(0);
  await page.screenshot({ path: "e2e/boot-resolved.png" });
});

