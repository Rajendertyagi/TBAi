import { afterEach, describe, expect, it, jest } from "bun:test";
import type { SessionInfo } from "@opencode/client";
import {
  V2ControllerError,
  createV2ThreadController,
} from "@web/features/opencode/v2ThreadController.ts";
import {
  SESSION,
  createClient,
  createGeneration,
  deferred,
  waitForState,
} from "@web/testing/opencode/v2ThreadControllerHarness";

/**
 * RT-012: the readiness wait is ONE absolute deadline, END TO END.
 *
 * The budget used to cover only the final gate wait. `awaitReady()` awaited
 * `ensureLoaded()` - the connection plus the whole hydration, including the
 * history read - with no deadline, so a slow server made the bound describe
 * "the last instant of the wait" rather than the wait.
 *
 * These tests pin the whole contract:
 *
 * - hydration completing inside the budget makes readiness succeed,
 * - hydration past the budget cannot keep the caller, and the runtime still
 *   comes up afterwards,
 * - a replacement attempt spends what is LEFT of the original budget, so
 *   repeated supersessions cannot extend the wait,
 * - a real failure settles the wait as ITSELF even while hydration is stalled,
 *   and only a failure that still has retry budget is a replacement to follow,
 * - disposal is not a timeout: the waiter ends immediately with the typed
 *   `aborted` failure, and leaves nothing running behind it.
 *
 * The clock is injectable (`nowMs`) so "the remaining budget" can be spent
 * without waiting it out in real time. The waits themselves stay real, so the
 * tests exercise `withDeadline`'s actual timer rather than a reimplementation.
 * Where a test proves the budget is ALREADY spent, the timeout comes from the
 * arithmetic alone - no timer runs, and no elapsed time is measured.
 */

/** Small enough that the deadline is observable without waiting out a product timeout. */
const READY_TIMEOUT_MS = 25;

/** How long the fake hydration takes: clearly past the deadline, clearly finite. */
const SLOW_HYDRATION_MS = 150;

/** A budget large enough that the tests below never reach it by accident. */
const GENEROUS_TIMEOUT_MS = 5_000;

/** A deadline used when the test only needs a bound that stays out of the way. */
const REAL_TIMEOUT_MS = 2_000;

const realSetTimeout = globalThis.setTimeout;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

// The disposal test uses the fake clock; restore the real one even on failure.
afterEach(() => {
  jest.useRealTimers();
});

/** Resolves to the rejection reason, so a test can assert on the failure type. */
function failure(promise: Promise<unknown>): Promise<Error | null> {
  return promise.then(
    () => null,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
}

describe("RT-012: awaitReady is bounded end to end", () => {
  it("resolves normally when hydration completes inside the deadline", async () => {
    const controller = createV2ThreadController(createClient([createGeneration(1)]), {
      readyTimeoutMs: REAL_TIMEOUT_MS,
    });

    try {
      await expect(controller.awaitReady()).resolves.toBeUndefined();
      expect(controller.getState().load.type).toBe("ready");
      expect(controller.getState().connection.type).toBe("connected");
    } finally {
      controller.dispose();
    }
  });

  it("stops waiting at its deadline while hydration is in flight, then still reports the runtime ready", async () => {
    const session = deferred<SessionInfo>();
    const generation = createGeneration(1, {
      sessionGet: () => session.promise,
    });
    const controller = createV2ThreadController(createClient([generation]), {
      readyTimeoutMs: READY_TIMEOUT_MS,
    });

    try {
      const startedAt = Date.now();
      const outcome = await controller
        .awaitReady()
        .then(() => null)
        .catch((error: Error) => error);
      const elapsed = Date.now() - startedAt;

      // The wait ended at its own deadline, not when hydration happened to
      // finish. Before the fix this resolved successfully at ~SLOW_HYDRATION_MS.
      expect(outcome?.message).toContain(`not ready within ${READY_TIMEOUT_MS}ms`);
      expect(elapsed).toBeLessThan(SLOW_HYDRATION_MS);

      // The deadline stopped the WAITER, not the runtime: hydration is still
      // in flight and nothing has been reported as a load failure.
      expect(controller.getState().load.type).toBe("loading");

      // Give hydration the time the timed-out waiter refused to spend.
      session.resolve(SESSION);
      await waitForState(controller, (state) => state.load.type === "ready");

      // A later wait finds the runtime ready. If the timeout had settled the
      // gate (retire/fail), this would reject with the attempt's error instead.
      await controller.awaitReady();
      expect(controller.getState().connection.type).toBe("connected");
    } finally {
      controller.dispose();
    }
  });

  it("does not settle the attempt's own load promise when a waiter times out", async () => {
    // The timeout is one caller's answer, not a property of the runtime. The
    // attempt's load (and the readiness gate inside it) must stay unsettled,
    // or a second caller would inherit a failure the runtime never had.
    const session = deferred<SessionInfo>();
    const generation = createGeneration(1, {
      sessionGet: () => session.promise,
    });
    const controller = createV2ThreadController(createClient([generation]), {
      readyTimeoutMs: READY_TIMEOUT_MS,
    });

    try {
      const load = controller.load();
      let loadSettled = false;
      void load.then(
        () => {
          loadSettled = true;
        },
        () => {
          loadSettled = true;
        },
      );

      await expect(controller.awaitReady()).rejects.toThrow(
        `not ready within ${READY_TIMEOUT_MS}ms`,
      );
      await sleep(READY_TIMEOUT_MS);

      // Still in flight: the timed-out waiter settled only itself. Had it
      // rejected the gate, this promise would already have settled too.
      expect(loadSettled).toBe(false);
      expect(controller.getState().load.type).toBe("loading");
      expect(controller.getState().connection.type).not.toBe("failed");

      session.resolve(SESSION);
      await load;
      expect(controller.getState().load.type).toBe("ready");
    } finally {
      controller.dispose();
    }
  });

  it("follows the attempt that replaced the one it was waiting on", async () => {
    const firstSession = deferred<SessionInfo>();
    const client = createClient([
      createGeneration(1, { sessionGet: () => firstSession.promise }),
      // The replacement hydrates normally.
      createGeneration(2),
    ]);
    let now = 0;
    const controller = createV2ThreadController(client, {
      readyTimeoutMs: GENEROUS_TIMEOUT_MS,
      nowMs: () => now,
    });

    try {
      const firstConnect = client.waitForConnect(1);
      const waiting = controller.awaitReady();
      await firstConnect;

      // Two seconds of the generous budget are spent, then the attempt is
      // replaced. The waiter must follow the replacement rather than report
      // supersession as a failure.
      const secondConnect = client.waitForConnect(2);
      now = GENEROUS_TIMEOUT_MS / 2;
      void controller.retry().catch(() => undefined);

      await expect(waiting).resolves.toBeUndefined();
      await secondConnect;
      expect(client.connectCount).toBe(2);
      expect(controller.getState().load.type).toBe("ready");
      expect(controller.getState().connection.type).toBe("connected");
    } finally {
      controller.dispose();
    }
  });

  it("reports a terminal stream failure while hydration is unresolved instead of following a replacement", async () => {
    // A real transport failure must reject the per-attempt load with ITSELF,
    // even though the history read that hydration is waiting on never settles.
    // The budget is 0 retries, so no replacement exists to follow: the waiter
    // has to report the failure, and it must do so without spending the
    // deadline (which is virtual here and never advanced).
    jest.useFakeTimers();
    const session = deferred<SessionInfo>();
    const generation = createGeneration(1, { sessionGet: () => session.promise });
    const client = createClient([generation]);
    const controller = createV2ThreadController(client, {
      readyTimeoutMs: GENEROUS_TIMEOUT_MS,
      maxReconnectAttempts: 0,
    });

    try {
      let outcome: Error | null | undefined;
      const firstConnect = client.waitForConnect(1);
      // Registered BEFORE the controller starts: `waitForCalls` only observes
      // reads that happen after it asks, exactly like `waitForConnect`.
      const firstRead = generation.events.waitForCalls(1);
      const waiting = failure(controller.awaitReady()).then((error) => {
        outcome = error;
      });
      await firstConnect;
      await firstRead;

      // The stream dies mid-hydration: the history read is still pending, so
      // the attempt's own load promise cannot settle through hydration.
      generation.events.fail(new TypeError("fetch failed"));

      // Drain promise reactions only. No deadline timer is advanced: under the
      // supersession sentinel this waiter would still be pending here, and the
      // assertion below would fail instead of waiting out the test timeout.
      for (let turn = 0; turn < 50 && outcome === undefined; turn += 1) {
        await Promise.resolve();
      }

      expect(outcome).toBeInstanceOf(V2ControllerError);
      if (outcome instanceof V2ControllerError) {
        expect(outcome.safe.kind).toBe("network");
        expect(outcome.message).toContain("event stream failed");
      }
      // A terminal failure has no replacement: the connect count stays 1, the
      // state says failed, and no retry or watchdog timer is left behind.
      expect(client.connectCount).toBe(1);
      expect(controller.getState().load.type).toBe("error");
      expect(controller.getState().connection.type).toBe("failed");
      expect(jest.getTimerCount()).toBe(0);
      await waiting;

      // The stalled hydration is now allowed to fail. The attempt is already
      // retired, so this late rejection is not the waiter's answer - it must be
      // absorbed by the (already settled) load race, never surface unhandled.
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      jest.useRealTimers();
      process.on("unhandledRejection", onUnhandled);
      try {
        session.reject(new Error("history read failed after the stream died"));
        await sleep(0);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    } finally {
      controller.dispose();
    }
  });

  it("follows the replacement a recoverable stream failure schedules, and cancels its timer", async () => {
    // The other half of the contract: a failure that still has budget is a
    // RECONNECT, not a per-attempt verdict. The waiter continues on the attempt
    // that replaces the dead one, and the pipeline's scheduled retry must not
    // later open a third connection on top of it.
    jest.useFakeTimers();
    const session = deferred<SessionInfo>();
    const deadStream = createGeneration(1, { sessionGet: () => session.promise });
    const client = createClient([deadStream, createGeneration(2)]);
    const controller = createV2ThreadController(client, {
      readyTimeoutMs: GENEROUS_TIMEOUT_MS,
      maxReconnectAttempts: 1,
    });

    try {
      const firstConnect = client.waitForConnect(1);
      const secondConnect = client.waitForConnect(2);
      const firstRead = deadStream.events.waitForCalls(1);
      const waiting = controller.awaitReady();
      await firstConnect;
      await firstRead;
      deadStream.events.fail(new TypeError("fetch failed"));

      await expect(waiting).resolves.toBeUndefined();
      await secondConnect;
      expect(client.connectCount).toBe(2);
      expect(controller.getState().load.type).toBe("ready");
      expect(controller.getState().connection.type).toBe("connected");

      // Well past the longest reconnect delay: if the waiter had left the
      // scheduled retry armed, it would open a third connection here.
      jest.advanceTimersByTime(15_000);
      expect(client.connectCount).toBe(2);
    } finally {
      controller.dispose();
    }
  });

  it("does not restart the deadline when replacements keep arriving", async () => {
    // The budget is spent entirely through the injected clock, and the LAST
    // replacement arrives after the original deadline has already passed. A
    // deadline restarted per attempt would read a fresh 600 ms at that point and
    // wait for it; the shared deadline has nothing left, so the waiter must
    // report the timeout from the arithmetic alone - no clock advances, no timer
    // fires, and nothing is measured in wall-clock time.
    const sessions = [
      deferred<SessionInfo>(),
      deferred<SessionInfo>(),
      deferred<SessionInfo>(),
      deferred<SessionInfo>(),
    ];
    const client = createClient(
      sessions.map((session, index) =>
        createGeneration(index + 1, { sessionGet: () => session.promise }),
      ),
    );
    let now = 0;
    const controller = createV2ThreadController(client, {
      readyTimeoutMs: 600,
      nowMs: () => now,
    });

    try {
      // `undefined` means the waiter had not settled yet.
      let outcome: Error | null | undefined;
      const firstConnect = client.waitForConnect(1);
      const waiting = failure(controller.awaitReady()).then((error) => {
        outcome = error;
      });
      await firstConnect;

      // 200 of the 600 spent, then replaced.
      const secondConnect = client.waitForConnect(2);
      now = 200;
      void controller.retry().catch(() => undefined);
      await secondConnect;

      // 500 spent, replaced again: 100 ms of the ORIGINAL budget remain.
      const thirdConnect = client.waitForConnect(3);
      now = 500;
      void controller.retry().catch(() => undefined);
      await thirdConnect;

      // 700 spent - past the deadline - then replaced once more. A per-attempt
      // deadline would grant a fresh 600 ms here and keep the caller waiting.
      const fourthConnect = client.waitForConnect(4);
      now = 700;
      void controller.retry().catch(() => undefined);
      await fourthConnect;

      // An event-loop turn, not a delay: the timeout is decided by the clock
      // arithmetic, so only pending promise work has to finish here. If the
      // deadline had restarted, this turn would still find the waiter pending.
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(outcome).toBeDefined();
      expect(outcome).toBeInstanceOf(Error);
      if (outcome instanceof Error) {
        expect(outcome.message).toContain("not ready within 600ms");
      }
      expect(client.connectCount).toBe(4);
      expect(controller.getState().load.type).not.toBe("ready");
      await waiting;
    } finally {
      controller.dispose();
    }
  });

  it("reports disposal with a typed aborted result, no ready state and no leaked timer", async () => {
    // Fake the clock: the deadline must NOT be what ends this wait, so the test
    // must be able to await the rejection without any timer being allowed to
    // fire. Under the previous behaviour this await would never settle.
    jest.useFakeTimers();

    const session = deferred<SessionInfo>();
    const controller = createV2ThreadController(
      createClient([createGeneration(1, { sessionGet: () => session.promise })]),
      {
        readyTimeoutMs: GENEROUS_TIMEOUT_MS * 6,
        // Far beyond the test: the watchdog must not be what ends this wait.
        streamIdleTimeoutMs: GENEROUS_TIMEOUT_MS * 12,
      },
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const waiting = failure(controller.awaitReady());
      await waitForState(controller, (state) => state.load.type === "loading");

      controller.dispose();
      const outcome = await waiting;

      expect(outcome).toBeInstanceOf(V2ControllerError);
      if (outcome instanceof V2ControllerError) expect(outcome.safe.kind).toBe("aborted");
      expect(controller.getState().load.type).not.toBe("ready");

      // A leaked deadline (or watchdog) would still be scheduled after the
      // runtime is gone, and would outlive it by the whole budget.
      expect(jest.getTimerCount()).toBe(0);

      // The fake clock also owns the timer queue, so the real one has to be back
      // before waiting for the unhandled-rejection check to settle.
      jest.useRealTimers();
      await sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      controller.dispose();
      jest.useRealTimers();
    }
  });
});
