import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  bootstrapOpenCodeSession,
  fetchOpenCodeSessionActivity,
  hasInFlightBootstrap,
  clearAllBootstraps,
  OPENCODE_BOOTSTRAP_PATH,
  OPENCODE_SESSION_ACTIVITY_PATH,
} from "@web/features/opencode/sessionBootstrap";

/**
 * Deterministic tests for conversation-keyed in-flight OpenCode session bootstrap.
 *
 * Requirements:
 * 1. One conversation ID → one in-flight bootstrap promise (singleflight).
 * 2. Two concurrent consumers → one /api/opencode/session request.
 * 3. First consumer unmounts/drops → second consumer still receives successful result.
 * 4. Concurrent unmount/remount does NOT create a second session request.
 * 5. Subsequent calls AFTER settlement revalidate with backend (backend remains authoritative).
 * 6. Different conversation IDs create independent bootstraps.
 * 7. Conversation A result cannot be applied to conversation B.
 * 8. Failed bootstrap is retryable.
 * 9. Invalidation is conservative: does not drop in-flight promise to prevent duplicate requests.
 * 10. Empty or whitespace-only conversationId rejected synchronously without network fetch.
 */

/**
 * Installs a fetch stub that answers ONLY the bootstrap endpoint, and counts
 * only those calls.
 *
 * Why the scoping matters: `bun test` runs every file in one process, so a
 * backend suite can leave the managed OpenCode server's startup probe
 * (`serverManager.waitForHttpReady` → `probeOpenCodeInfo`) still polling in the
 * background. That poll is a real, legitimate fetch that has nothing to do with
 * this module — but an unscoped counter counted it, so these tests failed only
 * when run with the rest of the suite and passed alone. A background server
 * probe is not a duplicate bootstrap, and asserting otherwise tested the
 * runner rather than the code.
 *
 * Anything that is not the endpoint under test is delegated to whatever fetch
 * was installed before the stub, so the probe keeps working and is never handed
 * a fabricated response.
 */
function stubBootstrapFetch(respond: (attempt: number, init?: RequestInit) => unknown): {
  attempts: () => number;
} {
  const previous = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).startsWith(OPENCODE_BOOTSTRAP_PATH)) {
      return previous(input, init);
    }
    attempts++;
    return (await respond(attempts, init)) as Response;
  }) as unknown as typeof fetch;
  return { attempts: () => attempts };
}

/**
 * The `fetch` that was installed before the currently running test.
 *
 * Captured per test rather than once at module load, which is what this file
 * used to do. `bun test` runs every file in one process, so a load-time capture
 * records whatever stub an EARLIER file happened to leak — and then restores that
 * leaked stub after every test here, spreading it further instead of containing
 * it. Test-time capture puts back exactly what the test found.
 */
let fetchBeforeTest: typeof fetch = globalThis.fetch;

beforeEach(() => {
  fetchBeforeTest = globalThis.fetch;
  clearAllBootstraps();
});

afterEach(() => {
  globalThis.fetch = fetchBeforeTest;
  clearAllBootstraps();
});

describe("sessionBootstrap — in-flight singleflight and deduplication", () => {
  it("one conversation ID with concurrent calls issues exactly one fetch", async () => {
    const stub = stubBootstrapFetch(async () => {
      // Simulate network latency
      await new Promise((r) => setTimeout(r, 15));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: "ses_concurrent",
          directory: "D:/test/workspace",
        }),
      };
    });

    const [res1, res2] = await Promise.all([
      bootstrapOpenCodeSession("conv_1"),
      bootstrapOpenCodeSession("conv_1"),
    ]);

    expect(stub.attempts()).toBe(1);
    expect(res1.sessionId).toBe("ses_concurrent");
    expect(res2.sessionId).toBe("ses_concurrent");
    expect(res1.directory).toBe("D:/test/workspace");
    expect(res2.directory).toBe("D:/test/workspace");
  });

  it("sequential calls AFTER completion revalidate with backend (no permanent stale cache)", async () => {
    const stub = stubBootstrapFetch((attempt) => ({
      ok: true,
      status: 200,
      json: async () => ({
        sessionId: `ses_attempt_${attempt}`,
        directory: "D:/test/dir",
      }),
    }));

    // First call completes and settles
    const res1 = await bootstrapOpenCodeSession("conv_seq");
    expect(stub.attempts()).toBe(1);
    expect(res1.sessionId).toBe("ses_attempt_1");

    // Later separate visit revalidates with backend (backend is authoritative)
    const res2 = await bootstrapOpenCodeSession("conv_seq");
    expect(stub.attempts()).toBe(2);
    expect(res2.sessionId).toBe("ses_attempt_2");
  });

  it("first consumer dropping does not prevent second consumer from receiving result", async () => {
    let resolveFetch: (val: unknown) => void;
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });

    stubBootstrapFetch(() => fetchPromise);

    // Consumer A starts bootstrap
    void bootstrapOpenCodeSession("conv_drop");

    // Consumer B attaches to the same in-flight bootstrap
    const promiseB = bootstrapOpenCodeSession("conv_drop");

    // Consumer A "unmounts" (abandons call)
    // Server finishes and resolves
    resolveFetch!({
      ok: true,
      status: 200,
      json: async () => ({
        sessionId: "ses_survived",
        directory: null,
      }),
    });

    const resB = await promiseB;
    expect(resB.sessionId).toBe("ses_survived");
    expect(resB.directory).toBeNull();
  });

  it("rejects empty or whitespace-only conversationId synchronously without fetch", async () => {
    const stub = stubBootstrapFetch(() => ({}) as Response);

    expect(bootstrapOpenCodeSession("")).rejects.toThrow("conversationId is required");
    expect(bootstrapOpenCodeSession("   ")).rejects.toThrow("conversationId is required");
    expect(stub.attempts()).toBe(0);
  });
});

describe("sessionBootstrap — conversation isolation", () => {
  it("different conversation IDs create independent bootstraps", async () => {
    const requestedIds: string[] = [];
    stubBootstrapFetch((_attempt, init) => {
      const body = JSON.parse(String(init?.body)) as { conversationId: string };
      requestedIds.push(body.conversationId);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: `ses_for_${body.conversationId}`,
          directory: `/workspace/${body.conversationId}`,
        }),
      };
    });

    const [resA, resB] = await Promise.all([
      bootstrapOpenCodeSession("conv_A"),
      bootstrapOpenCodeSession("conv_B"),
    ]);

    expect(requestedIds).toEqual(["conv_A", "conv_B"]);
    expect(resA.sessionId).toBe("ses_for_conv_A");
    expect(resB.sessionId).toBe("ses_for_conv_B");
    expect(resA.directory).toBe("/workspace/conv_A");
    expect(resB.directory).toBe("/workspace/conv_B");
  });

  it("conversation A in-flight operation does not satisfy conversation B", async () => {
    const stub = stubBootstrapFetch((_attempt, init) => {
      const body = JSON.parse(String(init?.body)) as { conversationId: string };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: `ses_${body.conversationId}`,
          directory: null,
        }),
      };
    });

    const [resA, resB] = await Promise.all([
      bootstrapOpenCodeSession("conv_A"),
      bootstrapOpenCodeSession("conv_B"),
    ]);

    expect(stub.attempts()).toBe(2);
    expect(resA.sessionId).toBe("ses_conv_A");
    expect(resB.sessionId).toBe("ses_conv_B");
  });
});

describe("sessionBootstrap — failure, retry, and conservative invalidation", () => {
  it("failed bootstrap throws and cleans up in-flight so it is immediately retryable", async () => {
    const stub = stubBootstrapFetch((attempt) => {
      if (attempt === 1) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: "OpenCode binary missing" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: "ses_recovered",
          directory: "D:/recovered",
        }),
      };
    });

    // First attempt fails
    let err: unknown = null;
    try {
      await bootstrapOpenCodeSession("conv_fail");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("OpenCode binary missing");

    // In-flight map cleaned up
    expect(hasInFlightBootstrap("conv_fail")).toBe(false);

    // Second attempt succeeds
    const recovered = await bootstrapOpenCodeSession("conv_fail");
    expect(recovered.sessionId).toBe("ses_recovered");
    expect(stub.attempts()).toBe(2);
  });

  it("a concurrent caller attaches to the in-flight bootstrap instead of spawning a duplicate", async () => {
    // L3 CHANGED THIS. The test used to call `invalidateBootstrap` - an empty
    // function - and assert that it did not delete the in-flight promise. The
    // GUARANTEE is what matters, and it is now asserted directly: the
    // bootstrap map self-cleans in its own `finally`, so a failed attempt is
    // gone by the time the reader presses Retry, and an attempt still in
    // flight is SHARED rather than duplicated.
    const stub = stubBootstrapFetch(async (attempt) => {
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: `ses_attempt_${attempt}`,
          directory: null,
        }),
      };
    });

    // Start P1
    const p1 = bootstrapOpenCodeSession("conv_conserv");
    expect(hasInFlightBootstrap("conv_conserv")).toBe(true);

    // Start P2 while P1 is still in flight -> MUST attach to P1, not spawn duplicate fetch!
    const p2 = bootstrapOpenCodeSession("conv_conserv");

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(stub.attempts()).toBe(1); // exactly 1 network call
    expect(res1.sessionId).toBe(res2.sessionId);
  });

  it("a failed bootstrap is not cached, so a retry really retries", async () => {
    // The other half of the guarantee the removed function used to promise:
    // a FAILED attempt leaves no entry behind, so the reader's Retry starts a
    // new request rather than receiving the same rejection again.
    let attempt = 0;
    const stub = stubBootstrapFetch(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("OpenCode binary missing");
      return {
        ok: true,
        status: 200,
        json: async () => ({ sessionId: "ses_recovered", directory: null }),
      };
    });

    await expect(bootstrapOpenCodeSession("conv_retry")).rejects.toThrow("OpenCode binary missing");
    expect(hasInFlightBootstrap("conv_retry")).toBe(false);

    const recovered = await bootstrapOpenCodeSession("conv_retry");
    expect(recovered.sessionId).toBe("ses_recovered");
    expect(stub.attempts()).toBe(2);
  });

  it("cleanup only removes the exact promise that owns the map entry (no stale race delete)", async () => {
    let resolveP1: (val: unknown) => void;
    let resolveP2: (val: unknown) => void;

    stubBootstrapFetch((attempt) => {
      if (attempt === 1) {
        return new Promise((r) => {
          resolveP1 = r;
        });
      }
      return new Promise((r) => {
        resolveP2 = r;
      });
    });

    // P1 starts
    const p1 = bootstrapOpenCodeSession("conv_race");

    // Simulate P2 replacing P1 directly in the map (e.g. forced eviction / retry)
    clearAllBootstraps();
    const p2 = bootstrapOpenCodeSession("conv_race");

    // Now P1 resolves late
    resolveP1!({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: "ses_p1", directory: null }),
    });
    await p1;

    // P1's finally must NOT have deleted P2 from the map!
    expect(hasInFlightBootstrap("conv_race")).toBe(true);

    // P2 resolves
    resolveP2!({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: "ses_p2", directory: null }),
    });
    const res2 = await p2;
    expect(res2.sessionId).toBe("ses_p2");
    expect(hasInFlightBootstrap("conv_race")).toBe(false);
  });
});

/**
 * The reuse flag is evidence, not a default.
 *
 * A malformed or absent field is NOT "the previous session was restored", so
 * the parser accepts only the literal `true`. The notice's copy depends on
 * this: reporting reuse for a new session would claim a restoration that never
 * happened.
 */
describe("sessionBootstrap — reusedExistingSession is strict", () => {
  function bootstrapWith(payload: Record<string, unknown>) {
    stubBootstrapFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: "ses_flag", directory: null, ...payload }),
    }));
    return bootstrapOpenCodeSession("conv_flag");
  }

  it("reports true only for the literal true", async () => {
    const result = await bootstrapWith({ reusedExistingSession: true });
    expect(result.reusedExistingSession).toBe(true);
  });

  it("reports false when the backend omits the flag", async () => {
    const result = await bootstrapWith({});
    expect(result.reusedExistingSession).toBe(false);
  });

  it("reports false for a non-boolean masquerading as reuse", async () => {
    for (const value of ["true", 1, {}]) {
      const result = await bootstrapWith({ reusedExistingSession: value });
      expect(result.reusedExistingSession).toBe(false);
    }
  });
});

/**
 * The activity read must never fail a conversation load.
 *
 * `running` and `not-running` are the only two authoritative answers. Every
 * other outcome — non-OK, a malformed body, a network failure, an abort — is
 * `unknown`, and `unknown` is never rendered as "not running".
 */
describe("fetchOpenCodeSessionActivity — a status read that cannot throw", () => {
  function stubActivityFetch(respond: (init?: RequestInit) => unknown): {
    calls: () => number;
    body: () => unknown;
  } {
    const previous = globalThis.fetch;
    let calls = 0;
    let body: unknown = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith(OPENCODE_SESSION_ACTIVITY_PATH)) {
        return previous(input, init);
      }
      calls += 1;
      body = init?.body ? JSON.parse(String(init.body)) : null;
      return (await respond(init)) as Response;
    }) as unknown as typeof fetch;
    return { calls: () => calls, body: () => body };
  }

  function read(signal: AbortSignal = new AbortController().signal) {
    return fetchOpenCodeSessionActivity({
      conversationId: "conv_activity",
      sessionId: "ses_activity",
      signal,
    });
  }

  it("posts the conversation/session pair to the backend-filtered route", async () => {
    expect(OPENCODE_SESSION_ACTIVITY_PATH).toBe("/api/opencode/session/activity");
    const stub = stubActivityFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ activity: "running" }),
    }));

    const activity = await read();

    expect(activity).toBe("running");
    expect(stub.calls()).toBe(1);
    expect(stub.body()).toEqual({ conversationId: "conv_activity", sessionId: "ses_activity" });
  });

  it("accepts not-running as the other authoritative answer", async () => {
    stubActivityFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ activity: "not-running" }),
    }));

    expect(await read()).toBe("not-running");
  });

  it("treats a non-OK response as unknown, not idle", async () => {
    stubActivityFetch(() => ({
      ok: false,
      status: 503,
      json: async () => ({ error: "unavailable" }),
    }));

    expect(await read()).toBe("unknown");
  });

  it("treats a malformed body as unknown, not idle", async () => {
    for (const payload of [{}, { activity: "busy" }, { activity: 1 }]) {
      stubActivityFetch(() => ({ ok: true, status: 200, json: async () => payload }));
      expect(await read()).toBe("unknown");
    }
  });

  it("never throws on a network failure", async () => {
    stubActivityFetch(() => {
      throw new Error("socket closed");
    });

    expect(await read()).toBe("unknown");
  });

  it("resolves unknown for an aborted read instead of rejecting", async () => {
    const abort = new AbortController();
    abort.abort();
    stubActivityFetch(() => {
      throw new DOMException("aborted", "AbortError");
    });

    expect(await read(abort.signal)).toBe("unknown");
  });
});
