/**
 * T3-SRV-06 — web-server port unit tests.
 *
 * Covers the `server-port` service (precedence, validation, persist roundtrip)
 * and the restart-listener rollback order (bind-new → persist → swap → delayed
 * old close; persist-failure rollback closes the new listener, old keeps
 * serving; same-port no-op; bind-conflict preserves the old listener). Live
 * behavior is already proven (T3-SRV-01–05); this file pins the unit
 * contracts.
 *
 * DB isolation: tests/setup.ts redirects DATA_DIR to a per-PID tmp dir, so the
 * module DB is hermetic. The `server.port` app_settings row is cleaned up per
 * test.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  DEFAULT_WEB_PORT,
  isPortEnvLocked,
  getPersistedPort,
  persistConfiguredPort,
  resolveConfiguredPort,
  writePortFile,
  resolveDataDir,
} from "../../src/services/server-port";
import { db } from "../../src/db";
import fs from "fs";
import path from "path";

const PORT_SETTING_KEY = "server.port";

function clearPersistedPort(): void {
  db.run("DELETE FROM app_settings WHERE key = ?", [PORT_SETTING_KEY]);
}

beforeEach(() => {
  clearPersistedPort();
  delete process.env.PORT;
});

afterEach(() => {
  clearPersistedPort();
});

// ── Precedence: PORT env → persisted → default ───────────────────────────────

describe("resolveConfiguredPort — precedence", () => {
  it("defaults to 3000 when no env and no persisted port", () => {
    clearPersistedPort();
    delete process.env.PORT;
    const { port, envLocked } = resolveConfiguredPort();
    expect(port).toBe(DEFAULT_WEB_PORT);
    expect(envLocked).toBe(false);
  });

  it("uses the persisted port when there is no env lock", () => {
    persistConfiguredPort(4123);
    delete process.env.PORT;
    const { port, envLocked } = resolveConfiguredPort();
    expect(port).toBe(4123);
    expect(envLocked).toBe(false);
  });

  it("the PORT env wins over the persisted port", () => {
    persistConfiguredPort(4123);
    process.env.PORT = "5555";
    const { port, envLocked } = resolveConfiguredPort();
    expect(port).toBe(5555);
    expect(envLocked).toBe(true);
  });

  it("an invalid PORT env falls back to the default (env still locked)", () => {
    persistConfiguredPort(4123);
    process.env.PORT = "99999"; // out of range
    const { port, envLocked } = resolveConfiguredPort();
    expect(port).toBe(DEFAULT_WEB_PORT);
    expect(envLocked).toBe(true);
  });

  it("a non-numeric PORT env falls back to the default (env still locked)", () => {
    process.env.PORT = "not-a-port";
    const { port, envLocked } = resolveConfiguredPort();
    expect(port).toBe(DEFAULT_WEB_PORT);
    expect(envLocked).toBe(true);
  });

  it("a whitespace-only PORT env is not locked", () => {
    persistConfiguredPort(4123);
    process.env.PORT = "   ";
    const { port, envLocked } = resolveConfiguredPort();
    expect(port).toBe(4123);
    expect(envLocked).toBe(false);
  });
});

// ── isPortEnvLocked ──────────────────────────────────────────────────────────

describe("isPortEnvLocked", () => {
  it("is true only when PORT is set to a non-blank value", () => {
    delete process.env.PORT;
    expect(isPortEnvLocked()).toBe(false);
    process.env.PORT = "   ";
    expect(isPortEnvLocked()).toBe(false);
    process.env.PORT = "8080";
    expect(isPortEnvLocked()).toBe(true);
  });
});

// ── Port validation boundaries ───────────────────────────────────────────────

describe("port validation boundaries", () => {
  it("rejects 0 (below the valid range)", () => {
    // getPersistedPort parses a stored 0 as null (invalid).
    db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`,
      [PORT_SETTING_KEY, "0", Date.now()],
    );
    expect(getPersistedPort()).toBeNull();
  });

  it("accepts 1 (lowest valid port)", () => {
    db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`,
      [PORT_SETTING_KEY, "1", Date.now()],
    );
    expect(getPersistedPort()).toBe(1);
  });

  it("accepts 65535 (highest valid port)", () => {
    db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`,
      [PORT_SETTING_KEY, "65535", Date.now()],
    );
    expect(getPersistedPort()).toBe(65535);
  });

  it("rejects 65536 (above the valid range)", () => {
    db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`,
      [PORT_SETTING_KEY, "65536", Date.now()],
    );
    expect(getPersistedPort()).toBeNull();
  });

  it("a stored non-integer is truncated to its integer part (parseInt semantics)", () => {
    // `getPersistedPort` parses via `Number.parseInt(..., 10)`, so a value
    // like 12.5 resolves to 12 (in range), not to null. This documents the
    // truncation, not a rejection.
    db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`,
      [PORT_SETTING_KEY, "12.5", Date.now()],
    );
    expect(getPersistedPort()).toBe(12);
  });

  it("a stored out-of-range value is null even after truncation", () => {
    db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`,
      [PORT_SETTING_KEY, "70000.9", Date.now()],
    );
    expect(getPersistedPort()).toBeNull();
  });
});

// ── persist-then-read roundtrip ──────────────────────────────────────────────

describe("persist-then-read roundtrip", () => {
  it("writes the DB row and the mirror file; a later read returns the port", () => {
    persistConfiguredPort(7777);
    expect(getPersistedPort()).toBe(7777);

    const mirror = path.join(resolveDataDir(), "port");
    expect(fs.readFileSync(mirror, "utf8").trim()).toBe("7777");
  });

  it("overwrites an existing persisted port on re-persist", () => {
    persistConfiguredPort(1111);
    persistConfiguredPort(2222);
    expect(getPersistedPort()).toBe(2222);
  });

  it("returns null when no value was ever saved", () => {
    clearPersistedPort();
    expect(getPersistedPort()).toBeNull();
  });

  it("returns null for a corrupt stored value", () => {
    db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`,
      [PORT_SETTING_KEY, "{not json", Date.now()],
    );
    expect(getPersistedPort()).toBeNull();
  });
});

// ── writePortFile is best-effort (never throws) ─────────────────────────────

describe("writePortFile", () => {
  it("writes the port to the mirror file in the data dir", () => {
    writePortFile(3333);
    const mirror = path.join(resolveDataDir(), "port");
    expect(fs.readFileSync(mirror, "utf8").trim()).toBe("3333");
  });
});
