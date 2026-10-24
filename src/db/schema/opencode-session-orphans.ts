import type { Database } from "bun:sqlite";

/**
 * DDL for the OpenCode session recovery journal.
 *
 * A leaf module that imports nothing from the app, so `src/db/index.ts` can
 * apply the DDL at boot without an import cycle (same convention as
 * `chat-streams.ts`).
 *
 * Why this exists: RT-001. `ensureOpenCodeSession` creates the remote session
 * BEFORE the pointer write, and the pointer write can fail while the remote
 * session survives. When TBAi cannot confirm that removal (or cannot even
 * decide whether the pointer is persisted), the remote session is a live
 * handle with no TBAi row pointing at it — and the structured log redacts
 * session ids by policy, so the log alone is not a durable, actionable
 * recovery record. This journal is that record.
 *
 * Two phases share one row shape:
 *  - `intent` — written BEFORE `session.create`, carrying the caller-supplied
 *    id. A crash after the server creates the session but before its id is
 *    durable therefore still leaves a recoverable handle. It is not an orphan
 *    claim: the reconciler probes the id and either clears the intent (the
 *    create never happened) or removes the unbound session.
 *  - `orphan` — a session that was created and confirmed NOT to be bound to its
 *    conversation, but whose removal could not be confirmed. The reconciler
 *    removes it when it can prove ownership and absence.
 *
 * Scope and lifecycle:
 *  - Row key is `(conversation_id, session_id)` — one row per distinct id;
 *    repeated attempts upsert rather than duplicate.
 *  - `resolved_at` is stamped when a reconciler proves the session is gone or
 *    bound; the row is kept (audit) but no longer a candidate for action. A
 *    proven-unused `intent` is deleted instead, because it never claimed an
 *    orphan.
 *  - `location_directory` is the directory the create was scoped to. It is
 *    recovery scope, not a secret.
 *  - `late_create_risk` says whether an AMBIGUOUS create request could still
 *    commit after the last observation. It starts at 1 (a create is about to
 *    be issued) and is never cleared by a bare 404, by observing the id
 *    present, or by binding the session: none of those proves that an earlier
 *    request has finished. Only a create path that can rule out a duplicate
 *    attempt clears it, or the reconciler's bounded absence release does.
 *  - `first_absent_at` is the start of the current continuous-absence epoch.
 *    Presence, binding and a confirmed removal end it, so the next 404 starts a
 *    fresh horizon. Together with the absence horizon in the reconciler it
 *    bounds how long a risk-bearing row is retained, because upstream exposes
 *    no terminality signal for a request whose response was lost.
 *  - `last_checked_at` rotates rows that cannot be settled (a risk-bearing
 *    intent that keeps answering 404) behind ones that have not been probed,
 *    so a bounded batch cannot starve a newer backlog.
 *  - No transcript content, no secrets. The record deliberately stores
 *    failure CLASSIFICATIONS (`persist_error_category`,
 *    `cleanup_error_category`), not raw provider errors.
 *
 * ADR: docs/decisions.md "RT-001: caller-supplied session ids, a durable
 * create-intent journal and a bounded orphan reconciler".
 */
export const OPENCODE_ORPHAN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS opencode_session_orphans (
  conversation_id         TEXT NOT NULL,
  session_id              TEXT NOT NULL,
  first_seen_at           INTEGER NOT NULL,
  last_seen_at            INTEGER NOT NULL,
  phase                   TEXT NOT NULL DEFAULT 'orphan',
  location_directory      TEXT,
  persist_error_category  TEXT,
  cleanup_error_category  TEXT,
  resolved_at             INTEGER,
  late_create_risk        INTEGER NOT NULL DEFAULT 1,
  first_absent_at         INTEGER,
  last_checked_at         INTEGER,
  PRIMARY KEY (conversation_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_opencode_orphans_unresolved
  ON opencode_session_orphans (first_seen_at ASC)
  WHERE resolved_at IS NULL;
`;

/** Additive columns for a journal created by an earlier build. */
function addColumnIfMissing(db: Database, column: string, definition: string): void {
  const columns = db.query("PRAGMA table_info(opencode_session_orphans)").all() as Array<{
    name: string;
  }>;
  if (!columns.some((c) => c.name === column)) {
    db.run(`ALTER TABLE opencode_session_orphans ADD COLUMN ${column} ${definition}`);
  }
}

/** Apply the journal DDL. Idempotent; safe to call on every boot. */
export function applyOpenCodeOrphanSchema(db: Database): void {
  db.run(OPENCODE_ORPHAN_SCHEMA_SQL);
  // A table created before the intent phase existed has neither column. Both
  // additions are nullable/defaulted, so existing rows remain valid.
  addColumnIfMissing(db, "phase", "TEXT NOT NULL DEFAULT 'orphan'");
  addColumnIfMissing(db, "location_directory", "TEXT");
  // A pre-existing intent predates late-create tracking; defaulting it to 1 is
  // the conservative read (its create may have been ambiguous), so the
  // reconciler will not clear it on a bare 404.
  addColumnIfMissing(db, "late_create_risk", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "first_absent_at", "INTEGER");
  addColumnIfMissing(db, "last_checked_at", "INTEGER");
}
