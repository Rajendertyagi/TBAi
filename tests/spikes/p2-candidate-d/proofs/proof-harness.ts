/**
 * SPIKE — OPTION B RUNTIME PROOF harness. TEMPORARY, removable.
 *
 * Instantiates the PROPOSED production decomposition as closely as possible:
 *
 *   useChat (Chat)            — execution engine, UNCHANGED
 *   AssistantChatTransport    — UNCHANGED (optionally resumable)
 *   useExternalStoreRuntime   — TBAi-owned
 *   messageRepository         — TBAi-owned, branch-aware (Option B)
 *
 * `chat.messages` is the SAME bounded semantic window the repository renders.
 * No second transport, no second execution engine, no copied internals.
 *
 * The store callbacks are transcribed from
 * `@assistant-ui/ai-sdk/dist/runtime/useAISDKRuntime.js:545-597` (they cannot
 * be imported — they are built inside a React hook). The functions they call
 * (`sliceMessagesUntil`, `toCreateMessage`) ARE imported from the package.
 */

import { AssistantChatTransport } from "@assistant-ui/ai-sdk";
import {
  AISDKMessageConverter,
  Chat,
  ExternalStoreThreadRuntimeCore,
  ExportedMessageRepository,
  MessageRepository,
  sliceMessagesUntil,
  toCreateMessage,
} from "../../../helpers/dom/resolve.ts";

export type AiMsg = {
  id: string;
  role: "user" | "assistant";
  parts: Array<Record<string, unknown>>;
};

export const ai = (id: string, role: "user" | "assistant", text?: string): AiMsg => ({
  id,
  role,
  parts: [{ type: "text", text: text ?? `body ${id}` }],
});

export const chainFromTo = (from: number, to: number): AiMsg[] =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    ai(`m${from + i}`, (from + i) % 2 === 1 ? "user" : "assistant"),
  );

/**
 * Build a branch-aware repository from a contiguous window (root parentId null).
 *
 * Uses the REAL `AISDKMessageConverter` so AI SDK v7 part types (`tool-*`,
 * reasoning, file, data) convert correctly — a minimal hand-rolled converter
 * cannot handle them (proven: it threw on `tool-read`).
 */
export function windowToRepository(windowMsgs: readonly AiMsg[], headId?: string) {
  const converted = AISDKMessageConverter.toThreadMessages(
    windowMsgs as never,
    false,
    {} as never,
  ) as never as Array<{ id: string }>;
  return ExportedMessageRepository.fromBranchableArray(
    converted.map((m, i) => ({
      message: m,
      parentId: i === 0 ? null : converted[i - 1].id,
    })) as never,
    { headId: headId ?? converted.at(-1)?.id ?? null },
  );
}

export type Submission = { ids: string[]; trigger: string };

export type ProofHarness = {
  chat: Chat<never>;
  runtime: InstanceType<typeof ExternalStoreThreadRuntimeCore>;
  repository: InstanceType<typeof MessageRepository>;
  submissions: Submission[];
  /** Ids the assistant-ui head walk renders. */
  visibleIds: () => string[];
  headId: () => string | null;
  chatIds: () => string[];
  /** Replace the window in BOTH the repository and the Chat (they stay aligned). */
  setWindow: (msgs: readonly AiMsg[]) => void;
  send: (text: string) => Promise<void>;
  appendAt: (parentId: string | null, text: string) => Promise<void>;
  capabilities: () => Record<string, boolean>;
  setHistoricalView: (on: boolean) => void;
  dispose: () => void;
};

export type ProofOptions = {
  window: readonly AiMsg[];
  /** Provide to enable the resumable transport. */
  resumable?: {
    storage: {
      getStreamId: (t?: string) => string | null;
      setStreamId: (id: string, t?: string) => void;
      clear: (t?: string) => void;
      subscribe?: (l: () => void, t?: string) => () => void;
    };
    resumeApi: (streamId: string) => string;
    isFinishEvent?: (chunk: Uint8Array, acc: string) => boolean;
  };
  sendAutomaticallyWhen?: (options: { messages: readonly unknown[] }) => boolean;
  /** Extra fetch inspector (e.g. to inject stream-id headers / resume bodies). */
  onFetch?: (url: string, init?: RequestInit) => Response | Promise<Response>;
};

export function createProof(options: ProofOptions): ProofHarness {
  const submissions: Submission[] = [];
  let historical = false;

  const baseFetch = async (url: unknown, init?: RequestInit): Promise<Response> => {
    if (options.onFetch) return options.onFetch(String(url), init);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    submissions.push({
      ids: (body.messages ?? []).map((m: { id: string }) => m.id),
      trigger: body.trigger ?? "submit-message",
    });
    return new Response(new ReadableStream({ start: (c) => c.close() }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const transport = new AssistantChatTransport({
    api: "/api/chat",
    fetch: baseFetch as unknown as typeof fetch,
    ...(options.resumable
      ? {
          resumable: {
            storage: options.resumable.storage,
            resumeApi: options.resumable.resumeApi,
            isFinishEvent: options.resumable.isFinishEvent,
          },
        }
      : {}),
  });

  const chat = new Chat<never>({
    id: "proof-thread",
    transport,
    messages: options.window as never,
    onError: () => {},
    ...(options.sendAutomaticallyWhen
      ? { sendAutomaticallyWhen: options.sendAutomaticallyWhen as never }
      : {}),
  });

  const setMessages = (messages: unknown): void => {
    const next =
      typeof messages === "function" ? (messages as (c: never) => never)(chat.messages) : messages;
    chat.messages = next as never;
  };

  const contextProvider = {
    getModelContext: () => ({ tools: {}, callSettings: {}, system: undefined, config: {} }),
    registerModelContextProvider: () => () => {},
  } as never;

  const makeStore = () => {
    const chatMsgs = chat.messages as unknown as AiMsg[];
    const mutationCallbacks = {
      onNew: async (message: never) => {
        const m = message as { role: string; content: unknown[]; runConfig?: unknown };
        await chat.sendMessage(toCreateMessage(m as never) as never, {
          metadata: m.runConfig as never,
        });
      },
      onEdit: async (message: never) => {
        const m = message as { parentId: string | null; role: string; content: unknown[]; runConfig?: unknown };
        setMessages((current: never) => sliceMessagesUntil(current, m.parentId));
        await chat.sendMessage(toCreateMessage(m as never) as never, {
          metadata: m.runConfig as never,
        });
      },
      onReload: async (parentId: string | null, config?: unknown) => {
        setMessages(sliceMessagesUntil(chat.messages as never, parentId) as never);
        await chat.regenerate({ metadata: (config as { runConfig?: unknown })?.runConfig as never });
      },
      onDelete: async (messageId: string) => {
        setMessages((current: never) =>
          (current as unknown as AiMsg[]).filter((m) => m.id !== messageId),
        );
      },
      setMessages: (messages: readonly unknown[]) => setMessages(messages as never),
    };

    return {
      // Option B: branch-aware repository built from the SAME window the Chat holds.
      messageRepository: windowToRepository(chatMsgs),
      isRunning: false,
      isSendDisabled: historical,
      hasEarlier: false,
      ...(historical ? {} : mutationCallbacks),
    };
  };

  const runtime = new ExternalStoreThreadRuntimeCore(contextProvider, makeStore() as never);

  return {
    chat,
    runtime,
    repository: runtime.repository as InstanceType<typeof MessageRepository>,
    submissions,
    visibleIds: () => (runtime.messages as Array<{ id: string }>).map((m) => m.id),
    headId: () => (runtime.repository as never as { canonicalHeadId: string | null }).canonicalHeadId,
    chatIds: () => (chat.messages as unknown as AiMsg[]).map((m) => m.id),
    setWindow(msgs) {
      setMessages(msgs as never);
      runtime.__internal_setAdapter(makeStore() as never);
    },
    async send(text: string) {
      await runtime.append({
        role: "user",
        parentId: (runtime.repository as never as { canonicalHeadId: string }).canonicalHeadId,
        content: [{ type: "text", text }],
      } as never);
      await new Promise((r) => setTimeout(r, 40));
    },
    async appendAt(parentId: string | null, text: string) {
      await runtime.append({
        role: "user",
        parentId,
        content: [{ type: "text", text }],
      } as never);
      await new Promise((r) => setTimeout(r, 40));
    },
    capabilities: () => ({ ...(runtime.capabilities as Record<string, boolean>) }),
    setHistoricalView(on: boolean) {
      historical = on;
      runtime.__internal_setAdapter(makeStore() as never);
    },
    dispose() {
      // best-effort; the core has no public dispose in this version
    },
  };
}
