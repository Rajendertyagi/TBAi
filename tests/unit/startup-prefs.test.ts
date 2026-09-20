/**
 * T3-TR-01 — startup-prefs unit tests.
 *
 * Covers the `startup-prefs` service:
 *   - `getPersistedStartMinimized` — default false on missing row, corrupt JSON,
 *     or a non-boolean stored value; true only when the stored value is the
 *     JSON literal `true`.
 *   - `persistStartMinimized` — upserts the DB row AND writes the mirror file
 *     (`1`/`0` in `<data dir>/start-minimized`).
 *   - `readStartMinimizedMirror` — reads the mirror file back (injectable dir),
 *     returns false when the file is absent.
 *
 * And the `/api/server/startup` route:
 *   - GET returns `{ startMinimized }` (the persisted value).
 *   - PUT accepts a Zod-validated boolean body; invalid/non-boolean/missing
 *     body → 400 with the issue list; persist failure → 500.
 *
 * DB isolation: tests/setup.ts redirects DATA_DIR to a per-PID tmp dir, so the
 * module DB is hermetic. The `server.startMinimized` row and the mirror file
 * are cleaned up per test.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../../src/db";
import { resolveDataDir } from "../../src/services/server-port";
import {
  getPersistedStartMinimized,
  persistStartMinimized,
  readStartMinimizedMirror,
} from "../../src/services/startup-prefs";

const START_MIN_KEY = "server.startMinimized";
const MIRROR_FILE = "start-minimized";

function clearPersisted(): void {
  db.run("DELETE FROM app_settings WHERE key = ?", [START_MIN_KEY]);
}

function clearMirror(): void {
  const file = path.join(resolveDataDir(), MIRROR_FILE);
  try {
    fs.unlinkSync(file);
  } catch {
    /* absent is the default */
  }
}

beforeEach(() => {
  clearPersisted();
  clearMirror();
});

afterEach(() => {
  clearPersisted();
  clearMirror();
});

// ── default / fallback ────────────────────────────────────────────────────────

describe("getPersistedStartMinimized — default & fallback", () => {
  it("defaults to false when no row has ever been persisted", () => {
    clearPersisted();
    expect(getPersistedStartMinimized()).toBe(false);
  });

  it("defaults to false for a corrupt JSON stored value", () => {
    db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [START_MIN_KEY, "{not-json", Date.now()],
    );
    expect(getPersistedStartMinimized()).toBe(false);
  });

  it("defaults to false for a non-boolean stored value (e.g. a string)", () => {
    db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [START_MIN_KEY, JSON.stringify("true"), Date.now()],
    );
    expect(getPersistedStartMinimized()).toBe(false);
  });

  it("reads back a persisted `true`", () => {
    persistStartMinimized(true);
    expect(getPersistedStartMinimized()).toBe(true);
  });

  it("reads back a persisted `false`", () => {
    persistStartMinimized(false);
    expect(getPersistedStartMinimized()).toBe(false);
  });
});

// ── roundtrip ─────────────────────────────────────────────────────────────────

describe("persistStartMinimized — DB + mirror roundtrip", () => {
  it("true roundtrips: DB row + mirror file `1`", () => {
    persistStartMinimized(true);
    expect(getPersistedStartMinimized()).toBe(true);
    const mirror = fs.readFileSync(
      path.join(resolveDataDir(), MIRROR_FILE),
      "utf8",
    ).trim();
    expect(mirror).toBe("1");
    expect(readStartMinimizedMirror()).toBe(true);
  });

  it("false roundtrips: DB row + mirror file `0`", () => {
    persistStartMinimized(false);
    expect(getPersistedStartMinimized()).toBe(false);
    const mirror = fs.readFileSync(
      path.join(resolveDataDir(), MIRROR_FILE),
      "utf8",
    ).trim();
    expect(mirror).toBe("0");
    expect(readStartMinimizedMirror()).toBe(false);
  });

  it("re-persisting overwrites both the row and the mirror", () => {
    persistStartMinimized(true);
    expect(readStartMinimizedMirror()).toBe(true);
    persistStartMinimized(false);
    expect(getPersistedStartMinimized()).toBe(false);
    expect(readStartMinimizedMirror()).toBe(false);
    const mirror = fs.readFileSync(
      path.join(resolveDataDir(), MIRROR_FILE),
      "utf8",
    ).trim();
    expect(mirror).toBe("0");
  });
});

// ── mirror file reads ────────────────────────────────────────────────────────

describe("readStartMinimizedMirror — file read", () => {
  it("reads `1` as true", () => {
    const dir = path.join(resolveDataDir(), "mirror-1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MIRROR_FILE), "1\n");
    expect(readStartMinimizedMirror(dir)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads `0` as false", () => {
    const dir = path.join(resolveDataDir(), "mirror-0");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MIRROR_FILE), "0\n");
    expect(readStartMinimizedMirror(dir)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns false when the mirror file is absent", () => {
    const dir = path.join(resolveDataDir(), "mirror-missing");
    fs.mkdirSync(dir, { recursive: true });
    expect(readStartMinimizedMirror(dir)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns false for a corrupt / non-boolean mirror value", () => {
    const dir = path.join(resolveDataDir(), "mirror-bad");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MIRROR_FILE), "banana\n");
    expect(readStartMinimizedMirror(dir)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── route shapes (GET/PUT /api/server/startup) ──────────────────────────────

// NOTE: no mock of the server-listener service here. These tests only hit
// the /startup endpoints, which never call the listener functions — and a
// second mock.module registration for the same path (see
// server-port-routes.test.ts) forces Bun to re-evaluate the service's
// importers, re-running src/server.ts top-level route registration on the
// already-built app ("matcher already built"). The real service module is
// side-effect free, so importing it unmocked is safe.

// Import the leaf route module ONCE and reuse the resolved app across all
const { Hono: HonoNS } = await import("hono");
const serverRoutesMod = await import("../../src/routes/server");
const serverRoutes = (serverRoutesMod as { default: unknown }).default as never;
const HonoCtor = HonoNS as unknown as new () => {
  route(base: string, app: unknown): { request(url: string, init?: RequestInit): Promise<Response> };
};
const root = (() => {
  const r = new HonoCtor();
  r.route("/api/server", serverRoutes);
  return r;
})();

describe("route /api/server/startup", () => {
  it("GET returns { startMinimized } defaulting to false", async () => {
    clearPersisted();
    const res = await root.request("http://localhost/api/server/startup");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ startMinimized: false });
  });

  it("GET reflects a persisted `true`", async () => {
    persistStartMinimized(true);
    const res = await root.request("http://localhost/api/server/startup");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ startMinimized: true });
  });

  it("PUT with a valid boolean body persists and returns 200 with the value", async () => {
    const res = await root.request("http://localhost/api/server/startup", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startMinimized: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ startMinimized: true });
    expect(getPersistedStartMinimized()).toBe(true);
  });

  it("PUT returns 400 for a non-boolean body", async () => {
    const res = await root.request("http://localhost/api/server/startup", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startMinimized: "true" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid startup preferences");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("PUT returns 400 for a missing body (no startMinimized field)", async () => {
    const res = await root.request("http://localhost/api/server/startup", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid startup preferences");
  });

  it("PUT returns 400 for an empty body", async () => {
    const res = await root.request("http://localhost/api/server/startup", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect(res.status).toBe(400);
  });
});
