import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  createCodeConversation,
  deleteCodeConversation,
  LIVE_TIMEOUT_MS,
  openCodeConversation,
  seedWorkspaceFile,
  sendPrompt,
  TARGET_FILE,
} from "./opencode-live-fixtures";


/**
 * A pending edit approval shows the ACTUAL CHANGE, not the model's find/replace.
 *
 * Live acceptance for the P1 fix. Nothing mocked: a real Code conversation, a
 * real model, the real managed OpenCode server, and a real permission request.
 * The test only sets one permission rule, types into the composer, and reads the
 * DOM.
 *
 * Why it must be live rather than seeded. The preview rides on the permission
 * request, and a permission is not something a seed can produce - the projection
 * builds it from server state. So the only way to see the gate render a diff is
 * to make the server ask for one.
 *
 * `edit` is normally configured to `allow`, so the spec sets that one rule to
 * `ask` and puts it back. It goes through TBAi's own permission API rather than
 * editing the config file: the config path is XDG-resolved on the host, so a spec
 * that hardcoded or discovered it would be a second source of truth for a file
 * the app already knows how to edit safely. The previous effect is read back
 * from the API and restored in `finally`, so a failure mid-test still puts the
 * user's configuration the way it was.
 */

interface ConfigSnapshot {
  /** The document the server selected as the writable one, and its rules. */
  permissions?: { action: string; resource: string; effect: string }[] | null;
  /** False when the selected document cannot be parsed; writes will be refused. */
  editable?: boolean;
}

/** One `edit` rule's current effect, or null when the config cannot be read. */
async function readEditEffect(request: APIRequestContext): Promise<string | null> {
  const response = await request.get("/api/opencode/config");
  if (!response.ok()) return null;
  const snapshot = (await response.json()) as ConfigSnapshot;
  if (snapshot.editable !== true) return null;
  for (const rule of snapshot.permissions ?? []) {
    if (rule.action === "edit" && rule.resource === "*") return rule.effect;
  }
  return null;
}

async function setEditEffect(
  request: APIRequestContext,
  effect: "allow" | "ask",
): Promise<boolean> {
  const response = await request.put("/api/opencode/config/permissions", {
    data: { action: "edit", resource: "*", effect },
  });
  return response.ok();
}

test.describe("edit approval shows the resulting change (live)", () => {
  test("the gate renders a diff, not the find/replace pair", async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);

    const previous = await readEditEffect(request);
    test.skip(previous === null, "the OpenCode config is not readable here");
    const armed = await setEditEffect(request, "ask");
    test.skip(armed === false, "the edit permission could not be set to ask");

    const conversationId = await createCodeConversation(request);
    // The file has to exist. A prompt asking a model to edit a missing file
    // sends it hunting instead - the turn ends in a glob and a directory read,
    // with no edit ever proposed, which is indistinguishable from this feature
    // being broken.
    seedWorkspaceFile(
      conversationId,
      TARGET_FILE,
      ["# probe", "", "TBAI_EDIT_ME", "", "trailing line", ""].join("\n"),
    );
    try {
      await openCodeConversation(page, conversationId);
      await sendPrompt(
        page,
        `Use the edit tool to change the single line "TBAI_EDIT_ME" to "TBAI_EDITED" in ${TARGET_FILE}. Make the edit now, and do not use any other tool.`,
      );

      // The real gate.
      await expect(
        page.getByRole("button", { name: /^(Allow|Approve)\b/ }),
      ).toBeVisible({ timeout: LIVE_TIMEOUT_MS });

      // The change, as a diff. `data-slot="opencode-pending-diff"` is set by the
      // component that renders the pending patch, so its presence is the feature
      // itself rather than a coincidence of styling.
      const diff = page.locator('[data-slot="opencode-pending-diff"]');
      await expect(diff).toBeVisible({ timeout: 30_000 });
      await expect(diff).toContainText("TBAI_EDIT_ME");
      await expect(diff).toContainText("TBAI_EDITED");

      // It is a real diff, so the counts are real: one line out, one line in.
      await expect(diff).toContainText("+1");
      await expect(diff).toContainText("-1");

      // And the find/replace pair is GONE. This is the assertion the old pinned
      // test inverted; leaving it in would mean the reader sees the model's
      // description as well as the change, and would read as "this is everything
      // that is going to change".
      await expect(page.getByText("Replace with:")).toHaveCount(0);
    } finally {
      if (previous === "allow" || previous === "ask") {
        await setEditEffect(request, previous);
      }
      await deleteCodeConversation(request, conversationId);
    }
  });
});
