/**
 * The event pipeline: consuming OpenCode's event stream, and scheduling the
 * retry when it fails.
 *
 * ## WHAT THIS OWNS
 *
 * The **lifecycle of the event stream**: the loop that reads events, the
 * ordinal that dates them, the buffer that holds the ones that arrive while
 * the history is loading, the retry timer, and the counter that charges the
 * retry budget.
 *
 * ## WHAT THIS DOES NOT OWN
 *
 * - **What an event means.** Reducing an event into domain state is the
 *   controller's job; this pipeline delivers events and never dispatches a
 *   domain action of its own accord (it does dispatch the connection
 *   transitions the retry implies - that is its lifecycle to report).
 * - **The connection.** Establishing it is the controller's; this pipeline
 *   asks for a new one when the stream dies.
 * - **The readiness gate.** It reports a failure through the host; it never
 *   settles the gate itself.
 * - **Domain state.** The transcript and the execution state belong to the
 *   controller.
 *
 * ## THE ORDINAL
 *
 * Every event carries an ordinal: a local counter over the events this client
 * has applied, which says nothing about the server's clock. It answers exactly
 * one question — which of the buffered events arrived after the history read
 * that is in flight. Ordering a *snapshot* against live events is done on
 * identity, never on an ordinal: the snapshot and the events are reconciled by
 * the ids the client held and the ids the events touched, because a snapshot
 * has no ordinal of its own and two reads can be in flight at once.
 *
 * ## THE BUFFER
 *
 * Events that arrive while the history is loading are held, because a
 * projection that replaces the transcript would otherwise erase them. The
 * controller drains the buffer, in ordinal order, after it commits the
 * snapshot.
 *
 * Adjacent deltas for one streaming target are coalesced on arrival, so a fast
 * stream costs one entry per part rather than one per token. Only deltas that
 * arrived after the read started may be folded together: everything before the
 * boundary is already in the snapshot, and merging across it would replay that
 * text twice. `OPENCODE_V2_EVENT_BUFFER_LIMIT` is the backstop for that many
 * *distinct* events arriving during a single read, not the mechanism.
 *
 * ## THE RETRY BUDGET
 *
 * `reconnectAttempt` counts the retries this controller has spent. The budget
 * is charged when a retry is scheduled and reset **only** by the controller,
 * after an attempt reports a completed hydration and passes its identity
 * check. The counter is not attempt-scoped, and that is deliberate: the
 * ceiling is a property of the runtime, not of one attempt. What changed in
 * Phase 3 is *who may reset it* — a superseded attempt can no longer report
 * completion for the live one, so M1 (a stale attempt resetting the counter)
 * is closed by construction rather than by a guard.
 *
 * At the ceiling the failure is terminal, and terminal means settled: the
 * attempt is failed (retired first, so nothing it left in flight can commit)
 * and then dropped as the runtime's current attempt. A "failed" attempt that
 * still counted as live would keep accepting events from a stream whose
 * recovery has already been given up on.
 *
 * ## THE DELAY POLICY
 *
 * The exponential backoff is bounded twice: by the configured ceiling, and — while
 * the document is visible and online, the case a reader is actually waiting
 * through — by the shorter foreground cap. When the environment cannot report
 * visibility or connectivity, the controller is assumed to be visible and
 * online, which is the *shorter* ceiling and therefore the safe assumption.
 *
 * A permanent 4xx deliberately does NOT skip ahead to the ceiling. The
 * installed `@opencode/client` throws `declared(body)` for every status an
 * operation declares, and `message.list` declares 400, 401, 404 and 500: the
 * transport status is discarded, so a deleted session and a transient failure
 * are indistinguishable by the time the controller sees the error. A
 * status-based shortcut would therefore be unreachable for the one case it
 * exists for. The limitation is recorded in `docs/decisions.md`; it belongs to
 * the client's contract, not to this module.
 *
 * This module was extracted from `v2ThreadController.ts` as part of Phase 2 of
 * the OpenCode runtime remediation plan; Phase 3 made its retry scheduling
 * attempt-scoped (it is told which attempt failed, and refuses to act on one
 * that has been superseded); Phase 4 gave the buffer its read boundary and its
 * coalescing (M5).
 */

import {
  OPENCODE_V2_EVENT_BUFFER_LIMIT,
  OPENCODE_V2_FOREGROUND_RECONNECT_CAP_MS,
  OPENCODE_V2_INITIAL_RECONNECT_DELAY_MS,
  OPENCODE_V2_MAX_RECONNECT_DELAY_MS,
} from "@/features/opencode/config";
import type { V2Event } from "@opencode/client";
import type { V2SafeError, V2ThreadAction } from "../v2Types";
import type { Attempt } from "./attempt";

/** The backoff parameters the retry scheduler uses. */
export interface ReconnectDelays {
  readonly initialReconnectDelayMs: number;
  readonly maxReconnectDelayMs: number;
}

/** The default backoff parameters. */
export const DEFAULT_RECONNECT_DELAYS: ReconnectDelays = {
  initialReconnectDelayMs: OPENCODE_V2_INITIAL_RECONNECT_DELAY_MS,
  maxReconnectDelayMs: OPENCODE_V2_MAX_RECONNECT_DELAY_MS,
};

/**
 * The conditions the delay policy reads.
 *
 * Passed in rather than read inside `computeReconnectDelay` so the policy stays
 * a pure function: the caller observes the environment once, at the moment the
 * retry is scheduled.
 */
export interface ReconnectConditions {
  /** Whether the document is visible (a hidden tab is not waiting). */
  readonly visible: boolean;
  /** Whether the browser reports a network connection. */
  readonly online: boolean;
}

/** The conditions assumed when the environment cannot report them. */
export const DEFAULT_RECONNECT_CONDITIONS: ReconnectConditions = {
  visible: true,
  online: true,
};

/**
 * The delay before the next retry.
 *
 * @param attempt - The number of retries already spent.
 * @param delays - The backoff parameters.
 * @param conditions - The environment the retry is scheduled in.
 * @returns The delay in milliseconds.
 */
export function computeReconnectDelay(
  attempt: number,
  delays: ReconnectDelays = DEFAULT_RECONNECT_DELAYS,
  conditions: ReconnectConditions = DEFAULT_RECONNECT_CONDITIONS,
): number {
  const ceiling =
    conditions.visible && conditions.online
      ? Math.min(delays.maxReconnectDelayMs, OPENCODE_V2_FOREGROUND_RECONNECT_CAP_MS)
      : delays.maxReconnectDelayMs;
  return Math.min(ceiling, delays.initialReconnectDelayMs * 2 ** attempt);
}

/**
 * Reads the environment the retry is scheduled in.
 *
 * Absent signals are treated as the *shorter* ceiling: an environment that
 * cannot say it is hidden or offline must not be given the longer delay.
 *
 * @returns The conditions.
 */
export function readReconnectConditions(): ReconnectConditions {
  const visible = typeof document === "undefined" ? true : document.visibilityState !== "hidden";
  const online =
    typeof navigator === "undefined" || typeof navigator.onLine !== "boolean"
      ? true
      : navigator.onLine;
  return { visible, online };
}

/**
 * Whether an event is one the transcript renders as content.
 *
 * @param event - The event.
 * @returns True for the events that carry assistant output.
 */
export function isAssistantMessageEvent(event: V2Event): boolean {
  return (
    event.type.startsWith("session.text.") ||
    event.type.startsWith("session.reasoning.") ||
    event.type.startsWith("session.tool.") ||
    event.type.startsWith("session.step.") ||
    event.type === "session.retry.scheduled"
  );
}

/** One buffered event, with the ordinal that dates it. */
export interface BufferedEvent {
  readonly ordinal: number;
  readonly event: V2Event;
}

/**
 * Coalesces `next` into the delta it directly follows, when both append to the
 * same streaming target.
 *
 * Concatenating two adjacent delta texts is indistinguishable from applying
 * them in turn, which is what makes this a representation change and not a
 * change of meaning. Two events with different targets, or a non-delta between
 * them, are left alone: the buffer must stay in ordinal order.
 *
 * The merged event keeps `next`'s id, so the folded events' ids never reach the
 * applied-id set. That is a known, accepted limit: deltas carry no durable
 * sequence in this protocol (only `*.started`/`*.ended` do), the server does not
 * re-send them on replay, and nothing else suppresses a re-delivery. Should a
 * delta ever be redelivered, it would be applied twice — folded or not.
 *
 * @param previous - The buffered event immediately before `next`.
 * @param next - The arriving event.
 * @returns The merged event, or null when the two are not one target's deltas.
 */
function coalescedDelta(previous: V2Event, next: V2Event): V2Event | null {
  switch (previous.type) {
    case "session.text.delta": {
      if (next.type !== "session.text.delta") return null;
      if (
        next.data.assistantMessageID !== previous.data.assistantMessageID ||
        next.data.ordinal !== previous.data.ordinal
      )
        return null;
      return { ...next, data: { ...next.data, delta: previous.data.delta + next.data.delta } };
    }
    case "session.reasoning.delta": {
      if (next.type !== "session.reasoning.delta") return null;
      if (
        next.data.assistantMessageID !== previous.data.assistantMessageID ||
        next.data.ordinal !== previous.data.ordinal
      )
        return null;
      return { ...next, data: { ...next.data, delta: previous.data.delta + next.data.delta } };
    }
    case "session.tool.input.delta": {
      if (next.type !== "session.tool.input.delta") return null;
      if (
        next.data.assistantMessageID !== previous.data.assistantMessageID ||
        next.data.id !== previous.data.id
      )
        return null;
      return { ...next, data: { ...next.data, delta: previous.data.delta + next.data.delta } };
    }
    default:
      return null;
  }
}

/**
 * What the pipeline needs from the controller.
 *
 * The pipeline owns the stream's lifecycle and nothing else, so everything it
 * cannot own arrives through this interface: the dispatch it reports
 * transitions to, the reducer it feeds, the connection it asks for, and the
 * error vocabulary it reports in.
 */
export interface EventPipelineHost {
  /** Whether the runtime has been disposed. */
  readonly isDisposed: boolean;
  /** The retry budget and the backoff parameters. */
  readonly config: {
    readonly maxReconnectAttempts: number;
    readonly initialReconnectDelayMs: number;
    readonly maxReconnectDelayMs: number;
  };
  /**
   * Whether an attempt is still the one that may commit.
   *
   * The pipeline asks before it reacts to a failure: a stream that died on a
   * superseded attempt says nothing about the live one.
   *
   * @param attempt - The attempt a failure came from.
   * @returns True when it is still live.
   */
  isLive(attempt: Attempt): boolean;
  /**
   * Whether an attempt still owns the runtime, even after it has failed.
   *
   * Deliberately weaker than `isLive`. A failed attempt stops being live the
   * moment it fails, but the runtime is still its responsibility until a
   * replacement exists, so the retry scheduler must be able to act on it. An
   * attempt that was superseded has no say at all (M2).
   *
   * @param attempt - The attempt a failure came from.
   * @returns True when it is still the current attempt.
   */
  ownsRuntime(attempt: Attempt): boolean;
  /**
   * Tears an attempt down: abort its signals, drop it as the current attempt,
   * close its stream and clear its load promise.
   *
   * Only that attempt is touched, which is what stops a superseded attempt
   * from tearing down a newer one.
   *
   * @param attempt - The attempt to retire.
   */
  retireAttempt(attempt: Attempt): void;
  /** Dispatches a domain action. */
  dispatch(action: V2ThreadAction): void;
  /**
   * Reports that the hydration buffer overflowed and events were lost.
   *
   * The pipeline owns the buffer, so it owns the fact that the buffer could
   * not hold everything. The controller owns what that MEANS: it logs it, counts
   * it, and fails the attempt's readiness - because a transcript that lost
   * events has not been reconciled, and saying otherwise would be a lie.
   *
   * @param dropped - How many events were dropped.
   * @param retained - How many the buffer still holds.
   */
  reportBufferOverflow(dropped: number, retained: number): void;
  /** Applies one event to the domain state. */
  applyEvent(event: V2Event, ordinal: number): void;
  /** Establishes a new connection. */
  startConnection(): Promise<void>;
  /**
   * Rejects an attempt's readiness with a real failure.
   *
   * @param attempt - The attempt that failed.
   * @param error - The failure, in the runtime's safe vocabulary.
   */
  failReady(attempt: Attempt, error: V2SafeError): void;
  /** Normalises an unknown error into the runtime's safe vocabulary. */
  toSafeError(error: unknown, fallback: string): V2SafeError;
}

/** The pipeline's surface. */
export interface EventPipeline {
  /**
   * Consumes the event stream of an attempt until it ends or fails.
   *
   * @param attempt - The attempt whose stream to consume.
   */
  consume(attempt: Attempt): Promise<void>;
  /**
   * Schedules a retry, if the budget allows one and the attempt still owns the
   * runtime.
   *
   * @param attempt - The attempt whose stream failed.
   * @param error - Why the stream failed.
   */
  scheduleReconnect(attempt: Attempt, error: V2SafeError): void;
  /**
   * The next ordinal, allocated as the stream is consumed.
   *
   * @returns The ordinal of the event that is about to be applied.
   */
  nextOrdinal(): number;
  /**
   * Samples the ordinal a history read starts at.
   *
   * Every event dated after it arrived while the snapshot was being read, which
   * is what decides whether a non-delta event has to be replayed on top of the
   * commit. It is ALSO the fold guard: a held delta that predates the read keeps
   * its own ordinal rather than being merged into a later entry, so it cannot
   * masquerade as one that arrived during the read.
   *
   * @returns The ordinal the read starts at.
   */
  beginHistoryRead(): number;
  /**
   * Holds an event that arrived while the history was loading.
   *
   * @param event - The event.
   * @param ordinal - The event's ordinal.
   */
  buffer(event: V2Event, ordinal: number): void;
  /**
   * The buffered events, oldest first.
   *
   * The pipeline does not decide what may be replayed: the caller compares the
   * buffer against the snapshot it committed (see `sync/historyReplay.ts`).
   *
   * @returns The held events.
   */
  bufferedEntries(): readonly BufferedEvent[];
  /**
   * How many events the backstop has dropped since the buffer was cleared.
   *
   * The controller reads this when the buffer is DRAINED, because that is when
   * the loss is final: the transcript it is about to commit is short by
   * exactly this many events, and the reconciliation must say so rather than
   * claim a complete transcript.
   *
   * @returns The number of events lost, or 0.
   */
  droppedEventCount(): number;
  /** Empties the buffer, and the loss it carries with it. */
  clearBuffer(): void;
  /**
   * The number of retries the current attempt has spent.
   *
   * @returns The retry count.
   */
  readonly attemptCount: number;
  /**
   * Resets the retry budget.
   *
   * Called by the controller — never by a superseded attempt — after an
   * attempt reports a completed hydration.
   */
  resetAttempt(): void;
  /**
   * Whether the automatic retry budget is spent.
   *
   * Set when a failure arrives with no retries left and cleared when an
   * attempt completes its hydration. While it is set, the runtime must not
   * open a connection on its own initiative: a caller that merely waits for
   * readiness is not a user deciding to retry.
   *
   * @returns True when the last failure was terminal.
   */
  isExhausted(): boolean;
  /**
   * Cancels a pending retry.
   *
   * @returns True when a retry was pending and has been cancelled.
   */
  cancelReconnect(): boolean;
}

/**
 * Creates the event pipeline.
 *
 * @param host - What the pipeline needs from the controller.
 * @returns The pipeline.
 */
export function createEventPipeline(host: EventPipelineHost): EventPipeline {
  let ordinal = 0;
  let eventBuffer: BufferedEvent[] = [];
  /**
   * The ordinal of the newest history read. A delta dated at or before it keeps
   * its own entry instead of being folded into a later one, so a held event can
   * never be dated later than it arrived. (Whether it is replayed is decided by
   * the snapshot's own text, not by this boundary - see `historyReplay.ts`.)
   */
  let coalesceFromOrdinal = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  /** True once a failure has arrived with no automatic retries left. */
  let exhausted = false;
  /**
   * How many events the backstop has dropped since the buffer was last
   * cleared.
   *
   * The running total, so the report names the WHOLE loss rather than "one
   * more" once per event. It resets with the buffer, because the buffer and
   * the loss it carries are one thing.
   */
  let droppedEvents = 0;
  /**
   * Whether the controller has already been told about an overflow.
   *
   * One overflow episode is one report: the loss is announced once, and the
   * attempt's readiness is failed once. The running total keeps counting, so
   * the count that reaches the domain state is the whole loss.
   */
  let overflowReported = false;

  async function consume(attempt: Attempt): Promise<void> {
    const generation = attempt.generation;
    if (generation === null) return;
    try {
      while (!host.isDisposed && host.isLive(attempt)) {
        const result = await generation.events.next();
        if (result.done) throw new Error("OpenCode V2 event stream closed");
        if (host.isDisposed || !host.isLive(attempt)) return;
        host.applyEvent(result.value, nextOrdinal());
      }
    } catch (error) {
      if (host.isDisposed || !host.isLive(attempt)) return;
      scheduleReconnect(attempt, host.toSafeError(error, "OpenCode V2 event stream failed"));
    }
  }

  function scheduleReconnect(failed: Attempt, error: V2SafeError): void {
    if (host.isDisposed) return;
    // A failure reported by an attempt that has already been superseded says
    // nothing about the live one: react only to the attempt that still owns
    // the runtime (M2). Ownership, not liveness, because a failed attempt is
    // no longer live by definition but has not been replaced yet.
    if (!host.ownsRuntime(failed)) return;
    if (reconnectTimer !== null) return;
    // Terminal failure: no more auto-retries after exhausting the budget.
    if (reconnectAttempt >= host.config.maxReconnectAttempts) {
      exhausted = true;
      host.dispatch({
        type: "connection_changed",
        connection: { type: "failed", attempt: reconnectAttempt },
      });
      host.dispatch({ type: "load_failed", error });
      // Settle it BEFORE anything else can observe it. `failReady` marks the
      // attempt retired, so a later event from its stream and any continuation
      // already in flight are refused; `retireAttempt` then drops it as the
      // current attempt and closes the stream. Without the settle here a
      // terminal failure left a "failed" attempt that `isLive` still accepted.
      host.failReady(failed, error);
      host.retireAttempt(failed);
      return;
    }
    host.retireAttempt(failed);
    host.dispatch({
      type: "connection_changed",
      connection: { type: "reconnecting", attempt: reconnectAttempt + 1 },
    });
    host.dispatch({ type: "load_failed", error });
    host.failReady(failed, error);
    const delay = computeReconnectDelay(reconnectAttempt, host.config, readReconnectConditions());
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // `startConnection` records the new attempt's load promise itself, so a
      // concurrent `load()` joins this attempt instead of starting a second
      // connection.
      void host.startConnection().catch(() => undefined);
    }, delay);
  }

  function nextOrdinal(): number {
    ordinal += 1;
    return ordinal;
  }

  function beginHistoryRead(): number {
    coalesceFromOrdinal = ordinal;
    return ordinal;
  }

  function buffer(event: V2Event, eventOrdinal: number): void {
    // Adjacent deltas for one part collapse into the entry they follow, so a
    // fast stream costs one entry per part rather than one per token. Only an
    // entry that arrived AFTER the read started is a coalescing target: an
    // earlier entry keeps its own ordinal, so a delta held before the boundary
    // stays distinguishable from one that arrived during the read. The merged
    // entry keeps the LATER ordinal, because the fold target is the later entry.
    const last = eventBuffer[eventBuffer.length - 1];
    if (last !== undefined && last.ordinal > coalesceFromOrdinal) {
      const merged = coalescedDelta(last.event, event);
      if (merged !== null) {
        eventBuffer[eventBuffer.length - 1] = { ordinal: eventOrdinal, event: merged };
        return;
      }
    }
    eventBuffer.push({ ordinal: eventOrdinal, event });
    // The backstop, not the mechanism: coalescing is what keeps a long stream
    // from filling this. Reaching the limit means that many DISTINCT events
    // arrived during one read.
    //
    // The drop is ANNOUNCED, never silent (M5's outstanding hold). Three
    // things happen, because a log alone does not recover the lost events:
    //
    // 1. a warning names the loss, so the log shows the transcript is
    //    incomplete;
    // 2. the dropped count reaches the domain state, as a diagnostic - so
    //    the state itself can say "some events were lost";
    // 3. the attempt's readiness is failed, because a transcript that silently
    //    lost events is NOT a successful reconciliation, and claiming it was
    //    would be a lie the reader would act on.
    //
    // The events themselves are not recovered: they are gone, and the only
    // honest repair is a fresh read, which the failed readiness triggers.
    if (eventBuffer.length > OPENCODE_V2_EVENT_BUFFER_LIMIT) {
      const dropped = eventBuffer.length - OPENCODE_V2_EVENT_BUFFER_LIMIT;
      eventBuffer = eventBuffer.slice(-OPENCODE_V2_EVENT_BUFFER_LIMIT);
      droppedEvents += dropped;
      // The report fires ONCE per overflow episode, and it is deferred to the
      // point where the loss is FINAL: the end of the buffer's life. Reporting
      // per dropped event would put thousands of identical lines in the log,
      // and reporting at the first drop would report a number that is still
      // growing.
      if (!overflowReported) {
        overflowReported = true;
        host.reportBufferOverflow(droppedEvents, eventBuffer.length);
      }
    }
  }

  function bufferedEntries(): readonly BufferedEvent[] {
    // A copy, because the caller iterates this while it dispatches the events
    // it holds, and the pipeline's own array must not be reachable from there.
    return [...eventBuffer];
  }

  /**
   * The loss the buffer has carried, if any.
   *
   * The controller reads this when the buffer is DRAINED, because that is when
   * the loss is final. The per-event report is the early warning - it says
   * "the transcript is already incomplete" - and this is the accounting.
   *
   * @returns The number of events lost, or 0.
   */
  function droppedEventCount(): number {
    return droppedEvents;
  }

  function clearBuffer(): void {
    eventBuffer = [];
    // The loss and the buffer are one thing: clearing the buffer clears the
    // running total, because the next read starts a new account.
    droppedEvents = 0;
    overflowReported = false;
  }

  function resetAttempt(): void {
    reconnectAttempt = 0;
    // A completed hydration is the runtime proving it recovered: the next
    // failure gets a full budget again.
    exhausted = false;
  }

  function isExhausted(): boolean {
    return exhausted;
  }

  function cancelReconnect(): boolean {
    if (reconnectTimer === null) return false;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    return true;
  }

  return {
    consume,
    scheduleReconnect,
    nextOrdinal,
    beginHistoryRead,
    buffer,
    bufferedEntries,
    droppedEventCount,
    clearBuffer,
    get attemptCount(): number {
      return reconnectAttempt;
    },
    resetAttempt,
    isExhausted,
    cancelReconnect,
  };
}
