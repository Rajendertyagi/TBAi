/**
 * Boot reconciliation of the persisted tab mirror: which tabs a pass may remove,
 * and — more importantly — which it must never remove.
 *
 * The design claim under test is that reconciliation is REMOVAL-ONLY: `exists`
 * has no write path, so a stale answer cannot resurrect a tab, and `unknown`
 * cannot erase anything. These cases try to break that claim from four
 * directions — a hostile server, a dead backend, a racing second pass, and a
 * conversation deleted on both engine surfaces at once.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import {
  evictIfGone,
  isConfirmedGone,
  reconcileTabMirror,
} from "./tabReconciliation";
import { ConversationNotFoundError } from "./conversationExistence";
import {
  NEW_DRAFT_TAB_ID,
  agentKey,
  chatKey,
  useChatTabsStore,
} from "./chatTabs";
import {
  setClientTransportEnabled,
  setLogLevel,
} from "../../../lib/logger";

const realFetch = globalThis.fetch;

// Eviction emits `tab.evicted` at info. Without silencing the transport the log
// POST would travel through the stubbed fetch and every call count below would
// be measuring the wrong thing.
setClientTransportEnabled(false);
setLogLevel("error");

const store = () => useChatTabsStore.getState();
const tabKeys = () => store().tabs.map((t) => t.key);
const refs = () => store().tabs.map((t) => t.ref);

/** Ids the client actually asked the server about, per request. */
let requests: string[][] = [];

function ok(entries: Array<[string, "exists" | "gone"]>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ results: entries.map(([id, status]) => ({ id, status })) }),
  } as Response;
}

function status(code: number): Response {
  return { ok: false, status: code, json: async () => ({ error: "x" }) } as Response;
}

/** Stub fetch, recording the requested ids. `responder` builds the response. */
function serve(responder: (ids: string[]) => Response): void {
  requests = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
    requests.push(ids);
    return responder(ids);
  }) as unknown as typeof fetch;
}

/** Every requested id answers `exists` unless listed in `gone`. */
function allExistExcept(gone: string[]): (ids: string[]) => Response {
  return (ids) => ok(ids.map((id) => [id, gone.includes(id) ? "gone" : "exists"]));
}

beforeEach(() => {
  // The store is a module singleton; start every case from an empty strip so a
  // previous case can never masquerade as state under test.
  useChatTabsStore.setState({ tabs: [], activeKey: undefined });
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  setClientTransportEnabled(true);
  setLogLevel("debug");
});

describe("reconcileTabMirror — what a pass may remove", () => {
  it("removes nothing when every conversation exists", async () => {
    store().openChat("a");
    store().openChat("b");
    serve(allExistExcept([]));

    await reconcileTabMirror();
    expect(refs().sort()).toEqual(["a", "b"]);
  });

  it("removes ONLY the conversations the server reports gone", async () => {
    store().openChat("keep");
    store().openChat("doomed");
    serve(allExistExcept(["doomed"]));

    await reconcileTabMirror();
    expect(refs()).toEqual(["keep"]);
  });

  it("closes both engine surfaces bound to one gone conversation", async () => {
    store().openChat("doomed");
    store().openAgent("doomed");
    store().openChat("keep");
    serve(allExistExcept(["doomed"]));

    await reconcileTabMirror();
    expect(refs()).toEqual(["keep"]);
    expect(tabKeys()).not.toContain(chatKey("doomed"));
    expect(tabKeys()).not.toContain(agentKey("doomed"));
  });

  it("deduplicates refs before asking (one id per conversation, not per tab)", async () => {
    store().openChat("dup");
    store().openAgent("dup");
    serve(allExistExcept([]));

    await reconcileTabMirror();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(["dup"]);
  });

  it("issues NO request for an empty tab set", async () => {
    serve(allExistExcept([]));
    await reconcileTabMirror();
    expect(requests).toHaveLength(0);
  });

  it("never reconciles the draft, which has no server row yet", async () => {
    // The draft is UI-only until first send. Asking about it would always read
    // as "gone" and would evict the empty conversation the user is typing into.
    store().openChat(NEW_DRAFT_TAB_ID);
    serve(allExistExcept(["new"]));

    await reconcileTabMirror();
    expect(requests).toHaveLength(0);
    expect(refs()).toEqual([NEW_DRAFT_TAB_ID]);
  });

  it("excludes the draft from a batch that also carries a real conversation", async () => {
    store().openChat(NEW_DRAFT_TAB_ID);
    store().openChat("real");
    serve(allExistExcept([]));

    await reconcileTabMirror();
    expect(requests[0]).toEqual(["real"]);
  });

  it("leaves unrelated tabs untouched", async () => {
    store().openChat("a");
    store().openAgent("b");
    serve(allExistExcept(["b"]));

    await reconcileTabMirror();
    expect(tabKeys()).toContain(chatKey("a"));
    expect(tabKeys()).not.toContain(agentKey("b"));
  });
});

describe("reconcileTabMirror — unknown never erases", () => {
  it("removes nothing when the backend is unhealthy (5xx)", async () => {
    store().openChat("a");
    store().openChat("b");
    serve(() => status(503));

    await reconcileTabMirror();
    expect(refs().sort()).toEqual(["a", "b"]);
  });

  it("removes nothing on a network failure", async () => {
    store().openChat("a");
    serve(() => {
      throw new TypeError("fetch failed");
    });

    await reconcileTabMirror();
    expect(refs()).toEqual(["a"]);
  });

  it("removes nothing when the response omits a requested id", async () => {
    store().openChat("a");
    store().openChat("b");
    // Answers only "a" — and "a" is told it is gone. The incomplete response
    // must invalidate the whole pass rather than evict the answered id.
    serve(() => ok([["a", "gone"]]));

    await reconcileTabMirror();
    expect(refs().sort()).toEqual(["a", "b"]);
  });

  it("leaves the tab array byte-identical through an all-unknown pass", async () => {
    store().openChat("a");
    store().openAgent("a");
    store().openChat("b");
    const before = JSON.stringify(store().tabs);

    serve(() => status(500));
    await reconcileTabMirror();

    expect(JSON.stringify(store().tabs)).toBe(before);
  });
});

describe("reconcileTabMirror — idempotence and singleflight", () => {
  it("is a no-op on a second run with no intervening change", async () => {
    store().openChat("doomed");
    serve(allExistExcept(["doomed"]));

    await reconcileTabMirror();
    const afterFirst = tabKeys();
    requests = [];
    serve(allExistExcept([]));

    await reconcileTabMirror();
    expect(tabKeys()).toEqual(afterFirst);
    // Nothing left to check, so no second request is even made.
    expect(requests).toHaveLength(0);
  });

  it("collapses concurrent passes into a single request", async () => {
    store().openChat("doomed");
    store().openChat("keep");
    serve(allExistExcept(["doomed"]));

    await Promise.all([
      reconcileTabMirror(),
      reconcileTabMirror(),
      reconcileTabMirror(),
    ]);

    expect(requests).toHaveLength(1);
    expect(refs()).toEqual(["keep"]);
  });
});

describe("active-tab behavior", () => {
  it("moves the active key onto a surviving tab when the active one is evicted", async () => {
    store().openChat("keep");
    store().openChat("doomed");
    store().setActive(chatKey("doomed"));
    serve(allExistExcept(["doomed"]));

    await reconcileTabMirror();
    expect(store().activeKey).toBe(chatKey("keep"));
  });

  it("falls back to a fresh draft when the evicted tab was the only one", async () => {
    store().openChat("doomed");
    serve(allExistExcept(["doomed"]));

    await reconcileTabMirror();
    expect(refs()).toEqual([NEW_DRAFT_TAB_ID]);
    expect(store().activeKey).toBe(chatKey(NEW_DRAFT_TAB_ID));
  });

  it("never leaves the strip empty", async () => {
    store().openChat("a");
    store().openChat("b");
    store().openChat("c");
    serve(allExistExcept(["a", "b", "c"]));

    await reconcileTabMirror();
    expect(store().tabs.length).toBeGreaterThan(0);
  });
});

describe("evictIfGone — the single eviction rule", () => {
  it("evicts on gone", () => {
    store().openChat("doomed");
    evictIfGone("doomed", "gone");
    expect(refs()).toEqual([NEW_DRAFT_TAB_ID]);
  });

  it("retains on exists", () => {
    store().openChat("alive");
    evictIfGone("alive", "exists");
    expect(refs()).toEqual(["alive"]);
  });

  it("retains on unknown", () => {
    store().openChat("alive");
    evictIfGone("alive", "unknown");
    expect(refs()).toEqual(["alive"]);
  });

  it("is harmless for a conversation with no open tab", () => {
    store().openChat("alive");
    const before = tabKeys();
    evictIfGone("never-opened", "gone");
    expect(tabKeys()).toEqual(before);
  });

  it("is idempotent when repeated for the same conversation", () => {
    store().openChat("doomed");
    store().openChat("keep");
    evictIfGone("doomed", "gone");
    const afterFirst = tabKeys();
    evictIfGone("doomed", "gone");
    evictIfGone("doomed", "gone");
    expect(tabKeys()).toEqual(afterFirst);
  });
});

describe("races", () => {
  it("A: a stale \"exists\" arriving after a \"gone\" cannot resurrect the tab", async () => {
    store().openChat("doomed");
    store().openChat("keep");

    // Pass 1 proves it gone and evicts it.
    serve(allExistExcept(["doomed"]));
    await reconcileTabMirror();
    expect(refs()).toEqual(["keep"]);

    // Pass 2 answers from a stale snapshot claiming it still exists. Because
    // `exists` has no write path, this can only ever be a no-op.
    serve(() => ok([["keep", "exists"], ["doomed", "exists"]]));
    await reconcileTabMirror();

    expect(refs()).toEqual(["keep"]);
    expect(refs()).not.toContain("doomed");
  });

  it("B: a late \"gone\" for a tab another surface already closed is a no-op", async () => {
    store().openChat("doomed");
    store().openChat("keep");

    // Simulate the in-app delete flow closing it first (its own removal path).
    store().closeByRef("doomed");
    const afterDelete = tabKeys();

    evictIfGone("doomed", "gone");
    expect(tabKeys()).toEqual(afterDelete);
  });

  it("C: an offline start evicts nothing, and the recovery pass settles it", async () => {
    store().openChat("doomed");
    store().openChat("keep");

    // Boot pass against a backend that is not ready yet.
    serve(() => status(503));
    await reconcileTabMirror();
    expect(refs().sort()).toEqual(["doomed", "keep"]);

    // The retry that rides the existing availability recovery sequence.
    serve(allExistExcept(["doomed"]));
    await reconcileTabMirror();
    expect(refs()).toEqual(["keep"]);
  });

  it("D: two passes racing on the same ref settle consistently", async () => {
    store().openChat("doomed");
    store().openChat("keep");
    serve(allExistExcept(["doomed"]));

    await Promise.all([reconcileTabMirror(), reconcileTabMirror()]);
    const settled = tabKeys();

    evictIfGone("doomed", "gone");
    evictIfGone("doomed", "gone");
    expect(tabKeys()).toEqual(settled);
    expect(refs()).toEqual(["keep"]);
  });
});

describe("isConfirmedGone", () => {
  it("recognizes the contract's not-found error", () => {
    expect(isConfirmedGone(new ConversationNotFoundError("c1"))).toBe(true);
  });

  it("rejects every other failure shape", () => {
    expect(isConfirmedGone(new Error("Thread status unknown: c1"))).toBe(false);
    expect(isConfirmedGone(new TypeError("fetch failed"))).toBe(false);
    expect(isConfirmedGone(undefined)).toBe(false);
    expect(isConfirmedGone(null)).toBe(false);
  });
});

describe("architectural guard", () => {
  it("emits the agreed eviction event with the agreed fields", async () => {
    const source = await Bun.file(
      new URL("./tabReconciliation.ts", import.meta.url),
    ).text();
    // Observability is part of the contract: an eviction must be traceable
    // beside tab.open / tab.close, named for what actually happened.
    expect(source).toContain('logger.info("chat", "tab.evicted"');
    expect(source).toContain('reason: "not_found"');
  });

  it("routes eviction through the existing single removal mutation", async () => {
    const source = await Bun.file(
      new URL("./tabReconciliation.ts", import.meta.url),
    ).text();
    // One tab-removal path: closeByRef. A second mutation here would be a
    // second way for the mirror to lose a row.
    expect(source).toContain("closeByRef");
    expect(source).not.toContain(".close(");
  });
});
