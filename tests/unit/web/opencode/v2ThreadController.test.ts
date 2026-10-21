import { describe, expect, it } from "bun:test";
import { REPO_ROOT } from "../../../helpers/repo-root";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  PermissionReplyInput,
  PermissionRequest,
  SessionInboxUser,
  V2Event,
} from "@opencode/client";
import { OpenCodeBashToolUI } from "@web/tools/opencode/ui";
import { projectV2RepositoryItems } from "@web/features/opencode/v2MessageProjection.ts";
import {
  createV2ThreadController,
  type V2ThreadController,
} from "@web/features/opencode/v2ThreadController.ts";
import { computeReconnectDelay } from "@web/features/opencode/sync/eventPipeline.ts";
import { clearAllAutoPolicies, setAutoPolicy } from "@web/features/opencode/sessionAutoPolicy.ts";
import {
  createInitialV2ThreadState,
  reduceV2ThreadState,
} from "@web/features/opencode/v2Events.ts";
import { QUESTION_PERMISSION_ACTION } from "@web/features/permissions/permissionPolicy";
import { resetClientTransportForTests } from "@web/lib/log-transport";
import { stripComments } from "@web/testing/source-scope";
import {
  ASSISTANT_TOOL_MESSAGE,
  EVENT_INBOX_ID,
  FORM_CANCEL,
  FORM_CANCEL_ID,
  FORM_REPLY,
  FORM_REPLY_ID,
  HTTP_INBOX_ID,
  LIVE_ASSISTANT_MESSAGE_ID,
  LOCAL_MESSAGE_ID,
  PERMISSION,
  PERMISSION_ID,
  SERVER_VERSION,
  SESSION_ID,
  STALE_ASSISTANT_MESSAGE_ID,
  USER_MESSAGE,
  assistantTextDelta,
  assistantTextStarted,
  createClient,
  createGeneration,
  createRejectingAfterFirstClient,
  deferred,
  inboxEvent,
  staleAssistantEvent,
  userInbox,
  waitForState,
  type FakeGeneration,
} from "@web/testing/opencode/v2ThreadControllerHarness";

describe("native V2 thread controller lifecycle", () => {
  it("hydrates authoritative state and resolves readiness once", async () => {
    const inbox = userInbox("inbox_initial", "queue");
    const generation = createGeneration(1, {
      inboxList: async () => [inbox],
      permissionList: async () => [PERMISSION],
      formList: async () => [FORM_REPLY, FORM_CANCEL],
    });
    const client = createClient([generation]);
    const controller = createV2ThreadController(client);

    try {
      await controller.awaitReady();
      const state = controller.getState();

      expect(client.connectCount).toBe(1);
      expect(state.connection).toEqual({ type: "connected", serverVersion: SERVER_VERSION });
      expect(state.load).toEqual({ type: "ready" });
      expect(state.session?.id).toBe(SESSION_ID);
      expect(Object.keys(state.inboxById)).toEqual([inbox.id]);
      expect(state.permissions).toEqual([PERMISSION]);
      expect(state.forms).toEqual([FORM_REPLY, FORM_CANCEL]);
    } finally {
      controller.dispose();
    }
  });

  it("projects assistant text events received after initial hydration", async () => {
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();
      generation.events.emit(assistantTextStarted());
      generation.events.emit(assistantTextDelta());
      await waitForState(
        controller,
        (state) =>
          state.messages[LIVE_ASSISTANT_MESSAGE_ID]?.parts.some(
            (part) => part.kind === "text" && part.value === "live response",
          ) === true,
      );

      const message = controller.getState().messages[LIVE_ASSISTANT_MESSAGE_ID];
      expect(message?.parts).toEqual([
        {
          kind: "text",
          id: `text:${LIVE_ASSISTANT_MESSAGE_ID}:0`,
          order: 0,
          value: "live response",
          status: "streaming",
        },
      ]);
      expect(controller.getState().execution.type).toBe("idle");
    } finally {
      controller.dispose();
    }
  });

  it("isolates auxiliary hydration failures without failing the primary load", async () => {
    const generation = createGeneration(1, {
      inboxList: async () => {
        throw new TypeError("inbox unavailable");
      },
      permissionList: async () => {
        throw new TypeError("permissions unavailable");
      },
      formList: async () => {
        throw new TypeError("forms unavailable");
      },
    });
    const client = createClient([generation]);
    const controller = createV2ThreadController(client);

    try {
      await controller.awaitReady();
      const state = controller.getState();

      expect(state.load).toEqual({ type: "ready" });
      expect(state.session?.id).toBe(SESSION_ID);
      expect(state.inboxById).toEqual({});
      expect(state.permissions).toEqual([]);
      expect(state.forms).toEqual([]);
    } finally {
      controller.dispose();
    }
  });

  it("reprojects hydrated tool history after permission hydration", async () => {
    const generation = createGeneration(1, {
      historyList: async () => ({ data: [ASSISTANT_TOOL_MESSAGE], cursor: {} }),
      permissionList: async () => [PERMISSION],
    });
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();
      const part = controller.getState().messages[ASSISTANT_TOOL_MESSAGE.id]?.parts[0];
      expect(part).toMatchObject({ kind: "tool", permissionId: PERMISSION_ID });
    } finally {
      controller.dispose();
    }
  });

  it("reconnects on a new generation and never applies buffered stale-generation events", async () => {
    const first = createGeneration(1);
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client);

    try {
      await controller.awaitReady();
      first.events.emit(staleAssistantEvent());
      queueMicrotask(() => first.events.fail(new Error("event stream failed")));

      await client.waitForConnect(2);
      await waitForState(controller, (state) => state.load.type === "ready");

      expect(client.connectCount).toBe(2);
      expect(first.events.closeCount).toBe(1);
      expect(controller.getState().messages[STALE_ASSISTANT_MESSAGE_ID]).toBeUndefined();
    } finally {
      controller.dispose();
    }
  });
});

describe("native V2 reconnect delay", () => {
  it("doubles from the initial delay and saturates at the cap", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 7, 20].map((attempt) => computeReconnectDelay(attempt));
    expect(delays).toEqual([250, 500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
  });

  it("honours an injected delay budget", () => {
    const budget = { initialReconnectDelayMs: 10, maxReconnectDelayMs: 40 };
    const delays = [0, 1, 2, 3, 10].map((attempt) => computeReconnectDelay(attempt, budget));
    expect(delays).toEqual([10, 20, 40, 40, 40]);
  });
});

describe("native V2 retry budget and disposal", () => {
  it("reaches the terminal gate after consecutive connect failures with no successful hydration", async () => {
    // Only one generation: connect succeeds once, then every retry rejects.
    // No hydrate ever succeeds on retries, so reconnectAttempt never resets.
    const generation = createGeneration(1);
    const client = createRejectingAfterFirstClient([generation]);
    const controller = createV2ThreadController(client, {
      maxReconnectAttempts: 3,
      initialReconnectDelayMs: 10,
    });

    try {
      await controller.awaitReady();
      generation.events.fail(new Error("event stream failed"));

      await waitForState(controller, (state) => state.connection.type === "failed");

      expect(client.connectCount).toBe(4); // 1 initial success + 3 rejected retries (budget=3)
      expect(controller.getState().connection).toEqual({ type: "failed", attempt: 3 });
      expect(controller.getState().load.type).toBe("error");
    } finally {
      controller.dispose();
    }
  });

  it("dispose clears pending retry timer and settles readiness", async () => {
    const generation = createGeneration(1);
    const client = createRejectingAfterFirstClient([generation]);
    const controller = createV2ThreadController(client, {
      maxReconnectAttempts: 3,
      initialReconnectDelayMs: 60_000,
    });

    try {
      await controller.awaitReady();
      generation.events.fail(new Error("event stream failed"));
      await waitForState(controller, (state) => state.connection.type === "reconnecting");

      controller.dispose();

      // Advance well past the 60s retry delay — no further connect should occur.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client.connectCount).toBe(1);
      expect(controller.getState().connection.type).toBe("reconnecting");
    } finally {
      controller.dispose();
    }
  });

  it("manual load during a pending timer cancels the timer and takes over", async () => {
    const generation = createGeneration(1);
    const client = createRejectingAfterFirstClient([generation]);
    const controller = createV2ThreadController(client, {
      maxReconnectAttempts: 3,
      initialReconnectDelayMs: 5_000,
    });

    try {
      await controller.awaitReady();
      generation.events.fail(new Error("event stream failed"));

      await waitForState(controller, (state) => state.connection.type === "reconnecting");

      const loadPromise = controller.load();
      await expect(loadPromise).rejects.toBeDefined();

      // Only 2 connects: initial + manual take-over. No timer-fired connect.
      expect(client.connectCount).toBe(2);
    } finally {
      controller.dispose();
    }
  });
});

describe("native V2 prompt admission", () => {
  it("keeps a prompt submitting until the HTTP response admits it", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    const generation = createGeneration(1);
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const client = createClient([generation]);
    const controller = createV2ThreadController(client);
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "queue",
      });
      await promptCalled.promise;

      expect(controller.getState().execution).toEqual({
        type: "submitting",
        userMessageId: LOCAL_MESSAGE_ID,
        cancelRequested: false,
      });

      prompt.resolve(userInbox(HTTP_INBOX_ID, "queue"));
      expect(await sending).toEqual({
        messageId: LOCAL_MESSAGE_ID,
        inboxId: HTTP_INBOX_ID,
        delivery: "queue",
      });
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("admitted");
      expect(Object.keys(controller.getState().inboxById)).toEqual([HTTP_INBOX_ID]);
    } finally {
      controller.dispose();
    }
  });

  it("applies an inbox event once before the matching HTTP response resolves", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    const generation = createGeneration(1);
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const client = createClient([generation]);
    const controller = createV2ThreadController(client);
    await controller.awaitReady();

    try {
      let sendSettled = false;
      const sending = controller
        .sendMessage(USER_MESSAGE, {
          messageId: LOCAL_MESSAGE_ID,
          delivery: "queue",
        })
        .then((submission) => {
          sendSettled = true;
          return submission;
        });
      await promptCalled.promise;
      generation.events.emit(inboxEvent(EVENT_INBOX_ID, LOCAL_MESSAGE_ID, "queue"));
      await waitForState(controller, (state) => state.inboxById[EVENT_INBOX_ID] !== undefined);
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("admitted");
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const settledByInboxEvent = sendSettled;

      expect(controller.getState().execution.type).toBe("admitted");
      expect(Object.keys(controller.getState().inboxById)).toEqual([EVENT_INBOX_ID]);

      prompt.resolve(userInbox(EVENT_INBOX_ID, "queue"));
      expect(await sending).toEqual({
        messageId: LOCAL_MESSAGE_ID,
        inboxId: EVENT_INBOX_ID,
        delivery: "queue",
      });
      expect(Object.keys(controller.getState().inboxById)).toEqual([EVENT_INBOX_ID]);
      expect(controller.getState().execution.type).toBe("admitted");
      expect(settledByInboxEvent).toBe(true);
    } finally {
      controller.dispose();
    }
  });

  it("cancels an ambiguous request locally and recovers admission without aborting the prompt", async () => {
    const prompt = deferred<SessionInboxUser>();
    const promptCalled = deferred<void>();
    const generation = createGeneration(1);
    generation.setPromptHandler(async () => {
      promptCalled.resolve(undefined);
      return await prompt.promise;
    });
    const client = createClient([generation]);
    const controller = createV2ThreadController(client);
    await controller.awaitReady();

    try {
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "queue",
      });
      await promptCalled.promise;
      await controller.cancel();
      expect(controller.getState().execution).toEqual({
        type: "cancelling",
        phase: "prompt-request",
        userMessageId: LOCAL_MESSAGE_ID,
        inboxId: null,
        assistantMessageId: null,
      });

      prompt.reject(new TypeError("prompt response was lost"));
      await waitForState(controller, (state) => state.execution.type === "reconciling");
      expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("ambiguous");
      expect(generation.inboxCancelInputs).toHaveLength(0);
      expect(generation.interruptInputs).toHaveLength(0);

      generation.events.emit(inboxEvent(EVENT_INBOX_ID, LOCAL_MESSAGE_ID, "queue"));
      await waitForState(controller, (state) => state.execution.type === "admitted");
      const admittedState = controller.getState().execution;
      expect(await sending).toEqual({
        messageId: LOCAL_MESSAGE_ID,
        inboxId: EVENT_INBOX_ID,
        delivery: "queue",
      });
      expect(generation.inboxCancelInputs).toHaveLength(0);
      expect(generation.interruptInputs).toHaveLength(0);
      expect(admittedState).toEqual({
        type: "admitted",
        userMessageId: LOCAL_MESSAGE_ID,
        inboxId: EVENT_INBOX_ID,
        delivery: "queue",
        cancelRequested: true,
      });
    } finally {
      controller.dispose();
    }
  });
});

describe("native V2 controller replies and disposal", () => {
  it("retires a permission once and suppresses a duplicate reply", async () => {
    const generation = createGeneration(1, {
      permissionList: async () => [PERMISSION],
    });
    const controller = createV2ThreadController(createClient([generation]));
    await controller.awaitReady();

    try {
      await controller.replyToPermission(PERMISSION_ID, "once");
      await controller.replyToPermission(PERMISSION_ID, "once");

      expect(generation.permissionReplyInputs).toEqual([
        {
          sessionID: SESSION_ID,
          requestID: PERMISSION_ID,
          decision: "once",
        },
      ]);
      expect(controller.getState().permissions).toEqual([]);
      expect(controller.getState().answeredPermissionIds).toEqual([PERMISSION_ID]);
    } finally {
      controller.dispose();
    }
  });

  it("retires replied and cancelled forms once while preserving distinct operations", async () => {
    const answer = { name: "Ada" };
    const generation = createGeneration(1, {
      formList: async () => [FORM_REPLY, FORM_CANCEL],
    });
    const controller = createV2ThreadController(createClient([generation]));
    await controller.awaitReady();

    try {
      await controller.replyToForm(FORM_REPLY_ID, answer);
      await controller.replyToForm(FORM_REPLY_ID, answer);
      await controller.rejectForm(FORM_CANCEL_ID);
      await controller.rejectForm(FORM_CANCEL_ID);

      expect(generation.formReplyInputs).toEqual([
        {
          sessionID: SESSION_ID,
          formID: FORM_REPLY_ID,
          answer,
        },
      ]);
      expect(generation.formCancelInputs).toEqual([
        {
          sessionID: SESSION_ID,
          formID: FORM_CANCEL_ID,
        },
      ]);
      expect(controller.getState().forms).toEqual([]);
    } finally {
      controller.dispose();
    }
  });

  it("aborts both scopes, closes events once, and settles pending admission on disposal", async () => {
    const promptCalled = deferred<void>();
    const generation = createGeneration(1);
    generation.setPromptHandler(async (_input, lifecycleSignal) => {
      promptCalled.resolve(undefined);
      return await new Promise<SessionInboxUser>((_resolve, reject) => {
        const abort = () => reject(new DOMException("disposed", "AbortError"));
        if (lifecycleSignal.aborted) abort();
        else lifecycleSignal.addEventListener("abort", abort, { once: true });
      });
    });
    const client = createClient([generation]);
    const controller = createV2ThreadController(client);
    await controller.awaitReady();
    const sending = controller.sendMessage(USER_MESSAGE, { messageId: LOCAL_MESSAGE_ID });
    await promptCalled.promise;
    let notifications = 0;
    controller.subscribe(() => {
      notifications += 1;
    });

    controller.dispose();
    controller.dispose();

    await expect(sending).rejects.toMatchObject({ kind: "disposed" });
    expect(await controller.awaitPromptAdmission(LOCAL_MESSAGE_ID)).toBe("disposed");
    expect(generation.events.closeCount).toBe(1);
    expect(client.signals).toHaveLength(1);
    expect(client.signals[0].connectionSignal.aborted).toBe(true);
    expect(client.signals[0].lifecycleSignal.aborted).toBe(true);

    const disposedState = controller.getState();
    controller.setDesiredSelection({ model: null, agent: null });
    expect(controller.getState()).toBe(disposedState);
    expect(notifications).toBe(0);
  });
});

/**
 * The two approval paths that only exist once native events, the reducer, and
 * the assistant-ui projection run together. Each half is proven elsewhere:
 * `v2Events.test.ts` covers the reducers, `v2MessageProjection.test.ts` covers
 * linkage, and `ui.test.ts` covers what a given `approval` renders. What no test
 * held was the seam — that a real `permission.asked` reaches the shell card as
 * Approve/Deny, and that a failed execution with no permission reaches it as
 * nothing at all.
 */
const LIVE_SHELL_MESSAGE_ID = "assistant_live_shell";
const LIVE_SHELL_TOOL_ID = "tool_live_shell";
const LIVE_SHELL_PERMISSION_ID = "permission_live_shell";

const LIVE_SHELL_PERMISSION = {
  id: LIVE_SHELL_PERMISSION_ID,
  sessionID: SESSION_ID,
  action: "bash",
  resources: ["bun --version"],
  save: [],
  source: { type: "tool", messageID: LIVE_SHELL_MESSAGE_ID, id: LIVE_SHELL_TOOL_ID },
} as const satisfies PermissionRequest;

function shellToolStarted(): V2Event {
  return {
    id: "evt_live_shell_tool_started",
    created: 20,
    type: "session.tool.input.started",
    durable: { aggregateID: SESSION_ID, seq: 3, version: 1 },
    data: {
      sessionID: SESSION_ID,
      assistantMessageID: LIVE_SHELL_MESSAGE_ID,
      id: LIVE_SHELL_TOOL_ID,
      name: "shell",
    },
  };
}

function shellToolCalled(): V2Event {
  // `input.started` only opens the part with an empty `input`; the real args
  // arrive with `called`, which is what the card titles itself from.
  return {
    id: "evt_live_shell_tool_called",
    created: 21,
    type: "session.tool.called",
    durable: { aggregateID: SESSION_ID, seq: 4, version: 1 },
    data: {
      sessionID: SESSION_ID,
      assistantMessageID: LIVE_SHELL_MESSAGE_ID,
      id: LIVE_SHELL_TOOL_ID,
      input: { command: "bun --version" },
      executed: false,
    },
  };
}

function permissionAsked(): V2Event {
  return {
    id: "evt_live_permission_asked",
    created: 22,
    type: "permission.asked",
    // No `durable` here: the official `PermissionAsked` type carries none.
    data: LIVE_SHELL_PERMISSION,
  };
}

function executionFailed(): V2Event {
  return {
    id: "evt_live_execution_failed",
    created: 22,
    type: "session.execution.failed",
    durable: { aggregateID: SESSION_ID, seq: 5, version: 1 },
    data: {
      sessionID: SESSION_ID,
      error: { type: "provider.quota", message: "provider rejected the request", status: 429 },
    },
  };
}

function projectedToolCalls(controller: V2ThreadController) {
  return projectV2RepositoryItems(controller.getState()).flatMap((item) =>
    Array.isArray(item.message.content)
      ? item.message.content.filter(
          (part): part is Extract<typeof part, { readonly type: "tool-call" }> =>
            part.type === "tool-call",
        )
      : [],
  );
}

describe("native V2 approval seams", () => {
  it("links a live permission.asked to its shell tool and renders Approve/Deny", async () => {
    // No hydrated permission: the ONLY source is the native event, so this
    // proves the live event path rather than the reload path.
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();
      generation.events.emit(shellToolStarted());
      generation.events.emit(shellToolCalled());
      generation.events.emit(permissionAsked());
      await waitForState(controller, (state) =>
        state.permissions.some((entry) => entry.id === LIVE_SHELL_PERMISSION_ID),
      );

      const shell = projectedToolCalls(controller).find((part) => part.toolName === "shell");
      expect(shell).toBeDefined();
      // The linkage itself: the native source ids resolved to this exact part.
      expect(shell?.approval).toMatchObject({ id: LIVE_SHELL_PERMISSION_ID });

      // And the user-facing half, through the real renderer the toolkit maps
      // `shell` to — the same component `bash` uses.
      const html = renderToStaticMarkup(createElement(OpenCodeBashToolUI, shell));
      expect(html).toContain("shell · bun --version");
      expect(html).toContain("Approve");
      expect(html).toContain("Deny");
    } finally {
      controller.dispose();
    }
  });

  it("exposes no approval card when an execution fails without permission.asked", async () => {
    // A tool part is on screen and the run then fails provider-side. Nothing
    // asked for permission, so nothing may render one: an approval card here
    // would offer the user a decision the server never requested.
    const generation = createGeneration(1, {
      historyList: async () => ({ data: [ASSISTANT_TOOL_MESSAGE], cursor: {} }),
      permissionList: async () => [],
    });
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();
      generation.events.emit(executionFailed());
      await waitForState(controller, (state) => state.execution.type === "error");

      // The failure really landed, so the assertions below are not vacuous.
      expect(controller.getState().execution).toMatchObject({
        type: "error",
        error: { message: "provider rejected the request", status: 429 },
      });
      expect(controller.getState().permissions).toEqual([]);

      const shell = projectedToolCalls(controller).find((part) => part.toolName === "shell");
      expect(shell).toBeDefined();
      expect(shell?.approval).toBeUndefined();
    } finally {
      controller.dispose();
    }
  });
});

/**
 * The Auto shield's ARM path (`applyAutoApproveEvent`).
 *
 * ## The bug this pins
 *
 * `reconcileAutoApprove` DRAINS the permissions that were already pending when
 * the shield was switched on. It does not answer permissions that arrive
 * AFTERWARDS, while the shield is still on — so the shield looked armed and was
 * not: the user switched Auto on, the agent asked for something new, and
 * nothing was ever sent. The cause was structural, not a typo:
 * `getAutoPolicy()` had NO production reader at all, so the event path had no
 * way to know the shield was on.
 *
 * The fix adds `applyAutoApproveEvent()` beside `dispatch`/`applyEvent` in the
 * controller. It lives in the controller precisely because answering a
 * permission is an async transport call, and `v2Events.ts` is a pure reducer
 * that must stay pure — hence the source guard at the bottom of this block.
 *
 * These cases drive the REAL controller through the existing harness, so what
 * they pin is the seam: a real `permission.asked` arriving over a real event
 * stream, with a real policy cache, and the transport call that results.
 */
const ARM_PERMISSION_ID = "permission_arm_test";
const ARM_SECOND_PERMISSION_ID = "permission_arm_second_test";
const ARM_UNLINKED_PERMISSION_ID = "permission_arm_unlinked_test";
const ARM_CUSTOM_KIND_PERMISSION_ID = "permission_arm_custom_kind_test";

/** The policy value the arm path is required to send, from `permissionPolicy`. */
const EXPECTED_AUTO_DECISION: PermissionReplyInput["decision"] = "once";

/**
 * A `permission.asked` for an arbitrary id, so several cases can arm against
 * DISTINCT requests (the controller answers each request id at most once, so a
 * shared id would make the "read at event time" case pass for the wrong reason).
 *
 * `source` is omitted by default: the official `PermissionAsked` type makes it
 * optional, and the arm path covers unlinked requests on purpose.
 *
 * `action` defaults to the existing bash-shaped case and is passed explicitly
 * only by the action-aware cases below, so no existing case changes meaning.
 */
function armPermissionAsked(
  id: string,
  source?: PermissionRequest["source"],
  action = "bash",
): V2Event {
  return {
    id: `evt_arm_${id}`,
    created: 30,
    type: "permission.asked",
    data: {
      id,
      sessionID: SESSION_ID,
      action,
      resources: ["bun --version"],
      ...(source === undefined ? {} : { source }),
    } as PermissionRequest,
  };
}

/**
 * A permission that was ALREADY pending when the controller loaded, as
 * `permissionList` returns it.
 *
 * Linked to a tool card, because the drain (`reconcileAutoApprove`) only touches
 * requests with a linked tool call — an unlinked one renders in the fallback
 * panel instead. Hydration records these into state and does NOT arm them; the
 * arm path is for events, so what happens to a pending request afterwards is
 * the drain's business alone.
 */
function pendingPermission(id: string, action: string): PermissionRequest {
  return {
    id,
    sessionID: SESSION_ID,
    action,
    resources: ["D:\\workspace"],
    save: [],
    source: { type: "tool", messageID: "assistant-1", id: `tool_${id}` },
  };
}

/**
 * Let the controller's fire-and-forget auto-reply settle.
 *
 * The arm path deliberately does NOT await its transport call (the event loop
 * must never block on a permission round-trip), so a case that asserts on the
 * reply has to yield the microtask queue for the call to be made. A single
 * macrotask turn drains every already-queued microtask, which is what a
 * resolved promise chain needs — this is not a timing workaround for a race in
 * the code under test, it is waiting for the deliberate non-await.
 */
function settleAsyncWork(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Ids the fake transport was asked to reply to, in order. */
function repliedIds(generation: FakeGeneration): readonly string[] {
  return generation.permissionReplyInputs.map((input) => input.requestID);
}

/** The shield state this session is in: armed, explicitly off, or unknown. */
type PolicyState = "armed" | "off" | "unknown";

/**
 * Puts the runtime policy cache in one of the three states a case needs.
 *
 * "unknown" is distinct from "off" on purpose: `getAutoPolicy` must treat an
 * absent entry as Manual (fail closed), and a case that only ever sets `false`
 * would not catch a regression that read the cache as "present means armed".
 */
function setShieldPolicy(state: PolicyState): void {
  clearAllAutoPolicies();
  if (state === "armed") setAutoPolicy(SESSION_ID, true);
  if (state === "off") setAutoPolicy(SESSION_ID, false);
}

describe("native V2 auto-approve arm path", () => {
  it("answers a permission that arrives while the shield is already on", async () => {
    setShieldPolicy("armed");
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();
      // Nothing was pending when the shield went on, so the DRAIN has nothing to
      // do — only the arm path can produce this reply. That is what makes this
      // case non-vacuous: it cannot pass via `reconcileAutoApprove`.
      expect(await controller.reconcileAutoApprove()).toBe(0);
      expect(repliedIds(generation)).toEqual([]);

      generation.events.emit(armPermissionAsked(ARM_PERMISSION_ID));
      await waitForState(controller, (state) =>
        state.permissions.some((entry) => entry.id === ARM_PERMISSION_ID),
      );
      await settleAsyncWork();

      // Exactly one reply, and it is the one-time approval — never "always",
      // which would grant more than the shield promises.
      expect(generation.permissionReplyInputs).toEqual([
        {
          sessionID: SESSION_ID,
          requestID: ARM_PERMISSION_ID,
          decision: EXPECTED_AUTO_DECISION,
        },
      ]);
      // The permission left state, so the user is never asked about something
      // that was already answered.
      expect(
        controller.getState().permissions.some((entry) => entry.id === ARM_PERMISSION_ID),
      ).toBe(false);
      expect(controller.getState().answeredPermissionIds).toEqual([ARM_PERMISSION_ID]);
    } finally {
      controller.dispose();
      clearAllAutoPolicies();
    }
  });

  it("fails closed when no policy was ever set for the session", async () => {
    setShieldPolicy("unknown");
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();
      generation.events.emit(armPermissionAsked(ARM_PERMISSION_ID));
      await waitForState(controller, (state) =>
        state.permissions.some((entry) => entry.id === ARM_PERMISSION_ID),
      );
      await settleAsyncWork();

      // Nothing may be sent: an unknown policy is not a permissive one.
      expect(generation.permissionReplyInputs).toEqual([]);
      // And the request is still the user's to answer.
      expect(
        controller.getState().permissions.some((entry) => entry.id === ARM_PERMISSION_ID),
      ).toBe(true);
    } finally {
      controller.dispose();
      clearAllAutoPolicies();
    }
  });

  it("fails closed when the shield is explicitly off", async () => {
    setShieldPolicy("off");
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();
      generation.events.emit(armPermissionAsked(ARM_PERMISSION_ID));
      await waitForState(controller, (state) =>
        state.permissions.some((entry) => entry.id === ARM_PERMISSION_ID),
      );
      await settleAsyncWork();

      expect(generation.permissionReplyInputs).toEqual([]);
      expect(
        controller.getState().permissions.some((entry) => entry.id === ARM_PERMISSION_ID),
      ).toBe(true);
    } finally {
      controller.dispose();
      clearAllAutoPolicies();
    }
  });

  it("reads the policy at event time, so turning the shield off stops arming", async () => {
    // The value must be read per event, never captured when the controller was
    // created or when the shield was first seen on. A captured `true` would keep
    // answering after the user switched Auto off — the exact opposite of what
    // the switch means.
    const generation = createGeneration(1);
    setShieldPolicy("armed");
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();

      generation.events.emit(armPermissionAsked(ARM_PERMISSION_ID));
      await waitForState(controller, (state) =>
        state.permissions.some((entry) => entry.id === ARM_PERMISSION_ID),
      );
      await settleAsyncWork();
      expect(repliedIds(generation)).toEqual([ARM_PERMISSION_ID]);

      // The user switches Auto OFF. A distinct request id, so "not answered"
      // cannot be explained by the first request already having been claimed.
      setAutoPolicy(SESSION_ID, false);
      generation.events.emit(armPermissionAsked(ARM_SECOND_PERMISSION_ID));
      await waitForState(controller, (state) =>
        state.permissions.some((entry) => entry.id === ARM_SECOND_PERMISSION_ID),
      );
      await settleAsyncWork();

      expect(repliedIds(generation)).toEqual([ARM_PERMISSION_ID]);
      expect(
        controller.getState().permissions.some((entry) => entry.id === ARM_SECOND_PERMISSION_ID),
      ).toBe(true);
    } finally {
      controller.dispose();
      clearAllAutoPolicies();
    }
  });

  it("answers a permission with no linked tool card", async () => {
    // Unlinked requests render ONLY in the fallback panel, so a user may have no
    // other way to answer them. That is why the arm path covers them even though
    // the DRAIN deliberately skips them (`reconcileAutoApprove` requires a
    // linked tool call). The drain is unchanged; this is the arm path only.
    setShieldPolicy("armed");
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();
      generation.events.emit(armPermissionAsked(ARM_UNLINKED_PERMISSION_ID));
      await waitForState(controller, (state) =>
        state.permissions.some((entry) => entry.id === ARM_UNLINKED_PERMISSION_ID),
      );
      await settleAsyncWork();

      expect(generation.permissionReplyInputs).toEqual([
        {
          sessionID: SESSION_ID,
          requestID: ARM_UNLINKED_PERMISSION_ID,
          decision: EXPECTED_AUTO_DECISION,
        },
      ]);
    } finally {
      controller.dispose();
      clearAllAutoPolicies();
    }
  });

  it("answers a permission whose source is not a tool source", async () => {
    // The mirror of the case above: a `source` that is present but is NOT
    // `{ type: "tool" }` links to nothing either, so it must be armed too. Built
    // through a cast because the official `PermissionSource` is the closed
    // `{ type: "tool", ... }` union — but this is a value arriving over the
    // wire, and the runtime is not obliged to honour a closed TypeScript union.
    setShieldPolicy("armed");
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();
      // `V2Event` is a discriminated union, so narrow it to the `permission.asked`
      // member to reach its payload before overriding `source`.
      const event = armPermissionAsked(ARM_CUSTOM_KIND_PERMISSION_ID);
      if (event.type !== "permission.asked") throw new Error("expected permission.asked");
      const unlinked = {
        ...event,
        data: {
          ...event.data,
          source: { type: "external", messageID: "assistant-1", id: "tool-1" },
        },
      } as unknown as V2Event;
      generation.events.emit(unlinked);
      await waitForState(controller, (state) =>
        state.permissions.some((entry) => entry.id === ARM_CUSTOM_KIND_PERMISSION_ID),
      );
      await settleAsyncWork();

      expect(repliedIds(generation)).toEqual([ARM_CUSTOM_KIND_PERMISSION_ID]);
    } finally {
      controller.dispose();
      clearAllAutoPolicies();
    }
  });

  it("sends exactly one reply for a redelivered permission event", async () => {
    // A reconnect can redeliver an event the runtime already published. Two
    // replies for one request id would be a double-approval, so the id is
    // claimed once and never released.
    setShieldPolicy("armed");
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();
      const event = armPermissionAsked(ARM_PERMISSION_ID);
      generation.events.emit(event);
      await waitForState(controller, (state) =>
        state.permissions.some((entry) => entry.id === ARM_PERMISSION_ID),
      );
      await settleAsyncWork();
      // The same event object, delivered again — a genuinely distinct second
      // event id would NOT be deduped, and the test would be claiming something
      // the code does not promise.
      generation.events.emit(event);
      await settleAsyncWork();

      expect(repliedIds(generation)).toEqual([ARM_PERMISSION_ID]);
    } finally {
      controller.dispose();
      clearAllAutoPolicies();
    }
  });

  it("contains a failed reply: no unhandled rejection, the stream keeps running", async () => {
    // An automatic acceptance is a side effect the user never asked for and
    // never sees. If its transport call rejected unhandled it would surface as a
    // global unhandled rejection — in the app, a red console and a destabilised
    // event loop; in CI, a random failure in whatever test happened to be
    // running. So the failure must be contained AND must not break the stream.
    const replyFailure = new Error("permission transport unavailable");
    setShieldPolicy("armed");
    const generation = createGeneration(1, {
      permissionReply: async () => {
        throw replyFailure;
      },
    });
    const controller = createV2ThreadController(createClient([generation]));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    // The contained failure is logged, and the client log transport BATCHES on a
    // 2s timer. Left alone, that timer outlives this case and fires a real
    // `POST /api/logs/client` into whatever test file runs next, whose fetch stub
    // records the URL and fails on an unexpected request. Resetting the
    // transport is the documented test seam for exactly this (`log-transport`
    // exposes it for this purpose), and the reset happens in `finally` so the
    // case cannot leak the queue even if an assertion above throws.
    resetClientTransportForTests();

    try {
      await controller.awaitReady();
      generation.events.emit(armPermissionAsked(ARM_PERMISSION_ID));
      await waitForState(controller, (state) =>
        state.permissions.some((entry) => entry.id === ARM_PERMISSION_ID),
      );
      await settleAsyncWork();

      // The reply WAS attempted (so this case is not passing because nothing
      // happened) and it did fail.
      expect(repliedIds(generation)).toEqual([ARM_PERMISSION_ID]);

      // The stream is unharmed: a later text event still reduces into state.
      // Were the rejection to have escaped `consumeEvents`, the controller would
      // have scheduled a reconnect and stopped reducing.
      generation.events.emit(assistantTextStarted());
      generation.events.emit(assistantTextDelta());
      await waitForState(
        controller,
        (state) =>
          state.messages[LIVE_ASSISTANT_MESSAGE_ID]?.parts.some(
            (part) => part.kind === "text" && part.value === "live response",
          ) === true,
      );
      // …and no reconnect was triggered by the failure.
      expect(controller.getState().connection.type).toBe("connected");

      // Nothing escaped as an unhandled rejection.
      expect(unhandled).toEqual([]);

      // The request is still pending, so the user (or the drain) can answer it.
      // A failed auto-approval must not silently drop a permission.
      expect(
        controller.getState().permissions.some((entry) => entry.id === ARM_PERMISSION_ID),
      ).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      controller.dispose();
      clearAllAutoPolicies();
      // Drop the queued failure log (and its timer) rather than letting it
      // escape into an unrelated test file.
      resetClientTransportForTests();
    }
  });
});

/**
 * Action-aware eligibility: a `question` needs no approval, everything else
 * still does.
 *
 * ## The bug this pins
 *
 * A user's `~/.config/opencode/opencode.json` carries
 * `{ "action": "question", "resource": "*", "effect": "ask" }`, so the
 * `question` tool raises a permission before it may ask anything. With the
 * shield in Manual the user clicked Approve on a card that protected no effect —
 * asking reads nothing, writes nothing, runs nothing — and only then got the
 * actual question form. Two clicks to ask one question.
 *
 * The fix is one predicate in `features/permissions/permissionPolicy.ts`
 * (`shouldAutoApprove(mode, action)`). These cases drive the REAL controller, so
 * what they pin is the wiring: the action is read off the wire request and
 * handed to that predicate, on BOTH automatic paths (the arm path and the
 * drain).
 *
 * `QUESTION_PERMISSION_ACTION` is imported from the policy module rather than
 * spelled here, because that module is the one place the wire value lives. The
 * actions that must KEEP asking are spelled deliberately: a negative case
 * written against a constant could only ever prove the constant agrees with
 * itself. `shell` is the action from a real observed V2 permission.
 */
const ARM_QUESTION_PERMISSION_ID = "permission_arm_question_test";
const ARM_SHELL_PERMISSION_ID = "permission_arm_shell_action_test";
const ARM_UNKNOWN_ACTION_PERMISSION_ID = "permission_arm_unknown_action_test";
const DRAIN_QUESTION_PERMISSION_ID = "permission_drain_question_test";
const DRAIN_SHELL_PERMISSION_ID = "permission_drain_shell_test";
const SHELL_PERMISSION_ACTION = "shell";
const UNRECOGNISED_PERMISSION_ACTION = "not_an_action_any_version_ships";

describe("native V2 auto-approve — a question needs no approval", () => {
  it("answers a question with the shield off, and leaves a shell request pending", async () => {
    // The load-bearing pair, in ONE state and ONE transport: the question is
    // answered and the shell is not. Neither reply can be explained by the
    // other, and neither can be explained by the drain (never called here), so
    // this cannot pass without the new logic running.
    setShieldPolicy("off");
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();
      generation.events.emit(
        armPermissionAsked(ARM_QUESTION_PERMISSION_ID, undefined, QUESTION_PERMISSION_ACTION),
      );
      generation.events.emit(
        armPermissionAsked(ARM_SHELL_PERMISSION_ID, undefined, SHELL_PERMISSION_ACTION),
      );
      await waitForState(controller, (state) =>
        state.permissions.some((entry) => entry.id === ARM_SHELL_PERMISSION_ID),
      );
      await settleAsyncWork();

      // Exactly one reply, the one-time approval. Under the old shield-only
      // rule this list was empty and both requests waited for the user.
      expect(generation.permissionReplyInputs).toEqual([
        {
          sessionID: SESSION_ID,
          requestID: ARM_QUESTION_PERMISSION_ID,
          decision: EXPECTED_AUTO_DECISION,
        },
      ]);
      // The question left state — the user is never asked about something that
      // was already answered.
      expect(
        controller.getState().permissions.some((entry) => entry.id === ARM_QUESTION_PERMISSION_ID),
      ).toBe(false);
      // …and the shell request is still the user's to answer.
      expect(controller.getState().permissions.map((entry) => entry.id)).toEqual([
        ARM_SHELL_PERMISSION_ID,
      ]);
    } finally {
      controller.dispose();
      clearAllAutoPolicies();
    }
  });

  it("answers a question and a shell request alike once the shield is on", async () => {
    // The regression guard in the other direction: the new rule must not
    // subtract anything from Auto, which accepted every request.
    setShieldPolicy("armed");
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();
      generation.events.emit(
        armPermissionAsked(ARM_QUESTION_PERMISSION_ID, undefined, QUESTION_PERMISSION_ACTION),
      );
      generation.events.emit(
        armPermissionAsked(ARM_SHELL_PERMISSION_ID, undefined, SHELL_PERMISSION_ACTION),
      );
      await waitForState(
        controller,
        (state) => !state.permissions.some((entry) => entry.id === ARM_SHELL_PERMISSION_ID),
      );
      await settleAsyncWork();

      expect(repliedIds(generation).slice().sort()).toEqual(
        [ARM_QUESTION_PERMISSION_ID, ARM_SHELL_PERMISSION_ID].sort(),
      );
      // Never "always" on either path: the automatic response is still "once".
      expect(generation.permissionReplyInputs.map((input) => input.decision)).toEqual([
        EXPECTED_AUTO_DECISION,
        EXPECTED_AUTO_DECISION,
      ]);
    } finally {
      controller.dispose();
      clearAllAutoPolicies();
    }
  });

  it("leaves an unrecognised action pending with the shield off", async () => {
    // Fail closed at the wire. An action nobody recognises is not a question,
    // and must not be rescued by the eligibility rule.
    setShieldPolicy("off");
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();
      generation.events.emit(
        armPermissionAsked(
          ARM_UNKNOWN_ACTION_PERMISSION_ID,
          undefined,
          UNRECOGNISED_PERMISSION_ACTION,
        ),
      );
      await waitForState(controller, (state) =>
        state.permissions.some((entry) => entry.id === ARM_UNKNOWN_ACTION_PERMISSION_ID),
      );
      await settleAsyncWork();

      expect(generation.permissionReplyInputs).toEqual([]);
      expect(controller.getState().permissions.map((entry) => entry.id)).toEqual([
        ARM_UNKNOWN_ACTION_PERMISSION_ID,
      ]);
    } finally {
      controller.dispose();
      clearAllAutoPolicies();
    }
  });

  it("leaves a request with no action field at all pending with the shield off", async () => {
    // The malformed-payload case. `action` is a required field of the official
    // type, but this is a value off the wire: the policy must treat an absent
    // action as "unknown" and ask, never as a match. Built through a cast for
    // the same reason the non-tool `source` case above is.
    setShieldPolicy("off");
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();
      const event = armPermissionAsked(ARM_UNKNOWN_ACTION_PERMISSION_ID);
      if (event.type !== "permission.asked") throw new Error("expected permission.asked");
      const { action: _absent, ...dataWithoutAction } = event.data;
      generation.events.emit({ ...event, data: dataWithoutAction } as unknown as V2Event);
      await waitForState(controller, (state) =>
        state.permissions.some((entry) => entry.id === ARM_UNKNOWN_ACTION_PERMISSION_ID),
      );
      await settleAsyncWork();

      expect(generation.permissionReplyInputs).toEqual([]);
      expect(controller.getState().permissions.map((entry) => entry.id)).toEqual([
        ARM_UNKNOWN_ACTION_PERMISSION_ID,
      ]);
    } finally {
      controller.dispose();
      clearAllAutoPolicies();
    }
  });
});

describe("native V2 auto-approve — the drain asks the same predicate", () => {
  it("drains a pending question with the shield off, and leaves a pending shell alone", async () => {
    // The drain is the second automatic path, so it must not be a blanket
    // "answer everything pending": under the old code it replied to both of
    // these without consulting anything.
    setShieldPolicy("off");
    const question = pendingPermission(DRAIN_QUESTION_PERMISSION_ID, QUESTION_PERMISSION_ACTION);
    const shell = pendingPermission(DRAIN_SHELL_PERMISSION_ID, SHELL_PERMISSION_ACTION);
    const generation = createGeneration(1, { permissionList: async () => [question, shell] });
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();
      expect(controller.getState().permissions.map((entry) => entry.id)).toEqual([
        question.id,
        shell.id,
      ]);

      expect(await controller.reconcileAutoApprove()).toBe(1);
      expect(generation.permissionReplyInputs).toEqual([
        {
          sessionID: SESSION_ID,
          requestID: DRAIN_QUESTION_PERMISSION_ID,
          decision: EXPECTED_AUTO_DECISION,
        },
      ]);
      expect(controller.getState().permissions.map((entry) => entry.id)).toEqual([shell.id]);
    } finally {
      controller.dispose();
      clearAllAutoPolicies();
    }
  });

  it("still drains every pending request once the shield is on", async () => {
    // The drain's existing promise, unchanged: Auto accepts what was already
    // waiting, with the one-time decision and nothing stronger.
    setShieldPolicy("armed");
    const question = pendingPermission(DRAIN_QUESTION_PERMISSION_ID, QUESTION_PERMISSION_ACTION);
    const shell = pendingPermission(DRAIN_SHELL_PERMISSION_ID, SHELL_PERMISSION_ACTION);
    const generation = createGeneration(1, { permissionList: async () => [question, shell] });
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();

      expect(await controller.reconcileAutoApprove()).toBe(2);
      expect(
        generation.permissionReplyInputs
          .map((input) => input.requestID)
          .slice()
          .sort(),
      ).toEqual([DRAIN_QUESTION_PERMISSION_ID, DRAIN_SHELL_PERMISSION_ID].sort());
      expect(new Set(generation.permissionReplyInputs.map((input) => input.decision))).toEqual(
        new Set([EXPECTED_AUTO_DECISION]),
      );
      expect(controller.getState().permissions).toEqual([]);
    } finally {
      controller.dispose();
      clearAllAutoPolicies();
    }
  });

  it("drains nothing at all when no policy was ever set for the session", async () => {
    // "Unknown" is not "permissive": the drain reads the same fail-closed policy
    // the arm path does, so an absent entry drains nothing.
    setShieldPolicy("unknown");
    const question = pendingPermission(DRAIN_QUESTION_PERMISSION_ID, QUESTION_PERMISSION_ACTION);
    const shell = pendingPermission(DRAIN_SHELL_PERMISSION_ID, SHELL_PERMISSION_ACTION);
    const generation = createGeneration(1, { permissionList: async () => [question, shell] });
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();

      // The question still goes: it needs no approval, so an unreadable shield
      // is irrelevant to it. The shell stays.
      expect(await controller.reconcileAutoApprove()).toBe(1);
      expect(repliedIds(generation)).toEqual([DRAIN_QUESTION_PERMISSION_ID]);
    } finally {
      controller.dispose();
      clearAllAutoPolicies();
    }
  });
});

/**
 * The reducer stays pure.
 *
 * Answering a permission is an async transport call, so the arm path had to go
 * somewhere other than `v2Events.ts`. This guard is what keeps that structural
 * decision from eroding: if a reply, a policy read, or an eligibility decision
 * ever moves into the reducer, the reducer stops being callable as a pure
 * function — and every test above would still pass, because the controller
 * would still be doing the work too.
 */
describe("native V2 auto-approve — the reducer stays pure", () => {
  it("v2Events.ts references no reply, no policy read, and no eligibility rule", async () => {
    // Comments are stripped first (per the repo's `source-scope` contract) so
    // prose DESCRIBING this rule can never satisfy an assertion about it.
    const source = stripComments(
      await Bun.file(path.join(REPO_ROOT, "web/src/features/opencode/v2Events.ts")).text(),
    );

    expect(source).not.toContain("replyToPermission");
    expect(source).not.toContain("permissionReply");
    expect(source).not.toContain("permission.reply");
    expect(source).not.toContain("getAutoPolicy");
    expect(source).not.toContain("shouldAutoApprove");
    expect(source).not.toContain("setAutoPolicy");
    // The policy vocabulary must not leak in by another name either.
    expect(source).not.toContain("AUTO_RESPONSE");
  });

  it("a permission.asked still reduces into state with the shield armed", async () => {
    // The behavioural half: reducing a `permission.asked` with the shield ON
    // must still ADD the permission. A reducer that auto-answered instead would
    // leave the user with a card for a decision the shield already made.
    setShieldPolicy("armed");
    try {
      const state = createInitialV2ThreadState(SESSION_ID);
      const event = armPermissionAsked(ARM_PERMISSION_ID);

      const next = reduceV2ThreadState(state, {
        type: "v2_event",
        event,
        ordinal: 1,
        mode: "observe-and-apply",
      });

      // The permission is present — the reducer records, it does not answer.
      expect(next.permissions.map((entry) => entry.id)).toEqual([ARM_PERMISSION_ID]);
      expect(next.answeredPermissionIds).toEqual([]);
      // And the input state is untouched, which is what "pure" means.
      expect(state.permissions).toEqual([]);
    } finally {
      clearAllAutoPolicies();
    }
  });
});
