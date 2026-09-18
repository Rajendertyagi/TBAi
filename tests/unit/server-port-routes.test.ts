/**
 * T3-SRV-06 — server routes (status codes & shapes).
 *
 * Tests the `/api/server` route handlers (GET /, PUT /port, POST /restart,
 * POST /check-port) through the real Hono sub-app, with `getActivePort` and
 * `restartListener` mocked so no live server is needed. DB is the real
 * hermetic test DB; the `server.port` row is cleaned up per test.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Hono } from "hono";

// Mock the server module BEFORE importing the route, so the route's
// `import { getActivePort, restartListener } from "../server"` resolves to our
// fakes. `activePort` is mutable so individual tests can control which port
// the probe treats as "active".
let activePort = 3000;
mock.module("../../src/server", () => ({
  getActivePort: () => activePort,
  restartListener: async (port: number) => ({ port, restarted: true }),
}));

const serverRoutesModule = await import("../../src/routes/server");
const serverRoutes = (serverRoutesModule as { default: unknown }).default as never;

import { db } from "../../src/db";

const PORT_SETTING_KEY = "server.port";
function clearPersistedPort(): void {
  db.run("DELETE FROM app_settings WHERE key = ?", [PORT_SETTING_KEY]);
}

const json = { "Content-Type": "application/json" };

/** Mount the real routes sub-app under /api/server. */
function app(): Hono<{ Variables: { requestId: string } }> {
  const root = new Hono<{ Variables: { requestId: string } }>();
  root.route("/api/server", serverRoutes as never);
  return root;
}

async function req(
  method: "GET" | "PUT" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const res = await app().request(`http://localhost${path}`, {
    method,
    headers: body ? json : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json: parsed, text };
}

beforeEach(() => {
  clearPersistedPort();
  delete process.env.PORT;
});

// ── GET / — identity shape ───────────────────────────────────────────────────

describe("GET /api/server — identity shape", () => {
  it("reports activePort, configuredPort, persistedPort, envLocked", async () => {
    // No env lock, no persisted port → configured falls back to default 3000,
    // persisted is null, active is whatever the running server owns.
    const r = await req("GET", "/api/server");
    expect(r.status).toBe(200);
    expect(typeof r.json.activePort).toBe("number");
    expect(typeof r.json.configuredPort).toBe("number");
    expect(r.json.configuredPort).toBe(3000);
    expect(r.json.persistedPort).toBeNull();
    expect(r.json.envLocked).toBe(false);
  });

  it("reports envLocked:true and the env port when PORT is set", async () => {
    process.env.PORT = "5555";
    const r = await req("GET", "/api/server");
    expect(r.status).toBe(200);
    expect(r.json.envLocked).toBe(true);
    expect(r.json.configuredPort).toBe(5555);
    delete process.env.PORT;
  });
});

// ── PUT /port — validation & env lock ────────────────────────────────────────

describe("PUT /api/server/port — save without restart", () => {
  it("persists a valid port and returns 200 with the configured port", async () => {
    const r = await req("PUT", "/api/server/port", { port: 4123 });
    expect(r.status).toBe(200);
    expect(r.json.configuredPort).toBe(4123);
    expect(r.json.error).toBeUndefined();
  });

  it("returns 400 for an out-of-range port (0)", async () => {
    const r = await req("PUT", "/api/server/port", { port: 0 });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("Invalid port (1-65535)");
    expect(Array.isArray(r.json.issues)).toBe(true);
  });

  it("returns 400 for a port above 65535", async () => {
    const r = await req("PUT", "/api/server/port", { port: 65536 });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("Invalid port (1-65535)");
  });

  it("returns 400 for a non-integer port", async () => {
    const r = await req("PUT", "/api/server/port", { port: 1.5 });
    expect(r.status).toBe(400);
  });

  it("returns 400 when the body has no port", async () => {
    const r = await req("PUT", "/api/server/port", {});
    expect(r.status).toBe(400);
  });

  it("returns 409 when the PORT env is locked", async () => {
    process.env.PORT = "8080";
    const r = await req("PUT", "/api/server/port", { port: 4123 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("Port is set by the PORT environment variable");
    delete process.env.PORT;
  });
});

// ── POST /restart — validation & env lock ────────────────────────────────────

describe("POST /api/server/restart — restart", () => {
  it("returns 400 for an out-of-range port", async () => {
    const r = await req("POST", "/api/server/restart", { port: 0 });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("Invalid port (1-65535)");
  });

  it("returns 400 for a port above 65535", async () => {
    const r = await req("POST", "/api/server/restart", { port: 70000 });
    expect(r.status).toBe(400);
  });

  it("returns 409 when the PORT env is locked", async () => {
    process.env.PORT = "8080";
    const r = await req("POST", "/api/server/restart", { port: 4123 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("Port is set by the PORT environment variable");
    delete process.env.PORT;
  });
});

// ── POST /check-port — validation ────────────────────────────────────────────

describe("POST /api/server/check-port — probe", () => {
  it("returns 400 for an out-of-range port", async () => {
    const r = await req("POST", "/api/server/check-port", { port: 0 });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("Invalid port (1-65535)");
  });

  it("returns 400 when the body is empty", async () => {
    const r = await req("POST", "/api/server/check-port", {});
    expect(r.status).toBe(400);
  });

  it("classifies the active port as unavailable (active_port)", async () => {
    activePort = 4999;
    const r = await req("POST", "/api/server/check-port", { port: 4999 });
    expect(r.status).toBe(200);
    expect(r.json.port).toBe(4999);
    expect(r.json.available).toBe(false);
    expect(r.json.reason).toBe("active_port");
    activePort = 3000;
  });

  it("reports a free port as available", async () => {
    // A port that is not the active port and has no listener → available:true.
    activePort = 4999;
    const r = await req("POST", "/api/server/check-port", { port: 4998 });
    expect(r.status).toBe(200);
    expect(r.json.port).toBe(4998);
    expect(r.json.available).toBe(true);
    expect(r.json.reason).toBeUndefined();
    activePort = 3000;
  });
});
