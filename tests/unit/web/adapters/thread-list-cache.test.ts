/**
 * URL-keyed thread-list cache (Fix 1).
 *
 * A failed list() must return stale data ONLY for the exact request URL that
 * was previously successful. A different search, sort order or page must never
 * inherit another query's threads. Cursors are retained with the threads, the
 * cache is bounded, and invalidateThreadListCache() clears every entry.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createRemoteThreadListAdapter,
  invalidateThreadListCache,
  setThreadListSearchQuery,
  setThreadListSortOrder,
} from "@web/adapters/remoteThreadListAdapter";

const realFetch = globalThis.fetch;

function okList(
  threads: Array<{ id: string; title: string }>,
  nextCursor: string | null = null,
): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      threads: threads.map((t) => ({
        id: t.id,
        title: t.title,
        status: "regular",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      })),
      nextCursor,
    }),
  } as Response;
}

function errStatus(status: number): Response {
  return { ok: false, status, json: async () => ({ error: "x" }) } as Response;
}

beforeEach(() => {
  invalidateThreadListCache();
  setThreadListSearchQuery("");
  setThreadListSortOrder("updated");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  invalidateThreadListCache();
  setThreadListSearchQuery("");
  setThreadListSortOrder("updated");
});

describe("URL-keyed thread-list cache", () => {
  it("does not leak one search's stale results into another search", async () => {
    const adapter = createRemoteThreadListAdapter();
    setThreadListSearchQuery("alpha");
    globalThis.fetch = (async () =>
      okList([{ id: "a", title: "Alpha" }])) as unknown as typeof fetch;
    expect((await adapter.list()).threads.map((t) => t.remoteId)).toEqual(["a"]);

    // A different search fails: no cached entry for that URL → empty, never A.
    setThreadListSearchQuery("beta");
    globalThis.fetch = (async () => errStatus(500)) as unknown as typeof fetch;
    expect((await adapter.list()).threads).toEqual([]);
  });

  it("does not leak one page's stale results into another page", async () => {
    const adapter = createRemoteThreadListAdapter();
    globalThis.fetch = (async () =>
      okList([{ id: "p0", title: "Page 0" }])) as unknown as typeof fetch;
    expect((await adapter.list()).threads.map((t) => t.remoteId)).toEqual(["p0"]);

    // A different offset fails: distinct URL → empty, never page 0's rows.
    globalThis.fetch = (async () => errStatus(500)) as unknown as typeof fetch;
    expect((await adapter.list({ after: "10" })).threads).toEqual([]);
  });

  it("does not leak across sort orders", async () => {
    const adapter = createRemoteThreadListAdapter();
    setThreadListSortOrder("updated");
    globalThis.fetch = (async () =>
      okList([{ id: "u", title: "Updated" }])) as unknown as typeof fetch;
    await adapter.list();

    setThreadListSortOrder("created");
    globalThis.fetch = (async () => errStatus(500)) as unknown as typeof fetch;
    expect((await adapter.list()).threads).toEqual([]);
  });

  it("retains the nextCursor with the stale threads", async () => {
    const adapter = createRemoteThreadListAdapter();
    globalThis.fetch = (async () =>
      okList([{ id: "a", title: "A" }], "cursor-42")) as unknown as typeof fetch;
    const seeded = await adapter.list();
    expect(seeded.nextCursor).toBe("cursor-42");

    globalThis.fetch = (async () => errStatus(500)) as unknown as typeof fetch;
    const stale = await adapter.list();
    expect(stale.threads.map((t) => t.remoteId)).toEqual(["a"]);
    expect(stale.nextCursor).toBe("cursor-42");
  });

  it("invalidateThreadListCache() clears every URL's entry", async () => {
    const adapter = createRemoteThreadListAdapter();
    setThreadListSearchQuery("one");
    globalThis.fetch = (async () =>
      okList([{ id: "one", title: "One" }])) as unknown as typeof fetch;
    await adapter.list();
    setThreadListSearchQuery("two");
    globalThis.fetch = (async () =>
      okList([{ id: "two", title: "Two" }])) as unknown as typeof fetch;
    await adapter.list();

    invalidateThreadListCache();
    globalThis.fetch = (async () => errStatus(500)) as unknown as typeof fetch;
    setThreadListSearchQuery("one");
    expect((await adapter.list()).threads).toEqual([]);
    setThreadListSearchQuery("two");
    expect((await adapter.list()).threads).toEqual([]);
  });

  it("is bounded: the oldest of >20 distinct URLs is evicted", async () => {
    const adapter = createRemoteThreadListAdapter();
    // Seed 21 distinct URLs (distinct offsets).
    for (let i = 0; i < 21; i += 1) {
      globalThis.fetch = (async () =>
        okList([{ id: `p${i}`, title: `Page ${i}` }])) as unknown as typeof fetch;
      await adapter.list({ after: String(i) });
    }
    globalThis.fetch = (async () => errStatus(500)) as unknown as typeof fetch;
    // The first URL (offset 0) was evicted → empty, not its old row.
    expect((await adapter.list({ after: "0" })).threads).toEqual([]);
    // The most recent URL is still cached.
    expect((await adapter.list({ after: "20" })).threads.map((t) => t.remoteId)).toEqual(["p20"]);
  });
});
