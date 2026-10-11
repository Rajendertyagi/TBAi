/**
 * Defect S, second half - the SUPERSEDED controller.
 *
 * `publishWindowUiFor` rejects a superseded controller's snapshot, but a snapshot
 * is not the only shared state a late load can touch. This file drives the real
 * adapter through the exact interleaving:
 *
 *   1. `load()` starts on controller C1 and its window request is held in flight
 *   2. C1 is dropped and C2 is registered for the same conversation
 *   3. C1's held request is released and the load completes
 *
 * and asserts that C1 touches NOTHING the conversation now owns: no failure flag,
 * no retained-history projection, and no messages of its own returned to the
 * runtime. Returning C1's rows would overwrite C2's window; returning `[]` would
 * blank the transcript. The only safe answer is the window that owns it.
 *
 * This is the adapter-level half of the defect. The orphaned half, and the real
 * browser lifecycle, are covered by `direct-history-stale-publication.test.ts`
 * and `tests/e2e/history/p2-stale-publication-reachability.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createThreadHistoryAdapter } from "@web/adapters/threadHistoryAdapter.ts";
import {
  clearAllWindowControllers,
  ensureWindowController,
  isHistoryLoadFailed,
} from "@web/features/chat/history/useDirectHistoryWindow.ts";

type StoredRow = { id: string; parent_id: string | null; format: string; content: unknown };

const row = (id: string, parent: string | null): StoredRow => ({
  id,
  parent_id: parent,
  format: "ai-sdk/v6",
  content: { role: "user", parts: [{ type: "text", text: id }] },
});

/** Minimal decode, matching what the runtime's storage adapter would supply. */
const formatAdapter = {
  encode: (item: unknown) => item,
  decode: (stored: unknown) => {
    const value = stored as { id: string; parent_id: string | null; content: unknown };
    return { parentId: value.parent_id, message: { id: value.id, ...(value.content as object) } };
  },
} as never;

const jsonResponse = (messages: StoredRow[]): Response =>
  new Response(
    JSON.stringify({
      messages,
      hasMoreBefore: false,
      hasMoreAfter: false,
      contiguous: true,
      complete: true,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** The decode the runtime's storage adapter would supply. */
const decodeRow = (stored: StoredRow) => ({
  parentId: stored.parent_id,
  message: { id: stored.id },
});

const adapterFor = (remoteId: string) =>
  createThreadHistoryAdapter(() => ({
    threadListItem: {
      getState: () => ({ remoteId }),
      initialize: async () => ({ remoteId }),
    },
  })) as unknown as {
    withFormat: (a: unknown) => { load: () => Promise<{ headId: string | null; messages: unknown[] }> };
  };

describe("Defect S - a superseded controller touches nothing", () => {
  let restore: typeof globalThis.fetch;

  beforeEach(() => {
    restore = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = restore;
    clearAllWindowControllers();
  });

  it("reports the OWNING window, not its own rows and not an empty result", async () => {
    const remoteId = `superseded-${Date.now()}`;

    // Only the FIRST request is held (C1). C2's request is answered normally with
    // rows that are distinguishable from C1's, so "returned C2's window" cannot be
    // confused with "returned []" or "returned C1's rows".
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (first) {
        first = false;
        await gate;
        if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return jsonResponse([row("c1-0", null)]);
      }
      return jsonResponse([row("c2-0", null), row("c2-1", "c2-0")]);
    }) as unknown as typeof fetch;

    const adapter = adapterFor(remoteId);
    const inflight = adapter.withFormat(formatAdapter).load();
    await Promise.resolve();

    // C1 is dropped and C2 takes the conversation - and C2 actually commits rows.
    clearAllWindowControllers();
    const c2 = ensureWindowController(remoteId, decodeRow);
    await c2.loadTip();
    expect(c2.rows().map((r) => r.id)).toEqual(["c2-0", "c2-1"]);

    release!();
    const result = await inflight;

    // The late C1 completion must report the window that owns the conversation.
    const ids = (result.messages as Array<{ message: { id: string } }>).map((m) => m.message.id);
    expect(ids, "a superseded completion must report the OWNING window").toEqual(["c2-0", "c2-1"]);
    expect(ids).not.toContain("c1-0");
    expect(result.headId).toBe("c2-1");
    expect(isHistoryLoadFailed(remoteId)).toBe(false);
  });

  it("does not record a failure against a conversation a newer controller owns", async () => {
    const remoteId = `superseded-fail-${Date.now()}`;

    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      await gate;
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      // A server refusal, so the adapter takes its failure path.
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    const adapter = adapterFor(remoteId);
    const inflight = adapter.withFormat(formatAdapter).load();
    await Promise.resolve();

    clearAllWindowControllers();
    ensureWindowController(remoteId, ((stored: StoredRow) => ({
      parentId: stored.parent_id,
      message: { id: stored.id },
    })) as never);

    release!();
    await inflight;

    expect(
      isHistoryLoadFailed(remoteId),
      "a superseded failure must not drive the Retry row for a healthy replacement",
    ).toBe(false);
  });
});