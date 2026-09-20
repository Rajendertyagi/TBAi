/**
 * T3-SRV-06 — restart-listener rollback-order unit tests.
 *
 * `restartListener` (src/server.ts) rebinds the single application server to a
 * new port WITHOUT re-running subsystem init. The safety is the ORDER:
 *
 *   1. bind the new listener (throws on conflict → old untouched),
 *   2. persist (failure → close the new listener, keep the old serving),
 *   3. swap active + close the old listener after a short delay.
 *
 * A same-port call is a no-op. This file drives the REAL `restartListener`
 * and `getActivePort` by faking the two seams it depends on — the bind layer
 * (`Bun.serve`) and the persist layer (`persistConfiguredPort`) — so the
 * rollback semantics are pinned without a live server or port churn.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { db } from "../../src/db";
import * as serverPortModule from "../../src/services/server-port";
import { restartListener, getActivePort } from "../../src/services/server-listener";

// ── Fake server objects standing in for Bun.serve results ───────────────────

function makeFakeServer() {
  const fake = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  return fake;
}

type FakeServer = ReturnType<typeof makeFakeServer>;

// ── Seams the real module depends on ────────────────────────────────────────

const serveCalls: Array<{ port: number; served: boolean; failed: boolean }> = [];
const persistCalls: Array<{ port: number; failed: boolean }> = [];
let nextServers: FakeServer[] = [];
let persistFail = false;
let bindFail = false;

function resetFakes() {
  serveCalls.length = 0;
  persistCalls.length = 0;
  nextServers = [];
  persistFail = false;
  bindFail = false;
}

// The real boot + restart primitives. `restartListener` / `getActivePort` now
// live in the server-listener service (T3-SRV-07 extracted listener ownership
// + identity out of src/server.ts); `startServer` still lives in src/server.ts
// and initializes the listener's fetch handler before binding.
import { startServer } from "../../src/server";
import {
  restartListener as realRestartListener,
  getActivePort as realGetActivePort,
} from "../../src/services/server-listener";

// We mutate `Bun.serve` (the bind layer) and the server module's persist layer.
// `Bun.serve` is read inside the real module at call time, so patching the
// global is effective. The persist layer is a named import binding in
// src/server.ts; we patch it through the module namespace object with Bun's
// `mock.module`.
const realPersistConfiguredPort = serverPortModule.persistConfiguredPort;

function withFakeServe(fn: () => Promise<void>): Promise<void> {
  const realServe = Bun.serve;
  const fakeServe = (config: { port: number }) => {
    if (bindFail) {
      serveCalls.push({ port: config.port, served: false, failed: true });
      throw new Error("EADDRINUSE: port in use");
    }
    const server = makeFakeServer();
    serveCalls.push({ port: config.port, served: true, failed: false });
    nextServers.push(server);
    return server;
  };
  (Bun as unknown as { serve: unknown }).serve = fakeServe;
  return fn().finally(() => {
    (Bun as unknown as { serve: unknown }).serve = realServe;
  });
}

function withFakePersist(fn: () => Promise<void>): Promise<void> {
  // Patch the server module's view of persistConfiguredPort via mock.module so
  // the real restartListener sees the spy.
  const spy = (port: number) => {
    persistCalls.push({ port, failed: persistFail });
    if (persistFail) throw new Error("db write failed");
    realPersistConfiguredPort(port);
  };
  mock.module("../../src/services/server-port", () => ({
    ...serverPortModule,
    persistConfiguredPort: spy,
  }));
  return fn().finally(() => {
    mock.module("../../src/services/server-port", () => ({
      ...serverPortModule,
      persistConfiguredPort: realPersistConfiguredPort,
    }));
  });
}

// The real boot path so `activeServer`/`activePort` are set to real values
// the rollback logic then reasons about.
import { startServer } from "../../src/server";

beforeEach(() => {
  resetFakes();
});

/** Boot the real single server on a scratch port so `activeServer` is set. */
async function bootOnPort(port: number): Promise<void> {
  await startServer(port);
}

describe("restartListener — rollback order", () => {
  it("bind-conflict: the new bind fails, the old listener keeps serving", async () => {
    const bootPort = 4300 + Math.floor(Math.random() * 1000);
    await bootOnPort(bootPort);

    bindFail = true;
    let err: unknown;
    await withFakeServe(async () => {
      try {
        await realRestartListener(bootPort + 1);
      } catch (e) {
        err = e;
      }
    });

    // The bind threw, so restartListener rethrows a `port_bind_failed` error.
    expect(err).toBeDefined();
    expect(String(err)).toContain("port_bind_failed");
    // No persist happened (bind is step 1, persist is step 2).
    expect(persistCalls).toEqual([]);
    // The active port is unchanged: the old listener still owns it.
    expect(realGetActivePort()).toBe(bootPort);
    // The new bind was attempted but not served.
    expect(serveCalls.some((c) => c.failed)).toBe(true);
  });

  it("persist-failure rollback: closes the NEW listener, old keeps serving", async () => {
    const bootPort = 4300 + Math.floor(Math.random() * 1000);
    await bootOnPort(bootPort);

    const targetPort = bootPort + 2;
    persistFail = true;
    let err: unknown;
    await withFakeServe(
      () =>
        withFakePersist(async () => {
          try {
            await realRestartListener(targetPort);
          } catch (e) {
            err = e;
          }
        }),
    );

    // A `port_persist_failed` error propagates.
    expect(err).toBeDefined();
    expect(String(err)).toContain("port_persist_failed");
    // The new listener was created (bind succeeded)…
    const served = serveCalls.find((c) => c.port === targetPort);
    expect(served?.served).toBe(true);
    // …and then rolled back: the NEW listener's `.stop()` was invoked.
    const newServer = nextServers[0] as unknown as { stopped: boolean };
    expect(newServer?.stopped).toBe(true);
    // The active port is still the old one — the old listener survived.
    expect(realGetActivePort()).toBe(bootPort);
  });

  it("success: swaps active port, the new listener is live, old is scheduled to close", async () => {
    const bootPort = 4300 + Math.floor(Math.random() * 1000);
    await bootOnPort(bootPort);

    const targetPort = bootPort + 3;
    let result: { port: number; restarted: boolean };
    await withFakeServe(
      () =>
        withFakePersist(async () => {
          result = await realRestartListener(targetPort);
        }),
    );

    expect(result).toEqual({ port: targetPort, restarted: true });
    // The persist layer recorded the new port.
    expect(persistCalls.map((c) => c.port)).toEqual([targetPort]);
    // The active port moved to the target.
    expect(realGetActivePort()).toBe(targetPort);
  });

  it("same-port: a no-op that does not rebind or persist", async () => {
    const bootPort = 4300 + Math.floor(Math.random() * 1000);
    await bootOnPort(bootPort);

    let result: { port: number; restarted: boolean };
    await withFakeServe(
      () =>
        withFakePersist(async () => {
          result = await realRestartListener(bootPort);
        }),
    );

    expect(result).toEqual({ port: bootPort, restarted: false });
    // No new bind, no persist.
    expect(serveCalls).toEqual([]);
    expect(persistCalls).toEqual([]);
    // The active port is unchanged.
    expect(realGetActivePort()).toBe(bootPort);
  });
});
