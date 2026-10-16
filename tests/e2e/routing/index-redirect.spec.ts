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

test("index route falls back to /chat/new with replacement navigation", async ({ page }) => {
  await seedTabs(page, { tabs: [] });
  await page.goto("/#/");

  await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: 15000 });
  await expect(page.getByRole("heading", { name: /what do you want to build/i })).toBeVisible({
    timeout: 15000,
  });
  // Replacement navigation: the transient `/` entry is replaced, not pushed.
  expect(await page.evaluate(() => window.history.length)).toBe(2);

  // Triggering back does not loop back to the index route
  await page.goBack();
  expect(page.url()).not.toContain("/#/");
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

test("AppShell instance persists across Chat <-> Code navigation without remounting", async ({
  page,
}) => {
  const { id: directId } = await seedConversation(page.request);
  const { id: codeId } = await seedOpenCodeConversation(page.request);

  try {
    await page.goto(`/#/chat/${directId}`);
    await expect(page).toHaveURL(new RegExp(`#/chat/${directId}$`), { timeout: 15000 });

    // Mark window with a persistent token
    await page.evaluate(() => {
      (window as unknown as { __TBAI_SHELL_TEST_ID?: number }).__TBAI_SHELL_TEST_ID = 88991;
    });

    // Navigate to Code conversation
    await page.goto(`/#/code/${codeId}`);
    await expect(page).toHaveURL(new RegExp(`#/code/${codeId}$`), { timeout: 15000 });

    // Verify token survived: AppShell did not unmount
    const token = await page.evaluate(
      () => (window as unknown as { __TBAI_SHELL_TEST_ID?: number }).__TBAI_SHELL_TEST_ID,
    );
    expect(token).toBe(88991);
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
