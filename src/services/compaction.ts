/**
 * Phase 4 — durable compaction records, behind the storage boundary.
 *
 * ## Why a store rather than exposing the `Database`
 *
 * `src/db/index.ts` owns the connection and `src/services/` owns persistence
 * queries. Handing the route a raw `Database` to call a table it understands
 * would leak the storage layer into the request path and make the table's
 * invariants unenforceable from outside.
 *
 * ## Why a factory
 *
 * `createCompactionStore(db)` takes the connection rather than importing it, so
 * the SQL is testable against a private temporary database — the same shape as
 * `createSqliteResumableStreamStore` in `src/services/chat-streams`. Tests must
 * not touch the shared application `db` singleton; the shutdown lifecycle closes
 * it. `compactionStore` is the production binding and the only exported
 * instance.
 *
 * ## The single-winner guarantee
 *
 * `chatRuns.create` has NO per-conversation guard — verified at
 * `src/services/chat-runs.ts:121-164`. Two tabs, a detached run plus a new
 * submit, or a rapid double-send can all assemble one conversation at once, and
 * two concurrent compactions would each summarise the same span.
 *
 * So the boundary is a UNIQUE constraint on `conversation_id`, enforced by
 * SQLite rather than by an in-process lock. That follows the precedent already
 * set by `claimHistory` in the detached finalizer — except that one is keyed by
 * `stream_id`, which does not help across concurrent runs.
 */

import type { Database } from "bun:sqlite";
import { db } from "../db";
import type { CompactionRecord } from "../context/compaction";

/** Column order for every read and write, in one place so the two cannot drift. */
function parseRecord(row: Record<string, unknown>): CompactionRecord | undefined {
  let coveredMessageIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row.covered_message_ids)) as unknown;
    if (Array.isArray(parsed)) {
      coveredMessageIds = parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // A corrupt row is treated as ABSENT rather than throwing during assembly.
    // Falling back to "no compaction" degrades to today's behaviour; throwing
    // would break every request for that conversation.
    return undefined;
  }

  return {
    compactionId: String(row.compaction_id),
    conversationId: String(row.conversation_id),
    spanStartIndex: Number(row.span_start_index),
    spanEndIndex: Number(row.span_end_index),
    coveredMessageIds,
    spanFingerprint: String(row.span_fingerprint),
    summaryText: String(row.summary_text),
    summaryTokens: Number(row.summary_tokens),
    origin: "model_generated_summary",
    summarizedBy: String(row.summarized_by),
    generation: Number(row.generation),
    latched: Number(row.latched) === 1,
    createdAt: Number(row.created_at),
  };
}

/** Persistence for compaction records. */
export interface CompactionStore {
  /** The compaction covering a conversation, or undefined. */
  get(conversationId: string): CompactionRecord | undefined;
  /** Whether a compaction exists, without parsing its content. */
  has(conversationId: string): boolean;
  /**
   * Persist a compaction.
   *
   * At most ONE row exists per conversation (PRIMARY KEY), and the update is
   * guarded by `generation`: a writer whose generation is not strictly greater
   * than the stored one is DISCARDED and the stored row is returned instead.
   * That makes a slow summariser unable to clobber a newer summary with an older
   * span — the exact race two concurrent runs would otherwise produce.
   *
   * @returns The record that is actually stored, which may be another writer's.
   */
  record(record: CompactionRecord): CompactionRecord;
  /** Clear the hysteresis latch without discarding the summary. */
  releaseLatch(conversationId: string): void;
  /** Remove a conversation's compaction. The rollback path, and the only DELETE. */
  clear(conversationId: string): void;
}

/**
 * Build a compaction store over a connection.
 *
 * Assumes the table exists; `src/db/index.ts` creates it at boot alongside every
 * other table, so there is exactly one schema owner.
 */
export function createCompactionStore(connection: Database): CompactionStore {
  return {
    get(conversationId: string): CompactionRecord | undefined {
      const row = connection
        .query("SELECT * FROM conversation_compactions WHERE conversation_id = ?")
        .get(conversationId) as Record<string, unknown> | null;
      if (!row) return undefined;
      return parseRecord(row);
    },

    has(conversationId: string): boolean {
      const row = connection
        .query("SELECT 1 AS present FROM conversation_compactions WHERE conversation_id = ?")
        .get(conversationId) as { present?: number } | null;
      return row?.present === 1;
    },

    record(record: CompactionRecord): CompactionRecord {
      connection
        .query(
          `INSERT INTO conversation_compactions (
             conversation_id, compaction_id, generation, latched, span_start_index, span_end_index,
             covered_message_ids, span_fingerprint, summary_text, summary_tokens,
             origin, summarized_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET
             compaction_id = excluded.compaction_id,
             generation = excluded.generation,
             latched = excluded.latched,
             span_start_index = excluded.span_start_index,
             span_end_index = excluded.span_end_index,
             covered_message_ids = excluded.covered_message_ids,
             span_fingerprint = excluded.span_fingerprint,
             summary_text = excluded.summary_text,
             summary_tokens = excluded.summary_tokens,
             summarized_by = excluded.summarized_by,
             updated_at = excluded.updated_at
           WHERE excluded.generation > conversation_compactions.generation`,
        )
        .run(
          record.conversationId,
          record.compactionId,
          record.generation,
          record.latched ? 1 : 0,
          record.spanStartIndex,
          record.spanEndIndex,
          JSON.stringify(record.coveredMessageIds),
          record.spanFingerprint,
          record.summaryText,
          record.summaryTokens,
          record.origin,
          record.summarizedBy,
          record.createdAt,
          record.createdAt,
        );
      // Re-read rather than returning `record`: on a lost race the stored row is a
      // DIFFERENT span, and the caller must apply that one.
      return this.get(record.conversationId) ?? record;
    },

    releaseLatch(conversationId: string): void {
      connection
        .query("UPDATE conversation_compactions SET latched = 0 WHERE conversation_id = ?")
        .run(conversationId);
    },

    clear(conversationId: string): void {
      connection
        .query("DELETE FROM conversation_compactions WHERE conversation_id = ?")
        .run(conversationId);
    },
  };
}

/** The production store, bound to the application database. */
export const compactionStore: CompactionStore = createCompactionStore(db);
