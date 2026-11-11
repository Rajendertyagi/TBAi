import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { cancelActiveRun } from "@web/features/chat/state/deleteConversation.ts";
import {
  createDirectResumableStorage,
  markDirectHistorySettled,
  rememberStreamId,
  lastRememberedStreamId,
  forgetRememberedStreamId,
} from "@web/features/chat/state/resumable-stream.ts";

function installMemorySessionStorage(): () => void {
  const holder = globalThis as unknown as { window?: unknown; sessionStorage?: unknown };
  const prevSessionStorage = holder.sessionStorage;
  const prevWindow = holder.window;
  const store = new Map<string, string>();
  const memoryStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  };

  holder.sessionStorage = memoryStorage;
  if (!holder.window) {
    holder.window = { sessionStorage: memoryStorage };
  } else {
    (holder.window as any).sessionStorage = memoryStorage;
  }

  return () => {
    if (prevSessionStorage === undefined) delete holder.sessionStorage;
    else holder.sessionStorage = prevSessionStorage;
    if (prevWindow === undefined) delete holder.window;
    else holder.window = prevWindow;
  };
}

const realFetch = globalThis.fetch;
let restoreStorage: (() => void) | null = null;

beforeEach(() => {
  restoreStorage = installMemorySessionStorage();
});

afterEach(() => {
  restoreStorage?.();
  restoreStorage = null;
  globalThis.fetch = realFetch;
});

describe("Direct cancellation and resumable stream handling", () => {
  it("cancelActiveRun returns false when threadKey is missing or has no active stream", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    }) as any;

    expect(await cancelActiveRun(null)).toBe(false);
    expect(await cancelActiveRun(undefined)).toBe(false);
    expect(await cancelActiveRun("non-existent-thread")).toBe(false);
    expect(fetchCalled).toBe(false);
  });

  it("cancelActiveRun invokes POST /api/chat/cancel/:streamId when active stream exists", async () => {
    const threadId = "thread-direct-1";
    const streamId = "stream-direct-abc-123";

    markDirectHistorySettled(threadId);
    const storage = createDirectResumableStorage(() => threadId);
    storage.setStreamId(streamId, threadId);

    let requestedUrl = "";
    let requestedMethod = "";
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    const result = await cancelActiveRun(threadId);
    expect(result).toBe(true);
    expect(requestedMethod).toBe("POST");
    expect(requestedUrl).toContain(`/api/chat/cancel/${encodeURIComponent(streamId)}`);
  });

  it("cancelActiveRun handles non-ok server response gracefully without throwing", async () => {
    const threadId = "thread-direct-fail";
    const streamId = "stream-direct-fail-404";

    markDirectHistorySettled(threadId);
    const storage = createDirectResumableStorage(() => threadId);
    storage.setStreamId(streamId, threadId);

    globalThis.fetch = (async () => {
      return new Response("Not Found", { status: 404 });
    }) as any;

    const result = await cancelActiveRun(threadId);
    expect(result).toBe(false);
  });

  it("cancelActiveRun handles network errors gracefully without throwing", async () => {
    const threadId = "thread-direct-err";
    const streamId = "stream-direct-err-net";

    markDirectHistorySettled(threadId);
    const storage = createDirectResumableStorage(() => threadId);
    storage.setStreamId(streamId, threadId);

    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as any;

    const result = await cancelActiveRun(threadId);
    expect(result).toBe(false);
  });

  it("repeated cancellation does not corrupt state or crash", async () => {
    const threadId = "thread-direct-rep";
    const streamId = "stream-direct-rep-999";

    markDirectHistorySettled(threadId);
    const storage = createDirectResumableStorage(() => threadId);
    storage.setStreamId(streamId, threadId);

    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    const res1 = await cancelActiveRun(threadId);
    const res2 = await cancelActiveRun(threadId);
    expect(res1).toBe(true);
    expect(res2).toBe(true);
    expect(calls).toBe(2);
  });

  it("lastRememberedStreamId tracks and clears streamId without clobbering other threads", () => {
    rememberStreamId("t-1", "str-1");
    rememberStreamId("t-2", "str-2");

    expect(lastRememberedStreamId("t-1")).toBe("str-1");
    expect(lastRememberedStreamId("t-2")).toBe("str-2");

    forgetRememberedStreamId("t-1");
    expect(lastRememberedStreamId("t-1")).toBeNull();
    expect(lastRememberedStreamId("t-2")).toBe("str-2");
  });
});
