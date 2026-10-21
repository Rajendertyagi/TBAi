import { describe, expect, test } from "bun:test";
import type { SessionMessagesResponse, V2Event } from "@opencode/client";
import { AttemptSupersededError, createAttempt } from "@web/features/opencode/sync/attempt.ts";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import {
  EVENT_INBOX_ID,
  LIVE_ASSISTANT_MESSAGE_ID,
  LOCAL_MESSAGE_ID,
  PERMISSION,
  SESSION_ID,
  USER_MESSAGE,
  createClient,
  createGeneration,
  deferred,
  inboxEvent,
  waitForState,
} from "@web/testing/opencode/v2ThreadControllerHarness";

/**
 * DEFECT REGRESSION — quarantined, and promoted as findings are fixed.
 *
 * ## WHY A TEST HERE IS USUALLY `test.todo`
 *
 * Each one asserts the behaviour a finding says the product **should** have.
 * Against the code of the day they fail — that failure is the point — so an
 * unresolved finding's entry is committed as `test.todo`, which means:
 *
 * - an ordinary `bun run test` **executes no todo body**, so an unresolved
 *   finding can never break the build;
 * - `bun test --todo` **executes** it, which is how the defect is
 *   demonstrated and how the failure is captured.
 *
 * The plan's rule is that the evidence for a finding is the **printed
 * assertion-error block** — the test name, `file:line`, `Expected:` and
 * `Received:` — and never an exit code. A quarantine of only failing todos
 * exits `0` in both modes, so an exit code could never show that a defect
 * was demonstrated.
 *
 * ## WHY SOME ENTRIES ARE PLAIN `test`
 *
 * An entry whose finding has been fixed is promoted: it stops being a
 * demonstration of a defect and becomes a regression test that must keep
 * passing. `R-M1`, `R-M2`, `R-M4` and `R-L4` are in that state; the ones still
 * marked `test.todo` are findings that are still open. The guard distinguishes
 * the two, so a todo that starts passing is reported rather than ignored.
 *
 * ## HOW THESE LEAVE THE QUARANTINE
 *
 * When a finding is fixed, its todo is promoted to a `test`, the baseline
 * test that pinned the broken behaviour is deleted **in the same commit**,
 * and the guard (`scripts/check-opencode-quarantine.ts`) stops reporting it.
 * A todo whose body has started passing is reported by bun as a failure —
 * that is the signal that the finding is ready to be converted.
 *
 * ## NAMING
 *
 * `R-<finding id> <what the correct behaviour is>`. The finding id is the
 * contract: it appears in the plan's invariant matrix, and the guard's output
 * names it.
 */

const EMPTY_PAGE: SessionMessagesResponse = { data: [], cursor: {} };

/**
 * A delta the assistant streamed while the runtime was still hydrating.
 *
 * `sessionID` is present because the real V2 event carries it, and the
 * reducer's session filter reads it: an event without one BYPASSES the filter
 * instead of passing it, so omitting it would make the test exercise a shape
 * the server never sends.
 */
function hydrationTimeDelta(id: string, delta: string): V2Event {
  return {
    id,
    created: 10,
    type: "session.text.delta",
    data: {
      sessionID: SESSION_ID,
      assistantMessageID: LIVE_ASSISTANT_MESSAGE_ID,
      ordinal: 0,
      delta,
    },
  };
}

describe("OpenCode V2 defect regression (quarantined)", () => {
  test.todo("R-H2: an assistant delta received during hydration survives the hydration", async () => {
    const history = deferred<SessionMessagesResponse>();
    const generation = createGeneration(1, { historyList: () => history.promise });
    const client = createClient([generation]);
    const controller = createV2ThreadController(client);
    try {
      void controller.load().catch(() => undefined);
      await waitForState(controller, (state) => state.load.type === "loading");

      generation.events.emit(hydrationTimeDelta("evt_h2_delta", "streamed during hydration"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      history.resolve(EMPTY_PAGE);
      await waitForState(controller, (state) => state.load.type === "ready");
      await new Promise((resolve) => setTimeout(resolve, 0));

      // CORRECT: the delta the user saw is still in the transcript.
      const message = controller.getState().messages[LIVE_ASSISTANT_MESSAGE_ID];
      expect(message).toBeDefined();
      const text = (message?.parts ?? [])
        .map((part) => (part.kind === "text" ? part.value : ""))
        .join("");
      expect(text).toContain("streamed during hydration");
    } finally {
      controller.dispose();
    }
  });

  test("R-M1: the reconnect ceiling is reached when the stream dies during hydration", async () => {
    const generations = Array.from({ length: 8 }, (_unused, index) =>
      createGeneration(index + 1, {
        inboxList: (_input, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      }),
    );
    const client = createClient(generations);
    const controller = createV2ThreadController(client, {
      maxReconnectAttempts: 3,
      initialReconnectDelayMs: 10,
      maxReconnectDelayMs: 10,
    });
    try {
      void controller.load().catch(() => undefined);

      for (let cycle = 0; cycle < 6; cycle += 1) {
        if (controller.getState().connection.type === "failed") break;
        await waitForState(controller, (state) => state.load.type === "loading");
        const live = generations[(client.connectCount - 1) % generations.length];
        live?.events.fail(new Error("stream died during hydration"));
        await waitForState(
          controller,
          (state) => state.connection.type === "reconnecting" || state.connection.type === "failed",
        );
        await new Promise((r) => setTimeout(r, 60));
      }

      // CORRECT: the budget is a ceiling, and the terminal state is reached.
      expect(controller.getState().connection).toEqual({ type: "failed", attempt: 3 });
      expect(client.connectCount).toBe(4);
    } finally {
      controller.dispose();
    }
  });

  test("R-M2: a superseded attempt's late failure does not touch the live state", async () => {
    const history = deferred<SessionMessagesResponse>();
    const liveHistory = deferred<SessionMessagesResponse>();
    const generations = [
      createGeneration(1, { historyList: () => history.promise }),
      createGeneration(2, { historyList: () => liveHistory.promise }),
      createGeneration(3),
    ];
    const client = createClient(generations);
    const controller = createV2ThreadController(client, {
      maxReconnectAttempts: 10,
      initialReconnectDelayMs: 50,
    });
    try {
      void controller.load().catch(() => undefined);
      await waitForState(controller, (state) => state.load.type === "loading");

      generations[0]?.events.fail(new Error("stream died during hydration"));
      await waitForState(controller, (state) => state.connection.type === "reconnecting");

      // A manual takeover: the second attempt connects and starts hydrating.
      void controller.load().catch(() => undefined);
      await waitForState(controller, (state) => state.load.type === "loading");
      expect(client.connectCount).toBe(2);

      // A second manual load while that attempt is in flight must JOIN it, not
      // start a third connection: the attempt owns the load slot, so the
      // promise a retry or a manual call started is not invisible to the next
      // caller.
      void controller.load().catch(() => undefined);
      expect(client.connectCount).toBe(2);

      liveHistory.resolve(EMPTY_PAGE);
      await waitForState(controller, (state) => state.load.type === "ready");

      history.resolve(EMPTY_PAGE);
      await new Promise((r) => setTimeout(r, 50));

      // CORRECT: the live attempt is untouched by the dead one.
      expect(controller.getState().load.type).toBe("ready");
      expect(controller.getState().connection.type).toBe("connected");

      // And the healthy attempt's load promise was not dropped.
      await controller.awaitReady();
      expect(client.connectCount).toBe(2);
    } finally {
      controller.dispose();
    }
  });

  test("R-M4: a failed history read leaves a defined state, and later events are applied", async () => {
    const generation = createGeneration(1, {
      historyList: async () => {
        throw new Error("history read failed");
      },
    });
    const client = createClient([generation]);
    // Budget 0: the failure must reach the DEFINED terminal state rather than
    // a controller that is loaded-but-not-loading forever. A budget of 1 is
    // covered by R-M1's reconnect path.
    const controller = createV2ThreadController(client, {
      maxReconnectAttempts: 0,
      initialReconnectDelayMs: 10,
    });
    try {
      void controller.load().catch(() => undefined);
      await waitForState(controller, (state) => state.load.type === "error");

      // The failure is classified, not half-applied: a controller that reports
      // `load: error` while still claiming `connection: connected` is the
      // half-initialised state this finding is about.
      expect(controller.getState().connection.type).toBe("failed");

      // And the transcript is not stranded behind a hydration that will never
      // happen: a delta arriving now is applied.
      generation.events.emit(hydrationTimeDelta("evt_m4_delta", "after the failed history read"));
      await waitForState(
        controller,
        (state) => state.messages[LIVE_ASSISTANT_MESSAGE_ID] !== undefined,
      );
      const message = controller.getState().messages[LIVE_ASSISTANT_MESSAGE_ID];
      const text = (message?.parts ?? [])
        .map((part) => (part.kind === "text" ? part.value : ""))
        .join("");
      expect(text).toContain("after the failed history read");
    } finally {
      controller.dispose();
    }
  });

  test("R-L4: a superseded attempt cannot resolve a readiness promise", async () => {
    const lifecycle = new AbortController();
    const stale = createAttempt(1, lifecycle.signal);
    const live = createAttempt(2, lifecycle.signal);

    stale.beginHydration();
    stale.retire();
    // A late hydration return is the case the defect is about: it used to
    // resolve whichever gate was current, which was the NEWER attempt's.
    stale.markReady();

    await expect(stale.gate.pending()).rejects.toBeInstanceOf(AttemptSupersededError);
    // The dead attempt cannot leave the transcript buffering either.
    expect(stale.hydrating).toBe(false);

    // The live attempt's own outcome is the only thing that settles readiness.
    live.markReady();
    await expect(live.gate.pending()).resolves.toBeUndefined();
  });

  test.todo("R-M3: an ambiguous prompt reaches a typed, bounded outcome", async () => {
    const generation = createGeneration(1);
    const client = createClient([generation]);
    const controller = createV2ThreadController(client);
    await controller.awaitReady();
    try {
      generation.setPromptHandler(async () => {
        const error = new Error("upstream 503") as Error & { status?: number };
        error.status = 503;
        throw error;
      });

      let settled = false;
      const sending = controller.sendMessage(USER_MESSAGE, { messageId: LOCAL_MESSAGE_ID }).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));

      // CORRECT: the caller learns the outcome instead of hanging.
      expect(settled).toBe(true);
      await sending;
    } finally {
      controller.dispose();
    }
  });

  test.todo("R-M6: two concurrent replies for one permission produce one transport call", async () => {
    const generation = createGeneration(1, {
      permissionList: async () => [PERMISSION],
      permissionReply: async () => {
        await new Promise((r) => setTimeout(r, 20));
      },
    });
    const client = createClient([generation]);
    const controller = createV2ThreadController(client);
    try {
      await controller.awaitReady();
      await waitForState(controller, (state) => state.permissions.length === 1);

      const first = controller.replyToPermission(PERMISSION.id, "once");
      await new Promise((r) => setTimeout(r, 5));
      const second = controller.replyToPermission(PERMISSION.id, "once");
      await Promise.allSettled([first, second]);

      // CORRECT: the request is claimed before the transport call.
      expect(generation.permissionReplyInputs).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  test.todo("R-M7: a cancel requested before admission is honoured once after admission", async () => {
    const prompt = deferred<{
      id: string;
      sessionID: string;
      time: { created: number };
      type: "user";
      payload: { text: string };
      delivery: "steer";
    }>();
    const generation = createGeneration(1);
    generation.setPromptHandler(async () => await prompt.promise);
    const client = createClient([generation]);
    const controller = createV2ThreadController(client);
    await controller.awaitReady();
    try {
      void controller.sendMessage(USER_MESSAGE, { messageId: LOCAL_MESSAGE_ID });
      await new Promise((r) => setTimeout(r, 10));

      // The user cancels while the prompt request is still in flight.
      await controller.cancel();

      // The prompt is admitted after the cancel.
      generation.events.emit(inboxEvent(EVENT_INBOX_ID, LOCAL_MESSAGE_ID, "steer"));
      await waitForState(controller, (state) => state.execution.type === "admitted");
      await new Promise((r) => setTimeout(r, 20));

      // CORRECT: the pending cancel is honoured exactly once, against the
      // admitted inbox id.
      expect(generation.inboxCancelInputs).toHaveLength(1);
      expect(generation.inboxCancelInputs[0]?.inboxID).toBe(EVENT_INBOX_ID);
    } finally {
      controller.dispose();
    }
  });

  test.todo("R-M10: a failed auxiliary read leaves the live permission untouched", async () => {
    let call = 0;
    const generation = createGeneration(1, {
      permissionList: async () => {
        call += 1;
        if (call === 1) return [PERMISSION];
        throw new Error("permission list unavailable (503)");
      },
    });
    const client = createClient([generation]);
    const controller = createV2ThreadController(client);
    try {
      await controller.awaitReady();
      expect(controller.getState().permissions).toEqual([PERMISSION]);

      await controller.resyncAuxiliary();
      await new Promise((r) => setTimeout(r, 10));

      // CORRECT: an unavailable read is not an authoritative empty list.
      expect(controller.getState().permissions).toEqual([PERMISSION]);
    } finally {
      controller.dispose();
    }
  });
});
