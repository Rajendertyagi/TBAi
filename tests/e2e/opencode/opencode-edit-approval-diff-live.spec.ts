import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  createCodeConversation,
  deleteCodeConversation,
  LIVE_TIMEOUT_MS,
  openCodeConversation,
  seedWorkspaceFile,
  sendPrompt,
  TARGET_FILE,
} from "../helpers/opencode-live-fixtures";

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
 * `edit` is normally configured to `allow`, so this environment must supply an
 * `edit/*` rule already set to `ask`. The spec CANNOT arm it any more: the app
 * refuses every configuration write (the managed document belongs to the user's
 * own installation, §9.3(1)), so the previous version — which PUT a rule and
 * restored it in `finally` — no longer applies and is gone.
 *
 * Requiring the rule from the environment is a precondition, not a setup step
 * this spec is responsible for, and it is stated in the skip message. It also
 * means the spec never mutates the maintainer's configuration.
 */

interface ConfigSnapshot {
  /** The document the server selected as the writable one, and its rules. */
  permissions?: { action: string; resource: string; effect: string }[] | null;
  /** False when the selected document cannot be parsed; writes would be refused. */
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
 *   - **the server is there but the config is unreadable**, or carries no
 *     `edit`/`*` rule → **fail**. That is a regression in the permissions API, or
 *     a config the server can no longer report — precisely the machinery this
 *     spec depends on, and exactly what a silent skip would have hidden.
 *   - **the rule is not `ask`** → skip, with the reason stated: the app will not
 *     arm it, so the environment has to. This is the one precondition the spec
 *     cannot satisfy by itself, and it says so instead of mutating the file.
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
  if (!Array.isArray(snapshot.permissions)) {
    return { kind: "broken", reason: "the OpenCode config reports no permission rules" };
  }
  for (const rule of snapshot.permissions) {
    if (rule.action === "edit" && rule.resource === "*") {
      return { kind: "readable", effect: rule.effect };
    }
  }
  return { kind: "broken", reason: "the config has no edit/* rule to arm" };
}

test.describe("edit approval shows the resulting change (live)", () => {
  test("the gate renders a diff, not the find/replace pair", async ({ page, request }) => {
    test.setTimeout(300_000);

    const state = await readEditState(request);
    // The one legitimate skip: there is no OpenCode server here, so the gate this
    // spec exists to inspect cannot come into existence.
    test.skip(state.kind === "no-server", "no OpenCode server in this environment");
    // Anything else is a failure, not a skip. See ConfigState. Thrown rather than
    // asserted, so the union narrows instead of being cast past the compiler.
    if (state.kind !== "readable") {
      throw new Error(
        `the OpenCode permissions API is not usable: ${
          state.kind === "broken" ? state.reason : state.kind
        }`,
      );
    }
    // The rule has to be `ask` before the prompt; the app refuses to arm it.
    test.skip(
      state.effect !== "ask",
      `the edit/* rule is "${state.effect}", and the app no longer writes configuration; start the app with edit/* set to ask to run this spec`,
    );

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
      await expect(page.getByRole("button", { name: /^(Allow|Approve)\b/ })).toBeVisible({
        timeout: LIVE_TIMEOUT_MS,
      });

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
      await deleteCodeConversation(request, conversationId);
    }
  });
});
