/**
 * The connection attempt: one attempt's identity, readiness, abort signals,
 * load promise and hydration outcome.
 *
 * ## WHAT THIS OWNS
 *
 * Everything that belongs to **one** attempt to bring the runtime up:
 *
 * - the generation it adopted,
 * - its own readiness gate (so its readiness promise has exactly one owner),
 * - its connection signal (aborted the moment the attempt stops being live),
 * - its idle watchdog: a silent stream aborts the CONNECTION (not the attempt)
 *   so the pipeline's existing reconnect path replaces it,
 * - the promise of the load in flight,
 * - whether it is still awaiting its first history projection (`hydrating`),
 * - whether it is settled (`retired`): superseded by a newer attempt,
 *   terminally failed, or disposed with the controller.
 *
 * ## WHAT THIS DOES NOT OWN
 *
 * - **The events.** Consuming them is `sync/eventPipeline.ts`'s business.
 * - **The history.** Reading it is `sync/sessionMessageLoader.ts`'s.
 * - **The retry budget.** When to retry and how many attempts are left is the
 *   pipeline's. This module only reports whether an attempt *completed* its
 *   hydration, which is the one fact the budget reset is allowed to depend on.
 * - **Domain state.** The transcript and the execution state belong to the
 *   controller, which dispatches them.
 *
 * ## THE RULE THAT CLOSES M1, M2 AND L4 AS A CLASS
 *
 * An attempt's readiness, load promise, abort signals and hydration outcome
 * are reachable **only through that attempt's handle**, and two synchronous
 * acts settle it: `retire()` when it is superseded, `fail()` when it fails
 * terminally. Both set `retired` before they do anything else, so no
 * continuation can observe a settled attempt as live. Every commit is guarded
 * by it:
 *
 * - `markReady()` refuses to resolve the readiness of a retired attempt, so a
 *   superseded attempt can never settle the readiness of a newer one (L4).
 * - `retire()` and `fail()` abort only their own connection signal, so a
 *   settled attempt cannot tear down a newer one (M2).
 * - `load()` is a per-attempt slot, so clearing a failed attempt's load
 *   promise cannot drop a newer attempt's (M2).
 * - `retire()`, `fail()`, `markReady()` and `endHydration()` all clear
 *   `hydrating`, so a dead attempt can never leave the transcript buffering
 *   behind a hydration that will not happen (M4).
 * - because `fail()` settles the attempt, a terminally failed attempt cannot
 *   consume a later event into the transcript or dispatch a state change from
 *   a continuation that was already in flight.
 *
 * What is deliberately NOT reachable from here is the retry counter: M1 was
 * a counter reset that any stale attempt could reach. The counter lives in
 * `eventPipeline.ts`, and the controller resets it only after `markReady()`
 * *and* an identity check, so the reset belongs to a completed attempt (M1).
 *
 * This module was extracted from `v2ThreadController.ts` in Phase 2 of the
 * OpenCode runtime remediation plan; Phase 3 gave it the attempt-scoped
 * ownership above.
 */

import type { OpenCodeV2Generation, V2ConnectionSignals } from "../v2Client";
import { createStartupGate, type StartupGate } from "./startupGate";

/**
 * The error a superseded attempt's readiness rejects with.
 *
 * It is a *sentinel*, not a failure of the runtime: a waiter that sees it must
 * move on to the attempt that replaced the one it was waiting for. Kept as its
 * own class so `awaitReady()` can tell "the runtime failed" apart from "the
 * runtime was replaced while you were waiting".
 */
export class AttemptSupersededError extends Error {
  /** The id of the attempt that was superseded. */
  public readonly attemptId: number;

  public constructor(attemptId: number) {
    super(`OpenCode V2 attempt ${attemptId} was superseded`);
    this.name = "AttemptSupersededError";
    this.attemptId = attemptId;
  }
}

/** One connection attempt's surface. */
export interface Attempt {
  /** The attempt's id: stable, and unique within one controller. */
  readonly id: number;
  /** This attempt's readiness promise, and the only handles that settle it. */
  readonly gate: StartupGate;
  /**
   * This attempt's abort signals, as handed to the client.
   *
   * `onActivity` is the whole watchdog interface: the official client reports
   * every chunk it reads there (SSE keepalives included), and the attempt
   * resets its idle timer from it.
   */
  readonly signals: V2ConnectionSignals;
  /**
   * The generation this attempt adopted.
   *
   * @returns The generation, or `null` before it connected.
   */
  readonly generation: OpenCodeV2Generation | null;
  /**
   * Whether this attempt is still awaiting its first history projection.
   *
   * Events are buffered while this is true and applied directly once it is
   * false. Every terminal transition clears it.
   */
  readonly hydrating: boolean;
  /** Whether this attempt has been superseded, failed or disposed. */
  readonly retired: boolean;
  /**
   * Settles when this attempt stops owning the runtime WITHOUT failing: a newer
   * attempt replaced it, or the controller was disposed.
   *
   * Deliberately not settled by `fail()`. A waiter must report a real failure as
   * itself, and only re-join a replacement; conflating the two would turn a
   * failed connect into a silent retry. It exists because a superseded attempt's
   * hydration may never finish, so waiting for its load promise alone can hang
   * past the point where the attempt is gone.
   */
  readonly superseded: Promise<void>;
  /**
   * Settles with the real failure when `fail()` ends this attempt.
   *
   * The load may be waiting on a hydration read that never returns, so a
   * terminal failure has to reach the waiter without hydration: it is not a
   * supersession, and the load must reject with the failure itself. Resolves
   * (rather than rejects) so an attempt that is failed without a load waiting
   * on it cannot surface as an unhandled rejection.
   */
  readonly failure: Promise<unknown>;
  /**
   * Adopts the generation the connection produced.
   *
   * A no-op on a retired attempt: an attempt that was superseded between its
   * connect and this call must not claim the generation.
   *
   * @param generation - The generation to adopt.
   */
  adopt(generation: OpenCodeV2Generation): void;
  /** Marks the start of the first history projection. */
  beginHydration(): void;
  /**
   * The history projection landed: live events apply directly from here.
   *
   * Deliberately separate from `markReady()`: the projection completes before
   * the auxiliary read, and the transcript must stop buffering of its own
   * accord rather than wait for the whole hydration.
   */
  projectionCommitted(): void;
  /** Clears `hydrating` unconditionally. Idempotent, so a `finally` can call it. */
  endHydration(): void;
  /**
   * Resolves this attempt's readiness.
   *
   * A no-op once the attempt is retired, which is what makes a late hydration
   * return unable to settle a newer attempt's readiness.
   */
  markReady(): void;
  /**
   * Fails this attempt terminally: settles it, aborts its connection and
   * rejects its readiness with the real failure.
   *
   * "Terminally" is the point. The attempt is marked retired **before**
   * anything else happens, so no continuation, stream reader or hydration
   * return from it can commit after this returns - the same guarantee
   * `retire()` gives a superseded attempt, with the failure kept as the reason
   * readiness rejects.
   *
   * @param error - The failure.
   */
  fail(error: unknown): void;
  /**
   * Supersedes this attempt: aborts its connection and rejects its readiness
   * with `AttemptSupersededError`.
   *
   * Synchronous and idempotent. Because it is synchronous, no continuation of
   * this attempt can observe itself as live after it returns.
   */
  retire(): void;
  /**
   * The load in flight for THIS attempt, if there is one.
   *
   * @returns The promise, or `null`.
   */
  load(): Promise<void> | null;
  /**
   * Records the load in flight for THIS attempt.
   *
   * Attempt-scoped on purpose: a failure handler clears the promise of the
   * attempt it belongs to, never a newer attempt's.
   *
   * @param promise - The promise, or `null` to clear it.
   */
  setLoad(promise: Promise<void> | null): void;
}

/**
 * Creates one connection attempt.
 *
 * The attempt opens its own readiness gate immediately, so there is no window
 * in which a caller can wait on an attempt whose readiness promise does not
 * exist yet.
 *
 * @param id - The attempt's id, unique within the owning controller.
 * @param lifecycleSignal - The controller-lifetime signal, which outlives this
 * attempt and is aborted only when the controller is disposed.
 * @param streamIdleTimeoutMs - How long the event stream may be silent before
 * this attempt's connection is aborted to force a reconnect.
 * @returns The attempt.
 */
export function createAttempt(
  id: number,
  lifecycleSignal: AbortSignal,
  streamIdleTimeoutMs: number,
): Attempt {
  const connection = new AbortController();
  const gate = createStartupGate();
  let adopted: OpenCodeV2Generation | null = null;
  let hydrating = false;
  let retired = false;
  let loadPromise: Promise<void> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let signalSuperseded: (() => void) | null = null;
  /**
   * Resolved by `retire()` only.
   *
   * A superseded attempt's load may never settle, so this is what lets a waiter
   * let go of it and re-join the attempt that replaced it.
   */
  const superseded = new Promise<void>((resolve) => {
    signalSuperseded = resolve;
  });
  let signalFailure: ((error: unknown) => void) | null = null;
  /**
   * Settled by `fail()` only.
   *
   * `superseded` cannot carry a failure: `scheduleReconnect` retires an attempt
   * before failing its readiness on the recoverable path, so the load would
   * otherwise see a replacement where a terminal failure has none. A failure
   * that ends the attempt resolves this, and the load rejects with the error
   * itself rather than waiting for a hydration read that may never return.
   */
  const failure = new Promise<unknown>((resolve) => {
    signalFailure = resolve;
  });
  /**
   * Whether this attempt still has its listener on the controller-lifetime
   * signal.
   *
   * The signal outlives the attempt, so a settled attempt that left its
   * listener behind would add one per reconnect cycle to an object aborted
   * only when the controller is disposed.
   */
  let lifecycleListening = true;

  function clearIdleTimer(): void {
    if (idleTimer === null) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  /**
   * Detaches this attempt's lifecycle listener, at most once.
   *
   * Idempotent because `fail()`, `retire()` and the abort dispatch itself can
   * all reach it, and removing the same listener twice would make an
   * add/remove balance meaningless.
   */
  function detachLifecycleListener(): void {
    if (!lifecycleListening) return;
    lifecycleListening = false;
    lifecycleSignal.removeEventListener("abort", onLifecycleAbort);
  }

  function onLifecycleAbort(): void {
    // The controller is going away: nothing may keep a watchdog timer alive
    // after it, and the listener that reported it is done.
    clearIdleTimer();
    detachLifecycleListener();
  }

  function onIdle(): void {
    idleTimer = null;
    if (retired) return;
    // Deliberately NOT `retire()` or `fail()`. Both settle the attempt, which
    // would report a silent stream as a terminal failure. A silent stream is
    // the same situation as a dropped connection: abort the connection and let
    // the stream reader route the failure into the reconnect path, where the
    // attempt is retired and a replacement is scheduled.
    connection.abort();
  }

  function armIdleTimer(): void {
    clearIdleTimer();
    // A settled attempt has no stream to watch, and an aborted connection is
    // already dead: rearming would only schedule an abort that has happened.
    // Activity can still be reported in the window between the abort and the
    // reader observing it, and after retirement.
    if (retired || lifecycleSignal.aborted || connection.signal.aborted) return;
    idleTimer = setTimeout(onIdle, streamIdleTimeoutMs);
  }

  const signals: V2ConnectionSignals = {
    connectionSignal: connection.signal,
    lifecycleSignal,
    onActivity: armIdleTimer,
  };

  // A watchdog outliving its controller would keep a Node/Bun process alive
  // for its whole duration after the runtime is gone. The listener is removed
  // by `fail()`/`retire()` as well, because those settle the attempt long
  // before the controller is disposed.
  lifecycleSignal.addEventListener("abort", onLifecycleAbort, { once: true });

  gate.open();
  armIdleTimer();

  function adopt(generation: OpenCodeV2Generation): void {
    if (retired) return;
    adopted = generation;
  }

  function beginHydration(): void {
    if (retired) return;
    hydrating = true;
  }

  function projectionCommitted(): void {
    hydrating = false;
  }

  function endHydration(): void {
    hydrating = false;
  }

  function markReady(): void {
    if (retired) return;
    hydrating = false;
    gate.resolve();
  }

  function fail(error: unknown): void {
    if (retired) return;
    // Settle FIRST: from this point no continuation of this attempt may commit,
    // which is the same synchronous guarantee `retire()` gives a superseded
    // attempt. The failure is kept as readiness's rejection reason.
    retired = true;
    hydrating = false;
    detachLifecycleListener();
    clearIdleTimer();
    connection.abort();
    gate.reject(error);
    // The load's other settlement: readiness only settles a waiter that has
    // already hydrated, and a terminal failure can arrive while hydration is
    // unresolved. `retire()` does not reach here, so a recoverable failure
    // that schedules a replacement stays a supersession for the load.
    signalFailure?.(error);
  }

  function retire(): void {
    if (retired) return;
    retired = true;
    hydrating = false;
    detachLifecycleListener();
    clearIdleTimer();
    connection.abort();
    // Settled before the gate so a waiter that was waiting on the LOAD (whose
    // hydration may never finish) stops waiting on an attempt that is gone.
    // `fail()` does not reach here: it settles `retired` first, so the early
    // return above keeps a real failure a failure.
    signalSuperseded?.();
    gate.reject(new AttemptSupersededError(id));
  }

  function load(): Promise<void> | null {
    return loadPromise;
  }

  function setLoad(promise: Promise<void> | null): void {
    loadPromise = promise;
  }

  return {
    id,
    gate,
    signals,
    get generation(): OpenCodeV2Generation | null {
      return adopted;
    },
    get hydrating(): boolean {
      return hydrating;
    },
    get retired(): boolean {
      return retired;
    },
    superseded,
    failure,
    adopt,
    beginHydration,
    projectionCommitted,
    endHydration,
    markReady,
    fail,
    retire,
    load,
    setLoad,
  };
}
