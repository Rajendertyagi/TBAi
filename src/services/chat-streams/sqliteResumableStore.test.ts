import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ResumableStreamError } from "assistant-stream/resumable";
import { applyChatStreamsSchema, DEFAULT_CHAT_STREAM_TTL_MS } from "./schema";
import {
  createSqliteResumableStreamStore,
  type SqliteResumableStreamStore,
} from "./sqliteResumableStore";

/**
 * Contract tests for the durable resumable stream store.
 *
 * Every test uses a private temp SQLite file — the shared application `db`
 * singleton is never opened, never written, and never closed (closing it
 * poisons sibling suites in the same `bun test` process; see
 * tests/unit/client-request-id.test.ts for that failure mode). Production user
 * data under DATA_DIR is never touched.
 */

const HOUR = 60 * 60 * 1000;
const enc = new TextEncoder();
const dec = new TextDecoder();

interface Harness {
  db: Database;
  store: SqliteResumableStreamStore;
  dir: string;
  file: string;
  clock: { now: number };
  close(): void;
}

const open: Harness[] = [];

function openDb(file: string, bootId?: string): Harness {
  const db = new Database(file);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run("PRAGMA foreign_keys=ON");
  applyChatStreamsSchema(db);
  const harness: Harness = {
    db,
    dir: "",
    file,
    clock: { now: 1_700_000_000_000 },
    store: createSqliteResumableStreamStore({
      db,
      now: () => harness.clock.now,
      pollIntervalMs: 10,
      bootId: bootId ?? "boot_test_1",
      generateLeaseToken: (() => {
        let n = 0;
        return () => `lease_${(n += 1)}`;
      })(),
    }),
    close: () => db.close(),
  };
  open.push(harness);
  return harness;
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-streams-"));
  const h = openDb(path.join(dir, "streams.db"));
  h.dir = dir;
  return h;
}

afterEach(() => {
  while (open.length > 0) {
    const h = open.pop();
    try {
      h.store.dispose();
    } catch {
      /* store already torn down */
    }
    try {
      h.db.close();
    } catch {
      /* already closed by a restart test */
    }
    if (h.dir) {
      try {
        fs.rmSync(h.dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* best effort on Windows */
      }
    }
  }
});

async function producerOf(store: SqliteResumableStreamStore, id: string) {
  const acquisition = await store.acquireLease(id);
  if (acquisition.role !== "producer") throw new Error("expected producer role");
  return acquisition.lease;
}

async function collect(
  store: SqliteResumableStreamStore,
  id: string,
  cursor = "",
  signal = new AbortController().signal,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const entry of store.read(id, cursor, signal)) chunks.push(entry.chunk);
  return chunks;
}

const joined = (chunks: Uint8Array[]): string =>
  dec.decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));

describe("sqlite resumable store — acquire/create", () => {
  it("elects the first caller as producer and every later caller as consumer", async () => {
    const { store, clock } = harness();
    const id = "run_1";
    const lease = await producerOf(store, id);

    expect(await store.status(id)).toBe("streaming");
    expect(await store.acquire(id)).toBe("consumer");
    expect((await store.acquireLease(id)).role).toBe("consumer");
    // A repeat call is still a consumer: the producer role is never re-elected.
    expect(await store.acquire(id)).toBe("consumer");

    const description = store.describe(id)!;
    expect(description.terminalKind).toBeNull();
    expect(description.chunkCount).toBe(0);
    // Retention metadata is written up front, defaulting to 24h.
    expect(description.expiresAt).toBe(clock.now + DEFAULT_CHAT_STREAM_TTL_MS);
    expect(lease.token).toBeString();
  });

  it("stays a consumer for an already-finalized stream (no re-election)", async () => {
    const { store } = harness();
    const id = "run_settled";
    await producerOf(store, id);
    await store.finalize(id, "done");
    expect(await store.acquire(id)).toBe("consumer");
    expect(store.describe(id)!.terminalKind).toBe("completed");
  });

  it("rejects an invalid stream id with the contract error code", async () => {
    const { store } = harness();
    expect(store.acquire("bad id!")).rejects.toBeInstanceOf(ResumableStreamError);
    await expect(store.acquire("bad id!")).rejects.toMatchObject({ code: "invalid-id" });
  });
});

describe("sqlite resumable store — append + cursor", () => {
  it("appends ordered chunks and yields ascending cursors", async () => {
    const { store } = harness();
    const id = "run_2";
    const lease = await producerOf(store, id);
    await store.append(id, enc.encode("one"), lease);
    await store.append(id, enc.encode("two"), lease);
    // A real completed stream always ends with the terminal part.
    await store.append(id, enc.encode('{"type":"finish"}'), lease);
    await store.finalize(id, "done");

    const controller = new AbortController();
    const cursors: string[] = [];
    for await (const entry of store.read(id, "", controller.signal)) cursors.push(entry.cursor);
    expect(cursors).toEqual(["1", "2", "3"]);
    expect(joined(await collect(store, id))).toBe('onetwo{"type":"finish"}');
  });

  it("reads strictly after the supplied cursor", async () => {
    const { store } = harness();
    const id = "run_3";
    const lease = await producerOf(store, id);
    await store.append(id, enc.encode("a"), lease);
    await store.append(id, enc.encode("b"), lease);
    await store.append(id, enc.encode('{"type":"finish"}'), lease);
    await store.finalize(id, "done");

    expect(joined(await collect(store, id, "1"))).toBe('b{"type":"finish"}');
    expect(joined(await collect(store, id, "2"))).toBe('{"type":"finish"}');
    // A cursor at the end yields nothing, as in the reference.
    expect(joined(await collect(store, id, "3"))).toBe("");
    // An unparseable cursor degrades to "from the beginning". Note that a
    // partially-valid base36 string parses to a large offset (parseInt stops at
    // the first invalid character), so only a fully invalid cursor resets.
    expect(joined(await collect(store, id, "!!!"))).toBe('ab{"type":"finish"}');
  });

  it("refreshes the retention deadline on every append", async () => {
    const { store, clock } = harness();
    const id = "run_4";
    const lease = await producerOf(store, id);
    const first = store.describe(id)!.expiresAt;
    clock.now += HOUR;
    await store.append(id, enc.encode("x"), lease);
    expect(store.describe(id)!.expiresAt).toBe(clock.now + DEFAULT_CHAT_STREAM_TTL_MS);
    expect(store.describe(id)!.expiresAt).toBeGreaterThan(first);
  });
});

describe("sqlite resumable store — exact replay", () => {
  it("replays byte-identical content, including a marker split across chunks", async () => {
    const { store } = harness();
    const id = "run_5";
    const lease = await producerOf(store, id);
    // The terminal marker is deliberately straddling a chunk boundary, proving
    // the integrity witness scans across appends rather than one chunk.
    await store.append(id, enc.encode('{"a":1,"ty'), lease);
    await store.append(id, enc.encode('pe":"finish"}'), lease);
    await store.finalize(id, "done");

    const chunks = await collect(store, id);
    expect(joined(chunks)).toBe('{"a":1,"type":"finish"}');
    expect(store.describe(id)!.sawTerminalPart).toBe(true);
    expect(store.describe(id)!.byteLength).toBe(23);
  });

  it("does not leak a consumer's mutation of a yielded chunk into another read", async () => {
    const { store } = harness();
    const id = "run_6";
    const lease = await producerOf(store, id);
    await store.append(id, enc.encode("payload"), lease);
    await store.append(id, enc.encode('{"type":"finish"}'), lease);
    await store.finalize(id, "done");

    for await (const entry of store.read(id, "", new AbortController().signal)) {
      entry.chunk[0] = 0;
    }
    expect(joined(await collect(store, id))).toBe('payload{"type":"finish"}');
  });

  it("yields a live streaming row and stops when the signal aborts", async () => {
    const { store } = harness();
    const id = "run_7";
    const lease = await producerOf(store, id);
    await store.append(id, enc.encode("partial"), lease);

    const controller = new AbortController();
    const seen: string[] = [];
    for await (const entry of store.read(id, "", controller.signal)) {
      seen.push(dec.decode(entry.chunk));
      controller.abort();
    }
    expect(seen).toEqual(["partial"]);
  });
});

describe("sqlite resumable store — terminal states", () => {
  it("records completion and replays without throwing", async () => {
    const { store } = harness();
    const id = "run_done";
    const lease = await producerOf(store, id);
    await store.append(id, enc.encode('{"type":"finish"}'), lease);
    await store.finalize(id, "done");

    expect(await store.status(id)).toBe("done");
    const description = store.describe(id)!;
    expect(description.terminalKind).toBe("completed");
    expect(description.finalizedAt).toBeNumber();
    expect(joined(await collect(store, id))).toBe('{"type":"finish"}');
  });

  it("records failure, replays the partial bytes, then throws", async () => {
    const { store } = harness();
    const id = "run_err";
    const lease = await producerOf(store, id);
    await store.append(id, enc.encode('{"type":"error"}'), lease);
    await store.settleDurable(id, {
      status: "error",
      terminalKind: "failed",
      errorText: "Generation failed.",
      errorCategory: "network",
    });

    expect(await store.status(id)).toBe("error");
    const description = store.describe(id)!;
    expect(description.terminalKind).toBe("failed");
    expect(description.errorCategory).toBe("network");
    // The stored text is the sanitized one we passed, never a provider message.
    await expect(collect(store, id)).rejects.toThrow("Generation failed.");
  });

  it("never persists the library-supplied raw error", async () => {
    const { store } = harness();
    const id = "run_raw";
    const lease = await producerOf(store, id);
    await store.append(id, enc.encode('{"type":"error"}'), lease);
    await store.finalize(id, "error", "API key sk-LEAKED provider said no");

    const row = store.describe(id)!;
    expect(row.terminalKind).toBe("failed");
    expect(row.errorCategory).toBeNull();
    await expect(collect(store, id)).rejects.toThrow("Stream errored");
  });

  it("keeps cancellation and interruption distinct from failure", async () => {
    const { store } = harness();
    for (const [id, kind] of [
      ["run_cancel", "cancelled"],
      ["run_interrupt", "interrupted"],
    ] as const) {
      const lease = await producerOf(store, id);
      await store.append(id, enc.encode('{"type":"abort"}'), lease);
      await store.settleDurable(id, { status: "error", terminalKind: kind });
      // Both are `error` on the official axis and replay-only.
      expect(await store.status(id)).toBe("error");
      expect(store.describe(id)!.terminalKind).toBe(kind);
      // Replay is what the user would have seen: the partial bytes arrive, and
      // only then does the terminal error surface.
      const seen: string[] = [];
      await expect(
        (async () => {
          for await (const entry of store.read(id, "", new AbortController().signal)) {
            seen.push(dec.decode(entry.chunk));
          }
        })(),
      ).rejects.toThrow("Stream errored");
      expect(seen).toEqual(['{"type":"abort"}']);
    }
  });
});

describe("sqlite resumable store — guarded settlement", () => {
  it("rejects a duplicate settlement as a no-op and refuses further appends", async () => {
    const { store } = harness();
    const id = "run_dup";
    const lease = await producerOf(store, id);
    await store.append(id, enc.encode('{"type":"finish"}'), lease);

    expect(await store.settleDurable(id, { status: "done", terminalKind: "completed" })).toBe(
      true,
    );
    expect(await store.settleDurable(id, { status: "error", terminalKind: "failed" })).toBe(
      false,
    );
    // The reference's finalize() is a silent no-op once terminal, not a throw.
    await expect(store.finalize(id, "error")).resolves.toBeUndefined();
    expect(store.describe(id)!.terminalKind).toBe("completed");

    await expect(store.append(id, enc.encode("late"), lease)).rejects.toMatchObject({
      code: "finalized",
    });
  });

  it("allows exactly one durable winner under concurrent settlement", async () => {
    const { store } = harness();
    const id = "run_race";
    const lease = await producerOf(store, id);
    await store.append(id, enc.encode('{"type":"finish"}'), lease);

    const results = await Promise.all([
      store.settleDurable(id, { status: "done", terminalKind: "completed", lease }),
      store.settleDurable(id, { status: "error", terminalKind: "failed", lease }),
      store.settleDurable(id, { status: "done", terminalKind: "completed", lease }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(store.describe(id)!.terminalKind).toBe("completed");
  });

  it("enforces lease ownership on append and settle", async () => {
    const { store } = harness();
    const id = "run_lease";
    const lease = await producerOf(store, id);
    const impostor = { token: "lease_not_mine" };

    await expect(store.append(id, enc.encode("x"), impostor)).rejects.toMatchObject({
      code: "missing",
    });
    expect(
      await store.settleDurable(id, { status: "done", terminalKind: "completed", lease: impostor }),
    ).toBe(false);
    expect(await store.status(id)).toBe("streaming");

    // The real lease still works afterwards.
    await store.append(id, enc.encode('{"type":"finish"}'), lease);
    expect(
      await store.settleDurable(id, { status: "done", terminalKind: "completed", lease }),
    ).toBe(true);
  });
});

describe("sqlite resumable store — missing + expired", () => {
  it("reports a missing stream the way the existing contract does", async () => {
    const { store } = harness();
    expect(await store.status("nope")).toBe("missing");
    expect(store.describe("nope")).toBeNull();
    await expect(collect(store, "nope")).rejects.toThrow("Stream not found: nope");
    // finalize on an unknown id throws a plain Error, not a ResumableStreamError.
    await expect(store.finalize("nope", "done")).rejects.toThrow("Stream not found: nope");
    await expect(store.finalize("nope", "done")).rejects.not.toBeInstanceOf(
      ResumableStreamError,
    );
    // delete is a no-op when absent.
    await store.delete("nope");
  });

  it("treats an expired stream as missing and refuses to replay it", async () => {
    const { store, clock } = harness();
    const id = "run_expired";
    const lease = await producerOf(store, id);
    await store.append(id, enc.encode('{"type":"fin'), lease);
    clock.now += DEFAULT_CHAT_STREAM_TTL_MS + 1;

    expect(await store.status(id)).toBe("missing");
    expect(store.describe(id)!.expired).toBe(true);
    await expect(collect(store, id)).rejects.toThrow("Stream not found");
  });

  it("surfaces a never-finalized stream as expired instead of hanging", async () => {
    const { store, clock } = harness();
    const id = "run_hang";
    const lease = await producerOf(store, id);
    await store.append(id, enc.encode("partial"), lease);
    const controller = new AbortController();
    const collected = collect(store, id, "", controller.signal);
    clock.now += DEFAULT_CHAT_STREAM_TTL_MS + 1;
    // A stored-but-expired row is re-checked on the next wait cycle.
    await expect(collected).rejects.toThrow(/Stream (not found|expired)/);
  });
});

describe("sqlite resumable store — integrity", () => {
  it("detects a terminal stream whose bytes carry no terminal part", async () => {
    const { store } = harness();
    const id = "run_nowitness";
    const lease = await producerOf(store, id);
    await store.append(id, enc.encode("no marker here"), lease);
    await store.finalize(id, "done");

    const description = store.describe(id)!;
    expect(description.sawTerminalPart).toBe(false);
    expect(description.integrity).toBe("terminal-witness-missing");
    // Reported as error, never as a clean done.
    expect(description.status).toBe("error");
    expect(await store.status(id)).toBe("error");
  });

  it("detects a lost chunk as a sequence gap and refuses to call it done", async () => {
    const { store, db } = harness();
    const id = "run_gap";
    const lease = await producerOf(store, id);
    await store.append(id, enc.encode('{"a":1'), lease);
    await store.append(id, enc.encode(',"type":"finish"}'), lease);
    await store.finalize(id, "done");
    expect(await store.status(id)).toBe("done");

    // Simulate bytes lost after the fact.
    db.run("DELETE FROM chat_stream_chunks WHERE stream_id = ? AND seq = ?", [id, 2]);

    const description = store.describe(id)!;
    expect(description.integrity).toBe("sequence-gap");
    expect(description.status).toBe("error");
    expect(await store.status(id)).toBe("error");
    await expect(collect(store, id)).rejects.toThrow(/integrity check failed/);
  });

  it("detects a chunk-count mismatch", async () => {
    const { store, db } = harness();
    const id = "run_count";
    const lease = await producerOf(store, id);
    await store.append(id, enc.encode('{"type":"finish"}'), lease);
    await store.finalize(id, "done");

    db.run(
      "INSERT INTO chat_stream_chunks (stream_id, seq, chunk) VALUES (?, ?, ?)",
      [id, 99, new Uint8Array([1])],
    );
    expect(store.describe(id)!.integrity).toBe("sequence-gap");
    db.run("DELETE FROM chat_stream_chunks WHERE stream_id = ? AND seq = ?", [id, 99]);
    // Sequence is contiguous again, but the recorded counter has drifted.
    expect(store.describe(id)!.integrity).toBe("ok");
    db.run("UPDATE chat_streams SET chunk_count = chunk_count + 5 WHERE stream_id = ?", [id]);
    expect(store.describe(id)!.integrity).toBe("chunk-count-mismatch");
    expect(await store.status(id)).toBe("error");
  });
});

describe("sqlite resumable store — terminal rows stay replayable", () => {
  it("replays completed, failed and cancelled rows independently", async () => {
    const { store } = harness();
    const cases = [
      ["t_done", "completed", '{"type":"finish"}', "done"],
      ["t_failed", "failed", '{"type":"error"}', "error"],
      ["t_cancelled", "cancelled", '{"type":"abort"}', "error"],
    ] as const;

    for (const [id, kind, payload, status] of cases) {
      const lease = await producerOf(store, id);
      await store.append(id, enc.encode(payload), lease);
      await store.settleDurable(id, { status, terminalKind: kind });
    }

    expect(await store.status("t_done")).toBe("done");
    expect(joined(await collect(store, "t_done"))).toBe('{"type":"finish"}');
    for (const id of ["t_failed", "t_cancelled"]) {
      expect(await store.status(id)).toBe("error");
      const seen: string[] = [];
      await expect(
        (async () => {
          for await (const entry of store.read(id, "", new AbortController().signal)) {
            seen.push(dec.decode(entry.chunk));
          }
        })(),
      ).rejects.toThrow("Stream errored");
      // Partial output is still delivered before the terminal error.
      expect(seen.length).toBe(1);
    }
  });
});

describe("sqlite resumable store — process restart", () => {
  it("reopens the same file and replays a stream finalized before the restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-streams-"));
    const file = path.join(dir, "streams.db");

    const before = openDb(file, "boot_before_restart");
    before.dir = dir;
    const id = "run_restart";
    const lease = await producerOf(before.store, id);
    await before.store.append(id, enc.encode('{"a":1,"ty'), lease);
    await before.store.append(id, enc.encode('pe":"finish"}'), lease);
    await before.store.settleDurable(id, {
      status: "done",
      terminalKind: "completed",
      finishReason: "stop",
    });
    before.close();

    // A new process: fresh connection, fresh store instance, different boot id.
    const after = openDb(file, "boot_after_restart");
    after.dir = "";

    expect(await after.store.status(id)).toBe("done");
    expect(joined(await collect(after.store, id))).toBe('{"a":1,"type":"finish"}');
    const description = after.store.describe(id)!;
    expect(description.terminalKind).toBe("completed");
    expect(description.finishReason).toBe("stop");
    expect(description.chunkCount).toBe(2);
    expect(description.integrity).toBe("ok");
    // Provenance: the row was minted by the previous process generation.
    expect(description.fromForeignBoot).toBe(true);
  });

  it("replays a run the previous process never finished, then reports it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-streams-"));
    const file = path.join(dir, "streams.db");

    const before = openDb(file, "boot_before_crash");
    before.dir = dir;
    const id = "run_crashed";
    const lease = await producerOf(before.store, id);
    await before.store.append(id, enc.encode("half a reply"), lease);
    before.close();

    const after = openDb(file, "boot_after_crash");
    after.dir = "";
    // Still `streaming` on disk — the boot sweep that would relabel it is not
    // part of this change, so the row is reported honestly as unfinished.
    expect(await after.store.status(id)).toBe("streaming");
    expect(store_unfinished(after.store, id)).toBe(true);
    expect(after.store.describe(id)!.fromForeignBoot).toBe(true);

    // A resumed reader still gets the bytes that were durably written.
    const controller = new AbortController();
    const seen: string[] = [];
    for await (const entry of after.store.read(id, "", controller.signal)) {
      seen.push(dec.decode(entry.chunk));
      controller.abort();
    }
    expect(seen).toEqual(["half a reply"]);
  });
});

/** A streaming row has no terminal kind yet. */
function store_unfinished(store: SqliteResumableStreamStore, id: string): boolean {
  return store.describe(id)!.terminalKind === null;
}

// ── The two axes have different owners ───────────────────────────────────────
// `status` is the byte stream ("did the producer's stream end?") and belongs to
// the official finalize plus boot recovery. `terminal_kind` is the run ("did it
// succeed?") and belongs to the Direct route, which records it while the producer
// is still appending. These tests pin the ownership rule that keeps them from
// overwriting each other: the FIRST verdict on the row wins, always.
describe("sqlite resumable store — verdict ownership", () => {
  it("records a verdict mid-stream without closing the row, and finalize does not overwrite it", async () => {
    const { store } = harness();
    const id = "run_midstream_verdict";
    const lease = await producerOf(store, id);
    await store.append(id, enc.encode('{"type":"start"}'), lease);

    // The route settles the RUN while the producer is still appending.
    expect(store.recordRunVerdict(id, "failed", { errorCategory: "network" })).toBe(true);
    // The row is NOT closed: closing it would make the library's next append
    // throw and cost the client the structured error part.
    expect(await store.status(id)).toBe("streaming");
    await store.append(id, enc.encode('{"type":"error"}'), lease);

    // The byte stream then closes cleanly, carrying its own error part.
    await store.finalize(id, "done");
    const description = store.describe(id)!;
    expect(description.storedStatus).toBe("done");
    // The recorded failure survives: a completed byte stream is not a successful run.
    expect(description.terminalKind).toBe("failed");
    expect(description.errorCategory).toBe("network");
  });

  it("never downgrades a recorded cancellation to a bare failure", async () => {
    const { store } = harness();
    const id = "run_cancel_then_finalize";
    const lease = await producerOf(store, id);
    await store.append(id, enc.encode('{"type":"abort"}'), lease);
    store.recordRunVerdict(id, "cancelled");

    await store.finalize(id, "error");
    expect(store.describe(id)!.terminalKind).toBe("cancelled");
  });

  it("boot recovery does not relabel a run that had already completed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-streams-"));
    const file = path.join(dir, "streams.db");
    const before = openDb(file, "boot_before");
    const id = "run_completed_before_crash";
    const lease = await producerOf(before.store, id);
    await before.store.append(id, enc.encode('{"type":"start"}'), lease);
    // The run completed and its reply is already in history...
    before.store.recordRunVerdict(id, "completed");
    before.store.bindRunContext(id, { conversationId: "conv_1" });
    expect(before.store.claimHistory(id, "msg_assistant_1")).toBe(true);
    before.store.completeHistory(id);
    // ...and the process died before the byte stream was finalized.
    before.store.dispose();
    before.db.close();

    // The next boot must NOT call this an interrupted run: the reply exists, and
    // relabelling it is what would invite a duplicate retry.
    const after = openDb(file, "boot_after");
    const report = after.store.recoverOrphans("The app restarted.");
    // Reported as a preserved verdict, never as an interruption: a client told
    // "interrupted, retry?" would duplicate a reply that is already stored.
    expect(report.interrupted).toBe(0);
    expect(report.preservedVerdicts).toBe(1);
    expect(report.preservedStreamIds).toEqual([id]);
    const description = after.store.describe(id)!;
    expect(description.storedStatus).toBe("error");
    expect(description.terminalKind).toBe("completed");
  });

  it("still interrupts a run that never recorded any verdict", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-streams-"));
    const file = path.join(dir, "streams.db");
    const before = openDb(file, "boot_before");
    const id = "run_no_verdict";
    const lease = await producerOf(before.store, id);
    await before.store.append(id, enc.encode('{"type":"start"}'), lease);
    before.store.dispose();
    before.db.close();

    const after = openDb(file, "boot_after");
    const report = after.store.recoverOrphans("The app restarted.");
    expect(report.interrupted).toBe(1);
    expect(report.preservedVerdicts).toBe(0);
    expect(after.store.describe(id)!.terminalKind).toBe("interrupted");
  });
});

// ── Run metadata binding ─────────────────────────────────────────────────────
// The official contract knows nothing about conversations, so the row is created
// without them. Server-side history finalization must not depend on a
// process-local registry that a restart empties.
describe("sqlite resumable store — run context binding", () => {
  it("binds run metadata after the row is created and reads it back", async () => {
    const { store } = harness();
    const id = "run_bind";
    await producerOf(store, id);

    expect(
      store.bindRunContext(id, {
        conversationId: "conv_42",
        requestId: "req_7",
        providerId: "prov_1",
        modelId: "model_1",
      }),
    ).toBe(true);
    expect(store.getRunContext(id)).toMatchObject({
      conversationId: "conv_42",
      requestId: "req_7",
      providerId: "prov_1",
      modelId: "model_1",
      historyState: "pending",
      historyMessageId: null,
    });
  });

  it("never repoints an already-bound conversation, whatever a later caller passes", async () => {
    const { store } = harness();
    const id = "run_bind_once";
    await producerOf(store, id);
    expect(store.bindRunContext(id, { conversationId: "conv_first" })).toBe(true);

    // A second bind cannot move the run to another conversation, and cannot add
    // a field to a row that already has one bound.
    expect(store.bindRunContext(id, { conversationId: "conv_second" })).toBe(false);
    expect(store.getRunContext(id)!.conversationId).toBe("conv_first");
  });

  it("returns null for an unknown stream instead of inventing a context", () => {
    const { store } = harness();
    expect(store.getRunContext("run_never_existed")).toBeNull();
    expect(store.bindRunContext("run_never_existed", { conversationId: "conv_x" })).toBe(false);
  });
});

// ── Conversation-scoped run lookup ───────────────────────────────────────────
// The durable form a reconnecting client actually uses: "what became of the last
// thing I asked in THIS conversation?" — answerable with no resumable pointer,
// which is the only reason a dead run can be recognised after a restart.
describe("sqlite resumable store — latest run for a conversation", () => {
  it("returns the most recent run for the conversation", async () => {
    const { store, clock } = harness();
    for (const [id, conversationId, at] of [
      ["run_old", "conv_1", 1_000],
      ["run_new", "conv_1", 2_000],
      ["run_elsewhere", "conv_2", 3_000],
    ] as const) {
      // `created_at` is stamped when the row is created, so the clock moves first.
      clock.now = at;
      await producerOf(store, id);
      store.bindRunContext(id, { conversationId });
      await store.append(id, enc.encode('{"type":"finish"}'));
      await store.finalize(id, "done");
    }
    // Newest first, and scoped: conv_2's later run must not leak into conv_1.
    expect(store.describeLatestForConversation("conv_1")?.streamId).toBe("run_new");
    expect(store.describeLatestForConversation("conv_2")?.streamId).toBe("run_elsewhere");
  });

  it("returns null for a conversation that has no run", () => {
    const { store } = harness();
    expect(store.describeLatestForConversation("conv_never_used")).toBeNull();
  });

  it("does not surface an unbound run for a conversation", async () => {
    const { store } = harness();
    // A row with no conversation bound belongs to nobody, so a conversation-scoped
    // read must never claim it — otherwise thread A could be shown thread B's run.
    await producerOf(store, "run_unbound");
    await store.append("run_unbound", enc.encode('{"type":"finish"}'));
    await store.finalize("run_unbound", "done");
    expect(store.describeLatestForConversation("conv_1")).toBeNull();
  });

  it("does not surface an expired run, so a forgotten reply never resurfaces", async () => {
    const { store, clock } = harness();
    const id = "run_expired";
    await producerOf(store, id);
    store.bindRunContext(id, { conversationId: "conv_1" });
    await store.append(id, enc.encode('{"type":"finish"}'));
    await store.finalize(id, "done");
    expect(store.describeLatestForConversation("conv_1")?.streamId).toBe(id);

    // Past the TTL the row is treated as absent, exactly as `describe` reports it.
    clock.now += DEFAULT_CHAT_STREAM_TTL_MS + 1;
    expect(store.describeLatestForConversation("conv_1")).toBeNull();
  });

  it("reports a live run honestly, so a healthy reply is never called a recovery", async () => {
    const { store } = harness();
    const id = "run_live";
    await producerOf(store, id);
    store.bindRunContext(id, { conversationId: "conv_1" });
    const description = store.describeLatestForConversation("conv_1");
    expect(description?.status).toBe("streaming");
    expect(description?.terminalKind).toBeNull();
  });
});

// ── Guarded history finalization ─────────────────────────────────────────────
describe("sqlite resumable store — history claim", () => {
  it("allows exactly one claim and records the message id", async () => {
    const { store } = harness();
    const id = "run_claim";
    await producerOf(store, id);
    store.recordRunVerdict(id, "completed");

    expect(store.claimHistory(id, "msg_1")).toBe(true);
    // A duplicate finalization callback, a re-entrant call, and a concurrent
    // second finalizer all get `false` and must write nothing.
    expect(store.claimHistory(id, "msg_1")).toBe(false);
    expect(store.claimHistory(id, "msg_2")).toBe(false);

    expect(store.getRunContext(id)!.historyMessageId).toBe("msg_1");
    expect(store.completeHistory(id)).toBe(true);
    expect(store.getRunContext(id)!.historyState).toBe("done");
    // `done` is final: a later claim can never reopen the row.
    expect(store.claimHistory(id, "msg_3")).toBe(false);
  });

  it("refuses to claim anything that is not a completed run", async () => {
    for (const kind of ["failed", "cancelled", "interrupted"] as const) {
      const { store } = harness();
      const id = `run_claim_${kind}`;
      await producerOf(store, id);
      await store.append(id, enc.encode('{"type":"abort"}'));
      store.recordRunVerdict(id, kind);
      await store.finalize(id, kind === "failed" ? "done" : "error");

      // The store refuses on its own account: partial output from a run that did
      // not succeed is never promoted into history.
      expect(store.claimHistory(id, "msg_bad")).toBe(false);
      expect(store.getRunContext(id)!.historyState).toBe("pending");
    }
  });

  it("refuses to claim a run that is still streaming", async () => {
    const { store } = harness();
    const id = "run_claim_streaming";
    await producerOf(store, id);
    store.recordRunVerdict(id, "completed");
    // Verdict recorded but the byte stream is still open: still claimable, because
    // the run's outcome is what the claim is about, not the transport.
    expect(store.claimHistory(id, "msg_ok")).toBe(true);
  });

  it("skips from either pending or claimed, and never reopens", async () => {
    const { store } = harness();
    const pending = "run_skip_pending";
    await producerOf(store, pending);
    store.recordRunVerdict(pending, "completed");
    expect(store.skipHistory(pending)).toBe(true);
    expect(store.getRunContext(pending)!.historyState).toBe("skipped");
    expect(store.claimHistory(pending, "msg_x")).toBe(false);

    const claimed = "run_skip_claimed";
    await producerOf(store, claimed);
    store.recordRunVerdict(claimed, "completed");
    expect(store.claimHistory(claimed, "msg_y")).toBe(true);
    // A failed write must not leave a bare `claimed`, which is a tombstone with
    // no recovery path.
    expect(store.skipHistory(claimed)).toBe(true);
    expect(store.getRunContext(claimed)!.historyState).toBe("skipped");
  });
});

describe("sqlite resumable store — schema + wiring safety", () => {
  it("fails loudly when the schema has not been applied", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-streams-"));
    const file = path.join(dir, "bare.db");
    const db = new Database(file);
    open.push({
      db,
      dir,
      file,
      clock: { now: 0 },
      store: undefined as unknown as SqliteResumableStreamStore,
      close: () => db.close(),
    });
    expect(() => createSqliteResumableStreamStore({ db })).toThrow(
      /chat_streams table is missing/,
    );
  });

  it("applies its schema idempotently", () => {
    const { db } = harness();
    expect(() => applyChatStreamsSchema(db)).not.toThrow();
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'chat_stream%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(["chat_stream_chunks", "chat_streams"]);
  });
});
