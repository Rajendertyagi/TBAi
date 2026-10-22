import { describe, expect, it, test } from "bun:test";
import type { SessionMessagesResponse, V2Event } from "@opencode/client";
import { AttemptSupersededError, createAttempt } from "@web/features/opencode/sync/attempt.ts";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import {
  ASSISTANT_TOOL_MESSAGE,
  EVENT_INBOX_ID,
  FORM_REPLY,
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
 * passing. `R-M1`, `R-M2`, `R-M4`, `R-M4b`, `R-M4c` and `R-L4` are in that
 * state; the ones still marked `test.todo` are findings that are still open.
 * The guard distinguishes the two, so a todo that starts passing is reported
 * rather than ignored.
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
  test("R-H2: an assistant delta received during hydration survives the hydration", async () => {
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

      // And a spent ceiling is not a suggestion: an incidental readiness wait
      // after it reports the failure instead of starting a fifth attempt.
      await expect(controller.awaitReady()).rejects.toThrow("stream died during hydration");
      await new Promise((r) => setTimeout(r, 60));
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

  test("R-M4: a failed history read recovers within the retry budget", async () => {
    const failing = createGeneration(1, {
      historyList: async () => {
        throw new Error("history read failed");
      },
    });
    const recovered = createGeneration(2);
    const client = createClient([failing, recovered]);
    const controller = createV2ThreadController(client, {
      maxReconnectAttempts: 1,
      initialReconnectDelayMs: 10,
      maxReconnectDelayMs: 10,
    });
    try {
      void controller.load().catch(() => undefined);

      // CORRECT: a failed history read is a connection failure, so it reaches a
      // DEFINED state - here, recovery on the next attempt - rather than a
      // controller that is loaded-but-not-loading behind a hydration flag that
      // stays set forever.
      await waitForState(controller, (state) => state.load.type === "ready");
      expect(client.connectCount).toBe(2);
      expect(controller.getState().connection.type).toBe("connected");
    } finally {
      controller.dispose();
    }
  });

  test("R-M4b: a terminally failed attempt commits nothing afterwards", async () => {
    const history = deferred<SessionMessagesResponse>();
    const failing = createGeneration(1, { historyList: () => history.promise });
    const recovered = createGeneration(2);
    const client = createClient([failing, recovered]);
    // Budget 0: a stream failure during hydration is terminal on the first
    // attempt.
    const controller = createV2ThreadController(client, {
      maxReconnectAttempts: 0,
      initialReconnectDelayMs: 10,
    });
    try {
      void controller.load().catch(() => undefined);
      await waitForState(controller, (state) => state.load.type === "loading");

      failing.events.fail(new Error("stream died during hydration"));
      await waitForState(controller, (state) => state.load.type === "error");

      // The failure is classified, not half-applied: a controller that reports
      // `load: error` while still claiming `connection: connected` is the
      // half-initialised state this finding is about.
      expect(controller.getState().connection).toEqual({ type: "failed", attempt: 0 });

      // The attempt's stream is torn down with it, so no later event can even
      // be delivered to a failed attempt.
      expect(failing.events.closeCount).toBe(1);

      // Explicit manual recovery: the automatic budget is spent, and a person
      // asking again still gets a fresh attempt. The exhausted attempt is
      // replaced, never revived.
      await controller.retry();
      await waitForState(controller, (state) => state.load.type === "ready");
      expect(client.connectCount).toBe(2);
      const recoveredState = controller.getState();

      // CORRECT: terminal failure settled the attempt, so the hydration
      // continuation it left in flight cannot reach ANY part of the state -
      // not the transcript, and not the recovered attempt's state. A read that
      // ignores its abort signal is exactly how a continuation outlives its
      // attempt.
      history.resolve({ data: [ASSISTANT_TOOL_MESSAGE], cursor: {} });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(controller.getState()).toEqual(recoveredState);
    } finally {
      controller.dispose();
    }
  });

  test("R-M4c: the spent automatic budget is not a back door to reconnecting", async () => {
    const failing = createGeneration(1, {
      historyList: async () => {
        throw new Error("history read failed");
      },
    });
    const recovered = createGeneration(2);
    const client = createClient([failing, recovered]);
    const controller = createV2ThreadController(client, {
      maxReconnectAttempts: 0,
      initialReconnectDelayMs: 10,
    });
    try {
      void controller.load().catch(() => undefined);
      await waitForState(controller, (state) => state.load.type === "error");

      // CORRECT: a caller that merely waits for readiness is not a user asking
      // to reconnect, so it learns the failure instead of spending an attempt
      // the budget no longer has.
      await expect(controller.awaitReady()).rejects.toThrow("history read failed");
      await expect(controller.load()).rejects.toThrow("history read failed");

      // No retry is pending either: the runtime does not reconnect on its own.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(client.connectCount).toBe(1);

      // The explicit act does reconnect, once.
      await controller.retry();
      await waitForState(controller, (state) => state.load.type === "ready");
      expect(client.connectCount).toBe(2);
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

  it("R-M3: an ambiguous prompt reaches a typed, bounded outcome", async () => {
    const generation = createGeneration(1);
    const client = createClient([generation]);
    // A short deadline, so the DEADLINE is what the test observes rather
    // than a five-minute wait for the product's timeout.
    const controller = createV2ThreadController(client, { promptAdmissionTimeoutMs: 200 });
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
      // The DEADLINE is what settles it, so the wait is the deadline rather
      // than a fixed number of microtask ticks.
      await new Promise((r) => setTimeout(r, 300));

      // CORRECT: the caller learns the outcome instead of hanging.
      expect(settled).toBe(true);
      await sending;
    } finally {
      controller.dispose();
    }
  });

  it("R-M3: an ambiguous prompt is NOT reported as a definitive rejection", async () => {
    // A 5xx cannot prove the server refused the prompt, so the prompt may still
    // be running there. Reporting it as a rejection would tell the reader
    // their message never arrived - which is exactly what the wire could not
    // establish - and would invite a retry that delivers the message twice.
    const generation = createGeneration(1);
    const client = createClient([generation]);
    const controller = createV2ThreadController(client, { promptAdmissionTimeoutMs: 30 });
    await controller.awaitReady();
    try {
      generation.setPromptHandler(async () => {
        const error = new Error("upstream 503") as Error & { status?: number };
        error.status = 503;
        throw error;
      });

      const failure = await controller
        .sendMessage(USER_MESSAGE, { messageId: LOCAL_MESSAGE_ID })
        .then(() => null)
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ kind: "ambiguous" });
      // The registry still reports the truth about the admission.
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("ambiguous");
    } finally {
      controller.dispose();
    }
  });

  it("R-M6: two concurrent replies for one permission produce one transport call", async () => {
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

  it("R-M6: two concurrent replies for one form produce one transport call", async () => {
    const generation = createGeneration(1, {
      formList: async () => [FORM_REPLY],
      formReply: async () => {
        await new Promise((r) => setTimeout(r, 20));
      },
    });
    const client = createClient([generation]);
    const controller = createV2ThreadController(client);
    try {
      await controller.awaitReady();
      await waitForState(controller, (state) => state.forms.length === 1);

      const first = controller.replyToForm(FORM_REPLY.id, { name: "value" });
      await new Promise((r) => setTimeout(r, 5));
      const second = controller.replyToForm(FORM_REPLY.id, { name: "value" });
      await Promise.allSettled([first, second]);

      expect(generation.formReplyInputs).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  it("R-M6: a failed reply releases the claim, so the reader can answer again", async () => {
    // A definitive failure is the only case where the request may be answered
    // again. A network error may mean the server took the answer, so that one
    // keeps the claim - and the request stays visible for the reader.
    let call = 0;
    const generation = createGeneration(1, {
      permissionList: async () => [PERMISSION],
      permissionReply: async () => {
        call += 1;
        if (call === 1) {
          const error = new Error("upstream refused") as Error & { status?: number };
          error.status = 400;
          throw error;
        }
      },
    });
    const client = createClient([generation]);
    const controller = createV2ThreadController(client);
    try {
      await controller.awaitReady();
      await waitForState(controller, (state) => state.permissions.length === 1);

      await expect(controller.replyToPermission(PERMISSION.id, "once")).rejects.toThrow();
      await controller.replyToPermission(PERMISSION.id, "once");

      expect(generation.permissionReplyInputs).toHaveLength(2);
    } finally {
      controller.dispose();
    }
  });

  it("R-M7: a cancel requested before admission is honoured once after admission", async () => {
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
    const controller = createV2ThreadController(client, { promptAdmissionTimeoutMs: 5_000 });
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

  it("R-M7: a second admission of the same prompt does not cancel it twice", async () => {
    // The admission arrives through two paths - the HTTP response and the
    // inbox event - and both must not issue the cancel. The inbox id is what
    // identifies the queued prompt, so the cancel is keyed on it.
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
    const controller = createV2ThreadController(client, { promptAdmissionTimeoutMs: 5_000 });
    await controller.awaitReady();
    try {
      void controller.sendMessage(USER_MESSAGE, { messageId: LOCAL_MESSAGE_ID });
      await new Promise((r) => setTimeout(r, 10));
      await controller.cancel();

      generation.events.emit(inboxEvent(EVENT_INBOX_ID, LOCAL_MESSAGE_ID, "steer"));
      await waitForState(controller, (state) => state.execution.type === "admitted");
      // The same admission arrives again.
      generation.events.emit(inboxEvent(EVENT_INBOX_ID, LOCAL_MESSAGE_ID, "steer"));
      await new Promise((r) => setTimeout(r, 20));

      expect(generation.inboxCancelInputs).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  test("R-M10: a failed auxiliary read leaves the live permission untouched", async () => {
    let call = 0;
    const generation = createGeneration(1, {
      permissionList: async () => {
        call += 1;
        if (call === 1) return [PERMISSION];
        if (call === 2) throw new Error("permission list unavailable (503)");
        return [];
      },
    });
    const client = createClient([generation]);
    const controller = createV2ThreadController(client);
    try {
      await controller.awaitReady();
      expect(controller.getState().permissions).toEqual([PERMISSION]);
      expect(controller.getState().auxiliary.permissions).toBe("current");

      await controller.resyncAuxiliary();

      // CORRECT: an unavailable read is not an authoritative empty list. The
      // card stays, and the state says the shown set is not confirmed.
      expect(controller.getState().permissions).toEqual([PERMISSION]);
      expect(controller.getState().auxiliary.permissions).toBe("unavailable");

      // The distinction only matters because a read that SUCCEEDS and returns
      // nothing IS authoritative - otherwise "keep it on failure" would just be
      // "never remove anything".
      await controller.resyncAuxiliary();
      expect(controller.getState().permissions).toEqual([]);
      expect(controller.getState().auxiliary.permissions).toBe("current");
    } finally {
      controller.dispose();
    }
  });
});
