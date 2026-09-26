import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Task 5 — the native V2 approval path against the REAL managed OpenCode server.
 *
 * Nothing is mocked here. The conversation, the native session, the SSE stream,
 * the tool call, and the permission request are all produced by the running
 * server; the test only types into the composer and reads the DOM.
 *
 * A real gated permission needs no configuration change: the live OpenCode
 * config already declares `{ "action": "shell", "resource": "*", "effect":
 * "ask" }`, so any shell tool call the model makes is permission-gated. That is
 * what makes this deterministic enough to assert on: the model must call the
 * shell, and the server must then ask.
 *
 * The negative case uses the same real path with a model whose provider rejects
 * the call, so the turn ends in a real `session.execution.failed` with no
 * `permission.asked` anywhere.
 */

const ROUTE_TIMEOUT_MS = 180_000;
const PROBE_COMMAND = "echo TBAI_V2_APPROVAL_PROBE";
const PROMPT_PROBE = `Use the shell tool to run exactly this command: ${PROBE_COMMAND}`;
const PROBE_OUTPUT = "TBAI_V2_APPROVAL_PROBE";

/** A conversation the model answers. Verified live in this environment. */
const WORKING_MODEL = "agnes/agnes-3.0-flash";
/** A route the provider answers with a quota rejection (HTTP 402). */
const FAILING_MODEL = "openrouter/qwen/qwen3.8-flash";

async function createCodeConversation(
  request: APIRequestContext,
  model: string,
): Promise<string> {
  const response = await request.post("/api/conversations", {
    data: {
      title: "V2 permission live probe",
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

async function sendPrompt(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: /Send a message/ });
  await expect(composer).toBeVisible({ timeout: ROUTE_TIMEOUT_MS });
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function openCodeConversation(page: Page, conversationId: string): Promise<void> {
  await page.goto(`/#/code/${conversationId}`);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
    timeout: ROUTE_TIMEOUT_MS,
  });
}

test.describe("native V2 permission approval against the real server", () => {
  test("a real gated shell call renders Approve/Deny and replies natively", async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);
    const conversationId = await createCodeConversation(request, WORKING_MODEL);

    try {
      await openCodeConversation(page, conversationId);
      await sendPrompt(page, PROMPT_PROBE);

      // The real gate. A live `permission.asked` carries save patterns, so the
      // shared gate renders option-backed controls ("Allow" / "Always allow" /
      // "Deny"); the generic "Approve" pair is the shape used when a permission
      // has no options. Both spellings are accepted, so the assertion is about
      // the gate existing rather than about its copy.
      const approve = page.getByRole("button", { name: /^(Allow|Approve)\b/ });
      await expect(approve).toBeVisible({ timeout: ROUTE_TIMEOUT_MS });
      await expect(page.getByRole("button", { name: /^Deny\b/ })).toBeVisible({
        timeout: ROUTE_TIMEOUT_MS,
      });
      await expect(page.getByText(PROBE_COMMAND, { exact: false }).first()).toBeVisible({
        timeout: ROUTE_TIMEOUT_MS,
      });

      // Answering must go back over the native permission endpoint, not a
      // TBAi-specific one.
      const reply = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          /\/api\/opencode\/(?:api\/)?session\/[^/]+\/permission\/[^/]+\/reply$/.test(
            new URL(response.url()).pathname,
          ),
        { timeout: ROUTE_TIMEOUT_MS },
      );
      await approve.click();
      expect((await reply).ok()).toBe(true);

      // Approving actually lets the gated command run and its real output land.
      await expect(page.getByText(PROBE_OUTPUT).first()).toBeVisible({
        timeout: ROUTE_TIMEOUT_MS,
      });
    } finally {
      await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
    }
  });

  test("a real failed execution without permission.asked renders no approval card", async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);
    const conversationId = await createCodeConversation(request, FAILING_MODEL);

    try {
      await openCodeConversation(page, conversationId);
      await sendPrompt(page, PROMPT_PROBE);

      // The turn fails for a provider reason, so the runtime must surface the
      // failure and must NOT offer a decision the server never requested.
      await expect(page.getByRole("button", { name: "OpenCode status: Error" })).toBeVisible({
        timeout: ROUTE_TIMEOUT_MS,
      });
      // Both gate spellings are checked, so an option-backed gate could not slip
      // through this negative.
      await expect(page.getByRole("button", { name: /^(Allow|Approve)\b/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Deny\b/ })).toHaveCount(0);
    } finally {
      await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
    }
  });
});
