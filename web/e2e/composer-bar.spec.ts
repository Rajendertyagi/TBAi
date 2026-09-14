import { expect, test } from "@playwright/test";

/** Return ids of threads whose messages contain the probe marker. */
async function probeThreadIds(
  request: import("@playwright/test").APIRequestContext,
  marker: string,
): Promise<string[]> {
  const list = await request.get("/api/conversations?status=all&limit=20");
  const data = (await list.json()) as { threads: Array<{ id: string }> };
  const hits: string[] = [];
  for (const t of data.threads) {
    const res = await request.get(`/api/conversations/${t.id}/messages`);
    if (!res.ok()) continue;
    const body = await res.json();
    if (JSON.stringify(body).includes(marker)) hits.push(t.id);
  }
  return hits;
}

async function cleanupProbeThreads(
  request: import("@playwright/test").APIRequestContext,
  marker: string,
): Promise<void> {
  for (const id of await probeThreadIds(request, marker)) {
    await request.delete(`/api/conversations/${id}`);
  }
}

test("model picker searches and selects via keyboard", async ({ page }) => {
  await page.goto("/#/chat/new");
  await expect(
    page.getByRole("heading", { name: /what do you want to build/i }),
  ).toBeVisible({ timeout: 15000 });

  await page.locator("button:has(.lucide-bot)").click();
  const search = page.getByRole("combobox", { name: "Search models" });
  await expect(search).toBeVisible();
  const options = page.getByRole("option");
  const total = await options.count();
  expect(total).toBeGreaterThan(0);

  // Gibberish narrows to the empty state; clearing restores the list.
  await search.fill("zzz-no-such-model");
  await expect(page.getByText("No models match your search")).toBeVisible();
  await search.fill("");
  await expect(page.getByRole("option").first()).toBeVisible();

  // Keyboard: arrows move, Enter selects, menu closes.
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(search).toHaveCount(0);
});

test("send/stop share one slot and the composer shrinks back after send", async ({
  page,
}) => {
  const MARKER = "composer bar probe alpha";
  await page.goto("/#/chat/new");
  await expect(
    page.getByRole("heading", { name: /what do you want to build/i }),
  ).toBeVisible({ timeout: 15000 });

  // Hold the chat stream so the run stays in flight for assertions.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/chat", async (route) => {
    await gate;
    await route.abort();
  });

  const box = page.getByRole("textbox", { name: /Send a message/ });
  await box.click();
  // Multiline WITHOUT submitting: Shift+Enter is a newline under
  // submitMode="enter" (bare \n would send on the first line).
  await box.pressSequentially(MARKER, { delay: 5 });
  await box.press("Shift+Enter");
  await box.pressSequentially("line two", { delay: 5 });
  await box.press("Shift+Enter");
  await box.pressSequentially("line three", { delay: 5 });
  const tallBox = await box.boundingBox();
  expect(tallBox!.height).toBeGreaterThan(45);

  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stop generating" }),
  ).toHaveCount(0);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/#\/chat\/(?!new).+/, { timeout: 30000 });

  // Running: exactly one slot, Stop mounted, Send gone, same footprint.
  const stop = page.getByRole("button", { name: "Stop generating" });
  await expect(stop).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toHaveCount(0);
  const stopBox = await stop.boundingBox();

  // Composer cleared + shrunk back immediately (no typing needed).
  await expect(box).toHaveValue("", { timeout: 15000 });
  const shrunk = await box.boundingBox();
  expect(shrunk!.height).toBeLessThanOrEqual(45);

  release();
  await expect(stop).toHaveCount(0, { timeout: 15000 });
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeVisible();
  const sendBox = await page
    .getByRole("button", { name: "Send message" })
    .boundingBox();
  expect(Math.abs(sendBox!.x - stopBox!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(sendBox!.y - stopBox!.y)).toBeLessThanOrEqual(2);

  await cleanupProbeThreads(page.request, MARKER);
});

test("composer right-click shows its own menu, not the page menu", async ({
  page,
}) => {
  await page.goto("/#/chat/new");
  await expect(
    page.getByRole("heading", { name: /what do you want to build/i }),
  ).toBeVisible({ timeout: 15000 });

  await page.getByRole("textbox", { name: /Send a message/ }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Cut" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Copy" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Paste as plain text" }),
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Select all" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Quick messages" }),
  ).toBeVisible();
  // Page-level menu must not appear inside the composer.
  await expect(page.getByRole("menuitem", { name: "New Chat" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

