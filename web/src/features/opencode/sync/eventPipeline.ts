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
 * Every event carries an ordinal, and the ordinal is what makes an ordering
 * decision possible at all: the reducer discards a snapshot older than the
 * newest applied event, and the history loader uses the ordinal to tell which
 * buffered events arrived after the read it started. It is a local counter -
 * it says nothing about the server's clock.
 *
 * ## THE BUFFER
 *
 * Events that arrive while the history is loading are held, because a
 * projection that replaces the transcript would otherwise erase them. The
 * buffer is drained by the loader, in ordinal order.
 *
 * Its overflow handling is reproduced here exactly as it was: the filter
 * that drops assistant events is vestigial, and Phase 4 of the remediation
 * plan is where it is replaced with a plain truncation. Moving the code must
 * not quietly fix it.
 *
 * ## THE RETRY BUDGET
 *
 * `reconnectAttempt` counts the retries the current attempt has spent. The
 * budget is charged when a retry is scheduled and reset when a hydration
 * COMPLETES. Phase 3 of the remediation plan moves that reset into the
 * attempt that earned it; until then the reset stays where it is.
 *
 * This module was extracted from `v2ThreadController.ts` as part of Phase 2 of
 * the OpenCode runtime remediation plan. The extraction is behaviour
 * preserving.
 */

import {
  OPENCODE_V2_EVENT_BUFFER_LIMIT,
  OPENCODE_V2_INITIAL_RECONNECT_DELAY_MS,
  OPENCODE_V2_MAX_RECONNECT_DELAY_MS,
} from "@/features/opencode/config";
import type { V2Event } from "@opencode/client";
import type { OpenCodeV2Generation } from "../v2Client";
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
 * The delay before the next retry.
 *
 * @param attempt - The number of retries already spent.
 * @param delays - The backoff parameters.
 * @returns The delay in milliseconds.
 */
export function computeReconnectDelay(
  attempt: number,
  delays: ReconnectDelays = DEFAULT_RECONNECT_DELAYS,
): number {
  return Math.min(delays.maxReconnectDelayMs, delays.initialReconnectDelayMs * 2 ** attempt);
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
  /** The attempt the pipeline drives. */
  readonly attempt: Attempt;
  /** The retry budget and the backoff parameters. */
  readonly config: {
    readonly maxReconnectAttempts: number;
    readonly initialReconnectDelayMs: number;
    readonly maxReconnectDelayMs: number;
  };
  /** Dispatches a domain action. */
  dispatch(action: V2ThreadAction): void;
  /** Applies one event to the domain state. */
  applyEvent(event: V2Event, ordinal: number): void;
  /** Establishes a new connection. */
  startConnection(): Promise<void>;
  /** Reports that the runtime did not come up. */
  failReady(error: V2SafeError): void;
  /** Normalises an unknown error into the runtime's safe vocabulary. */
  toSafeError(error: unknown, fallback: string): V2SafeError;
}

/** The pipeline's surface. */
export interface EventPipeline {
  /**
   * Consumes the event stream of a generation until it ends or fails.
   *
   * @param generation - The generation whose events to consume.
   */
  consume(generation: OpenCodeV2Generation): Promise<void>;
  /**
   * Schedules a retry, if the budget allows one.
   *
   * @param error - Why the stream failed.
   */
  scheduleReconnect(error: V2SafeError): void;
  /**
   * The next ordinal.
   *
   * @returns The ordinal of the event that is about to be applied.
   */
  nextOrdinal(): number;
  /**
   * The ordinal of the most recently applied event.
   *
   * @returns The current ordinal.
   */
  currentOrdinal(): number;
  /**
   * Holds an event that arrived while the history was loading.
   *
   * @param event - The event.
   * @param ordinal - The event's ordinal.
   */
  buffer(event: V2Event, ordinal: number): void;
  /**
   * The buffered events that arrived after an ordinal.
   *
   * @param ordinal - The ordinal to compare against.
   * @returns The matching events, in order.
   */
  bufferedSince(ordinal: number): BufferedEvent[];
  /** Empties the buffer. */
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
   * Called when a hydration COMPLETES. Phase 3 moves this into the attempt
   * that earned it.
   */
  resetAttempt(): void;
  /**
   * Cancels a pending retry.
   *
   * @returns True when a retry was pending and has been cancelled.
   */
  cancelReconnect(): boolean;
  /**
   * Whether a retry is pending.
   *
   * @returns True when a retry is scheduled.
   */
  hasPendingReconnect(): boolean;
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
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  async function consume(generation: OpenCodeV2Generation): Promise<void> {
    try {
      while (!host.isDisposed && host.attempt.isCurrent(generation)) {
        const result = await generation.events.next();
        if (result.done) throw new Error("OpenCode V2 event stream closed");
        if (host.isDisposed || !host.attempt.isCurrent(generation)) return;
        const eventOrdinal = ++ordinal;
        host.applyEvent(result.value, eventOrdinal);
      }
    } catch (error) {
      if (host.isDisposed || !host.attempt.isCurrent(generation)) return;
      scheduleReconnect(host.toSafeError(error, "OpenCode V2 event stream failed"));
    }
  }

  function scheduleReconnect(error: V2SafeError): void {
    if (host.isDisposed || reconnectTimer !== null) return;
    // Terminal failure: no more auto-retries after exhausting the budget.
    if (reconnectAttempt >= host.config.maxReconnectAttempts) {
      host.dispatch({
        type: "connection_changed",
        connection: { type: "failed", attempt: reconnectAttempt },
      });
      host.dispatch({ type: "load_failed", error });
      host.failReady(error);
      return;
    }
    const failedGeneration = host.attempt.current;
    host.attempt.setCurrent(null);
    host.attempt.abortConnection();
    if (failedGeneration) void failedGeneration.events.close();
    host.attempt.setLoad(null);
    host.dispatch({
      type: "connection_changed",
      connection: { type: "reconnecting", attempt: reconnectAttempt + 1 },
    });
    host.dispatch({ type: "load_failed", error });
    host.failReady(error);
    const delay = computeReconnectDelay(reconnectAttempt, host.config);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      const started = host.startConnection().catch((cause: unknown) => {
        host.attempt.setLoad(null);
        throw cause;
      });
      host.attempt.setLoad(started);
      void started.catch(() => undefined);
    }, delay);
  }

  function nextOrdinal(): number {
    ordinal += 1;
    return ordinal;
  }

  function currentOrdinal(): number {
    return ordinal;
  }

  function buffer(event: V2Event, eventOrdinal: number): void {
    eventBuffer.push({ ordinal: eventOrdinal, event });
    if (eventBuffer.length > OPENCODE_V2_EVENT_BUFFER_LIMIT) {
      eventBuffer = eventBuffer
        .filter((entry) => !isAssistantMessageEvent(entry.event))
        .slice(-OPENCODE_V2_EVENT_BUFFER_LIMIT);
    }
  }

  function bufferedSince(eventOrdinal: number): BufferedEvent[] {
    return eventBuffer.filter((entry) => entry.ordinal > eventOrdinal);
  }

  function clearBuffer(): void {
    eventBuffer = [];
  }

  function resetAttempt(): void {
    reconnectAttempt = 0;
  }

  function cancelReconnect(): boolean {
    if (reconnectTimer === null) return false;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    return true;
  }

  function hasPendingReconnect(): boolean {
    return reconnectTimer !== null;
  }

  return {
    consume,
    scheduleReconnect,
    nextOrdinal,
    currentOrdinal,
    buffer,
    bufferedSince,
    clearBuffer,
    get attemptCount(): number {
      return reconnectAttempt;
    },
    resetAttempt,
    cancelReconnect,
    hasPendingReconnect,
  };
}
