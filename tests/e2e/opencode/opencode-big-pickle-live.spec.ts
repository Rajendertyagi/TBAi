/**
 * LIVE acceptance: a real Code-mode conversation answered by the OpenCode free
 * tier model `opencode/big-pickle`, through the UI, over a real stream.
 *
 * Nothing is mocked:
 *   - the conversation is created through TBAi's own API with engine=opencode,
 *   - the session is booted by the real managed `opencode serve`,
 *   - the prompt goes through the real composer and the real SSE event stream,
 *   - the answer is read from the rendered transcript.
 *
 * Why this cannot be a hermetic spec: the free tier is only usable from inside
 * OpenCode, and the model must actually answer. The hermetic E2E server has no
 * provider credentials, which is exactly why this is `-live` and opt-in.
 *
 * The capability assertion comes first so a model that is missing from the
 * catalogue fails with that reason rather than as a mystery timeout.
 */
import { expect, test } from "@playwright/test";
import {
  deleteCodeConversation,
  LIVE_TIMEOUT_MS,
  openCodeConversation,
  sendPrompt,
} from "../helpers/opencode-live-fixtures";

const MODEL = "opencode/big-pickle";
const PROMPT =
  "Write the numbers 1 through 20, each on its own line. " +
  "Then write pickle-ok on its own line. Do not use any tools.";

test("real Big Pickle stream through the Code surface", async ({ page, request }, testInfo) => {
  test.setTimeout(300_000);

  // ── 1. The managed server really advertises the free model ────────────────
  const capabilitiesResponse = await request.get("/api/opencode/capabilities");
  expect(capabilitiesResponse.ok(), "capabilities endpoint must answer").toBe(true);
  const capabilities = (await capabilitiesResponse.json()) as {
    models?: Array<{ id?: string; modelID?: string; providerID?: string }>;
  };
  const modelIds = (capabilities.models ?? []).map(
    (model) => `${model.providerID ?? ""}/${model.id ?? model.modelID ?? ""}`,
  );
  expect(modelIds, "opencode/big-pickle must be in the managed catalogue").toContain(MODEL);

  // ── 2. A disposable Code conversation bound to that model ─────────────────
  const created = await request.post("/api/conversations", {
    data: {
      title: "Big Pickle live probe",
      workspaceMode: "simple",
      engine: "opencode",
      opencodeAgent: "build",
      opencodeModel: MODEL,
    },
  });
  expect(created.ok()).toBe(true);
  const { id: conversationId } = (await created.json()) as { id: string };
  expect(conversationId).toBeTruthy();

  try {
    // Booting the session first proves the model is bound before the UI runs.
    const boot = await request.post("/api/opencode/session", {
      data: { conversationId },
    });
    expect(boot.ok(), "the real session seam must accept the conversation").toBe(true);
    const { sessionId } = (await boot.json()) as { sessionId: string };
    expect(sessionId).toBeTruthy();

    // ── 3. Open the Code surface and confirm the bound model is displayed ───
    await openCodeConversation(page, conversationId);
    const chip = page.getByRole("button", { name: "Model", exact: true });
    await expect(chip).toHaveText(/big.?pickle/i, { timeout: LIVE_TIMEOUT_MS });

    // ── 4. Send through the real composer and observe the real stream ───────
    const promptResponse = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "POST" &&
          /^\/api\/opencode\/(?:api\/)?session\/[^/]+\/prompt$/.test(url.pathname)
        );
      },
      { timeout: LIVE_TIMEOUT_MS },
    );

    const startedAt = Date.now();
    await sendPrompt(page, PROMPT);
    const admitted = await promptResponse;
    expect(admitted.ok(), `prompt must be admitted (got ${admitted.status()})`).toBe(true);
    const admittedAt = Date.now() - startedAt;

    const working = page.getByRole("button", { name: "OpenCode status: Working" });
    await working.waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });
    const workingAt = Date.now() - startedAt;

    const scroller = page.locator('[data-testid="virtual-transcript-scroller"]');
    await scroller.waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });

    const samples: Array<{ ms: number; chars: number }> = [];
    let lastChars = 0;
    let text = "";
    const deadline = Date.now() + LIVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      text = await scroller.innerText().catch(() => "");
      const chars = text.split(PROMPT).pop()?.trim().length ?? 0;
      if (chars !== lastChars) {
        samples.push({ ms: Date.now() - startedAt, chars });
        lastChars = chars;
      }
      if (/pickle-ok/i.test(text) && (await working.count()) === 0) break;
      await page.waitForTimeout(150);
    }
    const finishedAt = Date.now() - startedAt;

    await page.screenshot({ path: testInfo.outputPath("big-pickle.png") });

    console.log(
      `[big-pickle] admitted=${admittedAt}ms working=${workingAt}ms finished=${finishedAt}ms`,
    );
    console.log(`[big-pickle] growth samples: ${JSON.stringify(samples)}`);
    console.log(`[big-pickle] tail: ${JSON.stringify(text.slice(-400))}`);

    expect(text, "the model's answer must be rendered").toMatch(/pickle-ok/i);
    expect(
      samples.filter((sample) => sample.chars > 0).length,
      "the reply must arrive in more than one visible step (real streaming)",
    ).toBeGreaterThanOrEqual(2);

    // ── 5. The same answer survives a reload (history came from the session) ─
    await page.reload();
    await openCodeConversation(page, conversationId);
    await expect(page.getByText(/pickle-ok/i).first()).toBeVisible({
      timeout: LIVE_TIMEOUT_MS,
    });
  } finally {
    await deleteCodeConversation(request, conversationId);
  }
});
