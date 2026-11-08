/**
 * E2E runner port ownership and readiness.
 *
 * The runner used to poll `/readyz` and proceed on any 200, and its
 * `waitForPortFree` returned `void` — so a stale server from an earlier crashed
 * run kept answering, every spec ran against the wrong database, and the leg
 * reported green. These tests pin the fail-closed behaviour:
 *
 *   - a port that stays occupied is a hard stop, not a shrug;
 *   - readiness requires the instance id THIS runner launched, so a stale or
 *     unrelated server answering `/readyz` is rejected;
 *   - a child that exits before readiness is reported immediately, not after
 *     the full timeout;
 *   - the correct owner is accepted.
 *
 * The network is injected, so every case is deterministic and no test binds a
 * real port.
 */
import { describe, expect, it } from "bun:test";
import { waitForPortFree, waitForServer } from "../../../scripts/run-e2e.ts";

/** A fake clock: `sleep` advances it, `now` reads it. */
function fakeClock(start = 0) {
  let clock = start;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

/** A fetch that answers readyz ok and the instance endpoint with `instanceId`. */
function fetchAnswering(instanceId: string | null, readyzOk = true): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/readyz")) {
      return new Response("ok", { status: readyzOk ? 200 : 503 });
    }
    if (url.endsWith("/api/server/instance")) {
      if (instanceId === null) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify({ instanceId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
}

/** A fetch that never answers (connection refused). */
const fetchRefused = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

const neverExits = new Promise<number>(() => {});

describe("waitForPortFree", () => {
  it("returns true when nothing answers on the port", async () => {
    const free = await waitForPortFree(3101, 1_000, async () => false);
    expect(free).toBe(true);
  });

  it("returns false when the port stays occupied past the deadline", async () => {
    // Fail closed: the caller must not spawn a server it cannot bind.
    const free = await waitForPortFree(3101, 50, async () => true);
    expect(free).toBe(false);
  });

  it("returns true once the occupant releases the port", async () => {
    let calls = 0;
    const free = await waitForPortFree(3101, 5_000, async () => {
      calls += 1;
      return calls < 3; // occupied twice, then released
    });
    expect(free).toBe(true);
    expect(calls).toBe(3);
  });
});

describe("waitForServer", () => {
  const base = {
    readyUrl: "http://localhost:3101/readyz",
    instanceUrl: "http://localhost:3101/api/server/instance",
    expectedInstanceId: "instance-ours",
    timeoutMs: 5_000,
  };

  it("accepts the server this runner launched", async () => {
    const clock = fakeClock();
    const readiness = await waitForServer({
      ...base,
      childExited: neverExits,
      fetchImpl: fetchAnswering("instance-ours"),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(readiness).toEqual({ ok: true, reason: "ready", detail: null });
  });

  it("rejects a stale server answering readyz with a different instance id", async () => {
    const clock = fakeClock();
    const readiness = await waitForServer({
      ...base,
      childExited: neverExits,
      fetchImpl: fetchAnswering("instance-stale"),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toBe("instance-mismatch");
    expect(readiness.detail).toContain("instance-stale");
    expect(readiness.detail).toContain("instance-ours");
  });

  it("rejects an unrelated server that answers readyz but has no instance endpoint", async () => {
    const clock = fakeClock();
    const readiness = await waitForServer({
      ...base,
      childExited: neverExits,
      fetchImpl: fetchAnswering(null),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toBe("timeout");
    expect(readiness.detail).toContain("500");
  });

  it("reports a child that exits before readiness, without waiting out the timeout", async () => {
    const clock = fakeClock();
    const readiness = await waitForServer({
      ...base,
      childExited: Promise.resolve(1),
      fetchImpl: fetchRefused,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toBe("child-exited");
    expect(readiness.detail).toContain("code 1");
    // The exit was detected on the next poll, not after the 5000 ms timeout.
    expect(clock.now()).toBeLessThanOrEqual(200);
  });

  it("times out when nothing ever answers", async () => {
    const clock = fakeClock();
    const readiness = await waitForServer({
      ...base,
      childExited: neverExits,
      fetchImpl: fetchRefused,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toBe("timeout");
    expect(readiness.detail).toContain("5000 ms");
  });

  it("keeps waiting while readyz is not ok, then accepts the launched server", async () => {
    const clock = fakeClock();
    let readyzCalls = 0;
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/readyz")) {
        readyzCalls += 1;
        return new Response("not yet", { status: readyzCalls < 3 ? 503 : 200 });
      }
      return new Response(JSON.stringify({ instanceId: "instance-ours" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const readiness = await waitForServer({
      ...base,
      childExited: neverExits,
      fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(readiness.ok).toBe(true);
    expect(readyzCalls).toBe(3);
  });
});
