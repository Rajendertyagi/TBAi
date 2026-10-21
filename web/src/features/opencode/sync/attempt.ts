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
  /** This attempt's abort signals, as handed to the client. */
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
 * @returns The attempt.
 */
export function createAttempt(id: number, lifecycleSignal: AbortSignal): Attempt {
  const connection = new AbortController();
  const gate = createStartupGate();
  const signals: V2ConnectionSignals = {
    connectionSignal: connection.signal,
    lifecycleSignal,
  };
  let adopted: OpenCodeV2Generation | null = null;
  let hydrating = false;
  let retired = false;
  let loadPromise: Promise<void> | null = null;

  gate.open();

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
    connection.abort();
    gate.reject(error);
  }

  function retire(): void {
    if (retired) return;
    retired = true;
    hydrating = false;
    connection.abort();
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
