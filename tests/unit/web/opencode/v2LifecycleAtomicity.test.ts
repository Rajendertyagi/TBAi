/**
 * P3: atomic lifecycle publication and fault recovery.
 *
 * These cases drive the REAL controller and the REAL fact stores. The only
 * synthetic part is a store wrapper that throws on one method, which is how a
 * cross-fact transition is made to fail at a known point. What is asserted is
 * subscriber-visible: the snapshots a listener actually receives, never an
 * internal flag.
 */

import { describe, expect, it } from "bun:test";
import type { SessionInboxUser, V2Event } from "@opencode/client";
import {
  createPromptsInFlight,
  type PromptsInFlight,
} from "@web/features/opencode/sync/promptsInFlight.ts";
import type { V2LifecycleProjection } from "@web/features/opencode/sync/lifecycleProjection.ts";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import {
  MESSAGE_TEXT,
  SESSION_ID,
  USER_MESSAGE,
  createClient,
  createGeneration,
  deferred,
  userInbox,
} from "@web/testing/opencode/v2ThreadControllerHarness";

const CONVERSATION_ID = "conv_lifecycle_atomicity";
const LIFECYCLE_RECOVERY_ATTEMPTS = 2;

type FaultablePrompts = {
  readonly store: PromptsInFlight;
  setMutationFault(value: boolean): void;
  setCaptureFault(value: boolean): void;
};

/**
 * The real store, with a controllable fault on the two evidence methods.
 *
 * Deliberately delegates capture/restore to the real store so a rollback is
 * exercised for real; only the transition's own mutation can fail.
 */
function faultablePrompts(): FaultablePrompts {
  const real = createPromptsInFlight();
  let mutationFault = false;
  let captureFault = false;
  const store: PromptsInFlight = {
    ...real,
    enrich: (promptId, evidence) => {
      if (mutationFault) throw new Error("injected-enrich-fault");
      return real.enrich(promptId, evidence);
    },
    settleVerdict: (promptId, verdict, evidence) => {
      if (mutationFault) throw new Error("injected-settle-fault");
      return real.settleVerdict(promptId, verdict, evidence);
    },
    captureRestorePoint: () => {
      if (captureFault) throw new Error("injected-capture-fault");
      return real.captureRestorePoint();
    },
  };
  return {
    store,
    setMutationFault: (value) => {
      mutationFault = value;
    },
    setCaptureFault: (value) => {
      captureFault = value;
    },
  };
}

function createController(
  generation: ReturnType<typeof createGeneration>,
  prompts: PromptsInFlight,
  config: { readonly lifecycleRecoveryAttempts?: number } = {},
) {
  return createV2ThreadController(
    createClient([generation]),
    {
      promptAdmissionTimeoutMs: 2_000,
      lifecycleRecoveryAttempts: config.lifecycleRecoveryAttempts ?? LIFECYCLE_RECOVERY_ATTEMPTS,
    },
    {
      conversationId: CONVERSATION_ID,
      fetchActivity: async () => "not-running",
      lifecycleStores: { prompts },
    },
  );
}

function inboxCorrelated(inboxId: string, delivery: SessionInboxUser["delivery"]): V2Event {
  return {
    id: `evt_correlated_${inboxId}`,
    created: 10,
    type: "session.inbox.enqueued",
    durable: { aggregateID: SESSION_ID, seq: 50, version: 1 },
    data: {
      sessionID: SESSION_ID,
      inboxID: inboxId,
      item: { type: "user", payload: { text: MESSAGE_TEXT }, delivery },
    },
  } as V2Event;
}

function cancellationEvent(id: string, inboxId: string): V2Event {
  return {
    id,
    created: 20,
    type: "session.inbox.cancelled",
    durable: { aggregateID: SESSION_ID, seq: 60, version: 1 },
    data: { sessionID: SESSION_ID, inboxID: inboxId },
  } as V2Event;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met before the deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("P3 atomic lifecycle publication", () => {
  it("rejects a replayed cancellation event instead of applying it twice", async () => {
    const generation = createGeneration(1);
    const prompts = createPromptsInFlight();
    const controller = createController(generation, prompts);

    try {
      await controller.awaitReady();
      generation.setPromptHandler(async () => userInbox("inbox_b", "queue"));
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: "msg_b",
        delivery: "queue",
      });
      await expect(sending).resolves.toEqual({
        messageId: "msg_b",
        inboxId: "inbox_b",
        delivery: "queue",
      });
      await controller.cancelQueuedPrompt("msg_b");
      // The cancellation is unresolved until the server's evidence arrives.
      expect(controller.getProjection().pendingLifecycle.cancellationPending).toBe(true);

      generation.events.emit(cancellationEvent("evt_cancel_once", "inbox_b"));
      await waitFor(
        () => controller.getProjection().pendingLifecycle.cancellationPending === false,
      );

      const publications: V2LifecycleProjection[] = [];
      const unsubscribe = controller.subscribe(() => {
        publications.push(controller.getProjection());
      });

      // The exact same event id is not new evidence: the reducer has already
      // applied it, so no fact may move and no subscriber may be told.
      generation.events.emit(cancellationEvent("evt_cancel_once", "inbox_b"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      unsubscribe();

      expect(publications).toHaveLength(0);
      expect(controller.getProjection().pendingLifecycle.cancellationPending).toBe(false);
    } finally {
      controller.dispose();
    }
  });

  it("does not let a stale HTTP response overwrite an event-proven admission", async () => {
    const generation = createGeneration(1);
    const prompts = createPromptsInFlight();
    const controller = createController(generation, prompts);
    const response = deferred<SessionInboxUser>();
    const called = deferred<void>();
    generation.setPromptHandler(async () => {
      called.resolve(undefined);
      return response.promise;
    });

    try {
      await controller.awaitReady();
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: "msg_s",
        delivery: "steer",
      });
      await called.promise;

      // Direct inbox-id/prompt-id equality is the only allowed correlation.
      generation.events.emit(inboxCorrelated("msg_s", "steer"));
      await waitFor(() => prompts.get("msg_s")?.verdict === "admitted");

      response.resolve(userInbox("inbox_http_late", "steer"));
      await expect(sending).resolves.toEqual({
        messageId: "msg_s",
        inboxId: "msg_s",
        delivery: "steer",
      });

      const record = prompts.get("msg_s");
      expect(record?.inboxId.value).toBe("msg_s");
      // The stale local response contributed NOTHING: no http-response evidence.
      expect(record?.inboxId.history.some((evidence) => evidence.source === "http-response")).toBe(
        false,
      );
    } finally {
      controller.dispose();
    }
  });

  it("publishes one snapshot in which a cross-fact event is fully visible", async () => {
    const generation = createGeneration(1);
    const prompts = createPromptsInFlight();
    const controller = createController(generation, prompts);

    try {
      await controller.awaitReady();
      generation.setPromptHandler(async () => userInbox("inbox_c_http", "queue"));
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: "msg_c",
        delivery: "queue",
      });
      await sending;
      await waitFor(() => controller.getProjection().queuedPromptActions.length === 1);

      const snapshots: Array<{ projection: V2LifecycleProjection; inboxRecorded: boolean }> = [];
      const unsubscribe = controller.subscribe(() => {
        snapshots.push({
          projection: controller.getProjection(),
          inboxRecorded: controller.getState().inboxById.msg_c !== undefined,
        });
      });

      generation.events.emit(inboxCorrelated("msg_c", "queue"));
      await waitFor(() => controller.getState().inboxById.msg_c !== undefined);
      await new Promise((resolve) => setTimeout(resolve, 20));
      unsubscribe();

      expect(snapshots).toHaveLength(1);
      // The single publication carries BOTH facts: the inbox record and the
      // admission evidence that came with the same event.
      expect(snapshots[0]?.inboxRecorded).toBe(true);
      expect(snapshots[0]?.projection.pendingLifecycle.submissionPending).toBe(false);
      expect(prompts.get("msg_c")?.phase).toBe("admitted");
    } finally {
      controller.dispose();
    }
  });

  it("rolls back every store and publishes degraded when a transition faults", async () => {
    const generation = createGeneration(1);
    const faultable = faultablePrompts();
    const controller = createController(generation, faultable.store);

    try {
      await controller.awaitReady();
      generation.setPromptHandler(async () => userInbox("inbox_f_http", "steer"));
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: "msg_f",
        delivery: "steer",
      });
      await sending;
      const before = controller.getProjection();
      const recordBefore = faultable.store.get("msg_f");
      expect(controller.getState().inboxById.msg_f).toBeUndefined();

      faultable.setMutationFault(true);
      const snapshots: Array<{ projection: V2LifecycleProjection; inboxRecorded: boolean }> = [];
      const unsubscribe = controller.subscribe(() => {
        snapshots.push({
          projection: controller.getProjection(),
          inboxRecorded: controller.getState().inboxById.msg_f !== undefined,
        });
      });
      generation.events.emit(inboxCorrelated("msg_f", "steer"));
      // The degraded publication happens synchronously inside the fault path, so
      // the subscriber buffer is deterministic even though bounded recovery may
      // clear the flag before a polling loop observes it.
      await waitFor(() => snapshots.some((snapshot) => snapshot.projection.health.degraded));
      await waitFor(() => controller.getProjection().health.degraded === false);
      unsubscribe();

      // Nothing from the failed event survived in ANY store.
      expect(controller.getState().inboxById.msg_f).toBeUndefined();
      expect(faultable.store.get("msg_f")?.inboxId.value).toBe(recordBefore?.inboxId.value);
      expect(faultable.store.get("msg_f")?.inboxId.history).toEqual(recordBefore?.inboxId.history);
      // Every published degraded snapshot shows the last-known-good facts: a
      // subscriber never saw the half-applied event.
      const degradedSnapshot = snapshots.find((snapshot) => snapshot.projection.health.degraded);
      expect(degradedSnapshot?.inboxRecorded).toBe(false);
      expect(degradedSnapshot?.projection.pendingLifecycle).toEqual(before.pendingLifecycle);
      // Recovery succeeded, so the runtime does not linger degraded by accident.
      expect(controller.getProjection().health.degraded).toBe(false);
    } finally {
      controller.dispose();
    }
  });

  it("blocks mutations while degraded and resumes after bounded reconciliation", async () => {
    const generation = createGeneration(1);
    const faultable = faultablePrompts();
    const controller = createController(generation, faultable.store);

    try {
      await controller.awaitReady();
      generation.setPromptHandler(async () => userInbox("inbox_g_http", "steer"));
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: "msg_g",
        delivery: "steer",
      });
      await sending;

      // A capture fault makes EVERY reconciliation attempt fail, so the runtime
      // stays visibly degraded instead of clearing itself by luck.
      faultable.setMutationFault(true);
      faultable.setCaptureFault(true);
      generation.events.emit(inboxCorrelated("msg_g", "steer"));
      await waitFor(() => controller.getProjection().health.degraded);
      await waitFor(() => controller.getProjection().health.recovering === false);
      expect(controller.getProjection().health.recoveryAttempts).toBe(LIFECYCLE_RECOVERY_ATTEMPTS);

      // A new lifecycle event is REFUSED, not applied onto an unproven snapshot.
      generation.events.emit(inboxCorrelated("msg_g_blocked", "steer"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(controller.getState().inboxById.msg_g_blocked).toBeUndefined();
      expect(controller.getProjection().health.degraded).toBe(true);

      // Clear the fault and reconcile explicitly: the snapshot is proven again
      // and mutations resume.
      faultable.setMutationFault(false);
      faultable.setCaptureFault(false);
      await controller.reconcileLifecycle();
      await waitFor(() => controller.getProjection().health.degraded === false);

      generation.events.emit(inboxCorrelated("msg_g_blocked", "steer"));
      await waitFor(() => controller.getState().inboxById.msg_g_blocked !== undefined);
      expect(controller.getProjection().health.degraded).toBe(false);
    } finally {
      controller.dispose();
    }
  });

  it("ignores a late HTTP response after disposal", async () => {
    const generation = createGeneration(1);
    const prompts = createPromptsInFlight();
    const controller = createController(generation, prompts);
    const response = deferred<SessionInboxUser>();
    const called = deferred<void>();
    generation.setPromptHandler(async () => {
      called.resolve(undefined);
      return response.promise;
    });

    await controller.awaitReady();
    const sending = controller.sendMessage(USER_MESSAGE, {
      messageId: "msg_d",
      delivery: "steer",
    });
    await called.promise;
    controller.dispose();
    response.resolve(userInbox("inbox_after_dispose", "steer"));

    await expect(sending).rejects.toMatchObject({ kind: "disposed" });
    expect(prompts.get("msg_d")?.terminal).toBe("disposed");
  });
});
