/**
 * Browser verification for the composer spelling menu and the page Copy item.
 *
 * Both features live in Radix context menus, which open from a real
 * `contextmenu` event and read live DOM selection — neither is reachable from a
 * static render or a unit test, so this is the only place the two promises can
 * actually be proven: that a right-clicked typo yields suggestions that replace
 * exactly that word with the caret restored, and that a page selection is
 * copied exactly as it was captured.
 */
import { test, expect, type Page } from "@playwright/test";

/** Right-clicks at the centre of a locator, which is what a user does. */
async function rightClick(page: Page, selector: string): Promise<void> {
  await page.locator(selector).click({ button: "right" });
}

/** The composer textarea, which owns the draft under test. */
const COMPOSER = '[data-testid="composer-input"], textarea[name="input"]';

/** Reads the composer draft, or `""` when there is none. */
async function draft(page: Page): Promise<string> {
  return (await page.locator(COMPOSER).inputValue().catch(() => "")) ?? "";
}

/** Replaces the draft with `text` and leaves the caret at its end. */
async function setDraft(page: Page, text: string): Promise<void> {
  const composer = page.locator(COMPOSER);
  await composer.click();
  await composer.fill("");
  if (text) await composer.type(text, { delay: 5 });
}

test.describe("composer context menu — spelling suggestions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/chat/new");
    await expect(page.locator(COMPOSER)).toBeVisible();
  });

  test("suggests corrections for a right-clicked typo", async ({ page }) => {
    await setDraft(page, "coztom");
    await rightClick(page, COMPOSER);

    // The header is the proof the block rendered at all...
    await expect(page.getByRole("menuitem", { name: "Spelling suggestions" })).toBeVisible();
    // ...and a named suggestion is the proof it is not an empty shell. Typo.js
    // ranks `custom` inside the candidate set rather than first, so the
    // assertion is on presence, which is the promise a user relies on.
    await expect(
      page.getByRole("menuitem", { name: "custom", exact: true }),
    ).toBeVisible();
    // The menu must still offer the text-editing actions alongside the
    // corrections, exactly as a browser's menu does.
    await expect(page.getByRole("menuitem", { name: "Cut" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Select all" })).toBeVisible();
  });

  test("replaces only the right-clicked word and restores the caret", async ({ page }) => {
    await setDraft(page, "the coztom value");
    // Right-click on the word itself rather than the end of the draft.
    await page.locator(COMPOSER).click({ button: "right", position: { x: 40, y: 10 } });

    const custom = page.getByRole("menuitem", { name: "custom", exact: true });
    await expect(custom).toBeVisible();
    await custom.click();

    // Only the typo changed; the surrounding words survived.
    await expect.poll(() => draft(page)).toBe("the custom value");

    // The caret sits immediately after the corrected word, so the user can keep
    // typing without clicking back into the box.
    const caret = await page.locator(COMPOSER).evaluate((el: HTMLTextAreaElement) => ({
      start: el.selectionStart,
      end: el.selectionEnd,
      value: el.value,
    }));
    expect(caret.start).toBe(10);
    expect(caret.end).toBe(10);
    expect(caret.value.slice(0, caret.start ?? 0)).toBe("the custom");
  });

  test("preserves Capitalised and ALL-CAPS input", async ({ page }) => {
    for (const [typed, expected] of [
      ["Coztom", "Custom"],
      ["COZTOM", "CUSTOM"],
    ] as const) {
      await setDraft(page, typed);
      await rightClick(page, COMPOSER);
      const suggestion = page.getByRole("menuitem", { name: expected, exact: true });
      await expect(suggestion).toBeVisible();
      await suggestion.click();
      await expect.poll(() => draft(page)).toBe(expected);
    }
  });

  test("shows no spelling section for a correctly spelled word", async ({ page }) => {
    await setDraft(page, "custom");
    await rightClick(page, COMPOSER);
    await expect(page.getByRole("menuitem", { name: "Cut" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Spelling suggestions" })).toHaveCount(0);
  });

  test("leaves a technical identifier alone", async ({ page }) => {
    // The guard that matters for a coding composer: real product names must
    // not be invited to be "corrected".
    for (const term of ["Supabase", "TypeScript", "ChatWindow", "API", "POST"]) {
      await setDraft(page, term);
      await rightClick(page, COMPOSER);
      await expect(page.getByRole("menuitem", { name: "Spelling suggestions" })).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
  });

  test("does not load the dictionary for an identifier or before a lookup", async ({ page }) => {
    // Lazy initialisation, proven on the wire: the ~552 KB dictionary chunk is
    // absent after the app loads, and stays absent for tokens that can be
    // dismissed on shape alone. Only a real word lookup fetches it.
    const requests: string[] = [];
    page.on("request", (request) => {
      if (/en_US.*\.js$/.test(request.url())) requests.push(request.url());
    });

    // 1. Opening the app and typing must not fetch it.
    await setDraft(page, "TypeScript");
    await page.waitForTimeout(750);
    expect(requests, "opening the app must not load the dictionary").toEqual([]);

    // 2. A right-click on an identifier is answered from the token's shape, so
    // the dictionary is still never needed.
    await rightClick(page, COMPOSER);
    await expect(page.getByRole("menuitem", { name: "Cut" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Spelling suggestions" })).toHaveCount(0);
    await page.waitForTimeout(750);
    expect(
      requests,
      "an identifier right-click must not load the dictionary",
    ).toEqual([]);

    // 3. A right-click on an ordinary word does need it, and fetches it once.
    await page.keyboard.press("Escape");
    await setDraft(page, "coztom");
    await rightClick(page, COMPOSER);
    await expect(page.getByRole("menuitem", { name: "Spelling suggestions" })).toBeVisible();
    expect(
      requests.length,
      "the dictionary chunk should load on the first real lookup",
    ).toBeGreaterThan(0);
  });

  test("leaves the existing text actions working", async ({ page }) => {
    await setDraft(page, "hello there");
    await rightClick(page, COMPOSER);

    // Select all is the safest of the four to assert on: it mutates the draft
    // in a way that is directly observable, and proves the spelling block did
    // not displace the existing entries.
    await page.getByRole("menuitem", { name: "Select all" }).click();
    const selected = await page
      .locator(COMPOSER)
      .evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
    expect(selected).toBe("hello there");
  });
});

test.describe("page context menu — copy selected text", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/chat/new");
    await expect(page.locator(COMPOSER)).toBeVisible();
  });

  test("copies the exact captured selection", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    // Select a distinctive run of text on the page.
    const target = page.getByRole("heading", { name: /what do you want to build/i });
    const text = ((await target.innerText()) ?? "").trim();
    expect(text.length).toBeGreaterThan(0);

    await page.evaluate((selector) => {
      const node = document.querySelector(selector);
      if (!node) return;
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, "h1, h2");

    await page.locator("main, [role=main], #root").first().click({ button: "right" });

    const copyItem = page.getByRole("menuitem", { name: "Copy", exact: true });
    await expect(copyItem).toBeEnabled();
    await copyItem.click();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard.trim()).toBe(text.trim());
  });

  test("disables Copy when nothing is selected", async ({ page }) => {
    await page.locator("main, [role=main], #root").first().click({ button: "right" });
    const copyItem = page.getByRole("menuitem", { name: "Copy", exact: true });
    await expect(copyItem).toBeVisible();
    await expect(copyItem).toBeDisabled();
  });

  test("keeps the page menu's existing items", async ({ page }) => {
    await page.locator("main, [role=main], #root").first().click({ button: "right" });
    for (const label of ["New Chat", "Toggle Sidebar", "Open Settings"]) {
      await expect(page.getByRole("menuitem", { name: label, exact: true })).toBeVisible();
    }
  });
});
