/**
 * DDL for the `messages` table.
 *
 * The messages table was created by `src/db/index.ts` and then migrated in place
 * twice (a `format` column, then a rebuild that made `role` nullable). These are the
 * two statements that define it, extracted here for the same reason
 * `chat-streams.ts` owns its own DDL: the schema is a contract, and a second copy of
 * it is a contract that can drift.
 *
 * `MESSAGES_TABLE_SQL` is the bootstrap form, created only when the table does not
 * exist. Its `role` is `NOT NULL`, which is why a fresh database immediately takes
 * the rebuild below: `upsertStoredSync` writes `role = NULL` (the runtime's storage
 * format carries the role inside `content`), so the bootstrap constraints cannot
 * hold a modern row.
 *
 * `MESSAGES_REBUILD_SQL` is therefore the effective shape of the table in every
 * database, fresh or migrated. A test that needs a real `messages` table should
 * import the application database (`@/db`) rather than restate this DDL, which is
 * what `tests/integration/history/claimed-history-recovery.test.ts` does.
 */
export const MESSAGES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    parent_id TEXT,
    order_seq INTEGER NOT NULL DEFAULT 0,
    status TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  )
`;

/** The effective `messages` table: nullable `role`, plus `format`. See above. */
export const MESSAGES_REBUILD_SQL = `
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT,
    content TEXT NOT NULL,
    parent_id TEXT,
    order_seq INTEGER NOT NULL DEFAULT 0,
    status TEXT,
    format TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  )
`;
