/**
 * M5's outstanding hold — the hydration buffer's backstop must not be silent.
 *
 * ## THE DEFECT THIS PINS
 *
 * The backstop dropped the oldest held events when more than 4,096 distinct
 * events arrived during one read, and it did so **silently**: no log, no
 * diagnostic, and no change of the attempt's readiness. The runtime then
 * committed the transcript and reported `load_completed` — that is, it claimed
 * a successful reconciliation of a transcript that was missing events.
 *
 * A log alone would not fix that, because a log does not recover the events and
 * does not stop the runtime claiming success. The loss has to reach the
 * reconciliation path.
 *
 * ## WHAT IS PINNED HERE
 *
 * - the loss is announced (the warning);
 * - the loss is counted in the domain state;
 * - and the runtime does NOT report a successful reconciliation: the attempt's
 *   readiness is failed, so the reconnect re-reads a fresh snapshot.
 */

import { describe, expect, it } from "bun:test";
import type { SessionMessagesResponse, V2Event } from "@opencode/client";
import { OPENCODE_V2_EVENT_BUFFER_LIMIT } from "@web/features/opencode/config.ts";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import {
  createClient,
  createGeneration,
  deferred,
} from "@web/testing/opencode/v2ThreadControllerHarness";

/** A text delta for the given message and ordinal. */
function textDelta(id: string, messageId: string, ordinal: number): V2Event {
  return {
    id,
    created: 10,
    type: "session.text.delta",
    data: { sessionID: "ses_buffer_test", assistantMessageID: messageId, ordinal, delta: "x" },
  } as V2Event;
}

/**
 * A generation whose history read is held open, so events can arrive DURING
 * the read and be HELD rather than applied.
 */
function createHeldGeneration() {
  const readStarted = deferred<void>();
  const read = deferred<SessionMessagesResponse>();
  const generation = createGeneration(1, {
    historyList: () => {
      readStarted.resolve(undefined);
      return read.promise;
    },
  });
  return { generation, readStarted, read };
}

/** Fills the buffer past its limit, with events that never coalesce. */
async function overflowTheBuffer(generation: ReturnType<typeof createGeneration>) {
  const overflow = OPENCODE_V2_EVENT_BUFFER_LIMIT + 10;
  for (let index = 0; index < overflow; index += 1)
    generation.events.emit(textDelta(`evt_${index}`, `assistant_${index}`, 0));
  // Let the event loop drain them into the buffer.
  await new Promise((r) => setTimeout(r, 50));
}

describe("the hydration buffer's backstop", () => {
  it("does not report a successful reconciliation after events were lost", async () => {
    const { generation, readStarted, read } = createHeldGeneration();
    const controller = createV2ThreadController(createClient([generation]));

    try {
      const ready = controller.awaitReady();
      await readStarted.promise;
      await overflowTheBuffer(generation);
      read.resolve({ data: [], cursor: {} });

      // The runtime must NOT come up claiming a complete transcript. The
      // attempt's readiness is failed when the overflow is reported, so the
      // hydration never commits and the runtime reports a failure.
      const outcome = await ready.then(
        () => "ready" as const,
        () => "failed" as const,
      );
      expect(outcome).toBe("failed");

      // And the loss is on the record in the domain state, in its OWN field:
      // the diagnostic count counts events the runtime ignored for other
      // reasons, and a LOSS must not be indistinguishable from an ignored
      // event.
      expect(controller.getState().droppedEventCount).toBeGreaterThan(0);
      // The load state is an error, not "ready": the runtime is not claiming a
      // reconciled transcript.
      expect(controller.getState().load.type).not.toBe("ready");
    } finally {
      controller.dispose();
    }
  });

  it("counts the loss in the domain state, bounded", async () => {
    // The diagnostic counter is capped, like every counter in the reducer, so a
    // huge loss does not inflate it past the cap.
    const { generation, readStarted, read } = createHeldGeneration();
    const controller = createV2ThreadController(createClient([generation]));

    try {
      const ready = controller.awaitReady().catch(() => undefined);
      await readStarted.promise;
      await overflowTheBuffer(generation);
      read.resolve({ data: [], cursor: {} });
      await ready;

      const count = controller.getState().droppedEventCount;
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(256);
    } finally {
      controller.dispose();
    }
  });
});
