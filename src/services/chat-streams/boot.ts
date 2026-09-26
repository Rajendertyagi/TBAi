import type { Database } from "bun:sqlite";
import {
  createSqliteResumableStreamStore,
  type ChatStreamRecoveryReport,
  type SqliteResumableStreamStoreOptions,
} from "./sqliteResumableStore";

/**
 * Boot-time recovery of durable Direct-chat resumable streams.
 *
 * A `chat_streams` row can only be `streaming` while a producer is alive, and a
 * producer cannot outlive its process. So every row still marked `streaming`
 * when the app boots is an orphan and is settled as
 * `error` / `interrupted` through the store's own guarded settlement.
 *
 * Deliberately NOT here: periodic cleanup of expired terminal rows, chat-route
 * wiring, and detached-run history finalization. Those are separate steps
 * (design §6, §10, §7).
 *
 * Design: docs/2026-09-25-phase2-durability-design.md §6.
 * ADR: docs/decisions.md "ADR: Direct Chat durable resumable streams".
 */

/**
 * Replay text for a run whose producer died. This is the only way a client can
 * learn the difference between "interrupted" and "failed" — it cannot read the
 * database — so the distinction has to survive into the replayed error. It is
 * TBAi's own sentence, never provider text (ADR: terminal diagnostics are
 * classification fields only).
 */
export const INTERRUPTED_STREAM_REPLAY_ERROR =
  "The app restarted while this reply was streaming.";

/** Classification recorded on every recovered row. */
export const INTERRUPTED_STREAM_ERROR_CATEGORY = "lifecycle";

/**
 * Identity of this process generation, minted once per process. Rows record the
 * boot that created them, so `boot_id` mismatch is what lets a later resume
 * distinguish "the backend restarted mid-run" from "the network blipped"
 * (design §12). The chat-route wiring will pass this same value to the store.
 */
export const APP_BOOT_ID = `boot_${crypto.randomUUID()}`;

export interface RecoverOrphanedChatStreamsOptions {
  /** Override the boot identity (tests; production uses `APP_BOOT_ID`). */
  bootId?: string;
  /** Override the clock. */
  now?: () => number;
  /** Replay text recorded on recovered rows. */
  errorText?: string;
  /** Extra store options (ttl, poll interval, ...). */
  store?: Omit<SqliteResumableStreamStoreOptions, "db" | "bootId" | "now">;
}

/**
 * Settle every orphaned `streaming` row left by an earlier boot. Idempotent: a
 * second call finds nothing, and rows created by the current boot are never
 * touched. Throws if the store cannot be constructed (e.g. the migration has
 * not run), so a boot that cannot reconcile durable state fails loudly instead
 * of silently serving stale stream records.
 */
export function recoverOrphanedChatStreams(
  db: Database,
  options: RecoverOrphanedChatStreamsOptions = {},
): ChatStreamRecoveryReport {
  const {
    bootId = APP_BOOT_ID,
    now = Date.now,
    errorText = INTERRUPTED_STREAM_REPLAY_ERROR,
    store: storeOptions = {},
  } = options;

  const store = createSqliteResumableStreamStore({ ...storeOptions, db, bootId, now });
  try {
    return store.recoverOrphans(errorText);
  } finally {
    store.dispose();
  }
}
