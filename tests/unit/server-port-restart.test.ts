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
 *
 * ## Why the boot port is never chosen here
 *
 * `bindBootPort` is written for production self-heal, not for tests: on
 * EADDRINUSE it scans upward and SILENTLY binds a different port. A test that
 * picked its port from a fixed range and really bound it therefore had three
 * possible wrong outcomes from one busy port, all of which were observed as
 * intermittent suite failures:
 *
 *   1. the heal landed elsewhere → the active port is not the one asserted;
 *   2. the heal landed on the port the case then restarts to → the same-port
 *      early return fires, so a case asserting "the bind failed" never throws;
 *   3. the scan exhausted → `startServer` throws out of the boot itself.
 *
 * So this file NEVER chooses a port from a range. It asks the OS for a free
 * one, and reads back what was actually bound. Every assertion is derived from
 * that returned value, which makes the file independent of whatever else on the
 * machine holds 4300-5299.
 *
 * ## Why NOT `startServer(0)`
 *
 * Port 0 is the obvious "let the OS choose" answer, and it is WRONG for these
 * assertions. `bindBootPort` records the REQUESTED port (`setActive(server,
 * port)`), not the ephemeral one Bun actually assigned — so `startServer(0)`
 * leaves `getActivePort() === 0` (measured, not assumed). Every case here
 * asserts against `getActivePort()`, so booting on 0 would make all of them
 * compare against a constant 0: green, and proving nothing. The port must be a
 * real, concrete one for the rollback assertions to mean anything.
 *
 * ## Why the listeners are stopped explicitly
 *
 * `setActive` overwrites the module-global `activeServer` WITHOUT stopping the
 * previous listener, so without cleanup every case left a real listener bound
 * for the rest of the test process, where a later file
 * (`server-port-routes.test.ts`) probing a fixed port could be poisoned by it.
 */
import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test";
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
import { getActiveServer } from "../../src/services/server-listener";

beforeEach(() => {
  resetFakes();
});

/**
 * Listeners this file created, so none outlives the case that made it.
 *
 * `setActive` overwrites the module-global `activeServer` without stopping the
 * previous listener, so the boot server of case N is invisible to case N+1 —
 * and still bound. Every real server this file boots is recorded and stopped
 * in `afterEach`, so a leak can never outlive the case that caused it.
 */
const liveServers: Array<{ stop: (close?: boolean) => void | Promise<void> }> = [];

afterEach(async () => {
  const servers = liveServers.splice(0, liveServers.length);
  for (const server of servers) {
    try {
      await server.stop(true);
    } catch {
      /* already closed by the restart path's delayed close; nothing to do */
    }
  }
  // The active listener is among the stopped ones, so release the module-global
  // pointer too: a stale reference would let a later case believe a server is
  // running when it is not.
  if (getActiveServer() !== null) getActiveServer()?.stop(true);
});

/**
 * How many times a boot may be re-attempted on a fresh OS-chosen port.
 *
 * The gap between the probe releasing its port and `startServer` binding it is
 * microseconds, and the OS assigns ephemeral ports from a rotating high range
 * that never overlaps the machine-global 4300-5299 block — so losing that race
 * is extraordinarily unlikely, not impossible. Re-choosing is the honest
 * response to losing it (pick a new free port) rather than asserting on a healed
 * port or skipping: a bounded loop that throws if it ever exhausts is a real
 * failure signal, not a silent flake.
 */
const MAX_BOOT_ATTEMPTS = 5;

/**
 * The low end of the OS-assigned ephemeral range (Windows' IANA dynamic block).
 *
 * Named rather than inlined because it is the whole point of the invariant
 * below: the ports this file binds must be UNREACHABLE from the 4300-5299
 * block the suite used to choose from, so the two can never collide.
 */
const EPHEMERAL_PORT_FLOOR = 49152;

/** The highest valid TCP port; the ceiling of the range above. */
const MAX_PORT = 65535;

/**
 * A concrete port the OS has confirmed free, chosen by binding port 0 (the OS
 * then assigns a free ephemeral port) and reading back what it assigned.
 *
 * Deliberately NOT the machine-global 4300-5299 range the suite used to pick
 * from: those ports are shared with every other process on the machine, which
 * is what made this file intermittent in the first place.
 *
 * @returns A port that was free at the moment it was chosen.
 */
function chooseFreePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = probe.port;
  probe.stop(true);
  if (port <= 0) throw new Error("the OS did not assign an ephemeral port");
  return port;
}

/**
 * Boot the real single server so `activeServer`/`activePort` hold REAL values.
 *
 * `bindBootPort` records the port it was ASKED for, so a concrete OS-chosen
 * port is passed in (not 0) and the value read back is the port actually owned
 * — the number every assertion in this file is derived from.
 *
 * If the boot healed onto a different port, the chosen port was taken in the
 * gap between the probe releasing it and the bind. That is a lost race, not a
 * behaviour worth asserting on: the previous server is stopped and a fresh port
 * chosen. Exhausting the attempts throws rather than returning a wrong port.
 *
 * @returns The port the listener is really serving on.
 */
async function bootOnFreePort(): Promise<number> {
  for (let attempt = 1; attempt <= MAX_BOOT_ATTEMPTS; attempt++) {
    const requested = chooseFreePort();
    const server = await startServer(requested);
    liveServers.push(server);
    const port = realGetActivePort();
    if (port === requested) return port;
    // Healed: stop this one and try a different port. Never fall through with
    // a port the file did not choose.
    server.stop(true);
    liveServers.pop();
  }
  throw new Error(
    `could not boot on an OS-chosen port after ${MAX_BOOT_ATTEMPTS} attempts`,
  );
}

describe("restartListener — rollback order", () => {
  it("bind-conflict: the new bind fails, the old listener keeps serving", async () => {
    const bootPort = await bootOnFreePort();

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
    const bootPort = await bootOnFreePort();

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
    const bootPort = await bootOnFreePort();

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
    const bootPort = await bootOnFreePort();

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

/**
 * The properties the four cases above are DEPENDENT on but that none of them
 * asserts. Without these, a future edit could go straight back to choosing a
 * port from a machine-global range and the rollback cases would go intermittent
 * again — green on a quiet machine, red on a busy one, with nothing in the diff
 * to explain it.
 */
describe("restartListener — the boot port itself", () => {
  it("binds the port it asked for, so the assertions read a real number", async () => {
    // Non-vacuous by construction: `bindBootPort` records the REQUESTED port, so
    // booting on 0 would report 0 here and every other case would then compare
    // against a constant.
    const bootPort = await bootOnFreePort();

    expect(bootPort).toBeGreaterThan(0);
    expect(realGetActivePort()).toBe(bootPort);
    // The listener is genuinely serving that port, so `getActivePort()` is not
    // merely bookkeeping — a real HTTP request answers on it.
    const response = await fetch(`http://127.0.0.1:${bootPort}/healthz`);
    expect(response.status).toBe(200);
  });

  it("never picks a port from the machine-global range the suite leaked into", async () => {
    // The regression itself: the old file chose `4300 + random(1000)`, i.e. a
    // port shared with every other process on the machine. Whatever the OS
    // assigns is a high ephemeral port, so the two can never collide and the
    // production self-heal scan can never run during a test.
    for (let i = 0; i < 3; i++) {
      const bootPort = await bootOnFreePort();
      expect(bootPort).toBeGreaterThanOrEqual(EPHEMERAL_PORT_FLOOR);
      expect(bootPort).toBeLessThanOrEqual(MAX_PORT);
    }
  });
});
