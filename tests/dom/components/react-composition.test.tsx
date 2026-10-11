/**
 * SPIKE — P2 Candidate D, Phase 2: REACT COMPOSITION.
 * TEMPORARY, removable.
 *
 * Closes the gap the re-audit could not close: whether `useChat()`,
 * `useExternalStoreRuntime()` and `useRemoteThreadListRuntime()` can actually
 * be composed in one React tree, with effects flushed, and whether a message
 * sent through the AI SDK Chat reaches the assistant-ui thread.
 *
 * Run with the DOM preload:
 *   bun test --preload ./web/spikes/p2-candidate-d/dom-preload.ts <this file>
 *
 * Everything here is the REAL installed package. Only the network is captured.
 */

import { describe, expect, it } from "bun:test";
import { StrictMode, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { AssistantChatTransport } from "@assistant-ui/ai-sdk";
// Resolved through the spike shim: `@ai-sdk/react` and `@assistant-ui/core`
// are nested in bun's isolated store, not hoisted into web/node_modules.
import { ExportedMessageRepository, useChat } from "../../helpers/dom/resolve.ts";

/* ------------------------------------------------------------------ *
 * A capturing transport standing in for /api/chat.
 * ------------------------------------------------------------------ */

type Sent = { ids: string[]; trigger?: string };

const sent: Sent[] = [];

function makeTransport() {
  return new AssistantChatTransport({
    api: "/api/chat",
    fetch: (async (_url: unknown, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { messages: Array<{ id: string }> }) : null;
      sent.push({
        ids: (body?.messages ?? []).map((m) => m.id),
        trigger: (init?.body ? (JSON.parse(String(init.body)) as { trigger?: string }).trigger : undefined) ?? "submit-message",
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            // A minimal, valid, immediately-terminal UI message stream.
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify({ type: "start" })}\n\n`),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch,
  });
}

/* ------------------------------------------------------------------ *
 * Message conversion
 *
 * Candidate D's real cost, measured: the host must convert the AI SDK
 * UIMessage shape (`parts`) into the assistant-ui ThreadMessageLike shape
 * (`content` + `metadata`). `@assistant-ui/ai-sdk` does this internally with
 * AISDKMessageConverter; owning the store means owning that conversion too.
 * ------------------------------------------------------------------ */

type AiMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  parts?: Array<{ type: string; text?: string }>;
};

type ThreadMessageLike = {
  id: string;
  role: "user" | "assistant" | "system";
  content: Array<{ type: "text"; text: string }>;
  // The MessageRuntime reads `message.status`, not the part's, when deriving
  // part status. Without it `toMessagePartStatus` throws. This is a real
  // requirement of the `messages` path when no `convertMessage` is supplied.
  status: { type: "complete" };
  metadata: { unstable_state: null; unstable_imperativeAdvance: false };
  createdAt: Date;
};

function toThreadMessageLike(message: AiMessage): ThreadMessageLike {
  const content = (message.parts ?? [])
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => ({ type: "text" as const, text: part.text }));
  return {
    id: message.id,
    role: message.role,
    content,
    status: { type: "complete" },
    metadata: { unstable_state: null, unstable_imperativeAdvance: false },
    createdAt: new Date(0),
  };
}

/* ------------------------------------------------------------------ *
 * Probe
 * ------------------------------------------------------------------ */

function Probe({ onSend }: { onSend: () => void }) {
  const aui = useAui();
  const messages = useAuiState((s) => s.thread.messages);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const hasEarlier = useAuiState((s) => s.thread.hasEarlier);
  const isLoadingEarlier = useAuiState((s) => s.thread.isLoadingEarlier);

  return (
    <div data-testid="probe">
      <span data-testid="count">{messages.length}</span>
      <span data-testid="ids">{messages.map((m) => m.id).join(",")}</span>
      <span data-testid="running">{String(isRunning)}</span>
      <span data-testid="hasEarlier">{String(hasEarlier)}</span>
      <span data-testid="isLoadingEarlier">{String(isLoadingEarlier)}</span>
      <button
        type="button"
        data-testid="loadEarlier"
        onClick={() => {
          // `loadEarlier` is a thread ACTION, not state: the state exposes
          // hasEarlier/isLoadingEarlier. The first run proved the distinction.
          void aui.thread.loadEarlier();
        }}
      />
      <button type="button" data-testid="send" onClick={onSend} />
    </div>
  );
}

/** Renders the thread through real ThreadPrimitive markup. */
function Transcript() {
  return (
    <ThreadPrimitive.Viewport data-testid="viewport">
      <ThreadPrimitive.Messages data-testid="messages">
        {() => (
          // MessagePrimitive.Root is what emits `data-message-id`; there is no
          // ThreadPrimitive.Message (the first run proved that is undefined).
          <MessagePrimitive.Root data-testid="message">
            <MessagePrimitive.Content />
          </MessagePrimitive.Root>
        )}
      </ThreadPrimitive.Messages>
    </ThreadPrimitive.Viewport>
  );
}

/* ------------------------------------------------------------------ *
 * The exact composition under test
 * ------------------------------------------------------------------ */

/**
 * Candidate D:
 *   - `useChat()` provides the EXECUTION object (unchanged AI SDK Chat).
 *   - `useExternalStoreRuntime()` owns assistant-ui PRESENTATION/HISTORY.
 *
 * The store is built from the Chat's messages exactly as `useAISDKRuntime`
 * does internally — except the store object is OURS, so it can carry
 * `hasEarlier` / `onLoadEarlier`, which the wrapper structurally cannot.
 */
/**
 * The Candidate D hook, in the shape `useRemoteThreadListRuntime` expects:
 * `runtimeHook` is invoked as a hook and must RETURN a runtime (TBAi's
 * `ResumableThreadRuntime` does exactly this). The first spike run wrongly
 * returned JSX from it, which is why the nested thread rendered nothing.
 */
function useCandidateRuntime(initial: unknown[], onSend: () => void) {
  const chat = useChat({
    id: "spike-thread",
    transport: useMemo(() => makeTransport(), []),
    messages: initial as never,
  });

  const store = useMemo(
    () => ({
      // The conversion the wrapper would otherwise do for us.
      messages: (chat.messages as unknown as AiMessage[]).map(toThreadMessageLike),
      isRunning: chat.status === "submitted" || chat.status === "streaming",
      hasEarlier: true,
      onLoadEarlier: async () => {
        (globalThis as Record<string, unknown>).__onLoadEarlierCalled = true;
      },
      onNew: async (message: { id: string }) => {
        // Mirror the wrapper: hand the new message back to the Chat.
        chat.setMessages((current) => [
          ...current,
          { id: message.id, role: "user", parts: [{ type: "text", text: "from the probe" }] },
        ] as never);
      },
    }),
    [chat, chat.messages, chat.status],
  );

  return useExternalStoreRuntime(store as never);
}

function CandidateD({ initial, onSend }: { initial: unknown[]; onSend: () => void }) {
  const runtime = useCandidateRuntime(initial, onSend);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Probe onSend={onSend} />
      <Transcript />
    </AssistantRuntimeProvider>
  );
}

/** Hosts a candidate runtime under useRemoteThreadListRuntime, as TBAi does. */
function AppWithRemoteThreadList({ initial, onSend }: { initial: unknown[]; onSend: () => void }) {
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: () => useCandidateRuntime(initial, onSend),
    adapter: {
      list: async () => ({
        threads: [{ remoteId: "spike-thread", title: "spike", status: "regular" }],
      }),
      fetch: async (id: string) => ({
        remoteId: id,
        title: "spike",
        status: "regular",
      }),
      initialize: async (id: string) => ({ remoteId: id }),
      rename: async () => {},
      delete: async () => {},
      archive: async () => {},
      unarchive: async () => {},
    } as never,
    threadId: "spike-thread",
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Transcript />
    </AssistantRuntimeProvider>
  );
}

/* ------------------------------------------------------------------ *
 * Mount helper
 * ------------------------------------------------------------------ */

function mount(element: React.ReactElement): { root: Root; container: HTMLElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { root, container };
}

const text = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
};

/**
 * Flush until `predicate` holds, rather than sleeping a fixed amount.
 *
 * The thread list resolves through several promises before the nested runtime
 * mounts, and a fixed wait is exactly the kind of timing assumption this spike
 * exists to avoid making.
 */
const waitFor = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`waitFor timed out: ${label}`);
};

const initial = Array.from({ length: 5 }, (_, i) => ({
  id: `m${i + 1}`,
  role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
  parts: [{ type: "text" as const, text: `body ${i + 1}` }],
}));

/* ------------------------------------------------------------------ */

describe("P2 spike — Phase 2: React composition", () => {
  it("mounts useChat + useExternalStoreRuntime together without errors", async () => {
    const { root, container } = mount(<CandidateD initial={initial} onSend={() => {}} />);
    await flush();

    expect(text(container, "count")).toBe("5");
    expect(text(container, "ids")).toBe("m1,m2,m3,m4,m5");
    expect(text(container, "running")).toBe("false");

    await act(async () => root.unmount());
  });

  it("renders the thread through real ThreadPrimitive markup with data-message-id", async () => {
    const { root, container } = mount(<CandidateD initial={initial} onSend={() => {}} />);
    await flush();

    const rendered = container.querySelectorAll("[data-message-id]");
    console.log("=== PROBE: rendered message rows ===");
    console.log("rows with data-message-id:", rendered.length);
    console.log(
      "ids:",
      [...rendered].map((el) => el.getAttribute("data-message-id")).join(","),
    );

    // This is what a viewport tracker would key on.
    expect(rendered.length).toBe(5);
    expect(rendered[0]?.getAttribute("data-message-id")).toBe("m1");

    await act(async () => root.unmount());
  });

  it("exposes hasEarlier/loadEarlier, which useChatRuntime cannot", async () => {
    const { root, container } = mount(<CandidateD initial={initial} onSend={() => {}} />);
    await flush();

    // The capability the re-audit proved unreachable through the wrapper.
    expect(text(container, "hasEarlier")).toBe("true");

    const button = container.querySelector<HTMLButtonElement>('[data-testid="loadEarlier"]');
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect((globalThis as Record<string, unknown>).__onLoadEarlierCalled).toBe(true);

    await act(async () => root.unmount());
  });

  it("composes inside useRemoteThreadListRuntime, the shape TBAi uses", async () => {
    const { root, container } = mount(
      <AppWithRemoteThreadList initial={initial} onSend={() => {}} />,
    );
    await waitFor(
      () => container.querySelectorAll("[data-message-id]").length === 5,
      "remote thread list renders 5 rows",
    );

    const rendered = container.querySelectorAll("[data-message-id]");
    console.log("=== PROBE: under useRemoteThreadListRuntime ===");
    console.log("rows:", rendered.length);
    console.log(
      "ids:",
      [...rendered].map((el) => el.getAttribute("data-message-id")).join(","),
    );

    // The nested runtime mounted and the thread list resolved to spike-thread.
    expect(rendered.length).toBe(5);

    await act(async () => root.unmount());
  });

  it("survives StrictMode double-invocation", async () => {
    const { root, container } = mount(
      <StrictMode>
        <CandidateD initial={initial} onSend={() => {}} />
      </StrictMode>,
    );
    await flush();

    expect(text(container, "count")).toBe("5");

    await act(async () => root.unmount());
  });

  it("accepts a bounded repository the runtime can adopt", async () => {
    // The composition must tolerate the messageRepository shape too, since
    // that is the only path that actually bounds memory.
    //
    // `fromBranchableArray` takes assistant-ui ThreadMessageLike (which uses
    // `content`), NOT the AI SDK UIMessage shape (`parts`). The conversion is
    // the same one the production wrapper performs via its message converter.
    const windowMessages = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i + 1}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: [{ type: "text" as const, text: `body ${i + 1}` }],
    }));

    function BoundedCandidate() {
      const chat = useChat({
        id: "spike-bounded",
        transport: useMemo(() => makeTransport(), []),
        messages: initial as never,
      });
      const repository = useMemo(
        () =>
          ExportedMessageRepository.fromBranchableArray(
            windowMessages.map((message, index) => ({
              message,
              parentId: index === 0 ? null : `m${index}`,
            })) as never,
            { headId: "m5" },
          ),
        // Deliberately keyed on the Chat so the composition re-evaluates when
        // the execution object publishes.
        [chat.messages],
      );
      const runtime = useExternalStoreRuntime({ messageRepository: repository } as never);
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <Probe onSend={() => {}} />
        </AssistantRuntimeProvider>
      );
    }

    const { root, container } = mount(<BoundedCandidate />);
    await flush();

    expect(text(container, "count")).toBe("5");
    expect(text(container, "ids")).toBe("m1,m2,m3,m4,m5");

    await act(async () => root.unmount());
  });

  it("a Chat append reaches the thread through the store", async () => {
    sent.length = 0;

    // Appends the way the composer does: through the runtime's thread, which
    // is the only public submission entry point.
    function AppendProbe() {
      const aui = useAui();
      const ids = useAuiState((s) => s.thread.messages.map((m) => m.id).join(","));
      return (
        <div>
          <span data-testid="appendIds">{ids}</span>
          <button
            type="button"
            data-testid="append"
            onClick={() => {
              // `content` must be an array of parts. Passing a bare string
              // reaches the runtime as an object and throws on `.content.map`.
              void aui.thread.append({
                role: "user",
                content: [{ type: "text", text: "hello" }],
              } as never);
            }}
          />
        </div>
      );
    }

    function CandidateWithAppend() {
      const chat = useChat({
        id: "spike-append",
        transport: useMemo(() => makeTransport(), []),
        messages: [] as never,
      });
      const store = useMemo(
        () => ({
          // The conversion the wrapper would otherwise do for us.
          messages: (chat.messages as unknown as AiMessage[]).map(toThreadMessageLike),
          isRunning: false,
          onNew: async (message: { id: string; content?: unknown }) => {
            const g = globalThis as Record<string, unknown>;
            g.__onNewCalled = ((g.__onNewCalled as number) ?? 0) + 1;
            // Mirror the REAL wrapper: onNew calls chatHelpers.sendMessage,
            // which is what publishes a new snapshot. Assigning
            // `chat.messages` alone does NOT notify subscribers — the first
            // spike run proved the thread stayed empty because of that.
            await chat.sendMessage(
              {
                id: message.id,
                role: "user",
                parts: [{ type: "text", text: "hello" }],
              } as never,
              { metadata: undefined } as never,
            );
          },
        }),
        [chat, chat.messages],
      );
      const runtime = useExternalStoreRuntime(store as never);
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <AppendProbe />
          <Transcript />
        </AssistantRuntimeProvider>
      );
    }

    const { root, container } = mount(<CandidateWithAppend />);
    await flush();

    const before = container.querySelectorAll("[data-message-id]").length;

    // Drive the append the way the composer does: through the runtime thread.
    const appendButton = container.querySelector<HTMLButtonElement>('[data-testid="append"]');
    await act(async () => {
      appendButton?.click();
      await Promise.resolve();
    });
    await waitFor(
      () => container.querySelectorAll("[data-message-id]").length > before,
      "append renders a new row",
    ).catch(async () => {
      const g = globalThis as Record<string, unknown>;
      console.log("=== PROBE: append diagnostics ===");
      console.log("onNew called:", g.__onNewCalled ?? 0);
      console.log("appendIds:", text(container, "appendIds"));
      throw new Error("append did not render");
    });

    const after = container.querySelectorAll("[data-message-id]").length;
    const ids = text(container, "appendIds");

    console.log("=== PROBE: Chat append through the store ===");
    console.log("rows before:", before, "rows after:", after);
    console.log("visible ids after append:", ids);
    console.log("transport submissions:", sent.length);

    // runtime -> store.onNew -> Chat.setMessages -> store -> runtime.
    expect(after).toBeGreaterThan(before);

    await act(async () => root.unmount());
  });
});