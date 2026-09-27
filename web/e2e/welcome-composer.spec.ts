import { expect, test } from "@playwright/test";
import {
  removeConversation,
  seedConversation,
} from "./helpers/seedConversation";

test("new-chat screen has exactly one composer", async ({ page }, testInfo) => {
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
  // Debug capture into Playwright's gitignored artifact dir rather than beside
  // the spec, so running the suite leaves no trace in the working tree.
  await page.screenshot({ path: testInfo.outputPath("welcome.png") });
});

test("welcome and docked composers share one box size", async ({ page }) => {
  await page.goto("/#/chat/new");
  await expect(
    page.getByRole("heading", { name: /what do you want to build/i }),
  ).toBeVisible({ timeout: 15000 });
  const welcomeBox = await page.getByRole("textbox", { name: /Send a message/ }).boundingBox();
  expect(welcomeBox).not.toBeNull();

  // Seeded rather than borrowed: this used to skip when the conversation list
  // was empty, which under per-spec isolation was every run.
  const { id: conversationId } = await seedConversation(page.request);

  try {
    await page.goto(`/#/chat/${conversationId}`);
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toHaveCount(1, { timeout: 15000 });
    const dockedBox = await page.getByRole("textbox", { name: /Send a message/ }).boundingBox();
    expect(dockedBox).not.toBeNull();
    console.log(
      "BOXES:" +
        JSON.stringify({ welcome: welcomeBox, docked: dockedBox }),
    );
    expect(Math.round(dockedBox!.width)).toBe(Math.round(welcomeBox!.width));
  } finally {
    await removeConversation(page.request, conversationId);
  }
});

