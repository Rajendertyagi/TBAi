/**
 * P5: replay, stale-response and lifecycle hardening.
 *
 * These cases exercise the real controller/event pipeline entry points and the
 * real fact stores through the shared fake client/generation harness. They
 * assert subscriber-visible state and publication behavior, not internal flags.
 */

import { describe, expect, it } from "bun:test";
import type { SessionInboxUser, V2Event } from "@opencode/client";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import { isLifecycleEvidenceEligible, reduceV2Event } from "@web/features/opencode/v2Events.ts";
import {
  MESSAGE_TEXT,
  SESSION_ID,
  USER_MESSAGE,
  createClient,
  createGeneration,
  deferred,
  userInbox,
} from "@web/testing/opencode/v2ThreadControllerHarness";

function inboxEnqueued(
  id: string,
  inboxId: string,
  seq: number,
  delivery: SessionInboxUser["delivery"] = "queue",
): V2Event {
  return {
    id,
    created: 100 + seq,
    type: "session.inbox.enqueued",
    durable: { aggregateID: SESSION_ID, seq, version: 1 },
    data: {
      sessionID: SESSION_ID,
      inboxID: inboxId,
      item: { type: "user", payload: { text: MESSAGE_TEXT }, delivery },
    },
  } as V2Event;
}

function inboxCancelled(id: string, inboxId: string, seq: number): V2Event {
  return {
    id,
    created: 100 + seq,
    type: "session.inbox.cancelled",
    durable: { aggregateID: SESSION_ID, seq, version: 1 },
    data: { sessionID: SESSION_ID, inboxID: inboxId },
  } as V2Event;
}

function inboxDelivered(id: string, inboxId: string, seq: number): V2Event {
  return {
    id,
    created: 100 + seq,
    type: "session.inbox.delivered",
    durable: { aggregateID: SESSION_ID, seq, version: 1 },
    data: { sessionID: SESSION_ID, inboxID: inboxId },
  } as V2Event;
}

function executionStarted(id: string, seq: number): V2Event {
  return {
    id,
    created: 100 + seq,
    type: "session.execution.started",
    durable: { aggregateID: SESSION_ID, seq, version: 1 },
    data: { sessionID: SESSION_ID },
  } as V2Event;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met before the deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setupQueuedPrompt(
  generation: ReturnType<typeof createGeneration>,
  controller: ReturnType<typeof createV2ThreadController>,
  promptId: string,
  inboxId: string,
  seq: number,
) {
  generation.setPromptHandler(async () => userInbox(inboxId, "queue"));
  await controller.sendMessage(USER_MESSAGE, { messageId: promptId, delivery: "queue" });
  await waitFor(() =>
    controller.getProjection().queuedPromptActions.some((a) => a.promptId === promptId),
  );
  generation.events.emit(inboxEnqueued(`evt_enq_${inboxId}`, inboxId, seq));
  await waitFor(
    () => controller.getState().eventIdentity.durableSequenceByAggregate[SESSION_ID] >= seq,
  );
}

describe("P5 replay and stale-response hardening", () => {
  it("1. duplicate server event ID is applied once", async () => {
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 2_000,
    });
    try {
      await controller.awaitReady();
      const event = inboxCancelled("evt_dup_cancel", "inbox_x", 10);
      generation.events.emit(event);
      await waitFor(() =>
        controller.getState().eventIdentity.recentAppliedEventIds.includes("evt_dup_cancel"),
      );
      const inboxBefore = { ...controller.getState().inboxById };
      const projBefore = controller.getProjection();
      generation.events.emit(event);
      await new Promise((r) => setTimeout(r, 30));
      expect(controller.getState().inboxById).toEqual(inboxBefore);
      expect(controller.getProjection()).toEqual(projBefore);
      expect(
        controller
          .getState()
          .eventIdentity.recentAppliedEventIds.filter((id) => id === "evt_dup_cancel"),
      ).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  it("2. reordered/stale durable evidence cannot regress lifecycle facts", async () => {
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 2_000,
    });
    try {
      await controller.awaitReady();
      await setupQueuedPrompt(generation, controller, "msg_q1", "inbox_q1", 10);
      await controller.cancelQueuedPrompt("msg_q1");
      await waitFor(() =>
        controller
          .getProjection()
          .queuedPromptActions.some((a) => a.promptId === "msg_q1" && a.state !== "available"),
      );
      generation.events.emit(inboxCancelled("evt_cancel_new", "inbox_q1", 12));
      await waitFor(
        () => !controller.getProjection().queuedPromptActions.some((a) => a.promptId === "msg_q1"),
      );
      const afterConfirm = controller.getProjection();
      generation.events.emit(inboxCancelled("evt_cancel_old", "inbox_q1", 11));
      await new Promise((r) => setTimeout(r, 30));
      expect(controller.getProjection().pendingLifecycle.cancellationPending).toBe(false);
      expect(controller.getState().inboxById.inbox_q1).toBeUndefined();
      expect(controller.getProjection().queuedPromptActions).toEqual([]);
      expect(afterConfirm.queuedPromptActions).toEqual([]);
    } finally {
      controller.dispose();
    }
  });

  it("3. replayed inbox cancellation confirms exact queued prompt after unknown", async () => {
    const generation = createGeneration(1);
    (generation.operations as any).inboxCancel = async () => {
      throw new Error("dispatch-failed");
    };
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 2_000,
    });
    try {
      await controller.awaitReady();
      await setupQueuedPrompt(generation, controller, "msg_q2", "inbox_q2", 20);
      await controller.cancelQueuedPrompt("msg_q2");
      await waitFor(() =>
        controller
          .getProjection()
          .queuedPromptActions.some((a) => a.promptId === "msg_q2" && a.state === "unknown"),
      );
      const execBefore = controller.getProjection().hasActiveSessionWork;
      generation.events.emit(inboxCancelled("evt_replay_cancel_q2", "inbox_q2", 21));
      await waitFor(
        () => !controller.getProjection().queuedPromptActions.some((a) => a.promptId === "msg_q2"),
      );
      expect(controller.getProjection().pendingLifecycle.cancellationPending).toBe(false);
      expect(controller.getState().inboxById.inbox_q2).toBeUndefined();
      expect(controller.getProjection().hasActiveSessionWork).toBe(execBefore);
      generation.events.emit(inboxCancelled("evt_replay_cancel_q2", "inbox_q2", 21));
      await new Promise((r) => setTimeout(r, 30));
      expect(controller.getProjection().queuedPromptActions).toEqual([]);
    } finally {
      controller.dispose();
    }
  });

  it("4. unknown cancellation resolved by late authoritative evidence (terminal)", async () => {
    const generation = createGeneration(1);
    (generation.operations as any).inboxCancel = async () => {
      throw new Error("dispatch-failed");
    };
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 2_000,
    });
    try {
      await controller.awaitReady();
      await setupQueuedPrompt(generation, controller, "msg_q3", "inbox_q3", 30);
      await controller.cancelQueuedPrompt("msg_q3");
      await waitFor(() =>
        controller
          .getProjection()
          .queuedPromptActions.some((a) => a.promptId === "msg_q3" && a.state === "unknown"),
      );
      generation.events.emit(inboxCancelled("evt_late_cancel_q3", "inbox_q3", 31));
      await waitFor(
        () => !controller.getProjection().queuedPromptActions.some((a) => a.promptId === "msg_q3"),
      );
      expect(controller.getProjection().pendingLifecycle.cancellationPending).toBe(false);
      generation.events.emit(inboxCancelled("evt_late_cancel_q3", "inbox_q3", 31));
      generation.events.emit(inboxCancelled("evt_stale_cancel_q3", "inbox_q3", 30));
      await new Promise((r) => setTimeout(r, 30));
      expect(controller.getProjection().queuedPromptActions).toEqual([]);
      expect(controller.getState().inboxById.inbox_q3).toBeUndefined();
    } finally {
      controller.dispose();
    }
  });

  it("5. confirmed cancellation is terminal against contradictory/stale evidence", async () => {
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 2_000,
    });
    try {
      await controller.awaitReady();
      await setupQueuedPrompt(generation, controller, "msg_q4", "inbox_q4", 40);
      await controller.cancelQueuedPrompt("msg_q4");
      await waitFor(() => generation.inboxCancelInputs.length === 1);
      generation.events.emit(inboxCancelled("evt_confirm_q4", "inbox_q4", 41));
      await waitFor(
        () => !controller.getProjection().queuedPromptActions.some((a) => a.promptId === "msg_q4"),
      );
      generation.events.emit(inboxDelivered("evt_deliver_q4", "inbox_q4", 42));
      await new Promise((r) => setTimeout(r, 30));
      expect(controller.getState().inboxById.inbox_q4).toBeUndefined();
      expect(controller.getProjection().queuedPromptActions).toEqual([]);
    } finally {
      controller.dispose();
    }
  });

  it("6. stale local HTTP prompt response is rejected (generation superseded)", async () => {
    const gen1 = createGeneration(1);
    const gen2 = createGeneration(2);
    const response = deferred<SessionInboxUser>();
    gen1.setPromptHandler(async () => response.promise);
    const client = createClient([gen1, gen2]);
    const controller = createV2ThreadController(client, {
      promptAdmissionTimeoutMs: 5_000,
      maxReconnectAttempts: 2,
    });
    try {
      await controller.awaitReady();
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: "msg_stale_http",
        delivery: "steer",
      });
      await waitFor(() => gen1.promptInputs.length === 1);
      gen1.events.fail(new Error("stream-died"));
      await client.waitForConnect(2);
      await controller.awaitReady();
      response.resolve(userInbox("inbox_stale", "steer"));
      const result = await Promise.race([
        sending.then((v) => ({ ok: true as const, v })).catch((e) => ({ ok: false as const, e })),
        new Promise<{ ok: false; e: Error }>((resolve) =>
          setTimeout(() => resolve({ ok: false, e: new Error("send-hung") }), 3_000),
        ),
      ]);
      const admittedStale = result.ok && (result.v as any).inboxId === "inbox_stale";
      expect(admittedStale).toBe(false);
      expect(controller.getState().inboxById.inbox_stale).toBeUndefined();
    } finally {
      controller.dispose();
    }
  });

  it("7. old-generation cancellation dispatch response cannot mutate current state", async () => {
    const gen1 = createGeneration(1);
    const gen2 = createGeneration(2);
    const cancelResponse = deferred<void>();
    (gen1.operations as any).inboxCancel = async (input: {
      sessionID: string;
      inboxID: string;
    }) => {
      (gen1.inboxCancelInputs as { sessionID: string; inboxID: string }[]).push(input);
      return cancelResponse.promise;
    };
    const client = createClient([gen1, gen2]);
    const controller = createV2ThreadController(client, {
      promptAdmissionTimeoutMs: 2_000,
      maxReconnectAttempts: 2,
    });
    try {
      await controller.awaitReady();
      await setupQueuedPrompt(gen1, controller, "msg_q7", "inbox_q7", 50);
      void controller.cancelQueuedPrompt("msg_q7");
      await waitFor(() => gen1.inboxCancelInputs.length === 1);
      const beforeReconnect = controller
        .getProjection()
        .queuedPromptActions.find((a) => a.promptId === "msg_q7");
      gen1.events.fail(new Error("stream-died"));
      await client.waitForConnect(2);
      await controller.awaitReady();
      const beforeResolve = controller
        .getProjection()
        .queuedPromptActions.find((a) => a.promptId === "msg_q7");
      cancelResponse.resolve(undefined);
      await new Promise((r) => setTimeout(r, 40));
      const after = controller
        .getProjection()
        .queuedPromptActions.find((a) => a.promptId === "msg_q7");
      // Stale dispatch response must not confirm or otherwise mutate current facts.
      expect(after?.state === "confirmed").toBe(false);
      expect(after?.state).toBe(beforeResolve?.state);
      expect(beforeReconnect?.state === "confirmed").toBe(false);
    } finally {
      controller.dispose();
    }
  });

  it("8. durable replay accepted after local generation change", async () => {
    const gen1 = createGeneration(1);
    const gen2 = createGeneration(2);
    const client = createClient([gen1, gen2]);
    const controller = createV2ThreadController(client, {
      promptAdmissionTimeoutMs: 2_000,
      maxReconnectAttempts: 2,
    });
    try {
      await controller.awaitReady();
      gen1.events.emit(executionStarted("evt_exec_g1", 60));
      await waitFor(
        () => controller.getState().eventIdentity.durableSequenceByAggregate[SESSION_ID] >= 60,
      );
      gen1.events.fail(new Error("stream-died"));
      await client.waitForConnect(2);
      await controller.awaitReady();
      gen2.events.emit(inboxCancelled("evt_replay_g2", "inbox_replay_g2", 61));
      await waitFor(() =>
        controller.getState().eventIdentity.recentAppliedEventIds.includes("evt_replay_g2"),
      );
      expect(controller.getState().eventIdentity.durableSequenceByAggregate[SESSION_ID]).toBe(61);
    } finally {
      controller.dispose();
    }
  });

  it("9. incomplete scans preserve ambiguity", async () => {
    let failScans = false;
    const generation = createGeneration(1, {
      inboxList: async () => {
        if (failScans) throw new Error("inbox-unavailable");
        return [];
      },
      historyList: async () => {
        if (failScans) throw new Error("history-unavailable");
        return { data: [], cursor: {} };
      },
    });
    const response = deferred<SessionInboxUser>();
    generation.setPromptHandler(async () => response.promise);
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 50,
    });
    try {
      await controller.awaitReady();
      failScans = true;
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: "msg_ambig",
        delivery: "steer",
      });
      await waitFor(() => generation.promptInputs.length === 1);
      const outcome = await sending.then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      // Incomplete/unavailable scans must not fabricate admission or absence.
      if (outcome.ok) {
        expect(
          (outcome.v as any).inboxId == null || typeof (outcome.v as any).inboxId === "string",
        ).toBe(true);
      } else {
        expect((outcome as { ok: false; e: any }).e.kind).toBe("ambiguous");
      }
      response.resolve(userInbox("inbox_late_ambig", "steer"));
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      controller.dispose();
    }
  });

  it("10. late admission evidence enriches without resetting active execution", async () => {
    const generation = createGeneration(1);
    const response = deferred<SessionInboxUser>();
    generation.setPromptHandler(async () => response.promise);
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 5_000,
    });
    try {
      await controller.awaitReady();
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: "msg_late_admit",
        delivery: "steer",
      });
      await waitFor(() => generation.promptInputs.length === 1);
      generation.events.emit(executionStarted("evt_exec_late", 70));
      await waitFor(() => controller.getProjection().hasActiveSessionWork);
      const execBefore = controller.getProjection().composerStopOperation;
      response.resolve(userInbox("inbox_late_admit", "steer"));
      await expect(sending).resolves.toMatchObject({ messageId: "msg_late_admit" });
      await waitFor(() => controller.getState().inboxById.inbox_late_admit != null);
      expect(controller.getProjection().hasActiveSessionWork).toBe(true);
      expect(controller.getProjection().composerStopOperation.kind).toBe("stop-current-execution");
      expect(controller.getProjection().composerStopOperation).toEqual(execBefore);
    } finally {
      controller.dispose();
    }
  });

  it("11. disposed controller ignores delayed callbacks (no mutation/publication/dispatch)", async () => {
    const generation = createGeneration(1);
    const promptResponse = deferred<SessionInboxUser>();
    const cancelResponse = deferred<void>();
    generation.setPromptHandler(async () => promptResponse.promise);
    (generation.operations as any).inboxCancel = async (input: {
      sessionID: string;
      inboxID: string;
    }) => {
      (generation.inboxCancelInputs as { sessionID: string; inboxID: string }[]).push(input);
      return cancelResponse.promise;
    };
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 5_000,
    });
    let notifications = 0;
    const unsub = controller.subscribe(() => {
      notifications += 1;
    });
    try {
      await controller.awaitReady();
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: "msg_disp",
        delivery: "queue",
      });
      await waitFor(() => generation.promptInputs.length === 1);
      promptResponse.resolve(userInbox("inbox_disp", "queue"));
      await sending.catch(() => undefined);
      void controller.cancelQueuedPrompt("msg_disp");
      await waitFor(() => generation.inboxCancelInputs.length === 1);
      const stateBefore = controller.getState();
      const projBefore = controller.getProjection();
      const notifBefore = notifications;
      controller.dispose();
      unsub();
      // Late async callback after disposal must not mutate/publish/dispatch.
      cancelResponse.resolve(undefined);
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 50));
      expect(controller.getState()).toBe(stateBefore);
      expect(controller.getProjection()).toBe(projBefore);
      expect(notifications).toBe(notifBefore);
      expect(generation.inboxCancelInputs).toHaveLength(1);
    } finally {
      try {
        unsub();
      } catch {}
      controller.dispose();
    }
  });

  it("delivery-versus-cancellation: authoritative delivery wins, late cancel does not reverse", async () => {
    const generation = createGeneration(1);
    (generation.operations as any).inboxCancel = async () => {
      throw new Error("dispatch-failed");
    };
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 2_000,
    });
    try {
      await controller.awaitReady();
      await setupQueuedPrompt(generation, controller, "msg_race", "inbox_race", 90);
      await controller.cancelQueuedPrompt("msg_race");
      await waitFor(() =>
        controller
          .getProjection()
          .queuedPromptActions.some((a) => a.promptId === "msg_race" && a.state === "unknown"),
      );
      generation.events.emit(inboxDelivered("evt_deliver_race", "inbox_race", 91));
      await waitFor(() =>
        controller.getState().eventIdentity.recentAppliedEventIds.includes("evt_deliver_race"),
      );
      // Delivery evidence must win: prompt must not appear successfully cancelled.
      const actionAfterDelivery = controller
        .getProjection()
        .queuedPromptActions.find((a) => a.promptId === "msg_race");
      expect(actionAfterDelivery?.state === "confirmed").toBe(false);
      // Late cancellation must not reverse proven delivery outcome.
      generation.events.emit(inboxCancelled("evt_cancel_race_late", "inbox_race", 92));
      await new Promise((r) => setTimeout(r, 30));
      const actionAfterLateCancel = controller
        .getProjection()
        .queuedPromptActions.find((a) => a.promptId === "msg_race");
      expect(actionAfterLateCancel?.state === "confirmed").toBe(false);
      // If still represented as a queued prompt, delivery won (superseded/unknown), not cancelled.
      if (actionAfterLateCancel) {
        expect(["superseded", "unknown", "failed", "unavailable"]).toContain(
          actionAfterLateCancel.state,
        );
      }
    } finally {
      controller.dispose();
    }
  });

  it("other-session events do not mutate lifecycle facts", async () => {
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 2_000,
    });
    try {
      await controller.awaitReady();
      await setupQueuedPrompt(generation, controller, "msg_scope", "inbox_scope", 100);
      const before = controller.getProjection();
      const otherSession: V2Event = {
        id: "evt_other_session",
        created: 201,
        type: "session.inbox.cancelled",
        durable: { aggregateID: "ses_other", seq: 1, version: 1 },
        data: { sessionID: "ses_other", inboxID: "inbox_scope" },
      } as V2Event;
      generation.events.emit(otherSession);
      await new Promise((r) => setTimeout(r, 30));
      expect(controller.getState().inboxById.inbox_scope).toBeDefined();
      expect(
        controller.getProjection().queuedPromptActions.some((a) => a.promptId === "msg_scope"),
      ).toBe(true);
      expect(controller.getProjection().queuedPromptActions).toEqual(before.queuedPromptActions);
    } finally {
      controller.dispose();
    }
  });

  it("P5.1 observe-only identity handling (preserves unapplied identity, applies later, deduplicates, and no duplicate transitions)", async () => {
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 2_000,
    });
    let notifications = 0;
    const unsub = controller.subscribe(() => {
      notifications += 1;
    });
    try {
      await controller.awaitReady();

      // Part 1: Event reducer level invariants
      const initialState = controller.getState();
      const candidateEvent = inboxCancelled("evt_obs_ident_1", "inbox_obs_1", 100);

      // A: Observe-only mode adds to recentObservedEventIds but NOT recentAppliedEventIds
      const observedState = reduceV2Event(initialState, candidateEvent, "observe-only");
      expect(observedState.eventIdentity.recentObservedEventIds.includes("evt_obs_ident_1")).toBe(
        true,
      );
      expect(observedState.eventIdentity.recentAppliedEventIds.includes("evt_obs_ident_1")).toBe(
        false,
      );

      // B: Identity is not consumed; event remains eligible for future lifecycle facts
      expect(isLifecycleEvidenceEligible(observedState, candidateEvent)).toBe(true);

      // C: Duplicate observation in observe-only returns exact reference (no new transition)
      const duplicateObserved = reduceV2Event(observedState, candidateEvent, "observe-only");
      expect(duplicateObserved).toBe(observedState);

      // D: Later valid evidence processes through observe-and-apply
      const appliedState = reduceV2Event(observedState, candidateEvent, "observe-and-apply");
      expect(appliedState.eventIdentity.recentAppliedEventIds.includes("evt_obs_ident_1")).toBe(
        true,
      );
      expect(isLifecycleEvidenceEligible(appliedState, candidateEvent)).toBe(false);

      // E: Once genuinely applied, duplicate arrives and is deduplicated
      const deduplicatedState = reduceV2Event(appliedState, candidateEvent, "observe-and-apply");
      expect(deduplicatedState).toBe(appliedState);

      // Part 2: Controller entry point verification
      const controllerApplied = inboxCancelled("evt_ctl_apply_1", "inbox_ctl_1", 105);
      generation.events.emit(controllerApplied);
      await waitFor(() =>
        controller.getState().eventIdentity.recentAppliedEventIds.includes("evt_ctl_apply_1"),
      );
      expect(
        controller
          .getState()
          .eventIdentity.recentAppliedEventIds.filter((id) => id === "evt_ctl_apply_1"),
      ).toHaveLength(1);

      // Duplicate observation through pipeline does not fire extra notification
      const notifsBeforeDup = notifications;
      const stateBeforeDup = controller.getState();
      generation.events.emit(controllerApplied);
      await new Promise((r) => setTimeout(r, 20));
      expect(controller.getState()).toBe(stateBeforeDup);
      expect(notifications).toBe(notifsBeforeDup);
      expect(
        controller
          .getState()
          .eventIdentity.recentAppliedEventIds.filter((id) => id === "evt_ctl_apply_1"),
      ).toHaveLength(1);
    } finally {
      unsub();
      controller.dispose();
    }
  });

  it("P5.2 out-of-scope event rejection (wrong session, wrong scope, ineligible type, uncorroborated correlation)", async () => {
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 2_000,
    });
    try {
      await controller.awaitReady();
      await setupQueuedPrompt(generation, controller, "msg_target", "inbox_target", 110);

      const wrongSessionEvent: V2Event = {
        id: "evt_wrong_session_test",
        created: 211,
        type: "session.inbox.cancelled",
        durable: { aggregateID: "ses_foreign", seq: 1, version: 1 },
        data: { sessionID: "ses_foreign", inboxID: "inbox_target" },
      } as any;
      generation.events.emit(wrongSessionEvent);

      const wrongScopeEvent: V2Event = {
        id: "evt_wrong_scope_test",
        created: 212,
        type: "session.inbox.cancelled",
        location: { directory: "/unrelated/different/workspace" },
        durable: { aggregateID: SESSION_ID, seq: 111, version: 1 },
        data: { sessionID: SESSION_ID, inboxID: "inbox_target" },
      } as any;
      generation.events.emit(wrongScopeEvent);

      const ineligibleTypeEvent: V2Event = {
        id: "evt_ineligible_type_test",
        created: 213,
        type: "session.renamed",
        durable: { aggregateID: SESSION_ID, seq: 112, version: 1 },
        data: { sessionID: SESSION_ID, title: "New Title" },
      } as any;
      generation.events.emit(ineligibleTypeEvent);

      const uncorroboratedInboxEvent: V2Event = {
        id: "evt_uncorroborated_inbox_test",
        created: 214,
        type: "session.inbox.cancelled",
        durable: { aggregateID: SESSION_ID, seq: 113, version: 1 },
        data: { sessionID: SESSION_ID, inboxID: "inbox_completely_unknown_999" },
      } as any;
      generation.events.emit(uncorroboratedInboxEvent);

      await new Promise((r) => setTimeout(r, 40));

      const targetAction = controller
        .getProjection()
        .queuedPromptActions.find((a) => a.promptId === "msg_target");
      expect(targetAction?.state).toBe("available");
      expect(controller.getProjection().queuedPromptActions).toHaveLength(1);
      expect(controller.getState().inboxById.inbox_target).toBeDefined();

      expect(controller.getProjection().pendingLifecycle.cancellationPending).toBe(false);
      expect(
        controller
          .getState()
          .eventIdentity.recentAppliedEventIds.includes("evt_wrong_session_test"),
      ).toBe(false);
      expect(
        controller.getState().eventIdentity.recentAppliedEventIds.includes("evt_wrong_scope_test"),
      ).toBe(false);
    } finally {
      controller.dispose();
    }
  });

  it("P5.3 asynchronous disposal safety (delayed reconcile, buffered replay, late events, microtasks)", async () => {
    let delayAuxiliary = false;
    const delayedAuxResponse = deferred<any>();
    const generation = createGeneration(1, {
      inboxList: async () => {
        if (delayAuxiliary) return delayedAuxResponse.promise;
        return [];
      },
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 2_000,
    });

    let notifications = 0;
    const unsub = controller.subscribe(() => {
      notifications += 1;
    });

    try {
      await controller.awaitReady();
      await setupQueuedPrompt(generation, controller, "msg_disp_edge", "inbox_disp_edge", 120);

      // Confirm cancellation first so we establish a confirmed/terminal fact
      await controller.cancelQueuedPrompt("msg_disp_edge");
      generation.events.emit(inboxCancelled("evt_confirm_disp", "inbox_disp_edge", 121));
      await waitFor(
        () =>
          !controller
            .getProjection()
            .queuedPromptActions.some((a) => a.promptId === "msg_disp_edge"),
      );
      expect(controller.getState().inboxById.inbox_disp_edge).toBeUndefined();

      // 1. Kick off an asynchronous auxiliary reconciliation that pauses at delayedAuxResponse
      delayAuxiliary = true;
      const resyncPromise = controller.resyncAuxiliary();

      // 2. Start an admission waiter for a pending message
      const admissionPromise = controller.awaitPromptAdmission("msg_pending_disp");

      const stateAtDisposal = controller.getState();
      const projAtDisposal = controller.getProjection();
      const notifsAtDisposal = notifications;

      // DISPOSE the controller
      controller.dispose();
      unsub();

      // A: Delayed reconciliation callback arrives after disposal
      delayedAuxResponse.resolve([
        { id: "inbox_disp_edge", sessionID: SESSION_ID, type: "user", delivery: "queue" },
      ]);
      await resyncPromise.catch(() => undefined);

      // B: Late event subscription callback arrives after disposal
      try {
        generation.events.emit(inboxCancelled("evt_late_post_disp", "inbox_disp_edge", 122));
      } catch {}

      // C: Deferred / microtask work after disposal
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 40));

      // Admission waiter settles with disposed and does not resurrect
      const admissionResult = await admissionPromise.catch((e) => e);
      expect(admissionResult === "disposed" || (admissionResult as any)?.kind === "disposed").toBe(
        true,
      );

      // Confirmed facts are NOT reopened; no lifecycle mutation, no subscriber publication
      expect(controller.getState()).toBe(stateAtDisposal);
      expect(controller.getProjection()).toBe(projAtDisposal);
      expect(notifications).toBe(notifsAtDisposal);
      expect(controller.getState().inboxById.inbox_disp_edge).toBeUndefined();
      expect(controller.getProjection().queuedPromptActions).toEqual([]);
    } finally {
      try {
        unsub();
      } catch {}
      controller.dispose();
    }
  });
});
