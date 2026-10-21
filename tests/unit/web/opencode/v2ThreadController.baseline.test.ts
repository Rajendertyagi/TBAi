import { describe, expect, it } from "bun:test";
import type { SessionMessagesResponse, V2Event } from "@opencode/client";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import {
  ASSISTANT_TOOL_MESSAGE,
  EVENT_INBOX_ID,
  HTTP_INBOX_ID,
  LIVE_ASSISTANT_MESSAGE_ID,
  LOCAL_MESSAGE_ID,
  PERMISSION,
  SERVER_VERSION,
  SESSION_ID,
  USER_MESSAGE,
  createClient,
  createGeneration,
  createRejectingAfterFirstClient,
  deferred,
  inboxEvent,
  waitForState,
} from "@web/testing/opencode/v2ThreadControllerHarness";

/**
 * BASELINE CHARACTERIZATION — the behaviour this controller has **today**.
 *
 * ## WHY THIS FILE EXISTS
 *
 * The October 2026 audit found defects in this controller that were invisible
 * to the suite because no test exercised the paths they live on. A fix for
 * such a defect cannot be *proved* by a test written after the fix: the
 * honest way to prove a fix is to pin the broken behaviour first, watch the
 * correct assertion fail, and then change the code.
 *
 * So every test here asserts **today's behaviour, defects included**. They
 * pass now, and each names the finding whose fix will delete it.
 *
 * ## THE CONTRACT WITH THE FIX
 *
 * When a finding is fixed, the test that pins it is **deleted in the same
 * commit** that fixes it, and the defect-regression test that replaces it
 * (`opencodeFindings.quarantine.test.ts`, promoted from `test.todo` to
 * `test`) takes over. A baseline test that survives its own fix is a finding
 * that was not really fixed.
 *
 * ## WHAT "PASSES TODAY" MEANS HERE
 *
 * These are not endorsements. A test that says "the assistant's text is
 * erased" is saying: *that is what the code does*, so the fix has a
 * starting point and a visible before/after.
 *
 * ## A NOTE ON THE HARNESS
 *
 * `client.connectCount` is the index of the NEXT connection, so the
 * generation serving the live attempt is `generations[connectCount - 1]`.
 * `client.waitForConnect(1)` is deliberately unused: the first connect
 * happens before the harness has wired its completion signal, so awaiting it
 * would wait forever. Waiting for `load.type === "loading"` is the reliable
 * signal instead — it is dispatched after `consumeEvents` has subscribed, so
 * the stream is guaranteed to have a waiter by the time the test fails it.
 */

/** The empty page the harness serves when a test does not supply one. */
const EMPTY_PAGE: SessionMessagesResponse = { data: [], cursor: {} };

/**
 * A delta the assistant streamed while the runtime was still hydrating.
 *
 * `sessionID` is present because the real V2 event carries it, and the
 * reducer's session filter reads it: an event without one BYPASSES the filter
 * instead of passing it, so omitting it would make the test exercise a shape
 * the server never sends.
 */
function hydrationTimeDelta(id: string, delta: string): V2Event {
  return {
    id,
    created: 10,
    type: "session.text.delta",
    data: {
      sessionID: SESSION_ID,
      assistantMessageID: LIVE_ASSISTANT_MESSAGE_ID,
      ordinal: 0,
      delta,
    },
  };
}

/** Waits until the controller reports it is hydrating. */
async function waitForHydration(controller: ReturnType<typeof createV2ThreadController>) {
  await waitForState(controller, (state) => state.load.type === "loading");
}

describe("baseline: OpenCode V2 controller behaviour today", () => {
  describe("H2 — an event received during hydration is erased", () => {
    it("applies the delta during hydration and then loses it to the reprojection", async () => {
      // The history read is held open, so the delta arrives while the runtime is
      // still hydrating and is buffered rather than applied.
      const history = deferred<SessionMessagesResponse>();
      const generation = createGeneration(1, {
        historyList: () => history.promise,
      });
      const client = createClient([generation]);
      const controller = createV2ThreadController(client);

      try {
        void controller.load().catch(() => undefined);
        await waitForHydration(controller);

        generation.events.emit(hydrationTimeDelta("evt_h2_delta", "streamed during hydration"));
        await new Promise((resolve) => setTimeout(resolve, 0));

        history.resolve(EMPTY_PAGE);
        await waitForState(controller, (state) => state.load.type === "ready");
        await new Promise((resolve) => setTimeout(resolve, 0));

        // PINNED DEFECT (H2): the delta was applied and then discarded by the
        // second history projection, so the transcript has no trace of it.
        expect(controller.getState().messages[LIVE_ASSISTANT_MESSAGE_ID]).toBeUndefined();
        expect(controller.getState().messageOrder).not.toContain(LIVE_ASSISTANT_MESSAGE_ID);
      } finally {
        controller.dispose();
      }
    });
  });

  /**
   * The control that proves the ceiling was never the broken part.
   *
   * M1 was an accounting defect on the *stream-failure* path: a superseded
   * attempt reached the shared reset on its way out. The pin that asserted
   * that behaviour is deleted with the fix. This case stays because the
   * connect-failure path was already correct and must not regress.
   */
  describe("the retry ceiling on the connect-failure path", () => {
    it("CONTROL: the ceiling IS reached when the retries fail to connect", async () => {
      // The same controller, with the failure moved to the connect step. This
      // is the path the existing suite already covers, and it is here so the
      // baseline says explicitly WHICH path is broken.
      const generation = createGeneration(1);
      const client = createRejectingAfterFirstClient([generation]);
      const controller = createV2ThreadController(client, {
        maxReconnectAttempts: 3,
        initialReconnectDelayMs: 10,
      });

      try {
        await controller.awaitReady();
        generation.events.fail(new Error("stream died after hydration"));
        await waitForState(controller, (state) => state.connection.type === "failed");
        expect(controller.getState().connection).toEqual({ type: "failed", attempt: 3 });
        expect(client.connectCount).toBe(4);
      } finally {
        controller.dispose();
      }
    });
  });

  describe("M3 - an ambiguous prompt never settles", () => {
    it("leaves sendMessage pending when the request fails non-definitively", async () => {
      const generation = createGeneration(1);
      const client = createClient([generation]);
      const controller = createV2ThreadController(client);
      await controller.awaitReady();

      try {
        generation.setPromptHandler(async () => {
          // A 5xx is explicitly NOT a definitive rejection.
          const error = new Error("upstream 503") as Error & { status?: number };
          error.status = 503;
          throw error;
        });

        let settled = false;
        const sending = controller.sendMessage(USER_MESSAGE, { messageId: LOCAL_MESSAGE_ID }).then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );

        // Give the failure path every microtask it needs.
        for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));

        // PINNED DEFECT (M3): the admission is known to be ambiguous, but the
        // promise `sendMessage` awaits is never settled.
        expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("ambiguous");
        expect(settled).toBe(false);

        // Only an explicit reconciliation settles it — and nothing in the
        // frontend calls that.
        await controller.reconcilePendingPrompt(LOCAL_MESSAGE_ID);
        await sending;
        expect(settled).toBe(true);
      } finally {
        controller.dispose();
      }
    });
  });

  describe("M10 — a failed auxiliary read clears the live permission", () => {
    it("removes the pending permission when the permission list read fails", async () => {
      let call = 0;
      const generation = createGeneration(1, {
        permissionList: async () => {
          call += 1;
          if (call === 1) return [PERMISSION];
          throw new Error("permission list unavailable (503)");
        },
      });
      const client = createClient([generation]);
      const controller = createV2ThreadController(client);

      try {
        await controller.awaitReady();
        expect(controller.getState().permissions).toEqual([PERMISSION]);

        await controller.resyncAuxiliary();
        await new Promise((r) => setTimeout(r, 10));

        // PINNED DEFECT (M10): a failed read is indistinguishable from an
        // authoritative empty list, so the pending permission disappears.
        expect(controller.getState().permissions).toEqual([]);
      } finally {
        controller.dispose();
      }
    });

    it("CONTROL: an authoritative empty list clears it too, so the two must be told apart", async () => {
      let call = 0;
      const generation = createGeneration(1, {
        permissionList: async () => {
          call += 1;
          return call === 1 ? [PERMISSION] : [];
        },
      });
      const client = createClient([generation]);
      const controller = createV2ThreadController(client);

      try {
        await controller.awaitReady();
        expect(controller.getState().permissions).toEqual([PERMISSION]);

        await controller.resyncAuxiliary();
        await new Promise((r) => setTimeout(r, 10));

        expect(controller.getState().permissions).toEqual([]);
      } finally {
        controller.dispose();
      }
    });
  });

  describe("baseline values the rest of the suite depends on", () => {
    it("exposes the identity the harness pins", () => {
      // These are not defects. They are recorded so a future change that moves
      // them is a visible diff rather than a silent one.
      expect(SESSION_ID).toBe("ses_v2_controller_test");
      expect(SERVER_VERSION).toBe("2.0.16");
      expect(ASSISTANT_TOOL_MESSAGE.id).toBe("assistant-1");
      expect(EVENT_INBOX_ID).toBe("inbox_event_controller_test");
      expect(HTTP_INBOX_ID).toBe("inbox_http_controller_test");
    });

    it("records an inbox event that admits a prompt", () => {
      const event = inboxEvent(EVENT_INBOX_ID, LOCAL_MESSAGE_ID, "queue");
      expect(event.type).toBe("session.inbox.enqueued");
    });
  });
});
