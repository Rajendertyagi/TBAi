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
 *  - a real Dockview split creates a separate spatial group (new group identity)
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
/** Emitted by the controlled provider only when complete() is called. */
const COMPLETION_MARKER = "hidden-run-completed";
const COMPOSER = { name: /Send a message/i } as const;

async function rmConv(request: APIRequestContext, id: string): Promise<void> {
  await request.delete(`/api/conversations/${id}`).catch(() => {});
}

/** Clear shared workspace membership so each test starts with no panels. */
async function clearSharedTabs(request: APIRequestContext): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const prefsRes = await request.get("/api/preferences");
    if (!prefsRes.ok()) return;
    const prefs = (await prefsRes.json()) as { revision: number };
    const res = await request.post("/api/preferences/tabs/close-batch", {
      data: { baseRevision: prefs.revision, mode: "all" },
    });
    if (res.status() === 409) continue;
    return;
  }
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
  // Shared tabs may already be open, so assert the target panel exists rather
  // than a fixed count.
  await expect(
    page.locator(`[data-testid="dockview-direct-panel"][data-conversation-id="${id}"]`),
  ).toBeVisible({ timeout: 15000 });
}

/**
 * Wait until the Chat Threads strip reflects every shared tab. Shared
 * membership arrives via the preferences snapshot (async), so asserting panel
 * counts before it lands reads a stale single-panel layout.
 */
async function waitForSharedTabs(page: Page, titles: string[]): Promise<void> {
  const strip = page.getByRole("tablist", { name: "Chat tabs" });
  for (const title of titles) {
    await expect(strip.locator(`[role="tab"][title="${title}"]`)).toBeVisible({
      timeout: 15000,
    });
  }
}

/** Click a conversation's row in the Chat Threads sidebar (a button, not a tab). */
async function openFromSidebar(page: Page, title: string): Promise<void> {
  await page
    .locator("#sidebar-section-chats")
    .getByRole("button", { name: title, exact: true })
    .click();
}

/** The Dockview tab for a conversation, matched by its exact title attribute. */
function dockviewTab(page: Page, title: string) {
  return page.locator(`[role="tab"][title="${title}"]`);
}

/**
 * The real Dockview tab for a conversation. Dockview tabs carry the canonical
 * panel id (`chat:<ref>`) in `data-tab-panel-id` and an `aria-label`, NOT a
 * `title` attribute — `dockviewTab()` above matches the dnd-kit Chat Threads
 * strip instead. Use this helper when the assertion is about Dockview itself.
 */
function realDockviewTab(page: Page, conversationId: string) {
  return page.locator(
    `[data-testid="dockview-workspace"] .dv-tab[data-tab-panel-id="chat:${conversationId}"]`,
  );
}

/** Tag each Dockview group element so group identity can be tracked across a DnD split. */
async function tagGroups(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll(".dv-groupview").forEach((group, index) => {
      group.setAttribute("data-e2e-group-tag", `g${index}`);
    });
  });
}

/** The tag of the Dockview group containing a conversation's tab, or null for a new group. */
async function groupTagFor(page: Page, conversationId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const tab = document.querySelector(`.dv-tab[data-tab-panel-id="chat:${id}"]`);
    return tab?.closest(".dv-groupview")?.getAttribute("data-e2e-group-tag") ?? null;
  }, conversationId);
}

/** Shared workspace membership from the API — the authoritative "not closed" signal. */
async function getSharedTabIds(request: APIRequestContext): Promise<string[]> {
  const res = await request.get("/api/preferences");
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { sharedTabs?: Array<{ ref: string }> };
  return (body.sharedTabs ?? []).map((tab) => tab.ref);
}

/** Concatenated persisted assistant text for a conversation, in stored order. */
async function persistedAssistantText(request: APIRequestContext, id: string): Promise<string> {
  const res = await request.get(`/api/conversations/${id}/messages`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as {
    messages?: Array<{
      content?: { role?: string; parts?: Array<{ type?: string; text?: string }> };
    }>;
  };
  return (body.messages ?? [])
    .filter((m) => m.content?.role === "assistant")
    .flatMap((m) =>
      (m.content?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? ""),
    )
    .join("");
}

test.describe("Dockview workspace (hermetic)", () => {
  let provider: ControlledProvider | undefined;
  const created: string[] = [];

  test.beforeEach(async ({ request }) => {
    await clearSharedTabs(request);
    provider = await startControlledProvider(request, {
      completionText: COMPLETION_MARKER,
    });
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

  test("a real Dockview split creates a separate group and preserves the panel runtime", async ({
    page,
    request,
  }) => {
    const a = await seedConversation(request, { title: `${MARKER}-split-a` });
    const b = await seedConversation(request, { title: `${MARKER}-split-b` });
    created.push(a.id, b.id);
    await addToSharedTabs(request, [a.id, b.id]);
    await openPanel(page, a.id);
    await waitForSharedTabs(page, [a.title, b.title]);
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(2, { timeout: 15000 });

    // Type a draft into A's composer so we can prove its runtime survives the split.
    await realDockviewTab(page, a.id).click();
    const aPanel = page.locator(
      `[data-testid="dockview-direct-panel"][data-conversation-id="${a.id}"]`,
    );
    const draft = "draft that must survive a real Dockview split";
    await aPanel.getByRole("textbox", COMPOSER).fill(draft);
    await expect(aPanel.getByRole("textbox", COMPOSER)).toHaveValue(draft);

    // Capture A's host identity and group membership before the split.
    const hostIdBefore = await aPanel
      .getByTestId("direct-chat-host")
      .getAttribute("data-thread-id");
    expect(hostIdBefore).toBe(a.id);
    await tagGroups(page);
    const aGroupBefore = await groupTagFor(page, a.id);
    const bGroupBefore = await groupTagFor(page, b.id);
    expect(aGroupBefore).not.toBeNull();
    expect(aGroupBefore).toBe(bGroupBefore); // both tabs in the one shared group
    await expect(page.locator(".dv-groupview")).toHaveCount(1);

    // Drive a REAL Dockview split. The tab element's own drop target only accepts
    // left/right (tab-group merge), so the drag must land on the group's
    // `.dv-content-container` near an edge: the default 20% activation band
    // resolves to a `left` split, creating a new group. Playwright's dragTo
    // cannot be used here because the active panel's `.dv-render-overlay`
    // covers the content container and intercepts pointer events; raw mouse
    // moves dispatch the drag at coordinates and let it bubble to the drop target.
    const aTab = realDockviewTab(page, a.id);
    const bContent = page.locator(".dv-content-container").last();
    const tabBox = await aTab.boundingBox();
    const contentBox = await bContent.boundingBox();
    if (!tabBox || !contentBox) throw new Error("Dockview tab/content box not found");
    const sx = tabBox.x + tabBox.width / 2;
    const sy = tabBox.y + tabBox.height / 2;
    const tx = contentBox.x + 6;
    const ty = contentBox.y + contentBox.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 10, sy + 10, { steps: 5 });
    await page.mouse.move(tx, ty, { steps: 20 });
    await page.mouse.up();

    // A separate spatial group now exists, and A moved into a NEW group while B
    // stayed in the original one — a changed group identity, not a tab merge.
    await expect(page.locator(".dv-groupview")).toHaveCount(2, { timeout: 15000 });
    const aGroupAfter = await groupTagFor(page, a.id);
    const bGroupAfter = await groupTagFor(page, b.id);
    expect(aGroupAfter).not.toBe(bGroupAfter);
    expect(aGroupAfter).not.toBe(aGroupBefore); // A's group identity changed
    expect(bGroupAfter).toBe(bGroupBefore); // B stayed in the original group

    // Both panels survive with unchanged identities; A's runtime and draft are intact.
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(2);
    await expect(aPanel.getByTestId("direct-chat-host")).toHaveAttribute(
      "data-thread-id",
      hostIdBefore as string,
    );
    await expect(aPanel.getByRole("textbox", COMPOSER)).toHaveValue(draft);

    // No close semantics were triggered: both conversations remain in shared membership.
    const shared = await getSharedTabIds(request);
    expect(shared).toContain(a.id);
    expect(shared).toContain(b.id);
    await waitForSharedTabs(page, [a.title, b.title]);
  });

  /**
   * The 2-arg form is required: Playwright 1.64.1 mis-parses the 3-arg
   * title/details/body form and skips every test in the file.
   */
  test("the two-group layout restores after a page reload", async ({ page, request }) => {
    const a = await seedConversation(request, { title: `${MARKER}-reload-a` });
    const b = await seedConversation(request, { title: `${MARKER}-reload-b` });
    created.push(a.id, b.id);
    await addToSharedTabs(request, [a.id, b.id]);
    await openPanel(page, a.id);
    await waitForSharedTabs(page, [a.title, b.title]);
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(2, { timeout: 15000 });

    const aTab = realDockviewTab(page, a.id);
    const bContent = page.locator(".dv-content-container").last();
    const tabBox = await aTab.boundingBox();
    const contentBox = await bContent.boundingBox();
    if (!tabBox || !contentBox) throw new Error("Dockview tab/content box not found");
    const sx = tabBox.x + tabBox.width / 2;
    const sy = tabBox.y + tabBox.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 10, sy + 10, { steps: 5 });
    await page.mouse.move(contentBox.x + 6, contentBox.y + contentBox.height / 2, {
      steps: 20,
    });
    await page.mouse.up();
    await expect(page.locator(".dv-groupview")).toHaveCount(2, { timeout: 15000 });

    // The layout write is debounced (250ms). Poll until the two-group layout is
    // actually in localStorage before reloading, or the reload reads stale data.
    await expect
      .poll(
        async () =>
          page.evaluate(
            ({ aId, bId }) => {
              const raw = localStorage.getItem("tbai:dockview-layout");
              if (!raw) return false;
              try {
                const rec = JSON.parse(raw);
                const root = rec?.layout?.grid?.root;
                return (
                  root?.type === "branch" &&
                  Array.isArray(root?.data) &&
                  root.data.length === 2 &&
                  raw.includes(aId) &&
                  raw.includes(bId)
                );
              } catch {
                return false;
              }
            },
            { aId: a.id, bId: b.id },
          ),
        { timeout: 5000, intervals: [100, 250, 500] },
      )
      .toBe(true);

    await page.reload();
    await expect(page.getByTestId("dockview-workspace")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(2, { timeout: 15000 });
    await expect(page.locator(".dv-groupview")).toHaveCount(2, { timeout: 15000 });
    const ids = await page
      .getByTestId("dockview-direct-panel")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-conversation-id")));
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
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
    await page.getByRole("button", { name: "Send message" }).first().click();
    await expect.poll(() => provider?.requestCount, { timeout: 30000 }).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 15000,
    });

    // Switch to B, hiding A's panel.
    await openFromSidebar(page, b.title);
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(2);

    // The marker is emitted by complete() only, so it cannot be in the store
    // while the run is still held — even though the pre-hide "working" frame
    // may already have been persisted.
    expect(await persistedAssistantText(request, a.id)).not.toContain(COMPLETION_MARKER);

    // Let the held run finish while A is hidden.
    provider?.complete();

    // Assert persistence WHILE A is still hidden: the hidden panel's run wrote
    // the completion text to the store without needing to be shown again.
    await expect
      .poll(() => persistedAssistantText(request, a.id), { timeout: 15000 })
      .toContain(COMPLETION_MARKER);

    // Return to A: the response completed, not aborted by the hide.
    await openFromSidebar(page, a.title);
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(2, { timeout: 15000 });
    await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
      timeout: 15000,
    });

    // The hidden run's text was APPENDED to A's rendered transcript too, not
    // merely finished in the background.
    const aPanel = page.locator(
      `[data-testid="dockview-direct-panel"][data-conversation-id="${a.id}"]`,
    );
    await expect(aPanel).toContainText(COMPLETION_MARKER, { timeout: 15000 });
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
    const a = await seedConversation(request, { title: `${MARKER}-layout-a` });
    const b = await seedConversation(request, { title: `${MARKER}-layout-b` });
    created.push(a.id, b.id);
    await addToSharedTabs(request, [a.id, b.id]);
    await openPanel(page, a.id);
    await waitForSharedTabs(page, [a.title, b.title]);
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(2, { timeout: 15000 });

    // Drive a real split so the persisted layout has a branch root with two groups.
    const aTab = realDockviewTab(page, a.id);
    const bContent = page.locator(".dv-content-container").last();
    const tabBox = await aTab.boundingBox();
    const contentBox = await bContent.boundingBox();
    if (!tabBox || !contentBox) throw new Error("Dockview tab/content box not found");
    const sx = tabBox.x + tabBox.width / 2;
    const sy = tabBox.y + tabBox.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 10, sy + 10, { steps: 5 });
    await page.mouse.move(contentBox.x + 6, contentBox.y + contentBox.height / 2, { steps: 20 });
    await page.mouse.up();
    await expect(page.locator(".dv-groupview")).toHaveCount(2, { timeout: 15000 });

    // The layout write is debounced (250ms). Poll until the two-group layout is
    // actually in localStorage before reloading, or the reload reads stale data.
    await expect
      .poll(
        async () =>
          page.evaluate(
            ({ aId, bId }) => {
              const raw = localStorage.getItem("tbai:dockview-layout");
              if (!raw) return false;
              try {
                const rec = JSON.parse(raw);
                const root = rec?.layout?.grid?.root;
                return (
                  root?.type === "branch" &&
                  Array.isArray(root?.data) &&
                  root.data.length === 2 &&
                  raw.includes(aId) &&
                  raw.includes(bId)
                );
              } catch {
                return false;
              }
            },
            { aId: a.id, bId: b.id },
          ),
        { timeout: 5000, intervals: [100, 250, 500] },
      )
      .toBe(true);

    // Reload: the saved two-group layout restores both panels and both groups.
    await page.reload();
    await expect(page.getByTestId("dockview-workspace")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(2, { timeout: 15000 });
    await expect(page.locator(".dv-groupview")).toHaveCount(2, { timeout: 15000 });
    const ids = await page
      .getByTestId("dockview-direct-panel")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-conversation-id")));
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);

    // Corrupt the saved layout; the app must fall back without crashing.
    await page.evaluate(() => localStorage.setItem("tbai:dockview-layout", "{not json"));
    await page.reload();
    await expect(page.getByTestId("dockview-workspace")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("dockview-direct-panel")).toHaveCount(2, { timeout: 15000 });
  });
});
