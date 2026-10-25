/**
 * The shared fake client/generation harness for the OpenCode V2 thread controller.
 *
 * ## WHY THIS FILE EXISTS
 *
 * The harness that drives `createV2ThreadController` was written inline in
 * `tests/unit/web/opencode/v2ThreadController.test.ts`. It grew to a size that
 * made the file a bad place to look for the controller's own contracts, and it
 * made every additional suite that needed the same fake client copy it — which
 * is how a "the fix works" test ends up running against a *different* fake than
 * the one that found the defect.
 *
 * So the harness lives here, once, and every suite that needs it imports it.
 * The controller is exercised through the same seams everywhere.
 *
 * ## WHAT IT MODELS
 *
 * A real `@opencode/client` generation: a subscription the server drives, a
 * history reader, and the V2 operation surface. The fake is deliberately
 * *controllable* rather than realistic — a test says "the permission list
 * fails on the second read" and the harness makes that true, so a defect is
 * reproduced rather than described.
 *
 * It mirrors the shapes the official V2 client actually produces, because a
 * fake that invents a different shape would pass a test the real server fails.
 */

import type { AppendMessage } from "@assistant-ui/react";
import type {
  FormInfo,
  MessageListInput,
  PermissionReplyInput,
  PermissionRequest,
  ServerInfo,
  SessionFormCancelInput,
  SessionFormReplyInput,
  SessionInboxInfo,
  SessionInboxListInput,
  SessionInboxUser,
  SessionMessagesResponse,
  SessionPromptInput,
  V2Event,
} from "@opencode/client";
import {
  V2_GENERATION_BRAND,
  V2_HISTORY_READER_BRAND,
  type OpenCodeV2Client,
  type OpenCodeV2Generation,
  type OpenCodeV2GenerationOperations,
  type V2ConnectionSignals,
} from "@web/features/opencode/v2Client.ts";
import type { V2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import type { SessionMessageInfo, SessionInfo } from "@opencode/client";

export const SESSION_ID = "ses_v2_controller_test";
export const DIRECTORY = "D:\\workspace\\v2-controller-test";
export const SERVER_VERSION = "2.0.16";
export const LOCAL_MESSAGE_ID = "msg_local_controller_test";
export const HTTP_INBOX_ID = "inbox_http_controller_test";
export const EVENT_INBOX_ID = "inbox_event_controller_test";
export const STALE_ASSISTANT_MESSAGE_ID = "msg_stale_controller_test";
export const LIVE_ASSISTANT_MESSAGE_ID = "msg_live_controller_test";
export const ASSISTANT_TOOL_MESSAGE: SessionMessageInfo = {
  id: "assistant-1",
  time: { created: 20 },
  type: "assistant",
  agent: "build",
  model: { id: "test-model", providerID: "test-provider" },
  content: [
    {
      type: "tool",
      id: "tool-1",
      name: "shell",
      state: { status: "running", input: { command: "bun --version" }, metadata: {} },
      time: { created: 20, ran: 21 },
    },
  ],
};
export const PERMISSION_ID = "permission_controller_test";
export const FORM_REPLY_ID = "form_reply_controller_test";
export const FORM_CANCEL_ID = "form_cancel_controller_test";
export const EMPTY_HISTORY: SessionMessagesResponse = { data: [], cursor: {} };

export const SERVER_INFO = {
  version: SERVER_VERSION,
  pid: 1,
  urls: [],
  paths: { tmp: "v2-controller-test" },
} as const satisfies ServerInfo;

export const SESSION = {
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

export const PERMISSION = {
  id: PERMISSION_ID,
  sessionID: SESSION_ID,
  action: "bash",
  resources: ["D:\\workspace"],
  save: [],
  source: { type: "tool", messageID: "assistant-1", id: "tool-1" },
} as const satisfies PermissionRequest;

export const FORM_REPLY = {
  id: FORM_REPLY_ID,
  sessionID: SESSION_ID,
  title: "Reply form",
  fields: [{ key: "name", type: "string", required: true }],
} as const satisfies FormInfo;

export const FORM_CANCEL = {
  id: FORM_CANCEL_ID,
  sessionID: SESSION_ID,
  title: "Cancel form",
  fields: [{ key: "confirm", type: "boolean" }],
} as const satisfies FormInfo;

export const MESSAGE_TEXT = "controller test";
export const USER_MESSAGE: AppendMessage = {
  role: "user",
  content: [{ type: "text", text: MESSAGE_TEXT }],
  createdAt: new Date(0),
  metadata: { custom: {} },
  attachments: [],
  parentId: null,
  sourceId: null,
  runConfig: undefined,
};

export type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason: unknown) => void;
};

export type EventWaiter = {
  readonly resolve: (result: IteratorResult<V2Event>) => void;
  readonly reject: (reason: unknown) => void;
};

export type PromptHandler = (
  input: SessionPromptInput,
  lifecycleSignal: AbortSignal,
) => Promise<SessionInboxUser>;

export type PermissionReplyHandler = (input: PermissionReplyInput) => Promise<void>;

export type GenerationOptions = {
  readonly session?: SessionInfo;
  /**
   * Overrides how the session itself is read.
   *
   * The session read sits between "the event stream is open" and "the history
   * read starts", so a deferred override is what creates the window in which
   * live events are held before the read's boundary exists.
   */
  readonly sessionGet?: () => Promise<SessionInfo>;
  /**
   * The list and history readers receive the CONNECTION signal, exactly as the
   * real client passes it: `v2Client.ts` runs every one of these through
   * `connectionOperation`, so a superseded attempt's pending reads are aborted
   * with it.
   *
   * A test that needs a read to hang until the attempt is superseded can
   * therefore wait on the signal instead of racing a timer — which is the
   * difference between a deterministic reproduction and a flaky one.
   */
  readonly historyList?: (
    input: MessageListInput,
    signal: AbortSignal,
  ) => Promise<SessionMessagesResponse>;
  readonly inboxList?: (
    input: SessionInboxListInput,
    signal: AbortSignal,
  ) => Promise<SessionInboxInfo[]>;
  readonly permissionList?: (signal: AbortSignal) => Promise<PermissionRequest[]>;
  readonly formList?: (signal: AbortSignal) => Promise<FormInfo[]>;
  readonly prompt?: PromptHandler;
  /**
   * Overrides how `permission.reply` behaves. The default records the input and
   * resolves; the containment case needs it to REJECT, which is the only way to
   * prove the auto-arm path cannot leak an unhandled rejection.
   */
  readonly permissionReply?: PermissionReplyHandler;
  /**
   * Overrides how `form.reply` behaves. The default records the input and
   * resolves; the idempotency case needs it to be SLOW, so a second reply
   * overlaps the first.
   */
  readonly formReply?: (input: SessionFormReplyInput) => Promise<void>;
};

export type FakeGeneration = OpenCodeV2Generation & {
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

export type FakeClient = OpenCodeV2Client & {
  readonly connectCount: number;
  readonly signals: readonly V2ConnectionSignals[];
  waitForConnect(count: number): Promise<void>;
};

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function userInbox(
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

export function inboxEvent(
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

export function staleAssistantEvent(): V2Event {
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

export function assistantTextStarted(): V2Event {
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

export function assistantTextDelta(): V2Event {
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

export function waitForState(
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

export function createEvents() {
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

export function createGeneration(
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
  let connectionSignal = new AbortController().signal;
  let promptHandler: PromptHandler = async (input) =>
    userInbox(input.id ?? LOCAL_MESSAGE_ID, input.delivery ?? "steer");

  const operations: OpenCodeV2GenerationOperations = {
    serverInfo: async () => SERVER_INFO,
    sessionGet: async () =>
      options.sessionGet ? options.sessionGet() : (options.session ?? SESSION),
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
    inboxList: async (input) => options.inboxList?.(input, connectionSignal) ?? [],
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
    formList: async () => options.formList?.(connectionSignal) ?? [],
    formReply: async (input) => {
      formReplyInputs.push(input);
      await options.formReply?.(input);
    },
    formCancel: async (input) => {
      formCancelInputs.push(input);
    },
    permissionList: async () => options.permissionList?.(connectionSignal) ?? [],
    permissionReply: async (input) => {
      permissionReplyInputs.push(input);
      // Recorded BEFORE the optional handler runs, so a rejecting handler still
      // leaves the attempt visible in `permissionReplyInputs`.
      await options.permissionReply?.(input);
    },
  };

  return {
    [V2_GENERATION_BRAND]: true,
    generationId,
    events,
    history: {
      [V2_HISTORY_READER_BRAND]: true,
      sessionId: SESSION_ID,
      list: async (input) => options.historyList?.(input, connectionSignal) ?? EMPTY_HISTORY,
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
      connectionSignal = signals.connectionSignal;
      // A real stream dies when its connection signal aborts. Mirror that here
      // so a controller-initiated abort (including the idle watchdog) reaches
      // the same failure path as a dropped connection.
      signals.connectionSignal.addEventListener(
        "abort",
        () => events.fail(new Error("connection aborted")),
        { once: true },
      );
    },
  };
}

export function createClient(generations: readonly FakeGeneration[]): FakeClient {
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

export function createRejectingAfterFirstClient(
  generations: readonly FakeGeneration[],
): FakeClient {
  const signals: V2ConnectionSignals[] = [];
  let index = 0;

  return {
    sessionId: SESSION_ID,
    directory: DIRECTORY,
    async connect(nextSignals) {
      signals.push(nextSignals);
      index += 1;
      if (index > 1) throw new Error("connection refused");
      const generation = generations[0];
      generation.bindSignals(nextSignals);
      return generation;
    },
    get connectCount() {
      return index;
    },
    signals,
    async waitForConnect(count: number) {
      while (index < count) await new Promise((r) => setTimeout(r, 5));
    },
  };
}
