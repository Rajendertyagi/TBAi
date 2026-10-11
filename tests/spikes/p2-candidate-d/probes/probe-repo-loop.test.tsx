/**
 * SPIKE — isolate the render loop: messageRepository with/without remote thread list.
 * TEMPORARY, removable.
 */
import { describe, expect, it } from "bun:test";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import {
  AssistantRuntimeProvider,
  useAuiState,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { useChat } from "../../../helpers/dom/resolve.ts";
import { windowToRepository, chainFromTo } from "../proofs/proof-harness.ts";
import { AssistantChatTransport } from "@assistant-ui/ai-sdk";

const WINDOW = chainFromTo(451, 500);
const transport = () =>
  new AssistantChatTransport({
    api: "/api/chat",
    fetch: (async () => new Response(new ReadableStream({ start: (c) => c.close() }))) as never,
  });

function useRepoRuntime() {
  const chat = useChat({ id: "t", transport: useMemo(transport, []), messages: WINDOW as never });
  const store = useMemo(
    () => ({ messageRepository: windowToRepository(WINDOW), isRunning: false, onNew: async () => {} }),
    [],
  );
  return useExternalStoreRuntime(store as never);
}

function Probe() {
  const count = useAuiState((s) => s.thread.messages.length);
  return <span data-testid="count">{count}</span>;
}

function mount(el: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(el);
  });
  return { root, container };
}

describe("isolate the loop", () => {
  it("messageRepository + useExternalStoreRuntime (NO remote thread list)", async () => {
    function App() {
      const runtime = useRepoRuntime();
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <Probe />
        </AssistantRuntimeProvider>
      );
    }
    const { root, container } = mount(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    console.log("  no-remote-thread-list count:", container.querySelector('[data-testid="count"]')?.textContent);
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe("50");
    await act(async () => root.unmount());
  });

  it("messageRepository + useRemoteThreadListRuntime", async () => {
    function App() {
      const runtime = useRemoteThreadListRuntime({
        runtimeHook: () => useRepoRuntime(),
        adapter: {
          list: async () => ({ threads: [{ remoteId: "t", title: "t", status: "regular" }] }),
          fetch: async (id: string) => ({ remoteId: id, title: "t", status: "regular" }),
          initialize: async (id: string) => ({ remoteId: id }),
          rename: async () => {},
          // `@assistant-ui/core` calls this during thread title generation; the
          // stub has to satisfy the same adapter surface as the other probes,
          // or the probe fails on an unrelated contract instead of the loop.
          generateTitle: async () => new ReadableStream({ start: (c) => c.close() }),
          delete: async () => {},
          archive: async () => {},
          unarchive: async () => {},
        } as never,
        threadId: "t",
      });
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <Probe />
        </AssistantRuntimeProvider>
      );
    }
    const { root, container } = mount(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    console.log("  with-remote-thread-list count:", container.querySelector('[data-testid="count"]')?.textContent);
    expect(container.querySelector('[data-testid="count"]')?.textContent).toBe("50");
    await act(async () => root.unmount());
  });
});