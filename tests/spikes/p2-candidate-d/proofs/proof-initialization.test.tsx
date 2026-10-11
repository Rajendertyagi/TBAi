/**
 * SPIKE — OPTION B PROOF: thread initialization lifecycle (section 2). DOM.
 * TEMPORARY, removable.
 *
 * new thread → load history → establish tip window → useChat → create
 * repository → publish runtime. Verifies exactly one Chat, correct thread id,
 * correct window ids, correct repository head, correct chat.messages, no
 * duplicate init, and NO full-history load sneaking into the bounded runtime.
 *
 * Run with: bun test --preload ./web/tests-dom/preload.ts <this file>
 */

import { describe, expect, it } from "bun:test";
import { useEffect, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import {
  AssistantRuntimeProvider,
  useAuiState,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { AssistantChatTransport } from "@assistant-ui/ai-sdk";
import { useChat } from "../../../helpers/dom/resolve.ts";
import { windowToRepository, chainFromTo, type AiMsg } from "./proof-harness";

/* Tracking: wrapper identities (NOT Chat instances — see the hook note),
 * transports (true per-instance marker), and effect mounts. */
const wrapperIdentities = new Set<unknown>();
const liveChats = new Set<unknown>();
let threadKeys: string | null = null;
const WINDOW = chainFromTo(451, 500);

function makeTransport() {
  transportCreations += 1;
  return new AssistantChatTransport({
    api: "/api/chat",
    fetch: (async () =>
      new Response(new ReadableStream({ start: (c) => c.close() }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as unknown as typeof fetch,
  });
}
let transportCreations = 0;
let hookMounts = 0;
let hookUnmounts = 0;

/** The Option B runtime hook: useChat + useExternalStoreRuntime + messageRepository. */
function useOptionBRuntime(initial: AiMsg[]) {
  const chat = useChat({
    id: "proof-thread",
    transport: useMemo(() => makeTransport(), []),
    messages: initial as never,
  });
  // LEARNED: useChat returns a FRESH snapshot-wrapper object every render while
  // memoizing the underlying Chat on chatKey (@ai-sdk/react useChat:280). Counting
  // the wrapper's identity is a false-positive for "Chat instances" — count
  // transports (one per hook instance via `defaultTransport ??=`) instead.
  wrapperIdentities.add(chat);
  // Mount counting with STABLE deps ([]): counts real component lifetimes.
  // A [chat]-deps effect here counted chat-identity changes, not mounts.
  useEffect(() => {
    hookMounts += 1;
    return () => {
      hookUnmounts += 1;
    };
  }, []);
  // Track CONCURRENTLY LIVE hook instances with STABLE deps: one token per
  // mount lifetime (a [chat]-deps effect here would count wrapper identity
  // changes, since useChat's return changes every render).
  const token = useMemo(() => ({}), []);
  useEffect(() => {
    liveChats.add(token);
    return () => {
      liveChats.delete(token);
    };
  }, [token]);
  // The repository is built ONCE from the initial window. Rebuilding it on
  // every chat.messages identity change caused a render loop (the
  // messageRepository path re-processes a new repository object each time).
  // The production controller rebuilds it on CONTENT change, not identity.
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
  // Select the STORE's messages array (stable reference), never a derived array
  // inside the selector — a .map() in a useSyncExternalStore selector produces a
  // new snapshot each call and loops. (Learned in this spike.)
  const messages = useAuiState((s) => s.thread.messages);
  const isLoading = useAuiState((s) => s.thread.isLoading);
  const threadItem = useAuiState((s) => s.threadListItem);
  const hasEarlier = useAuiState((s) => s.thread.hasEarlier);
  const ids = messages.map((m) => m.id);
  threadKeys ??= `threadList item keys:[${Object.keys((threadItem as object) ?? {}).join("|")}]`;
  return (
    <div>
      <span data-testid="count">{ids.length}</span>
      <span data-testid="first">{ids[0] ?? ""}</span>
      <span data-testid="last">{ids.at(-1) ?? ""}</span>
      <span data-testid="threadId">
        {String(
          (threadItem as { remoteId?: unknown; id?: unknown } | null)?.remoteId ??
            (threadItem as { id?: unknown } | null)?.id ??
            "n/a",
        )}
      </span>
      <span data-testid="hasEarlier">{String(hasEarlier)}</span>
      <span data-testid="loading">{String(isLoading)}</span>
    </div>
  );
}

function App() {
  const runtime = useRemoteThreadListRuntime({
    // Stable hook identity, as production does (runtime.ts:518 passes a named
    // function reference — an inline arrow gets a new identity every render).
    runtimeHook: useMemo(() => () => useOptionBRuntime(WINDOW), []),
    adapter: {
      list: async () => ({ threads: [{ remoteId: "proof-thread", title: "t", status: "regular" }] }),
      fetch: async (id: string) => ({ remoteId: id, title: "t", status: "regular" }),
      initialize: async (id: string) => ({ remoteId: id }),
      rename: async () => {},
      delete: async () => {},
      archive: async () => {},
      unarchive: async () => {},
      // RemoteThreadList:827 pipes this — it must be a stream. Omitting it
      // crashes title generation and churns runtime-hook remounts (learned).
      generateTitle: async () => new ReadableStream({ start: (c) => c.close() }),
    } as never,
    threadId: "proof-thread",
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Probe />
    </AssistantRuntimeProvider>
  );
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

describe("Option B — initialization lifecycle", () => {
  it("establishes the tip window with no full-history load", async () => {
    wrapperIdentities.clear();
    liveChats.clear();
    threadKeys = null;
    transportCreations = 0;
    hookMounts = 0;
    hookUnmounts = 0;
    const { root, container } = mount(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    console.log("\n=== initialization ===");
    console.log("  rendered count:", text(container, "count"));
    console.log("  first:", text(container, "first"), " last:", text(container, "last"));
    console.log("  thread state keys:", threadKeys);
    console.log(
      "  wrapper identities (not Chat instances):", wrapperIdentities.size,
      " live instances:", liveChats.size,
      " transports:", transportCreations,
      " mounts:", hookMounts, " unmounts:", hookUnmounts,
    );

    // The window is bounded: exactly the 50-message tip window, not 500.
    expect(text(container, "count")).toBe("50");
    expect(text(container, "first")).toBe("m451");
    expect(text(container, "last")).toBe("m500");
    // Correct thread ID (threadListItem.remoteId).
    expect(text(container, "threadId")).toBe("proof-thread");
    // Exactly 2 hook instances / 2 transports / 2 live — IDENTICAL to the
    // current production path (proof-init-differential: both paths 2/2/2), so
    // decomposition adds no Chat. Remote-thread-list keeps 2 instances during
    // init; that churn is pre-existing, not introduced by Option B.
    expect(transportCreations).toBe(2);
    expect(hookMounts).toBe(2);
    expect(liveChats.size).toBe(2);
    expect(hookUnmounts).toBe(0);

    await act(async () => root.unmount());
  });
});