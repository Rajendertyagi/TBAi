import { expect, test } from "@playwright/test";

/**
 * Phase 4 first-send lifecycle — e2e route-level verification.
 *
 * Proves the two first-send paths route to the correct surface:
 *   D1 Direct draft send  → /chat/<id>  (adapter.initialize + SDK send)
 *   D2 OpenCode draft send → /code/<id> (custom sendOpenCodeDraft, zero /api/chat)
 *
 * /api/chat is intercepted so the model call never reaches a real provider
 * (no keys/quota required). The intercept records whether the call happened;
 * the Direct path expects one abort, the OpenCode path expects zero.
 *
 * All created conversations are deleted in the finally block so repeated runs
 * stay hermetic (same pattern as phase-ua-d.spec.ts).
 */

type Page = Parameters<Parameters<typeof test>[0]>[0]["page"];

async function waitDraft(page: Page): Promise<void> {
  await page
    .getByRole("heading", { name: /what do you want to build/i })
    .first()
    .waitFor({ timeout: 30000 });
  await expect(
    page.getByRole("group", { name: "Engine" }),
  ).toBeVisible({ timeout: 10000 });
}

async function setDraftEngine(
  page: Page,
  engine: "Direct" | "OpenCode",
): Promise<void> {
  const pill = page
    .getByRole("group", { name: "Engine" })
    .getByRole("button", { name: engine });
  if ((await pill.getAttribute("aria-pressed")) !== "true") {
    await pill.click();
    await expect(pill).toHaveAttribute("aria-pressed", "true");
  }
}

async function rmConv(page: Page, id: string): Promise<void> {
  await page.request.delete(`/api/conversations/${id}`).catch(() => {});
}

async function probeConvIds(
  request: import("@playwright/test").APIRequestContext,
  marker: string,
): Promise<string[]> {
  const list = await request.get("/api/conversations?status=all&limit=50");
  const data = (await list.json()) as { threads: Array<{ id: string }> };
  const hits: string[] = [];
  for (const t of data.threads) {
    const res = await request.get(`/api/conversations/${t.id}/messages`);
    if (!res.ok()) continue;
    const body = await res.json();
    if (JSON.stringify(body).includes(marker)) hits.push(t.id);
  }
  return hits;
}

async function cleanupMarker(
  request: import("@playwright/test").APIRequestContext,
  marker: string,
): Promise<void> {
  for (const id of await probeConvIds(request, marker)) {
    await rmConv(request, id);
  }
}

/**
 * E2E spike verdict (documented in test comments):
 *
 * (a) Fake Ollama SSE stub driving a real Direct first-send with visible
 *     assistant text is NOT feasible at the e2e layer without modifying the
 *     backend to proxy model requests through a controllable port. The Bun
 *     server resolves the provider endpoint from SQLite and calls it directly;
 *     the browser's page.route cannot intercept that server-side fetch. The
 *     integration test (__spike-sse.test.ts) proves the SSE plumbing works at
 *     the route level, and the backend-first-send test (first-send-opencode-
 *     draft.test.ts case 1) proves admission over a black-hole endpoint. The
 *     e2e leg here instead proves routing (URL + surface) by intercepting
 *     /api/chat, which IS visible from the browser.
 *
 * (b) OpenCode route observation suffices: a page.route glob on /api/chat
 *     captures every attempt, and the custom send path never calls /api/chat
 *     (proven by firstSendPhase4.test.ts case 3 and the source-guard test). The
 *     e2e spec asserts zero intercepted calls and verifies the URL transitions
 *     to /code/<id> with the Code surface rendered.
 *
 *     Note: the glob literal is written in the code below, not here. A glob
 *     begins with an asterisk-slash sequence, which TERMINATES a block comment
 *     early - the remainder would then be parsed as code. That is why this file
 *     once failed to load with "Unterminated string literal" and took the whole
 *     Playwright suite's test collection down with it.
 */

test("D1 Direct draft send routes to /chat/<id> (intercept proves /api/chat called once)", async ({
  page,
}) => {
  const MARKER = "p4-direct-e2e-1";
  let chatCallCount = 0;

  // Intercept /api/chat: count and abort so no real model call is made.
  await page.route("**/api/chat", async (route) => {
    chatCallCount += 1;
    await route.abort();
  });

  try {
    await page.goto("/#/chat/new");
    await waitDraft(page);
    await setDraftEngine(page, "Direct");

    const box = page.getByRole("textbox", { name: /Send a message/ }).first();
    await box.fill(MARKER);
    await box.press("Enter");

    // Bound: left the draft, landed on a real conversation.
    await expect(page).toHaveURL(/#\/chat\/(?!new)/, { timeout: 30000 });
    const match = page.url().match(/#\/chat\/([^/]+)/);
    expect(match, "no /chat/<id> after Direct first send").not.toBeNull();
    const convId = match![1];

    // Exactly one /api/chat was attempted (the first send); it was aborted.
    expect(chatCallCount).toBe(1);

    // Composer cleared after send (same contract as composer-bar.spec.ts).
    await expect(box).toHaveValue("", { timeout: 15000 });

    // Cleanup.
    await cleanupMarker(page.request, MARKER);
    await rmConv(page, convId);
  } finally {
    await page.unroute("**/api/chat");
    await cleanupMarker(page.request, MARKER);
  }
});

test("D2 OpenCode draft send routes to /code/<id> with zero /api/chat calls", async ({
  page,
}) => {
  const MARKER = "p4-opencode-e2e-2";
  let chatCallCount = 0;

  // Intercept /api/chat: count but do NOT abort — the custom send path should
  // never reach this handler. If it does, the count will be > 0 and the test
  // fails, making the regression visible.
  await page.route("**/api/chat", async (route) => {
    chatCallCount += 1;
    // Never actually serve the request; if reached, abort so the test stays
    // quota-free even on a misrouted call.
    await route.abort();
  });

  try {
    await page.goto("/#/chat/new");
    await waitDraft(page);
    await setDraftEngine(page, "OpenCode");

    // Engine switch must have replaced the Bot chip with the Agent chip.
    await expect(page.getByRole("button", { name: "Agent" })).toBeVisible({
      timeout: 10000,
    });

    const box = page.getByRole("textbox", { name: /Send a message/ }).first();
    await box.fill(MARKER);

    // OpenCode draft: the send button is a custom circle-arrow, not the
    // library's standard submit button. Click it explicitly.
    const sendBtn = page.locator(
      'button[aria-label*="Send message"], button[size="7"]',
    ).first();
    await expect(sendBtn).toBeVisible({ timeout: 10000 });
    await sendBtn.click();

    // Bound: left the draft, landed on the Code surface.
    await expect(page).toHaveURL(/#\/code\//, { timeout: 30000 });
    const match = page.url().match(/#\/code\/([^/]+)/);
    expect(match, "no /code/<id> after OpenCode draft first send").not.toBeNull();
    const convId = match![1];

    // ZERO /api/chat calls: the custom send path never targets the chat
    // route; it materializes via POST /api/conversations and stashes the
    // prompt for the session-bound runtime to append.
    expect(chatCallCount).toBe(0);

    // Cleanup.
    await cleanupMarker(page.request, MARKER);
    await rmConv(page, convId);
  } finally {
    await page.unroute("**/api/chat");
    await cleanupMarker(page.request, MARKER);
  }
});
