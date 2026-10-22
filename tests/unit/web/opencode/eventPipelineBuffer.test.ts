/**
 * M5 — the hydration buffer must not lose streamed text.
 *
 * The defect this pins: every buffered delta was one entry, the buffer was a
 * fixed 512 slots, and overflow dropped the OLDEST entries. A long response
 * streamed while the transcript was loading therefore lost its beginning, and
 * the reader saw a truncated answer with no error. Coalescing adjacent deltas
 * for one part removes the per-token cost; the limit only has to survive that
 * many DISTINCT events.
 *
 * Ordinals come from `nextOrdinal()`, exactly as the live stream dates its
 * events: `beginHistoryRead()` reads the same counter, so a test that advanced
 * it another way would be testing a boundary the product never has.
 */

import { describe, expect, it } from "bun:test";
import type { V2Event } from "@opencode/client";
import {
  type BufferedEvent,
  type EventPipelineHost,
  createEventPipeline,
} from "@web/features/opencode/sync/eventPipeline.ts";

const MESSAGE_ID = "assistant-buffer-test";

function textDelta(id: string, ordinal: number, delta: string, messageId = MESSAGE_ID): V2Event {
  return {
    id,
    created: 10,
    type: "session.text.delta",
    data: { sessionID: "ses_buffer_test", assistantMessageID: messageId, ordinal, delta },
  } as V2Event;
}

function toolInputDelta(id: string, toolId: string, delta: string): V2Event {
  return {
    id,
    created: 10,
    type: "session.tool.input.delta",
    data: {
      sessionID: "ses_buffer_test",
      assistantMessageID: MESSAGE_ID,
      id: toolId,
      delta,
    },
  } as V2Event;
}

function toolInputEnded(id: string, toolId: string): V2Event {
  return {
    id,
    created: 10,
    type: "session.tool.input.ended",
    data: {
      sessionID: "ses_buffer_test",
      assistantMessageID: MESSAGE_ID,
      id: toolId,
      text: "{}",
    },
  } as V2Event;
}

/** The host the buffer does not talk to: it only holds events and ordinals. */
function createHost(overrides: Partial<EventPipelineHost> = {}): EventPipelineHost {
  return {
    isDisposed: false,
    config: { maxReconnectAttempts: 3, initialReconnectDelayMs: 10, maxReconnectDelayMs: 10 },
    isLive: () => true,
    ownsRuntime: () => true,
    retireAttempt: () => undefined,
    dispatch: () => undefined,
    applyEvent: () => undefined,
    startConnection: () => Promise.resolve(),
    reportBufferOverflow: () => undefined,
    failReady: () => undefined,
    toSafeError: (_error: unknown, fallback: string) => ({ kind: "unknown", message: fallback }),
    ...overrides,
  };
}

/** The text a buffered run would append to the part, in ordinal order. */
function bufferedText(entries: readonly BufferedEvent[]): string {
  return entries
    .map((entry) => (entry.event.type === "session.text.delta" ? entry.event.data.delta : ""))
    .join("");
}

describe("the hydration event buffer", () => {
  it("keeps every streamed delta of a 600-token response that arrived during the read", () => {
    const pipeline = createEventPipeline(createHost());
    pipeline.beginHistoryRead();

    const pieces = Array.from({ length: 600 }, (_unused, index) => `t${index} `);
    for (const [index, piece] of pieces.entries())
      pipeline.buffer(textDelta(`evt_delta_${index}`, 0, piece), pipeline.nextOrdinal());

    const buffered = pipeline.bufferedEntries();
    // CORRECT: the text survives. Coalescing is a representation change, so
    // the buffer no longer holds one entry per token - the concatenation does.
    expect(bufferedText(buffered)).toBe(pieces.join(""));
    expect(buffered).toHaveLength(1);
  });

  it("keeps a delta that predates the read in its own entry instead of folding later text into it", () => {
    const pipeline = createEventPipeline(createHost());

    // Arrives BEFORE the read starts. Whether it is replayed is decided by the
    // snapshot's own text (see `historyReplay.ts`), but it must not be merged
    // with what follows: that would raise its ordinal to the later event's and
    // make a pre-read delta indistinguishable from one that arrived during it.
    pipeline.buffer(textDelta("evt_before", 0, "before "), pipeline.nextOrdinal());
    pipeline.beginHistoryRead();
    pipeline.buffer(textDelta("evt_after_a", 0, "after "), pipeline.nextOrdinal());
    pipeline.buffer(textDelta("evt_after_b", 0, "text"), pipeline.nextOrdinal());

    const buffered = pipeline.bufferedEntries();
    // The merged entry wears the LATER event's id; what matters is that it did
    // not swallow the earlier entry's text.
    expect(buffered.map((entry) => entry.event.id)).toEqual(["evt_before", "evt_after_b"]);
    expect(bufferedText(buffered.slice(1))).toBe("after text");
  });

  it("keeps separate ordinals when two parts stream at once", () => {
    const pipeline = createEventPipeline(createHost());
    pipeline.beginHistoryRead();

    pipeline.buffer(textDelta("evt_a1", 0, "a1", "assistant-one"), pipeline.nextOrdinal());
    pipeline.buffer(textDelta("evt_b1", 0, "b1", "assistant-two"), pipeline.nextOrdinal());
    pipeline.buffer(textDelta("evt_a2", 0, "a2", "assistant-one"), pipeline.nextOrdinal());

    const buffered = pipeline.bufferedEntries();
    expect(buffered.map((entry) => entry.event.id)).toEqual(["evt_a1", "evt_b1", "evt_a2"]);
  });

  it("leaves a non-delta between two deltas in place instead of reordering them", () => {
    const pipeline = createEventPipeline(createHost());
    pipeline.beginHistoryRead();

    pipeline.buffer(toolInputDelta("evt_d1", "tool-1", "{"), pipeline.nextOrdinal());
    pipeline.buffer(toolInputEnded("evt_end", "tool-1"), pipeline.nextOrdinal());
    pipeline.buffer(toolInputDelta("evt_d2", "tool-1", "}"), pipeline.nextOrdinal());

    const buffered = pipeline.bufferedEntries();
    expect(buffered.map((entry) => entry.event.id)).toEqual(["evt_d1", "evt_end", "evt_d2"]);
  });

  it("drops the oldest entries at the limit rather than the stream", () => {
    const pipeline = createEventPipeline(createHost());
    pipeline.beginHistoryRead();

    // Distinct targets never coalesce, so each one costs a slot.
    const total = 4106;
    for (let index = 0; index < total; index += 1)
      pipeline.buffer(
        toolInputDelta(`evt_tool_${index}`, `tool-${index}`, "x"),
        pipeline.nextOrdinal(),
      );

    const buffered = pipeline.bufferedEntries();
    expect(buffered).toHaveLength(4096);
    expect(buffered[0]?.event.id).toBe(`evt_tool_${total - 4096}`);
    expect(buffered.at(-1)?.event.id).toBe(`evt_tool_${total - 1}`);
  });

  it("REPORTS the overflow, because a silent drop is a transcript that lies", () => {
    // M5's outstanding hold: the backstop dropped the oldest events with no
    // log, no counter and no change of state. A log alone would not be enough
    // either - the loss has to reach the readiness path, because a transcript
    // that lost events has NOT been reconciled and must not be reported as
    // though it had.
    const reports: { dropped: number; retained: number }[] = [];
    const pipeline = createEventPipeline(
      createHost({
        reportBufferOverflow: (dropped, retained) => reports.push({ dropped, retained }),
      }),
    );
    pipeline.beginHistoryRead();

    const total = 4106;
    for (let index = 0; index < total; index += 1)
      pipeline.buffer(
        toolInputDelta(`evt_tool_${index}`, `tool-${index}`, "x"),
        pipeline.nextOrdinal(),
      );

    // The controller was told ONCE - not once per dropped event, which would
    // bury the one line that matters - and the loss is on the record.
    expect(reports).toHaveLength(1);
    expect(reports[0]?.dropped).toBeGreaterThan(0);
    expect(reports[0]?.retained).toBe(4096);
    // And the FINAL count is available for the reconciliation path.
    expect(pipeline.droppedEventCount()).toBe(total - 4096);
  });

  it("reports the overflow only when there IS one", () => {
    const reports: number[] = [];
    const pipeline = createEventPipeline(
      createHost({ reportBufferOverflow: (dropped) => reports.push(dropped) }),
    );
    pipeline.beginHistoryRead();

    for (let index = 0; index < 10; index += 1)
      pipeline.buffer(
        toolInputDelta(`evt_tool_${index}`, `tool-${index}`, "x"),
        pipeline.nextOrdinal(),
      );

    expect(reports).toEqual([]);
    expect(pipeline.droppedEventCount()).toBe(0);
  });

  it("clears the loss with the buffer, because the next read starts a new account", () => {
    const pipeline = createEventPipeline(createHost());
    pipeline.beginHistoryRead();
    for (let index = 0; index < 4106; index += 1)
      pipeline.buffer(
        toolInputDelta(`evt_tool_${index}`, `tool-${index}`, "x"),
        pipeline.nextOrdinal(),
      );
    expect(pipeline.droppedEventCount()).toBe(10);

    pipeline.clearBuffer();
    expect(pipeline.droppedEventCount()).toBe(0);
  });
});
