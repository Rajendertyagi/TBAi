import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import type { TypographyConfig } from "../../web/src/features/appearance/typography";

/**
 * Typography standardization — rendered behaviour (Phase 5).
 *
 * This spec covers what only a real browser can prove:
 *
 * - the page-title convention (exactly one `h1` per route, strip label not a
 *   heading, back button navigates to chat);
 * - the compact tiers and the 9px floor at 14 / 16 / 24px, including a scan for
 *   ANY rendered text below 9px;
 * - the badge's content-driven minimum at the maximum interface size;
 * - a real structured tool payload following the Code channel (not Interface);
 * - Lato registering every advertised weight for both probe texts;
 * - the 12/13 → 14 migration reaching first paint.
 *
 * The three `0.84375×` multiplier sites and the `mono` helper live only in
 * agent-mode (OpenCode) surfaces, which the isolated e2e server cannot mount
 * (no managed OpenCode server). Those are guarded at the DOM layer instead;
 * see tests/dom/appearance/typography.test.tsx.
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

const SETTINGS_ROUTES = [
  { path: "/providers", heading: "Providers", strip: "Providers" },
  { path: "/appearance", heading: "Appearance", strip: "Appearance" },
  { path: "/workspace", heading: "Workspace", strip: "Workspace" },
  { path: "/opencode-config", heading: "OpenCode Configuration", strip: "OpenCode Config" },
  { path: "/folders", heading: "Folders", strip: "Folders" },
  { path: "/desktop", heading: "Desktop", strip: "Desktop" },
  { path: "/memory", heading: "Memory", strip: "Memory" },
  { path: "/quick-messages", heading: "Quick Messages", strip: "Quick Messages" },
  { path: "/mcp", heading: "MCP Servers", strip: "MCP" },
  { path: "/logs", heading: "Logs", strip: "Logs" },
] as const;

/** Seed the stored typography, then reload so the pre-paint bootstrap runs. */
async function applyTypography(
  page: Page,
  overrides: Partial<TypographyConfig> = {},
): Promise<void> {
  const config = { ...V2_DEFAULTS, ...overrides };
  await page.evaluate((value) => {
    localStorage.setItem("tbai-typography", JSON.stringify(value));
  }, config);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
}

/** Computed font-size (px) of the first element containing `needle`. */
async function fontSizeOf(page: Page, needle: string): Promise<number | null> {
  const locator = page.locator(`text=${needle}`).first();
  await expect(locator).toBeVisible({ timeout: 10_000 });
  return locator.evaluate((el) => {
    // If el has children and one of them also contains the text directly, find the deepest leaf
    let curr: HTMLElement = el as HTMLElement;
    while (curr.firstElementChild) {
      const childWithText = Array.from(curr.children).find((c) =>
        (c.textContent ?? "").includes(needle),
      ) as HTMLElement | undefined;
      if (childWithText) {
        curr = childWithText;
      } else {
        break;
      }
    }
    return Number.parseFloat(getComputedStyle(curr).fontSize);
  });
}

test.describe("page-title convention", () => {
  test("every settings route owns exactly one h1 and the strip label is not a heading", async ({
    page,
  }) => {
    for (const route of SETTINGS_ROUTES) {
      await page.goto(`/#${route.path}`);
      const heading = page.locator("h1");
      await expect(heading, `${route.path} must render one h1`).toHaveCount(1);
      await expect(heading).toHaveText(route.heading);
      // The strip is chrome: it repeats the section name as a span.
      const strip = page.locator('[data-slot="page-title-strip"]');
      await expect(strip).toBeVisible();
      await expect(strip.locator("h1")).toHaveCount(0);
      await expect(strip).toContainText(route.strip);
    }
  });

  test("Scheduler keeps the strip as its single h1; Archived has its own", async ({ page }) => {
    await page.goto("/#/scheduler");
    const schedulerStrip = page.locator('[data-slot="page-title-strip"]');
    await expect(schedulerStrip.locator("h1")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveText("Scheduler");

    await page.goto("/#/archived");
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveText("Archived");
    await expect(page.locator('[data-slot="page-title-strip"]')).toHaveCount(0);
  });

  test("the strip back button returns to chat", async ({ page }) => {
    await page.goto("/#/providers");
    await page.locator('[data-slot="page-title-strip"] button').first().click();
    await expect(page).toHaveURL(/#\/chat/);
  });
});

test.describe("compact tiers and the 9px floor", () => {
  const cases = [
    { size: 14, xs: 10.5, twoXs: 9.625, threeXs: 9 },
    { size: 16, xs: 12, twoXs: 11, threeXs: 10 },
    { size: 24, xs: 18, twoXs: 16.5, threeXs: 15 },
  ] as const;

  for (const tier of cases) {
    test(`renders xs/2xs/3xs at ${tier.size}px`, async ({ page }) => {
      await page.goto("/#/appearance");
      await applyTypography(page, { interfaceFontSize: tier.size });

      const xs = await fontSizeOf(page, "A provider-agnostic, local-first");
      const twoXs = await fontSizeOf(page, "Live Typography Preview");
      const threeXs = await fontSizeOf(page, "UI: ");

      expect(xs).toBeCloseTo(tier.xs, 2);
      expect(twoXs).toBeCloseTo(tier.twoXs, 2);
      expect(threeXs).toBeCloseTo(tier.threeXs, 2);
    });
  }

  test("no rendered text falls below 9px at the minimum interface size", async ({ page }) => {
    await page.goto("/#/appearance");
    await applyTypography(page, { interfaceFontSize: 14 });

    const tooSmall = await page.evaluate(() => {
      const offenders: string[] = [];
      for (const element of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        if (element.children.length > 0) continue;
        const text = (element.textContent ?? "").trim();
        if (!text) continue;
        if (element.getClientRects().length === 0) continue;
        const size = Number.parseFloat(getComputedStyle(element).fontSize);
        if (size < 9) offenders.push(`${size}px: ${text.slice(0, 40)}`);
      }
      return offenders;
    });
    expect(tooSmall).toEqual([]);
  });
});

test.describe("migration to the 14px minimum", () => {
  test("a stored 12 paints at 14px and the setting reads 14", async ({ page }) => {
    await page.goto("/#/appearance");
    await applyTypography(page, { interfaceFontSize: 12 });

    const rootSize = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--interface-font-size").trim(),
    );
    expect(rootSize).toBe("14px");
    await expect(page.getByRole("spinbutton", { name: "Interface font size (px)" })).toHaveValue(
      "14",
    );
  });
});

test.describe("badge at the maximum interface size", () => {
  test("does not clip and keeps its 20px minimum at the default", async ({ page }) => {
    await page.goto("/#/providers");
    await applyTypography(page, { interfaceFontSize: 16 });

    const badge = page.locator('[data-slot="badge"]').first();
    await expect(badge).toBeVisible();
    const defaultBox = await badge.evaluate((element) => ({
      scroll: element.scrollHeight,
      client: element.clientHeight,
      height: element.getBoundingClientRect().height,
    }));
    expect(defaultBox.scroll).toBeLessThanOrEqual(defaultBox.client);
    expect(Math.round(defaultBox.height)).toBe(20);

    await applyTypography(page, { interfaceFontSize: 24 });
    const maximumBox = await badge.evaluate((element) => ({
      scroll: element.scrollHeight,
      client: element.clientHeight,
      height: element.getBoundingClientRect().height,
    }));
    expect(maximumBox.scroll).toBeLessThanOrEqual(maximumBox.client);
    expect(Math.round(maximumBox.height)).toBe(23);
  });

  test("ProviderDialog context window input renders compact and grows at 24px", async ({
    page,
  }) => {
    await page.goto("/#/providers");
    await applyTypography(page, { interfaceFontSize: 16 });

    // Open edit dialog for the first provider
    const editBtn = page.locator('button[aria-label^="Edit "]').first();
    await expect(editBtn).toBeVisible();
    await editBtn.click();

    // Add a manual model so we have a model chip with context-window button
    const modelInput = page.locator('input[placeholder*="Type a model name"]').first();
    await expect(modelInput).toBeVisible();
    await modelInput.fill("test-model");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    // Context window button ("set window" or formatContextWindow)
    const windowBtn = page
      .locator(
        'button[title="Edit context window"], button[title="Set context window"], button:has-text("set window")',
      )
      .first();
    await expect(windowBtn).toBeVisible();
    await windowBtn.click();

    // Input is rendered
    const input = page.locator('input[aria-label^="Context window for"]').first();
    await expect(input).toBeVisible();

    const at16 = await input.evaluate((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        fontSize: Number.parseFloat(style.fontSize),
        height: rect.height,
        scroll: el.scrollHeight,
        client: el.clientHeight,
      };
    });

    expect(at16.fontSize).toBeCloseTo(10, 1);
    expect(at16.height).toBeCloseTo(20, 1);
    expect(at16.scroll).toBeLessThanOrEqual(at16.client);

    // Close the dialog by clicking the overlay or pressing Escape twice
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Now test at interface font size 24px
    await applyTypography(page, { interfaceFontSize: 24 });
    const editBtn24 = page.locator('button[aria-label^="Edit "]').first();
    await expect(editBtn24).toBeVisible();
    await editBtn24.click();

    const modelInput24 = page.locator('input[placeholder*="Type a model name"]').first();
    await expect(modelInput24).toBeVisible();
    await modelInput24.fill("test-model-24");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    const windowBtn24 = page
      .locator(
        'button[title="Edit context window"], button[title="Set context window"], button:has-text("set window")',
      )
      .first();
    await expect(windowBtn24).toBeVisible();
    await windowBtn24.click();

    const input24 = page.locator('input[aria-label^="Context window for"]').first();
    await expect(input24).toBeVisible();

    const at24 = await input24.evaluate((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        fontSize: Number.parseFloat(style.fontSize),
        height: rect.height,
        scroll: el.scrollHeight,
        client: el.clientHeight,
      };
    });

    expect(at24.fontSize).toBeCloseTo(15, 1);
    expect(at24.height).toBeGreaterThanOrEqual(21);
    expect(at24.scroll).toBeLessThanOrEqual(at24.client);

    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  });

  test("SidebarSection row does not clip at 24px interface font size", async ({ page }) => {
    await page.goto("/#/");
    await applyTypography(page, { interfaceFontSize: 24 });

    const sectionRow = page.locator(".group\\/section").first();
    await expect(sectionRow).toBeVisible();

    const measurements = await sectionRow.evaluate((el) => {
      const button = el.querySelector("button");
      const buttonStyle = button ? getComputedStyle(button) : null;
      return {
        rowHeight: el.getBoundingClientRect().height,
        rowScrollHeight: el.scrollHeight,
        rowClientHeight: el.clientHeight,
        buttonFontSize: buttonStyle ? Number.parseFloat(buttonStyle.fontSize) : 0,
        buttonLineHeight: buttonStyle ? Number.parseFloat(buttonStyle.lineHeight) : 0,
      };
    });

    // At 24px, 24 * 0.8125 = 19.5px font-size.
    expect(measurements.buttonFontSize).toBeCloseTo(19.5, 1);
    expect(measurements.rowScrollHeight).toBeLessThanOrEqual(measurements.rowClientHeight);
    expect(measurements.rowHeight).toBeGreaterThanOrEqual(24);
  });
});

test.describe("structured tool payload follows the Code channel", () => {
  const STUB_PORT = process.env.TBAI_E2E_STUB_PORT ?? "3199";
  const STUB = `http://127.0.0.1:${STUB_PORT}`;
  const FINAL_ANSWER = "TBAI_TYPOGRAPHY_PAYLOAD_COMPLETE";

  async function createConversation(request: APIRequestContext): Promise<string> {
    const created = await request.post("/api/conversations", {
      data: {
        title: `typography payload ${Date.now()}`,
        workspaceMode: "simple",
        engine: "direct",
      },
    });
    expect(created.ok()).toBeTruthy();
    return ((await created.json()) as { id: string }).id;
  }

  async function sendMessage(page: Page, text: string): Promise<void> {
    const composer = page.locator("textarea").first();
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.fill(text);
    await composer.press("Enter");
  }

  test("the payload renders at --code-font-size and ignores Interface Font Size", async ({
    page,
    request,
  }) => {
    const conversationId = await createConversation(request);
    try {
      await page.goto(`/#/chat/${conversationId}`);
      await applyTypography(page, { interfaceFontSize: 16, codeFontSize: 13 });

      await request.post(`${STUB}/__e2e/text`, { data: { text: FINAL_ANSWER } });
      const armed = await request.post(`${STUB}/__e2e/tool`, {
        data: { toolName: "scheduler", args: { action: "list" } },
      });
      expect(armed.ok(), "arming the stub tool call failed").toBeTruthy();

      await sendMessage(page, "list the scheduled jobs for the typography probe");
      const payload = page.locator('[data-slot="code-payload"]').first();
      await expect(payload).toBeVisible({ timeout: 60_000 });

      const atDefault = await payload.evaluate((element) => {
        const style = getComputedStyle(element);
        return { size: Number.parseFloat(style.fontSize), family: style.fontFamily };
      });
      expect(atDefault.size).toBeCloseTo(13, 2);
      expect(atDefault.family).toContain("JetBrains Mono");

      // Interface 24 with Code still 13: the payload must not grow with the
      // interface setting. Reloading also re-renders it from history.
      await applyTypography(page, { interfaceFontSize: 24, codeFontSize: 13 });
      const afterResize = page.locator('[data-slot="code-payload"]').first();
      await expect(afterResize).toBeVisible({ timeout: 60_000 });
      const computed = await afterResize.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      );
      expect(computed).toBeCloseTo(13, 2);
    } finally {
      await request.post(`${STUB}/__e2e/tool/disarm`).catch(() => undefined);
      await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
    }
  });

  test("terminal exit line follows the Terminal channel while status pills remain compact metadata", async ({
    page,
    request,
  }) => {
    const conversationId = await createConversation(request);
    try {
      await page.goto(`/#/chat/${conversationId}`);
      // Fira Code + weight 500, deliberately NOT the fixed metadata stack, so
      // the exit line and the header pill can be told apart by computed style.
      await applyTypography(page, {
        interfaceFontSize: 16,
        terminalFontSize: 14,
        terminalFontFamily: "fira-code",
        terminalFontWeight: 500,
      });

      await request.post(`${STUB}/__e2e/text`, { data: { text: FINAL_ANSWER } });
      const armed = await request.post(`${STUB}/__e2e/tool`, {
        data: { toolName: "run_command", args: { command: "powershell -Command exit 7" } },
      });
      expect(armed.ok(), "arming the stub tool call failed").toBeTruthy();

      await sendMessage(page, "run a failing command for the typography probe");

      // Approve the command when the approval button appears
      const approveBtn = page.getByRole("button", { name: /^Approve\b/i }).first();
      await expect(approveBtn).toBeVisible({ timeout: 30_000 });
      await approveBtn.click();

      const terminalLine = page.locator('[data-slot="terminal-line"]').first();
      await expect(terminalLine).toBeVisible({ timeout: 60_000 });
      await expect(terminalLine).toHaveText(/^exit \d+/);

      const lineStyles = await terminalLine.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          size: Number.parseFloat(style.fontSize),
          family: style.fontFamily,
          weight: Number.parseFloat(style.fontWeight),
          visibility: style.visibility,
          display: style.display,
          opacity: Number.parseFloat(style.opacity),
          rects: element.getClientRects().length,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      });
      expect(lineStyles.size).toBeCloseTo(14, 2);
      expect(lineStyles.family).toContain("Fira Code");
      expect(lineStyles.weight).toBe(500);
      // Visible and not clipped: one laid-out box, no overflow in either axis.
      expect(lineStyles.rects).toBe(1);
      expect(lineStyles.scrollHeight).toBeLessThanOrEqual(lineStyles.clientHeight);
      expect(lineStyles.scrollWidth).toBeLessThanOrEqual(lineStyles.clientWidth);
      expect(lineStyles.visibility).not.toBe("hidden");
      expect(lineStyles.display).not.toBe("none");
      expect(lineStyles.opacity).toBeGreaterThan(0);

      // The header status pill is compact metadata on the FIXED monospace
      // stack (`--font-mono`), which no setting writes. Selecting it by its
      // exact text keeps the selector unambiguous.
      const terminalBlock = page.locator('[data-slot="terminal-block"]').first();
      await expect(terminalBlock).toBeVisible();
      const statusPill = terminalBlock.getByText("failed", { exact: true });
      await expect(statusPill).toBeVisible();
      const pillStyles = await statusPill.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          size: Number.parseFloat(style.fontSize),
          family: style.fontFamily,
          visibility: style.visibility,
          display: style.display,
        };
      });
      expect(pillStyles.family).toContain("JetBrains Mono");
      expect(pillStyles.family).not.toContain("Fira Code");
      // Compact metadata: text-2xs at the 16px interface size is 11px.
      expect(pillStyles.size).toBeCloseTo(11, 2);
      expect(pillStyles.visibility).not.toBe("hidden");
      expect(pillStyles.display).not.toBe("none");
    } finally {
      await request.post(`${STUB}/__e2e/tool/disarm`).catch(() => undefined);
      await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
    }
  });
});

test.describe("Lato weight parity", () => {
  test("registers every advertised weight for both probe texts", async ({ page }) => {
    await page.goto("/#/appearance");
    await applyTypography(page, { interfaceFontFamily: "lato" });

    const loaded = await page.evaluate(async () => {
      const weights = [100, 300, 400, 700, 900];
      const family = (face: FontFace) => face.family.replaceAll('"', "").trim();
      const probe = async (text: string) => {
        for (const weight of weights) {
          await document.fonts.load(`${weight} 16px "Lato"`, text);
        }
        await document.fonts.ready;
        return Array.from(document.fonts)
          .filter((face) => family(face) === "Lato" && face.status === "loaded")
          .map((face) => String(face.weight));
      };
      return { a: await probe("A"), z: await probe("Ž") };
    });

    expect(new Set(loaded.a)).toEqual(new Set(["100", "300", "400", "700", "900"]));
    expect(new Set(loaded.z)).toEqual(new Set(["100", "300", "400", "700", "900"]));
  });
});
