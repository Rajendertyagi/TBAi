/**
 * T5 - a failed history read leaves the runtime RECOVERABLE, and later events
 * are still applied.
 *
 * ## THE GAP THIS CLOSES
 *
 * The plan's T5 says: *"rejects the history read, then emits a delta and
 * asserts it is applied"*. The first half was asserted - a failed read reaches
 * a **defined** state rather than a runtime stuck behind a hydration flag that
 * never clears. The second half was not: nothing asserted that a delta
 * arriving **after** a history-read failure still lands in the transcript.
 *
 * That is the difference between "the runtime is in a defined state" and "the
 * runtime is alive". A runtime that stops applying events after one failed
 * read is frozen: the reader sees a stale transcript with no error to act on,
 * and nothing says so.
 *
 * ## WHY THE RECOVERY PATH IS THE ONE EXERCISED
 *
 * The failure is a CONNECTION failure: a failed history read is a failed
 * attempt, and the runtime retries. So the delta is emitted against the
 * SECOND generation - the one that recovered - which is the state a reader
 * would actually be in after the recovery.
 */

import { describe, expect, it } from "bun:test";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import {
  createClient,
  createGeneration,
  waitForState,
  assistantTextStarted,
  assistantTextDelta,
  LIVE_ASSISTANT_MESSAGE_ID,
} from "@web/testing/opencode/v2ThreadControllerHarness";

describe("T5 - a failed history read leaves the runtime alive", () => {
  it("applies a delta that arrives AFTER the failed read, once the runtime recovers", async () => {
    const failing = createGeneration(1, {
      historyList: async () => {
        throw new Error("history read failed");
      },
    });
    const recovered = createGeneration(2);
    const client = createClient([failing, recovered]);
    const controller = createV2ThreadController(client, {
      maxReconnectAttempts: 1,
      initialReconnectDelayMs: 10,
      maxReconnectDelayMs: 10,
    });

    try {
      void controller.load().catch(() => undefined);

      // The runtime recovers: the failed read became a connection failure and
      // the next attempt succeeded.
      await waitForState(controller, (state) => state.load.type === "ready");
      expect(controller.getState().connection.type).toBe("connected");

      // A delta arrives AFTER the failure and the recovery.
      recovered.events.emit(assistantTextStarted());
      recovered.events.emit(assistantTextDelta());

      // And it is APPLIED. A runtime that stopped reducing events after the
      // failed read would leave the transcript empty here, with no error to
      // show for it.
      await waitForState(
        controller,
        (state) =>
          state.messages[LIVE_ASSISTANT_MESSAGE_ID]?.parts.some(
            (part) => part.kind === "text" && part.value === "live response",
          ) === true,
      );

      const message = controller.getState().messages[LIVE_ASSISTANT_MESSAGE_ID];
      expect(
        message?.parts.some((part) => part.kind === "text" && part.value === "live response"),
      ).toBe(true);
    } finally {
      controller.dispose();
    }
  });
});
