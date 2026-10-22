import type { SessionInboxItem, SessionMessageInfo, V2Event } from "@opencode/client";
import {
  OPENCODE_V2_DIAGNOSTIC_COUNT_CAP,
  OPENCODE_V2_RECENT_EVENT_ID_WINDOW,
} from "@/features/opencode/config";
import { resolveCodeOccupancy } from "./codeOccupancy";
import {
  modelRefToV2Selection,
  type V2AuxiliaryAvailability,
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

/**
 * True when two pending lists hold the same identities in the same order.
 *
 * A re-sync that finds nothing new must be a true NO-OP. Allocating a fresh
 * array here would hand the runtime store a new state object on every poll,
 * which rebuilds the assistant-ui adapter and re-renders the whole transcript
 * to redraw an identical screen.
 *
 * Identity is the correct comparison, not deep equality: a pending permission
 * or form is immutable once created. It leaves the pending set by being
 * answered or cancelled, never by mutating in place, so an id+order match
 * means the rendered result cannot differ.
 */
function sameIdentitySequence(
  current: readonly { readonly id: string }[],
  incoming: readonly { readonly id: string }[],
): boolean {
  if (current.length !== incoming.length) return false;
  return current.every((item, index) => item.id === incoming[index]?.id);
}

/**
 * Reconciles one pending set with the server's answer.
 *
 * The three pending sets are read over a live stream, so the same race applies
 * to them as to the transcript: an entry can be created while the read is in
 * flight, and an entry can leave by being answered. What must NOT happen is a
 * stale answer overwriting either.
 *
 * - An entry the read returned is taken from the snapshot: the server owns its
 *   content.
 * - An entry the client held, that the snapshot omits, is gone: answering or
 *   cancelling it removed it server-side.
 * - An entry the client did NOT hold is one created during the read, so it is
 *   kept and appended. `permission.asked` and `form.created` arrive as events,
 *   and dropping them here would make a prompt disappear mid-flight.
 *
 * A failed read never reaches this function: `null` means the list could not be
 * read, which says nothing about its contents.
 *
 * @param current - The entries held before the read.
 * @param held - The ids of `current` when the read started.
 * @param incoming - The server's answer.
 * @returns The reconciled list, or `current` itself when nothing changed.
 */
function reconcilePending<T extends { readonly id: string }>(
  current: readonly T[],
  held: readonly string[],
  incoming: readonly T[],
): readonly T[] {
  const answeredOrCancelled = new Set(incoming.map((item) => item.id));
  const heldIds = new Set(held);
  const createdDuringRead = current.filter(
    (item) => !answeredOrCancelled.has(item.id) && !heldIds.has(item.id),
  );
  const merged = createdDuringRead.length === 0 ? incoming : [...incoming, ...createdDuringRead];
  return sameIdentitySequence(current, merged) ? current : merged;
}

/**
 * The availability a hydration action leaves its kind in.
 *
 * @param incoming - The server's answer, or null when the read failed.
 * @returns `current` for an answer, `unavailable` for a failed read.
 */
function availabilityFor(incoming: readonly unknown[] | null): V2AuxiliaryAvailability {
  return incoming === null ? "unavailable" : "current";
}

function getEventSessionId(event: V2Event): string | null {
  const data: unknown = event.data;
  if (!data || typeof data !== "object" || !("sessionID" in data)) return null;
  const sessionID = data.sessionID;
  return typeof sessionID === "string" ? sessionID : null;
}

/**
 * The directory an event was produced in, when the event says.
 *
 * Every V2 event carries an optional `location` (`LocationRef`), and the
 * contract provides it precisely so a client can verify the scope of what it
 * receives.
 */
function getEventDirectory(event: V2Event): string | null {
  if (!("location" in event)) return null;
  const location: unknown = event.location;
  if (!location || typeof location !== "object") return null;
  const directory = (location as { readonly directory?: unknown }).directory;
  return typeof directory === "string" && directory.length > 0 ? directory : null;
}

/**
 * A path in a comparable form: trailing separators removed and the separator
 * unified, so two spellings of one directory compare equal.
 */
function normalizeDirectory(directory: string): string {
  const trimmed = directory.trim().replace(/[\\/]+$/, "");
  const unified = trimmed.replace(/\\/g, "/");
  return unified.length > 0 ? unified : directory.trim();
}

/** Whether a normalized path is a Windows drive path, which is case-insensitive. */
function isWindowsStylePath(directory: string): boolean {
  return /^[a-zA-Z]:\//.test(directory);
}

/**
 * Whether two paths name the same directory.
 *
 * The comparison is about the DIRECTORY, not about the spelling: a trailing
 * separator and a `\` versus `/` are the same path, and a Windows path is
 * case-insensitive. Two different directories never compare equal.
 */
function sameDirectory(left: string, right: string): boolean {
  const a = normalizeDirectory(left);
  const b = normalizeDirectory(right);
  if (a === b) return true;
  if (isWindowsStylePath(a) && isWindowsStylePath(b)) return a.toLowerCase() === b.toLowerCase();
  return false;
}

/**
 * Whether an event belongs to the workspace this view is subscribed to.
 *
 * This is **defence in depth**, not the scope control itself: the backend
 * already refuses a request that names another workspace, and the upstream
 * scopes the event stream. What this adds is that the client does not APPLY
 * an event that says it came from somewhere else.
 *
 * Two directories are accepted as this view's own:
 *
 * - the directory the client subscribed to, and
 * - the directory the SERVER reports for the session, which is the same
 *   directory in the server's spelling. Accepting it keeps a difference in
 *   how the two spell one path from silencing the whole stream.
 *
 * An event with no `location` is kept: it is location-scoped by definition
 * (`server.connected` is the case the contract names), and there is nothing to
 * compare.
 */
function isEventInScope(state: V2ThreadState, event: V2Event): boolean {
  const eventDirectory = getEventDirectory(event);
  if (eventDirectory === null) return true;

  const subscribed = state.directory;
  if (subscribed !== null && sameDirectory(subscribed, eventDirectory)) return true;

  const sessionDirectory = state.session?.location.directory ?? null;
  if (sessionDirectory !== null && sameDirectory(sessionDirectory, eventDirectory)) return true;

  // Neither scope is known, so nothing can be compared: the event is kept
  // rather than every event being dropped.
  return subscribed === null && sessionDirectory === null;
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

function withMessage(state: V2ThreadState, message: V2MessageState): V2ThreadState {
  const exists = state.messageOrder.includes(message.id);
  return {
    ...state,
    messages: { ...state.messages, [message.id]: message },
    messageOrder: exists ? state.messageOrder : [...state.messageOrder, message.id],
  };
}

function replacePart(message: V2MessageState, part: V2MessagePartState): V2MessageState {
  const index = message.parts.findIndex((candidate) => candidate.id === part.id);
  const parts =
    index < 0
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

function currentUserAndInbox(state: V2ThreadState): {
  userMessageId: string | null;
  inboxId: string | null;
} {
  if (
    state.execution.type === "submitting" ||
    state.execution.type === "admitted" ||
    state.execution.type === "reconciling"
  ) {
    return {
      userMessageId: state.execution.userMessageId,
      inboxId: state.execution.type === "admitted" ? state.execution.inboxId : null,
    };
  }
  if (
    state.execution.type === "executing" ||
    state.execution.type === "streaming" ||
    state.execution.type === "cancelling"
  ) {
    return {
      userMessageId: state.execution.userMessageId,
      inboxId: state.execution.inboxId,
    };
  }
  return { userMessageId: null, inboxId: null };
}

function recordInbox(state: V2ThreadState, record: V2InboxRecord): V2ThreadState {
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
  const type =
    item.type === "compaction"
      ? "compaction"
      : item.type === "synthetic"
        ? "synthetic"
        : item.type === "move"
          ? "move"
          : "user";
  return { id: inboxId, sessionId, type, delivery: item.delivery };
}

/**
 * Project a server error payload onto the safe shape the UI may render.
 *
 * Exported so the controller's side effects can reuse the SAME mapping rather
 * than inventing a second one - a compaction failure is displayed through this
 * function like every other error.
 *
 * @returns The safe error, carrying the server's own message and status.
 */
export function mapEventError(error: { message: string; status?: number }): V2SafeError {
  return {
    kind: error.status && error.status >= 500 ? "server" : "unknown",
    message: error.message,
    status: error.status,
  };
}

function applyModelEvent(
  state: V2ThreadState,
  event: Extract<V2Event, { type: "session.model.selected" }>,
): V2ThreadState {
  return { ...state, model: modelRefToV2Selection(event.data.model) };
}

function applyAgentEvent(
  state: V2ThreadState,
  event: Extract<V2Event, { type: "session.agent.selected" }>,
): V2ThreadState {
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
      cancelRequested:
        state.execution.type === "cancelling"
          ? true
          : state.execution.type === "submitting" ||
              state.execution.type === "admitted" ||
              state.execution.type === "reconciling"
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
  return existing?.kind === "tool"
    ? existing
    : {
        kind: "tool",
        id: `tool:${assistantMessageId}:${toolId}`,
        order: message.parts.length,
        name: "unknown",
        input: {},
        output: undefined,
        status: "running",
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

/**
 * Settles a tool part's duration when the server reports it finished.
 *
 * The completion time is MERGED onto whatever start the part already carries,
 * never written as a whole new `timing`. Two consequences, both deliberate:
 *
 * - A part whose `session.tool.input.started` was never observed (a reload
 *   that landed mid-run, a dropped event) keeps NO timing, rather than gaining
 *   a duration measured from an origin nobody recorded. `useToolCallElapsed`
 *   then renders nothing, which is the honest outcome.
 * - A part that already has a start keeps exactly that start, so the number
 *   does not change as the call finishes.
 */
function settleAssistantToolTiming(
  state: V2ThreadState,
  assistantMessageId: string,
  toolId: string,
  completedAt: number,
): V2ThreadState {
  const current = assistantToolPart(state, assistantMessageId, toolId);
  if (current.timing === undefined) return state;
  return applyAssistantEvent(state, assistantMessageId, {
    ...current,
    timing: { ...current.timing, completedAt },
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
      // Spend only. This event reports the SESSION's cumulative ledger, so it is
      // the wrong thing to measure occupancy from AND the wrong thing to clear a
      // compaction invalidation with: after a compaction the ledger still counts
      // every pre-compaction round trip, so clearing here repopulated the meter
      // with the traffic the compaction was meant to remove. Only a per-response
      // measurement (`session.step.ended`) or the persisted messages
      // (`history_loaded`) can resolve the occupancy.
      return {
        ...state,
        usage: { cost: event.data.cost, tokens: event.data.tokens },
      };
    case "session.inbox.enqueued":
      return recordInbox(
        state,
        inboxRecordFromItem(event.data.sessionID, event.data.inboxID, event.data.item),
      );
    case "session.inbox.cancelled": {
      // The server DELETES the inbox row when it cancels a pending entry
      // (upstream `SessionInbox.cancel` -> `projectDelivered` deletes the
      // row). The entry is therefore gone, and the pending list must not keep
      // showing it.
      const record = state.inboxById[event.data.inboxID];
      if (!record) return state;
      const { [event.data.inboxID]: _cancelled, ...inboxById } = state.inboxById;
      return { ...state, inboxById };
    }
    case "session.execution.started":
      return applyExecutionStarted(state);
    case "session.execution.succeeded":
    case "session.execution.interrupted":
    case "session.idle":
      return isTerminalExecution(state.execution)
        ? state
        : { ...state, execution: { type: "idle" } };
    case "session.execution.failed":
      return {
        ...state,
        execution: {
          type: "error",
          userMessageId: currentUserAndInbox(state).userMessageId,
          assistantMessageId:
            state.execution.type === "streaming" ? state.execution.assistantMessageId : null,
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
        permissions: state.permissions.filter(
          (permission) => permission.id !== event.data.requestID,
        ),
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
      const part = message.parts.find(
        (candidate) =>
          candidate.id === `text:${event.data.assistantMessageID}:${event.data.ordinal}`,
      );
      if (part?.kind !== "text") return state;
      return updateAssistantPart(state, event.data.assistantMessageID, {
        ...part,
        value: event.data.text,
        status: "complete",
      });
    }
    case "session.reasoning.ended": {
      const message = getMessage(state, event.data.assistantMessageID);
      const part = message.parts.find(
        (candidate) =>
          candidate.id === `reasoning:${event.data.assistantMessageID}:${event.data.ordinal}`,
      );
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
      // Occupancy is settled from this event even when there is no step part to
      // finish: a response's tokens are the current window whether or not its
      // parts arrived, and returning early here used to strand the meter in
      // "unknown" for the rest of the session after one compaction.
      const occupancyTokens = event.data.tokens ?? state.occupancyTokens;
      if (part?.kind !== "step") {
        return event.data.tokens ? { ...state, occupancyTokens, occupancyStale: false } : state;
      }
      const next = updateAssistantPart(state, event.data.assistantMessageID, {
        ...part,
        status: event.type === "session.step.failed" ? "error" : "finished",
      });
      const usage =
        event.type === "session.step.ended"
          ? { cost: event.data.cost, tokens: event.data.tokens }
          : event.data.cost !== undefined && event.data.tokens !== undefined
            ? { cost: event.data.cost, tokens: event.data.tokens }
            : next.usage;
      // A step's usage is measured against the CURRENT prompt, so it clears any
      // compaction invalidation. Without this the meter would stay unknown for
      // the rest of the session after one compaction.
      const measured = usage !== next.usage;
      // A step's tokens describe the prompt THIS response was given, so they are
      // the occupancy. The last step of a turn supersedes its earlier steps, and
      // the last turn supersedes earlier turns - which is exactly OpenChamber's
      // "newest assistant response that reported tokens".
      return {
        ...next,
        usage,
        occupancyTokens,
        ...(event.data.tokens
          ? { occupancyStale: false }
          : measured
            ? { occupancyStale: false }
            : {}),
      };
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
        // The call has begun, so this is the start. `input.started` is the FIRST
        // event OpenCode emits for a tool part, which makes it the only
        // defensible live start marker: `session.tool.called` arrives after the
        // arguments finish streaming, and the later events are all end markers.
        timing: { startedAt: event.created },
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
    case "session.tool.success": {
      const next = updateAssistantTool(state, event.data.assistantMessageID, event.data.id, {
        output: event.data.content,
        ...(event.data.metadata === undefined ? {} : { metadata: event.data.metadata }),
        status: "complete",
      });
      // A failure and a success both END the call, so both settle the clock.
      return settleAssistantToolTiming(
        next,
        event.data.assistantMessageID,
        event.data.id,
        event.created,
      );
    }
    case "session.tool.failed": {
      const next = updateAssistantTool(state, event.data.assistantMessageID, event.data.id, {
        output: {
          error: event.data.error.message,
          type: event.data.error.type,
          ...(event.data.content === undefined ? {} : { content: event.data.content }),
        },
        ...(event.data.metadata === undefined ? {} : { metadata: event.data.metadata }),
        status: "error",
      });
      return settleAssistantToolTiming(
        next,
        event.data.assistantMessageID,
        event.data.id,
        event.created,
      );
    }
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
      return reduceV2Event(state, action.event, action.mode);
    case "connection_changed":
      return { ...state, connection: action.connection };
    case "load_started":
      return { ...state, load: { type: "loading" } };
    case "load_completed":
      return { ...state, load: { type: "ready" } };
    case "load_failed":
      return {
        ...state,
        load: { type: "error", error: action.error },
        execution: { type: "idle" },
      };
    case "session_hydrated":
      // The server's own snapshot is authoritative on reload, including about
      // compactions it has already performed, so nothing is stale here. This is
      // what keeps reload after a compaction from inventing an "unknown" state
      // that OpenCode has already resolved.
      return {
        ...state,
        session: action.session,
        model: modelRefToV2Selection(action.session.model),
        agent: action.session.agent ?? null,
        usage: { cost: action.session.cost, tokens: action.session.tokens },
        occupancyStale: false,
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
      const inSnapshot = new Set(action.messages.map((message) => message.id));
      const snapshotSources = new Map(
        action.messages.map((message) => [message.id, message.source] as const),
      );
      const held = new Set(action.merge.held);
      const touched = new Set(action.merge.touched);
      // What the snapshot cannot speak for: a message created after the read
      // started, one a live event changed while it was in flight, and — always —
      // an optimistic prompt the server has not admitted yet. Everything else
      // the client holds and the snapshot omits was deleted server-side, which
      // is the only deletion this merge performs.
      const keptOrder = state.messageOrder.filter((messageId) => {
        if (inSnapshot.has(messageId)) return false;
        if (state.optimisticMessageIds.includes(messageId)) return true;
        return !held.has(messageId) || touched.has(messageId);
      });
      const kept = keptOrder
        .map((messageId) => state.messages[messageId])
        .filter((message): message is V2MessageState => message !== undefined);
      // A message the snapshot carries normally takes the SNAPSHOT's version —
      // that is what lets a refresh repair a transcript that drifted — except
      // when a live event changed it while this read was in flight, where the
      // live copy is strictly newer.
      const resolved = action.messages.map((message) =>
        touched.has(message.id) ? (state.messages[message.id] ?? message) : message,
      );
      const merged = [...resolved, ...kept];
      // Occupancy is re-derived from the PERSISTED messages, not from the live
      // event stream and not from the session ledger. This is what makes reload
      // and resume correct after a compaction: a session whose last message is a
      // finished compaction comes back `unknown` instead of resurrecting the
      // pre-compaction figure the ledger still remembers.
      const ordered = action.messageOrder
        .map((messageId) => state.messages[messageId]?.source ?? snapshotSources.get(messageId))
        .filter((source): source is SessionMessageInfo => source !== undefined && source !== null);
      const occupancy = resolveCodeOccupancy(ordered);
      return {
        ...state,
        messages: Object.fromEntries(merged.map((message) => [message.id, message])),
        messageOrder: [...action.messageOrder, ...keptOrder],
        occupancyTokens: occupancy?.state === "measured" ? occupancy.tokens : state.occupancyTokens,
        occupancyStale:
          occupancy?.state === "unknown" ? true : occupancy === null ? state.occupancyStale : false,
      };
    }
    case "inbox_hydrated": {
      const availability = availabilityFor(action.records);
      const current = Object.values(state.inboxById);
      const merged =
        action.records === null ? current : reconcilePending(current, action.held, action.records);
      const next =
        merged === current
          ? state.inboxById
          : Object.fromEntries(merged.map((record) => [record.id, record]));
      // A failed read leaves the last known list in place and only moves the
      // availability, so a surface can say the shown set is stale rather than
      // showing an empty inbox that is not the server's answer.
      return next === state.inboxById && state.auxiliary.inbox === availability
        ? state
        : { ...state, inboxById: next, auxiliary: { ...state.auxiliary, inbox: availability } };
    }
    case "inbox_recorded":
      return recordInbox(state, action.record);
    case "permissions_hydrated": {
      const availability = availabilityFor(action.requests);
      const next =
        action.requests === null
          ? state.permissions
          : reconcilePending(state.permissions, action.held, action.requests);
      return next === state.permissions && state.auxiliary.permissions === availability
        ? state
        : {
            ...state,
            permissions: next,
            auxiliary: { ...state.auxiliary, permissions: availability },
          };
    }
    case "forms_hydrated": {
      const availability = availabilityFor(action.forms);
      const next =
        action.forms === null
          ? state.forms
          : reconcilePending(state.forms, action.held, action.forms);
      return next === state.forms && state.auxiliary.forms === availability
        ? state
        : { ...state, forms: next, auxiliary: { ...state.auxiliary, forms: availability } };
    }
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
              cancelRequested:
                next.execution.type === "cancelling"
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
              // A cancel requested before the prompt was admitted is still OWED:
              // the prompt is queued on the server and nothing has removed it
              // yet. The flag is what the admission path reads to issue that
              // cancel once the inbox id exists (M7).
              cancelRequested: action.phase !== "execution",
            },
          };
    case "execution_started":
      return applyExecutionStarted(state);
    case "execution_streaming": {
      if (isTerminalExecution(state.execution) || state.execution.type === "reverting")
        return state;
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
      return isTerminalExecution(state.execution)
        ? state
        : { ...state, execution: { type: "idle" } };
    case "events_dropped": {
      // The count is the CUMULATIVE loss, so it is SET rather than added -
      // otherwise a stream that keeps overflowing would inflate the number
      // past what was actually lost. The events are NOT recovered: the count is
      // how the state admits that.
      //
      // It is its OWN field, not the diagnostic count: that one counts events
      // the runtime ignored for other reasons, and a loss must not be
      // indistinguishable from an ignored event.
      return {
        ...state,
        droppedEventCount: Math.min(Math.max(0, action.count), OPENCODE_V2_DIAGNOSTIC_COUNT_CAP),
      };
    }
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
          assistantMessageId:
            state.execution.type === "streaming" ? state.execution.assistantMessageId : null,
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
      // The conversation the `usage` snapshot describes no longer exists. The
      // spend breakdown is kept (it was really spent); only the context
      // NUMERATOR is invalidated, so the meter reports unknown rather than
      // continuing to display a pre-compaction figure.
      return { ...state, compaction: { type: "idle" }, occupancyStale: true };
    case "compaction_failed":
      // A failed compaction left the conversation intact, so the reading still
      // describes it. Only a SUCCESSFUL compaction invalidates occupancy.
      return { ...state, compaction: { type: "error", error: action.error } };
    case "permission_answered":
      return {
        ...state,
        permissions: state.permissions.filter((permission) => permission.id !== action.requestId),
        answeredPermissionIds: appendId(state.answeredPermissionIds, action.requestId),
      };
    case "permission_retired":
      return {
        ...state,
        permissions: state.permissions.filter((permission) => permission.id !== action.requestId),
      };
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
  mode: "observe-only" | "observe-and-apply" = "observe-and-apply",
): V2ThreadState {
  if (REPLAY_ONLY_EVENT_TYPES.has(event.type) || !PUBLIC_EVENT_TYPES.has(event.type)) {
    return incrementDiagnostic(state);
  }
  const sessionId = getEventSessionId(event);
  if (sessionId !== null && sessionId !== state.sessionId) return incrementDiagnostic(state);
  if (!isEventInScope(state, event)) return incrementDiagnostic(state);
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
export function reduceV2ThreadState(state: V2ThreadState, action: V2ThreadAction): V2ThreadState {
  return reduceAction(state, action);
}

/**
 * Creates the initial state for one scoped OpenCode session.
 *
 * @param sessionId - The session this view is about.
 * @param directory - The workspace the event stream is subscribed to, or
 *   `null` when the server did not report a scope.
 */
export function createInitialV2ThreadState(
  sessionId: string,
  directory: string | null = null,
): V2ThreadState {
  return {
    sessionId,
    directory,
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
    // Nothing has been read yet, so no pending set is known to be current. A
    // successful read moves its kind to "current"; a failed one leaves it here
    // rather than pretending the empty list is the server's answer.
    auxiliary: { inbox: "unavailable", permissions: "unavailable", forms: "unavailable" },
    usage: null,
    occupancyTokens: null,
    occupancyStale: false,
    optimisticMessageIds: [],
    answeredPermissionIds: [],
    diagnosticCount: 0,
    droppedEventCount: 0,
  };
}
