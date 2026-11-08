import { describe, expect, it } from "bun:test";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import {
  ASSISTANT_TOOL_MESSAGE,
  EVENT_INBOX_ID,
  HTTP_INBOX_ID,
  LOCAL_MESSAGE_ID,
  SERVER_VERSION,
  SESSION_ID,
  createGeneration,
  createRejectingAfterFirstClient,
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
 * H2's pin and its helper were deleted in Phase 4, with the finding, and M10's
 * went with its fix. M3's went with its fix in Phase 5.
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

describe("baseline: OpenCode V2 controller behaviour today", () => {
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
