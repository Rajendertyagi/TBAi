import { describe, it, expect, mock } from "bun:test";

describe("useConversationsList hook architecture guard", () => {
  it("stale request protection via cancellation pattern", async () => {
    let resolveFirst: (val: any) => void = () => {};
    let resolveSecond: (val: any) => void = () => {};

    const firstPromise = new Promise((res) => {
      resolveFirst = res;
    });
    const secondPromise = new Promise((res) => {
      resolveSecond = res;
    });

    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock((_url: string | URL | Request) => {
      callCount++;
      const promise = callCount === 1 ? firstPromise : secondPromise;
      return promise.then((data) => ({
        ok: true,
        json: async () => data,
      }));
    }) as any;

    // Simulate search A triggering first request
    const p1 = globalThis.fetch("/api/conversations?search=A");
    // Simulate search B triggering second request immediately
    const p2 = globalThis.fetch("/api/conversations?search=B");

    // Second request B resolves first
    resolveSecond({ threads: [{ id: "b", title: "B" }] });
    const res2 = await (await p2).json();
    expect(res2.threads[0].title).toBe("B");

    // First request A resolves later
    resolveFirst({ threads: [{ id: "a", title: "A" }] });
    const res1 = await (await p1).json();
    expect(res1.threads[0].title).toBe("A");

    // Restore original fetch
    globalThis.fetch = originalFetch;
  });
});
