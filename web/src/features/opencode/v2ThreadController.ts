import type {
  AppendMessage,
  CreateAppendMessage,
} from "@assistant-ui/react";
import type {
  SessionFormReplyInput,
  SessionInboxUser,
  SessionPromptInput,
  V2Event,
} from "@opencode/client";
import { logger } from "@/lib/logger";
import {
  OPENCODE_V2_EVENT_BUFFER_LIMIT,
  OPENCODE_V2_INITIAL_RECONNECT_DELAY_MS,
  OPENCODE_V2_MAX_RECONNECT_DELAY_MS,
} from "@/config/opencode";
import { loadV2History, projectV2History } from "./v2History";
import {
  createInitialV2ThreadState,
  reduceV2ThreadState,
} from "./v2Events";
import {
  toV2PromptInput,
} from "./v2MessageProjection";
import {
  projectV2Permission,
  type V2PermissionView,
} from "./v2Permissions";
import type {
  OpenCodeV2Client,
  OpenCodeV2Generation,
  V2ConnectionSignals,
} from "./v2Client";
import type {
  V2DesiredSelection,
  V2InboxRecord,
  V2MessageState,
  V2ModelSelection,
  V2SafeError,
  V2ThreadAction,
  V2ThreadState,
} from "./v2Types";

export const V2_PROMPT_MESSAGE_ID_KEY = "opencodeV2MessageId";
const V2_MESSAGE_ID_PREFIX = "msg_";
const V2_ABORTED_MESSAGE = "OpenCode V2 request was aborted";
const V2_DEFINITIVE_FAILURE_MESSAGE = "OpenCode V2 prompt was definitively rejected";
const V2_RECOVERY_REQUIRED_MESSAGE = "OpenCode V2 staged recovery must complete before admission";
const V2_DISPOSED_MESSAGE = "OpenCode V2 runtime was disposed";

type AdmissionRecord = {
  messageId: string;
  result: "admitted" | "definitive-failure" | "ambiguous" | "disposed" | null;
  submission: V2PromptSubmission | null;
  waiters: Set<(result: V2PromptAdmissionResult) => void>;
  settle: ((result: V2PromptAdmissionResult) => void) | null;
};

export type V2PromptOptions = {
  readonly messageId?: string;
  readonly model?: V2ModelSelection;
  readonly agent?: string;
  readonly delivery?: "steer" | "queue";
};

export type V2PromptAdmissionResult = "admitted" | "definitive-failure" | "ambiguous" | "disposed";
export type V2PromptSendError =
  | { readonly kind: "definitive-failure"; readonly error: V2SafeError }
  | { readonly kind: "disposed" };

export type V2PromptSubmission = {
  readonly messageId: string;
  readonly inboxId: string;
  readonly delivery: "steer" | "queue";
};

export interface V2ThreadController {
  getState(): V2ThreadState;
  subscribe(listener: () => void): () => void;
  setDesiredSelection(selection: V2DesiredSelection): void;
  load(): Promise<void>;
  awaitReady(): Promise<void>;
  refresh(): Promise<void>;
  reconcileStagedRevert(): Promise<void>;
  reconcilePendingPrompt(messageId: string): Promise<"admitted" | "absent" | "unresolved">;
  awaitPromptAdmission(messageId: string): Promise<V2PromptAdmissionResult>;
  sendMessage(message: AppendMessage, options?: V2PromptOptions): Promise<V2PromptSubmission>;
  regenerate(selectedAssistantParentId: string | null): Promise<void>;
  cancel(): Promise<void>;
  compact(): Promise<void>;
  replyToPermission(requestId: string, decision: "once" | "always" | "reject"): Promise<void>;
  reconcileAutoApprove(): Promise<number>;
  replyToForm(formId: string, answer: SessionFormReplyInput["answer"]): Promise<void>;
  rejectForm(formId: string): Promise<void>;
  reconcileRuntimeMessageIds(messageIds: readonly string[]): void;
  dispose(): void;
}

/** Allocates the stable local identity used for prompt admission. */
export function createV2MessageId(): string {
  return `${V2_MESSAGE_ID_PREFIX}${crypto.randomUUID()}`;
}

/** Copies a preallocated message id into assistant-ui's append metadata. */
export function attachV2PromptMessageId(message: string, messageId: string): string;
export function attachV2PromptMessageId<T extends CreateAppendMessage>(message: T, messageId: string): T;
export function attachV2PromptMessageId(
  message: CreateAppendMessage,
  messageId: string,
): CreateAppendMessage {
  if (typeof message === "string") return message;
  return {
    ...message,
    metadata: {
      ...message.metadata,
      custom: {
        ...message.metadata?.custom,
        [V2_PROMPT_MESSAGE_ID_KEY]: messageId,
      },
    },
  };
}

class V2ControllerError extends Error {
  public readonly safe: V2SafeError;

  public constructor(safe: V2SafeError) {
    super(safe.message);
    this.name = "V2ControllerError";
    this.safe = safe;
  }
}

function safeError(error: unknown, fallback: string): V2SafeError {
  if (error instanceof V2ControllerError) return error.safe;
  if (error instanceof DOMException && error.name === "AbortError") {
    return { kind: "aborted", message: V2_ABORTED_MESSAGE };
  }
  if (error instanceof TypeError) return { kind: "network", message: fallback };
  if (error !== null && typeof error === "object") {
    const candidate = error as { readonly status?: unknown; readonly message?: unknown };
    if (typeof candidate.status === "number") {
      return {
        kind: candidate.status >= 500 ? "server" : "unknown",
        message: typeof candidate.message === "string" ? candidate.message : fallback,
        status: candidate.status,
      };
    }
    if (typeof candidate.message === "string") return { kind: "network", message: candidate.message };
  }
  return { kind: "unknown", message: fallback };
}

function isDefinitiveFailure(error: unknown): boolean {
  const status = error !== null && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 425 && status !== 429;
}

function modelChanged(current: V2ModelSelection | null, desired: V2ModelSelection | null): boolean {
  return current?.providerID !== desired?.providerID || current?.modelID !== desired?.modelID || current?.variant !== desired?.variant;
}

function agentChanged(current: string | null, desired: string | null): boolean {
  return current !== desired;
}

function isAssistantMessageEvent(event: V2Event): boolean {
  return event.type.startsWith("session.text.") || event.type.startsWith("session.reasoning.") || event.type.startsWith("session.tool.") || event.type.startsWith("session.step.") || event.type === "session.retry.scheduled";
}

function inboxRecordFromUser(item: SessionInboxUser): V2InboxRecord {
  return {
    id: item.id,
    sessionId: item.sessionID,
    type: "user",
    delivery: item.delivery,
  };
}

function optimisticMessage(message: AppendMessage, messageId: string): V2ThreadState["messages"][string] {
  const payload = toV2PromptInput(message);
  return {
    id: messageId,
    parentId: message.parentId,
    role: "user",
    createdAt: Date.now(),
    parts: payload.text.length > 0
      ? [{ kind: "text", id: `text:${messageId}:0`, order: 0, value: payload.text, status: "complete" }]
      : [],
    source: null,
  };
}

function modelInput(model: V2ModelSelection): { readonly id: string; readonly providerID: string; readonly variant?: string } {
  return {
    id: model.modelID,
    providerID: model.providerID,
    ...(model.variant ? { variant: model.variant } : {}),
  };
}

/** Creates the single native OpenCode V2 session controller. */
export function createV2ThreadController(client: OpenCodeV2Client): V2ThreadController {
  let state = createInitialV2ThreadState(client.sessionId);
  let generation: OpenCodeV2Generation | null = null;
  let connectionController: AbortController | null = null;
  let lifecycleController: AbortController | null = null;
  let disposed = false;
  let ordinal = 0;
  let selectionGeneration = 0;
  let loadPromise: Promise<void> | null = null;
  let readyPromise: Promise<void> | null = null;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: unknown) => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let isHydrating = false;
  let eventBuffer: Array<{ readonly ordinal: number; readonly event: V2Event }> = [];
  const listeners = new Set<() => void>();
  const admissions = new Map<string, AdmissionRecord>();
  const answeredPermissions = new Set<string>();
  const formReplies = new Set<string>();

  function notify(): void {
    if (disposed) return;
    for (const listener of listeners) listener();
  }

  function dispatch(action: V2ThreadAction): void {
    if (disposed) return;
    const next = reduceV2ThreadState(state, action);
    if (next === state) return;
    state = next;
    notify();
  }

  function rejectAdmission(messageId: string, result: V2PromptAdmissionResult, submission: V2PromptSubmission | null = null): void {
    const record = admissions.get(messageId);
    if (!record || (record.result !== null && record.result !== "ambiguous")) return;
    record.result = result;
    record.submission = submission;
    for (const waiter of record.waiters) waiter(result);
    record.waiters.clear();
    record.settle?.(result);
    record.settle = null;
  }

  function markAdmissionAmbiguous(messageId: string): void {
    const record = admissions.get(messageId);
    if (!record || record.result !== null) return;
    record.result = "ambiguous";
    for (const waiter of record.waiters) waiter("ambiguous");
    record.waiters.clear();
  }

  function createAdmission(messageId: string): AdmissionRecord {
    const existing = admissions.get(messageId);
    if (existing) return existing;
    const record: AdmissionRecord = {
      messageId,
      result: null,
      submission: null,
      waiters: new Set(),
      settle: null,
    };
    admissions.set(messageId, record);
    return record;
  }

  function currentPermissions(): readonly V2PermissionView[] {
    return state.permissions
      .map(projectV2Permission)
      .filter((permission): permission is V2PermissionView => permission !== null);
  }

  function applyAdmissionEvent(event: V2Event): void {
    if (event.type !== "session.inbox.enqueued" || event.data.item.type !== "user") return;
    const item = event.data.item;
    const record: V2InboxRecord = {
      id: event.data.inboxID,
      sessionId: event.data.sessionID,
      type: "user",
      delivery: item.delivery,
    };
    const activeMessageId = state.execution.type === "submitting" || state.execution.type === "reconciling"
      ? state.execution.userMessageId
      : state.execution.type === "admitted" && state.execution.inboxId === event.data.inboxID
        ? state.execution.userMessageId
        : state.execution.type === "cancelling"
          ? state.execution.userMessageId
          : undefined;
    dispatch({ type: "inbox_recorded", record });
    if (typeof activeMessageId === "string") {
      dispatch({ type: "prompt_admitted", userMessageId: activeMessageId, inbox: record });
      rejectAdmission(activeMessageId, "admitted", {
        messageId: activeMessageId,
        inboxId: record.id,
        delivery: record.delivery,
      });
    }
  }

  function applyEvent(event: V2Event, eventOrdinal: number): void {
    dispatch({ type: "v2_event", event, ordinal: eventOrdinal, mode: "observe-only" });
    if (isAssistantMessageEvent(event)) {
      if (isHydrating) {
        eventBuffer.push({ ordinal: eventOrdinal, event });
        if (eventBuffer.length > OPENCODE_V2_EVENT_BUFFER_LIMIT) {
          eventBuffer = eventBuffer.filter((entry) => !isAssistantMessageEvent(entry.event)).slice(-OPENCODE_V2_EVENT_BUFFER_LIMIT);
        }
        return;
      }
      dispatch({ type: "v2_event", event, ordinal: eventOrdinal, mode: "observe-and-apply" });
      return;
    }
    dispatch({ type: "v2_event", event, ordinal: eventOrdinal, mode: "observe-and-apply" });
    applyAdmissionEvent(event);
  }

  async function consumeEvents(currentGeneration: OpenCodeV2Generation): Promise<void> {
    try {
      while (!disposed && generation === currentGeneration) {
        const result = await currentGeneration.events.next();
        if (result.done) throw new Error("OpenCode V2 event stream closed");
        if (disposed || generation !== currentGeneration) return;
        const eventOrdinal = ++ordinal;
        applyEvent(result.value, eventOrdinal);
      }
    } catch (error) {
      if (disposed || generation !== currentGeneration) return;
      scheduleReconnect(safeError(error, "OpenCode V2 event stream failed"));
    }
  }

  function scheduleReconnect(error: V2SafeError): void {
    if (disposed || reconnectTimer !== null) return;
    const failedGeneration = generation;
    generation = null;
    connectionController?.abort();
    if (failedGeneration) void failedGeneration.events.close();
    loadPromise = null;
    dispatch({ type: "connection_changed", connection: { type: "reconnecting", attempt: reconnectAttempt + 1 } });
    dispatch({ type: "load_failed", error });
    rejectReady?.(new V2ControllerError(error));
    rejectReady = null;
    const delay = Math.min(
      OPENCODE_V2_MAX_RECONNECT_DELAY_MS,
      OPENCODE_V2_INITIAL_RECONNECT_DELAY_MS * 2 ** reconnectAttempt,
    );
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void startConnection().catch(() => undefined);
    }, delay);
  }

  async function hydrate(currentGeneration: OpenCodeV2Generation, signals: V2ConnectionSignals): Promise<void> {
    const serverInfo = await currentGeneration.operations.serverInfo();
    if (disposed || generation !== currentGeneration) return;
    dispatch({ type: "connection_changed", connection: { type: "connected", serverVersion: serverInfo.version } });
    dispatch({ type: "load_started" });
    const session = await currentGeneration.operations.sessionGet({ sessionID: client.sessionId });
    if (disposed || generation !== currentGeneration) return;
    dispatch({ type: "session_hydrated", session });
    if (session.revert !== undefined) {
      dispatch({ type: "revert_recovery_clearing", userMessageId: session.revert.messageID });
      await currentGeneration.operations.revertClear({ sessionID: client.sessionId });
      const verified = await currentGeneration.operations.sessionGet({ sessionID: client.sessionId });
      if (verified.revert !== undefined) throw new V2ControllerError({ kind: "recovery-required", message: "OpenCode V2 staged revert could not be cleared" });
      dispatch({ type: "revert_recovery_cleared" });
    }
    const historyRequestOrdinal = ordinal;
    const snapshot = await loadV2History(currentGeneration.history, { signal: signals.connectionSignal });
    if (disposed || generation !== currentGeneration) return;
    const projection = projectV2History(snapshot, currentPermissions());
    dispatch({ type: "history_loaded", messages: projection.messages, messageOrder: projection.messageOrder, pages: projection.pages });
    const buffered = eventBuffer.filter((entry) => entry.ordinal > historyRequestOrdinal);
    for (const entry of buffered) dispatch({ type: "v2_event", event: entry.event, ordinal: entry.ordinal, mode: "observe-and-apply" });
    eventBuffer = [];
    isHydrating = false;
    const permissionRequestOrdinal = ordinal;
    const [inbox, permissions, forms] = await Promise.all([
      currentGeneration.operations.inboxList({ sessionID: client.sessionId }).catch((cause: unknown) => {
        logger.warn("opencode", "runtime.auxiliary_hydration_failed", { kind: "inbox", errorType: cause instanceof Error ? cause.name : typeof cause });
        return [];
      }),
      currentGeneration.operations.permissionList({ sessionID: client.sessionId }).catch((cause: unknown) => {
        logger.warn("opencode", "runtime.auxiliary_hydration_failed", { kind: "permission", errorType: cause instanceof Error ? cause.name : typeof cause });
        return [];
      }),
      currentGeneration.operations.formList({ sessionID: client.sessionId }).catch((cause: unknown) => {
        logger.warn("opencode", "runtime.auxiliary_hydration_failed", { kind: "form", errorType: cause instanceof Error ? cause.name : typeof cause });
        return [];
      }),
    ]);
    if (disposed || generation !== currentGeneration) return;
    dispatch({ type: "inbox_hydrated", records: inbox.map((item) => item.type === "user" ? inboxRecordFromUser(item) : { id: item.id, sessionId: item.sessionID, type: item.type, delivery: item.delivery }) });
    dispatch({ type: "permissions_hydrated", requests: permissions, requestOrdinal: permissionRequestOrdinal });
    // History was projected before the auxiliary permission snapshot arrived.
    // Reproject once so tool calls restored from history carry their approval
    // gate instead of appearing permanently stuck.
    const permissionProjection = projectV2History(snapshot, currentPermissions());
    dispatch({ type: "history_loaded", messages: permissionProjection.messages, messageOrder: permissionProjection.messageOrder, pages: permissionProjection.pages });
    dispatch({ type: "forms_hydrated", forms });
    dispatch({ type: "load_completed" });
  }

  async function startConnection(): Promise<void> {
    if (disposed) throw new V2ControllerError({ kind: "aborted", message: V2_DISPOSED_MESSAGE });
    isHydrating = true;
    connectionController?.abort();
    connectionController = new AbortController();
    lifecycleController ??= new AbortController();
    const signals: V2ConnectionSignals = {
      connectionSignal: connectionController.signal,
      lifecycleSignal: lifecycleController.signal,
    };
    readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // `load()` and `awaitReady()` are intentionally separate entry points. Mark
    // the internal promise handled even when a caller only awaits `load()`;
    // callers that do await `readyPromise` still receive the same rejection.
    void readyPromise.catch(() => undefined);
    let currentGeneration: OpenCodeV2Generation;
    try {
      currentGeneration = await client.connect(signals);
    } catch (error) {
      const safe = safeError(error, "OpenCode V2 connection failed");
      dispatch({ type: "load_failed", error: safe });
      rejectReady?.(new V2ControllerError(safe));
      rejectReady = null;
      resolveReady = null;
      throw new V2ControllerError(safe);
    }
    if (disposed || connectionController.signal.aborted) {
      await currentGeneration.events.close();
      throw new V2ControllerError({ kind: "aborted", message: V2_DISPOSED_MESSAGE });
    }
    generation = currentGeneration;
    void consumeEvents(currentGeneration);
    try {
      await hydrate(currentGeneration, signals);
      resolveReady?.();
      resolveReady = null;
      rejectReady = null;
      reconnectAttempt = 0;
    } catch (error) {
      const safe = safeError(error, "OpenCode V2 runtime failed to load");
      dispatch({ type: "load_failed", error: safe });
      rejectReady?.(error);
      rejectReady = null;
      resolveReady = null;
      throw error;
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (loadPromise) return loadPromise;
    loadPromise = startConnection().catch((error) => {
      loadPromise = null;
      throw error;
    });
    return loadPromise;
  }

  async function refresh(): Promise<void> {
    await ensureLoaded();
    if (!generation) throw new V2ControllerError({ kind: "not-found", message: "OpenCode V2 generation is unavailable" });
    dispatch({ type: "load_started" });
    try {
      const session = await generation.operations.sessionGet({ sessionID: client.sessionId });
      dispatch({ type: "session_hydrated", session });
      const snapshot = await loadV2History(generation.history);
      const projection = projectV2History(snapshot, currentPermissions());
      dispatch({ type: "history_loaded", messages: projection.messages, messageOrder: projection.messageOrder, pages: projection.pages });
      dispatch({ type: "load_completed" });
    } catch (error) {
      const safe = safeError(error, "OpenCode V2 refresh failed");
      dispatch({ type: "load_failed", error: safe });
      throw new V2ControllerError(safe);
    }
  }

  async function awaitReady(): Promise<void> {
    await ensureLoaded();
    if (readyPromise) await readyPromise;
  }

  async function reconcileStagedRevert(): Promise<void> {
    await awaitReady();
    if (!generation) throw new V2ControllerError({ kind: "not-found", message: "OpenCode V2 generation is unavailable" });
    try {
      const session = await generation.operations.sessionGet({ sessionID: client.sessionId });
      dispatch({ type: "session_hydrated", session });
      if (session.revert !== undefined) {
        dispatch({ type: "revert_recovery_clearing", userMessageId: session.revert.messageID });
        await generation.operations.revertClear({ sessionID: client.sessionId });
      }
      const verified = await generation.operations.sessionGet({ sessionID: client.sessionId });
      const snapshot = await loadV2History(generation.history);
      const projection = projectV2History(snapshot, currentPermissions());
      dispatch({ type: "history_loaded", messages: projection.messages, messageOrder: projection.messageOrder, pages: projection.pages });
      if (verified.revert !== undefined) throw new Error("staged revert remains");
      dispatch({ type: "revert_recovery_cleared" });
    } catch (error) {
      const safe = safeError(error, "OpenCode V2 staged recovery failed");
      dispatch({ type: "revert_recovery_failed", userMessageId: state.execution.type === "reverting" ? state.execution.userMessageId : null, error: safe });
      throw new V2ControllerError(safe);
    }
  }

  async function reconcilePendingPrompt(messageId: string): Promise<"admitted" | "absent" | "unresolved"> {
    await awaitReady();
    const inbox = Object.values(state.inboxById).find((record) => record.id === messageId || record.id === state.inboxById[messageId]?.id);
    if (inbox !== undefined) return "admitted";
    if (state.messages[messageId] !== undefined && !state.optimisticMessageIds.includes(messageId)) return "admitted";
    const record = admissions.get(messageId);
    if (record?.result === "ambiguous") {
      rejectAdmission(messageId, "definitive-failure");
      return "absent";
    }
    return "unresolved";
  }

  function awaitPromptAdmission(messageId: string): Promise<V2PromptAdmissionResult> {
    const record = createAdmission(messageId);
    if (record.result !== null) return Promise.resolve(record.result);
    return new Promise((resolve) => record.waiters.add(resolve));
  }

  async function applySelection(): Promise<void> {
    if (!generation) throw new V2ControllerError({ kind: "not-found", message: "OpenCode V2 generation is unavailable" });
    if (state.execution.type !== "idle" && state.execution.type !== "error") return;
    if (modelChanged(state.model, state.desiredModel) && state.desiredModel !== null) {
      await generation.operations.switchModel({ sessionID: client.sessionId, model: modelInput(state.desiredModel) });
    }
    if (agentChanged(state.agent, state.desiredAgent) && state.desiredAgent !== null) {
      await generation.operations.switchAgent({ sessionID: client.sessionId, agent: state.desiredAgent });
    }
  }

  async function sendMessage(message: AppendMessage, options: V2PromptOptions = {}): Promise<V2PromptSubmission> {
    await awaitReady();
    if (state.revertRecovery.type !== "none") throw new V2ControllerError({ kind: "recovery-required", message: V2_RECOVERY_REQUIRED_MESSAGE });
    if (!generation) throw new V2ControllerError({ kind: "not-found", message: "OpenCode V2 generation is unavailable" });
    const activeGeneration = generation;
    const customId = message.metadata?.custom?.[V2_PROMPT_MESSAGE_ID_KEY];
    const messageId = options.messageId ?? (typeof customId === "string" ? customId : createV2MessageId());
    if (!messageId.startsWith(V2_MESSAGE_ID_PREFIX)) throw new TypeError("OpenCode V2 prompt message id must start with msg_");
    await applySelection();
    const payload = toV2PromptInput(message);
    const localMessage = optimisticMessage(message, messageId);
    const record = createAdmission(messageId);
    dispatch({ type: "prompt_submitting", message: localMessage });
    const admissionPromise = new Promise<V2PromptAdmissionResult>((resolve) => { record.settle = resolve; });
    const input: SessionPromptInput = {
      sessionID: client.sessionId,
      id: messageId,
      text: payload.text,
      files: payload.files,
      agents: payload.agents,
      skills: payload.skills,
      delivery: options.delivery ?? "steer",
    };
    let definitiveError: V2SafeError | null = null;
    const promptRequest = Promise.resolve()
      .then(() => activeGeneration.operations.prompt(input))
      .then((response) => {
        if (disposed || record.result === "admitted") return;
        const normalized = inboxRecordFromUser(response);
        dispatch({ type: "inbox_recorded", record: normalized });
        dispatch({ type: "prompt_admitted", userMessageId: messageId, inbox: normalized });
        rejectAdmission(messageId, "admitted", {
          messageId,
          inboxId: normalized.id,
          delivery: normalized.delivery,
        });
      })
      .catch((error: unknown) => {
        if (disposed || record.result === "admitted") {
          if (disposed) rejectAdmission(messageId, "disposed");
          return;
        }
        if (isDefinitiveFailure(error)) {
          dispatch({ type: "prompt_removed", messageId });
          definitiveError = safeError(error, V2_DEFINITIVE_FAILURE_MESSAGE);
          rejectAdmission(messageId, "definitive-failure");
          return;
        }
        dispatch({ type: "prompt_reconciling", userMessageId: messageId, cancelRequested: state.execution.type === "cancelling" });
        markAdmissionAmbiguous(messageId);
      });
    // The request remains owned by this generation after an inbox event admits
    // the prompt. Its eventual response is observed and ignored safely; it is
    // never used as proof that the prompt was absent.
    void promptRequest;
    const result = await admissionPromise;
    if (result === "admitted" && record.submission !== null) return record.submission;
    if (result === "disposed") throw { kind: "disposed" } satisfies V2PromptSendError;
    throw {
      kind: "definitive-failure",
      error: definitiveError ?? { kind: "network", message: "OpenCode V2 prompt admission could not be proven" },
    } satisfies V2PromptSendError;
  }

  async function cancel(): Promise<void> {
    if (disposed || !generation || state.execution.type === "reverting") return;
    if (state.execution.type === "idle" || state.execution.type === "error") return;
    const current = state.execution;
    if (current.type === "submitting" || current.type === "reconciling") {
      dispatch({ type: "cancel_requested", phase: "prompt-request", userMessageId: current.userMessageId, inboxId: null, assistantMessageId: null });
      return;
    }
    if (current.type === "admitted") {
      dispatch({ type: "cancel_requested", phase: "queued", userMessageId: current.userMessageId, inboxId: current.inboxId, assistantMessageId: null });
      await generation.operations.inboxCancel({ sessionID: client.sessionId, inboxID: current.inboxId });
      dispatch({ type: "execution_settled" });
      return;
    }
    dispatch({ type: "cancel_requested", phase: "execution", userMessageId: current.type === "executing" || current.type === "streaming" || current.type === "cancelling" ? current.userMessageId : null, inboxId: current.type === "executing" || current.type === "streaming" || current.type === "cancelling" ? current.inboxId : null, assistantMessageId: current.type === "streaming" || current.type === "cancelling" ? current.assistantMessageId : null });
    const result = await generation.operations.interrupt({ sessionID: client.sessionId });
    if (!result.interrupted) await refresh();
  }

  async function compact(): Promise<void> {
    await awaitReady();
    if (state.revertRecovery.type !== "none") throw new V2ControllerError({ kind: "recovery-required", message: V2_RECOVERY_REQUIRED_MESSAGE });
    if (!generation) throw new V2ControllerError({ kind: "not-found", message: "OpenCode V2 generation is unavailable" });
    const id = createV2MessageId();
    const result = await generation.operations.compact({ sessionID: client.sessionId, id, delivery: "steer" });
    dispatch({ type: "compaction_admitted", inbox: { id: result.id, sessionId: result.sessionID, type: "compaction", delivery: result.delivery } });
  }

  async function replyToPermission(requestId: string, decision: "once" | "always" | "reject"): Promise<void> {
    if (answeredPermissions.has(requestId)) return;
    if (!generation) throw new V2ControllerError({ kind: "not-found", message: "OpenCode V2 generation is unavailable" });
    const request = state.permissions.find((candidate) => candidate.id === requestId);
    if (!request) throw new V2ControllerError({ kind: "not-found", message: "OpenCode V2 permission was not found" });
    try {
      await generation.operations.permissionReply({ sessionID: client.sessionId, requestID: requestId, decision });
      answeredPermissions.add(requestId);
      dispatch({ type: "permission_answered", requestId });
    } catch (error) {
      if (safeError(error, "").status === 404) dispatch({ type: "permission_retired", requestId });
      else throw error;
    }
  }

  async function reconcileAutoApprove(): Promise<number> {
    await awaitReady();
    let count = 0;
    for (const request of state.permissions) {
      const projected = projectV2Permission(request);
      if (projected === null || projected.toolCallId === null || answeredPermissions.has(request.id)) continue;
      await replyToPermission(request.id, "once");
      count += 1;
    }
    return count;
  }

  async function replyToForm(formId: string, answer: SessionFormReplyInput["answer"]): Promise<void> {
    if (!generation) throw new V2ControllerError({ kind: "not-found", message: "OpenCode V2 generation is unavailable" });
    if (formReplies.has(formId)) return;
    await generation.operations.formReply({ sessionID: client.sessionId, formID: formId, answer });
    formReplies.add(formId);
    dispatch({ type: "form_retired", formId });
  }

  async function rejectForm(formId: string): Promise<void> {
    if (!generation) throw new V2ControllerError({ kind: "not-found", message: "OpenCode V2 generation is unavailable" });
    if (formReplies.has(formId)) return;
    await generation.operations.formCancel({ sessionID: client.sessionId, formID: formId });
    formReplies.add(formId);
    dispatch({ type: "form_retired", formId });
  }

  async function regenerate(selectedAssistantParentId: string | null): Promise<void> {
    await awaitReady();
    if (state.revertRecovery.type !== "none") throw new V2ControllerError({ kind: "recovery-required", message: V2_RECOVERY_REQUIRED_MESSAGE });
    const candidateId = selectedAssistantParentId ?? state.messageOrder.at(-1) ?? null;
    if (!candidateId || !generation) throw new V2ControllerError({ kind: "not-found", message: "No assistant message is available to regenerate" });
    let user: V2MessageState | undefined = state.messages[candidateId];
    while (user && user.role !== "user") {
      user = user.parentId === null ? undefined : state.messages[user.parentId];
    }
    if (user === undefined || user.source?.type !== "user") throw new V2ControllerError({ kind: "not-found", message: "No preceding user message is available to regenerate" });
    dispatch({ type: "revert_recovery_staging", userMessageId: user.id });
    try {
      await generation.operations.revertStage({ sessionID: client.sessionId, messageID: user.id, files: true });
      await generation.operations.revertCommit({ sessionID: client.sessionId });
      await refresh();
      dispatch({ type: "revert_recovery_cleared" });
    } catch (error) {
      await reconcileStagedRevert().catch(() => undefined);
      throw error;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    connectionController?.abort();
    lifecycleController?.abort();
    const current = generation;
    generation = null;
    if (current) void current.events.close();
    for (const messageId of admissions.keys()) rejectAdmission(messageId, "disposed");
    listeners.clear();
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDesiredSelection: (selection) => {
      selectionGeneration += 1;
      dispatch({ type: "desired_selection_changed", selection, generation: selectionGeneration });
    },
    load: ensureLoaded,
    awaitReady,
    refresh,
    reconcileStagedRevert,
    reconcilePendingPrompt,
    awaitPromptAdmission,
    sendMessage,
    regenerate,
    cancel,
    compact,
    replyToPermission,
    reconcileAutoApprove,
    replyToForm,
    rejectForm,
    reconcileRuntimeMessageIds: (messageIds) => dispatch({ type: "runtime_messages_reconciled", messageIds }),
    dispose,
  };
}
