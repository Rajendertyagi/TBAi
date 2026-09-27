import { expect, test } from "@playwright/test";
import { startControlledProvider } from "./helpers/controlledProvider";

/**
 * Runtime-derived running indicator: while a generation is in flight the
 * sidebar row shows a live dot sourced from thread state (never persisted).
 * Finishing the run clears it; the conversation status never changes.
 *
 * Two things this spec had to get right, both learned the hard way:
 *
 * 1. The run is held at the PROVIDER, over a real socket, with real streaming
 *    frames. It used to be faked by intercepting the /api/chat request in the
 *    browser and holding it, which delivered zero bytes, so the thread never
 *    entered a running state and the indicator had nothing to report.
 *
 * 2. The conversation must already EXIST. The indicator lives inside a sidebar
 *    row, and a conversation created by the send has no row until the list
 *    refetches — measured, the row count does not change during a first send.
 *    So a first-message-in-a-new-chat has nothing to attach a dot to. This spec
 *    therefore continues an EXISTING conversation, which is the case the
 *    indicator is actually for.
 *
 * NOTE: no backticks in this comment — the spec transform mis-parses them and
 * reports the file as unbuildable.
 */
test("sidebar shows a running dot only while generating", async ({ page, request }) => {
  // A real stream held open, plus several page transitions.
  test.setTimeout(120_000);

  // Seed a conversation with history, so its sidebar row exists from first paint.
  const title = `indicator existing ${Date.now()}`;
  const created = await request.post("/api/conversations", {
    data: { title, workspaceMode: "simple", engine: "direct" },
  });
  expect(created.ok()).toBe(true);
  const conversation = (await created.json()) as { id: string };
  const seeded = await request.post(`/api/conversations/${conversation.id}/messages`, {
    data: {
      message: {
        id: `seed-${conversation.id}`,
        parent_id: null,
        format: "ai-sdk/v6",
        content: { role: "user", parts: [{ type: "text", text: "earlier turn" }] },
      },
    },
  });
  expect(seeded.ok()).toBe(true);

  const provider = await startControlledProvider(request);

  try {
    // Full load, so the sidebar list is fetched with this conversation in it.
    await page.goto(`/#/chat/${conversation.id}`);
    await expect(
      page.getByRole("textbox", { name: /Send a message/i }).first(),
    ).toBeVisible({ timeout: 30000 });

    // The row must exist before an indicator inside it can mean anything.
    const row = page.locator("div.group").filter({ hasText: title });
    await expect(row.first()).toBeVisible({ timeout: 15000 });

    const box = page.getByRole("textbox", { name: /Send a message/i }).first();
    await box.click();
    await box.pressSequentially("second turn, held open", { delay: 10 });
    await page.locator('button[type="submit"]').click();

    // The run really is in flight: the provider received the request and emitted
    // a streaming frame. Without this the dot assertion could pass or fail for
    // reasons unrelated to the run.
    await expect.poll(() => provider.requestCount, { timeout: 30000 }).toBeGreaterThan(0);
    await expect.poll(() => provider.frames.length, { timeout: 30000 }).toBeGreaterThan(0);

    // The app's own answer about the run, independent of the sidebar. This is the
    // reference the indicator is measured against.
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 15000,
    });

    // The indicator, on the row for THIS conversation.
    const dot = row.getByRole("status", { name: "Generating response" });
    await expect(dot.first()).toBeVisible({ timeout: 15000 });
    // Exactly one composer throughout the run.
    await expect(page.getByRole("textbox", { name: /Send a message/i })).toHaveCount(1);

    provider.complete();

    // Once the run ends the indicator goes away.
    await expect(
      row.getByRole("status", { name: "Generating response" }),
    ).toHaveCount(0, { timeout: 15000 });
  } finally {
    provider.complete();
    provider.stop();
    await request.delete(`/api/providers/${provider.providerId}`).catch(() => {});
    await request.delete(`/api/conversations/${conversation.id}`).catch(() => {});
  }
});
