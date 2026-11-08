import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { MessageFormatAdapter } from "@assistant-ui/react";
import {
  createThreadHistoryAdapter,
  invalidateHistoryCache,
} from "@web/adapters/threadHistoryAdapter.ts";
import {
  clearAllWindowControllers,
  dropWindowController,
  ensureWindowController,
  HistoryWindowTimeoutError,
  isHistoryLoadFailed,
} from "@web/features/chat/history/useDirectHistoryWindow.ts";

const realFetch = globalThis.fetch;

function makeAdapter(remoteId: string | null) {
  return createThreadHistoryAdapter(() => ({
    threadListItem: {
      getState: () => ({ remoteId: remoteId ?? undefined }),
      initialize: async () => ({ remoteId: remoteId ?? "missing" }),
    },
  }));
}

type StoredRow = {
  id: string;
  parent_id: string | null;
  format: string;
  content: unknown;
};

function storedRow(id: string, parentId: string | null = null): StoredRow {
  return {
    id,
    parent_id: parentId,
    format: "raw",
    content: { id, kind: "text", text: `body-${id}` },
  };
}

function okWindow(entries: StoredRow[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      messages: entries,
      hasMoreBefore: false,
      hasMoreAfter: false,
      contiguous: true,
      complete: true,
    }),
  } as Response;
}

const fakeFormat = {
  format: "raw",
  getId: (m: { id: string }) => m.id,
  encode: (item: { message: unknown }) => item.message,
  decode: (entry: { parent_id?: string | null; content: unknown }) => ({
    parentId: entry.parent_id ?? null,
    message: entry.content,
  }),
} as unknown as MessageFormatAdapter<{ id: string }, Record<string, unknown>>;

describe("Phase 4 — threadHistoryAdapter timeout with retained history", () => {
  beforeEach(() => {
    invalidateHistoryCache();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    invalidateHistoryCache();
  });

  it("(a) Timeout + empty retained history -> still calls markHistoryLoadFailed, still returns { messages: [] }", async () => {
    const threadId = "timeout-empty-thread";
    const adapter = makeAdapter(threadId).withFormat!(fakeFormat);

    // Initial load throws HistoryWindowTimeoutError with no retained history
    globalThis.fetch = (async () => {
      throw new HistoryWindowTimeoutError(5000);
    }) as unknown as typeof fetch;

    const res = await adapter.load();
    expect(res.messages).toEqual([]);
    expect(isHistoryLoadFailed(threadId)).toBe(true);
  });

  it("(b) Timeout + non-empty retained history -> returns the retained messages, does NOT call markHistoryLoadFailed", async () => {
    const threadId = "timeout-retained-thread";
    const adapter = makeAdapter(threadId).withFormat!(fakeFormat);

    // First load succeeds and populates retained history
    globalThis.fetch = (async () => okWindow([storedRow("m1")])) as unknown as typeof fetch;
    const initialRes = await adapter.load();
    expect(initialRes.messages).toHaveLength(1);
    expect(isHistoryLoadFailed(threadId)).toBe(false);

    // Drop only the in-memory window controller so the next load() must fetch again,
    // while keeping the lastGoodHistory retained projection intact.
    dropWindowController(threadId);

    // Second load times out
    globalThis.fetch = (async () => {
      throw new HistoryWindowTimeoutError(5000);
    }) as unknown as typeof fetch;

    const secondRes = await adapter.load();
    expect(secondRes.messages).toHaveLength(1);
    expect(secondRes.messages[0]).toEqual(initialRes.messages[0]);
    // Must NOT be marked as failed
    expect(isHistoryLoadFailed(threadId)).toBe(false);
  });

  it("(c) superseded + timeout + non-empty retained history -> returns reportCurrentWindow(remoteId), does NOT return retainedHistory, does NOT call markHistoryLoadFailed", async () => {
    const threadId = "superseded-timeout-retained-thread";
    const adapter = makeAdapter(threadId).withFormat!(fakeFormat);

    // First load succeeds and establishes retained history ("m-stale")
    globalThis.fetch = (async () => okWindow([storedRow("m-stale")])) as unknown as typeof fetch;
    const initialRes = await adapter.load();
    expect(initialRes.messages).toHaveLength(1);
    expect((initialRes.messages[0] as any).message.id).toBe("m-stale");

    // Drop window controller so a fresh load() starts with a new controller C1
    dropWindowController(threadId);

    let releaseTimeout: (() => void) | null = null;
    const timeoutGate = new Promise<void>((resolve) => {
      releaseTimeout = resolve;
    });

    let isFirstCall = true;
    globalThis.fetch = (async () => {
      if (isFirstCall) {
        isFirstCall = false;
        await timeoutGate;
        throw new HistoryWindowTimeoutError(5000);
      }
      return okWindow([storedRow("c2-0"), storedRow("c2-1", "c2-0")]);
    }) as unknown as typeof fetch;

    // Start load() for C1 in background
    const inflight = adapter.load();
    await Promise.resolve();

    // Now clear controllers and install C2 as the active, healthy controller with its own window
    clearAllWindowControllers();
    const c2 = ensureWindowController(threadId, (stored) => fakeFormat.decode(stored as never));
    await c2.loadTip();
    expect(c2.rows().map((r) => r.id)).toEqual(["c2-0", "c2-1"]);

    // C1 times out and settles
    releaseTimeout!();
    const result = await inflight;

    // Result must be C2's current window, NOT the retained history "m-stale"
    const ids = (result.messages as Array<{ message: { id: string } }>).map((m) => m.message.id);
    expect(ids).toEqual(["c2-0", "c2-1"]);
    expect(ids).not.toContain("m-stale");
    expect(isHistoryLoadFailed(threadId)).toBe(false);
  });
});
