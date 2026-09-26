import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppendMessage } from "@assistant-ui/react";
import type {
  FormInfo,
  MessageListInput,
  PermissionReplyInput,
  PermissionRequest,
  ServerInfo,
  SessionFormCancelInput,
  SessionMessageInfo,
  SessionFormReplyInput,
  SessionInfo,
  SessionInboxInfo,
  SessionInboxListInput,
  SessionInboxUser,
  SessionMessagesResponse,
  SessionPromptInput,
  V2Event,
} from "@opencode/client";
import { OpenCodeBashToolUI } from "@/tools/opencode/ui";
import {
  V2_GENERATION_BRAND,
  V2_HISTORY_READER_BRAND,
  type OpenCodeV2Client,
  type OpenCodeV2Generation,
  type OpenCodeV2GenerationOperations,
  type V2ConnectionSignals,
} from "./v2Client";
import { projectV2RepositoryItems } from "./v2MessageProjection";
import {
  createV2ThreadController,
  type V2ThreadController,
} from "./v2ThreadController";

const SESSION_ID = "ses_v2_controller_test";
const DIRECTORY = "D:\\workspace\\v2-controller-test";
const SERVER_VERSION = "2.0.16";
const LOCAL_MESSAGE_ID = "msg_local_controller_test";
const HTTP_INBOX_ID = "inbox_http_controller_test";
const EVENT_INBOX_ID = "inbox_event_controller_test";
const STALE_ASSISTANT_MESSAGE_ID = "msg_stale_controller_test";
const LIVE_ASSISTANT_MESSAGE_ID = "msg_live_controller_test";
const ASSISTANT_TOOL_MESSAGE: SessionMessageInfo = {
  id: "assistant-1",
  time: { created: 20 },
  type: "assistant",
  agent: "build",
  model: { id: "test-model", providerID: "test-provider" },
  content: [{
    type: "tool",
    id: "tool-1",
    name: "shell",
    state: { status: "running", input: { command: "bun --version" }, metadata: {} },
    time: { created: 20, ran: 21 },
  }],
};
const PERMISSION_ID = "permission_controller_test";
const FORM_REPLY_ID = "form_reply_controller_test";
const FORM_CANCEL_ID = "form_cancel_controller_test";
const EMPTY_HISTORY: SessionMessagesResponse = { data: [], cursor: {} };

const SERVER_INFO = {
  version: SERVER_VERSION,
  pid: 1,
  urls: [],
  paths: { tmp: "v2-controller-test" },
} as const satisfies ServerInfo;

const SESSION = {
  id: SESSION_ID,
  projectID: "project_controller_test",
  cost: 0,
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
  agent: "build",
  model: { id: "test-model", providerID: "test-provider" },
  time: { created: 1, updated: 2 },
  location: { directory: DIRECTORY },
} as const satisfies SessionInfo;

const PERMISSION = {
  id: PERMISSION_ID,
  sessionID: SESSION_ID,
  action: "bash",
  resources: ["D:\\workspace"],
  save: [],
  source: { type: "tool", messageID: "assistant-1", id: "tool-1" },
} as const satisfies PermissionRequest;

const FORM_REPLY = {
  id: FORM_REPLY_ID,
  sessionID: SESSION_ID,
  title: "Reply form",
  fields: [{ key: "name", type: "string", required: true }],
} as const satisfies FormInfo;

const FORM_CANCEL = {
  id: FORM_CANCEL_ID,
  sessionID: SESSION_ID,
  title: "Cancel form",
  fields: [{ key: "confirm", type: "boolean" }],
} as const satisfies FormInfo;

const MESSAGE_TEXT = "controller test";
const USER_MESSAGE: AppendMessage = {
  role: "user",
  content: [{ type: "text", text: MESSAGE_TEXT }],
  createdAt: new Date(0),
  metadata: { custom: {} },
  attachments: [],
  parentId: null,
  sourceId: null,
  runConfig: undefined,
};

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason: unknown) => void;
};

type EventWaiter = {
  readonly resolve: (result: IteratorResult<V2Event>) => void;
  readonly reject: (reason: unknown) => void;
};

type PromptHandler = (
  input: SessionPromptInput,
  lifecycleSignal: AbortSignal,
) => Promise<SessionInboxUser>;

type GenerationOptions = {
  readonly session?: SessionInfo;
  readonly historyList?: (input: MessageListInput) => Promise<SessionMessagesResponse>;
  readonly inboxList?: (input: SessionInboxListInput) => Promise<SessionInboxInfo[]>;
  readonly permissionList?: () => Promise<PermissionRequest[]>;
  readonly formList?: () => Promise<FormInfo[]>;
  readonly prompt?: PromptHandler;
};

type FakeGeneration = OpenCodeV2Generation & {
  readonly events: OpenCodeV2Generation["events"] & {
    readonly emit: (event: V2Event) => void;
    readonly fail: (error: unknown) => void;
    readonly waitForCalls: (count: number) => Promise<void>;
    readonly closeCount: number;
  };
  readonly promptInputs: readonly SessionPromptInput[];
  readonly inboxCancelInputs: readonly { readonly sessionID: string; readonly inboxID: string }[];
  readonly interruptInputs: readonly { readonly sessionID: string }[];
  readonly permissionReplyInputs: readonly PermissionReplyInput[];
  readonly formReplyInputs: readonly SessionFormReplyInput[];
  readonly formCancelInputs: readonly SessionFormCancelInput[];
  bindSignals(signals: V2ConnectionSignals): void;
  setPromptHandler(handler: PromptHandler): void;
};

type FakeClient = OpenCodeV2Client & {
  readonly connectCount: number;
  readonly signals: readonly V2ConnectionSignals[];
  waitForConnect(count: number): Promise<void>;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function userInbox(
  id: string,
  delivery: SessionInboxUser["delivery"],
  text = MESSAGE_TEXT,
): SessionInboxUser {
  return {
    id,
    sessionID: SESSION_ID,
    time: { created: 10 },
    type: "user",
    payload: { text },
    delivery,
  };
}

function inboxEvent(
  inboxId: string,
  messageId: string,
  delivery: SessionInboxUser["delivery"],
): V2Event {
  return {
    id: `evt_${messageId}`,
    created: 10,
    type: "session.inbox.enqueued",
    durable: { aggregateID: SESSION_ID, seq: 1, version: 1 },
    data: {
      sessionID: SESSION_ID,
      inboxID: inboxId,
      item: { type: "user", payload: { text: MESSAGE_TEXT }, delivery },
    },
  };
}

function staleAssistantEvent(): V2Event {
  return {
    id: "evt_stale_assistant",
    created: 10,
    type: "session.text.started",
    durable: { aggregateID: SESSION_ID, seq: 1, version: 1 },
    data: {
      sessionID: SESSION_ID,
      assistantMessageID: STALE_ASSISTANT_MESSAGE_ID,
      ordinal: 0,
    },
  };
}

function assistantTextStarted(): V2Event {
  return {
    id: "evt_live_assistant_started",
    created: 20,
    type: "session.text.started",
    durable: { aggregateID: SESSION_ID, seq: 2, version: 1 },
    data: {
      sessionID: SESSION_ID,
      assistantMessageID: LIVE_ASSISTANT_MESSAGE_ID,
      ordinal: 0,
    },
  };
}

function assistantTextDelta(): V2Event {
  return {
    id: "evt_live_assistant_delta",
    created: 21,
    type: "session.text.delta",
    data: {
      sessionID: SESSION_ID,
      assistantMessageID: LIVE_ASSISTANT_MESSAGE_ID,
      ordinal: 0,
      delta: "live response",
    },
  };
}

function waitForState(
  controller: V2ThreadController,
  predicate: (state: ReturnType<V2ThreadController["getState"]>) => boolean,
): Promise<void> {
  if (predicate(controller.getState())) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = controller.subscribe(() => {
      if (!predicate(controller.getState())) return;
      unsubscribe();
      resolve();
    });
  });
}

function createEvents() {
  const queued: V2Event[] = [];
  const waiters: EventWaiter[] = [];
  const callSignals: Deferred<void>[] = [];
  let calls = 0;
  let closed = false;
  let closeCount = 0;

  function waitForCalls(count: number): Promise<void> {
    while (callSignals.length < count) callSignals.push(deferred<void>());
    return callSignals[count - 1].promise;
  }

  const events = {
    next(): Promise<IteratorResult<V2Event>> {
      calls += 1;
      callSignals[calls - 1]?.resolve(undefined);
      const event = queued.shift();
      if (event !== undefined) return Promise.resolve({ done: false, value: event });
      if (closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise<IteratorResult<V2Event>>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      closeCount += 1;
      queued.length = 0;
      for (const waiter of waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
    },
    emit(event: V2Event): void {
      if (closed) throw new Error("cannot emit after the event reader is closed");
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ done: false, value: event });
      else queued.push(event);
    },
    fail(error: unknown): void {
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    },
    waitForCalls,
    get closeCount(): number {
      return closeCount;
    },
  };
  return events;
}

function createGeneration(
  generationId: number,
  options: GenerationOptions = {},
): FakeGeneration {
  const events = createEvents();
  const promptInputs: SessionPromptInput[] = [];
  const inboxCancelInputs: { readonly sessionID: string; readonly inboxID: string }[] = [];
  const interruptInputs: { readonly sessionID: string }[] = [];
  const permissionReplyInputs: PermissionReplyInput[] = [];
  const formReplyInputs: SessionFormReplyInput[] = [];
  const formCancelInputs: SessionFormCancelInput[] = [];
  let lifecycleSignal = new AbortController().signal;
  let promptHandler: PromptHandler = async (input) => userInbox(input.id ?? LOCAL_MESSAGE_ID, input.delivery ?? "steer");

  const operations: OpenCodeV2GenerationOperations = {
    serverInfo: async () => SERVER_INFO,
    sessionGet: async () => options.session ?? SESSION,
    switchAgent: async () => undefined,
    switchModel: async () => undefined,
    prompt: async (input) => {
      promptInputs.push(input);
      return promptHandler(input, lifecycleSignal);
    },
    compact: async () => {
      throw new Error("unexpected compact operation");
    },
    interrupt: async (input) => {
      interruptInputs.push(input);
      return { interrupted: true };
    },
    inboxList: async (input) => options.inboxList?.(input) ?? [],
    inboxCancel: async (input) => {
      inboxCancelInputs.push(input);
    },
    revertStage: async () => {
      throw new Error("unexpected revert stage operation");
    },
    revertCommit: async () => {
      throw new Error("unexpected revert commit operation");
    },
    revertClear: async () => undefined,
    formList: async () => options.formList?.() ?? [],
    formReply: async (input) => {
      formReplyInputs.push(input);
    },
    formCancel: async (input) => {
      formCancelInputs.push(input);
    },
    permissionList: async () => options.permissionList?.() ?? [],
    permissionReply: async (input) => {
      permissionReplyInputs.push(input);
    },
  };

  return {
    [V2_GENERATION_BRAND]: true,
    generationId,
    events,
    history: {
      [V2_HISTORY_READER_BRAND]: true,
      sessionId: SESSION_ID,
      list: async (input) => options.historyList?.(input) ?? EMPTY_HISTORY,
    },
    operations,
    promptInputs,
    inboxCancelInputs,
    interruptInputs,
    permissionReplyInputs,
    formReplyInputs,
    formCancelInputs,
    setPromptHandler(handler) {
      promptHandler = handler;
    },
    bindSignals(signals: V2ConnectionSignals) {
      lifecycleSignal = signals.lifecycleSignal;
    },
  };
}

function createClient(generations: readonly FakeGeneration[]): FakeClient {
  const signals: V2ConnectionSignals[] = [];
  const connects: Deferred<void>[] = [];
  let index = 0;

  return {
    sessionId: SESSION_ID,
    directory: DIRECTORY,
    async connect(nextSignals) {
      signals.push(nextSignals);
      connects[index]?.resolve(undefined);
      const generation = generations[index];
      index += 1;
      if (!generation) throw new Error("unexpected extra OpenCode connection");
      generation.bindSignals(nextSignals);
      return generation;
    },
    get connectCount() {
      return index;
    },
    signals,
    async waitForConnect(count: number) {
      while (connects.length < count) connects.push(deferred<void>());
      await connects[count - 1].promise;
    },
  };
}

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
        (state) => state.messages[LIVE_ASSISTANT_MESSAGE_ID]?.parts.some(
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
      inboxList: async () => { throw new TypeError("inbox unavailable"); },
      permissionList: async () => { throw new TypeError("permissions unavailable"); },
      formList: async () => { throw new TypeError("forms unavailable"); },
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
      const sending = controller.sendMessage(USER_MESSAGE, {
        messageId: LOCAL_MESSAGE_ID,
        delivery: "queue",
      }).then((submission) => {
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

      expect(generation.permissionReplyInputs).toEqual([{
        sessionID: SESSION_ID,
        requestID: PERMISSION_ID,
        decision: "once",
      }]);
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

      expect(generation.formReplyInputs).toEqual([{
        sessionID: SESSION_ID,
        formID: FORM_REPLY_ID,
        answer,
      }]);
      expect(generation.formCancelInputs).toEqual([{
        sessionID: SESSION_ID,
        formID: FORM_CANCEL_ID,
      }]);
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
    controller.subscribe(() => { notifications += 1; });

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
      await waitForState(
        controller,
        (state) => state.permissions.some((entry) => entry.id === LIVE_SHELL_PERMISSION_ID),
      );

      const shell = projectedToolCalls(controller).find((part) => part.toolName === "shell");
      expect(shell).toBeDefined();
      // The linkage itself: the native source ids resolved to this exact part.
      expect(shell?.approval).toMatchObject({ id: LIVE_SHELL_PERMISSION_ID });

      // And the user-facing half, through the real renderer the toolkit maps
      // `shell` to — the same component `bash` uses.
      const html = renderToStaticMarkup(
        createElement(OpenCodeBashToolUI, shell),
      );
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
