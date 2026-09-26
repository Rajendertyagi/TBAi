import type { Database, SQLQueryBindings } from "bun:sqlite";
import {
  ResumableStreamError,
  type ResumableStreamAcquireOptions,
  type ResumableStreamAcquisition,
  type ResumableStreamEntry,
  type ResumableStreamLease,
  type ResumableStreamRole,
  type ResumableStreamStatus,
  type ResumableStreamStore,
} from "assistant-stream/resumable";
import {
  STREAM_ID_PATTERN,
  UI_MESSAGE_TERMINAL_MARKERS,
  readChatStreamTtlMs,
  type ChatStreamRow,
  type ChatStreamHistoryState,
  type ChatStreamStatus,
  type ChatStreamTerminalKind,
} from "./schema";

/**
 * Durable, SQLite-backed implementation of the official assistant-stream
 * `ResumableStreamStore` contract.
 *
 * This replaces the in-memory store as an *implementation*; the streaming
 * contract, the resume protocol, and `/api/chat/resume` are untouched
 * (ADR: docs/decisions.md "ADR: Direct Chat durable resumable streams").
 *
 * Behaviour is a deliberate port of
 * `assistant-stream/dist/resumable/stores/InMemoryResumableStreamStore.js`:
 *   - the first `acquire` wins the producer role and gets a lease, every later
 *     caller is a consumer (including after finalize);
 *   - a superseded producer's `append` raises `ResumableStreamError("missing")`
 *     and its `finalize` is a silent no-op;
 *   - `append` after finalize raises `ResumableStreamError("finalized")`;
 *   - `finalize` on an unknown id throws a plain `Error`, not a
 *     `ResumableStreamError` (matches the reference);
 *   - `read` replays every entry after the cursor, then returns on `done` and
 *     throws the stored error on `error`;
 *   - `delete` is a no-op when missing and terminates active readers.
 *
 * The three places it deliberately goes beyond the reference:
 *   1. `error_text` is never populated from the library-supplied error. The
 *      library hands `finalize` the raw producer error, and persisting or
 *      replaying that would put provider text in SQLite and back on the wire —
 *      which the ADR forbids. Callers that want a specific message pass
 *      `errorText` through the typed `settleDurable` extension instead.
 *   2. Terminality is additionally witnessed by the tail of the persisted bytes
 *      and by sequence contiguity, so a truncated or tampered stream reports
 *      `error` instead of `done` (design §2).
 *   3. `terminal_kind` is a second axis with a different owner. `status` answers
 *      "did the byte stream end?" and only `finalize` (or boot recovery, for
 *      orphans) writes it; `terminal_kind` answers "did the run succeed?" and the
 *      Direct route writes it through `recordRunVerdict`, which never closes the
 *      row. A failed run whose UI stream closed cleanly is therefore
 *      `status='done', terminal_kind='failed'` (design §4).
 */

/** Thrown message for a `read` on a stream that expired before finalizing. */
const EXPIRED_ERROR = "Stream expired";
/** Stored/replayed error when no explicit text was supplied. */
const GENERIC_ERROR = "Stream errored";
/** Default wait between polls for a cross-process writer. */
const DEFAULT_POLL_INTERVAL_MS = 250;
/** Chunks (newest first) scanned for the terminal-part witness. */
const DEFAULT_WITNESS_CHUNKS = 64;
/** Trailing bytes scanned for the terminal-part witness. */
const DEFAULT_WITNESS_TAIL_BYTES = 8192;
/** Lower bound for any poll interval, so a misconfiguration cannot busy-loop. */
const MIN_POLL_INTERVAL_MS = 5;
/** Rows one cleanup tick may delete when the caller sets no limit. */
export const DEFAULT_CLEANUP_BATCH = 200;
/** Hard ceiling on a cleanup batch, whatever the caller asks for. */
const MAX_CLEANUP_BATCH = 1000;

/** Cursor encoding, matching the in-memory store exactly (base36 sequence). */
function cursorOf(seq: number): string {
  return seq.toString(36);
}
function seqFromCursor(cursor: string): number {
  if (cursor === "") return 0;
  const parsed = Number.parseInt(cursor, 36);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Integrity verdicts for a settled row (design §2 rule 3). */
export type StreamIntegrityVerdict =
  | "ok"
  | "not-terminal"
  | "sequence-gap"
  | "chunk-count-mismatch"
  | "terminal-witness-missing";

/** Durable snapshot of one stream, for the route and for diagnostics. */
export interface ChatStreamDescription {
  streamId: string;
  /** Official status, with an integrity failure reported as `error`. */
  status: ResumableStreamStatus;
  /** The row's raw status, before any integrity downgrade. */
  storedStatus: ChatStreamRow["status"];
  terminalKind: ChatStreamTerminalKind | null;
  finishReason: string | null;
  errorCategory: string | null;
  chunkCount: number;
  byteLength: number;
  sawTerminalPart: boolean;
  nextSeq: number;
  /** True when the row was created by a different store instance (a restart). */
  fromForeignBoot: boolean;
  expired: boolean;
  integrity: StreamIntegrityVerdict;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  finalizedAt: number | null;
}

/** One periodic cleanup tick's outcome. */
export interface ChatStreamCleanupReport {
  /** Expired terminal rows examined in this batch. */
  scanned: number;
  /** Rows actually removed. */
  deleted: number;
  /** Expired rows deliberately left alone because they are still `streaming`. */
  skippedStreaming: number;
  /** Rows that could not be removed; the tick continued past them. */
  failures: number;
  /** Chunk rows reclaimed alongside the deleted stream rows. */
  deletedChunks: number;
}

export interface ChatStreamCleanupOptions {
  /** Max rows per tick. Bounded so one tick cannot do unbounded work. */
  limit?: number;
}

/**
 * What one boot-time recovery pass did. */
export interface ChatStreamRecoveryReport {
  /** Rows still marked `streaming` that belonged to an earlier boot. */
  scanned: number;
  /** Rows this pass actually transitioned to `interrupted`. */
  interrupted: number;
  /** Stream ids that were transitioned, for logging. */
  streamIds: string[];
  /**
   * Rows whose recorded verdict was PRESERVED rather than relabelled: the run had
   * already settled (typically `completed`, with its reply already in history) and
   * only its byte stream was cut by the crash. Reporting these as `interrupted`
   * would tell the client its finished reply needs a retry, which duplicates it.
   */
  preservedVerdicts: number;
  /** Stream ids whose verdict was preserved, for logging. */
  preservedStreamIds: string[];
}

/** Typed settlement input for TBAi's richer terminal semantics. */
export interface DurableSettlement {
  /** Official terminal status. `done`/`error` only — the contract's vocabulary. */
  status: "done" | "error";
  /** TBAi terminal meaning. */
  terminalKind: ChatStreamTerminalKind;
  /** Sanitized error text to store and replay. Defaults to a generic string. */
  errorText?: string;
  /** Sanitized classification only; never the provider's message. */
  errorCategory?: string | null;
  /** AI SDK finish reason, recorded for diagnostics. */
  finishReason?: string | null;
  /** When given, the settlement applies only while this lease still owns the row. */
  lease?: ResumableStreamLease;
}

export interface SqliteResumableStreamStoreOptions {
  db: Database;
  /** Sliding retention TTL. Defaults to `TBAI_CHAT_STREAM_TTL_MS` or 24h. */
  ttlMs?: number;
  now?: () => number;
  /**
   * Backstop poll interval for a writer in another process. In-process writes
   * wake readers immediately, so this only bounds cross-process latency.
   */
  pollIntervalMs?: number;
  /** Terminal-part marker vocabulary. Empty disables the integrity witness. */
  terminalMarkers?: readonly string[];
  /** Lease token factory; override for deterministic tests. */
  generateLeaseToken?: () => string;
  /** Identifies the process generation that created rows. */
  bootId?: string;
}

export interface SqliteResumableStreamStore extends ResumableStreamStore {
  acquireLease(
    streamId: string,
    options?: ResumableStreamAcquireOptions,
  ): Promise<ResumableStreamAcquisition>;
  /** Durable metadata + integrity verdict, or null when the row is absent. */
  describe(streamId: string): ChatStreamDescription | null;
  /**
   * The most recent run for a conversation, or null when it has none.
   *
   * This is the durable question a reconnecting client actually has: "what became
   * of the last thing I asked in THIS conversation?" It is answerable without a
   * resumable-stream pointer, which is the whole point — the pointer is
   * transport-owned, is cleared by the transport before a failure is reported, and
   * does not survive an app restart. A client that can only ask about a stream id
   * it might have lost cannot recognise a dead run at all.
   *
   * "Most recent" is `created_at DESC`, then `stream_id DESC` as a deterministic
   * tie-break for two runs minted in the same millisecond. Expired rows are
   * reported as absent, exactly as `describe` reports them, so a forgotten run
   * never resurfaces as a phantom recovery.
   */
  describeLatestForConversation(conversationId: string): ChatStreamDescription | null;
  /**
   * Boot-time orphan recovery: settle every row this store instance did not
   * create that is still marked `streaming`. Such a row cannot have a live
   * producer — the process that owned it is gone — so it becomes
   * `error`/`interrupted` through the same guarded settlement as any other
   * terminal transition. Idempotent by construction: a second sweep finds
   * nothing, and rows from the current boot are excluded by `boot_id`.
   */
  recoverOrphans(errorText: string): ChatStreamRecoveryReport;
  /**
   * Delete expired TERMINAL rows, oldest first, in a bounded batch.
   *
   * A row whose official status is still `streaming` is never a candidate, even
   * when its `expires_at` has passed: boot recovery owns orphaned producers and
   * is the only thing allowed to relabel them (design §10). Deletion goes
   * through the same `delete()` the store contract uses, so there is exactly one
   * deletion mechanism and chunk rows are reclaimed the same way in both paths.
   */
  cleanupExpired(options?: ChatStreamCleanupOptions): Promise<ChatStreamCleanupReport>;
  /**
   * Record TBAi's verdict for a run WITHOUT touching the byte-stream `status`.
   *
   * `status` answers "did the producer's byte stream end?", which only the
   * official `finalize` (or boot recovery, for orphans) may answer. `terminal_kind`
   * answers "did the RUN succeed?", which only the Direct route knows. A run can
   * legitimately be `status='done'` (the UI stream closed cleanly, carrying its
   * own `error` part) and `terminal_kind='failed'`, so the two axes are written
   * by different owners and must never be conflated.
   *
   * Writing a verdict must not close the row: the producer may still be appending
   * the parts that carry the failure, and a terminal row makes the library's next
   * `append` throw, which would cost the client its structured `error` part.
   *
   * Returns true only when the verdict was recorded. False means the row is
   * absent, or its verdict is already final: `cancelled` and `interrupted` are
   * never overwritten, and an aborted byte stream is never recorded as a
   * `completed` run.
   */
  recordRunVerdict(
    streamId: string,
    terminalKind: ChatStreamTerminalKind,
    verdict?: { errorCategory?: string | null; finishReason?: string | null },
  ): boolean;
  /**
   * Durably associate run metadata with a stream row.
   *
   * The official contract knows nothing about conversations, so the row is
   * created without them and the producer is already running by the time the
   * caller can bind. Server-side history finalization happens minutes-to-hours
   * later and may well be the only writer, so `conversation_id` cannot live only
   * in the process-local run registry.
   *
   * Fill-only: an already-bound field is never overwritten, so a second call (or a
   * stale one) can never repoint a run at another conversation. Returns false
   * when the row is absent or already carries a different value.
   */
  bindRunContext(
    streamId: string,
    context: {
      conversationId: string;
      requestId?: string | null;
      providerId?: string | null;
      modelId?: string | null;
    },
  ): boolean;
  /** Bound run metadata + history-finalization state, or null when absent. */
  getRunContext(streamId: string): ChatStreamRunContext | null;
  /**
   * Claim the right to write this run's assistant message into history.
   *
   * Guarded on BOTH `history_state='pending'` AND `terminal_kind='completed'`, so
   * the store itself refuses to finalize a failed, cancelled or interrupted run
   * even if a caller asks. `changes === 1` is the single-winner signal; a
   * duplicate finalization callback, a re-entrant call, and a concurrent second
   * finalizer all get `false` and write nothing.
   *
   * This suppresses duplicate WORK, not duplicate rows: the message id is the
   * real idempotency key, and `upsertStored`'s `ON CONFLICT(id) DO UPDATE` makes a
   * browser write and a server write converge on one row in either order.
   */
  claimHistory(streamId: string, messageId: string): boolean;
  /** Mark the claimed history write as finished. Guarded on `history_state='claimed'`. */
  completeHistory(streamId: string): boolean;
  /**
   * Mark history finalization as deliberately not done, so the row is never
   * retried. Written when the completed run has no usable final message, or when
   * the write failed: a bare `claimed` is a permanent tombstone with no recovery,
   * which would silently lose an otherwise good reply.
   */
  skipHistory(streamId: string): boolean;
  /**
   * Guarded terminal transition. Returns true only for the single durable
   * winner; a superseded lease or an already-settled row returns false. Throws a
   * plain `Error` only when the stream does not exist (contract parity).
   */
  settleDurable(streamId: string, settlement: DurableSettlement): Promise<boolean>;
  /** Release process-local read waiters (test/boot hygiene). */
  dispose(): void;
}

/**
 * The run metadata bound to a stream row, plus the guarded history-finalization
 * state. Read by server-side history finalization, which may be the only writer.
 */
export interface ChatStreamRunContext {
  conversationId: string | null;
  requestId: string | null;
  providerId: string | null;
  modelId: string | null;
  historyState: ChatStreamHistoryState;
  historyMessageId: string | null;
  historyClaimedAt: number | null;
}

let leaseCounter = 0;

export function createSqliteResumableStreamStore(
  options: SqliteResumableStreamStoreOptions,
): SqliteResumableStreamStore {
  const {
    db,
    ttlMs = readChatStreamTtlMs(),
    now = Date.now,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    terminalMarkers = UI_MESSAGE_TERMINAL_MARKERS,
    generateLeaseToken = () => `lease_${Date.now().toString(36)}_${(leaseCounter += 1).toString(36)}`,
    bootId = `boot_${Date.now().toString(36)}_${(leaseCounter += 1).toString(36)}`,
  } = options;

  const pollMs = Math.max(MIN_POLL_INTERVAL_MS, pollIntervalMs);
  const markers = [...terminalMarkers];
  const waiters = new Set<() => void>();

  assertSchema(db);

  const rowOf = (streamId: string): ChatStreamRow | undefined =>
    db
      .query<ChatStreamRow, SQLQueryBindings[]>(
        "SELECT * FROM chat_streams WHERE stream_id = ?",
      )
      .get(streamId);

  const isExpired = (row: ChatStreamRow): boolean => row.expires_at <= now();

  /** Notify in-process readers; the poll interval covers other processes. */
  const notify = (): void => {
    if (waiters.size === 0) return;
    const pending = [...waiters];
    waiters.clear();
    for (const wake of pending) wake();
  };

  const wait = (signal: AbortSignal, wakeByMs: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", done);
        waiters.delete(done);
        resolve();
      };
      waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
      timer = setTimeout(done, Math.min(pollMs, Math.max(0, wakeByMs)));
      // A pending poll must never be the only thing keeping the process alive.
      (timer as unknown as { unref?: () => void }).unref?.();
    });

  /**
   * Whether the persisted bytes carry a terminal part. Scans the tail, because
   * a marker can straddle a chunk boundary and a single chunk cannot be trusted
   * in isolation. Restart-safe: it reads committed rows, no in-memory state.
   */
  const sawTerminalPart = (streamId: string): boolean => {
    if (markers.length === 0) return false;
    const tail = db
      .query<{ chunk: Uint8Array }, SQLQueryBindings[]>(
        "SELECT chunk FROM chat_stream_chunks WHERE stream_id = ? ORDER BY seq DESC LIMIT ?",
      )
      .all(streamId, DEFAULT_WITNESS_CHUNKS);
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const entry of tail) {
      parts.push(entry.chunk);
      total += entry.chunk.byteLength;
      if (total >= DEFAULT_WITNESS_TAIL_BYTES) break;
    }
    parts.reverse();
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      buffer.set(part, offset);
      offset += part.byteLength;
    }
    const text = new TextDecoder().decode(buffer);
    return markers.some((marker) => text.includes(marker));
  };

  /**
   * Mechanical integrity of a row; only meaningful once it is terminal.
   *
   * The sequence/count checks apply to every terminal row: lost bytes make any
   * replay incomplete regardless of why the stream ended. The terminal-part
   * witness is scoped to `done` only, per the approved design — a run that was
   * cancelled or interrupted legitimately ends without a finish part, so
   * demanding one there would misreport an honest outcome as corruption.
   */
  const integrityOf = (row: ChatStreamRow): StreamIntegrityVerdict => {
    if (row.status === "streaming") return "not-terminal";
    const bounds = db
      .query<{ count: number; max_seq: number }, SQLQueryBindings[]>(
        "SELECT COUNT(*) AS count, COALESCE(MAX(seq), 0) AS max_seq FROM chat_stream_chunks WHERE stream_id = ?",
      )
      .get(row.stream_id);
    const count = bounds?.count ?? 0;
    const maxSeq = bounds?.max_seq ?? 0;
    if (maxSeq !== row.next_seq - 1) return "sequence-gap";
    if (count !== row.chunk_count) return "chunk-count-mismatch";
    if (row.status === "done" && markers.length > 0 && row.saw_terminal_part === 0) {
      return "terminal-witness-missing";
    }
    return "ok";
  };

  const integrityError = (verdict: StreamIntegrityVerdict): string =>
    `Stream integrity check failed (${verdict})`;

  const acquireLeaseTx = (
    streamId: string,
    leaseTtlMs: number,
    timestamp: number,
    token: string,
  ): boolean => {
    // The in-memory reference evicts expired streams on every access, so an
    // expired row is treated as absent here too. stream_id is server-minted per
    // run and nothing re-acquires an existing id, so this cannot hand a second
    // producer the same run (ADR: no producer re-election).
    db.run("DELETE FROM chat_streams WHERE stream_id = ? AND expires_at <= ?", [
      streamId,
      timestamp,
    ]);
    const inserted = db.run(
      `INSERT OR IGNORE INTO chat_streams
         (stream_id, status, boot_id, lease_token, next_seq, chunk_count, byte_len,
          saw_terminal_part, history_state, expires_at, created_at, updated_at)
       VALUES (?, 'streaming', ?, ?, 1, 0, 0, 0, 'pending', ?, ?, ?)`,
      [streamId, bootId, token, timestamp + leaseTtlMs, timestamp, timestamp],
    );
    return inserted.changes === 1;
  };

  // Defined as standalone closures rather than `this`-bound methods, so a caller
  // that destructures the store still gets working delegation.
  const acquireLease = async (
    streamId: string,
    acquireOptions?: ResumableStreamAcquireOptions,
  ): Promise<ResumableStreamAcquisition> => {
    assertValidStreamId(streamId);
    const timestamp = now();
    const token = generateLeaseToken();
    const leaseTtlMs = acquireOptions?.ttlMs ?? ttlMs;
    const produced = db.transaction(() =>
      acquireLeaseTx(streamId, leaseTtlMs, timestamp, token),
    )();
    if (!produced) return { role: "consumer" };
    notify();
    return { role: "producer", lease: { token } };
  };

  const settleTx = (streamId: string, settlement: DurableSettlement): boolean => {
    const timestamp = now();
    const row = rowOf(streamId);
    if (!row) throw new Error(`Stream not found: ${streamId}`);
    // Lease first, then already-settled — the same order as the reference.
    if (settlement.lease && row.lease_token !== settlement.lease.token) return false;
    if (row.status !== "streaming") return false;
    const witness =
      markers.length > 0 ? (sawTerminalPart(streamId) ? 1 : 0) : row.saw_terminal_part;
    // The route's recorded verdict and diagnostics are COALESCE'd, not assigned,
    // and the EXISTING value wins. The byte stream ending says nothing about
    // whether the RUN succeeded, and the Direct route records its verdict with
    // `recordRunVerdict` while the producer is still appending the parts that
    // carry a failure. First writer wins, always:
    //   - the library's `finalize('done')` must not overwrite a recorded failure,
    //     nor blank the finish reason and error category recorded with it;
    //   - boot recovery's `interrupted` must not overwrite a recorded completion
    //     whose reply is already in history (that relabel is what makes a later
    //     Retry duplicate the assistant message).
    // `error_text` IS assigned: a failed byte stream must carry some stored text
    // for the contract's terminal throw, and the generic string is the security
    // decision (a provider message is never persisted).
    const settled = db.run(
      `UPDATE chat_streams
          SET status = ?, terminal_kind = COALESCE(terminal_kind, ?),
              terminal_finish_reason = COALESCE(terminal_finish_reason, ?),
              terminal_error_category = COALESCE(terminal_error_category, ?),
              error_text = ?, saw_terminal_part = ?,
              finalized_at = ?, expires_at = ?, updated_at = ?
        WHERE stream_id = ? AND status = 'streaming'`,
      [
        settlement.status,
        settlement.terminalKind,
        settlement.finishReason ?? null,
        settlement.errorCategory ?? null,
        settlement.errorText ?? GENERIC_ERROR,
        witness,
        timestamp,
        timestamp + ttlMs,
        timestamp,
        streamId,
      ],
    );
    return settled.changes === 1;
  };

  const settleDurable = async (
    streamId: string,
    settlement: DurableSettlement,
  ): Promise<boolean> => {
    assertValidStreamId(streamId);
    const won = db.transaction(() => settleTx(streamId, settlement))();
    if (won) notify();
    return won;
  };

  /** The single deletion mechanism: the row plus its chunk bytes. */
  const deleteStream = (streamId: string): void => {
    db.transaction(() => {
      // Explicit chunk delete so teardown does not depend on the connection
      // having `PRAGMA foreign_keys=ON` for the CASCADE. The FK is the schema's
      // guarantee; this is the same guarantee made explicit in one place.
      db.run("DELETE FROM chat_stream_chunks WHERE stream_id = ?", [streamId]);
      db.run("DELETE FROM chat_streams WHERE stream_id = ?", [streamId]);
    })();
    notify();
  };

  /**
   * May this verdict be written over the row's current one?
   *
   * Two invariants, both one-way:
   *  - `cancelled` and `interrupted` are final. They are strictly more specific
   *    than anything a live route can still learn, and `interrupted` is owned by
   *    boot recovery, so a crashed run can never be relabelled by a stale route.
   *  - An aborted byte stream is never a completed run. This is also what stops a
   *    recorded failure from being overwritten by a late success.
   */
  const canRecordVerdict = (
    status: ChatStreamStatus,
    current: ChatStreamTerminalKind | null,
    incoming: ChatStreamTerminalKind,
  ): boolean => {
    if (current === "cancelled" || current === "interrupted") return false;
    if (incoming === "completed" && status === "error") return false;
    return true;
  };

  const recordRunVerdict = (
    streamId: string,
    terminalKind: ChatStreamTerminalKind,
    verdict?: { errorCategory?: string | null; finishReason?: string | null },
  ): boolean => {
    assertValidStreamId(streamId);
    const timestamp = now();
    // Deliberately does NOT touch `status`, `error_text`, `saw_terminal_part` or
    // `expires_at`: a verdict is bookkeeping about a run, not new stream data, so
    // it must not close the row or extend its retention window.
    const recorded = db.transaction(() => {
      const row = rowOf(streamId);
      if (!row) return false;
      if (!canRecordVerdict(row.status, row.terminal_kind, terminalKind)) return false;
      return (
        db.run(
          `UPDATE chat_streams
              SET terminal_kind = ?, terminal_finish_reason = COALESCE(?, terminal_finish_reason),
                  terminal_error_category = COALESCE(?, terminal_error_category), updated_at = ?
            WHERE stream_id = ?`,
          [
            terminalKind,
            verdict?.finishReason ?? null,
            verdict?.errorCategory ?? null,
            timestamp,
            streamId,
          ],
        ).changes === 1
      );
    })();
    if (recorded) notify();
    return recorded;
  };

  const bindRunContext = (
    streamId: string,
    context: {
      conversationId: string;
      requestId?: string | null;
      providerId?: string | null;
      modelId?: string | null;
    },
  ): boolean => {
    assertValidStreamId(streamId);
    // Fill-only, per field: a second bind can add a field the first one lacked but
    // can never repoint an already-bound field at a different conversation.
    const bound = db.run(
      `UPDATE chat_streams
          SET conversation_id = COALESCE(conversation_id, ?),
              request_id = COALESCE(request_id, ?),
              provider_id = COALESCE(provider_id, ?),
              model_id = COALESCE(model_id, ?),
              updated_at = ?
        WHERE stream_id = ? AND conversation_id IS NULL`,
      [
        context.conversationId,
        context.requestId ?? null,
        context.providerId ?? null,
        context.modelId ?? null,
        now(),
        streamId,
      ],
    );
    return bound.changes === 1;
  };

  const getRunContext = (streamId: string): ChatStreamRunContext | null => {
    assertValidStreamId(streamId);
    const row = db
      .query<
        {
          conversation_id: string | null;
          request_id: string | null;
          provider_id: string | null;
          model_id: string | null;
          history_state: ChatStreamHistoryState;
          history_message_id: string | null;
          history_claimed_at: number | null;
        },
        SQLQueryBindings[]
      >(
        `SELECT conversation_id, request_id, provider_id, model_id,
                history_state, history_message_id, history_claimed_at
           FROM chat_streams WHERE stream_id = ?`,
      )
      .get(streamId);
    if (!row) return null;
    return {
      conversationId: row.conversation_id,
      requestId: row.request_id,
      providerId: row.provider_id,
      modelId: row.model_id,
      historyState: row.history_state,
      historyMessageId: row.history_message_id,
      historyClaimedAt: row.history_claimed_at,
    };
  };

  const claimHistory = (streamId: string, messageId: string): boolean => {
    assertValidStreamId(streamId);
    const timestamp = now();
    // Both guards matter: `pending` makes this the single winner, and
    // `terminal_kind='completed'` means the store refuses to finalize a run that
    // failed, was cancelled, or was interrupted, whatever a caller believes.
    const claimed = db.run(
      `UPDATE chat_streams
          SET history_state = 'claimed', history_message_id = ?, history_claimed_at = ?
        WHERE stream_id = ? AND history_state = 'pending' AND terminal_kind = 'completed'`,
      [messageId, timestamp, streamId],
    );
    return claimed.changes === 1;
  };

  const completeHistory = (streamId: string): boolean => {
    assertValidStreamId(streamId);
    return (
      db.run(
        `UPDATE chat_streams SET history_state = 'done', history_claimed_at = ?
          WHERE stream_id = ? AND history_state = 'claimed'`,
        [now(), streamId],
      ).changes === 1
    );
  };

  const skipHistory = (streamId: string): boolean => {
    assertValidStreamId(streamId);
    return (
      db.run(
        `UPDATE chat_streams SET history_state = 'skipped'
          WHERE stream_id = ? AND history_state IN ('pending', 'claimed')`,
        [streamId],
      ).changes === 1
    );
  };

  const countChunks = (streamId: string): number =>
    db
      .query<{ c: number }, SQLQueryBindings[]>(
        "SELECT COUNT(*) AS c FROM chat_stream_chunks WHERE stream_id = ?",
      )
      .get(streamId)?.c ?? 0;

  const cleanupExpired = async (
    cleanupOptions: ChatStreamCleanupOptions = {},
  ): Promise<ChatStreamCleanupReport> => {
    const timestamp = now();
    const limit = Math.max(
      1,
      Math.min(cleanupOptions.limit ?? DEFAULT_CLEANUP_BATCH, MAX_CLEANUP_BATCH),
    );
    // Deletion criteria: expired AND not `streaming`. An expired streaming row
    // is an orphan awaiting boot recovery, never a cleanup candidate.
    const candidates = db
      .query<{ stream_id: string }, SQLQueryBindings[]>(
        "SELECT stream_id FROM chat_streams WHERE status != 'streaming' AND expires_at <= ? ORDER BY expires_at ASC LIMIT ?",
      )
      .all(timestamp, limit);
    const skippedStreaming =
      db
        .query<{ c: number }, SQLQueryBindings[]>(
          "SELECT COUNT(*) AS c FROM chat_streams WHERE status = 'streaming' AND expires_at <= ?",
        )
        .get(timestamp)?.c ?? 0;

    const report: ChatStreamCleanupReport = {
      scanned: candidates.length,
      deleted: 0,
      skippedStreaming,
      failures: 0,
      deletedChunks: 0,
    };
    for (const candidate of candidates) {
      try {
        const chunks = countChunks(candidate.stream_id);
        deleteStream(candidate.stream_id);
        report.deleted += 1;
        report.deletedChunks += chunks;
      } catch {
        // Per-row isolation: one unremovable row must not strand the rest of
        // the batch. The tick stays observable via the failure count.
        report.failures += 1;
      }
    }
    return report;
  };

  return {
    async acquire(streamId: string, acquireOptions?: ResumableStreamAcquireOptions) {
      return (await acquireLease(streamId, acquireOptions)).role;
    },

    acquireLease,

    async append(
      streamId: string,
      chunk: Uint8Array,
      lease?: ResumableStreamLease,
    ): Promise<void> {
      assertValidStreamId(streamId);
      const timestamp = now();
      db.transaction(() => {
        const row = rowOf(streamId);
        if (!row) throw new Error(`Stream not found: ${streamId}`);
        if (lease && row.lease_token !== lease.token) {
          throw new ResumableStreamError(
            "missing",
            `Stream superseded by a new acquisition: ${streamId}`,
          );
        }
        if (row.status !== "streaming") {
          throw new ResumableStreamError(
            "finalized",
            `Stream already finalized: ${streamId}`,
          );
        }
        const seq = row.next_seq;
        db.run(
          "INSERT INTO chat_stream_chunks (stream_id, seq, chunk) VALUES (?, ?, ?)",
          [streamId, seq, chunk],
        );
        // Same round trip as the insert, and guarded by the lease and the live
        // status, so a superseded producer cannot leave a chunk behind.
        const written = db.run(
          `UPDATE chat_streams
              SET next_seq = ?, chunk_count = chunk_count + 1, byte_len = byte_len + ?,
                  expires_at = ?, updated_at = ?
            WHERE stream_id = ? AND status = 'streaming' AND lease_token IS ?`,
          [seq + 1, chunk.byteLength, timestamp + ttlMs, timestamp, streamId, row.lease_token],
        );
        if (written.changes !== 1) {
          throw new ResumableStreamError(
            "missing",
            `Stream superseded during append: ${streamId}`,
          );
        }
      })();
      notify();
    },

    async finalize(
      streamId: string,
      status: "done" | "error",
      _error?: string,
      lease?: ResumableStreamLease,
    ): Promise<void> {
      // `_error` is intentionally NOT persisted: the library passes the raw
      // producer error here, and storing or replaying it would put provider text
      // in SQLite and back on the wire. The ADR keeps terminal diagnostics to
      // classification fields. Use settleDurable to record a sanitized message.
      // The contract returns void; settleDurable already notifies readers, and
      // its `COALESCE` on terminal_kind keeps a verdict the route already
      // recorded via `recordRunVerdict` while the producer was still appending.
      await settleDurable(streamId, {
        status,
        terminalKind: status === "done" ? "completed" : "failed",
        lease,
      });
    },

    settleDurable,

    async *read(
      streamId: string,
      cursor: string,
      signal: AbortSignal,
    ): AsyncIterable<ResumableStreamEntry> {
      assertValidStreamId(streamId);
      let after = seqFromCursor(cursor);
      const first = rowOf(streamId);
      if (!first || isExpired(first)) throw new Error(`Stream not found: ${streamId}`);

      while (true) {
        if (signal.aborted) return;
        const pending = db
          .query<{ seq: number; chunk: Uint8Array }, SQLQueryBindings[]>(
            "SELECT seq, chunk FROM chat_stream_chunks WHERE stream_id = ? AND seq > ? ORDER BY seq ASC",
          )
          .all(streamId, after);
        for (const entry of pending) {
          if (signal.aborted) return;
          // Copy: the contract requires that a consumer's mutation of a yielded
          // chunk cannot affect another read.
          yield { cursor: cursorOf(entry.seq), chunk: new Uint8Array(entry.chunk) };
          after = entry.seq;
        }

        if (signal.aborted) return;
        const row = rowOf(streamId);
        if (!row) return; // deleted mid-read: active readers terminate
        if (row.status !== "streaming") {
          // Replay first, judge second: the consumer gets the bytes it actually
          // received, and only then the terminal error (reference behaviour).
          const integrity = integrityOf(row);
          if (integrity !== "ok") throw new Error(integrityError(integrity));
          if (row.status === "error") throw new Error(row.error_text ?? GENERIC_ERROR);
          return;
        }
        const wakeBy = row.expires_at - now();
        if (wakeBy <= 0) throw new Error(EXPIRED_ERROR);
        await wait(signal, wakeBy);
      }
    },

    async status(streamId: string): Promise<ResumableStreamStatus> {
      assertValidStreamId(streamId);
      const row = rowOf(streamId);
      if (!row || isExpired(row)) return "missing";
      if (row.status === "streaming") return "streaming";
      if (integrityOf(row) !== "ok") return "error";
      return row.status;
    },

    async delete(streamId: string): Promise<void> {
      assertValidStreamId(streamId);
      deleteStream(streamId);
    },

    cleanupExpired,

    recordRunVerdict,

    bindRunContext,
    getRunContext,
    claimHistory,
    completeHistory,
    skipHistory,

    describe(streamId: string): ChatStreamDescription | null {
      assertValidStreamId(streamId);
      const row = rowOf(streamId);
      if (!row) return null;
      const expired = isExpired(row);
      const integrity = integrityOf(row);
      const reportedStatus: ResumableStreamStatus =
        row.status === "streaming" ? "streaming" : integrity === "ok" ? row.status : "error";
      return {
        streamId: row.stream_id,
        status: expired ? "missing" : reportedStatus,
        storedStatus: row.status,
        terminalKind: row.terminal_kind,
        finishReason: row.terminal_finish_reason,
        errorCategory: row.terminal_error_category,
        chunkCount: row.chunk_count,
        byteLength: row.byte_len,
        sawTerminalPart: row.saw_terminal_part === 1,
        nextSeq: row.next_seq,
        fromForeignBoot: row.boot_id !== bootId,
        expired,
        integrity,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
        finalizedAt: row.finalized_at,
      };
    },

    describeLatestForConversation(conversationId: string): ChatStreamDescription | null {
      // Bounded by the conversation's own rows, and served by
      // `idx_chat_streams_conversation`. Not user input beyond an id, so no
      // stream-id validation applies here.
      const row = db
        .query<{ stream_id: string }, SQLQueryBindings[]>(
          `SELECT stream_id FROM chat_streams
            WHERE conversation_id = ? AND expires_at > ?
            ORDER BY created_at DESC, stream_id DESC
            LIMIT 1`,
        )
        .get(conversationId, now());
      if (!row) return null;
      return this.describe(row.stream_id);
    },

    recoverOrphans(errorText: string): ChatStreamRecoveryReport {
      // `boot_id` is NOT NULL, so every row that is not ours and still
      // `streaming` is an orphan by construction. No wall-clock liveness probe
      // is involved: a liveness timeout would mislabel a slow-but-healthy
      // producer, and at boot there is no producer to be slow.
      const orphans = db
        .query<{ stream_id: string; terminal_kind: ChatStreamTerminalKind | null }, SQLQueryBindings[]>(
          "SELECT stream_id, terminal_kind FROM chat_streams WHERE status = 'streaming' AND boot_id <> ? ORDER BY created_at ASC",
        )
        .all(bootId);
      const report: ChatStreamRecoveryReport = {
        scanned: orphans.length,
        interrupted: 0,
        streamIds: [],
        preservedVerdicts: 0,
        preservedStreamIds: [],
      };
      for (const orphan of orphans) {
        // The same guarded settlement every other terminal transition uses, so
        // there is exactly one settlement mechanism in the codebase. It closes the
        // byte stream (`status`) and keeps any verdict the route already recorded.
        const hadVerdict = orphan.terminal_kind !== null;
        const won = settleTx(orphan.stream_id, {
          status: "error",
          terminalKind: "interrupted",
          errorText,
          errorCategory: hadVerdict ? null : "lifecycle",
        });
        if (!won) continue;
        if (hadVerdict) {
          // The run had already settled — typically `completed`, with its reply
          // written to history. Only the byte stream died. Counting that as
          // `interrupted` would tell the client a finished reply needs a retry.
          report.preservedVerdicts += 1;
          report.preservedStreamIds.push(orphan.stream_id);
        } else {
          report.interrupted += 1;
          report.streamIds.push(orphan.stream_id);
        }
      }
      if (report.interrupted > 0 || report.preservedVerdicts > 0) notify();
      return report;
    },

    dispose(): void {
      notify();
      waiters.clear();
    },
  };
}

function assertValidStreamId(streamId: string): void {
  if (!STREAM_ID_PATTERN.test(streamId)) {
    throw new ResumableStreamError(
      "invalid-id",
      `Invalid streamId: ${streamId} (must match ${STREAM_ID_PATTERN})`,
    );
  }
}

function assertSchema(db: Database): void {
  const table = db
    .query<{ name: string }, SQLQueryBindings[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_streams'",
    )
    .get();
  if (!table) {
    throw new Error(
      "chat_streams table is missing — call applyChatStreamsSchema(db) before creating the store",
    );
  }
}
