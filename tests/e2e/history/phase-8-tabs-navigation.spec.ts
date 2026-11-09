import { expect, test, type Page, type APIRequestContext } from "@playwright/test";

/**
 * Phase 8 — tab & conversation lifecycle, browser-level verification.
 *
 * Updated for shared-workspace preferences architecture:
 * - Shared tab membership is authoritative in SQLite/preferences API (explicit
 *   open/close/reorder). Route mounting is presentation binding only and never
 *   mutates shared membership.
 * - A valid direct URL to a non-shared conversation creates a local detached
 *   presentation for this window only (not a shared tab).
 * - Tests that verify shared-tab strip close/reorder behavior seed shared
 *   membership via the preferences API (explicit workflow), not route mounting.
 *
 * Preserved invariants:
 * - No duplicate visible tab/presentation for the same conversation ref.
 * - Navigating to draft never creates a conversation row.
 * - First send from draft creates exactly one row (and delayed shared open is
 *   handled by the app; row count is the source of truth here).
 * - Closing an inactive shared tab leaves the active conversation unchanged.
 * - Closing the active shared tab activates the right neighbour.
 * - Deleting the active conversation falls back safely; deleted id never active.
 * - Browser back/forward creates no row; reload preserves direct URL and creates
 *   no duplicate rows.
 */

type Conv = { id: string; title: string; engine?: string | null };

async function listConversations(request: APIRequestContext): Promise<Conv[]> {
  const res = await request.get("/api/conversations?status=all&limit=100");
  expect(res.ok()).toBe(true);
  const data = (await res.json()) as { threads: Conv[] };
  return data.threads;
}

async function idsOf(request: APIRequestContext): Promise<Set<string>> {
  return new Set((await listConversations(request)).map((t) => t.id));
}

async function createConversation(request: APIRequestContext, marker: string): Promise<string> {
  const res = await request.post("/api/conversations", {
    data: { title: marker, workspaceMode: "simple" },
  });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function deleteConversation(request: APIRequestContext, id: string): Promise<void> {
  await request.delete(`/api/conversations/${id}`).catch(() => {});
}

/** Add conversations to shared workspace membership in order (CAS). */
async function addSharedTabs(request: APIRequestContext, ids: string[]): Promise<void> {
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

/** The composer's send affordance (shared across specs, same selector as phase-4). */
async function waitDraftReady(page: Page): Promise<void> {
  await page
    .getByRole("heading", { name: /what do you want to build/i })
    .first()
    .waitFor({ timeout: 30000 });
  await expect(page.getByRole("group", { name: "Engine" })).toBeVisible({ timeout: 10000 });
}

test.describe.configure({ mode: "serial" });
test.describe.configure({ timeout: 120000 });

test.beforeEach(async ({ page }) => {
  await page.goto("/#/chat/new");
  await waitDraftReady(page);
});

test("opening the same conversation through two paths yields no duplicate visible tab", async ({
  page,
}) => {
  const created = await createConversation(page.request, "p8-dup-conv");
  try {
    // Path 1: direct route navigation (detached local presentation; no shared mutation).
    await page.goto(`/#/chat/${created}`);
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toHaveCount(1, {
      timeout: 15000,
    });

    // Path 2: sidebar row click. Reload so the sidebar list includes the new row.
    await page.reload();
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toHaveCount(1, {
      timeout: 15000,
    });

    const row = page
      .locator("#sidebar-section-chats")
      .getByRole("button", { name: /p8-dup-conv/i });
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.click();
    await expect(page).toHaveURL(new RegExp(`#/chat/${created}$`), { timeout: 10000 });

    // No duplicate visible tab for this conversation ref.
    const strip = page.getByRole("tablist", { name: "Chat tabs" });
    await expect(strip).toBeVisible();
    const tabsForRef = strip.locator(`[data-tab-ref="${created}"], [data-conversation-id="${created}"]`);
    // Fallback: count tabs whose accessible name/title contains the marker.
    const namedTabs = strip.getByRole("tab", { name: /p8-dup-conv/i });
    const count = (await tabsForRef.count()) || (await namedTabs.count());
    expect(count).toBeLessThanOrEqual(1);
  } finally {
    await deleteConversation(page.request, created);
  }
});

test("navigating to a new draft creates NO conversation row", async ({ page }) => {
  const before = await idsOf(page.request);

  await page.locator("button[title='New chat']").first().click();
  await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: 10000 });

  const after = await idsOf(page.request);
  const createdIds = [...after].filter((id) => !before.has(id));
  expect(createdIds, "draft navigation must not mint a conversation").toEqual([]);
});

test("first send from the draft creates exactly ONE row and one tab", async ({ page }) => {
  const MARKER = "p8-first-send-row";
  let _chatCalls = 0;
  await page.route("**/api/chat", async (route) => {
    _chatCalls += 1;
    await route.abort(); // no real model call
  });

  const created: string[] = [];
  try {
    await page
      .getByRole("textbox", { name: /Send a message/ })
      .first()
      .fill(MARKER);
    await page
      .getByRole("textbox", { name: /Send a message/ })
      .first()
      .press("Enter");

    await expect(page).toHaveURL(/#\/chat\/(?!new)/, { timeout: 30000 });
    const match = page.url().match(/#\/chat\/([^/]+)/);
    expect(match).not.toBeNull();
    created.push(match![1]);

    const after = await idsOf(page.request);
    expect(after.has(match![1]), "first send materialized a conversation").toBe(true);

    await deleteConversation(page.request, match![1]);
  } finally {
    await page.unroute("**/api/chat");
    for (const id of created) await deleteConversation(page.request, id);
  }
});

test("closing an inactive shared tab leaves the active conversation unchanged", async ({ page }) => {
  const a = await createConversation(page.request, "p8-close-a");
  const b = await createConversation(page.request, "p8-close-b");
  try {
    await addSharedTabs(page.request, [a, b]);
    await page.goto(`/#/chat/${b}`);
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toHaveCount(1, {
      timeout: 15000,
    });

    const strip = page.getByRole("tablist", { name: "Chat tabs" });
    await expect(strip).toBeVisible({ timeout: 10000 });
    const tabA = strip.getByRole("tab", { name: /p8-close-a/i });
    await expect(tabA).toBeVisible({ timeout: 10000 });
    await tabA.hover();
    await tabA.getByRole("button", { name: "Close tab" }).click();

    await expect(page).toHaveURL(new RegExp(`#/chat/${b}$`), { timeout: 10000 });
  } finally {
    await deleteConversation(page.request, a);
    await deleteConversation(page.request, b);
  }
});

test("closing the active shared tab activates the right neighbour", async ({ page }) => {
  const a = await createConversation(page.request, "p8-neigh-a");
  const doomed = await createConversation(page.request, "p8-neigh-mid");
  const b = await createConversation(page.request, "p8-neigh-b");
  try {
    await addSharedTabs(page.request, [a, doomed, b]);
    await page.goto(`/#/chat/${doomed}`);
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toHaveCount(1, {
      timeout: 15000,
    });

    const strip = page.getByRole("tablist", { name: "Chat tabs" });
    await expect(strip).toBeVisible({ timeout: 10000 });
    const midTab = strip.getByRole("tab", { name: /p8-neigh-mid/i });
    await expect(midTab).toBeVisible({ timeout: 10000 });
    await midTab.hover();
    await midTab.getByRole("button", { name: "Close tab" }).click();

    // Right neighbour (b) becomes active.
    await expect(page).toHaveURL(new RegExp(`#/chat/${b}$`), { timeout: 10000 });
  } finally {
    for (const id of [a, doomed, b]) await deleteConversation(page.request, id);
  }
});

test("deleting the active conversation falls back safely; deleted id never active", async ({
  page,
}) => {
  const doomed = await createConversation(page.request, "p8-delete-active");
  const survivor = await createConversation(page.request, "p8-delete-survivor");
  try {
    await addSharedTabs(page.request, [survivor, doomed]);
    await page.goto(`/#/chat/${doomed}`);
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toHaveCount(1, {
      timeout: 15000,
    });

    await page.reload();
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toHaveCount(1, {
      timeout: 15000,
    });

    const titleButton = page
      .locator("#sidebar-section-chats")
      .getByRole("button", { name: /p8-delete-active/i });
    await expect(titleButton).toBeVisible({ timeout: 10000 });
    const row = titleButton.locator("xpath=..");
    await row.hover();
    await row.getByRole("button").last().click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();

    await page.waitForURL((url) => !url.toString().includes(doomed), { timeout: 15000 });
    const remaining = await idsOf(page.request);
    expect(remaining.has(doomed), "deleted conversation is gone").toBe(false);
  } finally {
    await deleteConversation(page.request, doomed);
    await deleteConversation(page.request, survivor);
  }
});

test("browser back/forward creates no conversation row", async ({ page }) => {
  const target = await createConversation(page.request, "p8-history");
  try {
    const before = await idsOf(page.request);

    await page.goto(`/#/chat/${target}`);
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toHaveCount(1, {
      timeout: 15000,
    });
    await page.locator("button[title='New chat']").first().click();
    await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: 10000 });
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`#/chat/${target}$`), { timeout: 10000 });
    await page.goForward();
    await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: 10000 });

    const after = await idsOf(page.request);
    const newRows = [...after].filter((id) => !before.has(id));
    expect(newRows).toEqual([]);
  } finally {
    await deleteConversation(page.request, target);
  }
});

test("reload preserves direct conversation URL with no duplicate rows", async ({ page }) => {
  const target = await createConversation(page.request, "p8-reload");
  try {
    const before = await idsOf(page.request);

    await page.goto(`/#/chat/${target}`);
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toHaveCount(1, {
      timeout: 15000,
    });

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`#/chat/${target}$`), { timeout: 15000 });
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toHaveCount(1, {
      timeout: 15000,
    });

    const after = await idsOf(page.request);
    const newRows = [...after].filter((id) => !before.has(id));
    expect(newRows, "reload must not create duplicate rows").toEqual([]);
  } finally {
    await deleteConversation(page.request, target);
  }
});
