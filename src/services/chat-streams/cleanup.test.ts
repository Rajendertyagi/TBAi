import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyChatStreamsSchema } from "./schema";
import {
  createSqliteResumableStreamStore,
  DEFAULT_CLEANUP_BATCH,
  type SqliteResumableStreamStore,
} from "./sqliteResumableStore";
import {
  DEFAULT_CLEANUP_INTERVAL_MS,
  getChatStreamCleanupState,
  runChatStreamCleanupOnce,
  startChatStreamCleanup,
  stopChatStreamCleanup,
} from "./cleanup";
import { CHAT_STREAM_TTL_ENV, DEFAULT_CHAT_STREAM_TTL_MS } from "./schema";

/**
 * Periodic cleanup of expired terminal resumable streams.
 *
 * Private temp SQLite files only: the shared application `db` singleton is
 * never opened or closed here. Conversation/message history is represented by a
 * local fixture table so cleanup can be proven not to touch it.
 */

const enc = new TextEncoder();

interface Fs {
  db: Database;
  dir: string;
  clock: { now: number };
}

const opened: Fs[] = [];

function harness(): Fs {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-cleanup-"));
  const db = new Database(path.join(dir, "streams.db"));
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA foreign_keys=ON");
  applyChatStreamsSchema(db);
  // Local stand-in for real chat history.
  db.run("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, content TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT)");
  const fsx: Fs = { db, dir, clock: { now: 1_700_000_000_000 } };
  opened.push(fsx);
  return fsx;
}

function storeFor(fsx: Fs, ttlMs?: number): SqliteResumableStreamStore {
  return createSqliteResumableStreamStore({
    db: fsx.db,
    bootId: "boot_cleanup",
    now: () => fsx.clock.now,
    pollIntervalMs: 10,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    generateLeaseToken: (() => {
      let n = 0;
      return () => `lease_${(n += 1)}`;
    })(),
  });
}

type Kind = "completed" | "failed" | "cancelled" | "interrupted";

/**
 * Create a terminal row with durable bytes. Settling slides the retention
 * window (design §10), so expiry must be applied AFTER the row settles — see
 * `expireAll`.
 */
async function seedTerminal(
  fsx: Fs,
  id: string,
  kind: Kind,
  options: { chunks?: number } = {},
): Promise<void> {
  const store = storeFor(fsx);
  const acq = await store.acquireLease(id);
  if (acq.role !== "producer") throw new Error("expected producer");
  for (let i = 0; i < (options.chunks ?? 1); i += 1) {
    await store.append(id, enc.encode(`chunk-${i}`), acq.lease);
  }
  await store.settleDurable(id, {
    status: kind === "completed" ? "done" : "error",
    terminalKind: kind,
  });
  store.dispose();
}

/** Create a row that is still `streaming`. */
async function seedStreaming(fsx: Fs, id: string): Promise<void> {
  const store = storeFor(fsx);
  const acq = await store.acquireLease(id);
  if (acq.role !== "producer") throw new Error("expected producer");
  await store.append(id, enc.encode("live"), acq.lease);
  store.dispose();
}

/** Move the clock past the default retention window for everything seeded. */
function expireAll(fsx: Fs, by = DEFAULT_CHAT_STREAM_TTL_MS + 1): void {
  fsx.clock.now += by;
}

const rowExists = (fsx: Fs, id: string): boolean =>
  fsx.db
    .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM chat_streams WHERE stream_id = ?")
    .get(id)!.c > 0;

const chunkRows = (fsx: Fs, id: string): number =>
  fsx.db
    .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM chat_stream_chunks WHERE stream_id = ?")
    .get(id)!.c;

afterEach(() => {
  stopChatStreamCleanup();
  while (opened.length > 0) {
    const fsx = opened.pop()!;
    try {
      fsx.db.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(fsx.dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort */
    }
  }
});

describe("cleanup — deletion criteria", () => {
  it("deletes an expired completed row", async () => {
    const fsx = harness();
    await seedTerminal(fsx, "done_old", "completed");
    expireAll(fsx);
    const report = await storeFor(fsx).cleanupExpired();

    expect(report).toEqual({
      scanned: 1,
      deleted: 1,
      skippedStreaming: 0,
      failures: 0,
      deletedChunks: 1,
    });
    expect(rowExists(fsx, "done_old")).toBe(false);
  });

  it("deletes expired failed, cancelled and interrupted rows", async () => {
    const fsx = harness();
    for (const kind of ["failed", "cancelled", "interrupted"] as const) {
      await seedTerminal(fsx, `${kind}_old`, kind);
    }
    expireAll(fsx);

    const report = await storeFor(fsx).cleanupExpired();

    expect(report.deleted).toBe(3);
    expect(report.failures).toBe(0);
    for (const kind of ["failed", "cancelled", "interrupted"]) {
      expect(rowExists(fsx, `${kind}_old`)).toBe(false);
    }
  });

  it("keeps an unexpired terminal row", async () => {
    const fsx = harness();
    await seedTerminal(fsx, "done_fresh", "completed");
    expect(rowExists(fsx, "done_fresh")).toBe(true);

    const report = await storeFor(fsx).cleanupExpired();

    expect(report).toEqual({
      scanned: 0,
      deleted: 0,
      skippedStreaming: 0,
      failures: 0,
      deletedChunks: 0,
    });
    expect(rowExists(fsx, "done_fresh")).toBe(true);
  });

  it("never deletes a streaming row, even when its expiry has passed", async () => {
    const fsx = harness();
    await seedStreaming(fsx, "run_live");
    expireAll(fsx);
    expect(rowExists(fsx, "run_live")).toBe(true);

    const report = await storeFor(fsx).cleanupExpired();

    expect(report.deleted).toBe(0);
    // Reported as deliberately skipped, which is how an operator can see it.
    expect(report.skippedStreaming).toBe(1);
    expect(rowExists(fsx, "run_live")).toBe(true);
    expect(storeFor(fsx).describe("run_live")!.terminalKind).toBeNull();
  });

  it("never turns streaming into interrupted", async () => {
    const fsx = harness();
    await seedStreaming(fsx, "run_a");
    await seedStreaming(fsx, "run_b");
    expireAll(fsx);

    await storeFor(fsx).cleanupExpired();
    await storeFor(fsx).cleanupExpired();

    for (const id of ["run_a", "run_b"]) {
      const description = storeFor(fsx).describe(id)!;
      expect(description.storedStatus).toBe("streaming");
      expect(description.terminalKind).toBeNull();
      expect(description.finalizedAt).toBeNull();
    }
  });

  it("respects a custom TBAI_CHAT_STREAM_TTL_MS value", async () => {
    const fsx = harness();
    const shortTtl = 60 * 1000;
    const store = storeFor(fsx, shortTtl);
    const acq = await store.acquireLease("ttl_run");
    if (acq.role !== "producer") throw new Error("expected producer");
    await store.append("ttl_run", enc.encode('{"type":"finish"}'), acq.lease);
    // Expiry follows the configured TTL, not the 24h default.
    expect(store.describe("ttl_run")!.expiresAt).toBe(fsx.clock.now + shortTtl);
    expect(fsx.clock.now + shortTtl).toBeLessThan(fsx.clock.now + DEFAULT_CHAT_STREAM_TTL_MS);

    // Settle first (settling slides the window), then step past the custom TTL.
    await store.settleDurable("ttl_run", { status: "done", terminalKind: "completed" });
    expect(store.describe("ttl_run")!.expiresAt).toBe(fsx.clock.now + shortTtl);
    store.dispose();
    fsx.clock.now += shortTtl + 1;

    // The cleanup store is configured with the DEFAULT ttl and must still honour
    // the expiry recorded on the row: retention is a property of the row, not of
    // whichever store instance happens to run the tick.
    const report = await storeFor(fsx).cleanupExpired();
    expect(report.deleted).toBe(1);
    expect(rowExists(fsx, "ttl_run")).toBe(false);
    expect(CHAT_STREAM_TTL_ENV).toBe("TBAI_CHAT_STREAM_TTL_MS");
    expect(DEFAULT_CHAT_STREAM_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("is idempotent across repeated ticks", async () => {
    const fsx = harness();
    await seedTerminal(fsx, "done_old", "completed");
    expireAll(fsx);

    const first = await storeFor(fsx).cleanupExpired();
    const second = await storeFor(fsx).cleanupExpired();
    const third = await storeFor(fsx).cleanupExpired();

    expect(first.deleted).toBe(1);
    expect(second).toEqual({
      scanned: 0,
      deleted: 0,
      skippedStreaming: 0,
      failures: 0,
      deletedChunks: 0,
    });
    expect(third.deleted).toBe(0);
  });

  it("removes chunk rows with the stream", async () => {
    const fsx = harness();
    await seedTerminal(fsx, "chunky", "completed", { chunks: 5 });
    expireAll(fsx);
    expect(chunkRows(fsx, "chunky")).toBe(5);

    const report = await storeFor(fsx).cleanupExpired();

    expect(report.deleted).toBe(1);
    expect(report.deletedChunks).toBe(5);
    expect(rowExists(fsx, "chunky")).toBe(false);
    // No orphan bytes left behind anywhere in the table.
    const total = fsx.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM chat_stream_chunks")
      .get()!.c;
    expect(total).toBe(0);
  });

  it("does not touch conversation or message history", async () => {
    const fsx = harness();
    fsx.db.run("INSERT INTO conversations (id, title) VALUES (?, ?)", ["conv_1", "keep me"]);
    fsx.db.run("INSERT INTO messages (id, content) VALUES (?, ?)", ["msg_1", "hello"]);
    await seedTerminal(fsx, "done_old", "completed");
    expireAll(fsx);

    await storeFor(fsx).cleanupExpired();

    expect(rowExists(fsx, "done_old")).toBe(false);
    expect(
      fsx.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM conversations").get()!.c,
    ).toBe(1);
    expect(
      fsx.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM messages").get()!.c,
    ).toBe(1);
  });

  it("processes only a bounded batch per tick", async () => {
    const fsx = harness();
    const total = DEFAULT_CLEANUP_BATCH + 5;
    for (let i = 0; i < total; i += 1) {
      const store = storeFor(fsx);
      const acq = await store.acquireLease(`bulk_${i}`);
      if (acq.role !== "producer") throw new Error("expected producer");
      await store.append(`bulk_${i}`, enc.encode('{"type":"finish"}'), acq.lease);
      store.dispose();
    }
    // Settle them all at the same clock, then expire together.
    const store = storeFor(fsx);
    for (let i = 0; i < total; i += 1) {
      await store.settleDurable(`bulk_${i}`, { status: "done", terminalKind: "completed" });
    }
    store.dispose();
    expireAll(fsx);

    const first = await storeFor(fsx).cleanupExpired();
    expect(first.scanned).toBe(DEFAULT_CLEANUP_BATCH);
    expect(first.deleted).toBe(DEFAULT_CLEANUP_BATCH);

    const second = await storeFor(fsx).cleanupExpired();
    expect(second.deleted).toBe(total - DEFAULT_CLEANUP_BATCH);

    const third = await storeFor(fsx).cleanupExpired();
    expect(third.deleted).toBe(0);
  });

  it("honours an explicit smaller limit", async () => {
    const fsx = harness();
    for (let i = 0; i < 4; i += 1) {
      await seedTerminal(fsx, `small_${i}`, "completed");
    }
    expireAll(fsx);

    const report = await storeFor(fsx).cleanupExpired({ limit: 2 });

    expect(report.scanned).toBe(2);
    expect(report.deleted).toBe(2);
  });
});

describe("cleanup — timer lifecycle", () => {
  it("defaults to an hourly interval", () => {
    expect(DEFAULT_CLEANUP_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it("starts one timer, runs a tick immediately, and does not accumulate", async () => {
    const fsx = harness();
    await seedTerminal(fsx, "expired_now", "completed");
    expireAll(fsx);

    expect(getChatStreamCleanupState().running).toBe(false);
    const first = startChatStreamCleanup(fsx.db, { intervalMs: 20 });
    expect(first).toEqual({ started: true, alreadyRunning: false });
    expect(getChatStreamCleanupState().running).toBe(true);
    expect(getChatStreamCleanupState().intervalMs).toBe(20);

    // Repeated initialisation must not create a second timer.
    const second = startChatStreamCleanup(fsx.db, { intervalMs: 20 });
    expect(second).toEqual({ started: false, alreadyRunning: true });
    const third = startChatStreamCleanup(fsx.db);
    expect(third.alreadyRunning).toBe(true);
    expect(getChatStreamCleanupState().intervalMs).toBe(20);

    // The immediate tick already reclaimed the expired row.
    await Bun.sleep(5);
    expect(rowExists(fsx, "expired_now")).toBe(false);
    expect(getChatStreamCleanupState().ticks).toBeGreaterThanOrEqual(1);
  });

  it("ticks repeatedly on the interval", async () => {
    const fsx = harness();
    startChatStreamCleanup(fsx.db, { intervalMs: 15 });
    await Bun.sleep(70);
    expect(getChatStreamCleanupState().ticks).toBeGreaterThanOrEqual(2);
  });

  it("stops the timer and halts ticking on shutdown", async () => {
    const fsx = harness();
    startChatStreamCleanup(fsx.db, { intervalMs: 15 });
    await Bun.sleep(40);
    expect(getChatStreamCleanupState().running).toBe(true);

    expect(stopChatStreamCleanup()).toBe(true);
    expect(getChatStreamCleanupState().running).toBe(false);

    const ticksAtStop = getChatStreamCleanupState().ticks;
    await Bun.sleep(60);
    expect(getChatStreamCleanupState().ticks).toBe(ticksAtStop);
  });

  it("stop is a no-op when nothing is running, and start works again after stop", () => {
    const fsx = harness();
    expect(stopChatStreamCleanup()).toBe(false);
    startChatStreamCleanup(fsx.db, { intervalMs: 20, runImmediately: false });
    expect(stopChatStreamCleanup()).toBe(true);
    // A restart after shutdown is a fresh single timer.
    expect(startChatStreamCleanup(fsx.db, { intervalMs: 20, runImmediately: false })).toEqual({
      started: true,
      alreadyRunning: false,
    });
    expect(getChatStreamCleanupState().running).toBe(true);
  });

  it("a tick with no database started is a no-op", async () => {
    expect(await runChatStreamCleanupOnce()).toBeNull();
  });

  it("a failing tick does not throw", async () => {
    const fsx = harness();
    // Point the timer at a closed database: the tick must swallow and log.
    startChatStreamCleanup(fsx.db, { intervalMs: 10_000, runImmediately: false });
    fsx.db.close();
    expect(await runChatStreamCleanupOnce()).toBeNull();
  });

  it("an expired streaming row survives many ticks", async () => {
    const fsx = harness();
    await seedStreaming(fsx, "run_live");
    expireAll(fsx);
    startChatStreamCleanup(fsx.db, { intervalMs: 10 });
    await Bun.sleep(60);
    expect(rowExists(fsx, "run_live")).toBe(true);
    expect(storeFor(fsx).describe("run_live")!.storedStatus).toBe("streaming");
  });
});

describe("cleanup — boot sweep remains the owner of orphans", () => {
  it("cleanup does not settle orphans, but boot recovery still does", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-cleanup-boot-"));
    const file = path.join(dir, "streams.db");
    const db = new Database(file);
    db.run("PRAGMA foreign_keys=ON");
    applyChatStreamsSchema(db);
    const fsx: Fs = { db, dir, clock: { now: 1_700_000_000_000 } };
    opened.push(fsx);

    // A previous process left a streaming row with bytes.
    const dead = createSqliteResumableStreamStore({
      db,
      bootId: "boot_dead",
      now: () => fsx.clock.now,
      generateLeaseToken: () => "lease_dead",
    });
    const acq = await dead.acquireLease("orphan");
    if (acq.role !== "producer") throw new Error("expected producer");
    await dead.append("orphan", enc.encode("partial"), acq.lease);
    dead.dispose();
    // Time passes with the app closed: the orphan is now also expired.
    expireAll(fsx);

    // Periodic cleanup on its own must not relabel or delete it.
    const cleanupReport = await storeFor(fsx).cleanupExpired();
    expect(cleanupReport.deleted).toBe(0);
    expect(cleanupReport.skippedStreaming).toBe(1);
    expect(storeFor(fsx).describe("orphan")!.storedStatus).toBe("streaming");

    // Boot recovery is the only thing that settles it, after which the expired
    // row becomes eligible for cleanup.
    const { recoverOrphanedChatStreams } = await import("./boot");
    const recovery = recoverOrphanedChatStreams(db, {
      bootId: "boot_new",
      now: () => fsx.clock.now,
    });
    expect(recovery.interrupted).toBe(1);
    expect(storeFor(fsx).describe("orphan")!.terminalKind).toBe("interrupted");

    fsx.clock.now += DEFAULT_CHAT_STREAM_TTL_MS + 1;
    const after = await storeFor(fsx).cleanupExpired();
    expect(after.deleted).toBe(1);
    expect(rowExists(fsx, "orphan")).toBe(false);
  });
});
