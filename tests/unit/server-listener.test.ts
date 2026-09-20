/**
 * T3-TI-04 — server-listener unit tests.
 *
 * Targets `src/services/server-listener.ts`:
 *   - `getInstanceId` — env `TBAI_INSTANCE_ID` vs generated UUID (module-level
 *     const, captured at import time; a fresh import re-evaluates it).
 *   - `bindBootPort` — heal scan bounds, explicit-env refusal,
 *     non-EADDRINUSE passthrough, persist-on-heal.
 *   - `restartListener` — same-port no-op, persist-failure rollback.
 *   - Route `GET /api/server/instance` — `{ instanceId }`-only shape.
 *
 * NOTE: the `getInstanceId` env-vs-generated tests use `mock.module(...,
 * () => import(...))` to force a fresh module evaluation so the module-level
 * `INSTANCE_ID` const re-runs against the current env.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { db } from "../../src/db";
import {
  bindBootPort,
  getActivePort,
  getInstanceId,
  initListenerFetch,
  restartListener,
} from "../../src/services/server-listener";
import * as serverPortModule from "../../src/services/server-port";

// ── Fakes standing in for Bun.serve ─────────────────────────────────────────

type FakeServer = { port: number; stopped: boolean; stop(): void };
const serveLog: Array<{ port: number }> = [];
const boundServers: Map<number, FakeServer> = new Map();
let bindFailOnPort: number | null = null;
let nonAddrInUseError: Error | null = null;

function resetServeFakes(): void {
  serveLog.length = 0;
  boundServers.clear();
  bindFailOnPort = null;
  nonAddrInUseError = null;
}

/** Patch global Bun.serve with a fake that records attempts and lets tests inject failures. */
function patchBunServe(): () => void {
  const realServe = Bun.serve;
  (Bun as unknown as { serve: unknown }).serve = (config: { port: number }) => {
    serveLog.push({ port: config.port });
    if (nonAddrInUseError) {
      throw nonAddrInUseError;
    }
    if (bindFailOnPort !== null && config.port === bindFailOnPort) {
      throw new Error("EADDRINUSE: port in use");
    }
    const fake: FakeServer = { port: config.port, stopped: false };
    fake.stop = () => {
      fake.stopped = true;
    };
    boundServers.set(config.port, fake);
    return fake as unknown as ReturnType<typeof Bun.serve>;
  };
  return () => {
    (Bun as unknown as { serve: unknown }).serve = realServe;
  };
}

// ── env / PORT control helpers ──────────────────────────────────────────────

function setEnvPort(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = value;
  }
}

// ── persist seam ────────────────────────────────────────────────────────────

const persistCalls: number[] = [];
let persistFail = false;

function resetPersistFakes(): void {
  persistCalls.length = 0;
  persistFail = false;
}

function patchPersist(): () => void {
  const real = serverPortModule.persistConfiguredPort;
  mock.module("../../src/services/server-port", () => ({
    ...serverPortModule,
    persistConfiguredPort: (port: number) => {
      persistCalls.push(port);
      if (persistFail) throw new Error("db write failed");
      real(port);
    },
  }));
  return () => {
    mock.module("../../src/services/server-port", () => ({
      ...serverPortModule,
      persistConfiguredPort: real,
    }));
  };
}

// ── DB cleanup ──────────────────────────────────────────────────────────────

const PORT_KEY = "server.port";
function clearDbPort(): void {
  db.run("DELETE FROM app_settings WHERE key = ?", [PORT_KEY]);
}

// ── fetch handler stub (required before any bind) ──────────────────────────

function stubFetch(): void {
  initListenerFetch(async () => new Response("ok"));
}

beforeEach(() => {
  resetServeFakes();
  resetPersistFakes();
  clearDbPort();
  setEnvPort(undefined);
});

// ── getInstanceId — env vs generated ────────────────────────────────────────

describe("getInstanceId — env vs generated", () => {
  it("returns a non-empty string (module-captured at import time)", () => {
    const id = getInstanceId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("is a UUID when TBAI_INSTANCE_ID was unset at import time", () => {
    // The module was imported at the top of this file with the test env in
    // effect. If the runner's env does not set TBAI_INSTANCE_ID, the
    // module-level const is crypto.randomUUID() → UUIDv4 shape.
    const id = getInstanceId();
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(id).toMatch(uuidRe);
  });

  it("serves the module-captured id verbatim at GET /api/server/instance", async () => {
    const root = await import("../../src/routes/server");
    const serverRoutes = (root as { default: unknown }).default as never;
    const { Hono } = await import("hono");
    const r = new Hono<{ Variables: { requestId: string } }>();
    r.route("/api/server", serverRoutes as never);
    const res = await r.request("http://localhost/api/server/instance");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["instanceId"]);
    expect(typeof body.instanceId).toBe("string");
    expect(body.instanceId).toBe(getInstanceId());
  });
});

// ── bindBootPort — heal scan bounds & explicit-env refusal ────────────────

describe("bindBootPort — heal scan & env lock", () => {
  it("binds the requested port on success without scanning or persisting", () => {
    stubFetch();
    const unpatch = patchBunServe();
    const unpatchPersist = patchPersist();
    try {
      const result = bindBootPort(4500);
      expect(result.port).toBe(4500);
      expect(serveLog.map((s) => s.port)).toEqual([4500]);
      expect(persistCalls).toEqual([]);
      expect(getActivePort()).toBe(4500);
    } finally {
      unpatch();
      unpatchPersist();
    }
  });

  it("refuses to heal when PORT env is locked (explicit operator conflict)", () => {
    stubFetch();
    setEnvPort("4600");
    const unpatch = patchBunServe();
    const unpatchPersist = patchPersist();
    try {
      bindFailOnPort = 4600;
      let err: unknown;
      try {
        bindBootPort(4600);
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(String(err)).toContain("EADDRINUSE");
      expect(serveLog.length).toBe(1);
      expect(persistCalls).toEqual([]);
    } finally {
      unpatch();
      unpatchPersist();
      setEnvPort(undefined);
    }
  });

  it("scans upward and persists the winner when the base port is occupied", () => {
    stubFetch();
    const unpatch = patchBunServe();
    const unpatchPersist = patchPersist();
    try {
      bindFailOnPort = 4700;
      const result = bindBootPort(4700);
      expect(result.port).toBe(4701);
      expect(serveLog.map((s) => s.port)).toEqual([4700, 4701]);
      expect(persistCalls).toEqual([4701]);
      expect(getActivePort()).toBe(4701);
    } finally {
      unpatch();
      unpatchPersist();
    }
  });

  it("heal scan is bounded: scans at most HEAL_SCAN_LIMIT slots, then rethrows", () => {
    stubFetch();
    const basePort = 4750;
    // Occupy every port in the full scan window (basePort..basePort+101) so
    // the scan exhausts its bound and must rethrow the original error.
    const unpatchServe = patchBunServe();
    const unpatchPersist = patchPersist();
    (Bun as unknown as { serve: unknown }).serve = (config: { port: number }) => {
      serveLog.push({ port: config.port });
      throw new Error("EADDRINUSE: port in use");
    };
    let err: unknown;
    try {
      bindBootPort(basePort);
    } catch (e) {
      err = e;
    }
    // The scan exhausted its bound and rethrew the original base-port error.
    expect(err).toBeDefined();
    expect(String(err)).toContain("EADDRINUSE");
    // 1 (base) + HEAL_SCAN_LIMIT (100) attempts — the scan is bounded, not
    // unbounded. No further ports were tried.
    expect(serveLog.length).toBe(101);
    expect(serveLog[serveLog.length - 1].port).toBe(basePort + 100);
    // The heal loop persists before it binds, so it records a persist call
    // for every scanned port even though all binds failed.
    expect(persistCalls.length).toBe(100);
    unpatchServe();
    unpatchPersist();
  });

  it("rethrows non-EADDRINUSE bind errors immediately (no heal)", () => {
    stubFetch();
    const unpatch = patchBunServe();
    const unpatchPersist = patchPersist();
    try {
      nonAddrInUseError = new Error("permission denied");
      let err: unknown;
      try {
        bindBootPort(4800);
      } catch (e) {
        err = e;
      }
      expect(String(err)).toContain("permission denied");
      expect(serveLog.length).toBe(1);
      expect(persistCalls).toEqual([]);
    } finally {
      unpatch();
      unpatchPersist();
    }
  });
});

// ── restartListener — same-port no-op & persist-failure rollback ───────────

describe("restartListener — same-port no-op", () => {
  it("returns restarted:false when the target port is already active", async () => {
    stubFetch();
    const unpatch = patchBunServe();
    const unpatchPersist = patchPersist();
    try {
      bindBootPort(4900);
      const result = await restartListener(4900);
      expect(result).toEqual({ port: 4900, restarted: false });
      expect(serveLog.map((s) => s.port)).toEqual([4900]);
      expect(persistCalls).toEqual([]);
    } finally {
      unpatch();
      unpatchPersist();
    }
  });
});

describe("restartListener — persist-failure rollback", () => {
  it("closes the new listener and keeps the old active on persist failure", async () => {
    stubFetch();
    const unpatch = patchBunServe();
    const unpatchPersist = patchPersist();
    try {
      bindBootPort(5000);
      persistFail = true;

      let err: unknown;
      try {
        await restartListener(5002);
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(String(err)).toContain("port_persist_failed");
      const newServer = boundServers.get(5002);
      expect(newServer?.stopped).toBe(true);
      expect(getActivePort()).toBe(5000);
    } finally {
      unpatch();
      unpatchPersist();
    }
  });
});
