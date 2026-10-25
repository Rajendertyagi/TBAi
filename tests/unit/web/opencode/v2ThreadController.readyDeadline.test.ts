import { describe, expect, it } from "bun:test";
import type { SessionInfo } from "@opencode/client";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import {
  SESSION,
  createClient,
  createGeneration,
  deferred,
  waitForState,
} from "@web/testing/opencode/v2ThreadControllerHarness";

/**
 * RT-012: the readiness wait is bounded END TO END.
 *
 * The budget used to cover only the final gate wait. `awaitReady()` awaited
 * `ensureLoaded()` - the connection plus the whole hydration, including the
 * history read - with no deadline, so a slow server made the bound describe
 * "the last instant of the wait" rather than the wait. These tests pin both
 * halves of the contract:
 *
 * - slow hydration cannot keep the caller past the deadline, and
 * - the deadline stops the CALLER only. The attempt keeps hydrating and its
 *   gate is left unsettled, so the runtime is not declared dead by a timeout
 *   and a later wait still sees it come up.
 */

/** Small enough that the deadline is observable without waiting out a product timeout. */
const READY_TIMEOUT_MS = 25;

/** How long the fake hydration takes: clearly past the deadline, clearly finite. */
const SLOW_HYDRATION_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("RT-012: awaitReady is bounded end to end", () => {
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
});
