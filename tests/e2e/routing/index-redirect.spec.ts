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
  // Seed a REAL conversation so the single-record existence probe has a row to
  // read. With an empty persisted tab list the boot reconciliation pass has no
  // IDs to check, so the probe is the sole existence signal for this route. A
  // fake id would make the probe answer 404 (`gone`) and evict the tab before
  // the simulated 500 is ever the deciding signal — defeating the test's intent.
  const { id } = await seedConversation(page.request, { title: "5xx retention target" });

  try {
    // Start with NO persisted tabs so the route opens a new tab and the
    // single-record existence probe (GET /api/conversations/<id>) actually
    // fires. Pre-seeding the tab would let boot reconciliation confirm the
    // row exists and skip the probe entirely.
    await seedTabs(page, { tabs: [] });

    // Intercept ONLY the single-record existence probe (GET
    // /api/conversations/<id>) and simulate a 500. The batch reconciliation POST
    // and the history /messages GET run through the real server. Because the
    // persisted tab list starts empty, boot reconciliation has no conversation
    // IDs to check — the single-record probe is the only existence signal for
    // this route, and it returns 500 (UNKNOWN), so the tab and route are
    // retained rather than evicted.
    let getIntercepted = 0;
    const probeUrls: string[] = [];
    await page.route(`**/api/conversations/${id}`, async (route) => {
      const req = route.request();
      const url = req.url();
      const isExistenceProbe =
        req.method() === "GET" &&
        new URL(url).pathname === `/api/conversations/${id}`;
      if (isExistenceProbe) {
        getIntercepted += 1;
        probeUrls.push(url);
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

    // The single-record probe must have fired and been answered with the
    // simulated 500 — this is the 5xx branch under test.
    await expect
      .poll(() => getIntercepted, {
        message: `GET /api/conversations/<id> probe must have fired (probes: ${() =>
          probeUrls.join(", ") || "none"})`,
        timeout: 10000,
      })
      .toBeGreaterThanOrEqual(1);

    // A 5xx is UNKNOWN existence, not `gone`: the tab and route are retained.
    await expect(page).toHaveURL(new RegExp(`#/chat/${id}$`), { timeout: 15000 });
    await expect(page).not.toHaveURL(/#\/chat\/new$/);

    // The retained tab must exist in persisted state and be active. This is the
    // observable completion signal for the retention path — no elapsed-time
    // sleep is needed; the URL + persisted-tab assertions above already wait
    // for the route to settle.
    const storedTabs = await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw) as { tabs: { key: string }[]; activeKey?: string };
    }, TABS_KEY);
    expect(storedTabs).not.toBeNull();
    expect(storedTabs!.tabs.some((t) => t.key === `chat:${id}`)).toBe(true);
    expect(storedTabs!.activeKey).toBe(`chat:${id}`);
  } finally {
    await removeConversation(page.request, id);
  }
});

test("confirmed 404 evicts a missing conversation and recovers to the draft route", async ({
  page,
}) => {
  // A real seed whose id we then DELETE before opening the route. The boot
  // reconciliation reports `gone` for the now-missing id, which is the only
  // evidence that may evict a conversation (the confirmed-404 contract).
  const { id } = await seedConversation(page.request, { title: "404 eviction target" });
  await removeConversation(page.request, id);

  await seedTabs(page, {
    tabs: [{ key: `chat:${id}`, kind: "chat", ref: id }],
    activeKey: `chat:${id}`,
  });

  // No interception: the missing row answers a real 404.
  await page.goto(`/#/chat/${id}`);

  // The confirmed-gone verdict evicts the tab and recovers to the draft route.
  await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: 15000 });

  // The evicted tab must no longer be persisted.
  const storedTabs = await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as { tabs: { key: string }[]; activeKey?: string };
  }, TABS_KEY);
  expect(storedTabs?.tabs.some((t) => t.key === `chat:${id}`)).toBe(false);
});

test("nested error boundary containment renders recovery UI while preserving AppShell chrome", async ({
  page,
}) => {
  // Abort lazy bundle load for a route to trigger the nested RouteError boundary
  await page.route("**/SchedulerPage*", (route) => route.abort());

  await page.goto("/#/scheduler");

  // ChatShell errorElement catches the failure and renders RouteError recovery UI.
  //
  // The "New chat" button is not globally unique — the rail, a corner chrome
  // action, and the recovery panel all carry one. Scope it to the RouteError
  // panel (the `justify-center` column that owns the "Something went wrong"
  // heading) so the strict locator resolves to exactly the recovery control.
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
