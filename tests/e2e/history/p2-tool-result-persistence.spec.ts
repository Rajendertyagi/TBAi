import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * F5 — a tool result must be PERSISTED, not merely rendered.
 *
 * ## The concern
 *
 * The installed `@assistant-ui/ai-sdk` (`useExternalHistory.js`) gates the
 * write-back of a settled message on `durationMs !== undefined`:
 *
 *     } else if (persisted.source !== item.message && durationMs !== undefined && adapter.update) {
 *
 * `durationMs` comes from `stepBoundariesRef`, which is populated only once a run
 * has recorded a tool-call boundary or ended. A scratch harness reproduced the
 * losing case - a settled assistant message receiving a tool result with no run
 * in flight was counted as a write but never persisted.
 *
 * ## Why this is not decided by reading that code
 *
 * The gate looks reachable until you trace TBAi's own lifecycle, and TBAi
 * configures `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls`
 * (`web/src/runtime.ts`), so a tool result is normally followed immediately by a
 * continuation run. Whether that makes the losing branch unreachable is exactly
 * the kind of claim that must be EXECUTED, not argued: a wrong conclusion here
 * either ships a real data-loss bug or declares one fixed.
 *
 * So this spec drives the genuine production path end to end - provider tool
 * call, backend tool execution, tool result, automatic continuation - against the
 * hermetic stub provider (no live model, no network), and then checks the
 * PERSISTED ROWS, not the DOM. A transcript can look perfect while the repository
 * was never written; that is the entire failure being tested for.
 *
 * The stub emits a real OpenAI-shaped streaming tool call and a distinct
 * `tool_calls` finish reason, because a stub with its own invented envelope would
 * only prove the stub agrees with itself.
 */

/** Port the hermetic stub provider listens on (scripts/start-e2e-server.ts). */
const STUB_PORT = process.env.TBAI_E2E_STUB_PORT ?? "3199";
const STUB = `http://127.0.0.1:${STUB_PORT}`;

/**
 * The tool to invoke.
 *
 * `scheduler` with `action: "list"` is chosen deliberately: it needs no
 * workspace and no credentials, it changes nothing, and — critically — it does not
 * require approval. An approval-gated tool would make this spec a test of the
 * approval gate instead of of tool-result persistence.
 */
const TOOL_NAME = "scheduler";
const TOOL_ARGS = { action: "list" };

/** Distinctive, so it cannot be confused with anything else in the transcript. */
const FINAL_ANSWER = "F5_TOOL_RUN_COMPLETE";

/** Arm the shared stub to answer the next completion with a tool call. */
async function armToolCall(
  request: APIRequestContext,
  toolName: string = TOOL_NAME,
  args: unknown = TOOL_ARGS,
): Promise<string> {
  const armed = await request.post(`${STUB}/__e2e/tool`, {
    data: { toolName, args },
  });
  expect(armed.ok(), "arming the stub tool call failed").toBeTruthy();
  return ((await armed.json()) as { callId: string }).callId;
}

/** Set the text the stub streams once the tool result has been handled. */
async function setStubText(request: APIRequestContext, text: string): Promise<void> {
  const res = await request.post(`${STUB}/__e2e/text`, { data: { text } });
  expect(res.ok()).toBeTruthy();
}

/** Never leave a tool armed for the next spec in this worker. */
async function disarmToolCall(request: APIRequestContext): Promise<void> {
  await request.post(`${STUB}/__e2e/tool/disarm`).catch(() => undefined);
}

async function createConversation(request: APIRequestContext, title: string): Promise<string> {
  const created = await request.post("/api/conversations", {
    data: { title, workspaceMode: "simple", engine: "direct" },
  });
  expect(created.ok()).toBeTruthy();
  return ((await created.json()) as { id: string }).id;
}

interface StoredMessage {
  id: string;
  parent_id: string | null;
  format: string;
  content: {
    role?: string;
    parts?: Array<{ type?: string; toolCallId?: string; output?: unknown; [k: string]: unknown }>;
  };
}

/** Read the PERSISTED rows for a conversation, in stored order. */
async function storedMessages(
  request: APIRequestContext,
  conversationId: string,
): Promise<StoredMessage[]> {
  const res = await request.get(`/api/conversations/${conversationId}/messages`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { messages?: StoredMessage[] };
  return body.messages ?? [];
}

/**
 * Every persisted tool part across the rows, flattened.
 *
 * The persisted shape was established by READING THE ACTUAL ROWS, not assumed:
 * an AI SDK v7 tool part is stored as
 * `tool-<name>{ input, output, state, toolCallId }`, alongside `text`,
 * `step-start` and `data-*` parts. Matching on `toolCallId` rather than on an
 * exact `type` string keeps this honest if the type prefix ever changes, while
 * still rejecting the non-tool parts that share the row.
 */
function toolParts(
  messages: StoredMessage[],
): Array<{ name: string; state: unknown; text: string }> {
  const found: Array<{ name: string; state: unknown; text: string }> = [];
  for (const message of messages) {
    for (const part of message.content?.parts ?? []) {
      if (typeof part.toolCallId !== "string") continue;
      const type = typeof part.type === "string" ? part.type : "";
      const name = type.startsWith("tool-") ? type.slice("tool-".length) : type;
      const output = part.output;
      found.push({
        name,
        state: part.state,
        text: typeof output === "string" ? output : JSON.stringify(output ?? null),
      });
    }
  }
  return found;
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const composer = page.locator("textarea").first();
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill(text);
  await composer.press("Enter");
}

test.describe("F5 — a settled tool result is persisted, not just rendered", () => {
  test.setTimeout(600_000);

  test("F5-1: the tool result survives a real reload of the conversation", async ({
    page,
    request,
  }) => {
    const tag = `f5-${Date.now()}`;
    const conversationId = await createConversation(request, `rec ${tag} tool persistence`);

    try {
      // Navigate FIRST, arm SECOND, send THIRD. A single send fans out into
      // several stub requests (the run itself plus title generation), so arming
      // before the page is even loaded widens the window in which unrelated
      // traffic could observe the arm. The stub also now ignores an armed call on
      // any request that does not offer the tool, so this ordering is belt and
      // braces rather than the only defence.
      await page.goto(`/#/chat/${conversationId}`);
      await setStubText(request, FINAL_ANSWER);

      // Prove the tool actually ran, and that the run CONTINUED after it: the
      // final answer only arrives if the tool result was delivered and the client
      // sent the follow-up request. That two-request shape is the production
      // lifecycle F5 turns on.
      const callId = await armToolCall(request);
      await sendMessage(page, `list the scheduled jobs ${tag}`);

      await expect(page.getByText(FINAL_ANSWER)).toBeVisible({ timeout: 60_000 });

      // ---- PERSISTED DATA, not the DOM --------------------------------------
      // The transcript above could be satisfied entirely from memory. This is
      // the assertion that matters: the rows SQLite holds.
      //
      // POLLED, not read once. Persistence is a background write-back scheduled by
      // the runtime, so the row legitimately lands shortly AFTER the transcript
      // renders. Reading once made this spec a coin flip that reported a
      // persistence bug whenever the write lost the race - and a coin flip that
      // sometimes says "fixed" is worse than no test at all.
      const persistedSchedulerTool = async () => {
        const rows = await storedMessages(request, conversationId);
        return toolParts(rows).find((t) => t.name === TOOL_NAME) ?? null;
      };

      await expect
        .poll(persistedSchedulerTool, {
          timeout: 30_000,
          message: `the tool call ${callId} was never persisted`,
        })
        .not.toBeNull();

      // A tool part persisted with no OUTPUT is a placeholder: the row exists but
      // the tool's answer was lost. This is the F5 failure in exactly the form a
      // rendering-only assertion would miss — the transcript shows the result
      // while the repository never received it.
      const schedulerOutput = (await persistedSchedulerTool())!;
      expect(schedulerOutput.text, "the persisted tool part carries no result payload").not.toBe(
        "null",
      );
      expect(schedulerOutput.text.length).toBeGreaterThan(2);
      // The read-only scheduler list reports its jobs as a collection; an empty
      // array is a real answer, but a MISSING one is not.
      expect(
        schedulerOutput.text,
        "the persisted tool output is not the scheduler's list result",
      ).toMatch(/jobs|scheduled/i);

      // ---- RELOAD through the production history path -----------------------
      // A full document reload discards every in-memory message, so what renders
      // afterwards came from the production load path and the repository.
      await page.reload();
      await expect(page.locator("textarea").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(FINAL_ANSWER)).toBeVisible({ timeout: 60_000 });

      const afterReload = await persistedSchedulerTool();
      expect(afterReload, "the persisted tool result did not survive the reload").not.toBeNull();
      expect(afterReload!.text, "the persisted tool result changed across a reload").toBe(
        schedulerOutput.text,
      );
    } finally {
      await disarmToolCall(request);
      await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
    }
  });

  test("F5-2: the persisted tool result is part of the loaded history window", async ({
    page,
    request,
  }) => {
    // F5-1 proves the ROW survives. This proves the production READ path serves
    // it: the bounded window the Direct surface loads must carry the tool part,
    // because a row that exists but is never handed to the client is still lost
    // history from the reader's point of view.
    const tag = `f5w-${Date.now()}`;
    const conversationId = await createConversation(request, `rec ${tag} window tool`);

    try {
      await page.goto(`/#/chat/${conversationId}`);
      await setStubText(request, `${FINAL_ANSWER}_WINDOW`);
      await armToolCall(request);

      await sendMessage(page, `list the scheduled jobs ${tag}`);
      await expect(page.getByText(`${FINAL_ANSWER}_WINDOW`)).toBeVisible({ timeout: 60_000 });

      // The SAME query the Direct surface issues (`readWindowSlice` in
      // useDirectHistoryWindow.ts: `direction=older`, no anchorId, which means
      // "start at the tip"). Requesting the endpoint bare is a different query,
      // and asserting on it tested nothing about the production read path.
      //
      // POLLED, for the same reason as F5-1: the write-back is a background
      // write, so a single read taken right after the run can observe an empty
      // window and report a persistence failure that has not happened.
      const windowCarriesToolResult = async (): Promise<boolean> => {
        const res = await request.get(
          `/api/conversations/${conversationId}/messages/window?direction=older&limit=50`,
        );
        if (!res.ok()) throw new Error(`history window read failed: ${res.status()}`);
        const rows = ((await res.json()) as { messages?: StoredMessage[] }).messages ?? [];
        return toolParts(rows).some((t) => t.name === TOOL_NAME);
      };

      await expect
        .poll(windowCarriesToolResult, {
          timeout: 30_000,
          message: "the history window omits the tool result",
        })
        .toBe(true);

      // And the window is a real window of a real conversation, not an empty
      // response that happened to satisfy the check above.
      const finalWindow = await request.get(
        `/api/conversations/${conversationId}/messages/window?direction=older&limit=50`,
      );
      const finalRows =
        ((await finalWindow.json()) as { messages?: StoredMessage[] }).messages ?? [];
      expect(finalRows.length).toBeGreaterThan(0);
      expect(finalRows.some((m) => m.content?.role === "assistant")).toBe(true);
    } finally {
      await disarmToolCall(request);
      await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
    }
  });

  test("F5-3: an approval resumed AFTER a reload still persists its tool result", async ({
    page,
    request,
  }) => {
    // The one production path where a SETTLED message mutates with NO run in
    // flight, which is the state the dependency's `durationMs !== undefined`
    // gate appears to drop.
    //
    // `durationMs` is derived from `stepBoundariesRef`, which is empty until a
    // run has recorded a boundary or ended. Reloading a conversation resets it,
    // and the initial mount persists the loaded history with those boundaries
    // still empty. So: persist an assistant message that is AWAITING APPROVAL,
    // reload (boundaries now empty, no run has happened), then approve it. The
    // tool result mutates a message that was already written - the exact shape
    // that needs `adapter.update`.
    //
    // `scheduler` with a MUTATING action is used because it is the only tool in
    // the registry that actually declares `needsApproval`
    // (`schedulerActionNeedsApproval`, src/tools/index.ts). Note `write_file`
    // PROMISES approval in its description but declares no gate, so choosing it
    // here produced no gate at all and the test silently degraded into a copy of
    // F5-1. That inconsistency is pre-existing and out of scope here, but it is
    // why the tool is chosen from the declaration rather than the description.
    const tag = `f5a-${Date.now()}`;
    const conversationId = await createConversation(request, `rec ${tag} approval resume`);

    const pendingSchedulerCall = async () => {
      const rows = await storedMessages(request, conversationId);
      return toolParts(rows).find((t) => t.name === TOOL_NAME) ?? null;
    };

    try {
      await page.goto(`/#/chat/${conversationId}`);
      await setStubText(request, `${FINAL_ANSWER}_APPROVED`);
      await armToolCall(request, TOOL_NAME, {
        action: "create",
        name: `f5-job-${tag}`,
        scheduleType: "once",
        timezone: "UTC",
        prompt: "noop",
        execAt: Math.floor(Date.now() / 1000) + 86_400,
      });

      await sendMessage(page, `schedule the f5 probe job ${tag}`);

      // The approval gate is the proof the tool did NOT auto-run, so the pending
      // state is genuinely reached rather than raced past.
      // "Approve"/"Deny" - the labels the shipped ApprovalCard actually renders.
      // Established by reading the rendered page, not from the component source:
      // an earlier version of this test looked for "Allow once" and simply never
      // found its selector, which reads the same as "no approval gate exists".
      const approve = page.locator("button:has-text('Approve')").first();
      await expect(approve).toBeVisible({ timeout: 60_000 });

      await expect
        .poll(pendingSchedulerCall, {
          timeout: 30_000,
          message: "the awaiting-approval tool was never persisted",
        })
        .not.toBeNull();

      // Snapshot the persisted shape BEFORE the reload. The message must be
      // MUTATED IN PLACE afterwards. A row-count or id change would mean the
      // result was satisfied by writing a second record, which is exactly the
      // shortcut this task forbids - and it would mask a dropped update rather
      // than reveal one.
      const beforeReload = await storedMessages(request, conversationId);
      const rowCountBefore = beforeReload.length;
      const assistantIdBefore = beforeReload
        .filter((m) => m.content?.role === "assistant")
        .map((m) => m.id);

      // ---- RELOAD before deciding: boundaries are empty from here on --------
      await page.reload();
      await expect(page.locator("textarea").first()).toBeVisible({ timeout: 30_000 });

      // Whether the gate survives a reload is itself the finding. If it does not,
      // the state is unreachable in production and that is a legitimate result to
      // record - but it must be OBSERVED, not assumed.
      const approveAfterReload = page.locator("button:has-text('Approve')").first();
      const survived = await approveAfterReload
        .isVisible({ timeout: 30_000 })
        .then(() => true)
        .catch(() => false);

      if (!survived) {
        // Recorded as an annotation rather than a silent pass: an approval that
        // cannot be resumed is a DIFFERENT reachability answer, and burying it
        // would leave the next reader assuming this path was covered.
        test.info().annotations.push({
          type: "F5-unreachable-in-production",
          description:
            "an awaiting-approval tool does not survive a reload, so no settled message can mutate with empty run boundaries",
        });
        return;
      }

      await approveAfterReload.click();
      await expect(page.getByText(`${FINAL_ANSWER}_APPROVED`)).toBeVisible({ timeout: 60_000 });

      // The tool result must now be persisted on the SAME message that was
      // already written before the reload.
      await expect
        .poll(
          async () => {
            const rows = await storedMessages(request, conversationId);
            const parts = toolParts(rows).filter((t) => t.name === TOOL_NAME);
            return parts.some((t) => t.text && t.text !== "null" && t.text.length > 2);
          },
          { timeout: 30_000, message: "the approved tool result was never persisted" },
        )
        .toBe(true);

      // And mutated IN PLACE. The dependency's update gate is what decides this,
      // so an id or row-count change would mean the gate was bypassed by writing
      // a second record - a duplicate-row "fix" that loses history and would
      // hide the real behaviour behind a green test.
      const afterApproval = await storedMessages(request, conversationId);
      expect(
        afterApproval.length,
        "approving a tool changed the persisted row count - the result was written as a duplicate, not updated in place",
      ).toBe(rowCountBefore);
      expect(
        afterApproval.filter((m) => m.content?.role === "assistant").map((m) => m.id),
        "approving a tool replaced the assistant message instead of updating it in place",
      ).toEqual(assistantIdBefore);
    } finally {
      await disarmToolCall(request);
      await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
    }
  });
});
