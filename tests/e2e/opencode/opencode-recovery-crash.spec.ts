/**
 * Scenario B — abrupt managed OpenCode child crash during an unfinished turn.
 *
 * The stub provider holds the first model request, so the turn is genuinely
 * unfinished (user projected, execution started, no assistant, no idle marker).
 * The verified managed child is killed; the real manager restarts it and the
 * shared durable recovery service must continue the original turn. For an
 * already-projected user with a shutdown-interruption signal, the service posts
 * a FRESH recovery synthetic (re-posting the user id alone creates no inbox work
 * in OpenCode 2.2.6). A distinct assistant response must then be persisted in the
 * ORIGINAL session, with no duplicate logical user input.
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
  getProcessIdentity,
  pidAlive,
  requireEnv,
  verifyAndKillProcess,
  waitFor,
  waitForExecutionStarted,
} from "../../harness/opencodeRecoveryE2E";

const EVIDENCE_DIR = requireEnv("TBAI_RESTART_EVIDENCE_DIR");
const TEMP_ROOT = requireEnv("TBAI_RESTART_TEMP_ROOT");
const REGISTRATION_PATH = path.join(TEMP_ROOT, "xdg-state", "opencode", "service.json");

function writeEvidence(name: string, data: unknown): void {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, name), JSON.stringify(data, null, 2), "utf8");
}

function readRegistration(): any {
  return JSON.parse(fs.readFileSync(REGISTRATION_PATH, "utf8"));
}

test("abrupt managed-child crash recovers an unfinished turn in the original session", async ({
  request,
  page,
}: {
  request: APIRequestContext;
  page: Page;
}) => {
  test.setTimeout(360_000);
  const marker =
    process.env.TBAI_RESTART_FIXED_MARKER ||
    `CRASH-MARKER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let setup: Awaited<ReturnType<typeof createConversationAndSubmit>> | null = null;
  let oldPid: number | null = null;

  try {
    // 1-3. Create conversation + session, submit the prompt (stub holds it).
    setup = await createConversationAndSubmit(request, marker);
    writeEvidence("setup.json", setup);

    // 4. Wait for a real execution-start boundary.
    await waitForExecutionStarted(request, setup.sessionId);
    writeEvidence("execution-started.json", { at: Date.now(), sessionId: setup.sessionId });

    // 5. Prove the turn is genuinely unfinished before the crash.
    const before = await fetchAllMessages(request, setup.sessionId);
    assertUnfinished(before.messages, setup.promptId);
    writeEvidence("before-crash.json", { messages: before.messages, pageCount: before.pageCount });

    // 6. Record original IDs and the verified managed child identity.
    const regBefore = readRegistration();
    oldPid = regBefore?.pid;
    expect(typeof oldPid).toBe("number");
    const identity = getProcessIdentity(oldPid!);
    expect(identity?.Pid).toBe(oldPid);
    writeEvidence("child-identity-before.json", identity);

    // 7. Terminate ONLY the verified managed child.
    const kill = verifyAndKillProcess({
      pid: oldPid!,
      creationDate: identity?.CreationDate,
      exe: identity?.Exe,
      cmd: identity?.Cmd,
      ppid: identity?.PPid,
    });
    writeEvidence("child-kill.json", kill);
    await waitFor(async () => !pidAlive(oldPid!), 30_000, "old managed child dead");

    // 8-9. Wait for the real manager to publish a new managed target (new child).
    await waitFor(
      async () => {
        try {
          if (!fs.existsSync(REGISTRATION_PATH)) return false;
          const reg = readRegistration();
          return typeof reg?.pid === "number" && reg.pid !== oldPid && pidAlive(reg.pid);
        } catch {
          return false;
        }
      },
      RECOVERY_TIMEOUT_MS,
      "new managed child published",
    );
    const regAfter = readRegistration();
    const newIdentity = getProcessIdentity(regAfter.pid);
    // Verify the NEW child's identity too (not just a different live PID), so a
    // PID reuse cannot be mistaken for a successful managed restart.
    expect(newIdentity?.Pid).toBe(regAfter.pid);
    expect(newIdentity?.CreationDate).not.toBe(identity?.CreationDate);
    writeEvidence("child-identity-after.json", newIdentity);

    // 10-12. Wait for the shared recovery service to re-submit and the stub to
    // produce a distinct assistant response in the ORIGINAL session.
    await waitFor(
      async () => {
        const transcript = await fetchAllMessages(request, setup!.sessionId);
        return findAssistantResponse(transcript.messages, setup!.expectedResponse) !== undefined;
      },
      RECOVERY_TIMEOUT_MS,
      "assistant response persisted after crash recovery",
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

    // Conversation remains usable: reload the UI and see the assistant response.
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

    // No stale registration: the published child is alive and is not the old one.
    const finalReg = readRegistration();
    expect(finalReg.pid).not.toBe(oldPid);
    expect(pidAlive(finalReg.pid)).toBe(true);
  } finally {
    writeEvidence("final.json", { setup, oldPid, at: Date.now() });
  }
});
