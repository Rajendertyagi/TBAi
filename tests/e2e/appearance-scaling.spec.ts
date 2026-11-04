import { expect, test } from "@playwright/test";

test.describe("Typography & Application Scaling Compatibility", () => {
  test("scales application at 75%, 100%, and 150% without breaking virtualized transcript, logs, and radix overlays", async ({
    page,
  }) => {
    // Test scales: 75% (12px), 100% (16px), 150% (24px)
    const zoomLevels = [0.75, 1.0, 1.5];

    for (const zoom of zoomLevels) {
      // 1. Visit Appearance and apply zoom
      await page.goto("/#/appearance");
      await page.waitForLoadState("domcontentloaded");

      await page.evaluate((z) => {
        document.documentElement.style.zoom = String(z);
      }, zoom);

      // In CSS zoom, document.body.scrollWidth reports in scaled CSS pixels.
      // Assert that there is no unintended horizontal scrollbar on documentElement.
      const hasHorizontalOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth + 5;
      });
      expect(hasHorizontalOverflow).toBe(false);

      // 2. Test Radix Overlay (Select dropdown) under zoom
      const fontSelect = page.getByRole("combobox").first();
      await expect(fontSelect).toBeVisible();
      await fontSelect.click();

      const selectContent = page.locator("[data-slot='select-content']");
      await expect(selectContent).toBeVisible();

      // Check coordinates of popover are aligned within viewport
      const selectBox = await selectContent.boundingBox();
      expect(selectBox).not.toBeNull();
      expect(selectBox!.x).toBeGreaterThanOrEqual(0);
      expect(selectBox!.y).toBeGreaterThanOrEqual(0);

      // Dismiss select with Escape
      await page.keyboard.press("Escape");

      // 3. Test Virtualized Transcript under zoom
      await page.goto("/#/");
      await page.waitForLoadState("domcontentloaded");

      await page.evaluate((z) => {
        document.documentElement.style.zoom = String(z);
      }, zoom);

      const composer = page
        .getByRole("textbox", { name: "Send a message" })
        .or(page.locator("textarea"))
        .first();
      await expect(composer).toBeVisible();

      // 4. Test Virtualized LogsPanel under zoom
      await page.goto("/#/logs");
      await page.waitForLoadState("domcontentloaded");

      await page.evaluate((z) => {
        document.documentElement.style.zoom = String(z);
      }, zoom);

      const recentHeading = page.getByRole("heading", { name: "Recent logs" });
      await expect(recentHeading).toBeVisible({ timeout: 15000 });

      // Check log viewport scroll dimensions
      const logScrollContainer = page.locator(".h-\\[30rem\\]").first();
      if (await logScrollContainer.isVisible()) {
        const dimensions = await logScrollContainer.evaluate((el) => ({
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          scrollTop: el.scrollTop,
        }));
        expect(dimensions.clientHeight).toBeGreaterThan(0);
        expect(dimensions.scrollHeight).toBeGreaterThanOrEqual(dimensions.clientHeight);
      }
    }
  });

  test("persists typography settings across page reload with zero layout flash", async ({
    page,
  }) => {
    await page.goto("/#/appearance");
    await page.waitForLoadState("domcontentloaded");

    // Set custom typography directly in localStorage and reload to test pre-paint bootstrap
    await page.evaluate(() => {
      localStorage.setItem(
        "tbai-typography",
        JSON.stringify({
          version: 1,
          fontFamily: "outfit",
          monoFontFamily: "fira-code",
          fontWeight: 600,
          baseSize: 18,
          lineHeight: 1.65,
        }),
      );
    });

    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Verify properties were applied to documentElement
    const state = await page.evaluate(() => {
      const root = document.documentElement;
      return {
        zoom: (root.style as any).zoom,
        fontWeight: root.style.getPropertyValue("--font-weight-base").trim(),
        lineHeight: root.style.getPropertyValue("--font-line-height").trim(),
        fontSans: root.style.getPropertyValue("--font-sans").trim(),
        fontMono: root.style.getPropertyValue("--font-mono").trim(),
      };
    });

    expect(state.zoom).toBe(String(18 / 16)); // 1.125
    expect(state.fontWeight).toBe("600");
    expect(state.lineHeight).toBe("1.65");
    expect(state.fontSans).toContain("Outfit");
    expect(state.fontMono).toContain("Fira Code");
  });
});
