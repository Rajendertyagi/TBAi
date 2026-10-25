/**
 * The readiness gate: the promise that says the runtime has come up.
 *
 * ## WHAT THIS OWNS
 *
 * The **readiness promise** of the current connection attempt, and the two
 * handles that settle it. One promise, one owner: whoever holds the gate is
 * the only thing that can resolve or reject it.
 *
 * ## WHAT THIS DOES NOT OWN
 *
 * - **The attempt.** The gate does not create a connection, and it does not
 *   decide which attempt it belongs to. Since Phase 3 of the remediation plan
 *   each attempt creates its own gate (`sync/attempt.ts`), so "which attempt
 *   opened this promise" is answered by ownership: the attempt holds the only
 *   handle that can settle it, and a superseded attempt refuses to resolve it.
 * - **The failure.** The gate is told what went wrong; it does not classify
 *   the error, and it does not decide whether the runtime should retry.
 * - **The work that makes the runtime ready.** The gate reports the outcome;
 *   hydration and connection are somebody else's. What this module does own is
 *   the *deadline* those waits share: `withDeadline()` bounds any promise the
 *   same way `waitWithDeadline()` bounds the gate's.
 *
 * ## WHY A GATE AND NOT A BARE PROMISE
 *
 * The promise has to be created, settled and awaited from three different
 * places: the connection attempt that opens it, the failure paths that reject
 * it, and `awaitReady`, which waits on it. A bare promise needs three
 * variables to stay in step; the gate keeps them together and makes the
 * pairing impossible to get wrong.
 *
 * ## THE HANDLED REJECTION
 *
 * `open()` marks the promise as handled immediately. `load()` and
 * `awaitReady()` are deliberately separate entry points, so a caller may only
 * ever await `load()` - and the promise must not surface as an unhandled
 * rejection in that case. Callers that DO await the promise still receive the
 * same rejection.
 *
 * This module was extracted from `v2ThreadController.ts` as part of Phase 2 of
 * the OpenCode runtime remediation plan. The extraction is behaviour
 * preserving: the same promise, settled at the same moments, with the same
 * rejection.
 */

/**
 * The error a bounded readiness wait rejects with.
 *
 * It is its own type because "the runtime did not come up in time" is neither
 * a failure of the runtime nor a supersession: the attempt may still come up,
 * and the waiter simply stopped watching. A caller that treats it as a
 * terminal failure would report a dead runtime for a slow one.
 */
export class StartupTimeoutError extends Error {
  /** The deadline that elapsed, in milliseconds. */
  public readonly timeoutMs: number;

  public constructor(timeoutMs: number) {
    super(`OpenCode V2 runtime was not ready within ${timeoutMs}ms`);
    this.name = "StartupTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** The gate's surface. */
export interface StartupGate {
  /**
   * Opens the gate for a new connection attempt.
   *
   * The returned promise is already marked as handled, so a caller that never
   * awaits it does not produce an unhandled rejection.
   *
   * @returns The readiness promise.
   */
  open(): Promise<void>;
  /** Resolves the gate: the runtime is up. */
  resolve(): void;
  /**
   * Rejects the gate: the runtime did not come up.
   *
   * @param error - The reason.
   */
  reject(error: unknown): void;
  /**
   * The promise the gate is currently waiting on, if it has one.
   *
   * @returns The promise, or `null` when no attempt has opened the gate.
   */
  pending(): Promise<void> | null;
  /**
   * Waits for readiness, but not forever.
   *
   * A caller that waits forever is a caller with no answer: the composer
   * holds the reader's text with no way to release it and no way to say why.
   * The deadline is the gate's own, because the gate is the thing that
   * settles readiness - a waiter that gives up first must not settle the
   * gate, it must only stop waiting.
   *
   * @param timeoutMs - How long to wait before giving up.
   * @returns The readiness promise, or a rejection carrying the timeout.
   */
  waitWithDeadline(timeoutMs: number): Promise<void>;
}

/**
 * Waits for a promise, but not longer than `timeoutMs`.
 *
 * The deadline stops only the waiter. The underlying work keeps running, and
 * a promise that settles after the deadline neither turns into a timeout nor
 * surfaces as an unhandled rejection - which is exactly what "the runtime is
 * slow" must look like: the caller gets an answer, the runtime keeps coming
 * up.
 *
 * @param promise - The work to wait for.
 * @param timeoutMs - How long to wait before giving up.
 * @returns The promise's value, or a rejection carrying `StartupTimeoutError`.
 */
export function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StartupTimeoutError(timeoutMs)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Creates the readiness gate.
 *
 * @returns The gate.
 */
export function createStartupGate(): StartupGate {
  let promise: Promise<void> | null = null;
  let resolveGate: (() => void) | null = null;
  let rejectGate: ((error: unknown) => void) | null = null;

  function open(): Promise<void> {
    const opened = new Promise<void>((resolve, reject) => {
      resolveGate = resolve;
      rejectGate = reject;
    });
    // `load()` and `awaitReady()` are intentionally separate entry points.
    // Mark the internal promise handled even when a caller only awaits
    // `load()`; callers that do await it still receive the same rejection.
    void opened.catch(() => undefined);
    promise = opened;
    return opened;
  }

  function resolve(): void {
    resolveGate?.();
    resolveGate = null;
    rejectGate = null;
  }

  function reject(error: unknown): void {
    rejectGate?.(error);
    resolveGate = null;
    rejectGate = null;
  }

  function pending(): Promise<void> | null {
    return promise;
  }

  function waitWithDeadline(timeoutMs: number): Promise<void> {
    const opened = promise;
    // A gate nobody opened is already past its deadline: waiting on it can
    // only ever time out.
    if (opened === null) return Promise.reject(new StartupTimeoutError(timeoutMs));
    // The deadline only stops THIS waiter. The gate keeps its own promise:
    // a late resolve must not be reported as a timeout, and a timeout must
    // not settle the gate for anybody else.
    return withDeadline(opened, timeoutMs);
  }

  return { open, resolve, reject, pending, waitWithDeadline };
}
