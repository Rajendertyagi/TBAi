import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createRemoteThreadListAdapter,
  invalidateThreadListCache,
  ConversationNotFoundError,
} from "./remoteThreadListAdapter";
import { useWelcomeScopeStore } from "../features/chat/state/welcomeScope";
import { useWelcomeEngineStore } from "../features/chat/state/welcomeEngine";

const realFetch = globalThis.fetch;

function okList(threads: Array<{ id: string; title: string }>): Response {
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
      nextCursor: null,
    }),
  } as Response;
}

function errStatus(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: "x" }),
  } as Response;
}

beforeEach(() => {
  invalidateThreadListCache();
  useWelcomeScopeStore.getState().setScope({ mode: "simple", folderId: null });
  useWelcomeEngineStore.setState({ engine: "direct", agent: "", model: "" });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  invalidateThreadListCache();
});

describe("thread-list fetch error taxonomy (Phase 3.4)", () => {
  it("[P3-05] confirmed 404 → ConversationNotFoundError carrying the thread id", async () => {
    globalThis.fetch = (async () => errStatus(404)) as unknown as typeof fetch;
    const adapter = createRemoteThreadListAdapter();
    try {
      await adapter.fetch("dead-id");
      expect.unreachable("fetch must reject on 404");
    } catch (err) {
      expect(err).toBeInstanceOf(ConversationNotFoundError);
      expect((err as ConversationNotFoundError).threadId).toBe("dead-id");
    }
  });

  it("[P3-04] network failure → generic unknown-existence error, NOT ConversationNotFoundError", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const adapter = createRemoteThreadListAdapter();
    try {
      await adapter.fetch("c1");
      expect.unreachable("fetch must reject on network failure");
    } catch (err) {
      expect(err).not.toBeInstanceOf(ConversationNotFoundError);
      expect((err as Error).message).toContain("unknown");
    }
  });

  it("[P3-04b] non-404 statuses (500/503) → unknown-existence error, never not-found", async () => {
    for (const status of [500, 503]) {
      globalThis.fetch = (async () => errStatus(status)) as unknown as typeof fetch;
      const adapter = createRemoteThreadListAdapter();
      try {
        await adapter.fetch("c1");
        expect.unreachable(`fetch must reject on ${status}`);
      } catch (err) {
        expect(err).not.toBeInstanceOf(ConversationNotFoundError);
        expect((err as Error).message).toContain("unknown");
      }
    }
  });

  it("[P3-04c] useConversationTab retains tab + route on unknown existence, destroys only on confirmed 404", async () => {
    const source = await Bun.file(
      new URL(
        "../features/chat/state/useConversationTab.ts",
        import.meta.url,
      ),
    ).text();
    // Unknown existence (network/5xx) returns early — no close, no navigate.
    expect(source).toContain("if (!(err instanceof ConversationNotFoundError))");
    expect(source).toContain("conversation validation unknown, retaining");
    // Confirmed 404 still closes every tab pointing at the ref + falls back.
    expect(source).toContain("ConversationNotFoundError");
    expect(source).toContain('navigate("/chat/new"');
    expect(source).toContain("current.close");
  });
});

describe("thread-list last-good retention (Phase 3.5)", () => {
  it("[P3-06] list() failure (!ok) retains the previous projection", async () => {
    const adapter = createRemoteThreadListAdapter();
    globalThis.fetch = (async () =>
      okList([
        { id: "a", title: "A" },
        { id: "b", title: "B" },
      ])) as unknown as typeof fetch;
    const seeded = await adapter.list();
    expect(seeded.threads.map((t) => t.remoteId)).toEqual(["a", "b"]);

    globalThis.fetch = (async () => errStatus(500)) as unknown as typeof fetch;
    const stale = await adapter.list();
    expect(stale.threads.map((t) => t.remoteId)).toEqual(["a", "b"]);
  });

  it("[P3-12] network failure never yields [] when a projection is retained", async () => {
    const adapter = createRemoteThreadListAdapter();
    globalThis.fetch = (async () =>
      okList([{ id: "a", title: "A" }])) as unknown as typeof fetch;
    await adapter.list();

    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const retained = await adapter.list();
    expect(retained.threads).not.toEqual([]);
    expect(retained.threads.map((t) => t.remoteId)).toEqual(["a"]);
  });

  it("[P3-11] server-returned [] is authoritative and replaces the stale cache", async () => {
    const adapter = createRemoteThreadListAdapter();
    globalThis.fetch = (async () =>
      okList([{ id: "a", title: "A" }])) as unknown as typeof fetch;
    await adapter.list();

    globalThis.fetch = (async () => okList([])) as unknown as typeof fetch;
    const emptied = await adapter.list();
    expect(emptied.threads).toEqual([]);

    // The cache now holds empty: a later failure serves [], not the old row.
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect((await adapter.list()).threads).toEqual([]);
  });

  it("[P3-06b] invalidateThreadListCache() drops the retained projection", async () => {
    const adapter = createRemoteThreadListAdapter();
    globalThis.fetch = (async () =>
      okList([{ id: "a", title: "A" }])) as unknown as typeof fetch;
    await adapter.list();

    invalidateThreadListCache();
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect((await adapter.list()).threads).toEqual([]);
  });
});

describe("conversation-config mutation failure contract (Phase 3.11)", () => {
  it("[P3-15a] updateCustom 503 throws — the failed write stays unsuccessful", async () => {
    globalThis.fetch = (async () => errStatus(503)) as unknown as typeof fetch;
    const adapter = createRemoteThreadListAdapter();
    await expect(
      adapter.updateCustom!("c1", { providerId: "p" }),
    ).rejects.toThrow("Failed to persist conversation config (503)");
  });
});
