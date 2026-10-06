import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  deleteCodeConversation,
  LIVE_TIMEOUT_MS,
  openCodeConversation,
} from "./opencode-live-fixtures";

/**
 * The Code model chip, against the REAL managed OpenCode server (nothing mocked).
 *
 * ## The bug under test
 *
 * A Code conversation with NO stored `opencodeModel` is still bound to a real
 * model, because `pickSessionModel` assigns the server's advertised default when
 * the session is created. That binding never writes the `opencodeModel` column,
 * so the chip has to fall back to what the native session is actually bound to
 * (`chipModelSource`'s NATIVE level). When that fallback does not reach the DOM,
 * a session running a real model on every turn displays as unbound.
 *
 * ## Why this is a live spec
 *
 * The whole point is the *real* default-driven binding. The hermetic E2E server
 * has no provider credentials, so it advertises no default, so no session is
 * ever bound and the case cannot be produced there. This needs a server whose
 * OpenCode instance can actually resolve a model.
 *
 * ## How the fixture is built — no React state is touched
 *
 * Everything is produced through the application's own APIs:
 *   1. `POST /api/conversations` with no `opencodeModel`  -> the column stays null
 *   2. `POST /api/opencode/session`                       -> the real session seam,
 *      which is what binds the server default
 *   3. `GET  /api/opencode/api/session/<id>`              -> proves it really is bound
 * Only then does the test open the Code surface and read the DOM.
 *
 * ## What the two cases prove together
 *
 * Case B (stored wins) is the CONTROL. It passes on today's code, which proves
 * the route, the selector, and the surface are all correct. That is what makes
 * Case A's failure attributable to the native fallback specifically, rather than
 * to a test that cannot find the chip at all.
 */

/** Verified present in this environment's catalogue. */
const STORED_MODEL = "agnes/agnes-3.0-flash";
const NATIVE_MODEL = "agnes/agnes-2.5-flash";

/** Creates a Code conversation, optionally with a stored model. */
async function createConversation(
  request: APIRequestContext,
  storedModel: string | null,
): Promise<string> {
  const response = await request.post("/api/conversations", {
    data: {
      title: "V2 chip probe",
      workspaceMode: "simple",
      engine: "opencode",
      opencodeAgent: "build",
      ...(storedModel === null ? {} : { opencodeModel: storedModel }),
    },
  });
  expect(response.ok()).toBe(true);
  const created = (await response.json()) as { id: string };
  expect(created.id).toBeTruthy();
  return created.id;
}

/** Reads a conversation row's stored OpenCode selection. */
async function readStoredModel(
  request: APIRequestContext,
  conversationId: string,
): Promise<string | null> {
  const response = await request.get(`/api/conversations/${conversationId}`);
  expect(response.ok()).toBe(true);
  const row = (await response.json()) as { opencodeModel?: string | null };
  return row.opencodeModel ?? null;
}

/**
 * Drives the real session seam and reports the model the native session is bound
 * to. The V2 proxy wraps responses in `data`.
 */
async function bootstrapSessionAndReadModel(
  request: APIRequestContext,
  conversationId: string,
): Promise<{ sessionId: string; nativeModel: string | null }> {
  const boot = await request.post("/api/opencode/session", {
    data: { conversationId },
  });
  expect(boot.ok()).toBe(true);
  const { sessionId } = (await boot.json()) as { sessionId: string };
  expect(sessionId).toBeTruthy();

  const read = await request.get(`/api/opencode/api/session/${sessionId}`);
  expect(read.ok()).toBe(true);
  const payload = (await read.json()) as {
    data?: { model?: { providerID: string; id: string } | null };
  };
  const model = payload.data?.model ?? null;
  return {
    sessionId,
    nativeModel: model === null ? null : `${model.providerID}/${model.id}`,
  };
}

/**
 * The chip button's visible text — its accessible name is the static "Model".
 *
 * `exact` is required, not decorative: the sidebar lists conversations as
 * buttons, so a non-exact name match also matches any conversation whose TITLE
 * contains the word "model" and the locator resolves to several elements.
 */
function modelChip(page: import("@playwright/test").Page) {
  return page.getByRole("button", { name: "Model", exact: true });
}

test.describe("Code model chip — native default binding", () => {
  test("CONTROL: a stored model is displayed, proving surface and selector", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const conversationId = await createConversation(request, STORED_MODEL);

    try {
      const bound = await bootstrapSessionAndReadModel(request, conversationId);
      // The control only means something if the session is genuinely bound.
      expect(bound.nativeModel).toBeTruthy();

      await openCodeConversation(page, conversationId);
      await expect(modelChip(page)).toHaveText(new RegExp(STORED_MODEL.split("/")[1]!, "i"), {
        timeout: LIVE_TIMEOUT_MS,
      });
    } finally {
      await deleteCodeConversation(request, conversationId);
    }
  });

  test("REGRESSION: no stored model, session bound by default -> chip shows the native model", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const conversationId = await createConversation(request, null);

    try {
      // 1. The stored column is null, and stays null. This is the precondition the
      //    whole case rests on, so it is asserted before anything is opened.
      expect(await readStoredModel(request, conversationId)).toBeNull();

      // 2. The real seam binds a model anyway.
      const bound = await bootstrapSessionAndReadModel(request, conversationId);
      console.log(`[chip] native session model: ${bound.nativeModel}`);
      expect(bound.nativeModel, "session should be bound by the server default").toBeTruthy();

      // 3. Open the Code surface and read the chip.
      await openCodeConversation(page, conversationId);

      // Evidence of the async transition: what the chip said before the wait, and
      // what it says once the native session state has had time to arrive.
      const initial = await modelChip(page).textContent();
      console.log(`[chip] text on first render: ${JSON.stringify(initial)}`);

      // The model id as the session actually carries it, asserted with a
      // RETRYING matcher. Hydration is asynchronous, so a one-shot read here
      // samples the pre-hydration label and fails a build that works.
      const boundId = bound.nativeModel!;
      const boundName = boundId.split("/")[1]!;
      await expect(modelChip(page)).toHaveText(new RegExp(boundName, "i"), {
        timeout: LIVE_TIMEOUT_MS,
      });
      const settled = await modelChip(page).textContent();
      console.log(`[chip] text after hydration: ${JSON.stringify(settled)}`);

      // The displayed model must be the one the session is actually bound to.
      expect(settled).toContain(boundName);

      // 4. Observing the native model must NOT have become a stored preference.
      expect(await readStoredModel(request, conversationId)).toBeNull();

      // 5. Reload: the same native model must still be displayed.
      await page.reload();
      await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
        timeout: LIVE_TIMEOUT_MS,
      });
      await expect(modelChip(page)).toHaveText(new RegExp(boundName, "i"), {
        timeout: LIVE_TIMEOUT_MS,
      });
    } finally {
      await deleteCodeConversation(request, conversationId);
    }
  });

  test("PRECEDENCE: a stored model wins over a different native session model", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const conversationId = await createConversation(request, STORED_MODEL);

    try {
      const bound = await bootstrapSessionAndReadModel(request, conversationId);

      // Move the NATIVE session to a different model, leaving the stored column
      // alone. This is the "stored A, native B" case the precedence rule covers.
      const switchBody = {
        model: {
          id: NATIVE_MODEL.split("/")[1]!,
          providerID: NATIVE_MODEL.split("/")[0]!,
        },
      };
      const switched = await request.post(
        `/api/opencode/api/session/${bound.sessionId}/model`,
        { data: switchBody },
      );
      expect(switched.ok()).toBe(true);

      const after = await request.get(`/api/opencode/api/session/${bound.sessionId}`);
      const payload = (await after.json()) as {
        data?: { model?: { providerID: string; id: string } | null };
      };
      const nativeNow = payload.data?.model
        ? `${payload.data.model.providerID}/${payload.data.model.id}`
        : null;
      console.log(`[chip] native after switch: ${nativeNow}`);
      expect(nativeNow).toBe(NATIVE_MODEL);

      // The stored choice must still be what is displayed.
      expect(await readStoredModel(request, conversationId)).toBe(STORED_MODEL);
      await openCodeConversation(page, conversationId);
      await expect(modelChip(page)).toHaveText(
        new RegExp(STORED_MODEL.split("/")[1]!, "i"),
        { timeout: LIVE_TIMEOUT_MS },
      );
    } finally {
      await deleteCodeConversation(request, conversationId);
    }
  });
});
