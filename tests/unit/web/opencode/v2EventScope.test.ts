import { describe, expect, it } from "bun:test";
import type { V2Event } from "@opencode/client";
import {
  createInitialV2ThreadState,
  reduceV2Event,
  reduceV2ThreadState,
} from "@web/features/opencode/v2Events.ts";

/**
 * Unit D — event-scope validation.
 *
 * Every V2 event carries an optional `location` (`LocationRef`), and the
 * official contract provides it precisely so a client can verify the scope of
 * what it receives. This suite pins that an event naming a different
 * workspace is not applied to this view.
 *
 * This is defence in depth. The backend already refuses a request that names
 * another workspace (the workspace-authorization chain), and the upstream
 * scopes the event stream; what is proved here is that the client does not
 * APPLY what arrives from elsewhere.
 */

const SESSION_ID = "ses_event_scope_test";
const ASSISTANT_MESSAGE_ID = "msg_event_scope_test";
const SUBSCRIBED = "D:\\workspace\\subscribed";

function textDelta(directory?: string): V2Event {
  return {
    id: `evt_scope_${directory ?? "none"}`,
    created: 1,
    type: "session.text.delta",
    ...(directory === undefined ? {} : { location: { directory } }),
    data: {
      sessionID: SESSION_ID,
      assistantMessageID: ASSISTANT_MESSAGE_ID,
      ordinal: 0,
      delta: "hello",
    },
  } as V2Event;
}

describe("V2 event scope", () => {
  it("does not apply an event that names another workspace", () => {
    const state = createInitialV2ThreadState(SESSION_ID, SUBSCRIBED);
    const next = reduceV2Event(state, textDelta("D:\\workspace\\somebody-elses"), 1);

    expect(next.messages).toEqual({});
    expect(next.messageOrder).toEqual([]);
    // The event was observed and counted, not silently swallowed.
    expect(next.diagnosticCount).toBe(1);
  });

  it("applies an event that names the subscribed workspace", () => {
    const state = createInitialV2ThreadState(SESSION_ID, SUBSCRIBED);
    const next = reduceV2Event(state, textDelta(SUBSCRIBED), 1);

    expect(next.messages[ASSISTANT_MESSAGE_ID]).toBeDefined();
    expect(next.diagnosticCount).toBe(0);
  });

  it("keeps an event that does not say where it happened", () => {
    const state = createInitialV2ThreadState(SESSION_ID, SUBSCRIBED);
    const next = reduceV2Event(state, textDelta(), 1);

    expect(next.messages[ASSISTANT_MESSAGE_ID]).toBeDefined();
    expect(next.diagnosticCount).toBe(0);
  });

  it("keeps every event when no scope is known, because nothing can be compared", () => {
    const state = createInitialV2ThreadState(SESSION_ID);
    const next = reduceV2Event(state, textDelta("D:\\workspace\\somebody-elses"), 1);

    expect(next.messages[ASSISTANT_MESSAGE_ID]).toBeDefined();
    expect(next.diagnosticCount).toBe(0);
  });

  it("treats one directory spelled two ways as the same directory", () => {
    const state = createInitialV2ThreadState(SESSION_ID, "D:\\workspace\\subscribed");
    // A trailing separator and a different case are the same Windows path.
    const next = reduceV2Event(state, textDelta("d:/workspace/subscribed/"), 1);

    expect(next.messages[ASSISTANT_MESSAGE_ID]).toBeDefined();
    expect(next.diagnosticCount).toBe(0);
  });

  it("accepts the directory the server reports for the session", () => {
    // The subscribed directory and the server's own spelling of it can differ;
    // the server's report is the same directory, so its events are kept.
    const state = createInitialV2ThreadState(SESSION_ID, "/workspace/from-the-backend");
    const hydrated = reduceV2ThreadState(state, {
      type: "session_hydrated",
      session: {
        id: SESSION_ID,
        projectID: "project_event_scope_test",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 2 },
        location: { directory: "/workspace/from-the-server" },
      },
    });

    const next = reduceV2Event(hydrated, textDelta("/workspace/from-the-server"), 1);
    expect(next.messages[ASSISTANT_MESSAGE_ID]).toBeDefined();
    expect(next.diagnosticCount).toBe(0);
  });
});
