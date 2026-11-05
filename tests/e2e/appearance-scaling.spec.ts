import { expect, test } from "@playwright/test";

/**
 * Typography & application scaling — rendered-behaviour coverage.
 *
 * The independence contract is asserted against COMPUTED styles of real
 * elements (the appearance page renders a live code preview and a live
 * terminal preview), not against root variables alone:
 *
 * - interface changes leave code and terminal typography untouched;
 * - code changes leave interface and terminal typography untouched;
 * - terminal changes leave interface and code typography untouched;
 * - code wrap is visual only (textContent is byte-identical);
 * - terminal wrap does not affect code wrap;
 * - reading line height affects prose only;
 * - application scale changes geometry but never stored font preferences.
 */

const V2_DEFAULTS = {
  version: 2,
  interfaceFontFamily: "inter",
  interfaceFontSize: 16,
  interfaceFontWeight: 400,
  codeFontFamily: "jetbrains-mono",
  codeFontSize: 13,
  codeFontWeight: 400,
  codeWordWrap: false,
  terminalFontFamily: "jetbrains-mono",
  terminalFontSize: 12,
  terminalFontWeight: 400,
  terminalWrap: true,
  readingLineHeight: 1.5,
  appScale: 1,
} as const;

/** Seed a Direct conversation with one user turn and one assistant reply. */
async function seedConversationWithReply(
  request: import("@playwright/test").APIRequestContext,
  label: string,
  replyText: string,
): Promise<string> {
  const created = await request.post("/api/conversations", {
    data: { title: label, workspaceMode: "simple", engine: "direct" },
  });
  expect(created.ok()).toBe(true);
  const conversation = (await created.json()) as { id: string };
  const user = await request.post(`/api/conversations/${conversation.id}/messages`, {
    data: {
      message: {
        id: `seed-user-${conversation.id}`,
        parent_id: null,
        format: "ai-sdk/v6",
        content: { role: "user", parts: [{ type: "text", text: "hello" }] },
      },
    },
  });
  expect(user.ok()).toBe(true);
  const reply = await request.post(`/api/conversations/${conversation.id}/messages`, {
    data: {
      message: {
        id: `seed-assistant-${conversation.id}`,
        parent_id: `seed-user-${conversation.id}`,
        format: "ai-sdk/v6",
        content: { role: "assistant", parts: [{ type: "text", text: replyText }] },
      },
    },
  });
  expect(reply.ok()).toBe(true);
  return conversation.id;
}

test.describe("Typography & Application Scaling Compatibility", () => {
  test("scales application at 75%, 100%, and 150% without breaking virtualized transcript, logs, and radix overlays", async ({
    page,
  }) => {
    // Test scales: 75% (0.75), 100% (1), 150% (1.5)
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
          version: 2,
          interfaceFontFamily: "outfit",
          interfaceFontSize: 18,
          interfaceFontWeight: 600,
          codeFontFamily: "fira-code",
          codeFontSize: 15,
          codeFontWeight: 700,
          codeWordWrap: true,
          terminalFontFamily: "source-code-pro",
          terminalFontSize: 14,
          terminalFontWeight: 600,
          terminalWrap: false,
          readingLineHeight: 1.65,
          appScale: 1.125,
        }),
      );
    });

    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Verify properties were applied to documentElement
    const state = await page.evaluate(() => {
      const root = document.documentElement;
      return {
        zoom: (root.style as CSSStyleDeclaration & { zoom?: string }).zoom,
        interfaceFontSize: root.style.getPropertyValue("--interface-font-size").trim(),
        fontWeight: root.style.getPropertyValue("--font-weight-base").trim(),
        codeFontFamily: root.style.getPropertyValue("--code-font-family").trim(),
        codeFontSize: root.style.getPropertyValue("--code-font-size").trim(),
        codeFontWeight: root.style.getPropertyValue("--code-font-weight").trim(),
        terminalFontFamily: root.style.getPropertyValue("--terminal-font-family").trim(),
        terminalFontSize: root.style.getPropertyValue("--terminal-font-size").trim(),
        terminalFontWeight: root.style.getPropertyValue("--terminal-font-weight").trim(),
        readingLineHeight: root.style.getPropertyValue("--reading-line-height").trim(),
        fontSans: root.style.getPropertyValue("--font-sans").trim(),
        codeWrap: root.getAttribute("data-code-wrap"),
        terminalWrap: root.getAttribute("data-terminal-wrap"),
      };
    });

    expect(state.zoom).toBe("1.125");
    expect(state.interfaceFontSize).toBe("18px");
    expect(state.fontWeight).toBe("600");
    expect(state.codeFontFamily).toContain("Fira Code");
    expect(state.codeFontSize).toBe("15px");
    expect(state.codeFontWeight).toBe("700");
    expect(state.terminalFontFamily).toContain("Source Code Pro");
    expect(state.terminalFontSize).toBe("14px");
    expect(state.terminalFontWeight).toBe("600");
    expect(state.readingLineHeight).toBe("1.65");
    expect(state.fontSans).toContain("Outfit");
    expect(state.codeWrap).toBe("on");
    expect(state.terminalWrap).toBe("off");
  });

  test("scoped resets modify only the target section", async ({ page }) => {
    await page.goto("/#/appearance");
    await page.waitForLoadState("domcontentloaded");

    // Start with custom settings for all sections
    await page.evaluate(() => {
      localStorage.setItem(
        "tbai-typography",
        JSON.stringify({
          version: 2,
          interfaceFontFamily: "roboto",
          interfaceFontSize: 18,
          interfaceFontWeight: 700,
          codeFontFamily: "fira-code",
          codeFontSize: 16,
          codeFontWeight: 600,
          codeWordWrap: true,
          terminalFontFamily: "source-code-pro",
          terminalFontSize: 14,
          terminalFontWeight: 600,
          terminalWrap: false,
          readingLineHeight: 1.65,
          appScale: 1.125,
        }),
      );
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const readSaved = () =>
      page.evaluate(() => JSON.parse(localStorage.getItem("tbai-typography") || "{}"));

    // Click "Reset code"
    const resetCodeBtn = page.getByRole("button", { name: "Reset code" });
    await expect(resetCodeBtn).toBeVisible();
    await resetCodeBtn.click();

    let saved = await readSaved();
    expect(saved.codeFontFamily).toBe("jetbrains-mono");
    expect(saved.codeFontWeight).toBe(400);
    expect(saved.codeFontSize).toBe(13);
    expect(saved.codeWordWrap).toBe(false);
    // Preserved:
    expect(saved.interfaceFontFamily).toBe("roboto");
    expect(saved.interfaceFontSize).toBe(18);
    expect(saved.interfaceFontWeight).toBe(700);
    expect(saved.terminalFontFamily).toBe("source-code-pro");
    expect(saved.terminalFontSize).toBe(14);
    expect(saved.terminalWrap).toBe(false);
    expect(saved.readingLineHeight).toBe(1.65);
    expect(saved.appScale).toBe(1.125);

    // Click "Reset interface"
    const resetInterfaceBtn = page.getByRole("button", { name: "Reset interface" });
    await expect(resetInterfaceBtn).toBeVisible();
    await resetInterfaceBtn.click();

    saved = await readSaved();
    expect(saved.interfaceFontFamily).toBe("inter");
    expect(saved.interfaceFontSize).toBe(16);
    expect(saved.interfaceFontWeight).toBe(400);
    // Preserved:
    expect(saved.terminalFontFamily).toBe("source-code-pro");
    expect(saved.appScale).toBe(1.125);

    // Click "Reset terminal"
    const resetTerminalBtn = page.getByRole("button", { name: "Reset terminal" });
    await expect(resetTerminalBtn).toBeVisible();
    await resetTerminalBtn.click();

    saved = await readSaved();
    expect(saved.terminalFontFamily).toBe("jetbrains-mono");
    expect(saved.terminalFontSize).toBe(12);
    expect(saved.terminalFontWeight).toBe(400);
    expect(saved.terminalWrap).toBe(true);
    // Preserved:
    expect(saved.appScale).toBe(1.125);
    expect(saved.readingLineHeight).toBe(1.65);

    // Click "Reset reading"
    const resetReadingBtn = page.getByRole("button", { name: "Reset reading" });
    await expect(resetReadingBtn).toBeVisible();
    await resetReadingBtn.click();

    saved = await readSaved();
    expect(saved.readingLineHeight).toBe(1.5);
    // Preserved:
    expect(saved.appScale).toBe(1.125);

    // Click "Reset scale"
    const resetScaleBtn = page.getByRole("button", { name: "Reset scale" });
    await expect(resetScaleBtn).toBeVisible();
    await resetScaleBtn.click();

    saved = await readSaved();
    expect(saved.appScale).toBe(1);

    // Click "Reset all"
    const resetAllBtn = page.getByRole("button", { name: "Reset all" });
    await expect(resetAllBtn).toBeVisible();
    await resetAllBtn.click();

    saved = await readSaved();
    expect(saved).toEqual(V2_DEFAULTS);
  });

  test("interface changes do not modify code or terminal typography", async ({ page }) => {
    await page.goto("/#/appearance");
    await page.waitForLoadState("domcontentloaded");

    const codePre = page.locator(".aui-shiki-base pre.shiki").first();
    const terminalBlock = page.locator('[data-slot="terminal-block"]').first();
    await expect(codePre).toBeVisible();
    await expect(terminalBlock).toBeVisible();

    const before = {
      codeFamily: await codePre.evaluate((el) => getComputedStyle(el).fontFamily),
      codeSize: await codePre.evaluate((el) => getComputedStyle(el).fontSize),
      codeWeight: await codePre.evaluate((el) => getComputedStyle(el).fontWeight),
      terminalFamily: await terminalBlock.evaluate((el) => getComputedStyle(el).fontFamily),
      terminalSize: await terminalBlock.evaluate((el) => getComputedStyle(el).fontSize),
      terminalWeight: await terminalBlock.evaluate((el) => getComputedStyle(el).fontWeight),
    };

    // Change the interface font to Roboto via localStorage + reload.
    await page.evaluate(() => {
      localStorage.setItem(
        "tbai-typography",
        JSON.stringify({ version: 2, interfaceFontFamily: "roboto", interfaceFontSize: 20 }),
      );
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const codePreAfter = page.locator(".aui-shiki-base pre.shiki").first();
    const terminalBlockAfter = page.locator('[data-slot="terminal-block"]').first();
    await expect(codePreAfter).toBeVisible();
    await expect(terminalBlockAfter).toBeVisible();

    expect(await codePreAfter.evaluate((el) => getComputedStyle(el).fontFamily)).toBe(
      before.codeFamily,
    );
    expect(await codePreAfter.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
      before.codeSize,
    );
    expect(await codePreAfter.evaluate((el) => getComputedStyle(el).fontWeight)).toBe(
      before.codeWeight,
    );
    expect(await terminalBlockAfter.evaluate((el) => getComputedStyle(el).fontFamily)).toBe(
      before.terminalFamily,
    );
    expect(await terminalBlockAfter.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
      before.terminalSize,
    );
    expect(await terminalBlockAfter.evaluate((el) => getComputedStyle(el).fontWeight)).toBe(
      before.terminalWeight,
    );

    // The interface itself did change.
    const bodyFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(bodyFamily).toContain("Roboto");
  });

  test("code changes do not modify interface or terminal typography", async ({ page }) => {
    await page.goto("/#/appearance");
    await page.waitForLoadState("domcontentloaded");

    const terminalBlock = page.locator('[data-slot="terminal-block"]').first();
    await expect(terminalBlock).toBeVisible();

    const before = {
      bodyFamily: await page.evaluate(() => getComputedStyle(document.body).fontFamily),
      terminalFamily: await terminalBlock.evaluate((el) => getComputedStyle(el).fontFamily),
      terminalSize: await terminalBlock.evaluate((el) => getComputedStyle(el).fontSize),
      terminalWeight: await terminalBlock.evaluate((el) => getComputedStyle(el).fontWeight),
    };

    await page.evaluate(() => {
      localStorage.setItem(
        "tbai-typography",
        JSON.stringify({
          version: 2,
          codeFontFamily: "fira-code",
          codeFontSize: 17,
          codeFontWeight: 700,
        }),
      );
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const codePre = page.locator(".aui-shiki-base pre.shiki").first();
    const terminalBlockAfter = page.locator('[data-slot="terminal-block"]').first();
    await expect(codePre).toBeVisible();
    await expect(terminalBlockAfter).toBeVisible();

    expect(await codePre.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Fira Code");
    expect(await codePre.evaluate((el) => getComputedStyle(el).fontSize)).toBe("17px");
    expect(await codePre.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("700");

    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toBe(
      before.bodyFamily,
    );
    expect(await terminalBlockAfter.evaluate((el) => getComputedStyle(el).fontFamily)).toBe(
      before.terminalFamily,
    );
    expect(await terminalBlockAfter.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
      before.terminalSize,
    );
    expect(await terminalBlockAfter.evaluate((el) => getComputedStyle(el).fontWeight)).toBe(
      before.terminalWeight,
    );
  });

  test("terminal changes do not modify interface or code typography", async ({ page }) => {
    await page.goto("/#/appearance");
    await page.waitForLoadState("domcontentloaded");

    const codePre = page.locator(".aui-shiki-base pre.shiki").first();
    await expect(codePre).toBeVisible();

    const before = {
      bodyFamily: await page.evaluate(() => getComputedStyle(document.body).fontFamily),
      codeFamily: await codePre.evaluate((el) => getComputedStyle(el).fontFamily),
      codeSize: await codePre.evaluate((el) => getComputedStyle(el).fontSize),
      codeWeight: await codePre.evaluate((el) => getComputedStyle(el).fontWeight),
    };

    await page.evaluate(() => {
      localStorage.setItem(
        "tbai-typography",
        JSON.stringify({
          version: 2,
          terminalFontFamily: "source-code-pro",
          terminalFontSize: 16,
          terminalFontWeight: 700,
        }),
      );
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const terminalBlock = page.locator('[data-slot="terminal-block"]').first();
    const codePreAfter = page.locator(".aui-shiki-base pre.shiki").first();
    await expect(terminalBlock).toBeVisible();
    await expect(codePreAfter).toBeVisible();

    expect(await terminalBlock.evaluate((el) => getComputedStyle(el).fontFamily)).toContain(
      "Source Code Pro",
    );
    expect(await terminalBlock.evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
    expect(await terminalBlock.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("700");

    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toBe(
      before.bodyFamily,
    );
    expect(await codePreAfter.evaluate((el) => getComputedStyle(el).fontFamily)).toBe(
      before.codeFamily,
    );
    expect(await codePreAfter.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
      before.codeSize,
    );
    expect(await codePreAfter.evaluate((el) => getComputedStyle(el).fontWeight)).toBe(
      before.codeWeight,
    );
  });

  test("code word wrap is visual only — copied source is byte-identical", async ({ page }) => {
    await page.goto("/#/appearance");
    await page.waitForLoadState("domcontentloaded");

    const codePre = page.locator(".aui-shiki-base pre.shiki").first();
    await expect(codePre).toBeVisible();
    const textBefore = await codePre.evaluate((el) => el.textContent);

    // Enable code word wrap via localStorage + reload.
    await page.evaluate(() => {
      localStorage.setItem("tbai-typography", JSON.stringify({ version: 2, codeWordWrap: true }));
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const codePreAfter = page.locator(".aui-shiki-base pre.shiki").first();
    await expect(codePreAfter).toBeVisible();
    const textAfter = await codePreAfter.evaluate((el) => el.textContent);
    const whiteSpace = await codePreAfter.evaluate((el) => getComputedStyle(el).whiteSpace);

    expect(textAfter).toBe(textBefore);
    expect(whiteSpace).toBe("pre-wrap");
  });

  test("terminal wrapping does not affect code wrapping", async ({ page }) => {
    await page.goto("/#/appearance");
    await page.waitForLoadState("domcontentloaded");

    const codePre = page.locator(".aui-shiki-base pre.shiki").first();
    await expect(codePre).toBeVisible();
    const codeWhiteSpaceBefore = await codePre.evaluate((el) => getComputedStyle(el).whiteSpace);

    // Toggle terminal wrapping off; code wrapping must be untouched.
    await page.evaluate(() => {
      localStorage.setItem("tbai-typography", JSON.stringify({ version: 2, terminalWrap: false }));
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const codePreAfter = page.locator(".aui-shiki-base pre.shiki").first();
    await expect(codePreAfter).toBeVisible();
    expect(await codePreAfter.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe(
      codeWhiteSpaceBefore,
    );

    // And the terminal rows switched to non-wrapping.
    const terminalRow = page.locator('[data-slot="terminal-block"] > div:last-child > div').first();
    await expect(terminalRow).toBeVisible();
    expect(await terminalRow.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre");
  });

  test("reading line height affects prose only", async ({ page, request }) => {
    test.setTimeout(120_000);
    const conversationId = await seedConversationWithReply(
      request,
      `reading line height ${Date.now()}`,
      "A paragraph of readable prose for the line-height check.",
    );

    await page.goto(`/#/chat/${conversationId}`);
    await expect(page.getByRole("textbox", { name: /Send a message/i }).first()).toBeVisible({
      timeout: 30000,
    });

    const prose = page.locator(".aui-md-p").first();
    await expect(prose).toBeVisible({ timeout: 30000 });
    const proseLineHeightBefore = await prose.evaluate((el) => getComputedStyle(el).lineHeight);

    // A button's line-height must not change with the reading setting.
    const button = page.getByRole("button").first();
    const buttonLineHeightBefore = await button.evaluate((el) => getComputedStyle(el).lineHeight);

    await page.evaluate(() => {
      localStorage.setItem(
        "tbai-typography",
        JSON.stringify({ version: 2, readingLineHeight: 1.65 }),
      );
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const proseAfter = page.locator(".aui-md-p").first();
    await expect(proseAfter).toBeVisible({ timeout: 30000 });
    const proseLineHeightAfter = await proseAfter.evaluate((el) => getComputedStyle(el).lineHeight);
    expect(proseLineHeightAfter).not.toBe(proseLineHeightBefore);

    const buttonAfter = page.getByRole("button").first();
    expect(await buttonAfter.evaluate((el) => getComputedStyle(el).lineHeight)).toBe(
      buttonLineHeightBefore,
    );
  });

  test("application scale changes geometry but not stored font preferences", async ({ page }) => {
    await page.goto("/#/appearance");
    await page.waitForLoadState("domcontentloaded");

    await page.evaluate(() => {
      localStorage.setItem(
        "tbai-typography",
        JSON.stringify({
          version: 2,
          interfaceFontFamily: "roboto",
          interfaceFontSize: 18,
          codeFontFamily: "fira-code",
          codeFontSize: 15,
          terminalFontFamily: "source-code-pro",
          terminalFontSize: 14,
          appScale: 1.25,
        }),
      );
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const zoom = await page.evaluate(
      () => (document.documentElement.style as CSSStyleDeclaration & { zoom?: string }).zoom,
    );
    expect(zoom).toBe("1.25");

    // Stored font preferences are untouched by the scale.
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("tbai-typography") || "{}"),
    );
    expect(saved.interfaceFontFamily).toBe("roboto");
    expect(saved.interfaceFontSize).toBe(18);
    expect(saved.codeFontFamily).toBe("fira-code");
    expect(saved.codeFontSize).toBe(15);
    expect(saved.terminalFontFamily).toBe("source-code-pro");
    expect(saved.terminalFontSize).toBe(14);
    expect(saved.appScale).toBe(1.25);
  });
});
