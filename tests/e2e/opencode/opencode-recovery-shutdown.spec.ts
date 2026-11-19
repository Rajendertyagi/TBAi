/**
 * Scenario A — orderly application shutdown during an unfinished turn.
 *
 * The stub provider holds the first model request, so the turn is genuinely
 * unfinished (user projected, execution started, no assistant, no idle marker).
 * The spec drives the REAL production shutdown entry point through the runner's
 * control protocol (the runner writes {"type":"shutdown"} to TBAi's stdin), then
 * asks the runner to relaunch TBAi with the same durable data. The shared
 * recovery service must observe the new managed target and continue the original
 * turn by its stable message ID. A distinct assistant response must be persisted
 * in the ORIGINAL session, with no duplicate logical user input.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  RECOVERY_TIMEOUT_MS,
  assertUnfinished,
  countOriginalUser,
  createConversationAndSubmit,
  fetchAllMessages,
  fetchJson,
  findAssistantResponse,
  findAssistantResponses,
  requireEnv,
  waitFor,
  waitForExecutionStarted,
} from "../../harness/opencodeRecoveryE2E";

const EVIDENCE_DIR = requireEnv("TBAI_RESTART_EVIDENCE_DIR");
const CONTROL_DIR = requireEnv("TBAI_RESTART_CONTROL_DIR");

function writeEvidence(name: string, data: unknown): void {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, name), JSON.stringify(data, null, 2), "utf8");
}

async function control(command: "shutdown" | "start"): Promise<void> {
  fs.mkdirSync(CONTROL_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONTROL_DIR, `cmd.${command}`), "go", "utf8");
  await waitFor(
    async () => fs.existsSync(path.join(CONTROL_DIR, `done.${command}`)),
    RECOVERY_TIMEOUT_MS,
    `runner done.${command}`,
  );
}

test("orderly shutdown recovers an unfinished turn in the original session", async ({
  request,
  page,
}: {
  request: APIRequestContext;
  page: Page;
}) => {
  test.setTimeout(420_000);
  const marker =
    process.env.TBAI_RESTART_FIXED_MARKER ||
    `SHUTDOWN-MARKER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let setup: Awaited<ReturnType<typeof createConversationAndSubmit>> | null = null;

  try {
    // 1-3. Create conversation + session, submit the prompt (stub holds it).
    setup = await createConversationAndSubmit(request, marker);
    writeEvidence("setup.json", setup);

    // 4. Wait for a real execution-start boundary.
    await waitForExecutionStarted(request, setup.sessionId);
    writeEvidence("execution-started.json", { at: Date.now(), sessionId: setup.sessionId });

    // 5-6. Prove the turn is genuinely unfinished and the original intent durable.
    const before = await fetchAllMessages(request, setup.sessionId);
    assertUnfinished(before.messages, setup.promptId);
    writeEvidence("before-shutdown.json", {
      messages: before.messages,
      pageCount: before.pageCount,
    });

    // 7. Real production shutdown through the runner's stdin control.
    await control("shutdown");
    writeEvidence("shutdown-complete.json", { at: Date.now() });

    // 9. Restart the application with the same durable data.
    await control("start");
    writeEvidence("restart-complete.json", { at: Date.now() });

    // 10-13. Wait for the shared recovery service to re-submit and the stub to
    // produce a distinct assistant response in the ORIGINAL session.
    await waitFor(
      async () => {
        const transcript = await fetchAllMessages(request, setup!.sessionId);
        return findAssistantResponse(transcript.messages, setup!.expectedResponse) !== undefined;
      },
      RECOVERY_TIMEOUT_MS,
      "assistant response persisted after shutdown recovery",
    );

    const after = await fetchAllMessages(request, setup.sessionId);
    const assistant = findAssistantResponse(after.messages, setup.expectedResponse);
    expect(assistant).toBeDefined();
    // Exactly one distinct assistant response — no duplicate continuation.
    expect(findAssistantResponses(after.messages, setup.expectedResponse).length).toBe(1);
    writeEvidence("after-recovery.json", { messages: after.messages, pageCount: after.pageCount });

    // Original identity preserved; no duplicate logical user input.
    expect(countOriginalUser(after.messages, setup.promptId)).toBe(1);
    const sessionCheck = await fetchJson(
      request,
      `/api/opencode/api/session/${encodeURIComponent(setup.sessionId)}`,
      { headers: { "x-tbai-session": setup.sessionId } },
    );
    expect(sessionCheck.ok).toBe(true);

    // Conversation remains usable after restart: reload the UI.
    await page.goto(`/#/code/${setup.conversationId}`);
    await expect(page.getByText(setup.expectedResponse, { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    });
    writeEvidence(
      "ui-after-recovery.txt",
      await page
        .locator("main, body")
        .first()
        .innerText()
        .catch(() => ""),
    );
  } finally {
    writeEvidence("final.json", { setup, at: Date.now() });
  }
});
