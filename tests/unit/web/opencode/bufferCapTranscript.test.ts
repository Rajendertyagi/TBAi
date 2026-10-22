/**
 * T2 - hundreds of events crossing the buffer cap cannot empty the buffer or
 * corrupt the transcript.
 *
 * ## THE GAP THIS CLOSES
 *
 * The plan's T2 says: *"drives >512 deltas during hydration and asserts both
 * the surviving window and the final text"*. The buffer-level case was
 * covered - `eventPipelineBuffer.test.ts` drives 600 deltas and asserts the
 * text survives in the buffer - and the overflow case was covered - the
 * backstop refuses to claim a successful reconciliation when the loss is real.
 *
 * What was not covered was the **whole** path: hundreds of deltas arriving
 * during a real hydration, the history read committing, and the FINAL
 * TRANSCRIPT. That is the end a reader sees, and it is the end that matters:
 * a buffer that survives 600 deltas proves nothing if the commit that follows
 * erases them.
 *
 * ## WHY 600, AND WHY THE READ IS HELD
 *
 * 600 is well past the 512 the plan names, and it is past the reducer's
 * 256-item window, so the run exercises the coalescing path rather than the
 * one-entry-per-delta path.
 *
 * The read is HELD while the deltas arrive, because that is the window the
 * buffer exists for: the deltas are held, then the snapshot commits, then the
 * held events are replayed onto it.
 */

import { describe, expect, it } from "bun:test";
import type { SessionMessagesResponse, V2Event } from "@opencode/client";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import {
  createClient,
  createGeneration,
  deferred,
  SESSION_ID,
} from "@web/testing/opencode/v2ThreadControllerHarness";

const MESSAGE_ID = "assistant_buffer_test";

/** The `session.text.started` event that opens the message. */
function textStarted(): V2Event {
  return {
    id: "evt_buffer_started",
    created: 9,
    type: "session.text.started",
    data: { sessionID: SESSION_ID, assistantMessageID: MESSAGE_ID, ordinal: 0 },
  } as V2Event;
}

/** A text delta for the given message and ordinal. */
function textDelta(id: string, ordinal: number, delta: string): V2Event {
  return {
    id,
    created: 10,
    type: "session.text.delta",
    data: { sessionID: SESSION_ID, assistantMessageID: MESSAGE_ID, ordinal, delta },
  } as V2Event;
}

/** The text the controller's transcript holds for the streamed message. */
function transcriptText(parts: readonly { kind: string; value?: string }[]): string {
  return parts
    .filter((part) => part.kind === "text")
    .map((part) => part.value ?? "")
    .join("");
}

describe("T2 - the transcript matches what was streamed, across the buffer cap", () => {
  it("keeps every streamed delta through a held hydration and the commit that follows", async () => {
    const readStarted = deferred<void>();
    const read = deferred<SessionMessagesResponse>();
    const generation = createGeneration(1, {
      historyList: () => {
        readStarted.resolve(undefined);
        return read.promise;
      },
    });
    const controller = createV2ThreadController(createClient([generation]));

    try {
      const ready = controller.awaitReady();
      await readStarted.promise;

      // 600 deltas arrive DURING the read. They are held, not applied.
      //
      // ONE ordinal, because they are ONE part: a streamed text part is
      // identified by its message and its ordinal, and every delta of it
      // carries the same ordinal. That is also what lets the buffer COALESCE
      // them - adjacent deltas for one part fold into the entry they follow,
      // so a 600-token response costs one entry rather than 600.
      const pieces = Array.from({ length: 600 }, (_unused, index) => `t${index} `);
      generation.events.emit(textStarted());
      for (const [index, piece] of pieces.entries())
        generation.events.emit(textDelta(`evt_delta_${index}`, 0, piece));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The snapshot commits. The held events are replayed onto it.
      read.resolve({ data: [], cursor: {} });
      await ready;

      // And the FINAL TRANSCRIPT holds every one of them, in order.
      //
      // This is the end a reader sees. The buffer's own case proves the
      // deltas survive the buffer; this proves they survive the COMMIT.
      const message = controller.getState().messages[MESSAGE_ID];
      expect(message).toBeDefined();
      expect(transcriptText(message?.parts ?? [])).toBe(pieces.join(""));
    } finally {
      controller.dispose();
    }
  });
});
