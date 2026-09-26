import { expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Shared fixtures for the specs that run against the REAL managed OpenCode
 * server (nothing mocked).
 *
 * These helpers live in their own module because two specs need the same
 * disposable-conversation lifecycle, and copying it per spec is how a cleanup
 * starts silently leaking rows.
 */

/**
 * Generous by design: a real model decides when to make its tool call, so these
 * specs wait on the model rather than on a fixed delay.
 */
export const LIVE_TIMEOUT_MS = 180_000;

/** Verified in this environment to answer real requests and make real tool calls. */
export const LIVE_MODEL = "agnes/agnes-3.0-flash";

/** Creates a disposable Code-mode conversation in its own throwaway workspace. */
export async function createCodeConversation(
  request: APIRequestContext,
  model: string = LIVE_MODEL,
): Promise<string> {
  const response = await request.post("/api/conversations", {
    data: {
      title: "V2 live probe",
      workspaceMode: "simple",
      engine: "opencode",
      opencodeAgent: "build",
      opencodeModel: model,
      opencodeVariant: "high",
    },
  });
  expect(response.ok()).toBe(true);
  const created = (await response.json()) as { id: string };
  expect(created.id).toBeTruthy();
  return created.id;
}

/** Removes the disposable conversation (and with it the throwaway workspace). */
export async function deleteCodeConversation(
  request: APIRequestContext,
  conversationId: string,
): Promise<void> {
  await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
}

/** Opens an existing Code-mode conversation and waits for the composer. */
export async function openCodeConversation(
  page: Page,
  conversationId: string,
): Promise<void> {
  await page.goto(`/#/code/${conversationId}`);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
    timeout: LIVE_TIMEOUT_MS,
  });
}

/** Sends one prompt through the real composer. */
export async function sendPrompt(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: /Send a message/ });
  await expect(composer).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}
