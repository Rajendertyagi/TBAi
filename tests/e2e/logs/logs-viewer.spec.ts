import { expect, test } from "@playwright/test";

test("logs viewer: settings, live entries, filtering, export, files", async ({ page, request }) => {
  // Force capture on (every API call is logged) and restore afterwards.
  const before = await (await request.get("/api/logs/settings")).json();
  await request.put("/api/logs/settings", { data: { level: "debug", targets: [] } });
  try {
    // Seed a uniquely identifiable entry: each API request is logged.
    const marker = `e2e-seed-${Date.now()}`;
    await request.get("/api/providers", { headers: { "x-request-id": marker } });
    await page.goto("/#/logs");
    const main = page.getByRole("main");

    // Viewer chrome.
    await expect(main.getByText("Runtime Logs")).toBeVisible({ timeout: 15000 });
    await expect(main.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Clear" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Export" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Files" })).toBeVisible();
    const search = main.getByPlaceholder(/Search logs/i);
    await expect(search).toBeVisible();
    await expect(main.getByText(/\d+ \/ \d+/)).toBeVisible();

    // Settings dialog exposes capture controls and preserves backend contract fields.
    await main.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Log Runtime Settings")).toBeVisible();
    await expect(dialog.getByText("Default Capture Level")).toBeVisible();
    await expect(dialog.getByText("Per-Scope Overrides")).toBeVisible();
    await expect(dialog.getByRole("switch", { name: "Toggle file sink" })).toBeVisible();
    await dialog
      .locator("div.border-t")
      .getByRole("button", { name: "Close", exact: true })
      .click();

    // The list is virtualized: isolate our row via search so it renders.
    await search.fill(marker);
    const seeded = main.getByText("GET /api/providers").first();
    await expect(seeded).toBeVisible({ timeout: 15000 });

    // Rows expand to a structured detail grid.
    const expander = seeded
      .locator('xpath=ancestor::*[.//button[@aria-label="Toggle details"]][1]')
      .getByRole("button", { name: "Toggle details" });
    await expander.click();
    await expect(expander).toHaveAttribute("aria-expanded", "true");
    await expect(main.locator("div.rounded-md.bg-muted\\/40").first()).toBeVisible();

    // Search narrows; clearing restores the live list.
    await search.fill("zzz-no-such-log");
    await expect(main.getByText("No matching log entries found.")).toBeVisible();
    await search.fill("");
    await expect(main.getByText(/\d+ \/ \d+/)).toBeVisible();

    // Keyboard: "/" focuses search (from a neutral focus point).
    await main.getByRole("button", { name: "Clear" }).focus();
    await page.keyboard.press("/");
    await expect(search).toBeFocused();

    // Export downloads the visible entries.
    await search.fill(marker);
    const downloadPromise = page.waitForEvent("download");
    await main.getByRole("button", { name: "Export" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("tbai-logs-export.log");
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const { readFile } = await import("node:fs/promises");
    const exported = await readFile(downloadPath as string, "utf-8");
    expect(exported).toContain(marker);
    expect(exported.trim().split("\n").length).toBeGreaterThanOrEqual(1);

    // Files dialog shows retention info.
    await main.getByRole("button", { name: "Files" }).click();
    const filesDialog = page.getByRole("dialog");
    await expect(filesDialog.getByText("Disk Log Files & Retention")).toBeVisible();
    await expect(
      filesDialog.getByText(/Total Disk Files|No log files found on disk/i),
    ).toBeVisible();
    await filesDialog
      .locator("div.border-t")
      .getByRole("button", { name: "Close", exact: true })
      .click();
  } finally {
    await request.put("/api/logs/settings", {
      data: { level: before.level, targets: before.targets ?? [] },
    });
  }
});
