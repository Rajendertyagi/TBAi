import { afterEach, describe, expect, it } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addChatStreamsColumnsIfMissing,
  applyChatStreamsSchema,
  CHAT_STREAMS_SCHEMA_SQL,
} from "./schema";

/**
 * Migration tests for the durable chat-stream schema.
 *
 * The reconciliation columns are the first additive change to `chat_streams`, so
 * the case that matters most is a database that already exists: `CREATE TABLE IF
 * NOT EXISTS` cannot add a column, and this migration is the only thing that can.
 * The legacy table below is the pre-reconciliation definition, kept verbatim so
 * the test fails if the columns it needs ever change shape.
 *
 * Every test uses a private temp file. The application database is never opened.
 */

const open: Array<{ db: Database; dir: string }> = [];

/** The `chat_streams` table as it was shipped before history reconciliation. */
const LEGACY_CHAT_STREAMS_SQL = `
CREATE TABLE chat_streams (
  stream_id               TEXT PRIMARY KEY,
  status                  TEXT NOT NULL DEFAULT 'streaming',
  terminal_kind           TEXT,
  terminal_finish_reason  TEXT,
  terminal_error_category TEXT,
  error_text              TEXT,
  boot_id                 TEXT NOT NULL,
  lease_token             TEXT,
  conversation_id         TEXT,
  request_id              TEXT,
  provider_id             TEXT,
  model_id                TEXT,
  next_seq                INTEGER NOT NULL DEFAULT 1,
  chunk_count             INTEGER NOT NULL DEFAULT 0,
  byte_len                INTEGER NOT NULL DEFAULT 0,
  saw_terminal_part       INTEGER NOT NULL DEFAULT 0,
  history_state           TEXT NOT NULL DEFAULT 'pending',
  history_message_id      TEXT,
  history_claimed_at      INTEGER,
  finalized_at            INTEGER,
  expires_at              INTEGER NOT NULL,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);
CREATE TABLE chat_stream_chunks (
  stream_id TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  chunk     BLOB NOT NULL,
  PRIMARY KEY (stream_id, seq),
  FOREIGN KEY (stream_id) REFERENCES chat_streams(stream_id) ON DELETE CASCADE
) WITHOUT ROWID;
`;

function tempDb(): { db: Database; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-schema-"));
  const db = new Database(path.join(dir, "chat.db"));
  const handle = { db, dir };
  open.push(handle);
  return handle;
}

function columnNames(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

afterEach(() => {
  while (open.length > 0) {
    const h = open.pop()!;
    try {
      h.db.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(h.dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort on Windows */
    }
  }
});

describe("chat-stream schema — fresh database", () => {
  it("creates the reconciliation columns and its partial index", () => {
    const { db } = tempDb();
    applyChatStreamsSchema(db);

    const columns = columnNames(db, "chat_streams");
    expect(columns).toContain("final_message_json");
    expect(columns).toContain("final_parent_id");

    const index = db
      .query<{ name: string }, SQLQueryBindings[]>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name=?",
      )
      .get("idx_chat_streams_pending_history");
    expect(index?.name).toBe("idx_chat_streams_pending_history");
  });

  it("is idempotent across repeated application", () => {
    const { db } = tempDb();
    applyChatStreamsSchema(db);
    applyChatStreamsSchema(db);
    addChatStreamsColumnsIfMissing(db);
    expect(columnNames(db, "chat_streams")).toContain("final_message_json");
  });
});

describe("chat-stream schema — existing database", () => {
  it("adds the reconciliation columns to a pre-reconciliation table", () => {
    const { db } = tempDb();
    db.run(LEGACY_CHAT_STREAMS_SQL);
    expect(columnNames(db, "chat_streams")).not.toContain("final_message_json");

    addChatStreamsColumnsIfMissing(db);

    const columns = columnNames(db, "chat_streams");
    expect(columns).toContain("final_message_json");
    expect(columns).toContain("final_parent_id");
    // Nothing pre-existing is dropped or rewritten.
    expect(columns).toContain("history_state");
    expect(columns).toContain("expires_at");
  });

  it("leaves existing rows readable and defaults them to no capture", () => {
    const { db } = tempDb();
    db.run(LEGACY_CHAT_STREAMS_SQL);
    db.run(
      `INSERT INTO chat_streams
         (stream_id, status, boot_id, history_state, expires_at, created_at, updated_at)
       VALUES ('run_legacy', 'done', 'boot_1', 'pending', 9999999999999, 1, 1)`,
    );

    addChatStreamsColumnsIfMissing(db);

    const row = db
      .query<
        { stream_id: string; history_state: string; final_message_json: string | null },
        SQLQueryBindings[]
      >(
        "SELECT stream_id, history_state, final_message_json FROM chat_streams WHERE stream_id = ?",
      )
      .get("run_legacy")!;
    expect(row.stream_id).toBe("run_legacy");
    expect(row.history_state).toBe("pending");
    // A pre-existing row has no captured message, which is the honest state the
    // reconciler reports as unrecoverable rather than inventing content for.
    expect(row.final_message_json).toBeNull();
  });

  it("is idempotent: a second pass adds nothing and does not throw", () => {
    const { db } = tempDb();
    db.run(LEGACY_CHAT_STREAMS_SQL);

    addChatStreamsColumnsIfMissing(db);
    const first = columnNames(db, "chat_streams");
    addChatStreamsColumnsIfMissing(db);
    addChatStreamsColumnsIfMissing(db);

    expect(columnNames(db, "chat_streams")).toEqual(first);
  });

  it("boot order is safe: legacy table, then the additive pass, then the full DDL", () => {
    const { db } = tempDb();
    db.run(LEGACY_CHAT_STREAMS_SQL);
    addChatStreamsColumnsIfMissing(db);
    // `applyChatStreamsSchema` is what `db/index.ts` runs first; re-running it
    // after the additive pass must not conflict with the columns already present.
    expect(() => applyChatStreamsSchema(db)).not.toThrow();
    expect(columnNames(db, "chat_streams")).toContain("final_message_json");
  });
});

describe("chat-stream schema — DDL and migration agree", () => {
  it("the shipped DDL declares the same reconciliation columns the migration adds", () => {
    // A drift guard: if someone edits one and not the other, a fresh install and
    // an upgraded install would end up with different tables.
    expect(CHAT_STREAMS_SCHEMA_SQL).toContain("final_message_json");
    expect(CHAT_STREAMS_SCHEMA_SQL).toContain("final_parent_id");
    expect(CHAT_STREAMS_SCHEMA_SQL).toContain("idx_chat_streams_pending_history");
  });
});
