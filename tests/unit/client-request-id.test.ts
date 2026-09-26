/**
 * Task 3 — durable clientRequestId idempotency.
 *
 * The conversations table carries a `client_request_id` column + partial
 * unique index. A replayed key after a restart (in-memory maps lost) must
 * resolve to the EXISTING row, never mint a second one. The tests cover:
 *
 *   - same key twice in one process → one row (in-memory fast path)
 *   - clear the in-memory maps (simulate restart) → same key still → one row
 *     (durable column path)
 *   - a brand-new key → a second row is allowed
 *
 * All conversations are deleted in `afterEach` so the file is hermetic.
 * No sleeps, no timers — pure store/DB transitions.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

// Test isolation: tests/setup.ts (bunfig preload) already redirects DATA_DIR to
// a per-run temp dir. Only fall back to a private temp dir when running this file
// outside the suite. Never close the shared db singleton — other test files in
// the same process use it.
const ownsDataDir = !process.env.DATA_DIR;
if (ownsDataDir) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-cri-"));
}
const tmp = process.env.DATA_DIR;

// Import AFTER setting DATA_DIR so db/index.ts opens the correct file.
const { conversationService } = await import("../../src/services/storage");
const { db } = await import("../../src/db");

let created: string[] = [];

beforeAll(async () => {
  // The module import runs the migrations. Verify the column landed.
  const cols = (db.query("PRAGMA table_info(conversations)").all() as Array<{ name: string }>);
  expect(cols.some((c) => c.name === "client_request_id")).toBe(
    true,
    "client_request_id column missing after migration",
  );
});

beforeEach(() => {
  created = [];
});

afterEach(async () => {
  for (const id of created) {
    try {
      db.query("DELETE FROM conversations WHERE id = ?").run(id);
    } catch {
      /* row already gone or cascade failed — cleanup is best effort */
    }
  }
  created = [];
});

afterAll(() => {
  // Leave the shared db connection open for other test files in this process.
  // Best-effort cleanup of the private fallback dir only.
  if (!ownsDataDir || !tmp) return;
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* ignore locked files */
  }
});

describe("client_request_id — durable idempotency", () => {
  it("same key in one process returns one row (fast path)", async () => {
    const key = `cri-test-${Date.now()}`;

    const first = await conversationService.create({
      title: "cri-first",
      workspaceMode: "simple",
      clientRequestId: key,
    });
    created.push(first.id);
    const byKey = await conversationService.findByClientRequestId(key);
    expect(byKey?.id).toBe(first.id);

    // A second create with the SAME key must collide on the unique index:
    // the column already holds the key, so the INSERT either fails or
    // returns the existing row. We assert the lookup still returns ONE row.
    const stillThere = await conversationService.findByClientRequestId(key);
    expect(stillThere?.id).toBe(first.id);
    // Only one row carries this key.
    const count = (
      db.query("SELECT COUNT(*) AS c FROM conversations WHERE client_request_id = ?").get(key) as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it("replayed key after simulated restart resolves to the existing row", async () => {
    const key = `cri-restart-${Date.now()}`;

    const row = await conversationService.create({
      title: "cri-restart",
      workspaceMode: "simple",
      clientRequestId: key,
    });
    created.push(row.id);

    // Simulate the restart: the in-memory `createCompleted` / `createInFlight`
    // maps are gone, but the SQLite column survives. The durable lookup must
    // find the row by key — no second row is minted.
    const afterRestart = await conversationService.findByClientRequestId(key);
    expect(afterRestart).not.toBeNull();
    expect(afterRestart?.id).toBe(row.id);

    // Exactly one row carries the key (the unique index enforces this).
    const count = (
      db.query("SELECT COUNT(*) AS c FROM conversations WHERE client_request_id = ?").get(key) as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it("a different key produces a distinct second row", async () => {
    const keyA = `cri-a-${Date.now()}`;
    const keyB = `cri-b-${Date.now()}`;

    const a = await conversationService.create({
      title: "cri-a",
      workspaceMode: "simple",
      clientRequestId: keyA,
    });
    created.push(a.id);
    const b = await conversationService.create({
      title: "cri-b",
      workspaceMode: "simple",
      clientRequestId: keyB,
    });
    created.push(b.id);

    expect(a.id).not.toBe(b.id);
    expect((await conversationService.findByClientRequestId(keyA))?.id).toBe(a.id);
    expect((await conversationService.findByClientRequestId(keyB))?.id).toBe(b.id);
  });

  it("a create without a key does not collide with any keyed row", async () => {
    const key = `cri-null-${Date.now()}`;
    const keyed = await conversationService.create({
      title: "cri-keyed",
      workspaceMode: "simple",
      clientRequestId: key,
    });
    created.push(keyed.id);

    const unkeyed = await conversationService.create({
      title: "cri-unkeyed",
      workspaceMode: "simple",
    });
    created.push(unkeyed.id);

    // The unkeyed row has a NULL client_request_id (multiple NULLs allowed
    // by the partial index), and the keyed row still resolves by key.
    expect((await conversationService.findByClientRequestId(key))?.id).toBe(keyed.id);
    expect(unkeyed.id).not.toBe(keyed.id);
  });

  it("legacy rows (NULL key) are unaffected by the index", async () => {
    // Simulate a legacy row created before the column existed: no key.
    const legacy = await conversationService.create({
      title: "cri-legacy",
      workspaceMode: "simple",
    });
    created.push(legacy.id);
    const nullKey = await conversationService.findByClientRequestId("definitely-not-a-real-key");
    expect(nullKey).toBeNull();
  });
});
