/**
 * The resumable read gate is wired to the REAL history adapter.
 *
 * `createDirectResumableStorage` suppresses a thread-addressed `getStreamId`
 * until `markDirectHistorySettled(threadId)` runs. That must happen for every
 * way a history load can end, or the runtime would either resume against rows
 * that have not arrived yet (the slow-load race) or never resume at all.
 *
 * These cases drive the production `createThreadHistoryAdapter` and assert the
 * gate opens on a successful load and on a refused one. The settle call lives in
 * the adapter's `finally`, so a failure settles exactly like a success.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createThreadHistoryAdapter } from "@web/adapters/threadHistoryAdapter.ts";
import { clearAllWindowControllers } from "@web/features/chat/history/useDirectHistoryWindow.ts";
import {
  createDirectResumableStorage,
  readDirectResumableStreamId,
} from "@web/features/chat/state/resumable-stream.ts";

type StoredRow = { id: string; parent_id: string | null; format: string; content: unknown };

const row = (id: string, parent: string | null): StoredRow => ({
  id,
  parent_id: parent,
  format: "ai-sdk/v6",
  content: { role: "user", parts: [{ type: "text", text: id }] },
});

const decodeRow = (stored: StoredRow) => ({
  parentId: stored.parent_id,
  message: { id: stored.id },
});

const formatAdapter = {
  encode: (item: unknown) => item,
  decode: decodeRow,
} as never;

const jsonResponse = (messages: StoredRow[], status = 200): Response =>
  new Response(
    JSON.stringify({
      messages,
      hasMoreBefore: false,
      hasMoreAfter: false,
      contiguous: true,
      complete: true,
    }),
    { status, headers: { "content-type": "application/json" } },
  );

const adapterFor = (remoteId: string) =>
  createThreadHistoryAdapter(() => ({
    threadListItem: {
      getState: () => ({ remoteId }),
      initialize: async () => ({ remoteId }),
    },
  })) as unknown as {
    withFormat: (a: unknown) => { load: () => Promise<unknown> };
  };

describe("Direct resumable read gate follows the real history load", () => {
  let restore: typeof globalThis.fetch;

  beforeEach(() => {
    restore = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = restore;
    clearAllWindowControllers();
  });

  it("suppresses the pointer while load() is pending and opens it when the load resolves", async () => {
    const remoteId = `gate-ok-${Date.now()}`;
    const storage = createDirectResumableStorage(() => remoteId);

    // A send during the load window records its id; writes are never gated.
    storage.setStreamId("stream-gate-ok", remoteId);
    expect(readDirectResumableStreamId(remoteId), "the write landed").toBe("stream-gate-ok");
    expect(storage.getStreamId(remoteId), "the read is suppressed before any load").toBeNull();

    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async () => {
      await gate;
      return jsonResponse([row("g0", null)]);
    }) as unknown as typeof fetch;

    const inflight = adapterFor(remoteId).withFormat(formatAdapter).load();
    await Promise.resolve();
    expect(
      storage.getStreamId(remoteId),
      "still suppressed while the load is in flight",
    ).toBeNull();

    release!();
    await inflight;

    expect(storage.getStreamId(remoteId), "the resume sees the pointer once rows are in").toBe(
      "stream-gate-ok",
    );
  });

  it("also opens the gate when the load fails, so a dead load cannot strand the resume", async () => {
    const remoteId = `gate-fail-${Date.now()}`;
    const storage = createDirectResumableStorage(() => remoteId);
    storage.setStreamId("stream-gate-fail", remoteId);

    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    expect(storage.getStreamId(remoteId), "suppressed before the load").toBeNull();
    await adapterFor(remoteId).withFormat(formatAdapter).load();
    expect(storage.getStreamId(remoteId), "the failed load still settles").toBe("stream-gate-fail");
  });
});
