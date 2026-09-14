import { expect, test } from "@playwright/test";

test("new-chat screen has exactly one composer", async ({ page }) => {
  await page.goto("/#/chat/new");
  await expect(
    page.getByRole("heading", { name: /what do you want to build/i }),
  ).toBeVisible({ timeout: 15000 });

  const boxes = page.getByRole("textbox", { name: /Send a message/ });
  await expect(boxes).toHaveCount(1);

  const detail = await page.evaluate(() =>
    [...document.querySelectorAll('textarea:not([aria-hidden="true"])')].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        placeholder: el.getAttribute("placeholder"),
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    }),
  );
  console.log("TEXTAREAS:" + JSON.stringify(detail));
  await page.screenshot({ path: "e2e/welcome.png" });
});

test("welcome and docked composers share one box size", async ({ page }) => {
  await page.goto("/#/chat/new");
  await expect(
    page.getByRole("heading", { name: /what do you want to build/i }),
  ).toBeVisible({ timeout: 15000 });
  const welcomeBox = await page.getByRole("textbox", { name: /Send a message/ }).boundingBox();
  expect(welcomeBox).not.toBeNull();

  const list = await page.request.get("/api/conversations?status=all&limit=5");
  expect(list.ok()).toBe(true);
  const data = (await list.json()) as { threads: Array<{ id: string }> };
  test.skip(data.threads.length === 0, "no existing thread in this database");
  await page.goto(`/#/chat/${data.threads[0].id}`);
  await expect(page.getByRole("textbox", { name: /Send a message/ })).toHaveCount(1, { timeout: 15000 });
  const dockedBox = await page.getByRole("textbox", { name: /Send a message/ }).boundingBox();
  expect(dockedBox).not.toBeNull();
  console.log(
    "BOXES:" +
      JSON.stringify({ welcome: welcomeBox, docked: dockedBox }),
  );
  expect(Math.round(dockedBox!.width)).toBe(Math.round(welcomeBox!.width));
});

