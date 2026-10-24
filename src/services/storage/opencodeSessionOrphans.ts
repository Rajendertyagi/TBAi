/**
 * OpenCode session recovery journal.
 *
 * The `opencode_session_orphans` table is written by
 * `src/services/opencode/sessions.ts` in two situations:
 *
 *  - BEFORE `session.create`, as an `intent` carrying the caller-supplied
 *    session id. This is what makes the create/persist window recoverable: a
 *    crash after the server creates the session but before any response is
 *    durable still leaves an id a reconciler can probe.
 *  - AFTER a create whose pointer could not be confirmed, as an `orphan` when
 *    removal (or the decision to remove) could not be confirmed either.
 *
 * The row is the durable handle that keeps a session recoverable: the
 * structured log redacts session ids by policy, so the log alone cannot
 * identify it, and an in-memory buffer is lost on restart.
 *
 * This module owns the row's shape and read surface. It is a leaf over `db`,
 * like the other `services/storage/*` aggregates, and may not call another
 * aggregate (see `conversations.ts`).
 *
 * Semantics (see the ADR in docs/decisions.md):
 *  - Writes are single-statement UPSERTs on `(conversation_id, session_id)`, so
 *    concurrent attempts cannot race a read-then-insert into a UNIQUE failure
 *    or a duplicate row.
 *  - Repeating a write refreshes `last_seen_at`, fills an empty failure slot
 *    and never overwrites one, and never downgrades an `orphan` to an
 *    `intent`. Resolution is terminal: a resolved row is never reopened.
 *  - `listUnresolvedOrphans` is the discovery surface: unresolved rows oldest
 *    first, so a bounded reconciler always drains the oldest backlog.
 *  - A proven-unused intent is deleted (`deleteCreateIntent`); a resolved
 *    orphan is stamped (`resolveOrphanedSession`) and kept for audit.
 *  - The journal never stores transcript content or secrets. Error fields
 *    carry failure classifications (category), not raw provider messages.
 */
import { db } from "../../db";
import type { SQLQueryBindings } from "bun:sqlite";
import type { ErrorCategory } from "../../lib/errors";

/**
 * Why a row exists. `intent` is a pre-create crash marker, not a claim that a
 * remote session is orphaned; the reconciler decides that by probing the id.
 */
export type OpenCodeOrphanPhase = "intent" | "orphan";

/**
 * One durable recovery record. `sessionId` is the OpenCode handle and is kept
 * in this module's surface and in the table on purpose: it is not a secret,
 * and without it the row cannot act on anything.
 */
export interface OpenCodeOrphanRecord {
  conversationId: string;
  sessionId: string;
  phase: OpenCodeOrphanPhase;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Directory the session was created (or intended) in, when known. */
  locationDirectory?: string;
  /** Failure classification of the persistence attempt that started this. */
  persistErrorCategory?: ErrorCategory;
  /**
   * Failure classification of the removal attempt, when one was made and
   * failed. Absent when no removal was attempted (e.g. verification was
   * unknown and removal was refused).
   */
  cleanupErrorCategory?: ErrorCategory;
  /** When a reconciler proved the session gone or bound; `null` = still open. */
  resolvedAt: Date | null;
}

interface OrphanRow {
  conversation_id: string;
  session_id: string;
  first_seen_at: number;
  last_seen_at: number;
  phase: string | null;
  location_directory: string | null;
  persist_error_category: string | null;
  cleanup_error_category: string | null;
  resolved_at: number | null;
}

function mapOrphanRow(row: OrphanRow): OpenCodeOrphanRecord {
  return {
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    // An unknown phase can only come from a hand-edited row; treating it as an
    // orphan is the conservative read (it is acted on, never silently dropped).
    phase: row.phase === "intent" ? "intent" : "orphan",
    firstSeenAt: new Date(row.first_seen_at),
    lastSeenAt: new Date(row.last_seen_at),
    locationDirectory: row.location_directory ?? undefined,
    persistErrorCategory: (row.persist_error_category as ErrorCategory | null) ?? undefined,
    cleanupErrorCategory: (row.cleanup_error_category as ErrorCategory | null) ?? undefined,
    resolvedAt: row.resolved_at !== null ? new Date(row.resolved_at) : null,
  };
}

export const opencodeOrphanService = {
  /**
   * Records the pre-create intent for a caller-supplied session id. The write
   * must land before `session.create` is called; that ordering is what closes
   * the "created remotely but no id is durable" crash window.
   *
   * Idempotent on `(conversationId, sessionId)`. An existing `orphan` row is
   * kept as an orphan; the phase is never downgraded.
   *
   * @returns True when an open durable record exists after the write.
   */
  async recordCreateIntent(input: {
    conversationId: string;
    sessionId: string;
    locationDirectory?: string;
  }): Promise<boolean> {
    const now = Date.now();
    const result = db.run(
      `INSERT INTO opencode_session_orphans
         (conversation_id, session_id, first_seen_at, last_seen_at, phase, location_directory)
       VALUES (?, ?, ?, ?, 'intent', ?)
       ON CONFLICT(conversation_id, session_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         location_directory = COALESCE(
           opencode_session_orphans.location_directory,
           excluded.location_directory
         )
       WHERE opencode_session_orphans.resolved_at IS NULL`,
      [input.conversationId, input.sessionId, now, now, input.locationDirectory ?? null],
    );
    return result.changes > 0;
  },

  /**
   * Records (or refreshes) one orphan and promotes an intent to an orphan.
   * Idempotent: one row per `(conversationId, sessionId)`.
   *
   * Refresh semantics are deliberately conservative: `first_seen_at` is set
   * once and never moved; `last_seen_at` always advances; a newly-supplied
   * failure category fills an empty slot and never overwrites a stored one
   * (the first failure is the one that opened the record). A resolved row is
   * never resurrected: resolution is terminal.
   *
   * @returns True when the record is (still) open after the write, false
   *   when the pair was already resolved.
   */
  async recordOrphanedSession(input: {
    conversationId: string;
    sessionId: string;
    locationDirectory?: string;
    persistErrorCategory?: ErrorCategory;
    cleanupErrorCategory?: ErrorCategory;
  }): Promise<boolean> {
    const now = Date.now();
    const result = db.run(
      `INSERT INTO opencode_session_orphans
         (conversation_id, session_id, first_seen_at, last_seen_at, phase,
          location_directory, persist_error_category, cleanup_error_category)
       VALUES (?, ?, ?, ?, 'orphan', ?, ?, ?)
       ON CONFLICT(conversation_id, session_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         phase = 'orphan',
         location_directory = COALESCE(
           opencode_session_orphans.location_directory,
           excluded.location_directory
         ),
         persist_error_category = COALESCE(
           opencode_session_orphans.persist_error_category,
           excluded.persist_error_category
         ),
         cleanup_error_category = COALESCE(
           opencode_session_orphans.cleanup_error_category,
           excluded.cleanup_error_category
         )
       WHERE opencode_session_orphans.resolved_at IS NULL`,
      [
        input.conversationId,
        input.sessionId,
        now,
        now,
        input.locationDirectory ?? null,
        input.persistErrorCategory ?? null,
        input.cleanupErrorCategory ?? null,
      ],
    );
    return result.changes > 0;
  },

  /**
   * Removes a create-intent row whose session is proven unused (the create
   * never happened, it is already gone, or it is now bound and healthy).
   *
   * An `orphan` row is deliberately NOT touched: it carries a real recovery
   * obligation and is resolved, not deleted.
   *
   * @returns Whether an intent row was deleted.
   */
  async deleteCreateIntent(conversationId: string, sessionId: string): Promise<boolean> {
    const result = db.run(
      `DELETE FROM opencode_session_orphans
       WHERE conversation_id = ? AND session_id = ? AND phase = 'intent'`,
      [conversationId, sessionId],
    ).changes;
    return result > 0;
  },

  /**
   * Unresolved records (both phases), oldest first. The read side of the
   * journal: a reconciler lists these, acts on each against the live server,
   * then clears the row when the outcome is proven.
   *
   * @param limit - Bounded scan; `undefined` for the whole backlog.
   */
  async listUnresolvedOrphans(limit?: number): Promise<OpenCodeOrphanRecord[]> {
    const rows = db
      .query<OrphanRow, SQLQueryBindings[]>(
        `SELECT * FROM opencode_session_orphans
         WHERE resolved_at IS NULL
         ORDER BY first_seen_at ASC, conversation_id ASC, session_id ASC
         ${limit !== undefined ? "LIMIT ?" : ""}`,
      )
      .all(...(limit !== undefined ? [limit] : []));
    return rows.map(mapOrphanRow);
  },

  /**
   * Marks one orphan resolved. Terminal: once stamped, writes for the same
   * pair do not reopen it, and the partial index stops returning it.
   *
   * @returns Whether a row was stamped.
   */
  async resolveOrphanedSession(conversationId: string, sessionId: string): Promise<boolean> {
    const result = db.run(
      `UPDATE opencode_session_orphans
         SET resolved_at = ?
         WHERE conversation_id = ? AND session_id = ? AND resolved_at IS NULL`,
      [Date.now(), conversationId, sessionId],
    ).changes;
    return result > 0;
  },
};
