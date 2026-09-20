import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  bootstrapOpenCodeSession,
  hasInFlightBootstrap,
  invalidateBootstrap,
  clearAllBootstraps,
} from "./sessionBootstrap";

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

const originalFetch = globalThis.fetch;

beforeEach(() => {
  clearAllBootstraps();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAllBootstraps();
});

describe("sessionBootstrap — in-flight singleflight and deduplication", () => {
  it("one conversation ID with concurrent calls issues exactly one fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      // Simulate network latency
      await new Promise((r) => setTimeout(r, 15));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: "ses_concurrent",
          directory: "D:/test/workspace",
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const [res1, res2] = await Promise.all([
      bootstrapOpenCodeSession("conv_1"),
      bootstrapOpenCodeSession("conv_1"),
    ]);

    expect(fetchCalls).toBe(1);
    expect(res1.sessionId).toBe("ses_concurrent");
    expect(res2.sessionId).toBe("ses_concurrent");
    expect(res1.directory).toBe("D:/test/workspace");
    expect(res2.directory).toBe("D:/test/workspace");
  });

  it("sequential calls AFTER completion revalidate with backend (no permanent stale cache)", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: `ses_attempt_${fetchCalls}`,
          directory: "D:/test/dir",
        }),
      } as Response;
    }) as unknown as typeof fetch;

    // First call completes and settles
    const res1 = await bootstrapOpenCodeSession("conv_seq");
    expect(fetchCalls).toBe(1);
    expect(res1.sessionId).toBe("ses_attempt_1");

    // Later separate visit revalidates with backend (backend is authoritative)
    const res2 = await bootstrapOpenCodeSession("conv_seq");
    expect(fetchCalls).toBe(2);
    expect(res2.sessionId).toBe("ses_attempt_2");
  });

  it("first consumer dropping does not prevent second consumer from receiving result", async () => {
    let resolveFetch: (val: unknown) => void;
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });

    globalThis.fetch = (() => fetchPromise) as unknown as typeof fetch;

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
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return {} as Response;
    }) as unknown as typeof fetch;

    expect(bootstrapOpenCodeSession("")).rejects.toThrow("conversationId is required");
    expect(bootstrapOpenCodeSession("   ")).rejects.toThrow("conversationId is required");
    expect(fetchCalled).toBe(false);
  });
});

describe("sessionBootstrap — conversation isolation", () => {
  it("different conversation IDs create independent bootstraps", async () => {
    const requestedIds: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { conversationId: string };
      requestedIds.push(body.conversationId);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: `ses_for_${body.conversationId}`,
          directory: `/workspace/${body.conversationId}`,
        }),
      } as Response;
    }) as unknown as typeof fetch;

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
    let fetchCount = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      fetchCount++;
      const body = JSON.parse(String(init?.body)) as { conversationId: string };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: `ses_${body.conversationId}`,
          directory: null,
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const [resA, resB] = await Promise.all([
      bootstrapOpenCodeSession("conv_A"),
      bootstrapOpenCodeSession("conv_B"),
    ]);

    expect(fetchCount).toBe(2);
    expect(resA.sessionId).toBe("ses_conv_A");
    expect(resB.sessionId).toBe("ses_conv_B");
  });
});

describe("sessionBootstrap — failure, retry, and conservative invalidation", () => {
  it("failed bootstrap throws and cleans up in-flight so it is immediately retryable", async () => {
    let attempt = 0;
    globalThis.fetch = (async () => {
      attempt++;
      if (attempt === 1) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: "OpenCode binary missing" }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: "ses_recovered",
          directory: "D:/recovered",
        }),
      } as Response;
    }) as unknown as typeof fetch;

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
    expect(attempt).toBe(2);
  });

  it("conservative invalidation does not delete in-flight promise to prevent concurrent duplicate calls", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: `ses_attempt_${fetchCount}`,
          directory: null,
        }),
      } as Response;
    }) as unknown as typeof fetch;

    // Start P1
    const p1 = bootstrapOpenCodeSession("conv_conserv");
    expect(hasInFlightBootstrap("conv_conserv")).toBe(true);

    // Call invalidateBootstrap while P1 is in flight
    invalidateBootstrap("conv_conserv");

    // Start P2 while P1 is still in flight -> MUST attach to P1, not spawn duplicate fetch!
    const p2 = bootstrapOpenCodeSession("conv_conserv");

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(fetchCount).toBe(1); // exactly 1 network call
    expect(res1.sessionId).toBe(res2.sessionId);
  });

  it("cleanup only removes the exact promise that owns the map entry (no stale race delete)", async () => {
    let resolveP1: (val: unknown) => void;
    let resolveP2: (val: unknown) => void;

    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Promise((r) => {
          resolveP1 = r;
        });
      }
      return new Promise((r) => {
        resolveP2 = r;
      });
    }) as unknown as typeof fetch;

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
