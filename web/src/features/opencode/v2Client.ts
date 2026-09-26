import { OpenCode } from "@opencode/client";
import type {
  FormInfo,
  MessageListInput,
  OpenCodeClient,
  PermissionListInput,
  PermissionReplyInput,
  PermissionRequest,
  ServerInfo,
  SessionCompactInput,
  SessionFormCancelInput,
  SessionFormListInput,
  SessionFormReplyInput,
  SessionGetInput,
  SessionInboxCancelInput,
  SessionInboxCompaction,
  SessionInboxInfo,
  SessionInboxListInput,
  SessionInboxUser,
  SessionInfo,
  SessionInterruptInput,
  SessionInterruptResponse,
  SessionMessagesResponse,
  SessionPromptInput,
  SessionRevert,
  SessionRevertClearInput,
  SessionRevertCommitInput,
  SessionRevertStageInput,
  SessionSwitchAgentInput,
  SessionSwitchModelInput,
  V2Event,
} from "@opencode/client";
import {
  OPENCODE_DIRECTORY_HEADER,
  OPENCODE_PROXY_BASE_URL,
} from "@/config/opencode";

export const V2_GENERATION_BRAND = Symbol("tbai-opencode-v2-generation");
export const V2_HISTORY_READER_BRAND = Symbol("tbai-opencode-v2-history-reader");

type SessionScopedInput = { readonly sessionID: string };
type OfficialRequestOptions = { readonly signal: AbortSignal };

type GenerationState = {
  active: boolean;
  readonly connectionSignal: AbortSignal;
  readonly lifecycleSignal: AbortSignal;
};

class V2ScopeError extends Error {
  constructor() {
    super("OpenCode V2 operation used a session outside its scoped client");
    this.name = "V2ScopeError";
  }
}

class V2GenerationClosedError extends Error {
  constructor() {
    super("OpenCode V2 generation is no longer active");
    this.name = "V2GenerationClosedError";
  }
}

export interface V2EventReader {
  next(): Promise<IteratorResult<V2Event>>;
  close(): Promise<void>;
}

export interface V2HistoryReader {
  readonly [V2_HISTORY_READER_BRAND]: true;
  readonly sessionId: string;
  list(input: MessageListInput): Promise<SessionMessagesResponse>;
}

export interface V2ConnectionSignals {
  readonly connectionSignal: AbortSignal;
  readonly lifecycleSignal: AbortSignal;
}

export interface OpenCodeV2GenerationOperations {
  serverInfo(): Promise<ServerInfo>;
  sessionGet(input: SessionGetInput): Promise<SessionInfo>;
  switchAgent(input: SessionSwitchAgentInput): Promise<void>;
  switchModel(input: SessionSwitchModelInput): Promise<void>;
  prompt(input: SessionPromptInput): Promise<SessionInboxUser>;
  compact(input: SessionCompactInput): Promise<SessionInboxCompaction>;
  interrupt(input: SessionInterruptInput): Promise<SessionInterruptResponse>;
  inboxList(input: SessionInboxListInput): Promise<SessionInboxInfo[]>;
  inboxCancel(input: SessionInboxCancelInput): Promise<void>;
  revertStage(input: SessionRevertStageInput): Promise<SessionRevert>;
  revertCommit(input: SessionRevertCommitInput): Promise<void>;
  revertClear(input: SessionRevertClearInput): Promise<void>;
  formList(input: SessionFormListInput): Promise<FormInfo[]>;
  formReply(input: SessionFormReplyInput): Promise<void>;
  formCancel(input: SessionFormCancelInput): Promise<void>;
  permissionList(input: PermissionListInput): Promise<PermissionRequest[]>;
  permissionReply(input: PermissionReplyInput): Promise<void>;
}

export interface OpenCodeV2Generation {
  readonly [V2_GENERATION_BRAND]: true;
  readonly generationId: number;
  readonly events: V2EventReader;
  readonly history: V2HistoryReader;
  readonly operations: OpenCodeV2GenerationOperations;
}

export interface OpenCodeV2Client {
  readonly sessionId: string;
  readonly directory: string | null;
  connect(signals: V2ConnectionSignals): Promise<OpenCodeV2Generation>;
}

export interface OpenCodeV2ClientOptions {
  readonly fetch?: Parameters<typeof OpenCode.make>[0]["fetch"];
}

function assertActive(state: GenerationState): void {
  if (!state.active) throw new V2GenerationClosedError();
}

function assertScopedSession(input: SessionScopedInput, sessionId: string): void {
  if (input.sessionID !== sessionId) throw new V2ScopeError();
}

async function callWithGeneration<T>(
  state: GenerationState,
  signal: AbortSignal,
  operation: (requestOptions: OfficialRequestOptions) => Promise<T>,
): Promise<T> {
  assertActive(state);
  const result = await operation({ signal });
  assertActive(state);
  return result;
}

function resolveProxyBaseUrl(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError("OpenCode V2 origin must be an absolute URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new TypeError("OpenCode V2 origin must be an HTTP(S) origin");
  }
  return new URL(OPENCODE_PROXY_BASE_URL, parsed.origin).toString();
}

/** Creates the official OpenCode V2 browser boundary without exposing its raw client. */
export function createOpenCodeV2Client(
  scope: { readonly sessionId: string; readonly directory: string | null },
  origin: string,
  options?: OpenCodeV2ClientOptions,
): OpenCodeV2Client {
  const baseUrl = resolveProxyBaseUrl(origin);
  const headers = scope.directory
    ? { [OPENCODE_DIRECTORY_HEADER]: encodeURIComponent(scope.directory) }
    : undefined;
  const officialClient: OpenCodeClient = OpenCode.make({
    baseUrl,
    fetch: options?.fetch,
    headers,
  });
  let nextGenerationId = 0;

  async function connect({
    connectionSignal,
    lifecycleSignal,
  }: V2ConnectionSignals): Promise<OpenCodeV2Generation> {
    if (connectionSignal.aborted || lifecycleSignal.aborted) {
      throw new V2GenerationClosedError();
    }
    const eventStream = officialClient.event.subscribe({ signal: connectionSignal });
    const iterator = eventStream[Symbol.asyncIterator]();
    let first: IteratorResult<V2Event>;
    try {
      first = await iterator.next();
    } catch (error) {
      await iterator.return?.();
      throw error;
    }
    if (first.done || first.value.type !== "server.connected") {
      await iterator.return?.();
      throw new Error("OpenCode V2 event stream did not start with server.connected");
    }

    const state: GenerationState = {
      active: true,
      connectionSignal,
      lifecycleSignal,
    };
    const generationId = ++nextGenerationId;
    const events: V2EventReader = {
      async next() {
        assertActive(state);
        const result = await iterator.next();
        assertActive(state);
        return result;
      },
      async close() {
        if (!state.active) return;
        state.active = false;
        await iterator.return?.();
      },
    };
    const scoped = async <TInput extends SessionScopedInput, TResult>(
      input: TInput,
      signal: AbortSignal,
      call: (
        scopedInput: TInput,
        requestOptions: OfficialRequestOptions,
      ) => Promise<TResult>,
    ): Promise<TResult> => {
      assertScopedSession(input, scope.sessionId);
      return callWithGeneration(state, signal, (requestOptions) =>
        call(input, requestOptions),
      );
    };
    const connectionOperation = <TInput extends SessionScopedInput, TResult>(
      input: TInput,
      call: (
        scopedInput: TInput,
        requestOptions: OfficialRequestOptions,
      ) => Promise<TResult>,
    ): Promise<TResult> => scoped(input, state.connectionSignal, call);
    const lifecycleOperation = <TInput extends SessionScopedInput, TResult>(
      input: TInput,
      call: (
        scopedInput: TInput,
        requestOptions: OfficialRequestOptions,
      ) => Promise<TResult>,
    ): Promise<TResult> => scoped(input, state.lifecycleSignal, call);
    const history: V2HistoryReader = {
      [V2_HISTORY_READER_BRAND]: true,
      sessionId: scope.sessionId,
      list: (input) =>
        connectionOperation(input, (scopedInput, requestOptions) =>
          officialClient.message.list(scopedInput, requestOptions),
        ),
    };
    const operations: OpenCodeV2GenerationOperations = {
      serverInfo: () =>
        callWithGeneration(state, state.connectionSignal, (requestOptions) =>
          officialClient.server.info(requestOptions),
        ),
      sessionGet: (input) =>
        connectionOperation(input, (scopedInput, requestOptions) =>
          officialClient.session.get(scopedInput, requestOptions),
        ),
      switchAgent: (input) =>
        connectionOperation(input, (scopedInput, requestOptions) =>
          officialClient.session.switchAgent(scopedInput, requestOptions),
        ),
      switchModel: (input) =>
        connectionOperation(input, (scopedInput, requestOptions) =>
          officialClient.session.switchModel(scopedInput, requestOptions),
        ),
      prompt: (input) =>
        lifecycleOperation(input, (scopedInput, requestOptions) =>
          officialClient.session.prompt(scopedInput, requestOptions),
        ),
      compact: (input) =>
        connectionOperation(input, (scopedInput, requestOptions) =>
          officialClient.session.compact(scopedInput, requestOptions),
        ),
      interrupt: (input) =>
        connectionOperation(input, (scopedInput, requestOptions) =>
          officialClient.session.interrupt(scopedInput, requestOptions),
        ),
      inboxList: (input) =>
        connectionOperation(input, (scopedInput, requestOptions) =>
          officialClient.session.inbox.list(scopedInput, requestOptions),
        ),
      inboxCancel: (input) =>
        connectionOperation(input, (scopedInput, requestOptions) =>
          officialClient.session.inbox.cancel(scopedInput, requestOptions),
        ),
      revertStage: (input) =>
        connectionOperation(input, (scopedInput, requestOptions) =>
          officialClient.session.revert.stage(scopedInput, requestOptions),
        ),
      revertCommit: (input) =>
        connectionOperation(input, (scopedInput, requestOptions) =>
          officialClient.session.revert.commit(scopedInput, requestOptions),
        ),
      revertClear: (input) =>
        connectionOperation(input, (scopedInput, requestOptions) =>
          officialClient.session.revert.clear(scopedInput, requestOptions),
        ),
      formList: (input) =>
        connectionOperation(input, (scopedInput, requestOptions) =>
          officialClient.session.form.list(scopedInput, requestOptions),
        ),
      formReply: (input) =>
        connectionOperation(input, (scopedInput, requestOptions) =>
          officialClient.session.form.reply(scopedInput, requestOptions),
        ),
      formCancel: (input) =>
        connectionOperation(input, (scopedInput, requestOptions) =>
          officialClient.session.form.cancel(scopedInput, requestOptions),
        ),
      permissionList: (input) =>
        connectionOperation(input, (scopedInput, requestOptions) =>
          officialClient.permission.list(scopedInput, requestOptions),
        ),
      permissionReply: (input) =>
        connectionOperation(input, (scopedInput, requestOptions) =>
          officialClient.permission.reply(scopedInput, requestOptions),
        ),
    };

    return { [V2_GENERATION_BRAND]: true, generationId, events, history, operations };
  }

  return {
    sessionId: scope.sessionId,
    directory: scope.directory,
    connect,
  };
}
