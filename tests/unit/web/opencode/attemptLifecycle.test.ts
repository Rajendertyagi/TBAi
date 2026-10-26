import { afterEach, describe, expect, it, jest } from "bun:test";
import { getEventListeners } from "node:events";
import { createAttempt } from "@web/features/opencode/sync/attempt.ts";

/**
 * RT-008: an attempt's listener on the controller-lifetime signal is a LOAN.
 *
 * The lifecycle signal outlives every attempt (it is aborted only when the
 * controller is disposed). An attempt that settles - superseded, terminally
 * failed, or discarded by a reconnect - must therefore detach its listener, or
 * every reconnect adds one more to an object that may live for hours.
 *
 * The same rule closes the second half of the defect: an attempt whose
 * connection has already been aborted (by the idle watchdog, or by settlement)
 * must not be able to ARM a new watchdog from late activity, because there is
 * no stream left to watch.
 *
 * The balance is measured with `node:events.getEventListeners`, which reports
 * the listeners actually attached to an `AbortSignal`; a behavioural test alone
 * cannot see a listener that fires into a no-op.
 */

/** Long enough that no timer fires during a test unless the test wants it to. */
const IDLE_TIMEOUT_MS = 5_000;

function lifecycleListenerCount(signal: AbortSignal): number {
  return getEventListeners(signal, "abort").length;
}

// Each test that uses the fake clock restores the real one; a failing assertion
// must not leave the next test without real timers.
afterEach(() => {
  jest.useRealTimers();
});

describe("RT-008: an attempt detaches its lifecycle listener when it settles", () => {
  it("attaches exactly one listener and removes it on retirement", () => {
    const lifecycle = new AbortController();
    const attempt = createAttempt(1, lifecycle.signal, IDLE_TIMEOUT_MS);

    expect(lifecycleListenerCount(lifecycle.signal)).toBe(1);

    attempt.retire();

    expect(lifecycleListenerCount(lifecycle.signal)).toBe(0);
    // Idempotent: settling twice must not try to remove it twice.
    attempt.retire();
    expect(lifecycleListenerCount(lifecycle.signal)).toBe(0);
  });

  it("removes it on terminal failure", () => {
    const lifecycle = new AbortController();
    const attempt = createAttempt(1, lifecycle.signal, IDLE_TIMEOUT_MS);

    expect(lifecycleListenerCount(lifecycle.signal)).toBe(1);

    attempt.fail(new Error("connection refused"));

    expect(lifecycleListenerCount(lifecycle.signal)).toBe(0);
    expect(attempt.retired).toBe(true);
  });

  it("does not accumulate listeners across repeated attempt cycles", () => {
    const lifecycle = new AbortController();

    for (let id = 1; id <= 25; id += 1) {
      const attempt = createAttempt(id, lifecycle.signal, IDLE_TIMEOUT_MS);
      expect(lifecycleListenerCount(lifecycle.signal)).toBe(1);
      // Both terminal paths, alternating.
      if (id % 2 === 0) attempt.fail(new Error("boom"));
      else attempt.retire();
      expect(lifecycleListenerCount(lifecycle.signal)).toBe(0);
    }

    // Several attempts alive at once still add one listener each, and the
    // controller's own abort clears the rest.
    const living = [1, 2, 3].map((id) => createAttempt(id, lifecycle.signal, IDLE_TIMEOUT_MS));
    expect(lifecycleListenerCount(lifecycle.signal)).toBe(3);
    lifecycle.abort();
    expect(lifecycleListenerCount(lifecycle.signal)).toBe(0);
    for (const attempt of living) expect(attempt.signals.lifecycleSignal.aborted).toBe(true);
  });

  it("never aborts the controller-lifetime signal when an attempt settles", () => {
    const lifecycle = new AbortController();

    const retired = createAttempt(1, lifecycle.signal, IDLE_TIMEOUT_MS);
    retired.retire();
    expect(lifecycle.signal.aborted).toBe(false);

    const failed = createAttempt(2, lifecycle.signal, IDLE_TIMEOUT_MS);
    failed.fail(new Error("boom"));
    expect(lifecycle.signal.aborted).toBe(false);

    // The signal stays usable for the next attempt after two settlements.
    const next = createAttempt(3, lifecycle.signal, IDLE_TIMEOUT_MS);
    expect(next.signals.lifecycleSignal.aborted).toBe(false);
    expect(lifecycleListenerCount(lifecycle.signal)).toBe(1);
    next.retire();
  });
});

describe("RT-008: an attempt cannot rearm a watchdog it no longer needs", () => {
  it("ignores activity after retirement", () => {
    jest.useFakeTimers();
    const lifecycle = new AbortController();
    const attempt = createAttempt(1, lifecycle.signal, IDLE_TIMEOUT_MS);

    expect(jest.getTimerCount()).toBe(1);

    attempt.retire();

    expect(jest.getTimerCount()).toBe(0);

    attempt.signals.onActivity();

    expect(jest.getTimerCount()).toBe(0);
    expect(attempt.signals.connectionSignal.aborted).toBe(true);
  });

  it("ignores activity after the watchdog has already aborted the connection", () => {
    jest.useFakeTimers();
    const lifecycle = new AbortController();
    const attempt = createAttempt(1, lifecycle.signal, 20);

    expect(jest.getTimerCount()).toBe(1);

    // Let the watchdog fire. It aborts the CONNECTION only: the attempt stays
    // live until the stream reader reports the failure and a replacement is
    // scheduled.
    jest.advanceTimersByTime(20);

    expect(attempt.signals.connectionSignal.aborted).toBe(true);
    expect(attempt.retired).toBe(false);
    expect(jest.getTimerCount()).toBe(0);

    // A keepalive arriving in the window between the abort and the reader
    // noticing it must not arm a watchdog for a stream that is already dead.
    attempt.signals.onActivity();

    expect(jest.getTimerCount()).toBe(0);
    attempt.retire();
  });

  it("rearms from activity while the connection is alive", () => {
    jest.useFakeTimers();
    const lifecycle = new AbortController();
    const attempt = createAttempt(1, lifecycle.signal, IDLE_TIMEOUT_MS);

    expect(jest.getTimerCount()).toBe(1);

    // The positive direction: a live stream's activity does arm a new timer,
    // which is what proves the assertions above are not vacuously true.
    attempt.signals.onActivity();

    expect(jest.getTimerCount()).toBe(1);
    expect(attempt.signals.connectionSignal.aborted).toBe(false);

    attempt.retire();
  });
});

describe("RT-012: a waiter can let go of an attempt that is gone without turning it into a failure", () => {
  it("settles `superseded` when the attempt is retired", async () => {
    const lifecycle = new AbortController();
    const attempt = createAttempt(1, lifecycle.signal, IDLE_TIMEOUT_MS);

    attempt.retire();

    // This is the signal a readiness wait races against the load promise: a
    // superseded attempt's hydration may never finish, and a waiter must not be
    // pinned to work that nobody will complete.
    await expect(attempt.superseded).resolves.toBeUndefined();
  });

  it("keeps `superseded` unsettled on terminal failure, so the failure stays the answer", async () => {
    const lifecycle = new AbortController();
    const attempt = createAttempt(1, lifecycle.signal, IDLE_TIMEOUT_MS);

    attempt.fail(new Error("connection refused"));

    // A failure must reach the waiter as itself. If `fail()` settled this
    // signal, `awaitReady()` would treat a failed connect as a replacement and
    // retry silently instead of reporting what happened.
    const outcome = await Promise.race([
      attempt.superseded.then(() => "settled" as const),
      Promise.resolve("pending" as const),
    ]);

    expect(outcome).toBe("pending");
    expect(attempt.retired).toBe(true);

    // A teardown that arrives after the failure (the reconnect path retires the
    // failed attempt) must not settle it either.
    attempt.retire();
    expect(
      await Promise.race([
        attempt.superseded.then(() => "settled" as const),
        Promise.resolve("pending" as const),
      ]),
    ).toBe("pending");
  });
});
