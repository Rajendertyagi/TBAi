import { expect, test, type APIRequestContext } from "@playwright/test";
import { removeConversation, seedConversation } from "../helpers/seedConversation.ts";

/**
 * Normal shared-tab workflow invariants (not migration/import setup).
 * - Direct URL to a valid conversation not in shared membership must not mutate
 *   shared membership (route mount is presentation binding only).
 * - Explicit shared open adds membership; explicit close removes it.
 */

async function getSharedTabIds(request: APIRequestContext): Promise<string[]> {
  const res = await request.get("/api/preferences");
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { sharedTabs?: Array<{ ref: string }> };
  return (body.sharedTabs ?? []).map((t) => t.ref);
}

async function openSharedTab(request: APIRequestContext, conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const prefsRes = await request.get("/api/preferences");
    expect(prefsRes.ok()).toBe(true);
    const prefs = (await prefsRes.json()) as { revision: number };
    const res = await request.post("/api/preferences/tabs/open", {
      data: { baseRevision: prefs.revision, conversationId, kind: "chat" },
    });
    if (res.status() === 409) continue;
    expect(res.ok()).toBe(true);
    return;
  }
  throw new Error("Failed to open shared tab");
}

async function closeSharedTab(request: APIRequestContext, conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const prefsRes = await request.get("/api/preferences");
    expect(prefsRes.ok()).toBe(true);
    const prefs = (await prefsRes.json()) as { revision: number };
    const res = await request.post("/api/preferences/tabs/close", {
      data: { baseRevision: prefs.revision, conversationId },
    });
    if (res.status() === 409) continue;
    expect(res.ok()).toBe(true);
    return;
  }
  throw new Error("Failed to close shared tab");
}

test("valid direct URL for a non-shared conversation does not add shared membership", async ({
  page,
}) => {
  const { id } = await seedConversation(page.request, { title: "detached-direct-url" });
  try {
    const before = await getSharedTabIds(page.request);
    expect(before).not.toContain(id);

    await page.goto(`/#/chat/${id}`);
    await expect(page).toHaveURL(new RegExp(`#/chat/${id}$`), { timeout: 15000 });
    await expect(page.getByRole("textbox", { name: /Send a message/ })).toBeVisible({
      timeout: 15000,
    });

    // Route mount is presentation binding only; must not mutate shared membership.
    await expect
      .poll(async () => getSharedTabIds(page.request), { timeout: 5000 })
      .not.toContain(id);
  } finally {
    await removeConversation(page.request, id);
  }
});

test("explicit shared open and close mutate membership via normal workflow", async ({ page }) => {
  const { id } = await seedConversation(page.request, { title: "explicit-shared-open" });
  try {
    await openSharedTab(page.request, id);
    await expect.poll(async () => getSharedTabIds(page.request), { timeout: 5000 }).toContain(id);

    await page.goto(`/#/chat/${id}`);
    await expect(page).toHaveURL(new RegExp(`#/chat/${id}$`), { timeout: 15000 });

    await closeSharedTab(page.request, id);
    await expect
      .poll(async () => getSharedTabIds(page.request), { timeout: 5000 })
      .not.toContain(id);
  } finally {
    await removeConversation(page.request, id);
  }
});
