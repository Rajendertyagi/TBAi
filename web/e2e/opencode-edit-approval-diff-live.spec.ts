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

/**
 * Why this one is NOT skipped, and the one that is.
 *
 * `seedConversation.ts` records the trap this file nearly fell into: specs used to
 * `test.skip` when a precondition was missing and "still reported green. A skipped
 * test proves nothing." A skip on *setup* is the worst version of that, because
 * the setup is the part this spec is responsible for.
 *
 * So the causes are kept apart rather than collapsed into one `null`:
 *
 *   - **no OpenCode server at all** (`GET` does not answer) → skip. The feature
 *     genuinely does not exist in that environment; there is nothing to assert.
 *   - **the server is there but the config is not editable**, or carries no
 *     `edit`/`*` rule → **fail**. That is a regression in the permissions API, or
 *     a config the app can no longer write — precisely the machinery this spec
 *     depends on, and exactly what a silent skip would have hidden.
 *   - **the write is refused** → **fail**, for the same reason.
 *
 * An earlier version returned `null` for all three and skipped on any of them,
 * which is how this spec could report green on a run where it had tested nothing.
 */
type ConfigState =
  | { readonly kind: "no-server" }
  | { readonly kind: "readable"; readonly effect: string }
  | { readonly kind: "broken"; readonly reason: string };

/** The `edit` rule's current effect, and whether this environment can test at all. */
async function readEditState(request: APIRequestContext): Promise<ConfigState> {
  const response = await request.get("/api/opencode/config");
  // No server, or the route is absent because OpenCode is not running here.
  if (!response.ok()) return { kind: "no-server" };
  const snapshot = (await response.json()) as ConfigSnapshot;
  if (snapshot.editable !== true) {
    return { kind: "broken", reason: "the OpenCode config is not editable" };
  }
  for (const rule of snapshot.permissions ?? []) {
    if (rule.action === "edit" && rule.resource === "*") {
      return { kind: "readable", effect: rule.effect };
    }
  }
  return { kind: "broken", reason: "the config has no edit/* rule to arm" };
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

    const state = await readEditState(request);
    // The one legitimate skip: there is no OpenCode server here, so the gate this
    // spec exists to inspect cannot come into existence.
    test.skip(state.kind === "no-server", "no OpenCode server in this environment");
    // Anything else is a failure, not a skip. See ConfigState. Thrown rather than
    // asserted, so the union narrows instead of being cast past the compiler.
    if (state.kind !== "readable") {
      throw new Error(`the OpenCode permissions API is not usable: ${state.reason}`);
    }
    const previous = state.effect;

    const armed = await setEditEffect(request, "ask");
    expect(armed, "the edit permission could not be set to ask").toBe(true);

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
