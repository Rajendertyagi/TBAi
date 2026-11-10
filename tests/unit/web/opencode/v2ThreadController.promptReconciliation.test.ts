import { describe, expect, it } from "bun:test";
import type { SessionInboxUser, SessionMessageInfo, SessionMessagesResponse } from "@opencode/client";
import {
  createV2ThreadController,
} from "@web/features/opencode/v2ThreadController.ts";
import {
  DIRECTORY,
  LOCAL_MESSAGE_ID,
  SESSION,
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
      expect(submission.messageId).toBe(LOCAL_MESSAGE_ID);
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("admitted");
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
          return { data: [userMessage("msg_other_1")], cursor: { next: "cursor-a" } } as SessionMessagesResponse;
        }
        if (input.cursor === "cursor-a") {
          return { data: [userMessage("msg_other_2")], cursor: { next: "cursor-a" } } as SessionMessagesResponse;
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
    const prompt = deferred<SessionInboxUser>();
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
