import type {
  SessionInboxItem,
  V2Event,
} from "@opencode/client";
import {
  OPENCODE_V2_DIAGNOSTIC_COUNT_CAP,
  OPENCODE_V2_RECENT_EVENT_ID_WINDOW,
} from "@/config/opencode";
import {
  modelRefToV2Selection,
  type V2EventIdentityState,
  type V2ExecutionState,
  type V2InboxRecord,
  type V2MessagePartState,
  type V2MessageState,
  type V2SafeError,
  type V2ThreadAction,
  type V2ThreadState,
} from "./v2Types";

const EVENT_ID_WINDOW = OPENCODE_V2_RECENT_EVENT_ID_WINDOW;
const REPLAY_ONLY_EVENT_TYPES = new Set([
  "session.message.content.updated",
  "session.usage.recorded",
]);
const PUBLIC_EVENT_TYPES = new Set([
  "server.connected",
  "session.created",
  "session.agent.selected",
  "session.model.selected",
  "session.moved",
  "session.renamed",
  "session.metadata.updated",
  "session.permissions",
  "session.viewed",
  "session.usage.updated",
  "session.deleted",
  "session.forked",
  "session.inbox.delivered",
  "session.inbox.enqueued",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.instructions.updated",
  "session.synthetic",
  "session.skill.activated",
  "session.shell.started",
  "session.shell.ended",
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.retry.scheduled",
  "session.compaction.started",
  "session.compaction.delta",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.revert.staged",
  "session.revert.cleared",
  "session.revert.committed",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
  "session.status.updated",
  "session.idle",
]);

const EMPTY_EVENT_IDENTITY: V2EventIdentityState = {
  nextOrdinal: 0,
  recentObservedEventIds: [],
  recentAppliedEventIds: [],
  durableSequenceByAggregate: {},
};

function appendId(ids: readonly string[], id: string): readonly string[] {
  if (ids.includes(id)) return ids;
  return [...ids, id].slice(-EVENT_ID_WINDOW);
}

function incrementDiagnostic(state: V2ThreadState): V2ThreadState {
  return {
    ...state,
    diagnosticCount: Math.min(state.diagnosticCount + 1, OPENCODE_V2_DIAGNOSTIC_COUNT_CAP),
  };
}

function getEventSessionId(event: V2Event): string | null {
  const data: unknown = event.data;
  if (!data || typeof data !== "object" || !("sessionID" in data)) return null;
  const sessionID = data.sessionID;
  return typeof sessionID === "string" ? sessionID : null;
}

function getDurableSequence(event: V2Event): { aggregateID: string; seq: number } | null {
  if (!("durable" in event) || !event.durable) return null;
  return event.durable;
}

function getMessage(
  state: V2ThreadState,
  messageId: string,
  role: V2MessageState["role"] = "assistant",
): V2MessageState {
  return (
    state.messages[messageId] ?? {
      id: messageId,
      parentId: state.messageOrder.at(-1) ?? null,
      role,
      createdAt: Date.now(),
      parts: [],
      source: null,
    }
  );
}

function withMessage(
  state: V2ThreadState,
  message: V2MessageState,
): V2ThreadState {
  const exists = state.messageOrder.includes(message.id);
  return {
    ...state,
    messages: { ...state.messages, [message.id]: message },
    messageOrder: exists ? state.messageOrder : [...state.messageOrder, message.id],
  };
}

function replacePart(
  message: V2MessageState,
  part: V2MessagePartState,
): V2MessageState {
  const index = message.parts.findIndex((candidate) => candidate.id === part.id);
  const parts = index < 0
    ? [...message.parts, part]
    : message.parts.map((candidate, candidateIndex) =>
        candidateIndex === index ? part : candidate,
      );
  return { ...message, parts };
}

function isTerminalExecution(state: V2ExecutionState): boolean {
  return state.type === "idle" || state.type === "error";
}

function executionCancelRequested(state: V2ExecutionState): boolean {
  return state.type !== "idle" && state.type !== "error" && "cancelRequested" in state
    ? state.cancelRequested
    : false;
}

function currentUserAndInbox(
  state: V2ThreadState,
): { userMessageId: string | null; inboxId: string | null } {
  if (state.execution.type === "submitting" || state.execution.type === "admitted" || state.execution.type === "reconciling") {
    return {
      userMessageId: state.execution.userMessageId,
      inboxId: state.execution.type === "admitted" ? state.execution.inboxId : null,
    };
  }
  if (state.execution.type === "executing" || state.execution.type === "streaming" || state.execution.type === "cancelling") {
    return {
      userMessageId: state.execution.userMessageId,
      inboxId: state.execution.inboxId,
    };
  }
  return { userMessageId: null, inboxId: null };
}

function recordInbox(
  state: V2ThreadState,
  record: V2InboxRecord,
): V2ThreadState {
  const next: V2ThreadState = {
    ...state,
    inboxById: { ...state.inboxById, [record.id]: record },
  };
  if (isTerminalExecution(next.execution)) return next;
  if (
    record.type === "user" &&
    (next.execution.type === "submitting" || next.execution.type === "reconciling")
  ) {
    return {
      ...next,
      execution: {
        type: "admitted",
        userMessageId: next.execution.userMessageId,
        inboxId: record.id,
        delivery: record.delivery,
        cancelRequested: next.execution.cancelRequested,
      },
    };
  }
  return next;
}

function inboxRecordFromItem(
  sessionId: string,
  inboxId: string,
  item: SessionInboxItem,
): V2InboxRecord {
  const type = item.type === "compaction"
    ? "compaction"
    : item.type === "synthetic"
      ? "synthetic"
      : item.type === "move"
        ? "move"
        : "user";
  return { id: inboxId, sessionId, type, delivery: item.delivery };
}

function mapEventError(
  error: { message: string; status?: number },
): V2SafeError {
  return {
    kind: error.status && error.status >= 500 ? "server" : "unknown",
    message: error.message,
    status: error.status,
  };
}

function applyModelEvent(state: V2ThreadState, event: Extract<V2Event, { type: "session.model.selected" }>): V2ThreadState {
  return { ...state, model: modelRefToV2Selection(event.data.model) };
}

function applyAgentEvent(state: V2ThreadState, event: Extract<V2Event, { type: "session.agent.selected" }>): V2ThreadState {
  return { ...state, agent: event.data.agent };
}

function applyExecutionStarted(state: V2ThreadState): V2ThreadState {
  if (state.execution.type === "reverting" || isTerminalExecution(state.execution)) return state;
  const ids = currentUserAndInbox(state);
  return {
    ...state,
    execution: {
      type: "executing",
      userMessageId: ids.userMessageId,
      inboxId: ids.inboxId,
      assistantMessageId: null,
      cancelRequested: state.execution.type === "cancelling"
        ? true
        : state.execution.type === "submitting" || state.execution.type === "admitted" || state.execution.type === "reconciling"
          ? state.execution.cancelRequested
          : false,
    },
  };
}

function toolInputFromText(text: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Readonly<Record<string, unknown>>;
    }
  } catch {
    // The server may still be streaming partial JSON; keep the raw text until ended.
  }
  return { text };
}

type V2ToolPartState = Extract<V2MessagePartState, { readonly kind: "tool" }>;

function assistantToolPart(
  state: V2ThreadState,
  assistantMessageId: string,
  toolId: string,
): V2ToolPartState {
  const message = getMessage(state, assistantMessageId);
  const existing = message.parts.find((part) => part.id === `tool:${assistantMessageId}:${toolId}`);
  return existing?.kind === "tool" ? existing : {
    kind: "tool",
    id: `tool:${assistantMessageId}:${toolId}`,
    order: message.parts.length,
    name: "unknown",
    input: {},
    output: undefined,
    status: "running",
    permissionId: null,
  };
}

function updateAssistantTool(
  state: V2ThreadState,
  assistantMessageId: string,
  toolId: string,
  update: Partial<Pick<V2ToolPartState, "input" | "output" | "metadata" | "status">>,
): V2ThreadState {
  const current = assistantToolPart(state, assistantMessageId, toolId);
  return applyAssistantEvent(state, assistantMessageId, {
    ...current,
    ...update,
  });
}

function updateAssistantPart(
  state: V2ThreadState,
  assistantMessageId: string,
  part: V2MessagePartState,
): V2ThreadState {
  const message = getMessage(state, assistantMessageId);
  return withMessage(state, replacePart(message, part));
}

function applyAssistantEvent(
  state: V2ThreadState,
  assistantMessageId: string,
  part: V2MessagePartState,
): V2ThreadState {
  if (!assistantMessageId) return state;
  const message = getMessage(state, assistantMessageId);
  const next = withMessage(state, replacePart(message, part));
  if (state.execution.type === "reverting" || isTerminalExecution(state.execution)) return next;
  const ids = currentUserAndInbox(state);
  return {
    ...next,
    execution: {
      type: "streaming",
      userMessageId: ids.userMessageId,
      inboxId: ids.inboxId,
      assistantMessageId,
      cancelRequested: state.execution.type === "cancelling",
    },
  };
}

function applyKnownEvent(state: V2ThreadState, event: V2Event): V2ThreadState {
  switch (event.type) {
    case "session.model.selected":
      return applyModelEvent(state, event);
    case "session.agent.selected":
      return applyAgentEvent(state, event);
    case "session.usage.updated":
      return { ...state, usage: { cost: event.data.cost, tokens: event.data.tokens } };
    case "session.inbox.enqueued":
      return recordInbox(state, inboxRecordFromItem(event.data.sessionID, event.data.inboxID, event.data.item));
    case "session.inbox.cancelled": {
      const record = state.inboxById[event.data.inboxID];
      return record ? { ...state, inboxById: { ...state.inboxById, [record.id]: record } } : state;
    }
    case "session.execution.started":
      return applyExecutionStarted(state);
    case "session.execution.succeeded":
    case "session.execution.interrupted":
    case "session.idle":
      return isTerminalExecution(state.execution) ? state : { ...state, execution: { type: "idle" } };
    case "session.execution.failed":
      return {
        ...state,
        execution: {
          type: "error",
          userMessageId: currentUserAndInbox(state).userMessageId,
          assistantMessageId: state.execution.type === "streaming" ? state.execution.assistantMessageId : null,
          error: mapEventError(event.data.error),
        },
      };
    case "session.retry.scheduled":
      return applyAssistantEvent(state, event.data.assistantMessageID, {
        kind: "retry",
        id: `retry:${event.data.assistantMessageID}`,
        order: state.messages[event.data.assistantMessageID]?.parts.length ?? 0,
        value: event.data.attempt > 0 ? `retry ${event.data.attempt}` : "retry",
      });
    case "session.revert.staged":
      return {
        ...state,
        revertRecovery: { type: "staging" },
        execution: { type: "reverting", userMessageId: event.data.revert.messageID },
      };
    case "session.revert.cleared":
    case "session.revert.committed":
      return state;
    case "form.created":
      return state.forms.some((form) => form.id === event.data.form.id)
        ? state
        : { ...state, forms: [...state.forms, event.data.form] };
    case "form.replied":
    case "form.cancelled":
      return { ...state, forms: state.forms.filter((form) => form.id !== event.data.id) };
    case "permission.asked":
      return {
        ...state,
        permissions: [
          ...state.permissions.filter((permission) => permission.id !== event.data.id),
          event.data,
        ],
      };
    case "permission.replied":
      return {
        ...state,
        permissions: state.permissions.filter((permission) => permission.id !== event.data.requestID),
        answeredPermissionIds: appendId(state.answeredPermissionIds, event.data.requestID),
      };
    case "session.text.started":
      return applyAssistantEvent(state, event.data.assistantMessageID, {
        kind: "text",
        id: `text:${event.data.assistantMessageID}:${event.data.ordinal}`,
        order: event.data.ordinal,
        value: "",
        status: "streaming",
      });
    case "session.text.delta": {
      const message = getMessage(state, event.data.assistantMessageID);
      const partId = `text:${event.data.assistantMessageID}:${event.data.ordinal}`;
      const part = message.parts.find((candidate) => candidate.id === partId);
      return applyAssistantEvent(state, event.data.assistantMessageID, {
        kind: "text",
        id: partId,
        order: event.data.ordinal,
        value: `${part?.kind === "text" ? part.value : ""}${event.data.delta}`,
        status: "streaming",
      });
    }
    case "session.reasoning.started":
      return applyAssistantEvent(state, event.data.assistantMessageID, {
        kind: "reasoning",
        id: `reasoning:${event.data.assistantMessageID}:${event.data.ordinal}`,
        order: event.data.ordinal,
        value: "",
        status: "streaming",
      });
    case "session.reasoning.delta": {
      const message = getMessage(state, event.data.assistantMessageID);
      const partId = `reasoning:${event.data.assistantMessageID}:${event.data.ordinal}`;
      const part = message.parts.find((candidate) => candidate.id === partId);
      return applyAssistantEvent(state, event.data.assistantMessageID, {
        kind: "reasoning",
        id: partId,
        order: event.data.ordinal,
        value: `${part?.kind === "reasoning" ? part.value : ""}${event.data.delta}`,
        status: "streaming",
      });
    }
    case "session.text.ended": {
      const message = getMessage(state, event.data.assistantMessageID);
      const part = message.parts.find((candidate) => candidate.id === `text:${event.data.assistantMessageID}:${event.data.ordinal}`);
      if (part?.kind !== "text") return state;
      return updateAssistantPart(state, event.data.assistantMessageID, {
        ...part,
        value: event.data.text,
        status: "complete",
      });
    }
    case "session.reasoning.ended": {
      const message = getMessage(state, event.data.assistantMessageID);
      const part = message.parts.find((candidate) => candidate.id === `reasoning:${event.data.assistantMessageID}:${event.data.ordinal}`);
      if (part?.kind !== "reasoning") return state;
      return updateAssistantPart(state, event.data.assistantMessageID, {
        ...part,
        value: event.data.text,
        status: "complete",
      });
    }
    case "session.step.ended":
    case "session.step.failed": {
      const message = getMessage(state, event.data.assistantMessageID);
      const part = [...message.parts].reverse().find((candidate) => candidate.kind === "step");
      if (part?.kind !== "step") return state;
      const next = updateAssistantPart(state, event.data.assistantMessageID, {
        ...part,
        status: event.type === "session.step.failed" ? "error" : "finished",
      });
      const usage = event.type === "session.step.ended"
        ? { cost: event.data.cost, tokens: event.data.tokens }
        : event.data.cost !== undefined && event.data.tokens !== undefined
          ? { cost: event.data.cost, tokens: event.data.tokens }
          : next.usage;
      return { ...next, usage };
    }
    case "session.tool.input.started":
      return applyAssistantEvent(state, event.data.assistantMessageID, {
        kind: "tool",
        id: `tool:${event.data.assistantMessageID}:${event.data.id}`,
        order: state.messages[event.data.assistantMessageID]?.parts.length ?? 0,
        name: event.data.name,
        input: {},
        output: undefined,
        status: "running",
        permissionId: null,
      });
    case "session.tool.input.delta": {
      const current = assistantToolPart(state, event.data.assistantMessageID, event.data.id);
      const previousText = typeof current.input.text === "string" ? current.input.text : "";
      return updateAssistantTool(state, event.data.assistantMessageID, event.data.id, {
        input: { ...current.input, text: `${previousText}${event.data.delta}` },
        output: undefined,
        status: "running",
      });
    }
    case "session.tool.input.ended":
      return updateAssistantTool(state, event.data.assistantMessageID, event.data.id, {
        input: toolInputFromText(event.data.text),
        output: undefined,
        status: "running",
      });
    case "session.tool.called":
      return updateAssistantTool(state, event.data.assistantMessageID, event.data.id, {
        input: event.data.input,
        output: undefined,
        status: "running",
      });
    case "session.tool.progress":
      return updateAssistantTool(state, event.data.assistantMessageID, event.data.id, {
        metadata: event.data.metadata,
        output: undefined,
        status: "running",
      });
    case "session.tool.success":
      return updateAssistantTool(state, event.data.assistantMessageID, event.data.id, {
        output: event.data.content,
        ...(event.data.metadata === undefined ? {} : { metadata: event.data.metadata }),
        status: "complete",
      });
    case "session.tool.failed":
      return updateAssistantTool(state, event.data.assistantMessageID, event.data.id, {
        output: {
          error: event.data.error.message,
          type: event.data.error.type,
          ...(event.data.content === undefined ? {} : { content: event.data.content }),
        },
        ...(event.data.metadata === undefined ? {} : { metadata: event.data.metadata }),
        status: "error",
      });
    case "session.step.started":
      return applyAssistantEvent(state, event.data.assistantMessageID, {
        kind: "step",
        id: `step:${event.data.assistantMessageID}:${event.id}`,
        order: state.messages[event.data.assistantMessageID]?.parts.length ?? 0,
        status: "started",
      });
    default:
      return state;
  }
}

function reduceAction(state: V2ThreadState, action: V2ThreadAction): V2ThreadState {
  switch (action.type) {
    case "v2_event":
      return reduceV2Event(state, action.event, action.ordinal, action.mode);
    case "connection_changed":
      return { ...state, connection: action.connection };
    case "load_started":
      return { ...state, load: { type: "loading" } };
    case "load_reconciling":
      return { ...state, load: { type: "reconciling" } };
    case "load_reconciled":
      return state.load.type === "reconciling" ? { ...state, load: { type: "loading" } } : state;
    case "load_completed":
      return { ...state, load: { type: "ready" } };
    case "load_failed":
      return { ...state, load: { type: "error", error: action.error }, execution: { type: "idle" } };
    case "session_hydrated":
      return {
        ...state,
        session: action.session,
        model: modelRefToV2Selection(action.session.model),
        agent: action.session.agent ?? null,
        usage: { cost: action.session.cost, tokens: action.session.tokens },
      };
    case "desired_selection_changed":
      return action.generation <= state.selectionGeneration
        ? state
        : {
            ...state,
            desiredModel: action.selection.model,
            desiredAgent: action.selection.agent,
            selectionGeneration: action.generation,
          };
    case "history_loaded": {
      const messages = Object.fromEntries(
        action.messages.map((message) => [message.id, message]),
      );
      const optimistic = state.optimisticMessageIds
        .filter((messageId) => !(messageId in messages))
        .map((messageId) => state.messages[messageId])
        .filter((message): message is V2MessageState => message !== undefined);
      const merged = [...action.messages, ...optimistic];
      return {
        ...state,
        messages: Object.fromEntries(merged.map((message) => [message.id, message])),
        messageOrder: [
          ...action.messageOrder,
          ...optimistic.map((message) => message.id).filter((id) => !action.messageOrder.includes(id)),
        ],
      };
    }
    case "inbox_hydrated":
      return {
        ...state,
        inboxById: Object.fromEntries(action.records.map((record) => [record.id, record])),
      };
    case "inbox_recorded":
      return recordInbox(state, action.record);
    case "permissions_hydrated":
      return action.requestOrdinal < state.eventIdentity.nextOrdinal
        ? state
        : { ...state, permissions: [...action.requests] };
    case "forms_hydrated":
      return { ...state, forms: [...action.forms] };
    case "prompt_submitting": {
      const alreadySubmitted = state.optimisticMessageIds.includes(action.message.id);
      const next: V2ThreadState = {
        ...state,
        messages: { ...state.messages, [action.message.id]: action.message },
        messageOrder: state.messageOrder.includes(action.message.id)
          ? state.messageOrder
          : [...state.messageOrder, action.message.id],
        optimisticMessageIds: alreadySubmitted
          ? state.optimisticMessageIds
          : [...state.optimisticMessageIds, action.message.id],
      };
      if (next.execution.type === "reverting") return next;
      return {
        ...next,
        execution: { type: "submitting", userMessageId: action.message.id, cancelRequested: false },
      };
    }
    case "prompt_admitted": {
      const next = recordInbox(state, action.inbox);
      return isTerminalExecution(next.execution) || next.execution.type === "reverting"
        ? next
        : {
            ...next,
            execution: {
              type: "admitted",
              userMessageId: action.userMessageId,
              inboxId: action.inbox.id,
              delivery: action.inbox.delivery,
              cancelRequested: next.execution.type === "cancelling"
                ? true
                : executionCancelRequested(next.execution),
            },
          };
    }
    case "prompt_removed": {
      const { [action.messageId]: _removed, ...messages } = state.messages;
      return {
        ...state,
        messages,
        messageOrder: state.messageOrder.filter((id) => id !== action.messageId),
        optimisticMessageIds: state.optimisticMessageIds.filter((id) => id !== action.messageId),
      };
    }
    case "prompt_reconciling":
      return isTerminalExecution(state.execution) || state.execution.type === "reverting"
        ? state
        : {
            ...state,
            execution: {
              type: "reconciling",
              userMessageId: action.userMessageId,
              cancelRequested: action.cancelRequested,
            },
          };
    case "cancel_requested":
      return isTerminalExecution(state.execution) || state.execution.type === "reverting"
        ? state
        : {
            ...state,
            execution: {
              type: "cancelling",
              phase: action.phase,
              userMessageId: action.userMessageId,
              inboxId: action.inboxId,
              assistantMessageId: action.assistantMessageId,
            },
          };
    case "execution_started":
      return applyExecutionStarted(state);
    case "execution_streaming": {
      if (isTerminalExecution(state.execution) || state.execution.type === "reverting") return state;
      const ids = currentUserAndInbox(state);
      return {
        ...state,
        execution: {
          type: "streaming",
          userMessageId: ids.userMessageId,
          inboxId: ids.inboxId,
          assistantMessageId: action.assistantMessageId,
          cancelRequested: state.execution.type === "cancelling",
        },
      };
    }
    case "execution_settled":
      return isTerminalExecution(state.execution) ? state : { ...state, execution: { type: "idle" } };
    case "execution_failed":
      return {
        ...state,
        execution: {
          type: "error",
          userMessageId: action.userMessageId,
          assistantMessageId: action.assistantMessageId,
          error: action.error,
        },
      };
    case "revert_recovery_staging":
      return {
        ...state,
        revertRecovery: { type: "staging" },
        execution: { type: "reverting", userMessageId: action.userMessageId },
      };
    case "revert_recovery_clearing":
      return {
        ...state,
        revertRecovery: { type: "clearing" },
        execution: { type: "reverting", userMessageId: action.userMessageId },
      };
    case "revert_recovery_cleared":
      return { ...state, revertRecovery: { type: "none" }, execution: { type: "idle" } };
    case "revert_recovery_failed":
      return {
        ...state,
        revertRecovery: { type: "blocked", error: action.error },
        execution: {
          type: "error",
          userMessageId: action.userMessageId,
          assistantMessageId: state.execution.type === "streaming" ? state.execution.assistantMessageId : null,
          error: action.error,
        },
      };
    case "compaction_admitted":
      return {
        ...state,
        compaction: { type: "admitted", inboxId: action.inbox.id },
        inboxById: { ...state.inboxById, [action.inbox.id]: action.inbox },
      };
    case "compaction_running":
      return { ...state, compaction: { type: "running" } };
    case "compaction_settled":
      return { ...state, compaction: { type: "idle" } };
    case "compaction_failed":
      return { ...state, compaction: { type: "error", error: action.error } };
    case "permission_answered":
      return {
        ...state,
        permissions: state.permissions.filter((permission) => permission.id !== action.requestId),
        answeredPermissionIds: appendId(state.answeredPermissionIds, action.requestId),
      };
    case "permission_retired":
      return { ...state, permissions: state.permissions.filter((permission) => permission.id !== action.requestId) };
    case "form_retired":
      return { ...state, forms: state.forms.filter((form) => form.id !== action.formId) };
    case "runtime_messages_reconciled": {
      const removed = new Set(action.messageIds);
      return {
        ...state,
        optimisticMessageIds: state.optimisticMessageIds.filter((id) => !removed.has(id)),
      };
    }
    default:
      return state;
  }
}

/** Reduces one public V2 event while preserving identity and hydration ordering. */
export function reduceV2Event(
  state: V2ThreadState,
  event: V2Event,
  ordinal: number,
  mode: "observe-only" | "observe-and-apply" = "observe-and-apply",
): V2ThreadState {
  if (REPLAY_ONLY_EVENT_TYPES.has(event.type) || !PUBLIC_EVENT_TYPES.has(event.type)) {
    return incrementDiagnostic(state);
  }
  const sessionId = getEventSessionId(event);
  if (sessionId !== null && sessionId !== state.sessionId) return incrementDiagnostic(state);
  if (state.eventIdentity.recentObservedEventIds.includes(event.id) && mode === "observe-only") {
    return state;
  }
  if (state.eventIdentity.recentAppliedEventIds.includes(event.id)) return state;
  const durable = getDurableSequence(event);
  if (durable) {
    const highWater = state.eventIdentity.durableSequenceByAggregate[durable.aggregateID];
    if (highWater !== undefined && durable.seq <= highWater) return incrementDiagnostic(state);
  }
  let next: V2ThreadState = {
    ...state,
    eventIdentity: {
      ...state.eventIdentity,
      nextOrdinal: Math.max(state.eventIdentity.nextOrdinal, ordinal + 1),
      recentObservedEventIds: appendId(state.eventIdentity.recentObservedEventIds, event.id),
    },
  };
  if (mode === "observe-only") return next;
  next = applyKnownEvent(next, event);
  const durableSequenceByAggregate = durable
    ? { ...next.eventIdentity.durableSequenceByAggregate, [durable.aggregateID]: durable.seq }
    : next.eventIdentity.durableSequenceByAggregate;
  return {
    ...next,
    eventIdentity: {
      ...next.eventIdentity,
      recentAppliedEventIds: appendId(next.eventIdentity.recentAppliedEventIds, event.id),
      durableSequenceByAggregate,
    },
  };
}

/** Reduces a typed state action without I/O or React dependencies. */
export function reduceV2ThreadState(
  state: V2ThreadState,
  action: V2ThreadAction,
): V2ThreadState {
  return reduceAction(state, action);
}

/** Creates the initial state for one scoped OpenCode session. */
export function createInitialV2ThreadState(sessionId: string): V2ThreadState {
  return {
    sessionId,
    connection: { type: "waiting-for-server" },
    load: { type: "idle" },
    execution: { type: "idle" },
    compaction: { type: "idle" },
    revertRecovery: { type: "none" },
    eventIdentity: EMPTY_EVENT_IDENTITY,
    session: null,
    model: null,
    agent: null,
    desiredModel: null,
    desiredAgent: null,
    selectionGeneration: 0,
    messages: {},
    messageOrder: [],
    permissions: [],
    forms: [],
    inboxById: {},
    usage: null,
    optimisticMessageIds: [],
    answeredPermissionIds: [],
    diagnosticCount: 0,
  };
}
