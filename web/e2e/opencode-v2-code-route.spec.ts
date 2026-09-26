import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const ROUTE_TIMEOUT_MS = 30_000;
const SERVER_TIMEOUT_MS = 90_000;
const LIVE_PROMPT = "Reply with OK.";

type Conversation = {
  id: string;
  engine?: string | null;
};

async function deleteConversation(
  request: APIRequestContext,
  id: string,
): Promise<void> {
  await request.delete(`/api/conversations/${id}`).catch(() => undefined);
}

async function listConversationIds(
  request: APIRequestContext,
): Promise<Set<string>> {
  const response = await request.get("/api/conversations?status=all&limit=200");
  if (!response.ok()) return new Set<string>();
  const body = (await response.json().catch(() => null)) as {
    threads?: Conversation[];
  } | null;
  return new Set((body?.threads ?? []).map((thread) => thread.id));
}

async function openCodeDraft(page: Page): Promise<void> {
  await page.goto("/#/code");
  await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: ROUTE_TIMEOUT_MS });
  const engine = page.getByRole("group", { name: "Engine" });
  await expect(engine).toBeVisible({ timeout: ROUTE_TIMEOUT_MS });
  const openCode = engine.getByRole("button", { name: "OpenCode" });
  if ((await openCode.getAttribute("aria-pressed")) !== "true") {
    await openCode.click();
  }
  await expect(openCode).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Agent" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Model" })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: /Send a message/ }),
  ).toBeVisible();
}

test("Code route admits a first prompt and restores its session history", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const before = await listConversationIds(page.request);
  let conversationId: string | null = null;

  try {
    await openCodeDraft(page);

    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/conversations",
    );
    const sessionResponsePromise = page
      .waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/opencode/session",
        { timeout: SERVER_TIMEOUT_MS },
      )
      .catch(() => null);
    const promptResponsePromise = page
      .waitForResponse(
        (response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === "POST" &&
            /^\/api\/opencode\/(?:api\/)?session\/[^/]+\/prompt$/.test(
              url.pathname,
            )
          );
        },
        { timeout: SERVER_TIMEOUT_MS },
      )
      .catch(() => null);
    const composer = page.getByRole("textbox", { name: /Send a message/ });
    await composer.fill(LIVE_PROMPT);
    await page.getByRole("button", { name: "Send message" }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.ok()).toBe(true);
    const created = (await createResponse.json()) as Conversation;
    expect(created.id).toBeTruthy();
    conversationId = created.id;
    expect(created.engine).toBe("opencode");

    await expect(page).toHaveURL(
      new RegExp(`#\\/code\\/${created.id}$`),
      { timeout: SERVER_TIMEOUT_MS },
    );
    await expect(composer).toBeVisible({ timeout: SERVER_TIMEOUT_MS });
    await expect(composer).toHaveValue("", { timeout: ROUTE_TIMEOUT_MS });
    await expect(page.getByRole("button", { name: "Agent" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Model" })).toBeVisible();

    const promptOutcome = await Promise.race([
      promptResponsePromise.then((response) =>
        response ? ({ kind: "response" as const, response }) : null,
      ),
      page
        .getByRole("button", { name: "OpenCode status: Error" })
        .waitFor({ timeout: ROUTE_TIMEOUT_MS })
        .then(() => ({ kind: "status-error" as const })),
    ]);
    const admitted = promptOutcome?.kind === "response" && promptOutcome.response.ok();
    if (!admitted) {
      const statusError = page.getByRole("button", {
        name: "OpenCode status: Error",
      });
      await expect(statusError).toBeVisible({ timeout: ROUTE_TIMEOUT_MS });
      await statusError.click();
      await expect(page.getByRole("alert")).toContainText(
        /provider|model|auth|credential|unavailable|not found|fail|required|credit|quota|billing|purchase/i,
        { timeout: ROUTE_TIMEOUT_MS },
      );
    } else {
      const sessionResponse = await sessionResponsePromise;
      expect(sessionResponse?.ok()).toBe(true);
      const session = (await sessionResponse!.json()) as { sessionId?: string };
      expect(session.sessionId).toBeTruthy();
      await expect(page.getByText(LIVE_PROMPT, { exact: true })).toBeVisible({
        timeout: ROUTE_TIMEOUT_MS,
      });
      await Promise.race([
        page
          .getByRole("button", { name: "OpenCode status: Working" })
          .waitFor({ timeout: SERVER_TIMEOUT_MS }),
        page
          .getByRole("button", { name: "Regenerate response" })
          .last()
          .waitFor({ timeout: SERVER_TIMEOUT_MS }),
      ]);
    }

    await page.reload();
    await expect(page).toHaveURL(
      new RegExp(`#\\/code\\/${created.id}$`),
      { timeout: SERVER_TIMEOUT_MS },
    );
    await expect(composer).toBeVisible({ timeout: SERVER_TIMEOUT_MS });
    await expect(page.getByRole("button", { name: "Agent" })).toBeVisible();
    if (admitted) {
      await expect(page.getByText(LIVE_PROMPT, { exact: true })).toBeVisible({
        timeout: SERVER_TIMEOUT_MS,
      });
    }
  } finally {
    const after = await listConversationIds(page.request);
    const createdIds = [...after].filter((id) => !before.has(id));
    for (const id of conversationId ? [conversationId] : createdIds) {
      await deleteConversation(page.request, id);
    }
  }
});
