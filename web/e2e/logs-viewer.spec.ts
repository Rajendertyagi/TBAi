import { expect, test } from "@playwright/test";

test("logs match codeg layout: capture, viewer, files", async ({ page, request }) => {
  // Force capture on (every API call is logged) and restore afterwards.
  const before = await (await request.get("/api/logs/settings")).json();
  await request.put("/api/logs/settings", { data: { level: "debug", targets: [] } });
  try {
    // Seed a uniquely identifiable entry: each API request is logged.
    const marker = `e2e-seed-${Date.now()}`;
    await request.get("/api/providers", { headers: { "x-request-id": marker } });
    await page.goto("/#/logs");
    const main = page.getByRole("main");

    // Capture card.
    await expect(main.getByRole("heading", { name: "Log level", exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(main.getByText("Per-scope overrides")).toBeVisible();
    await expect(main.getByRole("switch", { name: "Toggle file sink" })).toBeVisible();

    // Viewer card.
    await expect(main.getByRole("heading", { name: "Recent logs" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Clear" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Export" })).toBeVisible();
    const search = main.getByPlaceholder("Search message or target…");
    await expect(search).toBeVisible();
    await expect(main.getByText(/\/ \d+ shown/)).toBeVisible();

    // The list is virtualized: isolate our row via search so it renders.
    await search.fill(marker);
    const seeded = main.getByText("GET /api/providers").first();
    await expect(seeded).toBeVisible({ timeout: 15000 });

    // Rows expand to a structured detail grid.
    const expander = main.getByRole("button", { name: "Toggle details" }).first();
    await expander.click();
    await expect(expander).toHaveAttribute("aria-expanded", "true");
    await expect(main.locator("div.grid.grid-cols-\\[auto_1fr\\]").first()).toBeVisible();

    // Search narrows; clearing restores the live list.
    await search.fill("zzz-no-such-log");
    await expect(main.getByText("No entries match the current filters.")).toBeVisible();
    await search.fill("");
    await expect(main.getByText(/\/ \d+ shown/)).toBeVisible();

    // Time range: a future window matches nothing; clearing restores rows.
    // NOTE: datetime-local interprets input as LOCAL time — build the string
    // from local components (toISOString is UTC and lands in the past here).
    const pad = (n: number) => String(n).padStart(2, "0");
    const future = new Date(Date.now() + 3600 * 1000);
    const iso =
      `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}` +
      `T${pad(future.getHours())}:${pad(future.getMinutes())}`;
    await main.getByLabel("Show entries from").fill(iso);
    await expect(main.getByText("No entries match the current filters.")).toBeVisible();
    await main.getByRole("button", { name: "Clear range" }).click();
    await expect(main.getByText(/\/ \d+ shown/)).toBeVisible();

    // Keyboard: "/" focuses search (from a neutral focus point).
    await main.getByRole("button", { name: "Refresh" }).click();
    await page.keyboard.press("/");
    await expect(search).toBeFocused();

    // Export downloads the visible entries as JSON lines.
    await search.fill(marker);
    const downloadPromise = page.waitForEvent("download");
    await main.getByRole("button", { name: "Export" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("tbai-logs-export.log");
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const { readFile } = await import("fs/promises");
    const exported = await readFile(downloadPath as string, "utf-8");
    expect(exported).toContain(marker);
    expect(exported.trim().split("\n").length).toBeGreaterThanOrEqual(1);

    // Files card with retention policy.
    await expect(main.getByRole("heading", { name: "Log files" })).toBeVisible();
    await expect(main.getByText(/files · .* total/)).toBeVisible();
  } finally {
    await request.put("/api/logs/settings", {
      data: { level: before.level, targets: before.targets ?? [] },
    });
  }
});
