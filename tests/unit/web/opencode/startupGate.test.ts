import { afterEach, describe, expect, it, jest } from "bun:test";
import {
  StartupTimeoutError,
  createStartupGate,
  withDeadline,
} from "@web/features/opencode/sync/startupGate.ts";

/**
 * RT-012: the deadline primitives, tested where they live.
 *
 * `withDeadline()` is the ONE bound applied to every leg of a readiness wait,
 * so its contract is worth asserting directly rather than only through the
 * controller: a deadline stops the WAITER, never the work, and a result that
 * arrives late is neither a timeout nor an unhandled rejection.
 *
 * `createStartupGate()` is the readiness promise itself. The invariant that
 * matters for RT-012 is that one caller's deadline cannot settle the gate or
 * strand another caller - otherwise a slow runtime would be reported dead.
 */

/** Observable without waiting a product timeout, wide enough not to be flaky. */
const TIMEOUT_MS = 20;

/** A deadline the tests never expect to reach. */
const REAL_TIMEOUT_MS = 2_000;

const realSetTimeout = globalThis.setTimeout;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

// Tests that use the fake clock restore the real one, even on failure.
afterEach(() => {
  jest.useRealTimers();
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("RT-012: withDeadline bounds a waiter, not the work", () => {
  it("resolves with the work's value when it settles first", async () => {
    await expect(withDeadline(Promise.resolve("ready"), REAL_TIMEOUT_MS)).resolves.toBe("ready");
  });

  it("propagates the work's own rejection", async () => {
    const error = new Error("the runtime failed");
    await expect(withDeadline(Promise.reject(error), REAL_TIMEOUT_MS)).rejects.toBe(error);
  });

  it("rejects with a typed timeout at its deadline", async () => {
    const startedAt = Date.now();
    const error = await withDeadline(new Promise(() => undefined), TIMEOUT_MS).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(StartupTimeoutError);
    if (error instanceof StartupTimeoutError) expect(error.timeoutMs).toBe(TIMEOUT_MS);
    expect(Date.now() - startedAt).toBeLessThan(REAL_TIMEOUT_MS);
  });

  it("ignores a fulfillment that arrives after the deadline", async () => {
    const work = deferred<string>();
    const outcome = withDeadline(work.promise, TIMEOUT_MS).then(
      () => "resolved",
      (reason: unknown) => reason,
    );

    await sleep(TIMEOUT_MS * 3);
    work.resolve("too late");

    expect(await outcome).toBeInstanceOf(StartupTimeoutError);
  });

  it("swallows a late rejection instead of reporting it as unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const work = deferred<string>();
      const outcome = await withDeadline(work.promise, TIMEOUT_MS).catch(
        (reason: unknown) => reason,
      );
      work.reject(new Error("the runtime failed after the caller gave up"));
      await sleep(20);

      expect(outcome).toBeInstanceOf(StartupTimeoutError);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("clears its deadline timer when the work settles first", async () => {
    jest.useFakeTimers();

    await expect(withDeadline(Promise.resolve("ready"), REAL_TIMEOUT_MS)).resolves.toBe("ready");

    // The work settled first, so the deadline timer must be gone rather than
    // left to fire into an already-settled promise.
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("RT-012: the startup gate owns readiness, not its waiters' patience", () => {
  it("has nothing pending, and a bounded wait on an unopened gate times out", async () => {
    const gate = createStartupGate();

    expect(gate.pending()).toBeNull();

    const error = await gate.waitWithDeadline(TIMEOUT_MS).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(StartupTimeoutError);
  });

  it("settles every waiter, and the gate's own promise, on resolve", async () => {
    const gate = createStartupGate();
    const opened = gate.open();
    expect(gate.pending()).toBe(opened);

    const first = gate.waitWithDeadline(REAL_TIMEOUT_MS);
    const second = gate.waitWithDeadline(REAL_TIMEOUT_MS);
    gate.resolve();

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    await expect(opened).resolves.toBeUndefined();
  });

  it("propagates a rejection to the gate's promise and to its waiters", async () => {
    const gate = createStartupGate();
    const opened = gate.open();
    const sighted = gate.waitWithDeadline(REAL_TIMEOUT_MS).catch((reason: unknown) => reason);
    const error = new Error("connection refused");

    gate.reject(error);

    await expect(opened).rejects.toBe(error);
    expect(await sighted).toBe(error);
  });

  it("does not surface an unhandled rejection when nobody awaits the opened promise", async () => {
    // `load()` and `awaitReady()` are separate entry points, so a caller may
    // only await the gate with a deadline. Rejecting the gate must not produce
    // an unhandled rejection for the promise nobody kept.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const gate = createStartupGate();
      gate.open();
      gate.reject(new Error("the runtime never came up"));
      await sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("lets one caller's deadline expire without settling the gate or stranding another", async () => {
    const gate = createStartupGate();
    gate.open();

    const impatient = gate.waitWithDeadline(TIMEOUT_MS).catch((reason: unknown) => reason);
    const patient = gate.waitWithDeadline(REAL_TIMEOUT_MS);

    expect(await impatient).toBeInstanceOf(StartupTimeoutError);

    // The gate is untouched: it still has its promise, and it still settles the
    // caller that is willing to wait. A timeout that settled the gate would
    // report a slow runtime as a dead one to everybody.
    expect(gate.pending()).not.toBeNull();
    gate.resolve();
    await expect(patient).resolves.toBeUndefined();
  });

  it("still settles a LATER waiter after an earlier one timed out", async () => {
    const gate = createStartupGate();
    gate.open();

    const timedOut = await gate.waitWithDeadline(TIMEOUT_MS).catch((reason: unknown) => reason);
    expect(timedOut).toBeInstanceOf(StartupTimeoutError);

    // The runtime came up after the first caller stopped watching: a new wait
    // on the same gate sees readiness, not the earlier timeout.
    const later = gate.waitWithDeadline(REAL_TIMEOUT_MS);
    gate.resolve();
    await expect(later).resolves.toBeUndefined();
  });
});
