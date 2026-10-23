import type { AppendMessage } from "@assistant-ui/react";
import {
  isFormAlreadySettledError,
  isFormNotFoundError,
  isPermissionNotFoundError,
  isUnauthorizedError,
  type FormInfo,
  type PermissionRequest,
  type SessionFormReplyInput,
  type SessionInboxUser,
  type SessionPromptInput,
  type V2Event,
} from "@opencode/client";
import { logger } from "@/lib/logger";
import {
  OPENCODE_V2_INITIAL_RECONNECT_DELAY_MS,
  OPENCODE_V2_MAX_RECONNECT_ATTEMPTS,
  OPENCODE_V2_MAX_RECONNECT_DELAY_MS,
  OPENCODE_V2_PROMPT_ADMISSION_TIMEOUT_MS,
  OPENCODE_V2_READY_TIMEOUT_MS,
} from "@/features/opencode/config";
import {
  AUTO,
  AUTO_RESPONSE,
  MANUAL,
  shouldAutoApprove,
} from "@/features/permissions/permissionPolicy";
import { getAutoPolicy } from "./sessionAutoPolicy";
import { RetentionSet } from "./sync/retention";
import { createSessionMessageLoader } from "./sync/sessionMessageLoader";
import { coveredTextPartIds, shouldReplayBuffered } from "./sync/historyReplay";
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
import {
  clientErrorReason,
  errorStatus,
  isAlreadySettled,
  isDefinitiveFailure as clientIsDefinitiveFailure,
} from "./clientErrors";
import type { OpenCodeV2Client, OpenCodeV2Generation } from "./v2Client";
import type {
  V2ActivityState,
  V2DesiredSelection,
  V2ExecutionState,
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
  | {
      /**
       * The server may have taken the prompt, and the wire cannot say which.
       *
       * This is NOT a rejection: a retry would deliver the prompt twice, and
       * the server admits a repeated message id as the SAME prompt (upstream
       * `SessionInbox.admit` reconciles by id), so the honest answer is "it is
       * still in flight" rather than "it failed".
       */
      readonly kind: "ambiguous";
      readonly error: V2SafeError;
    }
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
  // The official client throws TAGGED errors for every status the route
  // declares, and it does not put the status on the error - the tag is the
  // only thing that says what happened. Reading `error.status` here read
  // `undefined` for every error the client throws, which is how a 404 and a
  // 409 both became "unknown".
  if (isFormNotFoundError(error) || isPermissionNotFoundError(error))
    return { kind: "not-found", message: fallback };
  if (isUnauthorizedError(error)) return { kind: "incompatible-server", message: fallback };
  if (isFormAlreadySettledError(error)) return { kind: "invalid-response", message: fallback };
  if (error !== null && typeof error === "object") {
    const candidate = error as { readonly status?: unknown; readonly message?: unknown };
    const status = errorStatus(error);
    if (status !== null) {
      return {
        kind: status >= 500 ? "server" : "unknown",
        message: typeof candidate.message === "string" ? candidate.message : fallback,
        status,
      };
    }
    const reason = clientErrorReason(error);
    if (reason !== null) {
      // A transport failure: the request may have reached the server, so this
      // is a NETWORK failure, not a refusal.
      return {
        kind: "network",
        message: typeof candidate.message === "string" ? candidate.message : fallback,
      };
    }
    if (typeof candidate.message === "string")
      return { kind: "network", message: candidate.message };
  }
  return { kind: "unknown", message: fallback };
}

function isDefinitiveFailure(error: unknown): boolean {
  return clientIsDefinitiveFailure(error);
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
  /**
   * How long a send waits for the server to admit the prompt.
   *
   * Injectable so a test can prove the DEADLINE without waiting the product's
   * timeout, and so the product's value is one number in one place.
   */
  readonly promptAdmissionTimeoutMs: number;
  /**
   * How long a caller waits for the runtime to become ready.
   *
   * Injectable for the same reason: a bounded wait that can only be observed
   * by waiting it out is a wait nobody will test.
   */
  readonly readyTimeoutMs: number;
};

const DEFAULT_V2_CONTROLLER_CONFIG: V2ThreadControllerConfig = {
  maxReconnectAttempts: OPENCODE_V2_MAX_RECONNECT_ATTEMPTS,
  initialReconnectDelayMs: OPENCODE_V2_INITIAL_RECONNECT_DELAY_MS,
  maxReconnectDelayMs: OPENCODE_V2_MAX_RECONNECT_DELAY_MS,
  promptAdmissionTimeoutMs: OPENCODE_V2_PROMPT_ADMISSION_TIMEOUT_MS,
  readyTimeoutMs: OPENCODE_V2_READY_TIMEOUT_MS,
};

export type V2ThreadControllerDeps = {
  /** The TBAi conversation this session belongs to (the activity pair's other half). */
  readonly conversationId: string;
  /**
   * Reads the backend-filtered activity for this session. Must resolve
   * `unknown` rather than throw: the check is non-blocking and must never
   * become a load failure.
   */
  readonly fetchActivity: (input: {
    readonly conversationId: string;
    readonly sessionId: string;
    readonly signal: AbortSignal;
  }) => Promise<V2ActivityState>;
};

/** Creates the single native OpenCode V2 session controller. */
export function createV2ThreadController(
  client: OpenCodeV2Client,
  config?: Partial<V2ThreadControllerConfig>,
  deps?: V2ThreadControllerDeps,
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
  /**
   * The retention policy, applied per collection.
   *
   * The collections split into two classes, and the split IS the policy (D16):
   *
   * - a **settled** entry records a decision that already happened. It is
   *   consulted for one question - "has this been answered?" - and the server
   *   can answer that too, so the entry is evictable.
   * - an **in-flight** entry records an operation that is still running. It is
   *   **protected**: evicting it would let a second operation start for the
   *   same id, which is exactly the defect M6 was.
   *
   * Each collection keeps its OWN instance, because each has its own lifecycle
   * and its own id namespace. The shared thing is the POLICY - the cap, the
   * TTL and the eviction rules - not the storage.
   */

  /**
   * The permission request ids that have been answered.
   *
   * Settled: it records a decision, so it is evictable. It exists so a
   * re-hydrated permission list does not re-show a request this client already
   * answered - and the server's own list is the authority if the entry is
   * gone.
   */
  const answeredPermissions = new RetentionSet<string>();
  /**
   * The permission request ids the Auto shield has already answered.
   *
   * A one-shot guard: "one attempt per request id".
   *
   * It is SETTLED in the "a decision already happened" sense - the reply has
   * been sent - but it is **PROTECTED** while the request is still pending,
   * and the protection is released when the request leaves the pending set.
   *
   * The protection is not optional, and it is not the same as
   * `answeredPermissions`'s case. `answeredPermissions` answers "has this been
   * answered?", a question the SERVER can also answer, so evicting it is
   * harmless. This one answers "has the Auto shield already tried this id?",
   * and nothing server-side can answer it - the shield is a client-side
   * policy. So an evicted entry would let a REDELIVERED `permission.asked`
   * send a SECOND auto-approval for the same id.
   *
   * That preserves the guard's meaning without the collection growing for the
   * life of the session.
   */
  const autoApproveAttempted = new RetentionSet<string>();
  /**
   * The form ids that have been answered or cancelled.
   *
   * Settled, like `answeredPermissions`: it exists so a re-hydrated form list
   * does not re-show a form this client already answered.
   */
  const formReplies = new RetentionSet<string>();
  /**
   * The permission request ids an answer is in flight for.
   *
   * A CLAIM, not a record of success: the id is held from the moment the
   * transport call starts until it succeeds or fails definitively. A second
   * answer to the same request while this one is in flight is suppressed (M6).
   * In flight, so PROTECTED.
   */
  const pendingPermissionReplies = new RetentionSet<string>();
  /**
   * The form ids an answer is in flight for. The same claim as
   * `pendingPermissionReplies`, and the same protection.
   */
  const pendingFormReplies = new RetentionSet<string>();
  /**
   * Whether a cancel is still owed for the current run.
   *
   * The `idle`, `error` and `reverting` states have no run to cancel, so they
   * carry no flag; every other state does.
   *
   * @param execution - The execution state to read.
   * @returns True when a cancel was requested and has not been honoured.
   */
  function cancelPending(execution: V2ExecutionState): boolean {
    return "cancelRequested" in execution ? execution.cancelRequested : false;
  }

  /**
   * Reports that the hydration buffer overflowed and events were lost.
   *
   * The loss is real, so it is reported three ways, and none of them is
   * "the transcript is fine":
   *
   * 1. a **warning**, so the log shows the transcript is incomplete;
   * 2. a **diagnostic count** in the domain state, so the state itself can
   *    say that some events were lost;
   * 3. the attempt's **readiness is failed**, so the runtime does not claim a
   *    successful reconciliation. A transcript that silently lost events is
   *    not reconciled, and the only honest repair is a fresh read - which the
   *    failed readiness schedules.
   *
   * The events themselves are gone; nothing here pretends otherwise.
   *
   * @param dropped - How many events were dropped.
   * @param retained - How many the buffer still holds.
   */
  function reportBufferOverflow(dropped: number, retained: number): void {
    // The ANNOUNCEMENT. The count reaches the domain state from the
    // reconciliation path, which owns the final number - the pipeline reports
    // the cumulative loss as it grows, and the reconciliation is where the
    // loss is final. Dispatching here as well would set the count twice, from
    // two places, and the state would depend on which ran last.
    logger.warn("opencode", "runtime.event_buffer_overflow", {
      dropped,
      retained,
    });
    const live = currentAttempt;
    if (!live || live.retired) return;
    // The attempt's readiness is NOT failed here. The reconciliation path
    // owns that decision: it is the point where the transcript is committed,
    // and it is the only place that can say "this transcript is short by N
    // events, so it is not a reconciliation". Failing the readiness here as
    // well would be a second mechanism for one fact, and two mechanisms can
    // disagree about whether the transcript is complete.
  }

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
    reportBufferOverflow,
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
    // The attempt boundary drops the previous attempt's held events. They
    // belong to ITS read: it never committed a snapshot, and this attempt
    // reads its own. Replaying them onto this attempt's snapshot would show
    // text the server may have discarded with the attempt that died - or, for
    // an attempt that failed after a read had started, double the text this
    // attempt's own snapshot carries.
    //
    // This is the ONE place the buffer is cleared for a dead attempt, so the
    // guard on it is a single site rather than two that no test can tell
    // apart.
    pipeline.clearBuffer();
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
   * Only APPLIED events count. A held event has not reached the transcript yet:
   * the commit takes the snapshot's copy and the replay re-applies the event to
   * it, but only where the snapshot does not already speak for that part - so
   * `touched` must mean "the client's own copy is the newer one", which a held
   * delta does not establish.
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
      // Read the pending cancel BEFORE the admission moves the state: the
      // `admitted` state carries the flag forward, but the check is about what
      // was true when the prompt was admitted.
      const cancelOwed = cancelPending(state.execution);
      dispatch({ type: "prompt_admitted", userMessageId: activeMessageId, inbox: record });
      prompts.settle(activeMessageId, "admitted", {
        messageId: activeMessageId,
        inboxId: record.id,
        delivery: record.delivery,
      });
      // A cancel requested BEFORE the admission is honoured now, against the
      // inbox id the server gave the prompt. Until this existed the flag was
      // carried into the `admitted` state and nothing read it, so the queued
      // prompt executed while the reader was told it was cancelled (M7).
      //
      // The cancel is issued against the admitted inbox id. "Exactly once" is
      // provided by the state machine (execution_settled -> idle); this set is
      // belt-and-braces.
      if (cancelOwed) void cancelAdmittedPrompt(record.id);
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
    if (disposed) return;
    // Duplicate suppression: already attempted (in-flight) OR already settled.
    if (autoApproveAttempted.has(event.data.id)) return;
    if (answeredPermissions.has(event.data.id)) return;
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
    // Claimed before the send, and PROTECTED while it matters.
    //
    // The protection is what makes "one attempt per request id" true. This
    // collection is SETTLED in the "a decision already happened" sense - the
    // reply has been sent - but it is NOT evictable, because the question it
    // answers ("has the Auto shield already tried this id?") is one the
    // SERVER cannot be asked: the shield is a client-side policy, and nothing
    // server-side says this client already tried this id.
    //
    // So an entry that is evicted would let a REDELIVERED `permission.asked`
    // pass the check and send a SECOND auto-approval for the same id. The
    // guard is released when the request leaves the pending set (the
    // `permission.replied` handler), which is when the server has answered it
    // and a redelivery can no longer be answered twice.
    autoApproveAttempted.add(event.data.id, Date.now());
    autoApproveAttempted.protect(event.data.id);
    void replyToPermission(event.data.id, AUTO_RESPONSE)
      .then(() => {
        // Definitive success: release in-flight protection. The entry stays as a
        // settled record (TTL-bounded) for duplicate suppression via
        // answeredPermissions.
        autoApproveAttempted.release(event.data.id);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // Definitive failure (already settled / not found): release protection.
        // Ambiguous (network): keep protected — the request may still be pending.
        if (isAlreadySettled(error) || isPermissionNotFoundError(error)) {
          autoApproveAttempted.release(event.data.id);
        }
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
    applySettlementEvent(event);
  }

  /**
   * Invalidates an in-flight answer when the server settles the request itself.
   *
   * A `permission.replied` or a `form.replied`/`form.cancelled` event means the
   * server has already answered. An answer this client is still awaiting is
   * then a SECOND answer to a settled request - and the server refuses it with
   * an error that looks like a failure of the reader's action. The claim is
   * dropped, so the in-flight call settles as "already answered" rather than
   * as a failure (M6).
   */
  function applySettlementEvent(event: V2Event): void {
    switch (event.type) {
      case "permission.replied":
        pendingPermissionReplies.release(event.data.requestID);
        pendingPermissionReplies.delete(event.data.requestID);
        answeredPermissions.add(event.data.requestID, Date.now());
        // The request is settled, so the Auto shield's one-shot guard has done
        // its job. Releasing its PROTECTION here is what lets the collection be
        // swept instead of growing for the life of the session - and the guard
        // cannot fire again, because the request is no longer pending and the
        // server has answered it.
        //
        // The ENTRY is kept, not deleted: it is what a redelivered
        // `permission.asked` is checked against, and deleting it would let a
        // redelivery answer a request the server has already settled.
        autoApproveAttempted.release(event.data.requestID);
        return;
      case "form.replied":
      case "form.cancelled":
        pendingFormReplies.release(event.data.id);
        pendingFormReplies.delete(event.data.id);
        formReplies.add(event.data.id, Date.now());
        return;
      default:
    }
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
   * Applies the retention policy to every long-lived collection.
   *
   * The sweep is cheap (a map walk over bounded collections) and runs at the
   * points where the runtime is already doing periodic work, so nothing needs
   * a timer of its own.
   *
   * When every entry in a collection is protected and the collection is over
   * its cap, the collection cannot honour the cap - and the protection is
   * absolute, so the entries are NOT evicted. The condition is logged, because
   * a protected collection that outgrows its cap is a real state the reader
   * should be able to diagnose.
   */
  function sweepRetention(): void {
    const now = Date.now();
    const collections: readonly (readonly [string, RetentionSet<string>])[] = [
      ["answeredPermissions", answeredPermissions],
      ["autoApproveAttempted", autoApproveAttempted],
      ["formReplies", formReplies],
      ["pendingPermissionReplies", pendingPermissionReplies],
      ["pendingFormReplies", pendingFormReplies],
    ];
    for (const [name, collection] of collections) {
      if (collection.sweep(now) === "protected")
        logger.warn("opencode", "runtime.retention_protected_overflow", {
          collection: name,
          size: collection.size,
          protectedCount: collection.protectedCount,
        });
    }
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
    // The re-sync is the runtime's periodic heartbeat, so it is where the
    // retention policy runs.
    sweepRetention();
    // Independent sweep trigger for the prompts registry (not tied to settle()).
    if (prompts.sweep(Date.now()) === "protected") {
      logger.warn("opencode", "runtime.retention_protected_overflow", {
        collection: "promptsInFlight",
        size: prompts.size,
        protectedCount: prompts.protectedCount,
      });
    }
    // Dropped-event safety net: release in-flight protection for auto-approve
    // entries whose permission is no longer pending (the server has answered it
    // but the permission.replied event was dropped). Without this, a dropped
    // event leaves the entry protected forever.
    const pendingIds = new Set((snapshot.permissions ?? []).map((request) => request.id));
    for (const id of autoApproveAttempted.ids()) {
      if (pendingPermissionReplies.has(id)) continue;
      if (pendingIds.has(id)) continue;
      autoApproveAttempted.release(id);
    }
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
    dispatch({ type: "load_started", reason: "connection" });
    const session = await currentGeneration.operations.sessionGet({ sessionID: client.sessionId });
    if (!isLive(live)) return;
    dispatch({ type: "session_hydrated", session });
    // The read's boundary is sampled HERE, before the history request goes out,
    // and it covers the session read too. An event that arrived while the
    // session was being read is held, and it is replayed only where the
    // snapshot does not already carry its part - so a delta that predates the
    // request is treated exactly like one that arrived during it, rather than
    // being dated later than it arrived.
    const held = beginHistoryReadScope();
    const historyBoundary = pipeline.beginHistoryRead();
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
    const snapshot = await history.read(currentGeneration, live.signals.connectionSignal);
    if (!isLive(live)) return;
    const committed = history.commit(snapshot, historyMerge(held));
    // The commit took the snapshot's copy of every message no live event
    // touched, so an event held during the read is replayed only where the
    // snapshot does not already carry its part. Replaying a delta into a part
    // the snapshot finished would double its text, and dropping a delta the
    // server never persisted would lose it: `historyReplay.ts` owns the rule.
    //
    // The snapshot is the only copy that can speak for a part here: while the
    // attempt hydrates, EVERY assistant event is held rather than applied, so
    // no message can have been touched by a live event, and the commit kept
    // the snapshot's copy of all of them.
    const covered = coveredTextPartIds(committed);
    for (const entry of pipeline.bufferedEntries()) {
      if (!shouldReplayBuffered(entry, historyBoundary, covered)) continue;
      dispatch({
        type: "v2_event",
        event: entry.event,
        mode: "observe-and-apply",
        // A buffered event was observed LIVE but applied late. Everything else
        // is legitimately applied late; only the durable retry record must not
        // become a live countdown, so that one branch reads this flag.
        replayed: true,
      });
    }
    // The loss the backstop carried, if any. The buffer is about to be
    // cleared, so this is the last moment the number is available.
    const dropped = pipeline.droppedEventCount();
    pipeline.clearBuffer();
    if (dropped > 0) {
      // The transcript is INCOMPLETE. Claiming `load_completed` here would say
      // the runtime reconciled, and it did not: events were lost and they are
      // not recovered.
      //
      // The attempt's readiness was ALREADY failed when the overflow was
      // reported - that is the report's own repair, and it is why this
      // hydration never reaches the commit. The count is still recorded here,
      // because the overflow may have been reported before the attempt
      // existed, and the state must carry the loss either way.
      dispatch({ type: "events_dropped", count: dropped });
      throw new V2ControllerError({
        kind: "network",
        message: `OpenCode V2 lost ${dropped} events during hydration; the transcript was re-read`,
      });
    }
    // The transcript is projected: stop buffering live deltas even though the
    // auxiliary read is still running. This is the attempt's own transition,
    // not a claim that the runtime is ready.
    live.projectionCommitted();
    const auxiliary = await loadAuxiliary(currentGeneration);
    if (!isLive(live)) return;
    applyAuxiliary(auxiliary);
    dispatch({ type: "load_completed" });
    // Deliberately not awaited: hydration is complete and must not wait for a
    // read that only refines a status chip and a notice.
    void checkActivity(live);
  }

  /**
   * Re-fetches the pending sets so a dropped event is repaired without a reload.
   *
   * The pending sets have no counter of their own, so a lost `form.created` or
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
   * Settles the session's process-local activity after hydration.
   *
   * Started AFTER `load_completed` and the hydration buffer drain, so a retry
   * event buffered during hydration has already been applied and cannot be
   * overwritten by an older activity response. The revision is captured
   * synchronously here, before the first await: any authoritative event that
   * arrives while the request is in flight bumps it, and the reducer then
   * discards this response as stale.
   *
   * Never awaited and never throws: a slow or failed read only leaves activity
   * `unknown`, and it cannot delay or fail the conversation load.
   *
   * @param live - The attempt whose hydration just completed.
   */
  async function checkActivity(live: Attempt): Promise<void> {
    if (!deps) return;
    const revision = state.activityRevision;
    try {
      const activity = await deps.fetchActivity({
        conversationId: deps.conversationId,
        sessionId: client.sessionId,
        signal: live.signals.connectionSignal,
      });
      if (!isLive(live)) return;
      dispatch({ type: "activity_resolved", activity, revision });
    } catch (error) {
      if (!isLive(live)) return;
      logger.warn("opencode", "runtime.activity_check_failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      dispatch({ type: "activity_resolved", activity: "unknown", revision });
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
      // The held events of a failed attempt are dropped by the ATTEMPT boundary
      // (`beginAttempt`), which every retry goes through. Clearing them here as
      // well would be a second site for one mechanism, and a second site that
      // no guard can distinguish from the first: removing either alone changes
      // nothing observable.
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
    // A manual retry is an explicit user action: give it a fresh budget so the
    // automatic ladder is available again if this attempt fails. The automatic
    // path still resets the budget only after successful hydration.
    pipeline.resetAttempt();
    return startConnection();
  }

  async function refresh(): Promise<void> {
    await awaitReady();
    requireGeneration();
    dispatch({ type: "load_started", reason: "refresh" });
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
   *
   * The wait is BOUNDED. A caller that waits forever holds the reader's text
   * with no way to release it and no way to say why, so a runtime that never
   * comes up ends the wait with a typed error instead of a hang.
   */
  async function awaitReady(): Promise<void> {
    const deadline = Date.now() + cfg.readyTimeoutMs;
    for (;;) {
      try {
        await ensureLoaded();
      } catch (error) {
        if (error instanceof AttemptSupersededError) continue;
        throw error;
      }
      const live = currentAttempt;
      if (live === null) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new V2ControllerError({
          kind: "network",
          message: `OpenCode V2 runtime was not ready within ${cfg.readyTimeoutMs}ms`,
        });
      try {
        await live.gate.waitWithDeadline(remaining);
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
    // The wait is BOUNDED. A prompt whose admission cannot be decided leaves
    // the server running it, and the client cannot say whether it arrived -
    // but the reader must not be left with a send that never returns. The
    // deadline turns that silence into a reported, recoverable outcome.
    const admissionPromise = prompts.awaitAdmissionWithDeadline(
      messageId,
      cfg.promptAdmissionTimeoutMs,
    );
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
        // The other admission path. A cancel requested before the admission is
        // honoured here too, and the inbox id makes it exactly once: the set
        // is shared with the inbox-event path.
        if (cancelPending(state.execution)) cancelAdmittedPrompt(normalized.id);
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
    if (result === "ambiguous") {
      // The request failed in a way that cannot prove the server refused it.
      // The prompt may still be running there, so this is NOT a rejection and
      // must not be reported as one: the reader's message stays in the thread
      // and the run continues server-side.
      throw {
        kind: "ambiguous",
        error: definitiveError ?? {
          kind: "network",
          message: "OpenCode V2 prompt admission could not be proven",
        },
      } satisfies V2PromptSendError;
    }
    throw {
      kind: "definitive-failure",
      error: definitiveError ?? {
        kind: "network",
        message: "OpenCode V2 prompt admission could not be proven",
      },
    } satisfies V2PromptSendError;
  }

  /**
   * Issues the cancel for a prompt that was admitted after the reader asked
   * for it.
   *
   * The in-flight request is NOT aborted - its outcome is genuinely unknown,
   * and aborting it would not stop the server from having taken the prompt.
   * What the cancel does is remove the QUEUED prompt, once the server tells
   * us its inbox id, and that is the only handle that identifies it.
   *
   * Belt-and-braces per inbox id: the admission arrives through two paths (the
   * HTTP response and the inbox event). "Exactly once" is provided by the state
   * machine (execution_settled -> idle).
   *

   * @param inboxId - The inbox id the server admitted the prompt as.
   */
  function cancelAdmittedPrompt(inboxId: string): void {
    const generation = currentAttempt?.generation ?? null;
    if (!generation) return;
    void generation.operations
      .inboxCancel({ sessionID: client.sessionId, inboxID: inboxId })
      .catch((error: unknown) => {
        logger.warn("opencode", "runtime.prompt_cancel_failed", {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      });
    dispatch({ type: "execution_settled" });
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
    // The id is CLAIMED before the transport call, not after it. Two clicks on
    // Approve, or a click that races the Auto shield, both reach this function
    // while the first is still awaiting the server: a check that only adds to
    // the set AFTER the await lets both through, and the server answers a
    // second reply to a settled request with an error (M6).
    if (!claimPermission(requestId)) return;
    const generation = requireGeneration();
    const request = state.permissions.find((candidate) => candidate.id === requestId);
    if (!request) {
      releasePermission(requestId);
      throw new V2ControllerError({
        kind: "not-found",
        message: "OpenCode V2 permission was not found",
      });
    }
    try {
      await generation.operations.permissionReply({
        sessionID: client.sessionId,
        requestID: requestId,
        decision,
      });
      // Settled: the claim becomes a record of success, so a later re-hydration
      // does not resurrect the request.
      pendingPermissionReplies.release(requestId);
      answeredPermissions.add(requestId, Date.now());
      dispatch({ type: "permission_answered", requestId });
    } catch (error) {
      // Only a DEFINITIVE failure releases the claim. A network error may mean
      // the server took the reply, and re-sending it would be a second answer
      // to the same request. The claim stays, and the request stays visible so
      // the reader can act on it.
      //
      // A request the server has GONE is the exception: it is not an answer
      // the reader can make, so the card is retired. The client throws this as
      // a TAGGED error, not as a status - see `clientErrors.ts`.
      if (isAlreadySettled(error) || isPermissionNotFoundError(error)) {
        dispatch({ type: "permission_retired", requestId });
        pendingPermissionReplies.release(requestId);
        answeredPermissions.add(requestId, Date.now());
      } else releasePermission(requestId);
      throw error;
    }
  }

  /**
   * Claims a permission request id for an answer.
   *
   * @param requestId - The permission request id.
   * @returns True when this call owns the answer, false when it was already
   * claimed or answered.
   */
  function claimPermission(requestId: string): boolean {
    if (answeredPermissions.has(requestId)) return false;
    if (pendingPermissionReplies.has(requestId)) return false;
    pendingPermissionReplies.add(requestId, Date.now());
    // In flight: protected, so a sweep can never let a second answer through
    // for the same request.
    pendingPermissionReplies.protect(requestId);
    return true;
  }

  /**
   * Releases a permission claim that failed definitively.
   *
   * The id is removed, not just unprotected: the claim exists to stop a second
   * answer while the first is in flight, and the first is over. Leaving the id
   * behind would keep suppressing the reader's retry.
   *
   * @param requestId - The permission request id.
   */
  function releasePermission(requestId: string): void {
    pendingPermissionReplies.release(requestId);
    pendingPermissionReplies.delete(requestId);
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
    // Claimed BEFORE the transport call, for the same reason a permission is:
    // two clicks on Submit both reach this function while the first is still
    // awaiting the server, and the server answers a second reply to a settled
    // form with an error (M6).
    if (!claimForm(formId)) return;
    const generation = requireGeneration();
    try {
      await generation.operations.formReply({
        sessionID: client.sessionId,
        formID: formId,
        answer,
      });
      pendingFormReplies.release(formId);
      formReplies.add(formId, Date.now());
      dispatch({ type: "form_retired", formId });
    } catch (error) {
      // Only a definitive failure releases the claim; a network error may mean
      // the server took the answer.
      //
      // A form the server has ALREADY SETTLED is not a failure at all: the
      // answer reached it, and the request is over. The client throws this as
      // a TAGGED error (`FormAlreadySettledError`), with no status - see
      // `clientErrors.ts`. Treating it as a failure would show the reader an
      // error for a form they already answered.
      if (isAlreadySettled(error)) {
        pendingFormReplies.release(formId);
        formReplies.add(formId, Date.now());
        dispatch({ type: "form_retired", formId });
        return;
      }
      releaseForm(formId);
      throw error;
    }
  }

  async function rejectForm(formId: string): Promise<void> {
    if (!claimForm(formId)) return;
    const generation = requireGeneration();
    try {
      await generation.operations.formCancel({ sessionID: client.sessionId, formID: formId });
      pendingFormReplies.release(formId);
      formReplies.add(formId, Date.now());
      dispatch({ type: "form_retired", formId });
    } catch (error) {
      // A form the server has already settled is not a failure: the request is
      // over. The client throws it as a tagged error, with no status.
      if (isAlreadySettled(error)) {
        pendingFormReplies.release(formId);
        formReplies.add(formId, Date.now());
        dispatch({ type: "form_retired", formId });
        return;
      }
      releaseForm(formId);
      throw error;
    }
  }

  /**
   * Claims a form id for an answer.
   *
   * @param formId - The form id.
   * @returns True when this call owns the answer, false when it was already
   * claimed or answered.
   */
  function claimForm(formId: string): boolean {
    if (formReplies.has(formId)) return false;
    if (pendingFormReplies.has(formId)) return false;
    pendingFormReplies.add(formId, Date.now());
    // In flight: protected, for the same reason as a permission.
    pendingFormReplies.protect(formId);
    return true;
  }

  /**
   * Releases a form claim that failed definitively.
   *
   * The id is removed, not just unprotected - the claim exists to stop a
   * second answer while the first is in flight, and the first is over.
   *
   * @param formId - The form id.
   */
  function releaseForm(formId: string): void {
    pendingFormReplies.release(formId);
    pendingFormReplies.delete(formId);
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
