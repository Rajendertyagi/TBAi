/**
 * SPIKE — OPTION B PROOF: initialization differential (section 2). DOM.
 * TEMPORARY, removable.
 *
 * Runs the SAME thread-list initialization twice:
 *   (a) CURRENT production path: useChatRuntime (via useChatThread → useChat)
 *   (b) PROPOSED Option B path: useChat + useExternalStoreRuntime + repository
 *
 * and compares Chat lifecycle + rendered window. Any difference in Chat
 * creation count is an Option B regression; identical numbers prove the
 * decomposition does not change initialization.
 *
 * Run with: bun test --preload ./web/tests-dom/preload.ts <this file>
 */

import { describe, expect, it } from "bun:test";
import { useEffect, useMemo } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  useAuiState,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/ai-sdk";
import { useChat } from "../../../helpers/dom/resolve.ts";
import { windowToRepository, chainFromTo, type AiMsg } from "./proof-harness";

const WINDOW = chainFromTo(451, 500);

/* Chat lifecycle tracking via TRANSPORT construction: both paths construct one
 * transport per hook instance (useChat builds a transport-wrapper per hook), so
 * transport count == hook/Chat-instance count for BOTH current and Option B —
 * a uniform counter neither path can skip. (Module mutation, no setState.) */
let transportCreations = 0;
/* Hook-instance lifecycle (identical counters for BOTH paths). */
let hookMounts = 0;
let liveHooks = 0;

const makeTransport = () => {
  transportCreations += 1;
  return new AssistantChatTransport({
    api: "/api/chat",
    fetch: (async () =>
      new Response(new ReadableStream({ start: (c) => c.close() }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as unknown as typeof fetch,
  });
};

/** The real aiSDKV6FormatAdapter shape (assistant-cloud/ai-sdk:4-15). */
const v6Format = {
  format: "ai-sdk/v6",
  encode: ({ message: { id: _id, ...message } }: { message: Record<string, unknown> }) => message,
  decode: (stored: { id: string; parent_id: string | null; content: Record<string, unknown> }) => ({
    parentId: stored.parent_id,
    message: { id: stored.id, ...stored.content },
  }),
  getId: (message: { id: string }) => message.id,
};

/** CURRENT: production's useChatRuntime, fed the SAME window via its history adapter. */
function useCurrentRuntime() {
  useEffect(() => {
    hookMounts += 1;
    liveHooks += 1;
    return () => {
      liveHooks -= 1;
    };
  }, []);
  return useChatRuntime({
    transport: useMemo(makeTransport, []),
    adapters: useMemo(
      () => ({
        history: {
          load: async () => windowToRepository(WINDOW) as never,
          append: async () => {},
          update: async () => {},
          delete: async () => {},
          // Required by useChatRuntime (runtime throws without it). The runtime
          // hands us its format adapter; we re-wrap it as the generic form.
          withFormat: (formatAdapter: typeof v6Format) => ({
            load: async () => ({
              messages: WINDOW.map((m, i) => ({
                // Real chain: each message's parent is the previous in the window.
                parentId: i === 0 ? null : WINDOW[i - 1].id,
                message: formatAdapter.decode({
                  id: m.id,
                  parent_id: i === 0 ? null : WINDOW[i - 1].id,
                  format: formatAdapter.format,
                  content: formatAdapter.encode({ message: m as never }) as never,
                }).message,
              })),
              headId: WINDOW.at(-1)?.id ?? null,
            }),
            append: async () => {},
            update: async () => {},
            delete: async () => {},
          }),
        },
      }),
      [],
    ),
  } as never);
}

/** PROPOSED: useChat + useExternalStoreRuntime + messageRepository (Option B). */
function useOptionBRuntime(initial: AiMsg[]) {
  useEffect(() => {
    hookMounts += 1;
    liveHooks += 1;
    return () => {
      liveHooks -= 1;
    };
  }, []);
  // The Chat is the execution engine; identity is not needed here.
  useChat({
    id: "proof-thread",
    transport: useMemo(makeTransport, []),
    messages: initial as never,
  });
  const store = useMemo(
    () => ({
      messageRepository: windowToRepository(initial),
      isRunning: false,
      onNew: async () => {},
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return useExternalStoreRuntime(store as never);
}

function Probe() {
  // Store-reference selectors only; derive outside (loop lesson).
  const messages = useAuiState((s) => s.thread.messages);
  const ids = messages.map((m) => m.id);
  return (
    <div>
      <span data-testid="count">{ids.length}</span>
      <span data-testid="first">{ids[0] ?? ""}</span>
      <span data-testid="last">{ids.at(-1) ?? ""}</span>
    </div>
  );
}

const adapter = {
  list: async () => ({ threads: [{ remoteId: "proof-thread", title: "t", status: "regular" }] }),
  fetch: async (id: string) => ({ remoteId: id, title: "t", status: "regular" }),
  initialize: async (id: string) => ({ remoteId: id }),
  rename: async () => {},
  delete: async () => {},
  archive: async () => {},
  unarchive: async () => {},
  generateTitle: async () =>
    // RemoteThreadList:827 pipes the returned stream — must be a stream.
    new ReadableStream({ start: (c) => c.close() }),
} as never;

function makeApp(runtimeHook: () => unknown) {
  return function App() {
    const runtime = useRemoteThreadListRuntime({
      runtimeHook: runtimeHook as never,
      adapter,
      threadId: "proof-thread",
    });
    return (
      <AssistantRuntimeProvider runtime={runtime as never}>
        <Probe />
      </AssistantRuntimeProvider>
    );
  };
}

function mount(el: React.ReactElement): { root: Root; container: HTMLElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(el);
  });
  return { root, container };
}

const text = (c: HTMLElement, id: string) =>
  c.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

type Numbers = {
  transportCreations: number;
  hookMounts: number;
  liveHooks: number;
  count: string;
  first: string;
  last: string;
};

async function run(hook: () => unknown): Promise<Numbers> {
  transportCreations = 0;
  hookMounts = 0;
  liveHooks = 0;
  const App = makeApp(hook);
  const { root, container } = mount(<App />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  const out: Numbers = {
    transportCreations,
    hookMounts,
    liveHooks,
    count: text(container, "count"),
    first: text(container, "first"),
    last: text(container, "last"),
  };
  await act(async () => root.unmount());
  return out;
}

describe("Option B — initialization differential vs current production", () => {
  it("Chat lifecycle and rendered window are IDENTICAL for both paths", async () => {
    const current = await run(() => useCurrentRuntime());
    const optionB = await run(() => useOptionBRuntime(WINDOW));

    console.log("\n=== initialization differential ===");
    console.log("  current  (useChatRuntime):", JSON.stringify(current));
    console.log("  option B (useChat+ext):   ", JSON.stringify(optionB));

    // Same rendered bounded window.
    expect(optionB.count).toBe(current.count);
    expect(optionB.first).toBe(current.first);
    expect(optionB.last).toBe(current.last);
    expect(optionB.count).toBe("50");

    // Same Chat/hook-instance lifecycle: Option B creates NO MORE execution
    // engines than the current production path during initialization.
    expect(optionB.transportCreations).toBe(current.transportCreations);
    expect(optionB.hookMounts).toBe(current.hookMounts);
    expect(optionB.liveHooks).toBe(current.liveHooks);
  });
});
