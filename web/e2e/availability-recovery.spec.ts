import { expect, test } from "@playwright/test";

/**
 * Phase 3 browser-level recovery (server availability).
 *
 * Backend down is simulated with route interception (no backend restarts):
 * page mounted + known conversation visible → abort /readyz + /api/* →
 * stale state retained with the offline gate → restore routes →
 * authoritative refresh, composer draft kept verbatim, nothing auto-sent.
 */
test("outage retains stale state and gates send, recovery refreshes authoritatively", async ({
  page,
}) => {
  const createBody = {
    title: "Known Conversation",
    workspaceMode: "simple",
    workspaceFolderId: null,
    engine: "direct",
    providerId: null,
    modelId: null,
    reasoningLevel: null,
    opencodeAgent: null,
    opencodeModel: null,
    opencodeVariant: null,
    opencodeAutoApprove: false,
  };
  const created = await page.request.post("/api/conversations", {
    data: createBody,
  });
  expect(created.ok()).toBe(true);

  await page.goto("/#/chat/new");
  await expect(
    page.getByRole("heading", { name: /what do you want to build/i }),
  ).toBeVisible({ timeout: 20000 });
  // Healthy: availability chrome reads Local; seeded conversation listed.
  await expect(page.getByTitle("Backend available")).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.getByText("Known Conversation").first(),
  ).toBeVisible({ timeout: 15000 });

  // Simulate a backend outage: readiness + all API traffic fails.
  await page.route("**/readyz", (route) => route.abort());
  await page.route("**/api/**", (route) => route.abort());

  // Poller escalates to offline; chrome says stale, never authoritative.
  await expect(
    page.getByTitle("Backend unavailable — showing last known state"),
  ).toBeVisible({ timeout: 60000 });
  // The known conversation stays visible (retained, not wiped to empty).
  await expect(page.getByText("Known Conversation").first()).toBeVisible();
  // Composer send is gated: an inert disabled button replaces Send.
  const box = page.getByRole("textbox", { name: /Send a message/ });
  await box.fill("unsent draft — keep me");
  const offlineSend = page.getByLabel("Backend unavailable — draft kept");
  await expect(offlineSend).toBeVisible();
  await expect(offlineSend).toBeDisabled();

  // Restore the network: recovery refetches authoritatively.
  await page.unroute("**/readyz");
  await page.unroute("**/api/**");
  await expect(page.getByTitle("Backend available")).toBeVisible({
    timeout: 90000,
  });
  await expect(page.getByText("Known Conversation").first()).toBeVisible();
  // Draft kept verbatim; still on the draft route — nothing auto-sent.
  await expect(box).toHaveValue("unsent draft — keep me");
  expect(page.url()).toContain("/chat/new");
  const list = await page.request.get(
    "/api/conversations?status=all&limit=50",
  );
  expect(list.ok()).toBe(true);
  const data = (await list.json()) as { threads: unknown[] };
  expect(data.threads).toHaveLength(1);
});
