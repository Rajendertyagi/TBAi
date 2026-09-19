import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type {
  ExportedMessageRepositoryItem,
  MessageFormatAdapter,
} from "@assistant-ui/react";
import {
  createThreadHistoryAdapter,
  invalidateHistoryCache,
} from "./threadHistoryAdapter";
import {
  captureDraftSnapshot,
  materializeDraft,
  peekMaterializedEngine,
} from "../features/chat/state/materializeDraft";
import { useWelcomeEngineStore } from "../features/chat/state/welcomeEngine";
import { useWelcomeScopeStore } from "../features/chat/state/welcomeScope";
import { useSettingsStore } from "../stores";

const realFetch = globalThis.fetch;

function repoItem(id: string): ExportedMessageRepositoryItem {
  return {
    message: { id },
    parentId: null,
  } as unknown as ExportedMessageRepositoryItem;
}

function makeAdapter(remoteId: string | null) {
  return createThreadHistoryAdapter(() => ({
    threadListItem: {
      getState: () => ({ remoteId: remoteId ?? undefined }),
      initialize: async () => ({ remoteId: remoteId ?? "missing" }),
    },
  }));
}

function okMessages(entries: unknown[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ messages: entries }),
  } as Response;
}

function errStatus(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: "x" }),
  } as Response;
}

function storedEntry(id: string): unknown {
  return {
    id,
    parent_id: null,
    format: "raw",
    content: { id, kind: "text", text: `body-${id}` },
  };
}

const fakeFormat = {
  format: "raw",
  getId: (m: { id: string }) => m.id,
  encode: (item: { message: unknown }) => item.message,
  decode: (entry: { content: unknown }) => entry.content,
} as unknown as MessageFormatAdapter<{ id: string }, Record<string, unknown>>;

beforeEach(() => {
  invalidateHistoryCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  invalidateHistoryCache();
});

describe("history last-good retention (Phase 3.5)", () => {
  it("[P3-07] load() failure (!ok or throw) retains the previous messages", async () => {
    const adapter = makeAdapter("c1");
    globalThis.fetch = (async () =>
      okMessages([storedEntry("m1")])) as unknown as typeof fetch;
    const seeded = await adapter.load();
    expect(seeded.messages).toHaveLength(1);

    globalThis.fetch = (async () => errStatus(500)) as unknown as typeof fetch;
    expect((await adapter.load()).messages).toHaveLength(1);

    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect((await adapter.load()).messages).toHaveLength(1);
  });

  it("[P3-07b] retention is per remoteId — unknown threads stay empty", async () => {
    const c1 = makeAdapter("c1");
    globalThis.fetch = (async () =>
      okMessages([storedEntry("m1")])) as unknown as typeof fetch;
    await c1.load();

    globalThis.fetch = networkDown();
    expect((await c1.load()).messages).toHaveLength(1);
    expect((await makeAdapter("c2").load()).messages).toEqual([]);
  });

  it("[P3-07c] invalidateHistoryCache() drops retained projections", async () => {
    const adapter = makeAdapter("c1");
    globalThis.fetch = (async () =>
      okMessages([storedEntry("m1")])) as unknown as typeof fetch;
    await adapter.load();

    invalidateHistoryCache("c1");
    globalThis.fetch = networkDown();
    expect((await adapter.load()).messages).toEqual([]);

    globalThis.fetch = (async () =>
      okMessages([storedEntry("m1")])) as unknown as typeof fetch;
    await adapter.load();
    invalidateHistoryCache();
    globalThis.fetch = networkDown();
    expect((await adapter.load()).messages).toEqual([]);
  });

  it("[P3-07d] withFormat load() follows the same retain-on-failure rule", async () => {
    const adapter = makeAdapter("c1").withFormat!(fakeFormat);
    globalThis.fetch = (async () =>
      okMessages([storedEntry("m1")])) as unknown as typeof fetch;
    expect((await adapter.load()).messages).toHaveLength(1);

    globalThis.fetch = networkDown();
    expect((await adapter.load()).messages).toHaveLength(1);
  });
});

describe("history mutation failure contract (Phase 3.11)", () => {
  it("[P3-16a] append throws on !ok — the failed persist stays unsuccessful", async () => {
    const adapter = makeAdapter("c1");
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") return errStatus(503);
      return okMessages([]);
    }) as unknown as typeof fetch;
    await expect(adapter.append(repoItem("m1"))).rejects.toThrow(
      "Failed to persist message (503)",
    );
  });

  it("[P3-16b] update delegates to append and throws on !ok", async () => {
    const adapter = makeAdapter("c1");
    globalThis.fetch = (async () => errStatus(500)) as unknown as typeof fetch;
    await expect(adapter.update!(repoItem("m1"))).rejects.toThrow(
      "Failed to persist message",
    );
  });

  it("[P3-16c] delete throws on !ok; success invalidates the retained projection", async () => {
    const adapter = makeAdapter("c1");
    globalThis.fetch = (async () =>
      okMessages([storedEntry("m1")])) as unknown as typeof fetch;
    await adapter.load();

    globalThis.fetch = (async () => errStatus(500)) as unknown as typeof fetch;
    await expect(adapter.delete!([repoItem("m1")])).rejects.toThrow(
      "Failed to delete message (500)",
    );

    globalThis.fetch = (async () =>
      okMessages([])) as unknown as typeof fetch;
    await adapter.delete!([repoItem("m1")]);

    // Deletion cleared the retained projection: a later failed load is [].
    globalThis.fetch = networkDown();
    expect((await adapter.load()).messages).toEqual([]);
  });

  it("[P3-16d] withFormat append/delete throw on !ok", async () => {
    const adapter = makeAdapter("c1").withFormat!(fakeFormat);
    globalThis.fetch = (async () => errStatus(500)) as unknown as typeof fetch;
    await expect(
      adapter.append({ message: { id: "m1" }, parentId: null } as never),
    ).rejects.toThrow("Failed to persist message");
    await expect(
      adapter.delete!([{ message: { id: "m1" }, parentId: null } as never]),
    ).rejects.toThrow("Failed to delete message");
  });
});

function networkDown(): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
}

/**
 * Phase 4 — opencode rows must never touch SQLite history.
 * The adapter silently skips append/update/delete when the owner record
 * says opencode, because the OpenCode server is the sole authority.
 */
describe("Phase 4 — opencode history skip (case C)", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    invalidateHistoryCache();
    useWelcomeEngineStore.setState({
      engine: "opencode",
      agent: "test",
      model: "",
      variant: "",
      autoApprove: false,
    });
    useWelcomeScopeStore.getState().setScope({ mode: "simple", folderId: null });
    useSettingsStore.getState().revertChatTarget();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    invalidateHistoryCache();
  });

  async function seedOpencodeAdapter(): Promise<{ adapter: ReturnType<typeof makeAdapter>; remoteId: string }> {
    // Materialize an opencode draft to seed the owner record.
    // Stub fetch first so the POST /api/conversations inside materializeDraft
    // resolves instead of hitting the real network.
    const stubFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, json: async () => ({ id: "c-oc-seeded" }) } as unknown as Response)) as unknown as typeof fetch;
    try {
      const snapshot = captureDraftSnapshot();
      const created = await materializeDraft(snapshot);
      return { adapter: makeAdapter(created.id), remoteId: created.id };
    } finally {
      globalThis.fetch = stubFetch;
    }
  }

  it("append on an opencode-recognized remoteId issues zero fetch calls", async () => {
    const { adapter, remoteId } = await seedOpencodeAdapter();
    expect(peekMaterializedEngine(remoteId)).toBe("opencode");

    let fetchCalls = 0;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      fetchCalls += 1;
      return { ok: true, status: 200, json: async () => ({ id: "never-reached" }) } as Response;
    }) as typeof fetch;

    await adapter.append(repoItem("m1"));
    expect(fetchCalls).toBe(0);
  });

  it("update on an opencode-recognized remoteId issues zero fetch calls", async () => {
    const { adapter, remoteId } = await seedOpencodeAdapter();
    expect(peekMaterializedEngine(remoteId)).toBe("opencode");

    let fetchCalls = 0;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      fetchCalls += 1;
      return { ok: true, status: 200, json: async () => ({ id: "never-reached" }) } as Response;
    }) as typeof fetch;

    await adapter.update!(repoItem("m1"));
    expect(fetchCalls).toBe(0);
  });

  it("delete on an opencode-recognized remoteId issues zero fetch calls", async () => {
    const { adapter, remoteId } = await seedOpencodeAdapter();
    expect(peekMaterializedEngine(remoteId)).toBe("opencode");

    let fetchCalls = 0;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      fetchCalls += 1;
      return { ok: true, status: 200, json: async () => ({ id: "never-reached" }) } as Response;
    }) as typeof fetch;

    await adapter.delete!([repoItem("m1")]);
    expect(fetchCalls).toBe(0);
  });

  it("withFormat append/delete on opencode also skips fetches", async () => {
    const { adapter, remoteId } = await seedOpencodeAdapter();
    expect(peekMaterializedEngine(remoteId)).toBe("opencode");

    let fetchCalls = 0;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      fetchCalls += 1;
      return { ok: true, status: 200, json: async () => ({ id: "never-reached" }) } as Response;
    }) as typeof fetch;

    const wfAdapter = adapter.withFormat!(fakeFormat);
    await wfAdapter.append({ message: { id: "m1" }, parentId: null } as never);
    await wfAdapter.delete!([{ message: { id: "m1" }, parentId: null } as never]);
    expect(fetchCalls).toBe(0);
  });

  it("Direct-recognized remoteId still issues fetches normally", async () => {
    useWelcomeEngineStore.setState({ engine: "direct" });
    useWelcomeScopeStore.getState().setScope({ mode: "simple", folderId: null });
    useSettingsStore.getState().revertChatTarget();

    const stubFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, json: async () => ({ id: "c-direct-seeded" }) } as unknown as Response)) as unknown as typeof fetch;
    let createdId = "";
    try {
      const snapshot = captureDraftSnapshot();
      const created = await materializeDraft(snapshot);
      createdId = created.id;
    } finally {
      globalThis.fetch = stubFetch;
    }

    const adapter = makeAdapter(createdId);

    let fetchCalls = 0;
    globalThis.fetch = (async (url: unknown, _init?: RequestInit) => {
      fetchCalls += 1;
      if (String(url).endsWith("/messages")) {
        return { ok: true, status: 200, json: async () => ({ messages: [] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ id: createdId }) } as Response;
    }) as typeof fetch;

    await adapter.append(repoItem("m1"));
    // At least one fetch (the POST to /messages) must have been issued.
    expect(fetchCalls).toBeGreaterThanOrEqual(1);
    expect(peekMaterializedEngine(createdId)).toBe("direct");
  });
});
