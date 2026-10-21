/**
 * The connection attempt: the live generation, its abort signals, and the
 * load it is waiting on.
 *
 * ## WHAT THIS OWNS
 *
 * The **identity of the current connection** - the generation the controller
 * is talking to, the abort controllers that cut it off, and the promise of
 * the load in flight.
 *
 * ## WHAT THIS DOES NOT OWN
 *
 * - **The events.** Consuming them is `sync/eventPipeline.ts`'s business.
 * - **The history.** Reading it is `sync/sessionMessageLoader.ts`'s.
 * - **The retry policy.** When to retry and when to give up is the pipeline's;
 *   this module only holds what a retry would replace.
 * - **Domain state.** The transcript and the execution state belong to the
 *   controller, which dispatches them.
 *
 * ## WHY THE IDENTITY IS A VALUE AND NOT A VARIABLE
 *
 * Every asynchronous continuation in the runtime has to answer one question
 * before it commits anything: *is the generation I was started for still the
 * current one?* Today that question is answered by comparing two closure
 * variables. `isCurrent` is that comparison, named - and Phase 3 of the
 * remediation plan builds the attempt-scoped discipline on top of it.
 *
 * ## THE LOAD PROMISE
 *
 * `load()` returns the promise of the load in flight, so a second caller does
 * not start a second connection. The promise is cleared by its own failure
 * handler, which is how a failed load becomes retryable.
 *
 * This module was extracted from `v2ThreadController.ts` as part of Phase 2 of
 * the OpenCode runtime remediation plan. The extraction is behaviour
 * preserving: the same generation, the same signals, the same promise.
 */

import type { OpenCodeV2Generation, V2ConnectionSignals } from "../v2Client";

/** The attempt's surface. */
export interface Attempt {
  /**
   * The generation this attempt is talking to, if it is connected.
   *
   * @returns The generation, or `null` when there is none.
   */
  readonly current: OpenCodeV2Generation | null;
  /**
   * Whether a generation is still the current one.
   *
   * The check every asynchronous continuation makes before it commits state.
   *
   * @param generation - The generation a continuation was started for.
   * @returns True when it is still current.
   */
  isCurrent(generation: OpenCodeV2Generation | null): boolean;
  /**
   * Makes a generation the current one.
   *
   * @param generation - The generation, or `null` to clear it.
   */
  setCurrent(generation: OpenCodeV2Generation | null): void;
  /**
   * Begins a connection: aborts the previous one and returns the signals for
   * the new one.
   *
   * The lifecycle signal is kept across connections - it outlives a single
   * generation - while the connection signal is per-generation.
   *
   * @returns The signals for the new connection.
   */
  beginConnection(): V2ConnectionSignals;
  /** Aborts the current connection, if there is one. */
  abortConnection(): void;
  /** Aborts the lifecycle, if it has been started. */
  abortLifecycle(): void;
  /**
   * The load in flight, if there is one.
   *
   * @returns The promise, or `null`.
   */
  load(): Promise<void> | null;
  /**
   * Records the load in flight.
   *
   * @param promise - The promise, or `null` to clear it.
   */
  setLoad(promise: Promise<void> | null): void;
}

/**
 * Creates the attempt.
 *
 * @returns The attempt.
 */
export function createAttempt(): Attempt {
  let generation: OpenCodeV2Generation | null = null;
  let connectionController: AbortController | null = null;
  let lifecycleController: AbortController | null = null;
  let loadPromise: Promise<void> | null = null;

  function isCurrent(candidate: OpenCodeV2Generation | null): boolean {
    return generation === candidate;
  }

  function setCurrent(next: OpenCodeV2Generation | null): void {
    generation = next;
  }

  function beginConnection(): V2ConnectionSignals {
    connectionController?.abort();
    connectionController = new AbortController();
    lifecycleController ??= new AbortController();
    return {
      connectionSignal: connectionController.signal,
      lifecycleSignal: lifecycleController.signal,
    };
  }

  function abortConnection(): void {
    connectionController?.abort();
  }

  function abortLifecycle(): void {
    lifecycleController?.abort();
  }

  function load(): Promise<void> | null {
    return loadPromise;
  }

  function setLoad(promise: Promise<void> | null): void {
    loadPromise = promise;
  }

  return {
    get current(): OpenCodeV2Generation | null {
      return generation;
    },
    isCurrent,
    setCurrent,
    beginConnection,
    abortConnection,
    abortLifecycle,
    load,
    setLoad,
  };
}
