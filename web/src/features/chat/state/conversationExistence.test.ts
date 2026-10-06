/**
 * The conversation-existence contract: three-valued classification, the
 * data-preserving single-id probe, and the fail-safe batch probe.
 *
 * These are the rules the whole orphan-tab fix rests on, so the cases are
 * chosen to break the design rather than to restate it:
 *   - only 404 may ever mean "gone" (a 5xx or another 4xx must not destroy state)
 *   - exactly one request per probe (an existence-only API would tempt a second)
 *   - an incomplete batch response degrades to "retain everything", never to
 *     "evict the ids that happened to be answered"
 */
import { describe, it, expect, afterAll } from "bun:test";
import {
  classifyExistence,
  ConversationNotFoundError,
  probeConversation,
  reconcileConversations,
  type ConversationRow,
} from "./conversationExistence";
import {
  setClientTransportEnabled,
  setLogLevel,
} from "../../../lib/logger";

const realFetch = globalThis.fetch;

// The batch probe logs a warn on an incomplete response. Without this the log
// transport would post to /api/logs through the very fetch these tests stub,
// and the call counts below would stop meaning anything.
setClientTransportEnabled(false);
setLogLevel("error");
afterAll(() => {
  globalThis.fetch = realFetch;
  setClientTransportEnabled(true);
});

function row(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "c1",
    title: "A conversation",
    status: "regular",
    engine: "direct",
    workspaceMode: "simple",
    workspaceFolderId: null,
    opencodeAgent: null,
    opencodeModel: null,
    opencodeVariant: null,
    opencodeAutoApprove: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function res(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** A 2xx whose body cannot be parsed at all. */
function resUnreadable(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    // Explicit return type: an arrow that only throws infers `Promise<never>`,
    // which defeats TypeScript's assertion-overlap check on the `as Response`.
    json: async (): Promise<unknown> => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  } as Response;
}

function throwsFetch(err: Error): void {
  globalThis.fetch = (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

describe("classifyExistence — only 404 is ever \"gone\"", () => {
  it("maps 2xx to exists", () => {
    for (const status of [200, 201, 202, 204]) {
      expect(classifyExistence(status)).toBe("exists");
    }
  });

  it("maps 404 to gone", () => {
    expect(classifyExistence(404)).toBe("gone");
  });

  it("maps every other 4xx to unknown, NOT gone (a refused request says nothing about the row)", () => {
    for (const status of [400, 401, 403, 409, 410, 422]) {
      expect(classifyExistence(status)).toBe("unknown");
    }
  });

  it("maps 5xx to unknown, NOT gone (an unhealthy server is not a missing row)", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyExistence(status)).toBe("unknown");
    }
  });

  it("maps 1xx and 3xx to unknown", () => {
    for (const status of [100, 101, 301, 302, 307, 308]) {
      expect(classifyExistence(status)).toBe("unknown");
    }
  });
});

describe("probeConversation — one request, verdict plus row data", () => {
  it("returns exists WITH the row data on 200", async () => {
    globalThis.fetch = (async () =>
      res(200, row({ title: "Live conversation", engine: "opencode" }))) as unknown as typeof fetch;

    const probe = await probeConversation("c1");
    expect(probe.status).toBe("exists");
    // The data-preservation guarantee: a consumer that needs a field must never
    // have to issue a second request to obtain it.
    expect(probe.data?.title).toBe("Live conversation");
    expect(probe.data?.engine).toBe("opencode");
  });

  it("issues EXACTLY ONE request per probe", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return res(200, row());
    }) as unknown as typeof fetch;

    await probeConversation("c1");
    expect(calls).toBe(1);
  });

  it("percent-encodes the id", async () => {
    let seen = "";
    globalThis.fetch = (async (url: string) => {
      seen = String(url);
      return res(200, row());
    }) as unknown as typeof fetch;

    await probeConversation("a b/c");
    expect(seen).toBe("/api/conversations/a%20b%2Fc");
  });

  it("returns gone on 404, with no data", async () => {
    globalThis.fetch = (async () => res(404, { error: "Conversation not found" })) as unknown as typeof fetch;
    const probe = await probeConversation("dead");
    expect(probe).toEqual({ status: "gone", data: null });
  });

  it("returns unknown for every non-404 failure status", async () => {
    for (const status of [400, 409, 500, 502, 503]) {
      globalThis.fetch = (async () => res(status, { error: "x" })) as unknown as typeof fetch;
      const probe = await probeConversation("c1");
      expect(probe).toEqual({ status: "unknown", data: null });
    }
  });

  it("returns unknown on a network throw", async () => {
    throwsFetch(new TypeError("fetch failed"));
    expect(await probeConversation("c1")).toEqual({ status: "unknown", data: null });
  });

  it("returns unknown on abort/timeout", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    throwsFetch(abort);
    expect(await probeConversation("c1")).toEqual({ status: "unknown", data: null });
  });

  it("returns unknown, NOT exists, when a 200 body is unparseable", async () => {
    globalThis.fetch = (async () => resUnreadable(200)) as unknown as typeof fetch;
    expect(await probeConversation("c1")).toEqual({ status: "unknown", data: null });
  });

  it("returns unknown, NOT exists, when a 200 body is not a JSON object", async () => {
    // An unreadable response is not evidence of existence — the mirror image of
    // the mistake this contract exists to prevent.
    for (const body of [null, [1, 2], "a string", 42, true]) {
      globalThis.fetch = (async () => res(200, body)) as unknown as typeof fetch;
      expect(await probeConversation("c1")).toEqual({ status: "unknown", data: null });
    }
  });
});

describe("reconcileConversations — fail-safe batch", () => {
  /** Records the ids each call actually asked about. */
  let seenIds: string[][] = [];
  let calls = 0;

  function install(responder: (ids: string[]) => Response): void {
    seenIds = [];
    calls = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls++;
      const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
      seenIds.push(ids);
      return responder(ids);
    }) as unknown as typeof fetch;
  }

  function results(entries: Array<[string, "exists" | "gone"]>): Response {
    return res(200, {
      results: entries.map(([id, status]) => ({ id, status })),
    });
  }

  it("maps a complete response per id", async () => {
    install(() => results([["a", "exists"], ["b", "gone"]]));
    const verdicts = await reconcileConversations(["a", "b"]);
    expect(verdicts.get("a")).toBe("exists");
    expect(verdicts.get("b")).toBe("gone");
  });

  it("issues no request at all for an empty id set", async () => {
    install(() => results([]));
    const verdicts = await reconcileConversations([]);
    expect(calls).toBe(0);
    expect(verdicts.size).toBe(0);
  });

  it("sends the requested ids, POSTing to the reconcile endpoint", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      expect(init?.method).toBe("POST");
      return results([["a", "exists"]]);
    }) as unknown as typeof fetch;

    await reconcileConversations(["a"]);
    expect(seenUrl).toBe("/api/conversations/reconcile");
  });

  it("INVALIDATES THE WHOLE PASS when one requested id is missing from the response", async () => {
    // The strongest fail-safe in the design: a server bug must degrade to
    // "retain everything", never to "evict the ids that happened to be answered".
    install(() => results([["a", "gone"]]));
    const verdicts = await reconcileConversations(["a", "b", "c"]);
    expect(verdicts.get("a")).toBe("unknown");
    expect(verdicts.get("b")).toBe("unknown");
    expect(verdicts.get("c")).toBe("unknown");
  });

  it("returns unknown for every id on a non-2xx response", async () => {
    for (const status of [400, 500, 503]) {
      install(() => res(status, { error: "x" }));
      const verdicts = await reconcileConversations(["a", "b"]);
      expect(verdicts.get("a")).toBe("unknown");
      expect(verdicts.get("b")).toBe("unknown");
    }
  });

  it("returns unknown for every id on a network throw", async () => {
    install(() => {
      throw new TypeError("fetch failed");
    });
    const verdicts = await reconcileConversations(["a"]);
    expect(verdicts.get("a")).toBe("unknown");
  });

  it("returns unknown for every id when the body is unreadable or malformed", async () => {
    install(() => resUnreadable(200));
    expect((await reconcileConversations(["a"])).get("a")).toBe("unknown");

    for (const body of [null, {}, { results: "nope" }, [1, 2]]) {
      install(() => res(200, body));
      expect((await reconcileConversations(["a"])).get("a")).toBe("unknown");
    }
  });

  it("ignores ids the client never asked about", async () => {
    install(() => results([["a", "exists"], ["stranger", "gone"]]));
    const verdicts = await reconcileConversations(["a"]);
    expect(verdicts.size).toBe(1);
    expect(verdicts.has("stranger")).toBe(false);
    // An unrequested id must not be mistaken for a missing answer.
    expect(verdicts.get("a")).toBe("exists");
  });

  it("keeps the FIRST verdict for a duplicated response entry", async () => {
    install(() =>
      results([["a", "exists"], ["a", "gone"]]),
    );
    expect((await reconcileConversations(["a"])).get("a")).toBe("exists");
  });

  it("ignores an entry with an unrecognized status value", async () => {
    install(() =>
      res(200, { results: [{ id: "a", status: "weird" }, { id: "b", status: "gone" }] }),
    );
    // "a" has no usable verdict, so the pass is incomplete -> everything unknown.
    const verdicts = await reconcileConversations(["a", "b"]);
    expect(verdicts.get("a")).toBe("unknown");
    expect(verdicts.get("b")).toBe("unknown");
  });
});

describe("class identity survives the move to this module", () => {
  it("is the SAME constructor through the adapter re-export", async () => {
    // The adapter re-exports rather than re-declares. If these ever became two
    // classes, `err instanceof ConversationNotFoundError` would silently stop
    // matching on one import path and a 404 would degrade into "unknown" —
    // i.e. orphan tabs would quietly stop being evicted, with nothing failing.
    const { ConversationNotFoundError: ViaAdapter } = await import(
      "../../../adapters/remoteThreadListAdapter"
    );
    expect(ViaAdapter).toBe(ConversationNotFoundError);
  });

  it("is recognized by the eviction rule from either import path", async () => {
    const { ConversationNotFoundError: ViaAdapter } = await import(
      "../../../adapters/remoteThreadListAdapter"
    );
    const { isConfirmedGone } = await import("./tabReconciliation");
    expect(isConfirmedGone(new ViaAdapter("c1"))).toBe(true);
  });
});

/**
 * Consumer adoption guards.
 *
 * Source-level on purpose. Asserting these hooks' runtime behavior would need a
 * DOM testing library, which this project does not depend on (AGENTS.md forbids
 * adding one without a recorded decision), so the house convention for this
 * class of check is the source guard already used by
 * `remoteThreadListAdapter.phase3.test.ts` and `TabStrip.test.tsx`.
 *
 * What they protect is the regression this change exists to remove: a
 * conversation read that collapses "the row is gone" into "response not ok".
 */
describe("consumer adoption — no lossy conversation reads remain", () => {
  const read = (rel: string) => Bun.file(new URL(rel, import.meta.url)).text();

  const PROBES = [
    ["ChatHeader", "../components/ChatHeader.tsx"],
    ["OpenCodeSessionRow", "../../opencode/OpenCodeSessionRow.tsx"],
    ["useOpenCodeConversationConfig", "../../opencode/useOpenCodeConversationConfig.ts"],
  ] as const;

  for (const [name, rel] of PROBES) {
    it(`${name} reads conversations through the shared contract`, async () => {
      const source = await read(rel);
      expect(source).toContain("probeConversation");
      expect(source).not.toContain("fetch(`/api/conversations/");
    });

    it(`${name} still reads the row fields it needs`, async () => {
      const source = await read(rel);
      // Data preservation: the verdict travels WITH the row, so each consumer
      // must still be reading its own fields off the probe result.
      expect(source).toContain('probe.status !== "exists"');
      expect(source).toContain("probe.data");
    });
  }

  it("ChatHeader still derives the project crumb from the row", async () => {
    const source = await read("../components/ChatHeader.tsx");
    expect(source).toContain("workspaceMode");
    expect(source).toContain("workspaceFolderId");
  });

  it("useOpenCodeConversationConfig keeps the fail-closed auto-approve rule", async () => {
    const source = await read("../../opencode/useOpenCodeConversationConfig.ts");
    expect(source).toContain("opencodeAutoApprove === true");
  });

  it("OpenCodeSessionRow still reads agent, model, variant and folder", async () => {
    const source = await read("../../opencode/OpenCodeSessionRow.tsx");
    for (const field of [
      "opencodeAgent",
      "opencodeModel",
      "opencodeVariant",
      "workspaceFolderId",
    ]) {
      expect(source).toContain(field);
    }
  });

  it("the tab strip routes its probe verdict to the eviction owner", async () => {
    const source = await read("../../../components/TabStrip.tsx");
    // It keeps using the adapter (an architectural guard in TabStrip.test.tsx
    // requires that path), but must no longer decide alone that a failure means
    // "keep this tab".
    expect(source).toContain("threadListAdapter");
    expect(source).toContain("evictIfGone");
    expect(source).toContain("isConfirmedGone");
  });

  it("the adapter delegates instead of re-deriving the verdict", async () => {
    const source = await read("../../../adapters/remoteThreadListAdapter.tsx");
    expect(source).toContain("probeConversation");
    // The 404 test now lives in one place rather than being duplicated.
    expect(source).not.toContain("res.status === 404");
  });

  it("useConversationTab no longer closes tabs through its own removal path", async () => {
    const source = await read("./useConversationTab.ts");
    expect(source).toContain("evictIfGone");
    // Precisely: the 404 branch must not walk the tab array closing keys itself.
    // (A blanket ban on `close(` would be wrong — the engine-mismatch branch
    // legitimately closes the wrong-surface tab for a conversation that lives.)
    expect(source).not.toContain("for (const tab of current.tabs)");
  });
});

describe("wiring — the pass is registered and retried", () => {
  it("the shell registers the boot pass", async () => {
    const source = await Bun.file(
      new URL("../../../app/layout/AppShell.tsx", import.meta.url),
    ).text();
    expect(source).toContain("registerTabReconciliation");
  });

  it("the recovery sequence re-runs it (no new poller, no second sync system)", async () => {
    const source = await Bun.file(
      new URL("../../availability/recovery.ts", import.meta.url),
    ).text();
    expect(source).toContain("reconcileTabMirror");
    // Deliberately absent: a private timer or channel would be a second
    // synchronization system for state the availability store already owns.
    expect(source).not.toContain("BroadcastChannel");
    expect(source).not.toContain("setInterval");
  });
});
