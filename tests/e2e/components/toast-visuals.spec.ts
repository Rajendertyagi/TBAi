import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * The toast surface contract.
 *
 * Sonner's own stylesheet decided this twice, in opposite directions. 1.7.4 wraps
 * every rule in `:where()` (62 occurrences measured in `dist/styles.css`), so it
 * sits at zero specificity and `globals.css` won on selector strength alone.
 * 2.0.8 has no `:where()` at all and instead ships `[data-sonner-toast][data-styled='true']`
 * at (0,2,0) — the same weight as the app's `[data-sonner-toaster] [data-sonner-toast]`
 * — while injecting its stylesheet from JavaScript at import time, i.e. after the
 * built app CSS. Source order therefore hands the tie to sonner and every app
 * override silently reverts: sonner's opaque `--normal-bg`, its grey border, no
 * backdrop blur, its default shadow, and 8px radius.
 *
 * No test asserted any of that, which is why it could have shipped broken. So this
 * reads the rendered toast back as computed styles and compares each property with
 * a probe element carrying the same declaration. The probe is deliberate: the
 * assertion is "the toast looks like the app's glass surface", not "the toast
 * matches this exact rgb() literal", so it holds across themes and token changes
 * while still failing if the override stops applying.
 *
 * The toast is produced through the real Quick Messages flow, not a test-only
 * route: the E2E suite serves a production build, so the dev-only labs are absent.
 */

type Surface = {
  backgroundColor: string;
  borderColor: string;
  backdropFilter: string;
  boxShadow: string;
  borderRadius: string;
};

const TOAST = "[data-sonner-toast]";

const GLASS_BACKGROUND = "color-mix(in srgb, var(--popover) var(--glass-tint), transparent)";
const GLASS_BACKDROP = "blur(var(--glass-blur)) saturate(var(--glass-saturation))";

/** Ids present before the test, so cleanup removes only what this spec created. */
async function quickMessageIds(request: APIRequestContext): Promise<Set<string>> {
  const res = await request.get("/api/quick-messages");
  expect(res.ok()).toBe(true);
  const items = (await res.json()) as Array<{ id: string }>;
  return new Set(items.map((item) => item.id));
}

async function removeCreated(request: APIRequestContext, before: Set<string>): Promise<void> {
  const res = await request.get("/api/quick-messages");
  if (!res.ok()) return;
  const items = (await res.json()) as Array<{ id: string }>;
  for (const item of items) {
    if (!before.has(item.id)) {
      await request.delete(`/api/quick-messages/${item.id}`);
    }
  }
}

/** Opens Quick Messages and creates a row, which raises sonner's success toast. */
async function createToast(page: Page): Promise<void> {
  await page.goto("/#/quick-messages");
  await expect(page.getByRole("heading", { name: "Quick Messages", level: 2 })).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(TOAST).first()).toBeVisible({ timeout: 15000 });
}

/**
 * Reads the toast's computed surface and builds the expected surface from probe
 * elements in the same page, so both sides resolve the same theme tokens.
 */
async function readSurface(
  page: Page,
  reducedTransparency: boolean,
): Promise<{ actual: Surface; expected: Surface; mediaMatches: boolean }> {
  return page.evaluate(
    ({ reduced, glassBackground, glassBackdrop }) => {
      const toast = document.querySelector("[data-sonner-toast]");
      if (!toast) throw new Error("toast element not found");

      const probe = (property: string, value: string): string => {
        const element = document.createElement("div");
        element.style.setProperty(property, value);
        document.body.appendChild(element);
        const computed = getComputedStyle(element).getPropertyValue(property);
        element.remove();
        return computed;
      };

      const expected = {
        backgroundColor: probe("background-color", reduced ? "var(--popover)" : glassBackground),
        borderColor: probe("border-color", "transparent"),
        backdropFilter: reduced
          ? probe("backdrop-filter", "none")
          : probe("backdrop-filter", glassBackdrop),
        boxShadow: probe("box-shadow", "var(--elevation-floating)"),
        borderRadius: probe("border-radius", "calc(var(--radius) * 1.2)"),
      } satisfies Surface;

      const computed = getComputedStyle(toast);
      const actual = {
        backgroundColor: computed.backgroundColor,
        borderColor: computed.borderColor,
        backdropFilter: computed.backdropFilter,
        boxShadow: computed.boxShadow,
        borderRadius: computed.borderRadius,
      } satisfies Surface;

      return {
        actual,
        expected,
        mediaMatches: matchMedia("(prefers-reduced-transparency: reduce)").matches,
      };
    },
    {
      reduced: reducedTransparency,
      glassBackground: GLASS_BACKGROUND,
      glassBackdrop: GLASS_BACKDROP,
    },
  );
}

test("toast surface: the app's glass skin survives the sonner stylesheet", async ({
  page,
  request,
}) => {
  const before = await quickMessageIds(request);
  try {
    await createToast(page);
    const { actual, expected } = await readSurface(page, false);
    expect(actual).toEqual(expected);
  } finally {
    await removeCreated(request, before);
  }
});

test("toast surface: reduced transparency flattens it instead of leaving blur without translucency", async ({
  page,
  context,
  request,
}) => {
  const before = await quickMessageIds(request);
  try {
    await createToast(page);
    // Playwright 1.64 has no `reducedTransparency` in `emulateMedia`, so drive the
    // media feature through CDP. The assertion below proves the emulation landed
    // rather than trusting it: if `matchMedia` stays false, this test fails and
    // says the branch was never exercised.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });

    const { actual, expected, mediaMatches } = await readSurface(page, true);
    expect(mediaMatches).toBe(true);
    expect(actual).toEqual(expected);
  } finally {
    await removeCreated(request, before);
  }
});
