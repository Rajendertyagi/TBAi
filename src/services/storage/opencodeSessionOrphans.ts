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
  /**
   * Whether an ambiguous create request for this id could still commit. True
   * for a fresh intent (and all legacy intents); false once the exact id has
   * been observed present, or when the row is an orphan. A bare 404 never
   * clears it: absence at lookup time is not proof that a lost request cannot
   * still complete.
   */
  lateCreateRisk: boolean;
  /** First positive 404 seen for a risk-bearing intent; `null` otherwise. */
  firstAbsentAt: Date | null;
  /** Last probe completed by the reconciler; `null` until one runs. */
  lastCheckedAt: Date | null;
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
  late_create_risk: number | null;
  first_absent_at: number | null;
  last_checked_at: number | null;
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
    // Anything other than an explicit 0 is risk-bearing: a missing/legacy
    // value must never be read as "safe to clear".
    lateCreateRisk: row.late_create_risk !== 0,
    firstAbsentAt: row.first_absent_at !== null ? new Date(row.first_absent_at) : null,
    lastCheckedAt: row.last_checked_at !== null ? new Date(row.last_checked_at) : null,
  };
}

export const opencodeOrphanService = {
  /**
   * Records the pre-create intent for a caller-supplied session id. The write
   * must land before `session.create` is called; that ordering is what closes
   * the "created remotely but no id is durable" crash window.
   *
   * Idempotent on `(conversationId, sessionId)`. An existing `orphan` row is
   * kept as an orphan; the phase is never downgraded. A repeated intent write
   * means a create request is about to be issued again, so it re-arms the
   * late-create risk and clears the previous absence observation.
   *
   * @returns True when an open durable record exists after the write. The
   *   caller MUST fail closed when this is false.
   */
  async recordCreateIntent(input: {
    conversationId: string;
    sessionId: string;
    locationDirectory?: string;
  }): Promise<boolean> {
    const now = Date.now();
    const result = db.run(
      `INSERT INTO opencode_session_orphans
         (conversation_id, session_id, first_seen_at, last_seen_at, phase,
          location_directory, late_create_risk)
       VALUES (?, ?, ?, ?, 'intent', ?, 1)
       ON CONFLICT(conversation_id, session_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         location_directory = COALESCE(
           opencode_session_orphans.location_directory,
           excluded.location_directory
         ),
         late_create_risk = 1,
         first_absent_at = NULL
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
   * A recorded orphan is a session that was OBSERVED to exist, so it is no
   * longer a late-create risk: any duplicate create of the same id resolves to
   * that same session.
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
          location_directory, persist_error_category, cleanup_error_category,
          late_create_risk, first_absent_at)
       VALUES (?, ?, ?, ?, 'orphan', ?, ?, ?, 0, NULL)
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
         ),
         late_create_risk = 0,
         first_absent_at = NULL
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
   * Records the outcome of one reconciler probe against the remote session.
   *
   * `present` proves the id exists, so a duplicate create can only resolve to
   * it: the late-create risk is cleared. `absent` is a 404, which proves
   * absence only at lookup time and therefore never clears that risk; it does
   * stamp `first_absent_at` (once) so the reconciler can bound how long a
   * risk-bearing intent is retained.
   *
   * Always advances `last_checked_at`, which is what rotates an unsettleable
   * row behind rows that have not been examined.
   *
   * @returns Whether an open row was updated.
   */
  async recordProbe(input: {
    conversationId: string;
    sessionId: string;
    outcome: "present" | "absent";
    at: number;
  }): Promise<boolean> {
    const result =
      input.outcome === "present"
        ? db.run(
            `UPDATE opencode_session_orphans
             SET late_create_risk = 0, first_absent_at = NULL, last_checked_at = ?
             WHERE conversation_id = ? AND session_id = ? AND resolved_at IS NULL`,
            [input.at, input.conversationId, input.sessionId],
          )
        : db.run(
            `UPDATE opencode_session_orphans
             SET first_absent_at = COALESCE(first_absent_at, ?), last_checked_at = ?
             WHERE conversation_id = ? AND session_id = ? AND resolved_at IS NULL`,
            [input.at, input.at, input.conversationId, input.sessionId],
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
   * Unresolved records (both phases), least-recently-examined first. The read
   * side of the journal: a reconciler lists these, acts on each against the
   * live server, then clears the row when the outcome is proven.
   *
   * `last_checked_at` rotates rows whose probe outcome could not settle them
   * (a risk-bearing intent that keeps answering 404) behind rows that have
   * not been examined, so a bounded batch cannot starve a newer backlog. A
   * row that has never been probed sorts by its `first_seen_at`.
   *
   * @param limit - Bounded scan; `undefined` for the whole backlog.
   */
  async listUnresolvedOrphans(limit?: number): Promise<OpenCodeOrphanRecord[]> {
    const rows = db
      .query<OrphanRow, SQLQueryBindings[]>(
        `SELECT * FROM opencode_session_orphans
         WHERE resolved_at IS NULL
         ORDER BY COALESCE(last_checked_at, first_seen_at) ASC,
                  first_seen_at ASC, conversation_id ASC, session_id ASC
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
