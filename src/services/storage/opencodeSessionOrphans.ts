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
   * Whether a create request for this id may still be outstanding: its
   * response was lost and nothing has proven it can no longer commit.
   *
   * Set by the pre-create intent and re-armed on every create attempt. It is
   * cleared only by a create path that can definitively rule out a duplicate
   * attempt or by the reconciler's bounded absence release — never by observing
   * the id present, and never by binding the session to the conversation.
   * Presence proves existence at that instant; binding proves ownership. Neither
   * proves every request for the id has finished, and a later removal frees the
   * id for recreation.
   */
  lateCreateRisk: boolean;
  /**
   * Start of the CURRENT continuous-absence epoch, or `null` when no absence is
   * being tracked. A presence observation, a successful binding, or a confirmed
   * removal ends the epoch (sets this to `null`), so the next 404 starts a
   * fresh one and a stale timestamp can never release a row.
   */
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

/**
 * Ends the current absence epoch and advances the rotation stamp without
 * resolving the row.
 *
 * Presence, binding and a confirmed removal all invalidate prior absence
 * without proving that an ambiguous create can no longer commit, so they share
 * this write: the next 404 starts a fresh horizon, and the row rotates behind
 * ones that have not been examined.
 */
function endAbsenceEpoch(conversationId: string, sessionId: string, at: number): boolean {
  return (
    db.run(
      `UPDATE opencode_session_orphans
         SET first_absent_at = NULL, last_checked_at = ?
       WHERE conversation_id = ? AND session_id = ? AND resolved_at IS NULL`,
      [at, conversationId, sessionId],
    ).changes > 0
  );
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
   * An orphan's session was OBSERVED to exist. That does not by itself prove
   * that every create request for the id finished, so the caller states what it
   * knows through `lateCreateRisk`: true when an earlier attempt's response was
   * lost and may still commit (the retried-create path), false when the create
   * path can rule that out. OMITTING it preserves an existing risk on
   * promotion and defaults a fresh orphan to risk-free, so an incomplete caller
   * can only be over-cautious, never unsafe.
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
    lateCreateRisk?: boolean;
  }): Promise<boolean> {
    const now = Date.now();
    // `null` means "the caller said nothing": keep whatever the row already
    // knows (an intent's risk survives promotion), and start a new orphan
    // risk-free. An explicit boolean is authoritative.
    const risk = input.lateCreateRisk === undefined ? null : input.lateCreateRisk ? 1 : 0;
    const result = db.run(
      `INSERT INTO opencode_session_orphans
         (conversation_id, session_id, first_seen_at, last_seen_at, phase,
          location_directory, persist_error_category, cleanup_error_category,
          late_create_risk, first_absent_at)
       VALUES (?, ?, ?, ?, 'orphan', ?, ?, ?, COALESCE(?, 0), NULL)
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
         late_create_risk = COALESCE(?, opencode_session_orphans.late_create_risk),
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
        risk,
        risk,
      ],
    );
    return result.changes > 0;
  },

  /**
   * Records the outcome of one reconciler probe against the remote session.
   *
   * `present` proves the id exists AT THAT INSTANT, which ends any continuous
   * absence but does NOT prove that every create request TBAi submitted for the
   * id has finished. The late-create risk therefore survives a presence
   * observation: the reconciler may remove the session afterwards, and a
   * request still in flight could then recreate the id.
   *
   * `absent` is a 404, which proves absence only at lookup time and never
   * clears the risk. It stamps `first_absent_at` ONCE per absence epoch so the
   * reconciler can bound retention; a presence or confirmed removal clears that
   * stamp so the next 404 begins a new post-observation horizon.
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
    if (input.outcome === "present") {
      return endAbsenceEpoch(input.conversationId, input.sessionId, input.at);
    }
    const result = db.run(
      `UPDATE opencode_session_orphans
       SET first_absent_at = COALESCE(first_absent_at, ?), last_checked_at = ?
       WHERE conversation_id = ? AND session_id = ? AND resolved_at IS NULL`,
      [input.at, input.at, input.conversationId, input.sessionId],
    );
    return result.changes > 0;
  },

  /**
   * Ends the current absence epoch and advances `last_checked_at` on an open
   * row, WITHOUT resolving or deleting it.
   *
   * Used when the session becomes bound: binding establishes ownership, not
   * that every earlier create request for the id has finished. The durable
   * risk therefore survives, and the touch keeps the row rotating so a bound
   * backlog cannot starve unexamined entries.
   *
   * @returns Whether an open row was touched.
   */
  async touchOrphanedSession(
    conversationId: string,
    sessionId: string,
    at: number = Date.now(),
  ): Promise<boolean> {
    return endAbsenceEpoch(conversationId, sessionId, at);
  },

  /**
   * Settles the journal after the bound remote session was successfully
   * removed.
   *
   * A risk-free create intent is released: nothing can recreate the id. A
   * risk-bearing row is preserved and its absence epoch ended, because removal
   * frees the id and an outstanding create may still commit and recreate it;
   * the next 404 must start a fresh post-removal horizon. Any other row (an
   * orphan, resolved or not) is left as it was.
   *
   * @returns `released` (risk-free intent deleted), `retained` (risk-bearing
   *   row touched) or `absent` (no matching open row).
   */
  async settleTerminatedSession(input: {
    conversationId: string;
    sessionId: string;
    at: number;
  }): Promise<"released" | "retained" | "absent"> {
    const released = db.run(
      `DELETE FROM opencode_session_orphans
       WHERE conversation_id = ? AND session_id = ?
         AND phase = 'intent' AND late_create_risk = 0`,
      [input.conversationId, input.sessionId],
    ).changes;
    if (released > 0) return "released";

    const retained = db.run(
      `UPDATE opencode_session_orphans
         SET first_absent_at = NULL, last_checked_at = ?
       WHERE conversation_id = ? AND session_id = ?
         AND resolved_at IS NULL AND late_create_risk = 1`,
      [input.at, input.conversationId, input.sessionId],
    ).changes;
    return retained > 0 ? "retained" : "absent";
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
