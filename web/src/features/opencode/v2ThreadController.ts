import type { AppendMessage } from "@assistant-ui/react";
import type {
  FormInfo,
  PermissionRequest,
  SessionFormReplyInput,
  SessionInboxUser,
  SessionPromptInput,
  V2Event,
} from "@opencode/client";
import { logger } from "@/lib/logger";
import {
  OPENCODE_V2_INITIAL_RECONNECT_DELAY_MS,
  OPENCODE_V2_MAX_RECONNECT_ATTEMPTS,
  OPENCODE_V2_MAX_RECONNECT_DELAY_MS,
  OPENCODE_V2_RETRYABLE_HTTP_STATUSES,
} from "@/features/opencode/config";
import {
  AUTO,
  AUTO_RESPONSE,
  MANUAL,
  shouldAutoApprove,
} from "@/features/permissions/permissionPolicy";
import { getAutoPolicy } from "./sessionAutoPolicy";
import { createSessionMessageLoader } from "./sync/sessionMessageLoader";
import { createInitialV2ThreadState, mapEventError, reduceV2ThreadState } from "./v2Events";
import { toV2PromptInput } from "./v2MessageProjection";
import { projectV2Permission } from "./v2Permissions";
import {
  attachV2PromptMessageId,
  createV2MessageId,
  isLocalV2MessageId,
  optimisticMessage,
  V2_PROMPT_MESSAGE_ID_KEY,
} from "./sync/optimistic";
import {
  createPromptsInFlight,
  type V2PromptAdmissionResult,
  type V2PromptSubmission,
} from "./sync/promptsInFlight";
import { AttemptSupersededError, createAttempt, type Attempt } from "./sync/attempt";
import {
  createEventPipeline,
  isAssistantMessageEvent,
  type EventPipelineHost,
} from "./sync/eventPipeline";
import type { OpenCodeV2Client, OpenCodeV2Generation } from "./v2Client";
import type {
  V2DesiredSelection,
  V2HistoryMerge,
  V2InboxRecord,
  V2MessageState,
  V2ModelSelection,
  V2SafeError,
  V2ThreadAction,
  V2ThreadState,
} from "./v2Types";

const V2_ABORTED_MESSAGE = "OpenCode V2 request was aborted";
const V2_DEFINITIVE_FAILURE_MESSAGE = "OpenCode V2 prompt was definitively rejected";
const V2_RECOVERY_REQUIRED_MESSAGE = "OpenCode V2 staged recovery must complete before admission";
const V2_DISPOSED_MESSAGE = "OpenCode V2 runtime was disposed";
const V2_EXHAUSTED_MESSAGE = "OpenCode V2 runtime stopped reconnecting";

export type V2PromptOptions = {
  readonly messageId?: string;
  readonly model?: V2ModelSelection;
  readonly agent?: string;
  readonly delivery?: "steer" | "queue";
};

export type V2PromptSendError =
  | { readonly kind: "definitive-failure"; readonly error: V2SafeError }
  | { readonly kind: "disposed" };

/**
 * The prompt admission registry lives in `sync/promptsInFlight.ts`. Its
 * vocabulary is re-exported here because the controller's public surface is
 * where the app has always found it.
 */
export type { V2PromptAdmissionResult, V2PromptSubmission };

export interface V2ThreadController {
  getState(): V2ThreadState;
  subscribe(listener: () => void): () => void;
  setDesiredSelection(selection: V2DesiredSelection): void;
  load(): Promise<void>;
  /**
   * Explicit manual recovery: starts a fresh attempt even after the automatic
   * retry budget is spent.
   *
   * The automatic budget limits retries the runtime schedules by itself, not a
   * person asking again. The failed attempt is replaced, never revived.
   * `load()` and `awaitReady()` are incidental and refuse to connect once the
   * budget is exhausted, so neither can spend an attempt on a caller's behalf.
   */
  retry(): Promise<void>;
  awaitReady(): Promise<void>;
  refresh(): Promise<void>;
  resyncAuxiliary(): Promise<void>;
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

/**
 * The local prompt identity and the optimistic record live in
 * `sync/optimistic.ts`. They are re-exported here because the controller's
 * public surface is where the app has always found them, and moving a symbol
 * must not move its import path.
 */
export { attachV2PromptMessageId, createV2MessageId, V2_PROMPT_MESSAGE_ID_KEY };

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
    if (typeof candidate.message === "string")
      return { kind: "network", message: candidate.message };
  }
  return { kind: "unknown", message: fallback };
}

function isDefinitiveFailure(error: unknown): boolean {
  const status =
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : undefined;
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    !OPENCODE_V2_RETRYABLE_HTTP_STATUSES.includes(status)
  );
}

function modelChanged(current: V2ModelSelection | null, desired: V2ModelSelection | null): boolean {
  return (
    current?.providerID !== desired?.providerID ||
    current?.modelID !== desired?.modelID ||
    current?.variant !== desired?.variant
  );
}

function agentChanged(current: string | null, desired: string | null): boolean {
  return current !== desired;
}

/**
 * The assistant message an event mutates, or null when it mutates none.
 *
 * Every event that changes the transcript carries the message it belongs to;
 * the event stream has no user-message mutation at all, because a user turn is
 * immutable once admitted.
 *
 * @param event - The event.
 * @returns The assistant message id, or null.
 */
function assistantMessageIdOf(event: V2Event): string | null {
  const data: unknown = event.data;
  if (data === null || typeof data !== "object" || !("assistantMessageID" in data)) return null;
  const messageId = data.assistantMessageID;
  return typeof messageId === "string" ? messageId : null;
}

function inboxRecordFromUser(item: SessionInboxUser): V2InboxRecord {
  return {
    id: item.id,
    sessionId: item.sessionID,
    type: "user",
    delivery: item.delivery,
  };
}

function modelInput(model: V2ModelSelection): {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
} {
  return {
    id: model.modelID,
    providerID: model.providerID,
    ...(model.variant ? { variant: model.variant } : {}),
  };
}

export type V2ThreadControllerConfig = {
  readonly maxReconnectAttempts: number;
  readonly initialReconnectDelayMs: number;
  readonly maxReconnectDelayMs: number;
};

const DEFAULT_V2_CONTROLLER_CONFIG: V2ThreadControllerConfig = {
  maxReconnectAttempts: OPENCODE_V2_MAX_RECONNECT_ATTEMPTS,
  initialReconnectDelayMs: OPENCODE_V2_INITIAL_RECONNECT_DELAY_MS,
  maxReconnectDelayMs: OPENCODE_V2_MAX_RECONNECT_DELAY_MS,
};

/** Creates the single native OpenCode V2 session controller. */
export function createV2ThreadController(
  client: OpenCodeV2Client,
  config?: Partial<V2ThreadControllerConfig>,
): V2ThreadController {
  const cfg: V2ThreadControllerConfig = { ...DEFAULT_V2_CONTROLLER_CONFIG, ...config };
  let state = createInitialV2ThreadState(client.sessionId, client.directory);
  /**
   * The attempt that may currently commit, and the only one whose readiness
   * anyone waits on.
   *
   * `null` means there is no live attempt: it was superseded, retired for a
   * reconnect, or disposed. Every continuation captures the attempt it started
   * for and calls `isLive` before it commits anything — state, readiness, a
   * load slot or the retry budget.
   */
  let currentAttempt: Attempt | null = null;
  /** Monotonic, so two attempts are never confused even after a retire. */
  let nextAttemptId = 0;
  /** Outlives every attempt; aborted only by `dispose`. */
  const lifecycle = new AbortController();
  let disposed = false;
  let selectionGeneration = 0;
  let resyncInFlight = false;
  /**
   * Message ids a live event has changed since the current history read began.
   *
   * A history read pages over time, so the transcript moves while it runs. The
   * ids here tell the commit which of the snapshot's own messages a live event
   * has already superseded.
   */
  const liveTouchedMessageIds = new Set<string>();
  const listeners = new Set<() => void>();
  const prompts = createPromptsInFlight();
  const answeredPermissions = new Set<string>();
  const autoApproveAttempted = new Set<string>();
  const formReplies = new Set<string>();

  /**
   * What the event pipeline needs from this controller.
   *
   * The pipeline owns the stream's lifecycle and nothing else, so the domain
   * actions it reports, the reducer it feeds and the connection it asks for
   * all arrive through here.
   */
  const pipelineHost: EventPipelineHost = {
    get isDisposed(): boolean {
      return disposed;
    },
    config: cfg,
    dispatch,
    applyEvent,
    startConnection,
    isLive,
    ownsRuntime,
    retireAttempt,
    failReady: (failed, error) => failed.fail(new V2ControllerError(error)),
    toSafeError: safeError,
  };
  const pipeline = createEventPipeline(pipelineHost);
  const history = createSessionMessageLoader({ dispatch });

  /**
   * Whether an attempt is the runtime's current attempt.
   *
   * Ownership only, and deliberately weaker than `isLive`: a just-failed
   * attempt may no longer commit, but the runtime is still its responsibility
   * until a replacement is started, so the retry scheduler must still be able
   * to act on it. A superseded attempt fails this check (M2).
   *
   * @param candidate - The attempt in question.
   * @returns True when it is still the current attempt.
   */
  function ownsRuntime(candidate: Attempt): boolean {
    return !disposed && currentAttempt === candidate;
  }

  /**
   * Whether an attempt may still commit anything.
   *
   * This is the single identity check every asynchronous continuation makes.
   * It is deliberately about the ATTEMPT, not the generation: an attempt that
   * was superseded must stop committing even while its own generation object
   * is still around, and a newer attempt that has not connected yet has no
   * generation at all. A terminally failed attempt is `retired` too, so it
   * stops committing the moment it fails.
   *
   * @param candidate - The attempt a continuation started for.
   * @returns True when it may still commit.
   */
  function isLive(candidate: Attempt): boolean {
    return ownsRuntime(candidate) && !candidate.retired;
  }

  /**
   * Mints the next attempt and supersedes the previous one.
   *
   * Supersession happens here, synchronously, before anything else in the new
   * attempt runs: from the moment this returns, the old attempt's loops,
   * hydration and failure handlers all observe `retired` and stop.
   *
   * @returns The new attempt.
   */
  function beginAttempt(): Attempt {
    retireAttempt(currentAttempt);
    nextAttemptId += 1;
    const started = createAttempt(nextAttemptId, lifecycle.signal);
    currentAttempt = started;
    return started;
  }

  /**
   * Tears one attempt down without touching any other.
   *
   * Closes that attempt's stream, aborts its signals, drops its readiness and
   * clears its own load slot. A newer attempt's promise and stream are not
   * reachable from here (M2).
   *
   * @param candidate - The attempt to retire, or `null`.
   */
  function retireAttempt(candidate: Attempt | null): void {
    if (!candidate) return;
    if (currentAttempt === candidate) currentAttempt = null;
    const generation = candidate.generation;
    candidate.retire();
    candidate.setLoad(null);
    // The attempt is already being abandoned, so a cancellation failure has no
    // recoverable outcome; it must not surface as an unhandled rejection.
    if (generation) void generation.events.close().catch(() => undefined);
  }

  function notify(): void {
    if (disposed) return;
    for (const listener of listeners) listener();
  }

  /**
   * The generation the runtime is talking to right now.
   *
   * Every use reads the LIVE generation, exactly as the closure variable it
   * replaced did: a reconnect that lands between two awaits is seen by the
   * second read, not frozen out by the first.
   */
  function requireGeneration(): OpenCodeV2Generation {
    const generation = currentAttempt?.generation ?? null;
    if (!generation)
      throw new V2ControllerError({
        kind: "not-found",
        message: "OpenCode V2 generation is unavailable",
      });
    return generation;
  }

  function dispatch(action: V2ThreadAction): void {
    if (disposed) return;
    const next = reduceV2ThreadState(state, action);
    if (next === state) return;
    state = next;
    notify();
  }

  /**
   * Opens a history-read scope and records the transcript as it stands.
   *
   * The returned ids are the merge's `held` set: a held message the snapshot no
   * longer contains was deleted server-side. An optimistic prompt is excluded —
   * the server has not admitted it yet, so its absence from the snapshot says
   * nothing.
   *
   * @returns The message ids the client holds at the start of the read.
   */
  function beginHistoryReadScope(): readonly string[] {
    liveTouchedMessageIds.clear();
    return state.messageOrder.filter(
      (messageId) => !state.optimisticMessageIds.includes(messageId),
    );
  }

  /**
   * Closes a history-read scope into the merge the commit reconciles against.
   *
   * @param held - The ids `beginHistoryReadScope` returned.
   * @returns The merge.
   */
  function historyMerge(held: readonly string[]): V2HistoryMerge {
    return { held, touched: [...liveTouchedMessageIds] };
  }

  /**
   * Notes that a live event changed this message while a history read was open.
   *
   * Only APPLIED events count. A buffered delta has not reached the transcript
   * yet: the commit takes the snapshot's copy and the replay appends the delta
   * to it, which is the same text by a different route.
   *
   * @param event - The event being applied.
   */
  function noteLiveMutation(event: V2Event): void {
    const assistantMessageId = assistantMessageIdOf(event);
    if (assistantMessageId !== null) liveTouchedMessageIds.add(assistantMessageId);
  }

  /**
   * Bridge OpenCode's compaction lifecycle into the compaction state machine.
   *
   * FOUND DURING CONFORMANCE. The reducer has handled `compaction_running`,
   * `compaction_settled` and `compaction_failed` since the V2 client landed, and
   * OpenCode publishes all three events - but nothing dispatched them. The only
   * producer was `compaction_admitted`, fired when `/compact` was submitted, so
   * the state went `admitted -> admitted` and never left it: a running
   * compaction was invisible, and a completed one was invisible too.
   *
   * That is why the context meter could not implement OpenChamber's post-
   * compaction rule. The meter needs to know a compaction FINISHED, and the
   * signal existed on the wire but was dropped at the boundary.
   *
   * `ended` with no error is the success signal, matching OpenChamber's
   * `status === 'completed' && !error`. The `delta` events that stream the
   * summary text are deliberately not consumed: the meter does not render a
   * progress figure, and reading them would mean projecting a summarization
   * TBAi does not own.
   */
  function applyCompactionLifecycleEvent(event: V2Event): void {
    switch (event.type) {
      case "session.compaction.started":
        dispatch({ type: "compaction_running" });
        return;
      case "session.compaction.ended":
        dispatch({ type: "compaction_settled" });
        return;
      case "session.compaction.failed":
        dispatch({ type: "compaction_failed", error: mapEventError(event.data.error) });
        return;
      default:
    }
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
    const activeMessageId =
      state.execution.type === "submitting" || state.execution.type === "reconciling"
        ? state.execution.userMessageId
        : state.execution.type === "admitted" && state.execution.inboxId === event.data.inboxID
          ? state.execution.userMessageId
          : state.execution.type === "cancelling"
            ? state.execution.userMessageId
            : undefined;
    dispatch({ type: "inbox_recorded", record });
    if (typeof activeMessageId === "string") {
      dispatch({ type: "prompt_admitted", userMessageId: activeMessageId, inbox: record });
      prompts.settle(activeMessageId, "admitted", {
        messageId: activeMessageId,
        inboxId: record.id,
        delivery: record.delivery,
      });
    }
  }

  /**
   * Arms the Auto shield for a permission request the moment it arrives.
   *
   * `reconcileAutoApprove` answers requests that were *already* pending when the
   * shield was switched on; this answers the ones that arrive while it is
   * already on. It lives here, beside `dispatch`/`applyEvent`, because answering
   * is an async transport call and `v2Events.ts` is a pure reducer.
   *
   * Deliberately NOT awaited: the event loop must never block on a permission
   * round-trip. Unlike the drain, this also covers requests with no linked tool
   * card — those render only in the fallback panel, so a user may have no other
   * way to answer them.
   *
   * **FAILS CLOSED.** The policy is read live on every event, never captured, so
   * switching the shield off stops arming at once and an unknown or unreadable
   * policy does not arm at all. The request's own action is passed to the policy
   * so an action that needs no approval (`question`) is answered even with the
   * shield off; an unknown or malformed action falls back to the shield.
   * Nothing here throws: an automatic acceptance must never break the event
   * stream or escape as an unhandled rejection.
   */
  function applyAutoApproveEvent(event: V2Event): void {
    if (event.type !== "permission.asked") return;
    if (disposed || autoApproveAttempted.has(event.data.id)) return;
    let eligible = false;
    try {
      // The one place the boolean policy cache meets the policy module's own
      // vocabulary; the decision itself belongs to `shouldAutoApprove`, which
      // reads the action as well as the shield.
      eligible = shouldAutoApprove(
        getAutoPolicy(client.sessionId) ? AUTO : MANUAL,
        event.data.action,
      );
    } catch (error) {
      logger.warn("opencode", "runtime.auto_approve_policy_unreadable", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return;
    }
    if (!eligible) return;
    // Claimed before the send and never released: one attempt per request id
    // stops a redelivered event from sending a second reply, and a failed send
    // leaves the request pending for the user or the drain rather than looping.
    autoApproveAttempted.add(event.data.id);
    void replyToPermission(event.data.id, AUTO_RESPONSE).catch((error: unknown) => {
      if (disposed) return;
      logger.warn("opencode", "runtime.auto_approve_reply_failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    });
  }

  function applyEvent(event: V2Event, eventOrdinal: number): void {
    dispatch({ type: "v2_event", event, mode: "observe-only" });
    if (isAssistantMessageEvent(event)) {
      // Buffering is a property of the LIVE attempt's hydration. A failed or
      // superseded attempt no longer reports `hydrating`, so a dead hydration
      // cannot strand the transcript by buffering every later delta (M4).
      if (currentAttempt?.hydrating ?? false) {
        pipeline.buffer(event, eventOrdinal);
        return;
      }
      noteLiveMutation(event);
      dispatch({ type: "v2_event", event, mode: "observe-and-apply" });
      return;
    }
    dispatch({ type: "v2_event", event, mode: "observe-and-apply" });
    applyAdmissionEvent(event);
    applyAutoApproveEvent(event);
    applyCompactionLifecycleEvent(event);
  }

  /**
   * The three append-only pending sets, with the ids the client held when each
   * read started.
   */
  type V2AuxiliarySnapshot = {
    readonly held: {
      readonly inbox: readonly string[];
      readonly permissions: readonly string[];
      readonly forms: readonly string[];
    };
    /** The server's answer per kind. `null` means that read FAILED. */
    readonly inbox: readonly V2InboxRecord[] | null;
    readonly permissions: readonly PermissionRequest[] | null;
    readonly forms: readonly FormInfo[] | null;
  };

  /**
   * Fetches the pending sets that only the load-time snapshot and the live
   * events otherwise know about: inbox records, permission requests, forms.
   *
   * The ids each list held are captured BEFORE the fetches. An entry created
   * while a read is in flight is therefore absent from `held`, and a snapshot
   * that has not caught up with it cannot delete it.
   *
   * Each list degrades INDEPENDENTLY to `null` rather than failing the batch: a
   * permissions endpoint that is briefly unavailable must not also cost the
   * reader their forms, and must not be reported as "no pending permissions".
   * A failed read leaves the entries already held in place; only availability
   * moves.
   */
  async function loadAuxiliary(
    currentGeneration: OpenCodeV2Generation,
  ): Promise<V2AuxiliarySnapshot> {
    const held: V2AuxiliarySnapshot["held"] = {
      inbox: Object.keys(state.inboxById),
      permissions: state.permissions.map((request) => request.id),
      forms: state.forms.map((form) => form.id),
    };
    const [inbox, permissions, forms] = await Promise.all([
      currentGeneration.operations
        .inboxList({ sessionID: client.sessionId })
        .catch((cause: unknown) => {
          logger.warn("opencode", "runtime.auxiliary_hydration_failed", {
            kind: "inbox",
            errorType: cause instanceof Error ? cause.name : typeof cause,
          });
          return null;
        }),
      currentGeneration.operations
        .permissionList({ sessionID: client.sessionId })
        .catch((cause: unknown) => {
          logger.warn("opencode", "runtime.auxiliary_hydration_failed", {
            kind: "permission",
            errorType: cause instanceof Error ? cause.name : typeof cause,
          });
          return null;
        }),
      currentGeneration.operations
        .formList({ sessionID: client.sessionId })
        .catch((cause: unknown) => {
          logger.warn("opencode", "runtime.auxiliary_hydration_failed", {
            kind: "form",
            errorType: cause instanceof Error ? cause.name : typeof cause,
          });
          return null;
        }),
    ]);
    return {
      held,
      inbox:
        inbox === null
          ? null
          : inbox.map((item) =>
              item.type === "user"
                ? inboxRecordFromUser(item)
                : {
                    id: item.id,
                    sessionId: item.sessionID,
                    type: item.type,
                    delivery: item.delivery,
                  },
            ),
      permissions,
      forms,
    };
  }

  /**
   * Publishes an auxiliary snapshot, minus anything already resolved locally.
   *
   * The two filters close a race the event stream does not cover: a reply
   * dispatched moments before this snapshot was taken would otherwise re-add a
   * form or permission the reader has already answered. A locally-resolved
   * record is authoritative — we know it is settled, regardless of what the
   * list still returns.
   */
  function applyAuxiliary(snapshot: V2AuxiliarySnapshot): void {
    dispatch({
      type: "inbox_hydrated",
      records: snapshot.inbox,
      held: snapshot.held.inbox,
    });
    dispatch({
      type: "permissions_hydrated",
      requests:
        snapshot.permissions === null
          ? null
          : snapshot.permissions.filter((request) => !answeredPermissions.has(request.id)),
      held: snapshot.held.permissions,
    });
    dispatch({
      type: "forms_hydrated",
      forms:
        snapshot.forms === null ? null : snapshot.forms.filter((form) => !formReplies.has(form.id)),
      held: snapshot.held.forms,
    });
  }

  /**
   * Projects the attempt's first history into the transcript.
   *
   * Returns early — never resolving readiness — as soon as the attempt it was
   * started for stops owning the runtime. The caller decides whether the
   * attempt completed; an early return is not a completion.
   *
   * @param live - The attempt this hydration belongs to.
   */
  async function hydrate(live: Attempt): Promise<void> {
    const currentGeneration = live.generation;
    if (currentGeneration === null)
      throw new V2ControllerError({
        kind: "not-found",
        message: "OpenCode V2 generation is unavailable",
      });
    const serverInfo = await currentGeneration.operations.serverInfo();
    if (!isLive(live)) return;
    dispatch({
      type: "connection_changed",
      connection: { type: "connected", serverVersion: serverInfo.version },
    });
    dispatch({ type: "load_started" });
    const session = await currentGeneration.operations.sessionGet({ sessionID: client.sessionId });
    if (!isLive(live)) return;
    dispatch({ type: "session_hydrated", session });
    if (session.revert !== undefined) {
      dispatch({ type: "revert_recovery_clearing", userMessageId: session.revert.messageID });
      await currentGeneration.operations.revertClear({ sessionID: client.sessionId });
      const verified = await currentGeneration.operations.sessionGet({
        sessionID: client.sessionId,
      });
      if (verified.revert !== undefined)
        throw new V2ControllerError({
          kind: "recovery-required",
          message: "OpenCode V2 staged revert could not be cleared",
        });
      dispatch({ type: "revert_recovery_cleared" });
    }
    const held = beginHistoryReadScope();
    const historyRequestOrdinal = pipeline.beginHistoryRead();
    const snapshot = await history.read(currentGeneration, live.signals.connectionSignal);
    if (!isLive(live)) return;
    history.commit(snapshot, historyMerge(held));
    const buffered = pipeline.bufferedSince(historyRequestOrdinal);
    for (const entry of buffered)
      dispatch({
        type: "v2_event",
        event: entry.event,
        mode: "observe-and-apply",
      });
    pipeline.clearBuffer();
    // The transcript is projected: stop buffering live deltas even though the
    // auxiliary read is still running. This is the attempt's own transition,
    // not a claim that the runtime is ready.
    live.projectionCommitted();
    const auxiliary = await loadAuxiliary(currentGeneration);
    if (!isLive(live)) return;
    applyAuxiliary(auxiliary);
    dispatch({ type: "load_completed" });
  }

  /**
   * Re-fetches the pending sets so a dropped event is repaired without a reload.
   *
   * `ordinal` is a LOCAL counter, so a lost `form.created` or
   * `permission.asked` leaves no trace at all: nothing can detect the gap, and
   * the reader waits for a restart. This is the backstop for precisely that
   * failure, and the reason it is a poll rather than a fix to the stream.
   *
   * Bounded to one in-flight request — a caller arriving while a re-sync is
   * running is a no-op, not a second round of three GETs. Never rejects: this
   * runs from a timer and from a visibility handler, where there is no caller
   * to hand an error to.
   */
  async function resyncAuxiliary(): Promise<void> {
    if (disposed) return;
    const live = currentAttempt;
    const currentGeneration = live?.generation ?? null;
    if (!live || currentGeneration === null || resyncInFlight) return;
    resyncInFlight = true;
    try {
      const snapshot = await loadAuxiliary(currentGeneration);
      if (!isLive(live)) return;
      // The pending sets are their own state. Nothing links a permission to a
      // tool PART, so a re-sync does not touch the transcript: reprojecting it
      // here used to rebuild every message on every poll.
      applyAuxiliary(snapshot);
    } catch (error) {
      logger.warn("opencode", "runtime.auxiliary_resync_failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      resyncInFlight = false;
    }
  }

  /**
   * Establishes one connection attempt and hydrates it.
   *
   * The attempt is minted synchronously and the returned promise is recorded as
   * THAT attempt's load, so every caller — the retry timer, `ensureLoaded`, a
   * manual `load()` — either joins the attempt in flight or starts one only
   * after it has failed. Recording the load here rather than at each call site
   * is what keeps a retry-started attempt from being duplicated by a concurrent
   * `load()`.
   */
  function startConnection(): Promise<void> {
    if (disposed)
      return Promise.reject(
        new V2ControllerError({ kind: "aborted", message: V2_DISPOSED_MESSAGE }),
      );
    const live = beginAttempt();
    const started = runAttempt(live).catch((error: unknown) => {
      // This attempt's own slot, so a newer attempt's promise cannot be
      // dropped from here (M2).
      live.setLoad(null);
      throw error;
    });
    live.setLoad(started);
    return started;
  }

  /**
   * Connects and hydrates one attempt.
   *
   * Every branch checks the attempt's liveness before it dispatches, settles
   * readiness, or lets a failure reach the retry scheduler, so a superseded
   * attempt cannot mutate, settle or tear down the attempt that replaced it
   * (M2, L4).
   *
   * A hydration that fails is routed to the same retry path as a connection
   * that fails, so a failed history read reaches a defined state — reconnect
   * within the budget, or terminal failure — instead of freezing (M4).
   *
   * @param live - The attempt this call owns.
   */
  async function runAttempt(live: Attempt): Promise<void> {
    let currentGeneration: OpenCodeV2Generation;
    try {
      currentGeneration = await client.connect(live.signals);
    } catch (error) {
      const safe = safeError(error, "OpenCode V2 connection failed");
      if (isLive(live)) {
        live.fail(new V2ControllerError(safe));
        dispatch({ type: "load_failed", error: safe });
        pipeline.scheduleReconnect(live, safe);
      }
      throw new V2ControllerError(safe);
    }
    if (!isLive(live)) {
      // Superseded between the connect and here. Close only this attempt's
      // stream, and report supersession rather than a runtime failure.
      await currentGeneration.events.close();
      throw new AttemptSupersededError(live.id);
    }
    live.adopt(currentGeneration);
    live.beginHydration();
    void pipeline.consume(live);
    try {
      await hydrate(live);
      if (!isLive(live)) throw new AttemptSupersededError(live.id);
      // The attempt completed its hydration while it still owned the runtime:
      // only this outcome may settle readiness and reset the retry budget
      // (M1, L4).
      live.markReady();
      pipeline.resetAttempt();
    } catch (error) {
      if (disposed) return;
      if (live.retired) throw new AttemptSupersededError(live.id);
      const safe = safeError(error, "OpenCode V2 runtime failed to load");
      live.fail(new V2ControllerError(safe));
      dispatch({ type: "load_failed", error: safe });
      pipeline.scheduleReconnect(live, safe);
      throw new V2ControllerError(safe);
    } finally {
      // Structural, so no exit path can leave the transcript buffering
      // behind a hydration that is not happening (M4).
      live.endHydration();
    }
  }

  async function ensureLoaded(): Promise<void> {
    const existing = currentAttempt?.load() ?? null;
    if (existing) return existing;
    // The automatic budget is spent. Waiting for readiness is not a user
    // asking to reconnect, so it reports the failure that ended the retries
    // instead of quietly spending an attempt the budget does not have (D2).
    if (pipeline.isExhausted()) throw new V2ControllerError(terminalFailure());
    // D2: manual load during a pending timer cancels the timer and takes over.
    pipeline.cancelReconnect();
    return startConnection();
  }

  /**
   * The failure the runtime stopped reconnecting on.
   *
   * A terminal failure always leaves `load: error`, so the state carries the
   * cause. The fallback exists only so a latched runtime can never be mistaken
   * for a healthy one.
   */
  function terminalFailure(): V2SafeError {
    return state.load.type === "error"
      ? state.load.error
      : { kind: "network", message: V2_EXHAUSTED_MESSAGE };
  }

  /**
   * Explicit manual recovery.
   *
   * Starts a fresh attempt even after the automatic budget is spent, because
   * the budget limits retries the runtime schedules by itself, not a person
   * asking again. The exhausted attempt stays retired and is replaced. The
   * retry counter is deliberately NOT reset: an attempt this call starts that
   * fails again is terminal, rather than earning a fresh round of automatic
   * retries.
   */
  async function retry(): Promise<void> {
    pipeline.cancelReconnect();
    return startConnection();
  }

  async function refresh(): Promise<void> {
    await awaitReady();
    requireGeneration();
    dispatch({ type: "load_started" });
    try {
      const session = await requireGeneration().operations.sessionGet({
        sessionID: client.sessionId,
      });
      dispatch({ type: "session_hydrated", session });
      const held = beginHistoryReadScope();
      const snapshot = await history.read(requireGeneration());
      history.commit(snapshot, historyMerge(held));
      dispatch({ type: "load_completed" });
    } catch (error) {
      const safe = safeError(error, "OpenCode V2 refresh failed");
      dispatch({ type: "load_failed", error: safe });
      throw new V2ControllerError(safe);
    }
  }

  /**
   * Waits until the runtime is ready, following a takeover if one happens.
   *
   * A wait is about the RUNTIME, not about one attempt: if the attempt it was
   * waiting on is superseded, it waits for the attempt that replaced it rather
   * than reporting the replacement as a failure. Only a real failure — a
   * terminal one, or a disposed runtime — is thrown.
   */
  async function awaitReady(): Promise<void> {
    for (;;) {
      try {
        await ensureLoaded();
      } catch (error) {
        if (error instanceof AttemptSupersededError) continue;
        throw error;
      }
      const live = currentAttempt;
      if (live === null) continue;
      const pending = live.gate.pending();
      if (pending === null) return;
      try {
        await pending;
      } catch (error) {
        if (error instanceof AttemptSupersededError) continue;
        throw error;
      }
      return;
    }
  }

  async function reconcileStagedRevert(): Promise<void> {
    await awaitReady();
    requireGeneration();
    try {
      const session = await requireGeneration().operations.sessionGet({
        sessionID: client.sessionId,
      });
      dispatch({ type: "session_hydrated", session });
      if (session.revert !== undefined) {
        dispatch({ type: "revert_recovery_clearing", userMessageId: session.revert.messageID });
        await requireGeneration().operations.revertClear({ sessionID: client.sessionId });
      }
      const verified = await requireGeneration().operations.sessionGet({
        sessionID: client.sessionId,
      });
      const held = beginHistoryReadScope();
      const snapshot = await history.read(requireGeneration());
      history.commit(snapshot, historyMerge(held));
      if (verified.revert !== undefined) throw new Error("staged revert remains");
      dispatch({ type: "revert_recovery_cleared" });
    } catch (error) {
      const safe = safeError(error, "OpenCode V2 staged recovery failed");
      dispatch({
        type: "revert_recovery_failed",
        userMessageId: state.execution.type === "reverting" ? state.execution.userMessageId : null,
        error: safe,
      });
      throw new V2ControllerError(safe);
    }
  }

  async function reconcilePendingPrompt(
    messageId: string,
  ): Promise<"admitted" | "absent" | "unresolved"> {
    await awaitReady();
    const inbox = Object.values(state.inboxById).find(
      (record) => record.id === messageId || record.id === state.inboxById[messageId]?.id,
    );
    if (inbox !== undefined) return "admitted";
    if (state.messages[messageId] !== undefined && !state.optimisticMessageIds.includes(messageId))
      return "admitted";
    const record = prompts.get(messageId);
    if (record?.result === "ambiguous") {
      prompts.settle(messageId, "definitive-failure");
      return "absent";
    }
    return "unresolved";
  }

  function awaitPromptAdmission(messageId: string): Promise<V2PromptAdmissionResult> {
    return prompts.awaitAdmission(messageId);
  }

  async function applySelection(): Promise<void> {
    if (!currentAttempt?.generation)
      throw new V2ControllerError({
        kind: "not-found",
        message: "OpenCode V2 generation is unavailable",
      });
    if (state.execution.type !== "idle" && state.execution.type !== "error") return;
    if (modelChanged(state.model, state.desiredModel) && state.desiredModel !== null) {
      await requireGeneration().operations.switchModel({
        sessionID: client.sessionId,
        model: modelInput(state.desiredModel),
      });
    }
    if (agentChanged(state.agent, state.desiredAgent) && state.desiredAgent !== null) {
      await requireGeneration().operations.switchAgent({
        sessionID: client.sessionId,
        agent: state.desiredAgent,
      });
    }
  }

  async function sendMessage(
    message: AppendMessage,
    options: V2PromptOptions = {},
  ): Promise<V2PromptSubmission> {
    await awaitReady();
    if (state.revertRecovery.type !== "none")
      throw new V2ControllerError({
        kind: "recovery-required",
        message: V2_RECOVERY_REQUIRED_MESSAGE,
      });
    const generation = requireGeneration();
    const activeGeneration = generation;
    const customId = message.metadata?.custom?.[V2_PROMPT_MESSAGE_ID_KEY];
    const messageId =
      options.messageId ?? (typeof customId === "string" ? customId : createV2MessageId());
    if (!isLocalV2MessageId(messageId))
      throw new TypeError("OpenCode V2 prompt message id must start with msg_");
    await applySelection();
    const payload = toV2PromptInput(message);
    const localMessage = optimisticMessage(message, messageId);
    const record = prompts.create(messageId);
    dispatch({ type: "prompt_submitting", message: localMessage });
    const admissionPromise = new Promise<V2PromptAdmissionResult>((resolve) => {
      record.onSettle(resolve);
    });
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
        prompts.settle(messageId, "admitted", {
          messageId,
          inboxId: normalized.id,
          delivery: normalized.delivery,
        });
      })
      .catch((error: unknown) => {
        if (disposed || record.result === "admitted") {
          if (disposed) prompts.settle(messageId, "disposed");
          return;
        }
        if (isDefinitiveFailure(error)) {
          dispatch({ type: "prompt_removed", messageId });
          definitiveError = safeError(error, V2_DEFINITIVE_FAILURE_MESSAGE);
          prompts.settle(messageId, "definitive-failure");
          return;
        }
        dispatch({
          type: "prompt_reconciling",
          userMessageId: messageId,
          cancelRequested: state.execution.type === "cancelling",
        });
        prompts.markAmbiguous(messageId);
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
      error: definitiveError ?? {
        kind: "network",
        message: "OpenCode V2 prompt admission could not be proven",
      },
    } satisfies V2PromptSendError;
  }

  async function cancel(): Promise<void> {
    const generation = currentAttempt?.generation ?? null;
    if (disposed || !generation || state.execution.type === "reverting") return;
    if (state.execution.type === "idle" || state.execution.type === "error") return;
    const current = state.execution;
    if (current.type === "submitting" || current.type === "reconciling") {
      dispatch({
        type: "cancel_requested",
        phase: "prompt-request",
        userMessageId: current.userMessageId,
        inboxId: null,
        assistantMessageId: null,
      });
      return;
    }
    if (current.type === "admitted") {
      dispatch({
        type: "cancel_requested",
        phase: "queued",
        userMessageId: current.userMessageId,
        inboxId: current.inboxId,
        assistantMessageId: null,
      });
      await generation.operations.inboxCancel({
        sessionID: client.sessionId,
        inboxID: current.inboxId,
      });
      dispatch({ type: "execution_settled" });
      return;
    }
    dispatch({
      type: "cancel_requested",
      phase: "execution",
      userMessageId:
        current.type === "executing" ||
        current.type === "streaming" ||
        current.type === "cancelling"
          ? current.userMessageId
          : null,
      inboxId:
        current.type === "executing" ||
        current.type === "streaming" ||
        current.type === "cancelling"
          ? current.inboxId
          : null,
      assistantMessageId:
        current.type === "streaming" || current.type === "cancelling"
          ? current.assistantMessageId
          : null,
    });
    const result = await generation.operations.interrupt({ sessionID: client.sessionId });
    if (!result.interrupted) await refresh();
  }

  async function compact(): Promise<void> {
    await awaitReady();
    if (state.revertRecovery.type !== "none")
      throw new V2ControllerError({
        kind: "recovery-required",
        message: V2_RECOVERY_REQUIRED_MESSAGE,
      });
    const generation = requireGeneration();
    const id = createV2MessageId();
    const result = await generation.operations.compact({
      sessionID: client.sessionId,
      id,
      delivery: "steer",
    });
    dispatch({
      type: "compaction_admitted",
      inbox: {
        id: result.id,
        sessionId: result.sessionID,
        type: "compaction",
        delivery: result.delivery,
      },
    });
  }

  async function replyToPermission(
    requestId: string,
    decision: "once" | "always" | "reject",
  ): Promise<void> {
    if (answeredPermissions.has(requestId)) return;
    const generation = requireGeneration();
    const request = state.permissions.find((candidate) => candidate.id === requestId);
    if (!request)
      throw new V2ControllerError({
        kind: "not-found",
        message: "OpenCode V2 permission was not found",
      });
    try {
      await generation.operations.permissionReply({
        sessionID: client.sessionId,
        requestID: requestId,
        decision,
      });
      answeredPermissions.add(requestId);
      dispatch({ type: "permission_answered", requestId });
    } catch (error) {
      if (safeError(error, "").status === 404) dispatch({ type: "permission_retired", requestId });
      else throw error;
    }
  }

  /**
   * Answers the requests that were already pending when the shield came on.
   *
   * The drain is the other automatic path, so it asks the SAME single predicate
   * the arm path asks, with the shield read live: answering is not implied by
   * being called. A request whose action needs no approval is therefore drained
   * even if the shield is off, and nothing else is drained when it is.
   */
  async function reconcileAutoApprove(): Promise<number> {
    await awaitReady();
    let count = 0;
    for (const request of state.permissions) {
      const projected = projectV2Permission(request);
      if (
        projected === null ||
        projected.toolCallId === null ||
        answeredPermissions.has(request.id)
      )
        continue;
      if (!shouldAutoApprove(getAutoPolicy(client.sessionId) ? AUTO : MANUAL, projected.action))
        continue;
      await replyToPermission(request.id, AUTO_RESPONSE);
      count += 1;
    }
    return count;
  }

  async function replyToForm(
    formId: string,
    answer: SessionFormReplyInput["answer"],
  ): Promise<void> {
    const generation = requireGeneration();
    if (formReplies.has(formId)) return;
    await generation.operations.formReply({ sessionID: client.sessionId, formID: formId, answer });
    formReplies.add(formId);
    dispatch({ type: "form_retired", formId });
  }

  async function rejectForm(formId: string): Promise<void> {
    const generation = requireGeneration();
    if (formReplies.has(formId)) return;
    await generation.operations.formCancel({ sessionID: client.sessionId, formID: formId });
    formReplies.add(formId);
    dispatch({ type: "form_retired", formId });
  }

  async function regenerate(selectedAssistantParentId: string | null): Promise<void> {
    await awaitReady();
    if (state.revertRecovery.type !== "none")
      throw new V2ControllerError({
        kind: "recovery-required",
        message: V2_RECOVERY_REQUIRED_MESSAGE,
      });
    const generation = currentAttempt?.generation ?? null;
    const candidateId = selectedAssistantParentId ?? state.messageOrder.at(-1) ?? null;
    if (!candidateId || !generation)
      throw new V2ControllerError({
        kind: "not-found",
        message: "No assistant message is available to regenerate",
      });
    let user: V2MessageState | undefined = state.messages[candidateId];
    while (user && user.role !== "user") {
      user = user.parentId === null ? undefined : state.messages[user.parentId];
    }
    if (user === undefined || user.source?.type !== "user")
      throw new V2ControllerError({
        kind: "not-found",
        message: "No preceding user message is available to regenerate",
      });
    dispatch({ type: "revert_recovery_staging", userMessageId: user.id });
    try {
      await requireGeneration().operations.revertStage({
        sessionID: client.sessionId,
        messageID: user.id,
        files: true,
      });
      await requireGeneration().operations.revertCommit({ sessionID: client.sessionId });
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
    pipeline.cancelReconnect();
    // Retiring the current attempt rejects its readiness with the superseded
    // sentinel; `awaitReady` then finds a disposed runtime and reports it.
    retireAttempt(currentAttempt);
    currentAttempt = null;
    lifecycle.abort();
    prompts.disposeAll();
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
    retry,
    awaitReady,
    refresh,
    resyncAuxiliary,
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
    reconcileRuntimeMessageIds: (messageIds) =>
      dispatch({ type: "runtime_messages_reconciled", messageIds }),
    dispose,
  };
}
