/**
 * Phase 5 — SQLite busy_timeout + WAL hardening.
 *
 * The shared db singleton (src/db/index.ts) opens a WAL-mode SQLite file under
 * DATA_DIR at module load. tests/setup.ts (bunfig preload) redirects DATA_DIR
 * to a per-PID tmp dir, so the module DB is hermetic — never the developer's
 * data/chat.db.
 *
 * Proven here (behavioral, no source-text asserts):
 * - The module DB opened without throwing (import succeeds → open works).
 * - busy_timeout reads back as a positive value (0 = the pre-Phase-5 default).
 *   NOTE: bun:sqlite exposes the `PRAGMA busy_timeout` row value under the key
 *   `timeout` (verified empirically against installed Bun 1.4.2).
 * - WAL journal mode is in effect.
 * - Normal read/write works on the module DB.
 * - A real cross-connection write lock makes a writer WAIT for the
 *   busy_timeout bound (not fail instantly), and an unbounded lock still
 *   fails after the bound (no hang).
 */
import { describe, it, expect } from "bun:test";
import path from "path";
import os from "os";
import fs from "fs";
import { Database } from "bun:sqlite";
import { db } from "../../src/db";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
/** The file the module singleton opened (WAL + busy_timeout already applied). */
const CHAT_DB_PATH = path.join(DATA_DIR, "chat.db");

describe("db open + busy_timeout + WAL (Phase 5)", () => {
  it("the module DB is open and normal read/write works", () => {
    db.run(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('db-test-phase5', 'ok', ${Date.now()})
       ON CONFLICT(key) DO UPDATE SET value = 'ok', updated_at = ${Date.now()}`
    );
    const row = db
      .query<{ value: string }>("SELECT value FROM app_settings WHERE key = ?")
      .get("db-test-phase5");
    expect(row?.value).toBe("ok");
    db.run("DELETE FROM app_settings WHERE key = ?", ["db-test-phase5"]);
    const gone = db
      .query<{ n: number }>("SELECT COUNT(*) AS n FROM app_settings WHERE key = ?")
      .get("db-test-phase5");
    expect(gone?.n).toBe(0);
  });

  it("busy_timeout reads back as a positive value on the module connection", () => {
    // bun:sqlite returns the value under the `timeout` key.
    const row = db.query<{ timeout?: number }>("PRAGMA busy_timeout").get();
    expect(typeof row.timeout).toBe("number");
    expect(row.timeout ?? 0).toBeGreaterThan(0);
  });

  it("WAL journal mode is in effect on the module connection", () => {
    const row = db.query<{ journal_mode: string }>("PRAGMA journal_mode").get();
    expect(row.journal_mode).toBe("wal");
  });

  it("a held write lock on the shared file makes the module wait the bound, not fail instantly", () => {
    // Contention is per-file: a second connection to the module's OWN DB file
    // holds the write lock; the module connection (busy_timeout=5000) must
    // retry until the bound instead of throwing SQLITE_BUSY at ~0ms.
    const holder = new Database(CHAT_DB_PATH);
    holder.run("BEGIN IMMEDIATE"); // acquire the write (RESERVED) lock

    const started = Date.now();
    let threw = false;
    try {
      db.run(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ('db-test-phase5-held', 'x', ${Date.now()})`
      );
    } catch {
      threw = true;
    }
    const waited = Date.now() - started;

    // The lock is still held: the module write retried until its busy_timeout
    // bound and only then surfaced the lock error — proving it did NOT fail
    // instantly (the pre-Phase-5 default of 0 throws at ~0ms).
    expect(threw).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(4000);

    holder.run("COMMIT");
    holder.close();
  }, 15000);

  it("a WAL reader on the shared file proceeds while a writer holds the lock", () => {
    // Phase 5's user-facing property: concurrent readers are not blocked by a
    // writer's RESERVED lock (WAL allows reader/writer overlap). This is the
    // real contention the busy_timeout backstop protects — slow readers and
    // the occasional writer must not deadlock the app on SQLITE_BUSY.
    const reader = new Database(CHAT_DB_PATH);
    reader.run("PRAGMA busy_timeout=5000");
    const writer = new Database(CHAT_DB_PATH);
    writer.run("BEGIN IMMEDIATE"); // hold the write lock

    // A read on a separate connection to the same file is unaffected.
    const row = reader
      .query<{ n: number }>("SELECT COUNT(*) AS n FROM app_settings")
      .get();
    expect(typeof row.n).toBe("number");

    writer.run("COMMIT");
    writer.close();
    reader.close();
  }, 15000);

  it("hermetic guard: the module DB is the isolated tmp file, not the developer DB", () => {
    expect(process.env.DATA_DIR ?? "").toContain("tbai-test");
    const dbPath = path.join(DATA_DIR, "chat.db");
    expect(path.isAbsolute(dbPath)).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
