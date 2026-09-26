import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyChatStreamsSchema } from "./schema";
import {
  INTERRUPTED_STREAM_ERROR_CATEGORY,
  INTERRUPTED_STREAM_REPLAY_ERROR,
  recoverOrphanedChatStreams,
} from "./boot";
import {
  createSqliteResumableStreamStore,
  type SqliteResumableStreamStore,
} from "./sqliteResumableStore";

/**
 * Boot-time orphan recovery for durable Direct-chat resumable streams.
 *
 * Private temp SQLite files only: the shared application `db` singleton is
 * never opened, written, or closed here (closing it poisons sibling suites in
 * the same `bun test` process). No real chat history is inspected or mutated —
 * the `messages` table below is a local fixture used only to prove recovery
 * writes no assistant message.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const opened: Array<{ db: Database; dir: string }> = [];

interface Fs {
  db: Database;
  file: string;
  dir: string;
  clock: { now: number };
}

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tbai-boot-"));
}

function openFs(dir: string, file: string): Fs {
  const db = new Database(file);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run("PRAGMA foreign_keys=ON");
  applyChatStreamsSchema(db);
  // Local stand-in for the real messages table, to prove recovery never writes
  // chat history.
  db.run(
    "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT, content TEXT)",
  );
  opened.push({ db, dir });
  return { db, file, dir, clock: { now: 1_700_000_000_000 } };
}

function storeFor(fs: Fs, bootId: string): SqliteResumableStreamStore {
  return createSqliteResumableStreamStore({
    db: fs.db,
    bootId,
    now: () => fs.clock.now,
    pollIntervalMs: 10,
    generateLeaseToken: (() => {
      let n = 0;
      return () => `lease_${(n += 1)}`;
    })(),
  });
}

function recover(fs: Fs, bootId: string) {
  return recoverOrphanedChatStreams(fs.db, { bootId, now: () => fs.clock.now });
}

/** Leave a `streaming` row with durable bytes, as a crashed process would. */
async function leaveOrphan(fs: Fs, bootId: string, id: string, payload: string) {
  const store = storeFor(fs, bootId);
  const acquisition = await store.acquireLease(id);
  if (acquisition.role !== "producer") throw new Error("expected producer");
  await store.append(id, enc.encode(payload), acquisition.lease);
  store.dispose();
  return store;
}

const messageCount = (fs: Fs): number =>
  fs.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM messages").get()!.c;

const chunkCount = (fs: Fs, id: string): number =>
  fs.db
    .query<{ c: number }, [string]>(
      "SELECT COUNT(*) AS c FROM chat_stream_chunks WHERE stream_id = ?",
    )
    .get(id)!.c;

/** Raw persisted bytes, read straight from SQLite (no store contract involved). */
const rawChunks = (fs: Fs, id: string): string[] =>
  fs.db
    .query<{ chunk: Uint8Array }, [string]>(
      "SELECT chunk FROM chat_stream_chunks WHERE stream_id = ? ORDER BY seq ASC",
    )
    .all(id)
    .map((row) => dec.decode(row.chunk));

async function readAll(
  store: SqliteResumableStreamStore,
  id: string,
): Promise<{ bytes: string; error: string | null }> {
  const seen: string[] = [];
  let error: string | null = null;
  try {
    for await (const entry of store.read(id, "", new AbortController().signal)) {
      seen.push(dec.decode(entry.chunk));
    }
  } catch (e) {
    error = (e as Error).message;
  }
  return { bytes: seen.join(""), error };
}

afterEach(() => {
  while (opened.length > 0) {
    const entry = opened.pop()!;
    try {
      entry.db.close();
    } catch {
      /* already closed by a restart test */
    }
    try {
      fs.rmSync(entry.dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort on Windows */
    }
  }
});

describe("boot recovery — orphaned streaming rows", () => {
  it("preserves a run that had already settled, and never reports it as interrupted", async () => {
    const dir = makeDir();
    const file = path.join(dir, "streams.db");

    // Previous process: the run completed and its reply was written to history,
    // then the process died before the byte stream was finalized.
    const before = openFs(dir, file);
    await leaveOrphan(before, "boot_one", "run_done", `{"type":"text","delta":"hi"}`);
    const store = storeFor(before, "boot_one");
    store.recordRunVerdict("run_done", "completed");
    expect(store.claimHistory("run_done", "msg_assistant")).toBe(true);
    store.completeHistory("run_done");
    before.db.close();

    // New process: the byte stream is dead, but the run did not fail.
    const after = openFs(dir, file);
    const report = recover(after, "boot_two");
    expect(report.interrupted).toBe(0);
    expect(report.preservedVerdicts).toBe(1);
    expect(report.preservedStreamIds).toEqual(["run_done"]);

    const description = storeFor(after, "boot_two").describe("run_done")!;
    // The transport is terminal, the run's verdict is untouched, and the history
    // claim still says the reply was written — so no client is invited to retry a
    // reply that already exists.
    expect(description.storedStatus).toBe("error");
    expect(description.terminalKind).toBe("completed");
    expect(description.errorCategory).toBeNull();
    expect(storeFor(after, "boot_two").getRunContext("run_done")!.historyState).toBe("done");
  });

  it("turns a previous boot's streaming row into interrupted after a real restart", async () => {
    const dir = makeDir();
    const file = path.join(dir, "streams.db");

    // Previous process: produces bytes, then dies without finalizing.
    const before = openFs(dir, file);
    await leaveOrphan(before, "boot_one", "run_a", `{"type":"text","delta":"hel`);
    expect(storeFor(before, "boot_one").describe("run_a")!.status).toBe("streaming");
    const bytesBefore = chunkCount(before, "run_a");
    before.db.close();

    // New process: new connection, new boot identity, recovery runs.
    const after = openFs(dir, file);
    const report = recover(after, "boot_two");
    expect(report).toEqual({ scanned: 1, interrupted: 1, streamIds: ["run_a"], preservedVerdicts: 0, preservedStreamIds: [] });

    const description = storeFor(after, "boot_two").describe("run_a")!;
    expect(description.storedStatus).toBe("error");
    expect(description.status).toBe("error");
    expect(description.terminalKind).toBe("interrupted");
    expect(description.errorCategory).toBe(INTERRUPTED_STREAM_ERROR_CATEGORY);
    expect(description.finalizedAt).toBe(after.clock.now);
    expect(description.fromForeignBoot).toBe(true);
    expect(await storeFor(after, "boot_two").status("run_a")).toBe("error");
    // Bytes were preserved exactly — nothing appended, nothing rewritten.
    expect(chunkCount(after, "run_a")).toBe(bytesBefore);
    expect(description.chunkCount).toBe(1);
  });

  it("preserves stored bytes byte-for-byte across recovery", async () => {
    const dir = makeDir();
    const file = path.join(dir, "streams.db");
    const fs = openFs(dir, file);
    const payload = '{"type":"text","delta":"partial answer"';
    await leaveOrphan(fs, "boot_one", "run_bytes", payload);

    // Snapshot the raw bytes before recovery. Reading through the store contract
    // is not possible yet: the row is still `streaming`, so a reader correctly
    // waits for more output instead of returning.
    const before = rawChunks(fs, "run_bytes");
    expect(before).toEqual([payload]);

    recover(fs, "boot_two");

    expect(rawChunks(fs, "run_bytes")).toEqual(before);
    // And the contract replay delivers exactly those bytes.
    const after = await readAll(storeFor(fs, "boot_two"), "run_bytes");
    expect(after.bytes).toBe(payload);
    expect(after.error).toBe(INTERRUPTED_STREAM_REPLAY_ERROR);
  });

  it("does not append or synthesise any UI-message bytes", async () => {
    const dir = makeDir();
    const fs = openFs(dir, path.join(dir, "streams.db"));
    await leaveOrphan(fs, "boot_one", "run_nofake", "half");
    const chunksBefore = chunkCount(fs, "run_nofake");

    recover(fs, "boot_two");

    expect(chunkCount(fs, "run_nofake")).toBe(chunksBefore);
    const stored = fs.db
      .query<{ chunk: Uint8Array }, [string, number]>(
        "SELECT chunk FROM chat_stream_chunks WHERE stream_id = ? AND seq = ?",
      )
      .get("run_nofake", 1)!;
    expect(dec.decode(stored.chunk)).toBe("half");
    // The witness stays 0: recovery never claims a terminal part it did not see.
    expect(storeFor(fs, "boot_two").describe("run_nofake")!.sawTerminalPart).toBe(false);
  });

  it("never writes an assistant message row", async () => {
    const dir = makeDir();
    const fs = openFs(dir, path.join(dir, "streams.db"));
    await leaveOrphan(fs, "boot_one", "run_nohistory", "orphan text");
    // Seed an unrelated pre-existing row: recovery must add nothing and remove
    // nothing.
    fs.db.run("INSERT INTO messages (id, conversation_id, content) VALUES (?, ?, ?)", [
      "preexisting",
      "conv_1",
      "{}",
    ]);
    expect(messageCount(fs)).toBe(1);

    recover(fs, "boot_two");

    expect(messageCount(fs)).toBe(1);
  });

  it("leaves an already-terminal row completely unchanged", async () => {
    const dir = makeDir();
    const fs = openFs(dir, path.join(dir, "streams.db"));
    const store = storeFor(fs, "boot_one");

    const done = await store.acquireLease("run_done");
    if (done.role !== "producer") throw new Error("expected producer");
    await store.append("run_done", enc.encode('{"type":"finish"}'), done.lease);
    await store.settleDurable("run_done", {
      status: "done",
      terminalKind: "completed",
      finishReason: "stop",
    });
    const cancelled = await store.acquireLease("run_cancel");
    if (cancelled.role !== "producer") throw new Error("expected producer");
    await store.append("run_cancel", enc.encode('{"type":"abort"}'), cancelled.lease);
    await store.settleDurable("run_cancel", { status: "error", terminalKind: "cancelled" });

    const doneBefore = store.describe("run_done")!;
    const cancelBefore = store.describe("run_cancel")!;

    const report = recover(fs, "boot_two");
    expect(report).toEqual({ scanned: 0, interrupted: 0, streamIds: [], preservedVerdicts: 0, preservedStreamIds: [] });

    const after = storeFor(fs, "boot_two");
    const doneAfter = after.describe("run_done")!;
    const cancelAfter = after.describe("run_cancel")!;
    expect(doneAfter.terminalKind).toBe("completed");
    expect(doneAfter.finishReason).toBe("stop");
    expect(doneAfter.finalizedAt).toBe(doneBefore.finalizedAt);
    expect(cancelAfter.terminalKind).toBe("cancelled");
    expect(cancelAfter.finalizedAt).toBe(cancelBefore.finalizedAt);
    expect(await after.status("run_done")).toBe("done");
  });

  it("never interrupts a stream created by the current boot", async () => {
    const dir = makeDir();
    const fs = openFs(dir, path.join(dir, "streams.db"));
    const store = storeFor(fs, "boot_current");
    const acquisition = await store.acquireLease("run_mine");
    if (acquisition.role !== "producer") throw new Error("expected producer");
    await store.append("run_mine", enc.encode("live output"), acquisition.lease);

    const report = recover(fs, "boot_current");

    expect(report).toEqual({ scanned: 0, interrupted: 0, streamIds: [], preservedVerdicts: 0, preservedStreamIds: [] });
    const description = store.describe("run_mine")!;
    expect(description.status).toBe("streaming");
    expect(description.terminalKind).toBeNull();
    expect(description.finalizedAt).toBeNull();
    // A live producer can still append and settle afterwards.
    await store.append("run_mine", enc.encode('{"type":"finish"}'), acquisition.lease);
    expect(
      await store.settleDurable("run_mine", {
        status: "done",
        terminalKind: "completed",
        lease: acquisition.lease,
      }),
    ).toBe(true);
  });

  it("interrupts only the foreign rows when current and foreign streams coexist", async () => {
    const dir = makeDir();
    const fs = openFs(dir, path.join(dir, "streams.db"));
    await leaveOrphan(fs, "boot_one", "run_old", "old bytes");
    const current = storeFor(fs, "boot_two");
    const mine = await current.acquireLease("run_new");
    if (mine.role !== "producer") throw new Error("expected producer");
    await current.append("run_new", enc.encode("new bytes"), mine.lease);

    const report = recover(fs, "boot_two");

    expect(report).toEqual({ scanned: 1, interrupted: 1, streamIds: ["run_old"], preservedVerdicts: 0, preservedStreamIds: [] });
    expect(current.describe("run_old")!.terminalKind).toBe("interrupted");
    expect(current.describe("run_new")!.terminalKind).toBeNull();
  });

  it("is idempotent: a second sweep changes nothing", async () => {
    const dir = makeDir();
    const fs = openFs(dir, path.join(dir, "streams.db"));
    await leaveOrphan(fs, "boot_one", "run_twice", "bytes");
    fs.clock.now += 60_000;

    const first = recover(fs, "boot_two");
    expect(first.interrupted).toBe(1);
    const afterFirst = storeFor(fs, "boot_two").describe("run_twice")!;

    fs.clock.now += 60_000;
    const second = recover(fs, "boot_two");
    expect(second).toEqual({ scanned: 0, interrupted: 0, streamIds: [], preservedVerdicts: 0, preservedStreamIds: [] });

    const afterSecond = storeFor(fs, "boot_two").describe("run_twice")!;
    // Nothing rewritten: same transition timestamp, same expiry, same bytes.
    expect(afterSecond.terminalKind).toBe("interrupted");
    expect(afterSecond.finalizedAt).toBe(afterFirst.finalizedAt);
    expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt);
    expect(afterSecond.expiresAt).toBe(afterFirst.expiresAt);
    expect(afterSecond.chunkCount).toBe(afterFirst.chunkCount);
    expect((await readAll(storeFor(fs, "boot_two"), "run_twice")).bytes).toBe("bytes");
  });
});

describe("boot recovery — replay + restart semantics", () => {
  it("replays a recovered row through the existing store contract", async () => {
    const dir = makeDir();
    const fs = openFs(dir, path.join(dir, "streams.db"));
    const payload = '{"type":"text","delta":"what I had before the crash"';
    await leaveOrphan(fs, "boot_one", "run_replay", payload);

    recover(fs, "boot_two");

    const store = storeFor(fs, "boot_two");
    expect(await store.status("run_replay")).toBe("error");
    const { bytes, error } = await readAll(store, "run_replay");
    // Partial output is delivered first; only then the terminal error, and it
    // is TBAI's sentence so the client can tell interrupted from failed.
    expect(bytes).toBe(payload);
    expect(error).toBe(INTERRUPTED_STREAM_REPLAY_ERROR);
    expect(error).not.toContain("crash bytes");
  });

  it("survives repeated process restarts without changing the outcome", async () => {
    const dir = makeDir();
    const file = path.join(dir, "streams.db");

    const one = openFs(dir, file);
    await leaveOrphan(one, "boot_1", "run_multi", "payload");
    one.db.close();

    const two = openFs(dir, file);
    const firstSweep = recover(two, "boot_2");
    expect(firstSweep.interrupted).toBe(1);
    const settled = storeFor(two, "boot_2").describe("run_multi")!;
    two.db.close();

    // A third boot finds the row already terminal and leaves it alone.
    const three = openFs(dir, file);
    const secondSweep = recover(three, "boot_3");
    expect(secondSweep).toEqual({ scanned: 0, interrupted: 0, streamIds: [], preservedVerdicts: 0, preservedStreamIds: [] });
    const after = storeFor(three, "boot_3").describe("run_multi")!;
    expect(after.terminalKind).toBe("interrupted");
    expect(after.finalizedAt).toBe(settled.finalizedAt);
    expect((await readAll(storeFor(three, "boot_3"), "run_multi")).bytes).toBe("payload");
  });

  it("fails loudly when the schema has not been migrated", () => {
    const dir = makeDir();
    const db = new Database(path.join(dir, "bare.db"));
    opened.push({ db, dir });
    expect(() => recoverOrphanedChatStreams(db)).toThrow(/chat_streams table is missing/);
  });

  it("uses a distinct boot identity per process", async () => {
    const first = await import("./boot");
    expect(first.APP_BOOT_ID).toStartWith("boot_");
    // Stable within a process (module constant), which is what boot_id requires.
    expect(first.APP_BOOT_ID).toBe(first.APP_BOOT_ID);
  });
});
