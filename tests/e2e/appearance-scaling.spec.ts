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

  test("persists independent interface and code typography settings across reload", async ({
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
          monoFontWeight: 700,
          baseSize: 18,
          codeFontSize: 15,
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
        monoFontWeight: root.style.getPropertyValue("--font-weight-mono").trim(),
        codeFontSize: root.style.getPropertyValue("--code-font-size").trim(),
        lineHeight: root.style.getPropertyValue("--font-line-height").trim(),
        fontSans: root.style.getPropertyValue("--font-sans").trim(),
        fontMono: root.style.getPropertyValue("--font-mono").trim(),
      };
    });

    expect(state.zoom).toBe(String(18 / 16)); // 1.125
    expect(state.fontWeight).toBe("600");
    expect(state.monoFontWeight).toBe("700");
    expect(state.codeFontSize).toBe("15px");
    expect(state.lineHeight).toBe("1.65");
    expect(state.fontSans).toContain("Outfit");
    expect(state.fontMono).toContain("Fira Code");
  });

  test("scoped resets modify only the target section", async ({ page }) => {
    await page.goto("/#/appearance");
    await page.waitForLoadState("domcontentloaded");

    // Start with custom settings for all sections
    await page.evaluate(() => {
      localStorage.setItem(
        "tbai-typography",
        JSON.stringify({
          version: 1,
          fontFamily: "roboto",
          monoFontFamily: "fira-code",
          fontWeight: 700,
          monoFontWeight: 600,
          baseSize: 18,
          codeFontSize: 16,
          lineHeight: 1.65,
        }),
      );
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Click "Reset code"
    const resetCodeBtn = page.getByRole("button", { name: "Reset code" });
    await expect(resetCodeBtn).toBeVisible();
    await resetCodeBtn.click();

    // Verify: Code settings reset to defaults, Interface & Scale remain custom
    let saved = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem("tbai-typography") || "{}");
    });
    expect(saved.monoFontFamily).toBe("jetbrains-mono");
    expect(saved.monoFontWeight).toBe(400);
    expect(saved.codeFontSize).toBe(13);
    // Preserved:
    expect(saved.fontFamily).toBe("roboto");
    expect(saved.fontWeight).toBe(700);
    expect(saved.baseSize).toBe(18);

    // Click "Reset interface"
    const resetInterfaceBtn = page.getByRole("button", { name: "Reset interface" });
    await expect(resetInterfaceBtn).toBeVisible();
    await resetInterfaceBtn.click();

    saved = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem("tbai-typography") || "{}");
    });
    expect(saved.fontFamily).toBe("inter");
    expect(saved.fontWeight).toBe(400);
    // Preserved scale:
    expect(saved.baseSize).toBe(18);

    // Click "Reset all"
    const resetAllBtn = page.getByRole("button", { name: "Reset all" });
    await expect(resetAllBtn).toBeVisible();
    await resetAllBtn.click();

    saved = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem("tbai-typography") || "{}");
    });
    expect(saved.baseSize).toBe(16);
    expect(saved.fontFamily).toBe("inter");
    expect(saved.monoFontFamily).toBe("jetbrains-mono");
  });
});
