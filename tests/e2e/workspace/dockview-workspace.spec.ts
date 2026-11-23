import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { seedConversation } from "../helpers/seedConversation.ts";
import { startControlledProvider, type ControlledProvider } from "../helpers/controlledProvider.ts";

/**
 * Dockview production workspace — real-browser acceptance for the critical
 * scenarios that do NOT need a live model or a managed OpenCode server.
 *
 * These specs run against the hermetic E2E server (its own DB, no credentials).
 * A ControlledProvider is registered through the app's own API so a run can be
 * genuinely in flight while a panel is hidden — no transport is faked.
 *
 * Scenarios covered here (plan §6):
 *  - two real Direct chats open as independent panels with distinct identities
 *  - a panel move does not close the conversation or dispose its host
 *  - composer text survives a real Dockview panel move
 *  - an active response continues while its panel is hidden
 *  - chat -> settings -> chat keeps the workspace mounted and the host alive
 *  - deep link /chat/:id opens and focuses the correct panel
 *  - layout save/restore across reload; corrupt layout falls back safely
 *
 * Scenarios that need real credentials / a managed OpenCode server remain in
 * the opt-in `*-live.spec.ts` suite (OpenCode lifecycle, concurrent mixed-engine
 * sends with distinct reply markers). They are NOT asserted here.
 */

const MARKER = "dockview-e2e";
const COMPOSER = { name: /Send a message/i } as const;

async function rmConv(request: APIRequestContext, id: string): Promise<void> {
  await request.delete(`/api/conversations/${id}`).catch(() => {});
}

/**
 * Add conversations to shared workspace membership (CAS). A conversation only
 * becomes a Dockview panel when it is in `sharedTabs` — clicking a sidebar row
 * navigates but does not open a panel. This mirrors the proven helper in
 * tab-strip-reorder.spec.ts.
 */
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

/** Open a seeded conversation as a Dockview panel via its deep link. */
async function openPanel(page: Page, id: string): Promise<void> {
  await page.goto(`/#/chat/${id}`);
  await expect(page.getByTestId("dockview-workspace")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(1, { timeout: 15000 });
}

/**
 * Wait until the Chat Threads strip reflects every shared tab. Shared
 * membership arrives via the preferences snapshot (async), so asserting panel
 * counts before it lands reads a stale single-panel layout.
 */
async function waitForSharedTabs(page: Page, titles: string[]): Promise<void> {
  const strip = page.getByRole("tablist", { name: "Chat tabs" });
  for (const title of titles) {
    await expect(strip.getByRole("tab", { name: new RegExp(title, "i") })).toBeVisible({
      timeout: 15000,
    });
  }
}

/** Click a conversation's row in the Chat Threads sidebar (a button, not a tab). */
async function openFromSidebar(page: Page, title: string): Promise<void> {
  await page
    .locator("#sidebar-section-chats")
    .getByRole("button", { name: new RegExp(title, "i") })
    .click();
}

/** The Dockview tab for a conversation, scoped to the workspace tab list. */
function dockviewTab(page: Page, title: string) {
  return page.getByRole("tab", { name: new RegExp(title, "i") });
}

test.describe("Dockview workspace (hermetic)", () => {
  let provider: ControlledProvider | undefined;
  const created: string[] = [];

  test.beforeEach(async ({ request }) => {
    provider = await startControlledProvider(request);
  });

  test.afterEach(async ({ request }) => {
    provider?.complete();
    provider?.stop();
    provider = undefined;
    for (const id of created.splice(0)) await rmConv(request, id);
  });

  test("two Direct chats open as independent panels with distinct identities", async ({
    page,
    request,
  }) => {
    const a = await seedConversation(request, { title: `${MARKER}-a` });
    const b = await seedConversation(request, { title: `${MARKER}-b` });
    created.push(a.id, b.id);
    await addToSharedTabs(request, [a.id, b.id]);

    await openPanel(page, a.id);
    await waitForSharedTabs(page, [a.title, b.title]);
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(2, { timeout: 15000 });

    const ids = await page
      .getByTestId("dockview-direct-panel")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-conversation-id")));
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  test("a panel move does not close the conversation or dispose its host", async ({
    page,
    request,
  }) => {
    const a = await seedConversation(request, { title: `${MARKER}-move-a` });
    const b = await seedConversation(request, { title: `${MARKER}-move-b` });
    created.push(a.id, b.id);
    await addToSharedTabs(request, [a.id, b.id]);

    await openPanel(page, a.id);
    await waitForSharedTabs(page, [a.title, b.title]);
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(2);

    // Capture both host identities, then drag panel A's tab onto panel B's tab
    // (Dockview's own DnD). Both hosts must survive with the same identities.
    const before = await page
      .getByTestId("direct-chat-host")
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.threadId).sort());
    await dockviewTab(page, a.title).dragTo(dockviewTab(page, b.title));

    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(2, { timeout: 15000 });
    const after = await page
      .getByTestId("direct-chat-host")
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.threadId).sort());
    expect(after).toEqual(before);
    expect(after).toContain(a.id);
    expect(after).toContain(b.id);
  });

  test("composer text survives a real Dockview panel move", async ({ page, request }) => {
    const a = await seedConversation(request, { title: `${MARKER}-composer` });
    const b = await seedConversation(request, { title: `${MARKER}-composer-other` });
    created.push(a.id, b.id);
    await addToSharedTabs(request, [a.id, b.id]);
    await openPanel(page, a.id);
    await waitForSharedTabs(page, [a.title, b.title]);
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(2);

    // Focus A's panel and type a draft.
    await dockviewTab(page, a.title).click();
    const composer = page.getByRole("textbox", COMPOSER).first();
    await composer.fill("draft text that must survive a move");
    await expect(composer).toHaveValue("draft text that must survive a move");

    // Move A's tab onto B's tab — a real Dockview relocation.
    await dockviewTab(page, a.title).dragTo(dockviewTab(page, b.title));
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(2, { timeout: 15000 });

    // The composer value is runtime-owned and must survive the move.
    await expect(page.getByRole("textbox", COMPOSER).first()).toHaveValue(
      "draft text that must survive a move",
    );
  });

  test("an active response continues while its panel is hidden", async ({ page, request }) => {
    const a = await seedConversation(request, { title: `${MARKER}-hidden` });
    const b = await seedConversation(request, { title: `${MARKER}-hidden-other` });
    created.push(a.id, b.id);
    await addToSharedTabs(request, [a.id, b.id]);
    await openPanel(page, a.id);
    await waitForSharedTabs(page, [a.title, b.title]);

    // Start a held run on conversation A.
    await page.getByRole("textbox", COMPOSER).first().fill("stream me");
    await page.locator('button[type="submit"]').first().click();
    await expect.poll(() => provider?.requestCount, { timeout: 30000 }).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 15000,
    });

    // Switch to B, hiding A's panel.
    await openFromSidebar(page, b.title);
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(2);

    // Let the held run finish while A is hidden.
    provider?.complete();

    // Return to A: the response completed, not aborted by the hide.
    await openFromSidebar(page, a.title);
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(2, { timeout: 15000 });
    await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
      timeout: 15000,
    });
  });

  test("chat -> settings -> chat keeps the workspace mounted and the host alive", async ({
    page,
    request,
  }) => {
    const a = await seedConversation(request, { title: `${MARKER}-persist` });
    created.push(a.id);
    await openPanel(page, a.id);

    const hostBefore = await page
      .getByTestId("direct-chat-host")
      .first()
      .evaluate((el) => (el as HTMLElement).dataset.threadId);

    await page.goto("/#/scheduler");
    await expect(page.getByTestId("workspace-surface")).toHaveCount(1); // still mounted
    await page.goto(`/#/chat/${a.id}`);
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(1, { timeout: 15000 });

    const hostAfter = await page
      .getByTestId("direct-chat-host")
      .first()
      .evaluate((el) => (el as HTMLElement).dataset.threadId);
    expect(hostAfter).toBe(hostBefore);
  });

  test("deep link /chat/:id opens and focuses the correct panel", async ({ page, request }) => {
    const a = await seedConversation(request, { title: `${MARKER}-deep` });
    created.push(a.id);
    await openPanel(page, a.id);
    await expect(page).toHaveURL(new RegExp(`#/chat/${a.id}`));
    await expect(page.getByTestId("dockview-direct-panel")).toHaveAttribute(
      "data-conversation-id",
      a.id,
    );
  });

  test("layout save/restore across reload and corrupt-layout fallback", async ({
    page,
    request,
  }) => {
    const a = await seedConversation(request, { title: `${MARKER}-layout` });
    created.push(a.id);
    await openPanel(page, a.id);

    // Reload: the saved layout restores the panel.
    await page.reload();
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(1, { timeout: 15000 });

    // Corrupt the saved layout; the app must fall back without crashing.
    await page.evaluate(() => localStorage.setItem("tbai:dockview-layout", "{not json"));
    await page.reload();
    await expect(page.getByTestId("dockview-workspace")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(1, { timeout: 15000 });
  });
});
