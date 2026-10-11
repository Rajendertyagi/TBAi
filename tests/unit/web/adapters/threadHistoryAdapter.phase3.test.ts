import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type {
  ExportedMessageRepositoryItem,
  MessageFormatAdapter,
} from "@assistant-ui/react";
import {
  createThreadHistoryAdapter,
  invalidateHistoryCache,
} from "@web/adapters/threadHistoryAdapter.ts";
import {
  captureDraftSnapshot,
  materializeDraft,
  peekMaterializedEngine,
} from "@web/features/chat/state/materializeDraft.ts";
import {
  hasAttemptedHistoryRecovery,
  isHistoryLoadFailed,
} from "@web/features/chat/history/useDirectHistoryWindow.ts";
import { useWelcomeEngineStore } from "@web/features/chat/state/welcomeEngine.ts";
import { useWelcomeScopeStore } from "@web/features/chat/state/welcomeScope.ts";
import { useSettingsStore } from "@web/stores";

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

/** A stored row shaped exactly as `GET /messages/window` returns it. */
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

/** The bounded-window response envelope, including the fail-closed `complete`. */
function okWindow(entries: StoredRow[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      messages: entries,
      hasMoreBefore: false,
      hasMoreAfter: false,
      contiguous: true, complete: true,
    }),
  } as Response;
}

const fakeFormat = {
  format: "raw",
  getId: (m: { id: string }) => m.id,
  encode: (item: { message: unknown }) => item.message,
  // `decode` returns a `MessageFormatItem` — `{ parentId, message }` — which is
  // how persisted parentage reaches the runtime. Returning the bare content here
  // would silently drop it.
  decode: (entry: { parent_id?: string | null; content: unknown }) => ({
    parentId: entry.parent_id ?? null,
    message: entry.content,
  }),
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
      okWindow([storedRow("m1")])) as unknown as typeof fetch;
    expect((await adapter.load()).messages).toHaveLength(1);

    globalThis.fetch = networkDown();
    expect((await adapter.load()).messages).toHaveLength(1);
  });
});

/**
 * P2 — a Direct thread's INITIAL history is a bounded window, and it is the only
 * history writer for that thread.
 */
describe("P2 bounded window-backed history (Direct)", () => {
  beforeEach(() => {
    invalidateHistoryCache();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    invalidateHistoryCache();
  });

  function recordingFetch(entries: StoredRow[]) {
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      calls.push(String(url));
      return okWindow(entries);
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("[P2-01] withFormat load() fetches the window endpoint, never the full history", async () => {
    // Linked, as a real window slice always is. `getWindowSlice` walks the
    // parent chain, so every row after the first names the row before it; a
    // slice whose interior rows all carry `parent_id: null` describes a
    // discontiguous chain the backend cannot emit, and the controller now
    // refuses to commit one.
    const { calls, fetchImpl } = recordingFetch([
      { ...storedRow("m1"), parent_id: null },
      { ...storedRow("m2"), parent_id: "m1" },
    ]);
    globalThis.fetch = fetchImpl;

    const adapter = makeAdapter("c1").withFormat!(fakeFormat);
    const loaded = await adapter.load();

    // Exactly one history read, and it is the bounded window route.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/api/conversations/c1/messages/window");
    // The old full-history endpoint must never be consulted for a Direct thread,
    // or the bounded window would be silently overwritten by the whole thread.
    expect(calls.some((c) => c.endsWith("/messages"))).toBe(false);
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.headId).toBe("m2");
  });

  it("[P2-02] persisted parentage survives the bounded load; only the root is clipped", async () => {
    globalThis.fetch = recordingFetch([
      { ...storedRow("m1"), parent_id: null },
      { ...storedRow("m2"), parent_id: "m1" },
      { ...storedRow("m3"), parent_id: "m2" },
    ]).fetchImpl;

    const adapter = makeAdapter("c1").withFormat!(fakeFormat);
    const loaded = await adapter.load();

    expect(loaded.messages.map((m) => m.parentId)).toEqual([null, "m1", "m2"]);
  });

  it("[P2-03] an incomplete slice fails closed and never replaces a valid window", async () => {
    const adapter = makeAdapter("c1").withFormat!(fakeFormat);
    globalThis.fetch = recordingFetch([storedRow("m1")]).fetchImpl;
    expect((await adapter.load()).messages).toHaveLength(1);

    // `contiguous: false, complete: false` is the backend's fail-closed signal: a partial walk must
    // not replace the committed window, so the load is refused outright.
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [storedRow("m2"), storedRow("m3")],
        hasMoreBefore: true,
        hasMoreAfter: false,
        contiguous: false, complete: false,
      }),
    })) as unknown as typeof fetch;

    expect((await adapter.load()).messages).toHaveLength(1);
    // The window still holds m1 — not the m2/m3 the incomplete slice offered.
    const [kept] = (await adapter.load()).messages;
    expect((kept?.message as { id: string }).id).toBe("m1");
  });
});

/**
 * The persistence contract TBAi actually owns: `update` must rewrite a message
 * IN PLACE, keyed by its stable id, through the same server-confirmed upsert as
 * `append`.
 *
 * `useExternalHistory` documents `update` as the seam that "records a tool
 * result that arrives after the message settled", so its correctness is the
 * thing that makes any late write safe — whether or not the runtime chooses to
 * issue one. This drives the real `withFormat(...)` adapter and inspects the
 * bytes that reach the HTTP boundary, so a regression in the envelope (lost
 * id, lost parent, lost format, non-upsert shape) fails here rather than in a
 * user's transcript.
 */
describe("update rewrites a settled message in place", () => {
  const captureBody = () => {
    const bodies: Array<{ message: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") bodies.push(JSON.parse(String(init.body ?? "{}")));
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    return bodies;
  };

  const toolMessage = () => ({
    id: "a1",
    role: "assistant",
    parts: [
      { type: "tool-call", toolCallId: "call_1", toolName: "read_file", state: "output-available", input: { path: "a.ts" }, output: { type: "json", value: { lines: 42 } } },
    ],
  });

  it("a settled message's tool result reaches the boundary with id, parent and format intact", async () => {
    const adapter = makeAdapter("upd-1").withFormat!(fakeFormat);
    const bodies = captureBody();

    const item = { message: toolMessage(), parentId: "u1" } as never;
    // `GenericThreadHistoryAdapter.update` takes the LOCAL message id alongside
    // the item, exactly as `useExternalHistory` calls it.
    await adapter.update!(item, "a1");

    expect(bodies).toHaveLength(1);
    const sent = bodies[0].message as { id: string; parent_id: string; format: string; content: unknown };
    expect(sent.id).toBe("a1");
    expect(sent.parent_id).toBe("u1");
    expect(sent.format).toBe(fakeFormat.format);
    // The tool output itself must survive — this is the whole point of `update`.
    expect(JSON.stringify(sent.content)).toContain("call_1");
    expect(JSON.stringify(sent.content)).toContain("lines");
  });

  it("repeated updates of the same id stay idempotent — one write per call, same identity", async () => {
    const adapter = makeAdapter("upd-2").withFormat!(fakeFormat);
    const bodies = captureBody();

    const item = { message: toolMessage(), parentId: "u1" } as never;
    await adapter.update!(item, "a1");
    await adapter.update!(item, "a1");
    await adapter.update!({ message: { ...toolMessage(), id: "a1" }, parentId: "u1" } as never, "a1");

    // Three calls, three requests — the ADAPTER must not dedupe silently, because
    // the server-side upsert is what makes repetition safe, and hiding the calls
    // here would hide a real regression in the write path.
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map((b) => (b.message as { id: string }).id))).toEqual(new Set(["a1"]));
  });

  it("update failures are surfaced, never swallowed", async () => {
    const adapter = makeAdapter("upd-3").withFormat!(fakeFormat);
    globalThis.fetch = (async () => errStatus(500)) as unknown as typeof fetch;
    await expect(adapter.update!({ message: toolMessage(), parentId: null } as never, "a1")).rejects.toThrow(
      "Failed to persist message",
    );
  });
});

describe("history mutation failure contract (Phase 3.11)", () => {  it("[P3-16a] append throws on !ok — the failed persist stays unsuccessful", async () => {
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
 * The empty conversation vs. the failed load.
 *
 * These drive the REAL production `withFormat(...).load()` — the same call
 * `useExternalHistory` makes once per thread mount — and assert on the real
 * failure signal the recovery component reads. That distinction is the whole
 * point of the empty-conversation fix: an empty thread and an unreachable
 * backend must not look alike, or every new conversation burns a recovery
 * retry and latches `loadFailed` forever.
 */
describe("empty conversation is a successful load, not a failed one", () => {
  const EMPTY_OK_WINDOW: typeof fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [],
        hasMoreBefore: false,
        hasMoreAfter: false,
        // What the backend now answers for a conversation that holds nothing.
        contiguous: true,
        complete: false,
      }),
    }) as Response) as unknown as typeof fetch;

  const EMPTY_BROKEN_WINDOW: typeof fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [],
        hasMoreBefore: false,
        hasMoreAfter: false,
        contiguous: false,
        complete: false,
      }),
    }) as Response) as unknown as typeof fetch;

  const windowFormat = (adapter: ReturnType<typeof makeAdapter>) =>
    adapter.withFormat!(fakeFormat as never);

  it("a zero-row contiguous slice does NOT record a failed load", async () => {
    const adapter = makeAdapter("empty-ok");
    globalThis.fetch = EMPTY_OK_WINDOW;

    const repo = await windowFormat(adapter).load();

    expect(repo.messages).toEqual([]);
    expect(repo.headId).toBeNull();
    expect(isHistoryLoadFailed("empty-ok")).toBe(false);
    expect(hasAttemptedHistoryRecovery("empty-ok")).toBe(false);
  });

  it("loading an empty conversation repeatedly never latches a failure", async () => {
    const adapter = makeAdapter("empty-repeat");
    globalThis.fetch = EMPTY_OK_WINDOW;

    // Re-entry re-mounts the thread resource, which re-runs load(). Each pass
    // must remain a success, or the thread would accumulate failure state that
    // recovery can never clear.
    for (let i = 0; i < 5; i += 1) {
      const repo = await windowFormat(adapter).load();
      expect(repo.messages).toEqual([]);
      expect(isHistoryLoadFailed("empty-repeat")).toBe(false);
    }
  });

  it("an UNREACHABLE backend DOES record a failed load, so recovery can run", async () => {
    const adapter = makeAdapter("down-1");
    globalThis.fetch = networkDown();

    const repo = await windowFormat(adapter).load();

    // Retained history is empty (nothing was ever loaded), and the failure is
    // recorded — this is the signal `DirectViewportBridge` needs.
    expect(repo.messages).toEqual([]);
    expect(isHistoryLoadFailed("down-1")).toBe(true);
  });

  it("an empty slice the server marks UNTRUSTWORTHY is still a failure", async () => {
    // `contiguous: false` means "do not trust this answer" regardless of row
    // count. The fix narrowed the empty case; it must not have weakened
    // fail-closed for a genuinely unsound slice.
    const adapter = makeAdapter("empty-broken");
    globalThis.fetch = EMPTY_BROKEN_WINDOW;

    await windowFormat(adapter).load();

    expect(isHistoryLoadFailed("empty-broken")).toBe(true);
  });

  it("a failed load followed by a good one clears the failure signal", async () => {
    const adapter = makeAdapter("recover-1");
    globalThis.fetch = networkDown();
    await windowFormat(adapter).load();
    expect(isHistoryLoadFailed("recover-1")).toBe(true);

    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          messages: [storedRow("m1")],
          hasMoreBefore: false,
          hasMoreAfter: false,
          contiguous: true,
          complete: true,
        }),
      }) as Response) as unknown as typeof fetch;

    const repo = await windowFormat(adapter).load();

    expect(repo.messages).toHaveLength(1);
    expect(isHistoryLoadFailed("recover-1")).toBe(false);
  });
});

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
