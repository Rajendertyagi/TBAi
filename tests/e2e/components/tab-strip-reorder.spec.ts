import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Tab-strip REORDER, in a real browser with real pointer input.
 *
 * ## Why this file exists
 *
 * `useChatTabsStore.reorder` is covered by unit tests, but they call the action
 * directly — they prove what the STORE does with indices, never that a drag
 * produces the right pair. The seam between "the user drags a tab" and
 * "`reorder(from, to)` is called exactly once with the right indices" had NO
 * coverage at all, and it is the only thing a change of drag library can break
 * while every other test in the repository stays green.
 *
 * That matters more than it looks, because `reorder` is POSITIONAL: the same
 * (from, to) pair applied twice moves a DIFFERENT tab and corrupts the order
 * (pinned in `tests/unit/web/chat/chatTabs.reorder.test.ts`). So the drop must
 * report exactly once, and the drop that moved nothing must report not at all.
 *
 * ## What is asserted
 *
 *   1. a pointer drag past a neighbour produces the expected new order
 *   2. a drag that ends where it started changes nothing at all
 *   3. a drag does not ACTIVATE the tab it moved (a reorder is not a click)
 *   4. Space picks a focused tab up, ArrowLeft moves it, Space drops it
 *
 * Test 3 is the one most likely to regress silently: the legacy library
 * suppressed the click that follows a drag with a capture-phase listener, so a
 * reorder never navigated. If a future drag layer loses that, dragging a tab
 * would open it — a visible behaviour change that no unit test can see.
 *
 * Test 4 is keyboard drag, which does not exist before the `@dnd-kit/react`
 * migration: it fails on the pre-migration tree BY DESIGN (there is no keyboard
 * sensor, so Space only activates). It is the guard for the capability the
 * migration adds.
 *
 * DOM order is read from the tabs' `title` attribute, which is the resolved
 * conversation title, not from a screenshot.
 *
 * ## Shared workspace membership (2026-11-09)
 *
 * Tabs are server-authoritative shared membership. Tests add conversations to
 * shared membership via the preferences API (CAS) so they appear in the strip,
 * then navigate to establish local presentation. This preserves the reorder
 * behavior under test while matching the current architecture.
 */

/** The strip's own accessible name; every locator below is scoped to it. */
function strip(page: Page) {
  return page.getByRole("tablist", { name: "Chat tabs" });
}

/** Tab labels in strip order, from the `title` attribute each tab renders. */
async function stripOrder(page: Page): Promise<string[]> {
  return strip(page)
    .getByRole("tab")
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("title") ?? ""));
}

/** The label of the single tab that is currently selected. */
async function activeTabLabel(page: Page): Promise<string | null> {
  return strip(page)
    .locator('[role="tab"][aria-selected="true"]')
    .evaluate((element) => element.getAttribute("title") ?? null);
}

/** The conversation's default title, as `tabStripConfig.copy.newChat` renders it. */
const DRAFT_LABEL = "New chat";

async function createConversation(request: APIRequestContext, marker: string): Promise<string> {
  const res = await request.post("/api/conversations", {
    data: { title: marker, workspaceMode: "simple" },
  });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function deleteConversation(request: APIRequestContext, id: string): Promise<void> {
  await request.delete(`/api/conversations/${id}`).catch(() => {});
}

/** Add conversations to shared workspace membership in order (CAS). */
async function addToSharedTabs(request: APIRequestContext, ids: string[]): Promise<void> {
  for (const id of ids) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const prefsRes = await request.get("/api/preferences");
      expect(prefsRes.ok()).toBe(true);
      const prefs = (await prefsRes.json()) as { revision: number };
      const res = await request.post("/api/preferences/tabs/open", {
        data: { baseRevision: prefs.revision, conversationId: id, kind: "chat" },
      });
      if (res.status() === 409) continue;
      expect(res.ok()).toBe(true);
      break;
    }
  }
}

async function waitDraftReady(page: Page): Promise<void> {
  await page
    .getByRole("heading", { name: /what do you want to build/i })
    .first()
    .waitFor({ timeout: 30000 });
  await expect(page.getByRole("group", { name: "Engine" })).toBeVisible({ timeout: 10000 });
}

/** Navigate to a conversation and wait for its tab to appear with its title resolved. */
async function openTab(page: Page, id: string, label: string): Promise<void> {
  await page.goto(`/#/chat/${id}`);
  await expect(page.getByRole("textbox", { name: /Send a message/ })).toHaveCount(1, {
    timeout: 15000,
  });
  await expect(strip(page).getByRole("tab", { name: new RegExp(label) })).toBeVisible({
    timeout: 15000,
  });
}

function tab(page: Page, label: string) {
  return strip(page).getByRole("tab", { name: new RegExp(label) });
}

/**
 * A real pointer drag between two tabs.
 *
 * dnd-kit listens to POINTER events, so `locator.dragTo()` (which dispatches
 * HTML5 drag events) would move nothing. The path is deliberately stepped:
 * a single jump would not clear the sensor's activation distance, and dnd-kit
 * decides the drop target from the pointer's position over the strip.
 *
 * `overshootPx` moves past the start point first, so a "drag that ends back
 * where it began" is still a real drag rather than a click.
 */
async function dragTab(page: Page, fromLabel: string, toLabel: string): Promise<void> {
  const from = await tab(page, fromLabel).boundingBox();
  const to = await tab(page, toLabel).boundingBox();
  if (!from || !to) throw new Error(`tab not laid out: ${fromLabel} -> ${toLabel}`);

  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  const endX = to.x + to.width / 2;
  const endY = to.y + to.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Clear the activation distance, then travel to the target in steps so the
  // collision detector sees the pointer cross the neighbour.
  await page.mouse.move(startX + 18, startY, { steps: 4 });
  await page.mouse.move(endX, endY, { steps: 12 });
  await page.mouse.up();
}

test("a pointer drag moves a tab to the drop position and changes nothing else", async ({
  page,
}) => {
  const a = await createConversation(page.request, "e2e-drag-a");
  const b = await createConversation(page.request, "e2e-drag-b");
  const c = await createConversation(page.request, "e2e-drag-c");
  try {
    await addToSharedTabs(page.request, [a, b, c]);
    // Establish local draft tab, then open shared tabs.
    await page.goto("/#/chat/new");
    await waitDraftReady(page);
    await openTab(page, a, "e2e-drag-a");
    await openTab(page, b, "e2e-drag-b");
    await openTab(page, c, "e2e-drag-c");

    const before = await stripOrder(page);
    expect(before[0], "the draft tab anchors the strip").toBe(DRAFT_LABEL);
    expect(before).toEqual([DRAFT_LABEL, "e2e-drag-a", "e2e-drag-b", "e2e-drag-c"]);

    // Drag the LAST tab onto the FIRST conversation tab.
    await dragTab(page, "e2e-drag-c", "e2e-drag-a");

    // Reorder is server-authoritative (async CAS); wait for the UI to reflect it.
    await expect
      .poll(async () => stripOrder(page), { timeout: 10000 })
      .toEqual([DRAFT_LABEL, "e2e-drag-c", "e2e-drag-a", "e2e-drag-b"]);
  } finally {
    for (const id of [a, b, c]) await deleteConversation(page.request, id);
  }
});

test("a drag that ends where it started leaves the order untouched", async ({ page }) => {
  const a = await createConversation(page.request, "e2e-noop-a");
  const b = await createConversation(page.request, "e2e-noop-b");
  try {
    await addToSharedTabs(page.request, [a, b]);
    await page.goto("/#/chat/new");
    await waitDraftReady(page);
    await openTab(page, a, "e2e-noop-a");
    await openTab(page, b, "e2e-noop-b");

    const before = await stripOrder(page);
    expect(before).toEqual([DRAFT_LABEL, "e2e-noop-a", "e2e-noop-b"]);

    // A real drag that travels away and returns to its own slot.
    const box = await tab(page, "e2e-noop-b").boundingBox();
    if (!box) throw new Error("tab not laid out");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 18, y, { steps: 4 });
    await page.mouse.move(x, y, { steps: 6 });
    await page.mouse.up();

    expect(await stripOrder(page)).toEqual(before);
  } finally {
    for (const id of [a, b]) await deleteConversation(page.request, id);
  }
});

test("dragging a tab does not activate it", async ({ page }) => {
  const a = await createConversation(page.request, "e2e-click-a");
  const b = await createConversation(page.request, "e2e-click-b");
  try {
    await addToSharedTabs(page.request, [a, b]);
    await page.goto("/#/chat/new");
    await waitDraftReady(page);
    await openTab(page, a, "e2e-click-a");
    await openTab(page, b, "e2e-click-b");

    // Make A the active tab by CLICKING it, which is a legitimate activation.
    await tab(page, "e2e-click-a").click();
    await expect(page).toHaveURL(new RegExp(`#/chat/${a}$`), { timeout: 10000 });
    expect(await activeTabLabel(page)).toBe("e2e-click-a");

    const before = await stripOrder(page);
    // Now drag B, which is NOT the active tab. A reorder must not navigate.
    await dragTab(page, "e2e-click-b", "e2e-click-a");

    await expect
      .poll(async () => stripOrder(page), { timeout: 10000 })
      .toEqual([DRAFT_LABEL, "e2e-click-b", "e2e-click-a"]);
    expect(await stripOrder(page)).not.toEqual(before);
    await expect(page).toHaveURL(new RegExp(`#/chat/${a}$`), { timeout: 10000 });
    expect(await activeTabLabel(page), "a drag must not activate the dragged tab").toBe(
      "e2e-click-a",
    );
  } finally {
    for (const id of [a, b]) await deleteConversation(page.request, id);
  }
});

test("Space picks a tab up, ArrowLeft moves it, Space drops it", async ({ page }) => {
  const a = await createConversation(page.request, "e2e-keys-a");
  const b = await createConversation(page.request, "e2e-keys-b");
  try {
    await addToSharedTabs(page.request, [a, b]);
    await page.goto("/#/chat/new");
    await waitDraftReady(page);
    await openTab(page, a, "e2e-keys-a");
    await openTab(page, b, "e2e-keys-b");

    // Clicking focuses the tab as well as activating it; the keyboard sensor
    // requires focus on the draggable element.
    await tab(page, "e2e-keys-b").click();
    expect(await stripOrder(page)).toEqual([DRAFT_LABEL, "e2e-keys-a", "e2e-keys-b"]);

    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Space");

    // One press of ArrowLeft moves it exactly one slot, whatever the tab width.
    await expect
      .poll(async () => stripOrder(page), { timeout: 10000 })
      .toEqual([DRAFT_LABEL, "e2e-keys-b", "e2e-keys-a"]);
  } finally {
    for (const id of [a, b]) await deleteConversation(page.request, id);
  }
});
