import { describe, expect, it } from "bun:test";
import type { PermissionRequest, V2Event } from "@opencode/client";
import {
  createInitialV2ThreadState,
  reduceV2Event,
  reduceV2ThreadState,
} from "./v2Events";
import type {
  V2InboxRecord,
  V2MessageState,
  V2SafeError,
} from "./v2Types";

const SESSION_ID = "ses_v2_events_test";
const ASSISTANT_MESSAGE_ID = "msg_assistant_v2_events_test";
const OPTIMISTIC_MESSAGE_ID = "msg_optimistic_v2_events_test";
const INBOX_ID = "inbox_v2_events_test";
const FIRST_ORDINAL = 1;

const TOKEN_USAGE = {
  input: 10,
  output: 5,
  reasoning: 2,
  cache: { read: 3, write: 1 },
} as const;

const MODEL = {
  providerID: "test-provider",
  modelID: "test-model",
  variant: "fast",
} as const;

const NEXT_MODEL = {
  providerID: "test-provider",
  modelID: "next-model",
} as const;

const SESSION = {
  id: SESSION_ID,
  projectID: "project_v2_events_test",
  cost: 0.25,
  tokens: TOKEN_USAGE,
  agent: "current-agent",
  model: { id: "test-model", providerID: MODEL.providerID, variant: MODEL.variant },
  time: { created: 1, updated: 2 },
  location: { directory: "D:\\workspace\\v2-events-test" },
} as const;

const OPTIMISTIC_MESSAGE = {
  id: OPTIMISTIC_MESSAGE_ID,
  parentId: null,
  role: "user",
  createdAt: 10,
  parts: [
    {
      kind: "text",
      id: "prt_optimistic_v2_events_test",
      order: 0,
      value: "hello",
      status: "complete",
    },
  ],
  source: null,
} as const satisfies V2MessageState;

const INBOX_RECORD = {
  id: INBOX_ID,
  sessionId: SESSION_ID,
  type: "user",
  delivery: "queue",
} as const satisfies V2InboxRecord;

const PERMISSION = {
  id: "permission_v2_events_test",
  sessionID: SESSION_ID,
  action: "bash",
  resources: ["D:\\workspace\\v2-events-test"],
  save: [],
} as const satisfies PermissionRequest;

const RECOVERY_ERROR = {
  kind: "server",
  message: "Revert recovery failed.",
  status: 503,
} as const satisfies V2SafeError;

const LOAD_ERROR = {
  kind: "network",
  message: "History refresh failed.",
} as const satisfies V2SafeError;

function malformedV2Event(event: object): V2Event {
  return Object.assign({} as V2Event, event);
}

function durableEvent<T extends V2Event["type"]>({
  id,
  type,
  aggregateID,
  seq,
  data,
}: {
  readonly id: string;
  readonly type: T;
  readonly aggregateID: string;
  readonly seq: number;
  readonly data: Extract<V2Event, { type: T }>["data"];
}): V2Event {
  return {
    id,
    created: 100 + seq,
    type,
    durable: { aggregateID, seq, version: 1 },
    data,
  } as V2Event;
}

function initialReadyState() {
  let state = createInitialV2ThreadState(SESSION_ID);
  state = reduceV2ThreadState(state, { type: "load_started" });
  state = reduceV2ThreadState(state, {
    type: "history_loaded",
    messages: [],
    messageOrder: [],
    pages: 1,
  });
  state = reduceV2ThreadState(state, { type: "load_completed" });
  state = reduceV2ThreadState(state, { type: "session_hydrated", session: SESSION });
  return state;
}

describe("V2 desired selection generation", () => {
  it("updates desired selection without changing authoritative selection and ignores stale generations", () => {
    const initial = initialReadyState();
    const desired = { model: NEXT_MODEL, agent: "next-agent" } as const;

    const changed = reduceV2ThreadState(initial, {
      type: "desired_selection_changed",
      selection: desired,
      generation: 3,
    });
    const stale = reduceV2ThreadState(changed, {
      type: "desired_selection_changed",
      selection: { model: null, agent: null },
      generation: 2,
    });

    expect(changed.selectionGeneration).toBe(3);
    expect(changed.desiredModel).toEqual(NEXT_MODEL);
    expect(changed.desiredAgent).toBe("next-agent");
    expect(changed.model).toEqual(MODEL);
    expect(changed.agent).toBe("current-agent");
    expect(stale.desiredModel).toEqual(NEXT_MODEL);
    expect(stale.desiredAgent).toBe("next-agent");
    expect(stale.selectionGeneration).toBe(3);
  });
});

describe("V2 tool lifecycle events", () => {
  it("converges input, call, and success events into a completed tool", () => {
    let state = initialReadyState();
    const toolId = "call_v2_lifecycle_success";
    const messageId = "msg_v2_lifecycle_success";
    const events: V2Event[] = [
      durableEvent({
        id: "evt_tool_started",
        type: "session.tool.input.started",
        aggregateID: SESSION_ID,
        seq: 1,
        data: { sessionID: SESSION_ID, assistantMessageID: messageId, id: toolId, name: "shell" },
      }),
      durableEvent({
        id: "evt_tool_delta",
        type: "session.tool.input.delta",
        aggregateID: SESSION_ID,
        seq: 2,
        data: { sessionID: SESSION_ID, assistantMessageID: messageId, id: toolId, delta: "{\"command\":" },
      }),
      durableEvent({
        id: "evt_tool_ended",
        type: "session.tool.input.ended",
        aggregateID: SESSION_ID,
        seq: 3,
        data: { sessionID: SESSION_ID, assistantMessageID: messageId, id: toolId, text: "{\"command\":\"bun --version\"}" },
      }),
      durableEvent({
        id: "evt_tool_called",
        type: "session.tool.called",
        aggregateID: SESSION_ID,
        seq: 4,
        data: { sessionID: SESSION_ID, assistantMessageID: messageId, id: toolId, input: { command: "bun --version" }, executed: true },
      }),
      durableEvent({
        id: "evt_tool_progress",
        type: "session.tool.progress",
        aggregateID: SESSION_ID,
        seq: 5,
        data: { sessionID: SESSION_ID, assistantMessageID: messageId, id: toolId, metadata: { progress: "running" } },
      }),
      durableEvent({
        id: "evt_tool_success",
        type: "session.tool.success",
        aggregateID: SESSION_ID,
        seq: 6,
        data: { sessionID: SESSION_ID, assistantMessageID: messageId, id: toolId, content: [{ type: "text", text: "1.4.2" }], executed: true },
      }),
    ];
    for (const [index, event] of events.entries()) {
      state = reduceV2Event(state, event, index + 1, "observe-and-apply");
    }

    expect(state.messages[messageId]?.parts[0]).toMatchObject({
      kind: "tool",
      input: { command: "bun --version" },
      output: [{ type: "text", text: "1.4.2" }],
      status: "complete",
    });
  });

  it("converges a failed tool event into an error tool part", () => {
    let state = initialReadyState();
    const messageId = "msg_v2_lifecycle_failure";
    const toolId = "call_v2_lifecycle_failure";
    const started = durableEvent({
      id: "evt_tool_failure_started",
      type: "session.tool.input.started",
      aggregateID: SESSION_ID,
      seq: 1,
      data: { sessionID: SESSION_ID, assistantMessageID: messageId, id: toolId, name: "read" },
    });
    const failed = durableEvent({
      id: "evt_tool_failed",
      type: "session.tool.failed",
      aggregateID: SESSION_ID,
      seq: 2,
      data: {
        sessionID: SESSION_ID,
        assistantMessageID: messageId,
        id: toolId,
        error: { type: "tool.execution", message: "File not found" },
        executed: false,
      },
    });

    state = reduceV2Event(state, started, 1, "observe-and-apply");
    state = reduceV2Event(state, failed, 2, "observe-and-apply");

    expect(state.messages[messageId]?.parts[0]).toMatchObject({
      kind: "tool",
      output: { type: "tool.execution", error: "File not found" },
      status: "error",
    });
  });

  it("finalizes text, reasoning, and step parts from official ended events", () => {
    let state = initialReadyState();
    const messageId = "msg_v2_terminal_events";
    const events: V2Event[] = [
      durableEvent({
        id: "evt_text_started",
        type: "session.text.started",
        aggregateID: SESSION_ID,
        seq: 1,
        data: { sessionID: SESSION_ID, assistantMessageID: messageId, ordinal: 0 },
      }),
      durableEvent({
        id: "evt_text_ended",
        type: "session.text.ended",
        aggregateID: SESSION_ID,
        seq: 2,
        data: { sessionID: SESSION_ID, assistantMessageID: messageId, ordinal: 0, text: "final text" },
      }),
      durableEvent({
        id: "evt_reasoning_started",
        type: "session.reasoning.started",
        aggregateID: SESSION_ID,
        seq: 3,
        data: { sessionID: SESSION_ID, assistantMessageID: messageId, ordinal: 0 },
      }),
      durableEvent({
        id: "evt_reasoning_ended",
        type: "session.reasoning.ended",
        aggregateID: SESSION_ID,
        seq: 4,
        data: { sessionID: SESSION_ID, assistantMessageID: messageId, ordinal: 0, text: "final reasoning" },
      }),
      durableEvent({
        id: "evt_step_started",
        type: "session.step.started",
        aggregateID: SESSION_ID,
        seq: 5,
        data: { sessionID: SESSION_ID, assistantMessageID: messageId, agent: "build", model: { id: "test-model", providerID: "test-provider" }, started: 1 },
      }),
      durableEvent({
        id: "evt_step_ended",
        type: "session.step.ended",
        aggregateID: SESSION_ID,
        seq: 6,
        data: { sessionID: SESSION_ID, assistantMessageID: messageId, finish: "stop", cost: 0.25, tokens: TOKEN_USAGE },
      }),
    ];
    for (const [index, event] of events.entries()) {
      state = reduceV2Event(state, event, index + 1, "observe-and-apply");
    }

    expect(state.messages[messageId]?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "text", value: "final text", status: "complete" }),
      expect.objectContaining({ kind: "reasoning", value: "final reasoning", status: "complete" }),
      expect.objectContaining({ kind: "step", status: "finished" }),
    ]));
    expect(state.usage).toEqual({ cost: 0.25, tokens: TOKEN_USAGE });
  });

  it("marks a failed official step as failed", () => {
    let state = initialReadyState();
    const messageId = "msg_v2_step_failure";
    const started = durableEvent({
      id: "evt_step_failure_started",
      type: "session.step.started",
      aggregateID: SESSION_ID,
      seq: 1,
      data: { sessionID: SESSION_ID, assistantMessageID: messageId, agent: "build", model: { id: "test-model", providerID: "test-provider" }, started: 1 },
    });
    const failed = durableEvent({
      id: "evt_step_failure",
      type: "session.step.failed",
      aggregateID: SESSION_ID,
      seq: 2,
      data: { sessionID: SESSION_ID, assistantMessageID: messageId, error: { type: "provider.error", message: "Step failed" } },
    });
    state = reduceV2Event(state, started, 1, "observe-and-apply");
    state = reduceV2Event(state, failed, 2, "observe-and-apply");
    expect(state.messages[messageId]?.parts[0]).toMatchObject({ kind: "step", status: "error" });
  });
});

describe("V2 public event identity", () => {
  it("records observe-only identity, applies that event once, and skips its duplicate", () => {
    const initial = initialReadyState();
    const event = durableEvent({
      id: "evt_model_selected",
      type: "session.model.selected",
      aggregateID: SESSION_ID,
      seq: 8,
      data: { sessionID: SESSION_ID, model: { id: "next-model", providerID: "test-provider" } },
    });

    const observed = reduceV2Event(initial, event, FIRST_ORDINAL, "observe-only");
    expect(observed.model).toEqual(MODEL);
    expect(observed.eventIdentity.recentObservedEventIds).toEqual(["evt_model_selected"]);
    expect(observed.eventIdentity.recentAppliedEventIds).toEqual([]);

    const applied = reduceV2Event(observed, event, FIRST_ORDINAL, "observe-and-apply");
    expect(applied.model).toEqual(NEXT_MODEL);
    expect(applied.eventIdentity.recentAppliedEventIds).toEqual(["evt_model_selected"]);
    expect(applied.eventIdentity.durableSequenceByAggregate[SESSION_ID]).toBe(8);

    const duplicate = reduceV2Event(applied, event, 2, "observe-and-apply");
    expect(duplicate.eventIdentity.recentObservedEventIds).toEqual(["evt_model_selected"]);
    expect(duplicate.eventIdentity.recentAppliedEventIds).toEqual(["evt_model_selected"]);
  });

  it("rejects a new event whose durable sequence is not newer than the aggregate high-water mark", () => {
    const first = durableEvent({
      id: "evt_agent_first",
      type: "session.agent.selected",
      aggregateID: SESSION_ID,
      seq: 4,
      data: { sessionID: SESSION_ID, agent: "first-agent" },
    });
    const stale = durableEvent({
      id: "evt_agent_stale",
      type: "session.agent.selected",
      aggregateID: SESSION_ID,
      seq: 4,
      data: { sessionID: SESSION_ID, agent: "stale-agent" },
    });
    const initial = initialReadyState();
    const afterFirst = reduceV2Event(initial, first, 1, "observe-and-apply");
    const afterStale = reduceV2Event(afterFirst, stale, 2, "observe-and-apply");

    expect(afterStale.agent).toBe("first-agent");
    expect(afterStale.eventIdentity.durableSequenceByAggregate[SESSION_ID]).toBe(4);
    expect(afterStale.eventIdentity.recentObservedEventIds).toEqual(["evt_agent_first"]);
    expect(afterStale.diagnosticCount).toBeGreaterThan(afterFirst.diagnosticCount);
  });
});

describe("V2 replay-only event exclusion", () => {
  it("does not project replay-only usage or content events or give them public identity", () => {
    const initial = initialReadyState();
    const usageRecorded = malformedV2Event({
      id: "evt_replay_usage",
      created: 20,
      type: "session.usage.recorded",
      durable: { aggregateID: SESSION_ID, seq: 9, version: 1 },
      data: { sessionID: SESSION_ID, source: "title", cost: 99, tokens: TOKEN_USAGE },
    });
    const contentUpdated = malformedV2Event({
      id: "evt_replay_content",
      created: 21,
      type: "session.message.content.updated",
      durable: { aggregateID: SESSION_ID, seq: 10, version: 1 },
      data: { sessionID: SESSION_ID, messageID: ASSISTANT_MESSAGE_ID, content: [] },
    });

    const afterUsage = reduceV2Event(initial, usageRecorded, 1, "observe-and-apply");
    const afterContent = reduceV2Event(afterUsage, contentUpdated, 2, "observe-and-apply");

    expect(afterContent.usage).toEqual({ cost: SESSION.cost, tokens: SESSION.tokens });
    expect(afterContent.messages).toEqual({});
    expect(afterContent.messageOrder).toEqual([]);
    expect(afterContent.eventIdentity.recentObservedEventIds).toEqual([]);
    expect(afterContent.eventIdentity.recentAppliedEventIds).toEqual([]);
    expect(afterContent.diagnosticCount).toBe(2);
  });
});

describe("V2 load reconciliation actions", () => {
  it("moves loading to reconciling, back to loading, and only then to ready", () => {
    const initial = createInitialV2ThreadState(SESSION_ID);
    const loading = reduceV2ThreadState(initial, { type: "load_started" });
    const reconciling = reduceV2ThreadState(loading, {
      type: "load_reconciling",
      reason: "history-convergence-cap",
    });
    const refreshing = reduceV2ThreadState(reconciling, { type: "load_reconciled" });
    const ready = reduceV2ThreadState(refreshing, { type: "load_completed" });

    expect(loading.load).toEqual({ type: "loading" });
    expect(reconciling.load).toEqual({ type: "reconciling" });
    expect(refreshing.load).toEqual({ type: "loading" });
    expect(ready.load).toEqual({ type: "ready" });
    expect(ready.execution).toEqual({ type: "idle" });
  });

  it("moves a failed authoritative refresh to a sanitized load error", () => {
    const loading = reduceV2ThreadState(createInitialV2ThreadState(SESSION_ID), {
      type: "load_started",
    });
    const failed = reduceV2ThreadState(loading, { type: "load_failed", error: LOAD_ERROR });

    expect(failed.load).toEqual({ type: "error", error: LOAD_ERROR });
    expect(failed.execution).toEqual({ type: "idle" });
  });
});

describe("V2 revert recovery transitions", () => {
  it("moves staged through clearing to cleared while blocking execution and then restoring idle", () => {
    const stagedEvent = durableEvent({
      id: "evt_revert_staged",
      type: "session.revert.staged",
      aggregateID: SESSION_ID,
      seq: 12,
      data: { sessionID: SESSION_ID, revert: { messageID: OPTIMISTIC_MESSAGE_ID } },
    });
    const staged = reduceV2Event(
      createInitialV2ThreadState(SESSION_ID),
      stagedEvent,
      FIRST_ORDINAL,
      "observe-and-apply",
    );
    const clearing = reduceV2ThreadState(staged, {
      type: "revert_recovery_clearing",
      userMessageId: OPTIMISTIC_MESSAGE_ID,
    });
    const cleared = reduceV2ThreadState(clearing, { type: "revert_recovery_cleared" });

    expect(staged.revertRecovery).toEqual({ type: "staging" });
    expect(staged.execution).toEqual({
      type: "reverting",
      userMessageId: OPTIMISTIC_MESSAGE_ID,
    });
    expect(clearing.revertRecovery).toEqual({ type: "clearing" });
    expect(clearing.execution).toEqual({
      type: "reverting",
      userMessageId: OPTIMISTIC_MESSAGE_ID,
    });
    expect(cleared.revertRecovery).toEqual({ type: "none" });
    expect(cleared.execution).toEqual({ type: "idle" });
  });

  it("moves failed clearing to blocked recovery and a sanitized execution error", () => {
    const clearing = reduceV2ThreadState(createInitialV2ThreadState(SESSION_ID), {
      type: "revert_recovery_clearing",
      userMessageId: OPTIMISTIC_MESSAGE_ID,
    });
    const failed = reduceV2ThreadState(clearing, {
      type: "revert_recovery_failed",
      userMessageId: OPTIMISTIC_MESSAGE_ID,
      error: RECOVERY_ERROR,
    });

    expect(failed.revertRecovery).toEqual({ type: "blocked", error: RECOVERY_ERROR });
    expect(failed.execution).toEqual({
      type: "error",
      userMessageId: OPTIMISTIC_MESSAGE_ID,
      assistantMessageId: null,
      error: RECOVERY_ERROR,
    });
  });
});

describe("V2 prompt admission and idempotence", () => {
  it("inserts an optimistic message and records the same inbox admission only once", () => {
    const submitting = reduceV2ThreadState(createInitialV2ThreadState(SESSION_ID), {
      type: "prompt_submitting",
      message: OPTIMISTIC_MESSAGE,
    });
    const admitted = reduceV2ThreadState(submitting, {
      type: "prompt_admitted",
      userMessageId: OPTIMISTIC_MESSAGE_ID,
      inbox: INBOX_RECORD,
    });
    const duplicate = reduceV2ThreadState(admitted, {
      type: "prompt_admitted",
      userMessageId: OPTIMISTIC_MESSAGE_ID,
      inbox: INBOX_RECORD,
    });

    expect(submitting.messages[OPTIMISTIC_MESSAGE_ID]).toEqual(OPTIMISTIC_MESSAGE);
    expect(submitting.messageOrder).toEqual([OPTIMISTIC_MESSAGE_ID]);
    expect(submitting.execution).toEqual({
      type: "submitting",
      userMessageId: OPTIMISTIC_MESSAGE_ID,
      cancelRequested: false,
    });
    expect(admitted.inboxById).toEqual({ [INBOX_ID]: INBOX_RECORD });
    expect(admitted.execution).toEqual({
      type: "admitted",
      userMessageId: OPTIMISTIC_MESSAGE_ID,
      inboxId: INBOX_ID,
      delivery: "queue",
      cancelRequested: false,
    });
    expect(duplicate.inboxById).toEqual(admitted.inboxById);
  });

  it("accepts enqueue before the HTTP response without regressing a terminal execution state", () => {
    const submitting = reduceV2ThreadState(createInitialV2ThreadState(SESSION_ID), {
      type: "prompt_submitting",
      message: OPTIMISTIC_MESSAGE,
    });
    const enqueuedEvent = durableEvent({
      id: "evt_inbox_enqueued",
      type: "session.inbox.enqueued",
      aggregateID: SESSION_ID,
      seq: 14,
      data: {
        sessionID: SESSION_ID,
        inboxID: INBOX_ID,
        item: { type: "user", delivery: "queue", payload: { text: "hello" } },
      },
    });
    const terminalEvent = durableEvent({
      id: "evt_execution_succeeded",
      type: "session.execution.succeeded",
      aggregateID: SESSION_ID,
      seq: 15,
      data: { sessionID: SESSION_ID },
    });

    const enqueued = reduceV2Event(
      submitting,
      enqueuedEvent,
      1,
      "observe-and-apply",
    );
    const terminal = reduceV2Event(enqueued, terminalEvent, 2, "observe-and-apply");
    const httpResponse = reduceV2ThreadState(terminal, {
      type: "prompt_admitted",
      userMessageId: OPTIMISTIC_MESSAGE_ID,
      inbox: INBOX_RECORD,
    });

    expect(enqueued.inboxById[INBOX_ID]).toEqual(INBOX_RECORD);
    expect(terminal.execution).toEqual({ type: "idle" });
    expect(httpResponse.inboxById[INBOX_ID]).toEqual(INBOX_RECORD);
    expect(Object.keys(httpResponse.inboxById)).toEqual([INBOX_ID]);
    expect(httpResponse.execution).toEqual({ type: "idle" });
  });
});

describe("V2 permission snapshot ordinal behavior", () => {
  it("does not let an older list snapshot erase a newer permission event", () => {
    const initial = initialReadyState();
    const newer = reduceV2Event(
      initial,
      {
        id: "evt_permission_asked",
        created: 30,
        type: "permission.asked",
        data: PERMISSION,
      } as V2Event,
      5,
      "observe-and-apply",
    );
    const staleSnapshot = reduceV2ThreadState(newer, {
      type: "permissions_hydrated",
      requests: [],
      requestOrdinal: 4,
    });

    expect(staleSnapshot.permissions).toEqual([PERMISSION]);
    expect(staleSnapshot.eventIdentity.recentAppliedEventIds).toEqual(["evt_permission_asked"]);
  });
});

describe("V2 unknown events", () => {
  it("changes no domain state, records a bounded diagnostic, and creates no identity entry", () => {
    const initial = initialReadyState();
    const unknown = malformedV2Event({
      id: "evt_unknown_future",
      created: 40,
      type: "session.future.event",
      data: { sessionID: SESSION_ID, assistantMessageID: ASSISTANT_MESSAGE_ID },
    });

    const reduced = reduceV2Event(initial, unknown, FIRST_ORDINAL, "observe-and-apply");

    expect(reduced.messages).toEqual(initial.messages);
    expect(reduced.messageOrder).toEqual(initial.messageOrder);
    expect(reduced.execution).toEqual(initial.execution);
    expect(reduced.usage).toEqual(initial.usage);
    expect(reduced.eventIdentity.recentObservedEventIds).toEqual([]);
    expect(reduced.eventIdentity.recentAppliedEventIds).toEqual([]);
    expect(reduced.diagnosticCount).toBe(1);
  });
});
