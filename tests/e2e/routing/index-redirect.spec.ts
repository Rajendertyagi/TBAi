import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { removeConversation, seedConversation } from "../helpers/seedConversation.ts";

/**
 * Routing, AppShell persistence, cross-engine reconciliation, and history behavior specs.
 *
 * Real application-level verification:
 * - Index-route (/) redirect to active Chat, active Code, and fresh draft fallback.
 * - Cross-engine navigation reconciliation (/chat/<opencodeId> -> /code/<opencodeId> and vice versa).
 * - Deep link reload/refresh resilience.
 * - Confirmed 404 eviction vs transient 5xx retention.
 * - AppShell DOM persistence across Chat <-> Code switches (no unmount).
 * - Back-navigation replacement history invariants.
 */

const TABS_KEY = "tbai:openTabs";

async function seedTabs(
  page: Page,
  state: { tabs: { key: string; kind: string; ref: string }[]; activeKey?: string },
): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, JSON.stringify(value));
    },
    { key: TABS_KEY, value: state },
  );
}

async function seedOpenCodeConversation(request: APIRequestContext): Promise<{ id: string }> {
  const created = await request.post("/api/conversations", {
    data: { title: "Index redirect Code target", workspaceMode: "simple", engine: "opencode" },
  });
  if (!created.ok()) {
    throw new Error(`seed opencode conversation failed: ${created.status()}`);
  }
  return (await created.json()) as { id: string };
}

test("index route restores the active Direct chat tab", async ({ page }) => {
  const { id: target } = await seedConversation(page.request);

  try {
    await seedTabs(page, {
      tabs: [{ key: `chat:${target}`, kind: "chat", ref: target }],
      activeKey: `chat:${target}`,
    });
    await page.goto("/#/");

    // Restores the tab's route, not the new-chat fallback.
    await expect(page).toHaveURL(new RegExp(`#/chat/${target}$`), { timeout: 15000 });
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toBeVisible({
      timeout: 15000,
    });
  } finally {
    await removeConversation(page.request, target);
  }
});

test("index route restores the active OpenCode conversation tab", async ({ page }) => {
  const { id: target } = await seedOpenCodeConversation(page.request);

  try {
    await seedTabs(page, {
      tabs: [{ key: `agent:${target}`, kind: "agent", ref: target }],
      activeKey: `agent:${target}`,
    });
    await page.goto("/#/");

    // Lands on the Code surface for the conversation…
    await expect(page).toHaveURL(new RegExp(`#/code/${target}$`), { timeout: 15000 });
    // …inside the persistent shell (not bounced to the Direct draft).
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible({
      timeout: 15000,
    });
    await expect(page).not.toHaveURL(/#\/chat\/new$/, { timeout: 5000 });
  } finally {
    await removeConversation(page.request, target);
  }
});

test("index route falls back to /chat/new with replacement navigation without history loops", async ({
  page,
}) => {
  await seedTabs(page, { tabs: [] });

  // Start at a known previous route
  await page.goto("/#/providers");
  await expect(page).toHaveURL(/#\/providers$/, { timeout: 15000 });

  // Navigate to index route (which redirects to /chat/new with replace: true)
  await page.goto("/#/");
  await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: 15000 });
  await expect(page.getByRole("heading", { name: /what do you want to build/i })).toBeVisible({
    timeout: 15000,
  });

  // Replacement navigation: clicking browser Back returns directly to /providers,
  // proving the transient index route was replaced and does not loop.
  await page.goBack();
  await expect(page).toHaveURL(/#\/providers$/, { timeout: 15000 });
});

test("cross-engine URL reconciliation routes OpenCode conversation to Code surface", async ({
  page,
}) => {
  const { id: target } = await seedOpenCodeConversation(page.request);

  try {
    // Open through /chat/<id> route
    await page.goto(`/#/chat/${target}`);

    // Reconciles and lands on /code/<id>
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
    // Open through /code/<id> route
    await page.goto(`/#/code/${target}`);

    // Reconciles and lands on /chat/<id>
    await expect(page).toHaveURL(new RegExp(`#/chat/${target}$`), { timeout: 15000 });
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toBeVisible({
      timeout: 15000,
    });
  } finally {
    await removeConversation(page.request, target);
  }
});

test("deep-link refresh retains session and active tab", async ({ page }) => {
  const { id: target } = await seedConversation(page.request);

  try {
    await page.goto(`/#/chat/${target}`);
    await expect(page).toHaveURL(new RegExp(`#/chat/${target}$`), { timeout: 15000 });

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

    // Client navigation to Code conversation
    await page.evaluate((url) => {
      window.location.hash = url;
    }, `#/code/${codeId}`);
    await expect(page).toHaveURL(new RegExp(`#/code/${codeId}$`), { timeout: 15000 });

    // Assert DOM node identity: the primary nav element inside AppShell remained connected and identical
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

  // Missing conversation 404 redirects to /chat/new without looping
  await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: 15000 });
  await expect(page.getByRole("heading", { name: /what do you want to build/i })).toBeVisible({
    timeout: 15000,
  });
});

test("transient 5xx server failure retains current tab and route without evicting to new chat", async ({
  page,
}) => {
  const fakeId = "transient-failure-id-12345";
  // Intercept the metadata fetch to simulate a 500 server error
  await page.route(`**/api/conversations/${fakeId}`, (route) => {
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Temporary internal server error" }),
    });
  });

  await seedTabs(page, {
    tabs: [{ key: `chat:${fakeId}`, kind: "chat", ref: fakeId }],
    activeKey: `chat:${fakeId}`,
  });

  await page.goto(`/#/chat/${fakeId}`);

  // URL must be retained on /chat/<fakeId>, not evicted to /chat/new
  await expect(page).toHaveURL(new RegExp(`#/chat/${fakeId}$`), { timeout: 10000 });
  await page.waitForTimeout(1000);
  await expect(page).toHaveURL(new RegExp(`#/chat/${fakeId}$`));
  await expect(page).not.toHaveURL(/#\/chat\/new$/);
});

test("nested error boundary containment renders recovery UI while preserving AppShell chrome", async ({
  page,
}) => {
  // Abort lazy bundle load for a route to trigger the nested RouteError boundary
  await page.route("**/SchedulerPage*", (route) => route.abort());

  await page.goto("/#/scheduler");

  // ChatShell errorElement catches the failure and renders RouteError recovery UI
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();

  // AppShell chrome (Primary navigation) is preserved and did not crash
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

  // Clicking "New chat" recovers navigation to /chat/new
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: 15000 });
});
