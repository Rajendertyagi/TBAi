import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { removeConversation, seedConversation } from "../helpers/seedConversation.ts";

/**
 * Multi-window shared workspace behavior (same browser profile/context + same backend).
 * Verifies independent local routes, shared membership convergence, remote close
 * preserving the viewing window's route/composer, detached presentation, and
 * explicit-only reopen.
 */

async function getPrefs(request: APIRequestContext) {
  const res = await request.get("/api/preferences");
  expect(res.ok()).toBe(true);
  return (await res.json()) as {
    revision: number;
    sharedTabs: Array<{ ref: string; kind: string }>;
  };
}

async function openSharedTab(request: APIRequestContext, conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const prefs = await getPrefs(request);
    const res = await request.post("/api/preferences/tabs/open", {
      data: { baseRevision: prefs.revision, conversationId, kind: "chat" },
    });
    if (res.status() === 409) continue;
    expect(res.ok()).toBe(true);
    return;
  }
  throw new Error("openSharedTab failed");
}

async function closeSharedTab(request: APIRequestContext, conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const prefs = await getPrefs(request);
    const res = await request.post("/api/preferences/tabs/close", {
      data: { baseRevision: prefs.revision, conversationId },
    });
    if (res.status() === 409) continue;
    expect(res.ok()).toBe(true);
    return;
  }
  throw new Error("closeSharedTab failed");
}

async function openConversation(page: Page, id: string): Promise<void> {
  await page.goto(`/#/chat/${id}`);
  await expect(page).toHaveURL(new RegExp(`#/chat/${id}$`), { timeout: 15000 });
  await expect(page.getByRole("textbox", { name: /Send a message/ })).toBeVisible({
    timeout: 15000,
  });
}

test("two windows keep independent routes; shared mutations converge without stealing route", async ({
  browser,
  request,
}) => {
  const { id: a } = await seedConversation(request, { title: "mw-a" });
  const { id: b } = await seedConversation(request, { title: "mw-b" });
  const { id: c } = await seedConversation(request, { title: "mw-c" });
  let context: BrowserContext | undefined;
  try {
    await openSharedTab(request, a);
    await openSharedTab(request, b);

    context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    await openConversation(pageA, a);
    await openConversation(pageB, b);

    // Independent local routes/active selections.
    await expect(pageA).toHaveURL(new RegExp(`#/chat/${a}$`));
    await expect(pageB).toHaveURL(new RegExp(`#/chat/${b}$`));

    // Shared mutation from "another window" perspective (API) becomes visible; B keeps route.
    await openSharedTab(request, c);
    await expect
      .poll(async () => (await getPrefs(request)).sharedTabs.map((t) => t.ref), {
        timeout: 5000,
      })
      .toContain(c);
    await expect(pageB).toHaveURL(new RegExp(`#/chat/${b}$`), { timeout: 5000 });
    await expect(pageA).toHaveURL(new RegExp(`#/chat/${a}$`), { timeout: 5000 });
  } finally {
    await context?.close().catch(() => {});
    await removeConversation(request, a);
    await removeConversation(request, b);
    await removeConversation(request, c);
  }
});

test("remote close preserves viewing window route and unsent composer text; conversation becomes detached", async ({
  browser,
  request,
}) => {
  const { id: target } = await seedConversation(request, { title: "mw-remote-close" });
  let context: BrowserContext | undefined;
  try {
    await openSharedTab(request, target);
    context = await browser.newContext();
    const pageB = await context.newPage();
    await openConversation(pageB, target);

    const composer = pageB.getByRole("textbox", { name: /Send a message/ });
    await composer.fill("unsent draft text");
    await expect(composer).toHaveValue("unsent draft text");

    // Remote close (simulates another window / authoritative shared mutation).
    await closeSharedTab(request, target);
    await expect
      .poll(async () => (await getPrefs(request)).sharedTabs.map((t) => t.ref), {
        timeout: 5000,
      })
      .not.toContain(target);

    // B must keep its route and unsent composer text; no navigation/deletion.
    await expect(pageB).toHaveURL(new RegExp(`#/chat/${target}$`), { timeout: 10000 });
    await expect(pageB.getByRole("textbox", { name: /Send a message/ })).toHaveValue(
      "unsent draft text",
      { timeout: 10000 },
    );
    await expect(pageB).not.toHaveURL(/#\/chat\/new$/);
  } finally {
    await context?.close().catch(() => {});
    await removeConversation(request, target);
  }
});

test("only explicit action reopens shared membership after remote close", async ({
  browser,
  request,
}) => {
  const { id: target } = await seedConversation(request, { title: "mw-reopen-explicit" });
  let context: BrowserContext | undefined;
  try {
    await openSharedTab(request, target);
    context = await browser.newContext();
    const pageB = await context.newPage();
    await openConversation(pageB, target);

    await closeSharedTab(request, target);
    await expect
      .poll(async () => (await getPrefs(request)).sharedTabs.map((t) => t.ref), {
        timeout: 5000,
      })
      .not.toContain(target);

    // Reload/navigation within the same conversation must not resurrect shared membership.
    await pageB.reload();
    await expect(pageB).toHaveURL(new RegExp(`#/chat/${target}$`), { timeout: 15000 });
    await expect
      .poll(async () => (await getPrefs(request)).sharedTabs.map((t) => t.ref), {
        timeout: 5000,
      })
      .not.toContain(target);

    // Explicit reopen adds it back.
    await openSharedTab(request, target);
    await expect
      .poll(async () => (await getPrefs(request)).sharedTabs.map((t) => t.ref), {
        timeout: 5000,
      })
      .toContain(target);
  } finally {
    await context?.close().catch(() => {});
    await removeConversation(request, target);
  }
});
