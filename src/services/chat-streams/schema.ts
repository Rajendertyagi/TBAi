import type { Database } from "bun:sqlite";

/**
 * Schema and shared vocabulary for the durable Direct-chat resumable stream
 * store (`sqliteResumableStore.ts`).
 *
 * This module is deliberately a LEAF: it imports nothing from the app, so
 * `src/db/index.ts` can apply the DDL without creating an import cycle
 * (db -> services/chat-streams/schema -> services/chat-streams/store -> db).
 * It is the single definition of the DDL — the boot migration and the store's
 * tests both apply this exact string, so the two can never drift.
 *
 * Approved design: docs/2026-09-25-phase2-durability-design.md §1-§2.
 * ADR: docs/decisions.md "ADR: Direct Chat durable resumable streams".
 */

/** Official assistant-stream status axis. `missing` is derived from row absence. */
export const CHAT_STREAM_STATUSES = ["streaming", "done", "error"] as const;
export type ChatStreamStatus = (typeof CHAT_STREAM_STATUSES)[number];

/**
 * TBAi terminal-semantics axis. The official interface has no `interrupted`, so
 * it rides on a `status='error'` row and is carried here (design §4).
 */
export const CHAT_STREAM_TERMINAL_KINDS = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type ChatStreamTerminalKind = (typeof CHAT_STREAM_TERMINAL_KINDS)[number];

/** Guarded history-finalization state (design §9). */
export const CHAT_STREAM_HISTORY_STATES = [
  "pending",
  "claimed",
  "done",
  "skipped",
] as const;
export type ChatStreamHistoryState = (typeof CHAT_STREAM_HISTORY_STATES)[number];

/**
 * Terminal-part vocabulary for the integrity witness (design §2 rule 2).
 *
 * These are the AI SDK v7 UI-message part markers the browser already treats as
 * terminal (`makeIsFinishEvent` in web/src/runtime.ts). The store scans the tail
 * of the persisted bytes for them when a stream is settled as `done`.
 * Configurable via the store's `terminalMarkers` option; empty disables the
 * witness entirely.
 */
export const UI_MESSAGE_TERMINAL_MARKERS: readonly string[] = [
  '"type":"finish"',
  '"type":"abort"',
  '"type":"error"',
];

/**
 * Mirrors the library's unexported `validateStreamId`
 * (`assistant-stream/dist/resumable/errors.js`). It is not part of the public
 * `assistant-stream/resumable` export surface, so the store keeps its own copy
 * and throws the same `ResumableStreamError("invalid-id")` to stay contract-faithful.
 */
export const STREAM_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;

/** Default retention for stored stream bytes: 24 hours (ADR decision 2). */
export const DEFAULT_CHAT_STREAM_TTL_MS = 24 * 60 * 60 * 1000;
export const CHAT_STREAM_TTL_ENV = "TBAI_CHAT_STREAM_TTL_MS";

/** Read the retention TTL from the environment, falling back to 24h. */
export function readChatStreamTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[CHAT_STREAM_TTL_ENV] ?? DEFAULT_CHAT_STREAM_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CHAT_STREAM_TTL_MS;
}

/**
 * DDL for the durable store. Additive only: two new tables and one index, no
 * change to any existing table, so it applies cleanly to a fresh database and
 * to a pre-existing one.
 *
 * `error_text` is the one column beyond the design's list: the official `read`
 * contract requires throwing a stored error after replaying the partial bytes,
 * so the error string has to be durable. It is never a provider message — see
 * `settleDurable` in the store for why the library-supplied error is dropped.
 */
export const CHAT_STREAMS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chat_streams (
  stream_id               TEXT PRIMARY KEY,
  status                  TEXT NOT NULL DEFAULT 'streaming'
                            CHECK (status IN ('streaming','done','error')),
  terminal_kind           TEXT
                            CHECK (terminal_kind IS NULL OR terminal_kind IN
                                   ('completed','failed','cancelled','interrupted')),
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
  history_state           TEXT NOT NULL DEFAULT 'pending'
                            CHECK (history_state IN ('pending','claimed','done','skipped')),
  history_message_id      TEXT,
  history_claimed_at      INTEGER,
  finalized_at            INTEGER,
  expires_at              INTEGER NOT NULL,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_stream_chunks (
  stream_id TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  chunk     BLOB NOT NULL,
  PRIMARY KEY (stream_id, seq),
  FOREIGN KEY (stream_id) REFERENCES chat_streams(stream_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_chat_streams_expires ON chat_streams (expires_at);

-- Serves the durable "what became of this conversation's last run?" read, which
-- is how a reconnecting client recognises a dead run without holding a resumable
-- stream pointer. Additive and idempotent, like the rest of this DDL.
CREATE INDEX IF NOT EXISTS idx_chat_streams_conversation
  ON chat_streams (conversation_id, created_at DESC);
`;

/** Apply the chat-stream DDL. Idempotent; safe to call on every boot. */
export function applyChatStreamsSchema(db: Database): void {
  db.run(CHAT_STREAMS_SCHEMA_SQL);
}

/** One row of `chat_streams`, as stored. */
export interface ChatStreamRow {
  stream_id: string;
  status: ChatStreamStatus;
  terminal_kind: ChatStreamTerminalKind | null;
  terminal_finish_reason: string | null;
  terminal_error_category: string | null;
  error_text: string | null;
  boot_id: string;
  lease_token: string | null;
  conversation_id: string | null;
  request_id: string | null;
  provider_id: string | null;
  model_id: string | null;
  next_seq: number;
  chunk_count: number;
  byte_len: number;
  saw_terminal_part: number;
  history_state: ChatStreamHistoryState;
  history_message_id: string | null;
  history_claimed_at: number | null;
  finalized_at: number | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}
