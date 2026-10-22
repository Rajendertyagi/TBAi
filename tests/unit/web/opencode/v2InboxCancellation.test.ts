/**
 * The pending inbox list, and what a cancelled entry does to it.
 *
 * ## THE DEFECT THIS PINS
 *
 * The `session.inbox.cancelled` reducer was a no-op: it rewrote the same
 * record it was handed. The server DELETES the pending inbox row when it
 * cancels an entry (upstream `SessionInbox.cancel` -> `projectDelivered`
 * deletes the row, at 2.0.22), so the entry is gone - and a pending list that
 * keeps showing it tells the reader a prompt is still queued when it is not.
 *
 * It matters now because M7 makes the client issue real cancels: a cancel
 * requested before the prompt was admitted is honoured against the admitted
 * inbox id, and the server's answer to that cancel is this event.
 */

import { describe, expect, it } from "bun:test";
import type { V2Event } from "@opencode/client";
import {
  createInitialV2ThreadState,
  reduceV2ThreadState,
} from "@web/features/opencode/v2Events.ts";

const SESSION_ID = "ses_inbox_cancel_test";
const INBOX_ID = "inbox_cancelled_test";

function inboxEnqueued(): V2Event {
  return {
    id: "evt_inbox_enqueued",
    created: 10,
    type: "session.inbox.enqueued",
    durable: { aggregateID: SESSION_ID, seq: 1, version: 1 },
    data: {
      sessionID: SESSION_ID,
      inboxID: INBOX_ID,
      item: { type: "user", payload: { text: "hello" }, delivery: "queue" },
    },
  } as V2Event;
}

function inboxCancelled(): V2Event {
  return {
    id: "evt_inbox_cancelled",
    created: 11,
    type: "session.inbox.cancelled",
    durable: { aggregateID: SESSION_ID, seq: 2, version: 1 },
    data: { sessionID: SESSION_ID, inboxID: INBOX_ID },
  } as V2Event;
}

describe("the pending inbox list", () => {
  it("an enqueued entry is recorded", () => {
    const state = reduceV2ThreadState(createInitialV2ThreadState(SESSION_ID), {
      type: "v2_event",
      event: inboxEnqueued(),
      mode: "observe-and-apply",
    });

    expect(Object.keys(state.inboxById)).toEqual([INBOX_ID]);
  });

  it("a cancelled entry is REMOVED, because the server deleted it", () => {
    const enqueued = reduceV2ThreadState(createInitialV2ThreadState(SESSION_ID), {
      type: "v2_event",
      event: inboxEnqueued(),
      mode: "observe-and-apply",
    });
    const cancelled = reduceV2ThreadState(enqueued, {
      type: "v2_event",
      event: inboxCancelled(),
      mode: "observe-and-apply",
    });

    // The entry is gone. The old reducer rewrote the same record, so the
    // pending list kept showing a prompt the server had already removed.
    expect(Object.keys(cancelled.inboxById)).toEqual([]);
  });

  it("a cancel for an entry the client does not hold changes nothing", () => {
    const state = reduceV2ThreadState(createInitialV2ThreadState(SESSION_ID), {
      type: "v2_event",
      event: inboxCancelled(),
      mode: "observe-and-apply",
    });

    expect(state.inboxById).toEqual({});
  });
});
