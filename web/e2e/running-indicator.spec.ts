import { expect, test } from "@playwright/test";

/**
 * Runtime-derived running indicator: while a generation is in flight the
 * sidebar row shows a live dot sourced from threadListItem.isRunning
 * (never persisted). Aborting the run clears it; the conversation status
 * never changes.
 */
test("sidebar shows a running dot only while generating", async ({ page }) => {
  await page.goto("/#/chat/new");
  await expect(
    page.getByRole("heading", { name: /what do you want to build/i }),
  ).toBeVisible({ timeout: 15000 });

  // Hold the chat stream: the run stays in-flight without needing provider
  // credentials. The gate always resolves (abort path) so route handlers
  // never dangle — a never-resolving handler would hang unrouteAll("wait").
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/chat", async (route) => {
    await gate;
    await route.abort();
  });

  const box = page.getByRole("textbox", { name: /Send a message/ });
  // Real keystrokes: the composer is controlled state, programmatic fill
  // does not propagate and leaves Send disabled. Submit via the Send
  // button (Enter-key submission is IME/composition sensitive).
  await box.click();
  await box.pressSequentially("indicator probe message", { delay: 10 });
  await page.locator('button[type="submit"]').click();

  // Wait until the draft binds to a real thread (sidebar row appears).
  await page.waitForURL(/#\/chat\/(?!new).+/, { timeout: 30000 });

  const dot = page.getByRole("status", { name: "Generating response" });
  await expect(dot.first()).toBeVisible({ timeout: 15000 });
  // Exactly one composer throughout the run.
  await expect(page.getByRole("textbox", { name: /Send a message/ })).toHaveCount(1);

  release();
  await expect(
    page.getByRole("status", { name: "Generating response" }),
  ).toHaveCount(0, { timeout: 15000 });
});

