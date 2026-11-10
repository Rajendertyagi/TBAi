import { describe, expect, it } from "bun:test";
import type {
  SessionInboxUser,
  SessionMessageInfo,
  SessionMessagesResponse,
} from "@opencode/client";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import {
  LOCAL_MESSAGE_ID,
  SESSION_ID,
  USER_MESSAGE,
  createClient,
  createGeneration,
  deferred,
  userInbox,
  waitForState,
} from "@web/testing/opencode/v2ThreadControllerHarness";

function userMessage(id: string, created = 10): SessionMessageInfo {
  return {
    id,
    type: "user",
    time: { created },
    text: "controller test",
  } as SessionMessageInfo;
}

describe("native V2 prompt reconciliation (REL-IMPL-PROMPT-AMBIGUITY-01)", () => {
  it("reconciles a lost HTTP response by finding the prompt in inbox", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    const inbox = userInbox(LOCAL_MESSAGE_ID, "steer");
    let inboxCalls = 0;
    const generation = createGeneration(1, {
      inboxList: async () => {
        inboxCalls += 1;
        // First call during auxiliary hydration may be empty; reconciliation should find it later.
        return inboxCalls >= 2 ? [inbox] : [];
      },
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 2_000,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;
      prompt.reject(new TypeError("prompt response was lost"));

      await waitForState(controller, (state) => state.execution.type === "reconciling");
      const submission = await sending;
      expect(submission).toEqual({
        messageId: LOCAL_MESSAGE_ID,
        inboxId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("admitted");
      expect(controller.getState().execution.type).toBe("admitted");
      expect(inboxCalls).toBeGreaterThanOrEqual(2);
    } finally {
      controller.dispose();
    }
  });

  it("reconciles a lost HTTP/SSE response by finding the prompt in paginated message history", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    let historyCalls = 0;
    const generation = createGeneration(1, {
      inboxList: async () => [],
      historyList: async (input) => {
        historyCalls += 1;
        // Initial hydration read
        if (historyCalls === 1) return { data: [], cursor: {} };
        // Reconciliation pagination: page 1 has cursor, page 2 contains the prompt
        if (!input.cursor) {
          return {
            data: [userMessage("msg_other_1")],
            cursor: { next: "cursor-2" },
          } as SessionMessagesResponse;
        }
        if (input.cursor === "cursor-2") {
          return {
            data: [userMessage(LOCAL_MESSAGE_ID)],
            cursor: {},
          } as SessionMessagesResponse;
        }
        return { data: [], cursor: {} };
      },
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 2_000,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;
      prompt.reject(new TypeError("prompt response was lost"));

      const submission = await sending;
      expect(submission).toEqual({
        messageId: LOCAL_MESSAGE_ID,
        inboxId: null,
        delivery: null,
      });
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("admitted");
      expect(controller.getState().execution.type).toBe("admitted");
      expect(controller.getState().execution).toMatchObject({
        type: "admitted",
        userMessageId: LOCAL_MESSAGE_ID,
        inboxId: null,
        delivery: null,
      });
      expect(historyCalls).toBeGreaterThanOrEqual(3);
    } finally {
      controller.dispose();
    }
  });

  it("preserves ambiguity when message pagination is incomplete (cursor cycle)", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    let historyCalls = 0;
    const generation = createGeneration(1, {
      inboxList: async () => [],
      historyList: async (input) => {
        historyCalls += 1;
        if (historyCalls === 1) return { data: [], cursor: {} };
        if (!input.cursor) {
          return {
            data: [userMessage("msg_other_1")],
            cursor: { next: "cursor-a" },
          } as SessionMessagesResponse;
        }
        if (input.cursor === "cursor-a") {
          return {
            data: [userMessage("msg_other_2")],
            cursor: { next: "cursor-a" },
          } as SessionMessagesResponse;
        }
        return { data: [], cursor: {} };
      },
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 400,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;
      prompt.reject(new TypeError("prompt response was lost"));

      await expect(sending).rejects.toMatchObject({ kind: "ambiguous" });
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("ambiguous");
      expect(controller.getState().execution.type).toBe("reconciling");
      expect(historyCalls).toBeGreaterThanOrEqual(2);
    } finally {
      controller.dispose();
    }
  });

  it("preserves ambiguity when reconciliation requests fail", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    let historyCalls = 0;
    const generation = createGeneration(1, {
      inboxList: async () => {
        throw new Error("inbox unavailable");
      },
      historyList: async () => {
        historyCalls += 1;
        // Initial hydration load succeeds; reconciliation scans fail.
        if (historyCalls === 1) return { data: [], cursor: {} };
        throw new Error("history unavailable");
      },
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 400,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;
      prompt.reject(new TypeError("prompt response was lost"));

      await expect(sending).rejects.toMatchObject({ kind: "ambiguous" });
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("ambiguous");
    } finally {
      controller.dispose();
    }
  });

  it("reconcilePendingPrompt is authoritative and does not settle ambiguous as absent on unresolved scans", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    let historyCalls = 0;
    const generation = createGeneration(1, {
      inboxList: async () => [],
      historyList: async (input) => {
        historyCalls += 1;
        // Initial hydration load succeeds.
        if (historyCalls === 1) return { data: [], cursor: {} };
        // Reconciliation sees incomplete/cycling pagination.
        if (!input.cursor) return { data: [], cursor: { next: "loop" } } as SessionMessagesResponse;
        return { data: [], cursor: { next: "loop" } } as SessionMessagesResponse;
      },
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 400,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;
      prompt.reject(new TypeError("prompt response was lost"));
      await expect(sending).rejects.toMatchObject({ kind: "ambiguous" });

      const result = await controller.reconcilePendingPrompt(LOCAL_MESSAGE_ID);
      expect(result).toBe("unresolved");
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("ambiguous");
    } finally {
      controller.dispose();
    }
  });

  it("does not duplicate submission when HTTP response and reconciliation both observe admission", async () => {
    const promptCalled = deferred<void>();
    const inbox = userInbox(LOCAL_MESSAGE_ID, "steer");
    let promptCalls = 0;
    const generation = createGeneration(1, {
      inboxList: async () => [inbox],
    });
    generation.setPromptHandler(async () => {
      promptCalls += 1;
      promptCalled.resolve(undefined);
      // Simulate delayed HTTP response after transport uncertainty window; reconciliation may also find it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return inbox;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 2_000,
    });
    await controller.awaitReady();

    try {
      const submission = await controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      expect(submission.inboxId).toBe(LOCAL_MESSAGE_ID);
      expect(promptCalls).toBe(1);
      expect(generation.promptInputs).toHaveLength(1);
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("admitted");
    } finally {
      controller.dispose();
    }
  });

  it("triggers reconciliation when prompt HTTP remains pending past admission deadline", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    let inboxCalls = 0;
    const inbox = userInbox(LOCAL_MESSAGE_ID, "steer");
    const generation = createGeneration(1, {
      inboxList: async () => {
        inboxCalls += 1;
        // Initial auxiliary hydration empty; reconciliation finds admission.
        return inboxCalls >= 2 ? [inbox] : [];
      },
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise; // never resolves until test ends
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 100,
    });
    await controller.awaitReady();

    try {
      const seenExecutionTypes: string[] = [];
      const unsubscribe = controller.subscribe(() => {
        seenExecutionTypes.push(controller.getState().execution.type);
      });
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;

      await expect(sending).rejects.toMatchObject({ kind: "ambiguous" });
      await waitForState(
        controller,
        (state) => state.execution.type === "reconciling" || state.execution.type === "admitted",
      );
      await waitForState(controller, (state) => state.execution.type === "admitted");
      unsubscribe();
      expect(seenExecutionTypes).toContain("reconciling");
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("admitted");
      expect(inboxCalls).toBeGreaterThanOrEqual(2);
      expect(generation.promptInputs).toHaveLength(1);
    } finally {
      prompt.resolve(inbox);
      controller.dispose();
    }
  });

  it("keeps awaitPromptAdmission non-hanging after admission timeout and allows late HTTP success to settle once", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    const inbox = userInbox(LOCAL_MESSAGE_ID, "steer");
    const generation = createGeneration(1, {
      inboxList: async () => [],
      historyList: async () => ({ data: [], cursor: {} }),
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 80,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;

      await expect(sending).rejects.toMatchObject({ kind: "ambiguous" });
      await waitForState(controller, (state) => state.execution.type === "reconciling");
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("ambiguous");

      // Late HTTP success must still settle admitted exactly once.
      prompt.resolve(inbox);
      await waitForState(controller, (state) => state.execution.type === "admitted");
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("admitted");
      expect(generation.promptInputs).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  it("allows a late inbox event to settle a timed-out prompt as admitted exactly once", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    const inbox = userInbox(LOCAL_MESSAGE_ID, "steer");
    const generation = createGeneration(1, {
      inboxList: async () => [],
      historyList: async () => ({ data: [], cursor: {} }),
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 80,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;

      await expect(sending).rejects.toMatchObject({ kind: "ambiguous" });
      await waitForState(controller, (state) => state.execution.type === "reconciling");

      generation.events.emit({
        id: "evt_late_inbox",
        created: 100,
        type: "session.inbox.enqueued",
        durable: { aggregateID: SESSION_ID, seq: 10, version: 1 },
        data: {
          sessionID: SESSION_ID,
          inboxID: LOCAL_MESSAGE_ID,
          item: { type: "user", payload: { text: "controller test" }, delivery: "steer" },
        },
      } as any);

      await waitForState(controller, (state) => state.execution.type === "admitted");
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("admitted");
      expect(generation.promptInputs).toHaveLength(1);
    } finally {
      prompt.resolve(inbox);
      controller.dispose();
    }
  });

  it("settles active execution state from locally hydrated inbox evidence", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    const inbox = userInbox(LOCAL_MESSAGE_ID, "steer");
    let inboxCalls = 0;
    const generation = createGeneration(1, {
      inboxList: async () => {
        inboxCalls += 1;
        // Initial auxiliary hydration empty; later resync/reconciliation sees inbox.
        return inboxCalls >= 2 ? [inbox] : [];
      },
      historyList: async () => ({ data: [], cursor: {} }),
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 80,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;
      await expect(sending).rejects.toMatchObject({ kind: "ambiguous" });
      await waitForState(
        controller,
        (state) => state.execution.type === "reconciling" || state.execution.type === "admitted",
      );

      // Hydrate inbox into local state, then reconciliation should settle execution from local evidence.
      await controller.resyncAuxiliary();
      await waitForState(controller, (state) => state.inboxById[LOCAL_MESSAGE_ID] !== undefined);
      await waitForState(controller, (state) => state.execution.type === "admitted");
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("admitted");
      expect(controller.getState().inboxById[LOCAL_MESSAGE_ID]?.id).toBe(LOCAL_MESSAGE_ID);
    } finally {
      prompt.resolve(inbox);
      controller.dispose();
    }
  });

  it("settles admission from locally hydrated persisted-history evidence without inbox cancellation or fabricated metadata", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    let historyCalls = 0;
    const generation = createGeneration(1, {
      inboxList: async () => [],
      historyList: async () => {
        historyCalls += 1;
        // Initial hydration empty; later history read shows persisted user message.
        if (historyCalls === 1) return { data: [], cursor: {} };
        return { data: [userMessage(LOCAL_MESSAGE_ID)], cursor: {} } as SessionMessagesResponse;
      },
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 80,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;
      await expect(sending).rejects.toMatchObject({ kind: "ambiguous" });
      await waitForState(
        controller,
        (state) => state.execution.type === "reconciling" || state.execution.type === "admitted",
      );

      // Refresh/history hydration provides local persisted-message evidence.
      await controller.refresh();
      await waitForState(controller, (state) => state.messages[LOCAL_MESSAGE_ID] !== undefined);
      await waitForState(controller, (state) => state.execution.type === "admitted");
      expect(controller.getState().execution).toMatchObject({
        type: "admitted",
        userMessageId: LOCAL_MESSAGE_ID,
        inboxId: null,
        delivery: null,
      });
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("admitted");
      expect(generation.inboxCancelInputs).toHaveLength(0);
    } finally {
      prompt.resolve(userInbox(LOCAL_MESSAGE_ID, "steer"));
      controller.dispose();
    }
  });

  it("aborts a never-resolving inbox reconciliation request within its deadline", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    const inboxAbort = deferred<void>();
    let inboxCalls = 0;
    const generation = createGeneration(1, {
      inboxList: async (_input, signal) => {
        inboxCalls += 1;
        if (inboxCalls === 1) return [];
        signal.addEventListener("abort", () => inboxAbort.resolve(undefined), { once: true });
        return await new Promise<any[]>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
      historyList: async () => ({ data: [], cursor: {} }),
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 300,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;
      prompt.reject(new TypeError("prompt response was lost"));

      await expect(sending).rejects.toMatchObject({ kind: "ambiguous" });
      await inboxAbort.promise;
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("ambiguous");
      expect(inboxCalls).toBeGreaterThanOrEqual(2);
      expect(generation.promptInputs).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  it("aborts a never-resolving history reconciliation request within its deadline", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    const historyAbort = deferred<void>();
    let historyCalls = 0;
    const generation = createGeneration(1, {
      inboxList: async () => [],
      historyList: async (_input, signal) => {
        historyCalls += 1;
        if (historyCalls === 1) return { data: [], cursor: {} };
        signal.addEventListener("abort", () => historyAbort.resolve(undefined), { once: true });
        return await new Promise<any>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 300,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;
      prompt.reject(new TypeError("prompt response was lost"));

      await expect(sending).rejects.toMatchObject({ kind: "ambiguous" });
      await historyAbort.promise;
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("ambiguous");
      expect(historyCalls).toBeGreaterThanOrEqual(2);
      expect(generation.promptInputs).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  it("bounds a multi-page reconciliation scan by the overall deadline, including a never-resolving page request", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    const pageAbort = deferred<void>();
    let historyCalls = 0;
    const generation = createGeneration(1, {
      inboxList: async () => [],
      historyList: async (input, signal) => {
        historyCalls += 1;
        if (historyCalls === 1) return { data: [], cursor: {} };
        if (!input.cursor) {
          return {
            data: [userMessage("msg_other_1")],
            cursor: { next: "cursor-2" },
          } as SessionMessagesResponse;
        }
        // Second reconciliation page never resolves; overall deadline must abort it.
        signal.addEventListener("abort", () => pageAbort.resolve(undefined), { once: true });
        return await new Promise<any>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 250,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;
      prompt.reject(new TypeError("prompt response was lost"));

      await expect(sending).rejects.toMatchObject({ kind: "ambiguous" });
      await pageAbort.promise;
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("ambiguous");
      expect(historyCalls).toBeGreaterThanOrEqual(3);
    } finally {
      controller.dispose();
    }
  });

  it("preserves accurate inbox admission metadata for queue delivery", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    const inbox = userInbox(LOCAL_MESSAGE_ID, "queue");
    let inboxCalls = 0;
    const generation = createGeneration(1, {
      inboxList: async () => {
        inboxCalls += 1;
        return inboxCalls >= 2 ? [inbox] : [];
      },
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 2_000,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "queue",
      });
      await promptCalled.promise;
      prompt.reject(new TypeError("prompt response was lost"));

      const submission = await sending;
      expect(submission).toEqual({
        messageId: LOCAL_MESSAGE_ID,
        inboxId: LOCAL_MESSAGE_ID,
        delivery: "queue",
      });
      expect(controller.getState().execution).toMatchObject({
        type: "admitted",
        inboxId: LOCAL_MESSAGE_ID,
        delivery: "queue",
      });
    } finally {
      controller.dispose();
    }
  });

  it("history-only admission preserves pending execution state and does not fabricate inbox metadata", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    let historyCalls = 0;
    const generation = createGeneration(1, {
      inboxList: async () => [],
      historyList: async () => {
        historyCalls += 1;
        if (historyCalls === 1) return { data: [], cursor: {} };
        return { data: [userMessage(LOCAL_MESSAGE_ID)], cursor: {} } as SessionMessagesResponse;
      },
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 2_000,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "queue",
      });
      await promptCalled.promise;
      prompt.reject(new TypeError("prompt response was lost"));

      const submission = await sending;
      expect(submission).toEqual({ messageId: LOCAL_MESSAGE_ID, inboxId: null, delivery: null });
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("admitted");
      expect(controller.getState().execution).toMatchObject({
        type: "admitted",
        userMessageId: LOCAL_MESSAGE_ID,
        inboxId: null,
        delivery: null,
      });
      expect(controller.getState().execution.type).not.toBe("idle");
      expect(generation.inboxCancelInputs).toHaveLength(0);
    } finally {
      controller.dispose();
    }
  });

  it("history-only admission while execution is running preserves running execution state", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    let historyCalls = 0;
    const generation = createGeneration(1, {
      inboxList: async () => [],
      historyList: async () => {
        historyCalls += 1;
        if (historyCalls <= 2) return { data: [], cursor: {} };
        return { data: [userMessage(LOCAL_MESSAGE_ID)], cursor: {} } as SessionMessagesResponse;
      },
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 120,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;
      prompt.reject(new TypeError("prompt response was lost"));
      await expect(sending).rejects.toMatchObject({ kind: "ambiguous" });
      await waitForState(controller, (state) => state.execution.type === "reconciling");

      // Execution evidence arrives while admission is still being reconciled.
      generation.events.emit({
        id: "evt_exec_started",
        created: 100,
        type: "session.execution.started",
        durable: { aggregateID: SESSION_ID, seq: 11, version: 1 },
        data: { sessionID: SESSION_ID },
      } as any);
      await waitForState(controller, (state) => state.execution.type === "executing");

      const result = await controller.reconcilePendingPrompt(LOCAL_MESSAGE_ID);
      expect(result).toBe("admitted");
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("admitted");
      expect(controller.getState().execution.type).toBe("executing");
      expect(generation.inboxCancelInputs).toHaveLength(0);
    } finally {
      controller.dispose();
    }
  });

  it("history-only admission with cancellation requested does not report cancellation completed", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    let historyCalls = 0;
    const generation = createGeneration(1, {
      inboxList: async () => [],
      historyList: async () => {
        historyCalls += 1;
        if (historyCalls === 1) return { data: [], cursor: {} };
        return { data: [userMessage(LOCAL_MESSAGE_ID)], cursor: {} } as SessionMessagesResponse;
      },
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 2_000,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;
      // Request cancel while prompt is still submitting (before transport ambiguity settles).
      await controller.cancel();
      prompt.reject(new TypeError("prompt response was lost"));

      const submission = await sending;
      expect(submission).toEqual({ messageId: LOCAL_MESSAGE_ID, inboxId: null, delivery: null });
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("admitted");
      // Cancellation cannot be performed from history-only evidence; must not be reported completed.
      expect(controller.getState().execution.type).not.toBe("idle");
      expect(controller.getState().execution).toMatchObject({
        type: "admitted",
        userMessageId: LOCAL_MESSAGE_ID,
        inboxId: null,
        delivery: null,
        cancelRequested: true,
      });
      expect(generation.inboxCancelInputs).toHaveLength(0);
    } finally {
      controller.dispose();
    }
  });

  it("does not automatically resubmit prompts during timeout/reconciliation", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    const generation = createGeneration(1, {
      inboxList: async () => [],
      historyList: async () => ({ data: [], cursor: {} }),
    });
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 120,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;
      await expect(sending).rejects.toMatchObject({ kind: "ambiguous" });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(generation.promptInputs).toHaveLength(1);
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("ambiguous");
    } finally {
      prompt.resolve(userInbox(LOCAL_MESSAGE_ID, "steer"));
      controller.dispose();
    }
  });

  it("does not let a stale generation settle or dispatch admission after generation changes", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    const staleInboxLookup = deferred<any[]>();
    const staleInboxCalled = deferred<void>();
    const inbox = userInbox(LOCAL_MESSAGE_ID, "steer");
    let gen1InboxCalls = 0;

    const generation1 = createGeneration(1, {
      inboxList: async () => {
        gen1InboxCalls += 1;
        // Initial auxiliary hydration should complete; reconciliation call blocks.
        if (gen1InboxCalls === 1) return [];
        staleInboxCalled.resolve(undefined);
        return await staleInboxLookup.promise;
      },
    });
    generation1.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });

    const generation2 = createGeneration(2, {
      inboxList: async () => [],
      historyList: async () => ({ data: [], cursor: {} }),
    });

    const controller = createV2ThreadController(createClient([generation1, generation2]), {
      promptAdmissionTimeoutMs: 1_500,
      initialReconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "steer",
      });
      await promptCalled.promise;
      prompt.reject(new TypeError("prompt response was lost"));

      await waitForState(controller, (state) => state.execution.type === "reconciling");
      await staleInboxCalled.promise;

      // Force a new attempt/generation while stale reconciliation is in-flight.
      generation1.events.fail(new Error("connection dropped"));
      await controller.awaitReady();

      // Stale generation now "finds" admission, but must not settle/dispatch into active generation.
      staleInboxLookup.resolve([inbox]);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const admission = await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID);
      expect(admission).not.toBe("admitted");
      expect(controller.getState().inboxById[LOCAL_MESSAGE_ID]).toBeUndefined();

      // The original send may resolve/reject based on reconnect semantics; it must not be admitted by stale reconciliation.
      await Promise.race([
        sending.then(
          () => undefined,
          () => undefined,
        ),
        new Promise((resolve) => setTimeout(resolve, 20)),
      ]);
    } finally {
      staleInboxLookup.resolve([]);
      controller.dispose();
    }
  });
});
