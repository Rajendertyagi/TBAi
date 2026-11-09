import { expect, test, type APIRequestContext } from "@playwright/test";
import { removeConversation, seedConversation } from "../helpers/seedConversation.ts";

/**
 * Routing, AppShell persistence, cross-engine reconciliation, and history behavior specs.
 *
 * Canonical shared-workspace preferences architecture:
 * - `/` waits for authoritative hydration. Fresh `/` => deterministic local draft
 *   (`/chat/new`). No shared active pointer, no stale local active conversation,
 *   no arbitrary first shared tab, never another window's active route.
 * - Direct conversation URLs take precedence immediately; engine reconciliation preserved.
 * - Deep-link refresh preserves URL/local presentation.
 * - Confirmed 404 => safe fallback/eviction; unknown/transient (5xx/network) => retain.
 * - AppShell DOM persists across Chat <-> Code navigation.
 */

async function seedOpenCodeConversation(request: APIRequestContext): Promise<{ id: string }> {
  const created = await request.post("/api/conversations", {
    data: { title: "Index redirect Code target", workspaceMode: "simple", engine: "opencode" },
  });
  if (!created.ok()) {
    throw new Error(`seed opencode conversation failed: ${created.status()}`);
  }
  return (await created.json()) as { id: string };
}

/** Add conversations to shared workspace membership (CAS). */
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

async function closeSharedTab(request: APIRequestContext, conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const prefsRes = await request.get("/api/preferences");
    if (!prefsRes.ok()) return;
    const prefs = (await prefsRes.json()) as { revision: number };
    const res = await request.post("/api/preferences/tabs/close", {
      data: { baseRevision: prefs.revision, conversationId },
    });
    if (res.status() === 409) continue;
    return;
  }
}

test("index route redirects to fresh local draft after authoritative hydration", async ({
  page,
}) => {
  await page.goto("/#/");
  await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: 15000 });
  await expect(page.getByRole("heading", { name: /what do you want to build/i })).toBeVisible({
    timeout: 15000,
  });
});

test("fresh / with shared tabs still resolves to deterministic local draft (no shared active pointer)", async ({
  page,
}) => {
  const { id: first } = await seedConversation(page.request, { title: "First shared tab" });
  const { id: second } = await seedConversation(page.request, { title: "Second shared tab" });
  try {
    await addToSharedTabs(page.request, [first, second]);
    await page.goto("/#/");
    await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: 15000 });
    await expect(page.getByRole("heading", { name: /what do you want to build/i })).toBeVisible({
      timeout: 15000,
    });
  } finally {
    await closeSharedTab(page.request, first);
    await closeSharedTab(page.request, second);
    await removeConversation(page.request, first);
    await removeConversation(page.request, second);
  }
});

test("index route does not restore another window's active conversation from legacy localStorage", async ({
  page,
}) => {
  const { id: target } = await seedConversation(page.request);
  try {
    // Legacy localStorage must not act as shared/global active authority.
    await page.addInitScript(
      ({ key, value }) => {
        window.localStorage.setItem(key, JSON.stringify(value));
      },
      {
        key: "tbai:openTabs",
        value: {
          tabs: [{ key: `chat:${target}`, kind: "chat", ref: target }],
          activeKey: `chat:${target}`,
        },
      },
    );
    await page.goto("/#/");
    await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: 15000 });
    await expect(page.getByRole("heading", { name: /what do you want to build/i })).toBeVisible({
      timeout: 15000,
    });
  } finally {
    await removeConversation(page.request, target);
  }
});

test("index route falls back to /chat/new with replacement navigation without history loops", async ({
  page,
}) => {
  await page.goto("/#/providers");
  await expect(page).toHaveURL(/#\/providers$/, { timeout: 15000 });

  await page.goto("/#/");
  await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: 15000 });
  await expect(page.getByRole("heading", { name: /what do you want to build/i })).toBeVisible({
    timeout: 15000,
  });

  // Replacement navigation: Back returns directly to /providers.
  await page.goBack();
  await expect(page).toHaveURL(/#\/providers$/, { timeout: 15000 });
});

test("cross-engine URL reconciliation routes OpenCode conversation to Code surface", async ({
  page,
}) => {
  const { id: target } = await seedOpenCodeConversation(page.request);
  try {
    await page.goto(`/#/chat/${target}`);
    await expect(page).toHaveURL(new RegExp(`#/code/${target}$`), { timeout: 15000 });
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible({
      timeout: 15000,
    });
  } finally {
    await removeConversation(page.request, target);
  }
});

test("cross-engine URL reconciliation routes Direct conversation to Chat surface", async ({
  page,
}) => {
  const { id: target } = await seedConversation(page.request);
  try {
    await page.goto(`/#/code/${target}`);
    await expect(page).toHaveURL(new RegExp(`#/chat/${target}$`), { timeout: 15000 });
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toBeVisible({
      timeout: 15000,
    });
  } finally {
    await removeConversation(page.request, target);
  }
});

test("deep-link refresh retains Direct conversation route and presentation", async ({ page }) => {
  const { id: target } = await seedConversation(page.request);
  try {
    await page.goto(`/#/chat/${target}`);
    await expect(page).toHaveURL(new RegExp(`#/chat/${target}$`), { timeout: 15000 });
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toBeVisible({
      timeout: 15000,
    });

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`#/chat/${target}$`), { timeout: 15000 });
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toBeVisible({
      timeout: 15000,
    });
  } finally {
    await removeConversation(page.request, target);
  }
});

test("deep-link refresh for valid Code session stays on Code route", async ({ page }) => {
  const { id: target } = await seedOpenCodeConversation(page.request);
  try {
    await page.goto(`/#/code/${target}`);
    await expect(page).toHaveURL(new RegExp(`#/code/${target}$`), { timeout: 15000 });
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible({
      timeout: 15000,
    });

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`#/code/${target}$`), { timeout: 15000 });
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible({
      timeout: 15000,
    });
    await expect(page).not.toHaveURL(/#\/chat/, { timeout: 5000 });
  } finally {
    await removeConversation(page.request, target);
  }
});

test("AppShell instance persists across Chat <-> Code navigation without remounting", async ({
  page,
}) => {
  const { id: directId } = await seedConversation(page.request);
  const { id: codeId } = await seedOpenCodeConversation(page.request);
  try {
    await page.goto(`/#/chat/${directId}`);
    await expect(page).toHaveURL(new RegExp(`#/chat/${directId}$`), { timeout: 15000 });

    const navLocator = page.locator("nav[aria-label='Primary']");
    await expect(navLocator).toBeVisible({ timeout: 15000 });
    const navHandle = await navLocator.elementHandle();
    expect(navHandle).not.toBeNull();

    await page.evaluate((url) => {
      window.location.hash = url;
    }, `#/code/${codeId}`);
    await expect(page).toHaveURL(new RegExp(`#/code/${codeId}$`), { timeout: 15000 });

    const isSameNode = await page.evaluate(
      ([element]) => {
        const currentNav = document.querySelector("nav[aria-label='Primary']");
        return currentNav !== null && element === currentNav;
      },
      [navHandle!],
    );
    expect(isSameNode).toBe(true);
    const isConnected = await navHandle!.evaluate((el) => el.isConnected);
    expect(isConnected).toBe(true);
  } finally {
    await removeConversation(page.request, directId);
    await removeConversation(page.request, codeId);
  }
});

test("confirmed 404 evicts missing conversation and redirects safely", async ({ page }) => {
  await page.goto("/#/chat/000000000000000000000000");
  await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: 15000 });
  await expect(page.getByRole("heading", { name: /what do you want to build/i })).toBeVisible({
    timeout: 15000,
  });
});

test("transient 5xx server failure retains current route without evicting to new chat", async ({
  page,
}) => {
  const { id } = await seedConversation(page.request, { title: "5xx retention target" });
  try {
    let getIntercepted = 0;
    await page.route(`**/api/conversations/${id}`, async (route) => {
      const req = route.request();
      const isExistenceProbe =
        req.method() === "GET" && new URL(req.url()).pathname === `/api/conversations/${id}`;
      if (isExistenceProbe) {
        getIntercepted += 1;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary internal server error" }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`/#/chat/${id}`);
    await expect.poll(() => getIntercepted, { timeout: 10000 }).toBeGreaterThanOrEqual(1);

    // Unknown/transient existence must not evict or redirect.
    await expect(page).toHaveURL(new RegExp(`#/chat/${id}$`), { timeout: 15000 });
    await expect(page).not.toHaveURL(/#\/chat\/new$/);
  } finally {
    await removeConversation(page.request, id);
  }
});

test("confirmed 404 evicts a missing shared conversation and recovers to the draft route", async ({
  page,
}) => {
  const { id } = await seedConversation(page.request, { title: "404 eviction target" });
  await addToSharedTabs(page.request, [id]);
  await removeConversation(page.request, id);

  // Reload so boot reconciliation / route validation sees confirmed gone.
  await page.goto(`/#/chat/${id}`);
  await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: 15000 });
  await expect(page.getByRole("heading", { name: /what do you want to build/i })).toBeVisible({
    timeout: 15000,
  });
});

test("nested error boundary containment renders recovery UI while preserving AppShell chrome", async ({
  page,
}) => {
  // Abort lazy bundle load for a route to trigger the nested RouteError boundary
  await page.route("**/SchedulerPage*", (route) => route.abort());

  await page.goto("/#/scheduler");

  // ChatShell errorElement catches the failure and renders RouteError recovery UI.
  const recoveryPanel = page.locator(
    'div.justify-center:has(> h1:has-text("Something went wrong"))',
  );
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible({
    timeout: 15000,
  });
  await expect(recoveryPanel.getByRole("button", { name: "New chat", exact: true })).toBeVisible();

  // AppShell chrome (Primary navigation) is preserved and did not crash
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

  // Clicking the recovery panel's "New chat" recovers navigation to /chat/new
  await recoveryPanel.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: 15000 });
});
