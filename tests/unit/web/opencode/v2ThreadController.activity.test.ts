/**
 * The controller's ONE activity read per hydration.
 *
 * ## Why this file exists
 *
 * `session.active` answers a process-local question: does this OpenCode process
 * currently own a drain for the session? Asking it is useful; asking it at the
 * wrong time is worse than not asking, because a late answer would overwrite
 * newer event evidence with an older snapshot.
 *
 * The controller is therefore the owner of exactly two things here:
 *
 * 1. **when** the read starts (after `load_completed` and the hydration buffer
 *    drain, never before and never awaited), and
 * 2. **which revision** its response was captured at, so the reducer can
 *    discard it if an authoritative event landed while it was in flight.
 *
 * A reducer test cannot prove either, because both are ordering facts about the
 * controller. These cases drive the real controller through the shared harness
 * and replace only the backend read, which is the one thing the browser asks.
 */

import { describe, expect, it } from "bun:test";
import type { V2Event } from "@opencode/client";
import {
  createV2ThreadController,
  type V2ThreadController,
} from "@web/features/opencode/v2ThreadController.ts";
import type { V2ActivityState } from "@web/features/opencode/v2Types.ts";
import {
  SESSION_ID,
  createClient,
  createGeneration,
  deferred,
  waitForState,
} from "@web/testing/opencode/v2ThreadControllerHarness";

const CONVERSATION_ID = "conv_activity_test";

type ActivityCall = {
  readonly conversationId: string;
  readonly sessionId: string;
};

/** A fetcher that records each call and answers with `activity`. */
function activityFetcher(activity: V2ActivityState): {
  readonly calls: ActivityCall[];
  readonly fetch: (
    input: ActivityCall & { readonly signal: AbortSignal },
  ) => Promise<V2ActivityState>;
} {
  const calls: ActivityCall[] = [];
  return {
    calls,
    fetch: async (input) => {
      calls.push({ conversationId: input.conversationId, sessionId: input.sessionId });
      return activity;
    },
  };
}

function mount(
  fetchActivity: (input: {
    readonly conversationId: string;
    readonly sessionId: string;
    readonly signal: AbortSignal;
  }) => Promise<V2ActivityState>,
) {
  const controller: V2ThreadController = createV2ThreadController(
    createClient([createGeneration(1)]),
    undefined,
    { conversationId: CONVERSATION_ID, fetchActivity },
  );
  return controller;
}

describe("the activity read is asked once, after hydration, and never awaited", () => {
  it("asks for the conversation/session pair and applies the answer", async () => {
    const fetcher = activityFetcher("running");
    const controller = mount(fetcher.fetch);

    try {
      await controller.awaitReady();
      await waitForState(controller, (state) => state.activity === "running");

      expect(fetcher.calls).toEqual([{ conversationId: CONVERSATION_ID, sessionId: SESSION_ID }]);
      expect(controller.getState().load).toEqual({ type: "ready" });
    } finally {
      controller.dispose();
    }
  });

  it("starts only after load_completed: the load is already ready at call time", async () => {
    let loadAtCall: unknown = null;
    let controller: V2ThreadController | null = null;
    const fetchActivity = async (): Promise<V2ActivityState> => {
      loadAtCall = controller?.getState().load;
      return "not-running";
    };
    controller = mount(fetchActivity);

    try {
      await controller.awaitReady();
      await waitForState(controller, (state) => state.activity === "not-running");

      expect(loadAtCall).toEqual({ type: "ready" });
    } finally {
      controller.dispose();
    }
  });

  it("does not delay readiness when the read never answers", async () => {
    const pending = deferred<V2ActivityState>();
    const controller = mount(() => pending.promise);

    try {
      // Resolves although the activity request is still outstanding.
      await controller.awaitReady();
      expect(controller.getState().load).toEqual({ type: "ready" });
      expect(controller.getState().activity).toBe("unknown");
    } finally {
      controller.dispose();
    }
  });

  it("settles to unknown when the read fails, and never throws into hydration", async () => {
    const controller = mount(() => Promise.reject(new Error("activity read failed")));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      await controller.awaitReady();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(controller.getState().load).toEqual({ type: "ready" });
      expect(controller.getState().activity).toBe("unknown");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      controller.dispose();
    }
  });

  it("issues exactly one read per hydration, and a refresh issues none", async () => {
    const fetcher = activityFetcher("not-running");
    const controller = mount(fetcher.fetch);

    try {
      await controller.awaitReady();
      await waitForState(controller, (state) => state.activity === "not-running");
      expect(fetcher.calls).toHaveLength(1);

      await controller.refresh();
      expect(fetcher.calls).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  it("does not read at all when no conversation owns the session", async () => {
    const controller = createV2ThreadController(createClient([createGeneration(1)]));

    try {
      await controller.awaitReady();
      expect(controller.getState().activity).toBe("unknown");
    } finally {
      controller.dispose();
    }
  });
});

describe("a late activity answer cannot overwrite newer event evidence", () => {
  /** A `session.status busy` event, which is authoritative running evidence. */
  function busyEvent(): V2Event {
    return {
      id: "evt_status_busy_during_read",
      created: 40,
      type: "session.status",
      data: { sessionID: SESSION_ID, status: { type: "busy" } },
    };
  }

  it("discards a response captured before a live status landed", async () => {
    const pending = deferred<V2ActivityState>();
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]), undefined, {
      conversationId: CONVERSATION_ID,
      fetchActivity: () => pending.promise,
    });

    try {
      await controller.awaitReady();
      // The read is in flight. A live status proves the drain is running and
      // bumps the activity revision.
      generation.events.emit(busyEvent());
      await waitForState(controller, (state) => state.activity === "running");

      // The older read now answers "not running". It must be dropped, or the
      // chip would contradict an event the server just sent.
      pending.resolve("not-running");
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(controller.getState().activity).toBe("running");
    } finally {
      controller.dispose();
    }
  });

  it("applies the same answer when no event intervened", async () => {
    const pending = deferred<V2ActivityState>();
    const controller = mount(() => pending.promise);

    try {
      await controller.awaitReady();
      pending.resolve("not-running");
      await waitForState(controller, (state) => state.activity === "not-running");
    } finally {
      controller.dispose();
    }
  });

  it("drops an answer for an attempt that no longer owns the runtime", async () => {
    const pending = deferred<V2ActivityState>();
    const controller = mount(() => pending.promise);

    await controller.awaitReady();
    // The attempt is retired: a disposed controller must not adopt the answer.
    controller.dispose();
    pending.resolve("running");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(controller.getState().activity).toBe("unknown");
  });
});
