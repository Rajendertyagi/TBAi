import { expect, test } from "@playwright/test";

/**
 * The radix custom-property contract behind two of the app's own Tailwind classes.
 *
 * `components/ui/tooltip.tsx` and `components/ui/select.tsx` read properties that
 * radix publishes at runtime and that nothing else in this repository covers. The
 * compiled CSS rules are:
 *
 *   tooltip: transform-origin: var(--radix-tooltip-content-transform-origin)
 *   select:  max-height:       var(--radix-select-content-available-height)
 *            transform-origin: var(--radix-select-content-transform-origin)
 *            min-width:        var(--radix-select-trigger-width)   (popper mode only)
 *
 * A rename inside radix leaves every other gate green — no test asserts `data-radix-*`,
 * a computed custom property, or popup geometry — while a tooltip animates from the
 * wrong point or a popup stops being bounded. So these tests read the values back as
 * computed styles. If a property is published, its name is right; if it is not, the
 * declaration is invalid at computed-value time and the computed value falls back to
 * the property's initial value, which has no `px` in it.
 *
 * Recorded rather than "fixed": the select wrapper supports both of radix's
 * positioning modes, and `min-width` / `transform-origin` are popper-only. No call
 * site passes `position="popper"`, so every select in the app is item-aligned: radix
 * bounds the list with inline px on the content wrapper and the wrapper turns the
 * animation off (see `data-[align-trigger=true]:animate-none` in `select.tsx`). That
 * branch is byte-for-byte identical in radix-ui 1.6.7 and 1.8.1 — both were read on
 * disk — which is why the popup test below asserts the behaviour (bounded, inside the
 * viewport, aligned to the trigger) and accepts either mechanism for it.
 */

const TOOLTIP_ORIGIN_VAR = "--radix-tooltip-content-transform-origin";
const SELECT_HEIGHT_VAR = "--radix-select-content-available-height";

test("tooltip: the origin property resolves, and the popup is centred just above its trigger", async ({
  page,
}) => {
  await page.goto("/#/chat/new");
  await expect(page.getByRole("heading", { name: /what do you want to build/i })).toBeVisible({
    timeout: 15000,
  });

  // The composer's attach button is a TooltipIconButton with side="top".
  const trigger = page.getByRole("button", { name: "Attach" });
  await expect(trigger).toBeVisible();
  await trigger.hover();

  const content = page.locator('[data-slot="tooltip-content"]');
  await expect(content).toHaveCount(1);
  await expect(content).toBeVisible({ timeout: 5000 });

  const probe = await content.evaluate((el, varName) => {
    const cs = getComputedStyle(el);
    return {
      published: cs.getPropertyValue(varName).trim(),
      transformOrigin: cs.transformOrigin,
    };
  }, TOOLTIP_ORIGIN_VAR);
  console.log(`TOOLTIP_PROBE:${JSON.stringify(probe)}`);

  expect(
    probe.published,
    `${TOOLTIP_ORIGIN_VAR} must be published on the tooltip content by radix`,
  ).not.toBe("");
  // floating-ui writes the origin as px; the initial value (what an unresolved
  // var() falls back to) is a percentage pair.
  expect(probe.transformOrigin).toContain("px");

  // `toBeVisible()` ignores opacity, so a popup whose enter animation never
  // finishes would occupy a box, pass every geometry assertion, and paint nothing.
  await expect
    .poll(async () => Number(await content.evaluate((el) => getComputedStyle(el).opacity)), {
      timeout: 5000,
    })
    .toBeGreaterThan(0);

  const triggerBox = await trigger.boundingBox();
  const contentBox = await content.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  const centreDelta = Math.abs(
    contentBox!.x + contentBox!.width / 2 - (triggerBox!.x + triggerBox!.width / 2),
  );
  expect(centreDelta, "tooltip should be centred on its trigger").toBeLessThanOrEqual(8);
  const gap = triggerBox!.y - (contentBox!.y + contentBox!.height);
  expect(gap, "tooltip should sit just above its trigger").toBeGreaterThanOrEqual(-2);
  expect(gap, "tooltip should sit just above its trigger").toBeLessThanOrEqual(12);
});

test("select: the popup is bounded, stays in the viewport, aligns its chosen item to the trigger, and closes on Escape", async ({
  page,
}) => {
  await page.goto("/#/providers");
  const trigger = page.getByRole("combobox", { name: "Filter providers by type" });
  await expect(trigger).toBeVisible({ timeout: 15000 });
  const triggerBox = await trigger.boundingBox();
  const viewport = page.viewportSize();
  expect(triggerBox).not.toBeNull();
  expect(viewport).not.toBeNull();

  await trigger.click();
  const content = page.locator('[data-slot="select-content"]');
  await expect(content).toBeVisible({ timeout: 5000 });

  const contentBox = await content.boundingBox();
  expect(contentBox).not.toBeNull();
  expect(contentBox!.y).toBeGreaterThanOrEqual(-1);
  expect(contentBox!.y + contentBox!.height).toBeLessThanOrEqual(viewport!.height + 1);

  const probe = await content.evaluate((el, varName) => {
    const cs = getComputedStyle(el);
    const wrapper = el.parentElement;
    const wrapperCs = wrapper ? getComputedStyle(wrapper) : null;
    return {
      published: cs.getPropertyValue(varName).trim(),
      maxHeight: cs.maxHeight,
      wrapperMaxHeight: wrapperCs ? wrapperCs.maxHeight : null,
      opacity: cs.opacity,
      // select.tsx sets this from `position === "item-aligned"`.
      alignTrigger: el.getAttribute("data-align-trigger"),
    };
  }, SELECT_HEIGHT_VAR);
  console.log(`SELECT_PROBE:${JSON.stringify(probe)}`);

  expect(probe.alignTrigger).toBe("true");
  // `toBeVisible()` ignores opacity, so a popup whose enter animation never
  // finishes would occupy a box, pass every geometry assertion, and paint nothing.
  // A live browser panel did report `opacity: 0` here while the popup was painted,
  // so this is measured rather than assumed.
  await expect
    .poll(async () => Number(await content.evaluate((el) => getComputedStyle(el).opacity)), {
      timeout: 5000,
    })
    .toBeGreaterThan(0);
  // Either radix publishes the available height (popper mode) or it clamps the
  // content wrapper with inline px (item-aligned mode, what the app uses today).
  // If both vanished the popup would grow without limit.
  const bounded = probe.maxHeight.endsWith("px") || (probe.wrapperMaxHeight ?? "").endsWith("px");
  expect(bounded, "the open popup must be height-bounded by one of radix's two mechanisms").toBe(
    true,
  );

  // item-aligned mode puts the chosen row on the trigger's centre line.
  const checked = content.locator('[role="option"][data-state="checked"]');
  const option =
    (await checked.count()) > 0 ? checked.first() : content.locator('[role="option"]').first();
  const optionBox = await option.boundingBox();
  expect(optionBox).not.toBeNull();
  const optionCentre = optionBox!.y + optionBox!.height / 2;
  const triggerCentre = triggerBox!.y + triggerBox!.height / 2;
  expect(
    Math.abs(optionCentre - triggerCentre),
    "the aligned item should sit on the trigger's centre line",
  ).toBeLessThanOrEqual(3);

  const overlap =
    Math.min(contentBox!.x + contentBox!.width, triggerBox!.x + triggerBox!.width) -
    Math.max(contentBox!.x, triggerBox!.x);
  expect(overlap / Math.min(contentBox!.width, triggerBox!.width)).toBeGreaterThanOrEqual(0.5);

  await page.keyboard.press("Escape");
  await expect(content).toBeHidden();
});
