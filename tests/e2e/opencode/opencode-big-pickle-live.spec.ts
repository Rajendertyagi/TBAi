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
 * Why this cannot be a hermetic spec: the answer comes from a live provider and
 * the free tier is metered, so the run is opt-in (`TBAI_E2E_LIVE=1`) rather than
 * part of `verify`. A failed turn is not a pass: the answer is read from the
 * rendered transcript AND from the session's assistant content, so "the model
 * never answered" and "the UI never rendered the answer" stay distinguishable.
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

    // The turn-in-progress signal is the composer's Stop control, not the
    // connection heart. Since the status-ownership change the heart reports
    // TRANSPORT health only, so a healthy active turn reads "Connected" and
    // only a scheduled reconnect ever reads "Working" (see `statusView.ts`);
    // the Stop button is mounted for the whole of `thread.isRunning`, which is
    // exactly the fact this step needs.
    const running = page.getByRole("button", { name: "Stop generating" });
    await running.waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });
    const runningAt = Date.now() - startedAt;

    const scroller = page.locator('[data-testid="virtual-transcript-scroller"]');
    await scroller.waitFor({ state: "visible", timeout: LIVE_TIMEOUT_MS });

    // The answer is everything AFTER the echoed prompt. Matching the scroller's
    // whole text is vacuous here: the prompt itself contains "pickle-ok", so the
    // user's own message satisfies the check before the model has said anything,
    // and the samples then describe the prompt (the first live run failed its
    // streaming assertion for exactly that reason). Stripping the prompt leaves
    // the user row's timestamp/actions plus the assistant turn - the only place
    // the token can come from is the answer.
    const answerText = async () => {
      const whole = await scroller.innerText().catch(() => "");
      return whole.split(PROMPT).pop()?.trim() ?? "";
    };

    const samples: Array<{ ms: number; chars: number }> = [];
    let lastChars = 0;
    let text = "";
    // The user row's timestamp/actions are part of the stripped remainder and
    // appear before any answer text. They are a stable baseline, not a streaming
    // step, so the step count starts above them; otherwise one inserted answer
    // plus the baseline would look like two steps.
    let baselineChars = 0;
    const deadline = Date.now() + LIVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      text = await answerText();
      const chars = text.length;
      if (baselineChars === 0 && chars > 0) baselineChars = chars;
      if (chars !== lastChars) {
        samples.push({ ms: Date.now() - startedAt, chars });
        lastChars = chars;
      }
      if (/pickle-ok/i.test(text) && (await running.count()) === 0) break;
      await page.waitForTimeout(100);
    }
    const finishedAt = Date.now() - startedAt;

    // Distinguish "the model never answered" from "the answer exists on the
    // server but never reached the transcript". A UI-only assertion cannot tell
    // them apart, and they have completely different owners. This is the same
    // session read the reload below performs.
    const sessionRead = await request.get(`/api/opencode/api/session/${sessionId}/message`);
    type SessionRow = {
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    const sessionBody: { data?: SessionRow[] } = sessionRead.ok()
      ? ((await sessionRead.json()) as { data?: SessionRow[] })
      : {};
    const sessionRows = Array.isArray(sessionBody.data) ? sessionBody.data : [];
    const serverAnswer = sessionRows
      .filter((row) => row.type === "assistant")
      .flatMap((row) =>
        (row.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? ""),
      )
      .join("\n")
      .trim();

    await page.screenshot({ path: testInfo.outputPath("big-pickle.png") });

    console.log(
      `[big-pickle] admitted=${admittedAt}ms running=${runningAt}ms finished=${finishedAt}ms`,
    );
    console.log(`[big-pickle] growth samples: ${JSON.stringify(samples)}`);
    console.log(`[big-pickle] server answer chars: ${serverAnswer.length}`);
    console.log(`[big-pickle] tail: ${JSON.stringify(text.slice(-400))}`);

    expect(text, "the model's answer must be rendered").toMatch(/pickle-ok/i);
    expect(
      samples.filter((sample) => sample.chars > baselineChars).length,
      "the reply must arrive in more than one visible step (real streaming)",
    ).toBeGreaterThanOrEqual(2);

    // ── 5. The same answer survives a reload (history came from the session) ─
    await page.reload();
    await openCodeConversation(page, conversationId);
    // Prompt-stripped for the same reason as the live read: after the reload the
    // prompt is on screen again, and it also carries "pickle-ok".
    await expect.poll(answerText, { timeout: LIVE_TIMEOUT_MS }).toMatch(/pickle-ok/i);
  } finally {
    await deleteCodeConversation(request, conversationId);
  }
});
