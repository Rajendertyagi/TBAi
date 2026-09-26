import { expect, test } from "@playwright/test";
import {
  createCodeConversation,
  deleteCodeConversation,
  LIVE_MODEL,
  LIVE_TIMEOUT_MS,
  openCodeConversation,
  sendPrompt,
} from "./opencode-live-fixtures";

/**
 * Task 5's last open item: does a reloaded `edit` still render as a DIFF?
 *
 * This is the only acceptance path that needs a real browser AND a real model,
 * because the patch is not something the app can be handed — it is recorded by
 * OpenCode in `state.metadata.files[].patch` while the tool runs, and the
 * renderer can only reach it by reading the message metadata that a *reloaded*
 * history rebuild produces. Unit tests stop one link short: they inject
 * `diffPatch` as a prop, because `useOpenCodeEditPatch` needs an `AuiProvider`
 * and `web/` has no DOM harness.
 *
 * So the test drives the real thing: the model creates a file, edits it, and
 * the assertion is made after a full page reload — which forces the history
 * path, and therefore the hook, to be the thing under test.
 *
 * The discriminating assertion is the pair: the patched line must be visible
 * AND the literal `"Edit applied successfully."` must not. That is exactly the
 * difference between a surviving patch and a fallback to raw result text.
 */

const PROBE_FILE = "v2probe.txt";
const BEFORE_MARKER = "ALPHA_MARKER";
const AFTER_MARKER = "BETA_MARKER";
const RAW_RESULT_TEXT = "Edit applied successfully.";

// The tools are named explicitly and the shell is ruled out on purpose: left to
// its own devices the model sometimes reports that it has no `edit` tool and
// falls back to the shell, which is permission-gated and never produces a
// patch. That makes the prompt part of what is under test, not decoration.
const EDIT_PROMPT = [
  "You have a write tool and an edit tool available. Do not use the shell.",
  "Do exactly these two steps, in order, and nothing else:",
  `1. Use the write tool to create a file named ${PROBE_FILE} in the current working directory, containing exactly one line: ${BEFORE_MARKER}`,
  `2. Use the edit tool (not the shell) on that same file to replace ${BEFORE_MARKER} with ${AFTER_MARKER}`,
  "Do not modify any other file.",
].join(" ");

test.describe("native V2 edit diff across a reload (real server)", () => {
  test("a reloaded edit still renders the patch as a diff, not the result string", async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);
    const conversationId = await createCodeConversation(request, LIVE_MODEL);

    try {
      await openCodeConversation(page, conversationId);
      await sendPrompt(page, EDIT_PROMPT);

      // First, prove the live path produced a patch at all. Without this the
      // reload assertion below could pass on a card that never had a diff.
      const editCard = page.getByText(new RegExp(`edit · .*${PROBE_FILE}`)).first();
      await expect(editCard).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect(page.getByText(AFTER_MARKER).first()).toBeVisible({
        timeout: LIVE_TIMEOUT_MS,
      });
      await expect(page.getByText(RAW_RESULT_TEXT)).toHaveCount(0);

      // Now the acceptance criterion: rebuild everything from history.
      await page.reload();
      await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
        timeout: LIVE_TIMEOUT_MS,
      });

      const reloadedCard = page.getByText(new RegExp(`edit · .*${PROBE_FILE}`)).first();
      await expect(reloadedCard).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      // The patch survived the reload and is being rendered as a diff.
      await expect(page.getByText(AFTER_MARKER).first()).toBeVisible({
        timeout: LIVE_TIMEOUT_MS,
      });
      // ...and it is a diff, not the result string the card would fall back to.
      await expect(page.getByText(RAW_RESULT_TEXT)).toHaveCount(0);
    } finally {
      await deleteCodeConversation(request, conversationId);
    }
  });
});
