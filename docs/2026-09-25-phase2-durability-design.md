# Phase 2 — Durable Direct Runs and History Finalization (design only)

**Status:** design complete; the six policy questions are closed (§0a). Awaiting
implementation approval. **Nothing in this document has been implemented.**
**Date:** 2026-09-25 · **Author:** coding agent · **Scope:** Direct chat only.

OpenCode behavior, files, and boundaries are untouched. `assistant-stream`'s
official resumable infrastructure stays the streaming contract; SQLite becomes
the durable byte store. No second streaming protocol, no second database, no
Redis. The assistant-ui storage format (`ai-sdk/v6`) stays authoritative for
history.

## 0. Contracts this design is built on (verified on disk today)

| Fact | Source |
|---|---|
| `ResumableStreamStore` = `acquire` / `acquireLease?` / `append` / `finalize` / `read` / `status` / `delete`; cursor is an opaque string; `read` yields strictly after the cursor then waits | `node_modules/assistant-stream/dist/resumable/types.d.ts:21-61` |
| `ResumableStreamStatus` = `"streaming" \| "done" \| "error" \| "missing"` (no "interrupted") | same file, line 3 |
| A superseded producer's `append` throws `ResumableStreamError("missing")`; its `finalize` is a no-op | same file, lines 39-47 |
| `finalize(streamId, "done" \| "error", error?, lease?)`; error text is a string | same file, line 50 |
| Context = `run` / `resume` / `requireResume` / `status` / `delete`, with `ttlMs` and hooks | `ResumableStreamContext.d.ts:3-26` |
| `read` throws the stored error string after yielding all entries when finalized `error` | `stores/InMemoryResumableStreamStore.js:162-164` |
| Current store is `createInMemoryResumableStreamStore()`; route hooks are intentionally inert | `src/lib/resumable.ts:16-19` |
| `toUIMessageStream.onEnd` yields `{ isAborted, responseMessage, outcome, finishReason }` | `node_modules/ai/dist/index.d.ts:2504,2514` |
| `upsertStored` is idempotent by message id (`ON CONFLICT(id) DO UPDATE`, preserves `order_seq`) | `src/services/storage/index.ts:365-401` |
| Server-side writes in the assistant-ui shape already exist: `format: "ai-sdk/v6"`, `content: { id, role, parts }` | `src/services/scheduler/schedulerExecution.ts:338-362` |
| History is normally written **by the browser** via `ThreadHistoryAdapter.withFormat` → `POST /api/conversations/:id/messages` | `web/src/adapters/threadHistoryAdapter.ts:149-166` |
| `chatRuns` is process-local and owns the `AbortController` + wall clock; transitions are single-winner latches | `src/services/chat-runs.ts:1-266` |
| The client treats a stream as terminal on a `finish` / `abort` / `error` marker | `web/src/runtime.ts:123-147` |
| DB is additive-migration style (`CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` guards), WAL, `foreign_keys=ON` | `src/db/index.ts:14-47,81,133-158` |
| Retention precedent: `schedulerStore.pruneOldRuns` + a sweep that reports `prunedRuns` | `src/services/scheduler/scheduler.ts:434-453` |
| Composer already has two sibling inline `role="alert"` strips (`px-3 pb-3`, `text-xs text-destructive`) | `web/src/components/Composer.tsx:779-792` |

### Prior art, cited narrowly

`D:\Temp\openchamber` is a different stack (OpenCode client + Express relay + WS;
no assistant-ui, no AI SDK). It is cited **only** for three patterns, each
re-expressed natively:

1. **Snapshot + sequence** — theirs: `type: 'snapshot'` with `sequence` then deltas
   for terminals (`packages/ui/src/lib/api/types.ts:42-60`,
   `terminalApi.ts:89,199,377-410`). Ours: the store's own `read(cursor)` sequence,
   plus a recorded terminal marker as the integrity witness (§2).
2. **Rendered recovery state, not a toast/loader** — theirs: keep the surface
   mounted while `reconnecting`, never blank to a loader
   (`packages/ui/src/apps/MobileApp.tsx:1224-1228`). Ours: a third sibling alert
   strip in the Composer (§13).
3. **Separate `restarted` signal** — theirs: a distinct `restarted` WS event.
   Ours: a `boot_id` column, so "the backend restarted" is distinguishable from
   "the network blipped" with no protocol change (§12).

Their WS relay, terminal sync layer, snapshot frames, and transport model are
**not** adopted and **not** ported.

---

## 0a. Resolved decisions (maintainer, 2026-09-25)

These were open in the first draft and are now closed. The design below
implements them as written.

| # | Question | Decision |
|---|---|---|
| 1 | Encrypt chunks at rest? | **No — accept the existing plaintext posture.** `messages.content` already stores model output in plaintext; encrypting only resumable chunks would create an inconsistent security model. TTL is the bound. |
| 2 | Retention | **24 hours**, `TBAI_CHAT_STREAM_TTL_MS` configurable. |
| 3 | Resume a user-cancelled run | **Replay the exact stored stream, including the abort terminal marker.** Never turn it into a new execution. This preserves the actual UI state the user created. |
| 4 | Retry semantics | **New run.** New `stream_id`, new run, new assistant message. Never reuse the old stream. |
| 5 | Auto-retry interrupted runs | **Never.** Mark interrupted, surface retry, let the user initiate a new run. |
| 6 | Multi-browser resume | **Accepted, read-only.** Multiple clients may consume the same stream; durable finalization stays guarded exactly once. |

**Added invariant (maintainer):** *a resumable stream may be replayed after
cancellation, but cancellation is terminal and never transitions back to
streaming.* Replay is not re-execution. See I10/I11 in §15.

```
retry(oldRun)  ≠  resume(oldRun)

retry(oldRun)   →  new stream_id  →  new run  →  new assistant message
resume(oldRun)  →  byte-exact replay of stored chunks  →  never re-drives the producer
```

The architecture decision confirmed by the maintainer: **replace the
`ResumableStreamStore` implementation, not the AI SDK streaming contract.**

---

## 1. SQLite schema

Added to `src/db/index.ts` alongside the existing `CREATE TABLE IF NOT EXISTS`
blocks. Additive only; no rewrite, no data migration.

```sql
-- One row per Direct run. stream_id is server-minted per run (chat-runs.create).
CREATE TABLE IF NOT EXISTS chat_streams (
  stream_id            TEXT PRIMARY KEY,
  status               TEXT NOT NULL DEFAULT 'streaming'
                         CHECK (status IN ('streaming','done','error')),
  terminal_kind        TEXT
                         CHECK (terminal_kind IS NULL OR terminal_kind IN
                               ('completed','failed','cancelled','interrupted')),
  terminal_finish_reason TEXT,
  terminal_error_category TEXT,   -- classifyError category; never raw text
  boot_id              TEXT NOT NULL,  -- process generation that created it
  lease_token          TEXT,           -- producer lease from acquireLease
  conversation_id      TEXT,
  request_id           TEXT,
  provider_id          TEXT,
  model_id             TEXT,
  next_seq             INTEGER NOT NULL DEFAULT 1,
  chunk_count          INTEGER NOT NULL DEFAULT 0,
  byte_len             INTEGER NOT NULL DEFAULT 0,
  saw_terminal_part    INTEGER NOT NULL DEFAULT 0,  -- integrity witness (§2)
  history_state        TEXT NOT NULL DEFAULT 'pending'
                         CHECK (history_state IN
                               ('pending','claimed','done','skipped')),
  history_message_id   TEXT,
  history_claimed_at   INTEGER,
  finalized_at         INTEGER,
  expires_at           INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

-- Ordered bytes exactly as the producer emitted them. seq is the resume cursor.
CREATE TABLE IF NOT EXISTS chat_stream_chunks (
  stream_id TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  chunk     BLOB NOT NULL,
  PRIMARY KEY (stream_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_chat_streams_expires ON chat_streams (expires_at);
```

**Two status axes, deliberately.** `status` is the official store axis
(`streaming`/`done`/`error`; `missing` is derived from row absence and is never
stored). `terminal_kind` is TBAi's semantic outcome. `interrupted` has no
official equivalent, so it is a `terminal_kind` on a `status='error'` row.

**Foreign keys:** none on `conversation_id` (a stream may outlive or predate a
conversation row, matching how `chatRuns` already treats `conversationId` as
optional correlation). `ON DELETE CASCADE` is therefore not used; cleanup is
TTL-driven.

**Disk posture (decision 1):** chunk bytes are model output stored **plaintext**,
identical to the existing `messages.content` column. Encrypting only resumable
chunks would split the security model across two behaviours for the same data,
so the single existing posture is kept and the 24h TTL bounds the exposure
window. Documented in `docs/security.md`; no encryption code in this phase.

## 2. Snapshot + sequence and integrity rules

The store is the only holder of ordering. Cursor encoding mirrors the official
in-memory store exactly (`cursorOf(seq) = seq.toString(36)`, `read` yields
strictly after the cursor, `""` = from the beginning) so behaviour is
byte-compatible with the library's `readFromStore` and invisible above the
interface.

Three rules, in order of authority:

1. **Terminality authority = the producer's `finalize`.** The library's producer
   task calls `finalize("done" | "error")`; that write is the run's terminal
   truth. `read` after a `done` row returns and closes; after an `error` row it
   yields all entries then throws the stored message — the client receives the
   partial text it actually got plus an error, never invented text.
2. **Integrity witness = the terminal marker.** The route already buffers the
   final chunk; on `finalize` the store flips `saw_terminal_part` when the last
   persisted chunk contains `"type":"finish"` or `"type":"abort"`
   (the same markers `makeIsFinishEvent` uses client-side), and
   `terminal_error_category` is set for `"type":"error"`. Computed once, at
   finalize, by the store's `append` path — not by re-scanning the table.
3. **Integrity violation = mismatch.** `status='done'` with
   `saw_terminal_part=0` means bytes were lost or the producer lied. On the next
   `status()`/`read()` the store reports `error` with
   `terminal_kind='interrupted'` and the route logs `ai.error` with
   `errorType: "StreamIntegrityError"`, `errorType` never carrying provider text.
   Integrity is never inferred from `byte_len`/`chunk_count` alone.

`chunk_count` and `byte_len` are recorded for operator proof ("the replay was N
chunks / M bytes") and are logged on resume, not used for control flow.

## 3. Lease / acquire semantics

- `acquireLease(streamId, {ttlMs})`: `INSERT` a fresh row with
  `lease_token = <new cuid>`, `boot_id = <current boot id>`,
  `expires_at = now + ttlMs` → `{role:"producer", lease}`. If the row already
  exists → `{role:"consumer"}`, no write.
- `append(streamId, chunk, lease)`: single statement — verify
  `status='streaming' AND lease_token = ?`, bump `next_seq`, insert the chunk at
  `seq = next_seq`, refresh `expires_at`. A lease mismatch raises
  `ResumableStreamError("missing")` exactly as the interface requires.
- `finalize(streamId, status, error, lease)`: guarded update
  `WHERE stream_id=? AND status='streaming' AND lease_token=?`. Lease mismatch →
  no-op. `status` already terminal → no-op. `changes === 1` is the
  single-winner signal.
- **No producer re-election, ever.** `stream_id` is minted server-side per run,
  so a client can never cause a second acquisition. The "orphaned producer"
  hazard is therefore resolved at boot (§6) rather than by lease stealing, and
  `lease_token` is defence in depth.
- **Replay never elects a producer.** `resumableContext.resume()` only calls the
  store's `read`; it never calls `acquire`/`acquireLease`. Replaying a terminal
  row therefore cannot resurrect it, re-run the model, or write a new lease —
  which is the mechanism behind the maintainer's cancellation invariant (I10).
- `delete(streamId)`: deletes the row and its chunks; readers terminate. Only
  called by TTL cleanup and by explicit conversation delete — **never** on
  browser disconnect.

## 4. Terminal states

Two axes, **two different owners**. This split is load-bearing and was corrected
during implementation (see "Corrected during implementation" below).

- `status` (`streaming | done | error`) is the **byte stream** axis: "did the
  producer's stream end?". Only the official `finalize` answers it, plus boot
  recovery for orphans. The Direct route never writes it.
- `terminal_kind` is the **run** axis: "did the run succeed?". Only the Direct
  route answers it, via `chatStreamStore.recordRunVerdict`, which writes the
  verdict and nothing else.

| `terminal_kind` | Recorded when | Usually paired with | Client sees |
|---|---|---|---|
| `completed` | `toUIMessageStream.onEnd` outcome `completed` **and** finish reason in the allowlist (`stop`, `length`, `content-filter`, `tool-calls`) | `status='done'` | normal end |
| `failed` | provider error chunk, rejected finish reason (`error`/`other`/missing), merge/transform failure, `response.body` absent, resumable-mount failure, integrity violation | `status='done'` **or** `status='error'` | error part + sanitized copy |
| `cancelled` | explicit `POST /api/chat/cancel`, or wall-clock timeout | `status='error'` | abort marker + partial text; **replayable, never re-executed** (decision 3) |
| `interrupted` | producer never finalized: process died, store error before finalize, or integrity mismatch | `status='error'` | partial text + error; **retry affordance** (§13) |

**`status='done'` with `terminal_kind='failed'` is a normal, expected
combination, not a contradiction.** The Direct UI stream closes cleanly and
carries its own `error` part in the bytes, so the byte stream genuinely
completed while the run failed. The same bytes, replayed, show the user the
error — which is why the verdict lives on its own axis.

`cancelled` and `interrupted` are both `status='error'` because the official
interface has no richer terminal state. The distinction is carried by
`terminal_kind` and is what drives different user copy.

**First verdict wins, and it is one-way.** `settleDurable` and
`recordRunVerdict` both keep an existing `terminal_kind` (`COALESCE`), so nothing
later relabels a run. `cancelled` and `interrupted` are final; an aborted byte
stream is never recorded as `completed`. The official `finalize` seeds a
status-implied default (`done` → `completed`, `error` → `failed`) only to fill a
blank.

**Terminality is one-way (decision 3, maintainer invariant).** Once a row leaves
`streaming`, no code path writes `status='streaming'` back, and no code path
calls `acquire` for an existing row. A cancelled run stays cancelled forever: it
can be *replayed* byte-for-byte for the TTL window, and it can never be
re-executed. The only way to get a new attempt is a new run (§13).

The mapping reuses Phase 1's single settlement latches; Phase 2 only adds the
durable mirror of the outcome. The in-process `chatRuns` latch remains the
race arbiter; `recordRunVerdict`'s guards are the cross-restart arbiter.

### Corrected during implementation

The first implementation had the route call `settleDurable` (status **and**
verdict). Two test failures proved it wrong, and the cause is worth recording:

1. The route's failure settlement fires from `onError`, which runs **while the
   producer is still appending** the parts that carry the error. Closing the row
   there made the library's next `append` throw `finalized`, so the producer
   aborted and the client lost the structured `error` part it needs — four
   Direct tests failed on exactly that.
2. Waiting for the library's own `finalize` first does not help either: the
   library finalizes the byte stream as `done`, and a run that legitimately
   failed would then need a `done → error` downgrade, which re-breaks the live
   response (the consumer read throws instead of closing cleanly).

Hence the axis split above. The route writes only the verdict, so it can record
an outcome at any point in the producer's life without disturbing the streaming
contract, and the client-visible behaviour is byte-identical to the in-memory
store.

## 5. Browser disconnect

Unchanged from Phase 1, and now durable:

1. `monitorStream.cancel()` sets `clientDisconnected`, calls `sourceReader.cancel()`,
   `chatRuns.markDetached(streamId)`, logs `ai.run_detached`. It does **not**
   abort the producer and does **not** delete the stream.
2. The library's producer task keeps consuming `response.body`, keeps
   `append`ing chunks, and keeps running tools — all of it owned by
   `run.controller.signal`, never the request signal.
3. The durable store means those bytes survive process exit, so a later resume
   can replay them even if the app was closed mid-reply.
4. `chatRuns.attach(streamId)` on resume clears the in-memory detached mark. The
   durable row additionally records `detached` implicitly: `history_state`
   pending + `terminal_kind='completed'` at settle time means "finalize it".

## 6. Process / app restart

Boot sweep, run once from `src/server.ts` **before** `initScheduler()` (same
ordering discipline as registry/credentials, per the 2026-09-25 startup ADR):

```
UPDATE chat_streams
   SET status='error', terminal_kind='interrupted',
       terminal_error_category='lifecycle', finalized_at=?, updated_at=?
 WHERE status='streaming'
```
At boot, **every** `streaming` row is an orphan — no producer can outlive the
process. This needs no lease timestamp and cannot produce a false interrupt.
The reason code is `lifecycle`, and the row's `boot_id` differs from the current
boot id, which is what lets resume distinguish "restarted" from "network"
(§12).

Completed/failed/cancelled rows are untouched and stay resumable until TTL.
`chatRuns` is empty after a restart by construction; the durable row is the
authority for outcome, and no run is resurrected (no `AbortController` to
recreate, and nothing should be).

## 7. Producer finishes with no browser attached

Detached completion is a first-class path, not an error:

1. Producer reaches terminal state. `settleFromUiOutcome` wins the
   `chatRuns` latch, then performs the durable write:
   `UPDATE chat_streams SET status=?, terminal_kind=?, terminal_finish_reason=?,
   terminal_error_category=?, saw_terminal_part=?, chunk_count=?, byte_len=?,
   finalized_at=?, updated_at=? WHERE stream_id=? AND status='streaming'`.
2. If `terminal_kind='completed'` and the client did not persist, the server
   finalizes history (§8). "Was anybody there?" is answered by the run's own
   `chatRuns.detachedAt` mark, read at the moment of the authoritative outcome.
   The design's earlier `consumers` counter was **dropped**: it needed another
   persisted signal, and it was strictly worse — a client that drained the whole
   response and then vanished is not detached, while a client that resumed before
   the run finished *is* attached again, and only the lifecycle knows that.
3. `aborted` runs (`cancelled`/`interrupted`) never auto-write an assistant
   message. Partial output is not a reply the user asked to keep, and inventing
   a message for an interrupted run would violate "never invent the missing
   text". The partial bytes remain replayable for 24h if the user reconnects.

## 8. Server-side finalization into `messageService.upsertStored`

- **Trigger:** the single winning `completed` transition of a run whose
  `chatRuns` record carried a `detachedAt` mark. Detachment is read
  **synchronously before** `settleRun`, because `attach()` clears the mark
  regardless of run status and a resume landing later would otherwise flip the
  answer. A disconnect alone never finalizes anything: the run keeps going and
  the decision is made at the authoritative outcome.
- **Message identity:** `toUIMessageStream.onEnd` yields `responseMessage`
  (`ai` types, `UIMessageStreamOnEndCallback`). The route already passes
  `generateMessageId: () => generateId()`, so `responseMessage.id` is the id the
  browser renders and persists. One id, two writers, one row.
- **Persisted shape — the adapter's, not the scheduler's.** `aiSDKV6FormatAdapter`
  (`assistant-cloud/dist/ai-sdk/index.js`) encodes as
  `({ message: { id: _id, ...message } }) => message`: the id is hoisted into
  `messages.id` and **stripped from `content`**. The server does the same, so both
  writers emit the same representation. Note `schedulerExecution.ts` embeds the
  id inside `content` — tolerated only because the two ids are equal, and it is
  not the shape to copy.
- **Parent id:** `messages[messages.length - 2]?.id ?? null`, read from the
  `messages` array the AI SDK hands `onEnd`
  (`[...(isContinuation ? originalMessages.slice(0, -1) : originalMessages), responseMessage]`).
  That is the previous message in the branch the run continued, which is exactly
  what the browser's adapter records — and it stays correct for a continuation,
  where "the last `user` message" is not. The earlier `getThreadTip` fallback was
  **dropped**: with the user message unpersisted it chains the reply onto an
  earlier message, and a false parent is worse than `null`.
- **Run metadata is bound durably.** The official contract knows nothing about
  conversations, so the row is created without them; the route calls
  `bindRunContext` immediately after `resumableContext.run()` returns (the row is
  committed by then). Finalization may be the only writer and may run long after
  `chatRuns` has forgotten the run, so `conversation_id` cannot live only in the
  process-local registry. Binding is fill-only and never repoints a field.
- **Only for Direct, only when settled:** gated on the winning `completed`
  transition, and the claim itself re-checks `terminal_kind='completed'`, so the
  store refuses to finalize a failed, cancelled or interrupted run even if a
  caller asks.
- **Never fabricates.** No usable final message — aborted, absent, no id, not an
  assistant message, or empty `parts` — produces a typed
  `chat_history_skipped` and `history_state='skipped'`. Partial output is never
  promoted into history.
- **No genuine async work on the response-close path.** `onEnd` is awaited by the
  AI SDK's `TransformStream.flush`, so anything truly async there would delay the
  last byte. `upsertStored` performs only synchronous SQLite writes, so the row is
  durable by the time it resolves.

## 9. Exactly-once / idempotent finalization

Two guarded transitions, both single-round-trip conditional updates, using
`changes`:

1. **Verdict / outcome:** `WHERE status='streaming'`, and `terminal_kind`,
   `terminal_finish_reason` and `terminal_error_category` are `COALESCE`d so the
   **first** writer wins. The library's `finalize('done')` must not overwrite a
   recorded failure, and boot recovery's `interrupted` must not overwrite a
   recorded completion. `error_text` *is* assigned, because a failed byte stream
   must carry some stored text and the generic string is the security decision.
2. **History claim:** `UPDATE … SET history_state='claimed',
   history_message_id=?, history_claimed_at=? WHERE stream_id=? AND
   history_state='pending' AND terminal_kind='completed'`. Only `changes === 1`
   proceeds to the `upsertStored` call, then `SET history_state='done'`.

Why it is safe to run twice (browser wrote it, then server finalizes, or vice
versa): same message id, and `upsertStored` is `ON CONFLICT(id) DO UPDATE` that
preserves `order_seq`. The second execution is a no-op that cannot reorder a
thread the browser already placed. There is no second history writer and no
second message format.

The claim suppresses duplicate **work**, not duplicate **rows** — the message id
is the real idempotency key.

**No `claimed` tombstone.** ADR decision 3 removed the boot re-arm, so a failure
after the claim marks the row `skipped` instead: a bare `claimed` would silently
lose an otherwise good reply. `skipped` is written for a skipped finalization and
for a failed write alike, and is final.

**Foreign keys are live.** `PRAGMA foreign_keys=ON` and `messages.conversation_id`
references `conversations(id)`, so a conversation deleted mid-run makes the write
throw. The finalizer catches, marks `skipped`, and logs
`chat_history_finalize_failed` with scalars only — never content.

### Measured performance (2026-09-26)

Recorded because the design assumed a cost, and an unmeasured cost is a guess.
All figures from the real implementation against an isolated copy of the live
data directory, with a ~4,000-token reply from `agnes-2.5-flash`.

| Operation | Measured |
|---|---|
| Append one chunk to a stream | **0.07–0.22 ms** (≈14,000 chunks/s) |
| Full run, 4,171-chunk reply | **≈300–380 ms** total store cost |
| Replay a 2.5 MB stored stream | **8–19 ms** |
| Cleanup 500 expired rows | 4 ticks, **36–55 ms** |

**No optimisation was needed**, and none was added. The store is not the
bottleneck at any plausible conversation size; a per-chunk optimisation would
have been premature. The numbers are here so the next person does not have to
re-derive them before touching `sqliteResumableStore.ts`.

### 9a. The phantom blank bubble after an interrupted run

The client persists an assistant row the moment a run **starts**, holding whatever
the runtime has then — which is only TBAi's UI-only `data-tbai-progress` part. If
the run then dies, nothing ever updates that row. `TodoList` returns `null` for an
empty stage list, so what survives is an assistant turn that renders **nothing**:
a blank bubble, permanently, in the user's history.

Measured on a real interrupted run (`SIGKILL` mid-reply against `agnes-2.5-flash`):
**0 rows had `parts: []`**. Every phantom carried exactly one
`data-tbai-progress` part with `stages: []`. So the defect is *"renders no
content"*, not *"empty array"* — and the same shape already exists in real user
history, which is why a heuristic that deletes stored assistant messages is not
an acceptable fix.

**The fix is prevention, at the client write boundary.** `POST
/api/conversations/:id/messages` refuses an assistant message with nothing
renderable in it and answers `{ success: true, persisted: false }`; the real reply
arrives seconds later as an update to the same message id and is persisted
normally. `messageService.upsertStored` is deliberately **not** touched, so
server-side writers — detached-run finalization and the scheduler — keep writing
whatever they intend.

Why prevention rather than cleanup:

- A post-hoc delete would need run↔message identity, which does not exist durably
  without changing the stream store, or would mean guessing from "latest message".
  Both are worse than not doing it.
- Refusing the write needs no run linkage, is idempotent by construction, cannot
  be resurrected by a reconnect, and cannot race a real reply.
- Nothing is ever deleted, so no legitimate message is at risk.

**The rule is about the message, never the run's outcome.** At shell-write time
the run is still in flight, so the outcome is unknowable — a guard cannot tell
interrupted from cancelled from healthy, and one that claimed to would be
guessing. Interrupted, failed and cancelled therefore behave identically *by
construction*: contentless is not yet a reply. The predicate **fails open** — an
unrecognised part type counts as real content, because dropping a part we do not
understand would destroy a genuine reply. A progress part *with* stages is kept:
the user really saw it.

Verified live on the real scenario: the interrupted run alone leaves **no**
assistant row, and a Retry adds exactly one new assistant message.

Pre-existing phantom rows are left alone on purpose — deleting stored assistant
messages on a heuristic is precisely what "never delete a partially/fully
persisted assistant response" rules out. A one-time cleanup would be a separate,
explicitly-approved operation.

### The crash window, stated precisely

ADR decision 3 scopes out reconstruction, so the honest limitation is: **no
structured final message is persisted, and no boot path reconstructs one.** The
bytes in `chat_stream_chunks` do contain the whole message, so this is a scoping
decision, not an impossibility — a future phase can change that.

The window is the interval between the durable `completed` verdict and the
history write. A crash inside it leaves the reply in the replayable bytes only,
and nothing finalizes it on the next boot. It is narrow because both writes
happen in the same turn of the producer's completion.

The **inverse** case is handled rather than documented: a crash *after* the
history write but *before* `store.finalize` leaves a `streaming` row whose
verdict is already `completed`. Boot recovery closes its byte stream but keeps
the recorded verdict (`preservedVerdicts`, logged as
`ai.stream_verdict_preserved`), because relabelling it `interrupted` would tell
the client a finished reply needs a retry — and a retry would duplicate it.

## 10. TTL and cleanup

- `expires_at = now + ttlMs` on create, refreshed on every `append` **and on every
  settlement** (a run's retention therefore starts when it finishes), matching the
  official store's sliding expiry. Default **24h** (decision 2, confirmed),
  overridable with `TBAI_CHAT_STREAM_TTL_MS` (same env style as
  `TBAI_CHAT_RUN_RECORD_TTL_MS`). Expiry is a property of the **row**: whichever
  store instance runs a tick reads the row's own `expires_at` and never substitutes
  its own TTL.
- Cleanup is owned by the chat-streams service (one owner of timers, per the
  scheduler precedent): an hourly `unref`'d interval, plus one tick immediately at
  start so rows that expired while the app was closed are reclaimed at boot rather
  than up to an interval later. The tick is bounded
  (`DEFAULT_CLEANUP_BATCH = 200`, hard-capped at 1000), never blocks startup, and
  its failures are logged and swallowed — retention bookkeeping must not take the
  server down. Reports
  `{ scanned, deleted, skippedStreaming, failures, deletedChunks }`.
- **Two operations, deliberately distinct, with disjoint responsibilities:**
  - **Boot recovery only (§6):** mark orphaned `streaming` rows
    `error`/`interrupted`. It is the *only* path permitted to relabel a row.
  - **Periodic cleanup only:** delete rows that are **expired AND already
    terminal**. It contains no code path that writes `status` or `terminal_kind` —
    it can only delete.
- **Deletion criterion (corrected 2026-09-26).** The first draft of this section
  specified `DELETE FROM chat_streams WHERE expires_at < now` with no status
  condition, which would also have deleted an expired row that was still
  `streaming`. The implemented, verified rule requires a terminal status:

  ```sql
  SELECT stream_id FROM chat_streams
  WHERE status != 'streaming' AND expires_at <= ?
  ORDER BY expires_at ASC
  LIMIT ?   -- bounded batch
  ```

  Deletion then goes through the same store-owned delete path the official
  `delete()` uses, per row, so there is exactly one deletion mechanism and chunk
  rows are reclaimed identically in both paths (`ON DELETE CASCADE`, plus an
  explicit chunk delete so the outcome does not depend on the connection's
  `foreign_keys` pragma). A row that cannot be removed increments `failures` and the
  batch continues.
- **`status = 'streaming'` rows are never deleted by periodic cleanup**, even when
  their `expires_at` has passed. Such a row is an orphan awaiting boot recovery,
  never a cleanup candidate; it is reported as `skippedStreaming` so an operator can
  see the work boot recovery still owes. **Only after boot recovery has made an
  orphan terminal does TTL cleanup become eligible to delete it** — and even then
  only once its refreshed 24h window has also elapsed.
- **No periodic liveness probe, ever.** During runtime a slow-but-healthy producer
  must not be mislabelled, which is why terminality relies on boot + `boot_id`
  rather than on a wall-clock timeout.
- Cleanup is independent of message retention: it never reads or writes `messages`
  or `conversations`.
- Disk bound: removing the parent row removes its chunks in the same transaction.

## 11. `/api/chat/resume/:streamId` behavior

Protocol unchanged: `200` + `UI_MESSAGE_STREAM_HEADERS` +
`RESUMABLE_STREAM_ID_HEADER`, or `404` for missing/expired. The distinction is
made by what the replayed bytes end in, not by a new status code.

| Stored row | Behavior | Client experience |
|---|---|---|
| `missing` (row absent) | `404` `{error:"stream not found"}` — exactly as today | `onResumeError` clears the stale pointer (existing behavior, unchanged) |
| `status='done'`, witness present | `200`, replay all chunks, clean end | normal completion, **or** the replayed bytes end in the run's own `error` part when `terminal_kind='failed'` |
| `status='error'`, `terminal_kind='cancelled'` | `200`, replay the **exact** stored bytes including the abort terminal marker (decision 3). The trailing throw is only a safety net; the client normally stops on the marker first. | user stopped it; they see precisely the state they created — never a re-execution |
| `status='error'`, `terminal_kind='failed'` | `200`, replay partial chunks, then the stored error | genuine failure, honest copy |
| `status='error'`, `terminal_kind='interrupted'` | `200`, replay partial chunks, then the stored error **tagged as interrupted** | Phase 3 recovery strip with Retry |
| `status='streaming'` (live producer, app never restarted) | `200`, stream live from cursor | continues exactly as today |
| `status='streaming'`, `boot_id ≠ current` | impossible after §6; treated as `interrupted` defensively | retry strip |

`chatRuns.attach(streamId)` still runs so in-memory detached state clears. The
route additionally logs `ai.resume` (`streamId`, `terminal_kind`,
`chunk_count`, `byte_len`, `restarted: boolean`, `ageMs`) — safe scalars only.

## 12. `restarted` vs network/browser reconnect

**Corrected twice during implementation, against a real provider.** The first
plan — "no header, no event envelope, no client protocol branch beyond reading
the existing error path" — is not achievable with the installed AI SDK:

- `makeRequest` **never rejects** (`ai/dist/index.js:19120-19320`). A failed
  `reconnectToStream` is caught at `:19176` and an errored replayed stream at
  `:19273`; both only call `setStatus({ status: "error" })`.
- `onResumeError` is invoked from `chat.resumeStream().catch(...)`
  (`@assistant-ui/ai-sdk/dist/runtime/useChatThread.js:117`). With no rejection
  there is no catch, so **the hook never fires** — for a 404 and for an
  interrupted replay alike.
- The live hook is `onError` (`:19176`, `:19288`), which fires for both.

The second plan keyed recovery on the transport's resumable-stream pointer. A
live run against a real provider killed that too, and the reason is structural:
**the pointer is transport-owned, the transport clears it when a send fails
(before the failure is reported), and it does not survive an app restart.** A
client that can only ask "what is stream X?" with an id it may have lost cannot
recognise a dead run at all — observed live as a crash that produced no recovery
state whatsoever, and as seven replayed resumes in ~20ms while it hunted for one.

### The durable question is about the CONVERSATION

Every run already binds `conversation_id` (§8), so "what became of the last thing
I asked in THIS conversation?" is answerable durably, with no client-held state at
all — and a conversation id is always known.

- **`GET /api/chat/stream-status?conversationId=<id>`** (or `?streamId=<id>` for
  a caller that already holds one) — a read-only projection of the same row the
  resume protocol replays: `status`, `terminalKind`, `restarted` (`boot_id ≠
  current`), `historyState`, `chunkCount`, `byteLen`, `ageMs`. Safe scalars
  only; no chunk bytes, no provider text, never the prompt. `400` for a missing,
  doubled or malformed selector; a conversation with no run is a `200` with
  `run: null`, because "never answered" is normal and must be distinguishable
  from "could not read".
- Backed by `describeLatestForConversation` and
  `idx_chat_streams_conversation`. Expired rows are reported as absent, so a
  forgotten reply never resurfaces as a phantom recovery; a `streaming` row is
  reported honestly, so a healthy reply is never called a recovery.
- Resolved at three points: thread load, `onError`, and a bounded re-read chain.
- Because the client no longer needs the resume machinery to learn what happened,
  the dead-stream replay storm **disappears** rather than being damped: verified
  live at zero resume replays.

- **Network / browser reconnect:** the process never restarted
  (`boot_id === current`), the row is `streaming` (live producer) or already
  terminal. No interruption language anywhere.
- **Restart mid-run:** `boot_id !== current` and `terminal_kind='interrupted'`.
- **Backend-restart-with-`boot_id`-absent** (an older build's row): treated as
  `interrupted`, never `failed`, so the copy never accuses the provider.
- A client that cannot read the status treats the terminal state as
  **unconfirmed** and offers no Retry. Failing toward "no button" is the only
  safe direction.

### Convergence is the recovery feature's own, not a sibling's

A crash is detected while the backend is DOWN, so the first status read is
*guaranteed* to fail and the notice starts unconfirmed. Something must ask again.
Keying that off the availability poller's offline→online **transition** was tried
and does not work: the transition can be missed outright (observed live — a single
`/readyz` poll across a crash and a restart), and a feature that silently stalls
on a sibling subsystem's edge case is not durable.

So the re-read owns itself: a bounded, backing-off chain (1.5s → 25s, five
attempts) that stops the moment a verdict arrives. It answers a different
question from the availability poller — "has this conversation's verdict
arrived?", not "is the backend reachable?" — so there is still exactly one
reachability authority. The availability store is kept only as a cheap catch-up
for a chain that already exhausted its attempts.

An **unreadable** status is never treated as "nothing happened": a thread that
demonstrably had a run in flight keeps an unconfirmed notice (no Retry) so the
chain has something to upgrade. Only a conversation with no run at all, or a
`streaming` one, clears the notice.

## 13. Phase 3 Composer interaction

- **Surface:** a third sibling inline strip in `Composer.tsx`, identical shape
  to the existing two (`px-3 pb-3`, `role="alert"`, `text-xs text-destructive`),
  placed after `codeSendError` and `compactError`. No new dialog, page, route,
  or toast system.
- **Trigger:** three points, none of which depends on a resumable pointer: thread
  load, the runtime's `onError` (the only live error hook — see §12), and the
  bounded re-read chain that upgrades an unconfirmed notice once the backend can
  answer.
- **Copy:** two sentences, chosen by the server's verdict, never by matching an
  error string — *interrupted:* "The app restarted while this reply was
  streaming. Nothing was sent — retry?" · *unconfirmed:* "Couldn't reconnect this
  reply." (no button).
- **Retry action (decision 4):** append the last user turn as a **new** user
  message, which starts a new run — new `stream_id`, new run, new assistant
  message id, fresh `history_state='pending'`. The old row stays for the TTL
  window and is never resurrected, re-driven, or rewritten.
  `retry(oldRun) ≠ resume(oldRun)`: retry mints new identity, resume only replays
  bytes. There is deliberately **no** API that re-drives a terminal stream, so a
  retry cannot be expressed as a resume by accident.
- **Retry safety (the dangerous case):** the button renders only when the server
  reports `terminalKind='interrupted'` **and** the prompt is non-empty. The first
  condition is the duplicate-message guarantee: `interrupted` is the one terminal
  kind a live send can never produce, so a run that actually **completed** can
  never satisfy it. The second is because a crashed run's user message was never
  persisted, so there is nothing to re-send. Every other case — `completed`,
  `failed`, `cancelled`, still streaming, an unreadable status, or a lost prompt —
  shows the sentence with no button. Server-side backstops unchanged: a new run
  is a new `stream_id`, and `POST /api/chat` never accepts a client-supplied one.
- Auto-clear on the next send, at the single funnel every send passes through
  (`prepareSendMessagesRequest`), so Enter, the button, touch, and programmatic
  sends all clear it.

**Verified live** (Playwright + Bun, real `agnes-2.5-flash`, backend `SIGKILL`ed
mid-reply): boot recovery reports `interrupted=1`; the conversation-scoped status
returns `terminalKind=interrupted, restarted=true`; the strip upgrades by itself
to the interrupted copy with a working Retry; the retry issues exactly one new
model request and adds exactly one new assistant message id; and **zero** resume
replays occur.

## 14. Migration and backward compatibility

- **In-memory state needs no migration.** It is process-local and lost on
  restart by definition; there is nothing to convert.
- **Client-held pointers:** a browser may hold a `stream_id` for a stream that no
  longer exists (old build, or a row already TTL'd). Resume answers `404`, which
  is the current contract, and the current `onResumeError` path clears the
  pointer. Unchanged.
- **Additive schema:** new tables only. An older build ignores them harmlessly;
  a downgrade leaves orphan rows that the next upgraded boot's TTL sweep removes.
- **No message-format change:** `ai-sdk/v6` + `{id, role, parts}` is exactly what
  is written today, so old and new history rows are mutually readable.
- **No protocol change:** the client already speaks the official resume protocol
  through the transport's `resumable` mount; nothing about the request or the
  replayed bytes changes shape.

## 15. Failure modes and invariants

**Invariants (must hold, and are asserted by tests):**

- I1 — A run is settled exactly once per process (existing `chatRuns` latch) and
  at most once durably (`status` guarded update).
- I2 — `status='done'` implies the terminal marker was persisted (or an
  `ai.error` integrity line was emitted and the row downgraded to `interrupted`).
- I3 — At most one assistant message row per run, keyed by `responseMessage.id`;
  browser and server writes converge to the same row.
- I4 — Browser disconnect never aborts a producer and never deletes a stream.
- I5 — A run that no producer owns is never `completed`.
- I6 — A live producer is never relabelled `interrupted` by a periodic sweep.
- I7 — Replay never invents bytes: the client receives exactly what was appended,
  then the recorded terminal error.
- I8 — No secret, prompt, tool payload, or raw provider text enters
  `chat_streams` beyond model output bytes already persisted in `messages`;
  terminal diagnostics are classification fields only.
- I9 — Cleanup is TTL-bounded and never deletes a `streaming` row in use.
- **I10 — Cancellation is terminal (maintainer invariant).** Once a row leaves
  `streaming` it never returns: no write sets `status='streaming'` again, and no
  path calls `acquire` for an existing row. A cancelled run is replayable
  byte-for-byte and is never silently resumed or re-executed.
- **I11 — Retry is a new identity, never a reuse.** `retry(oldRun)` mints a new
  `stream_id`, a new run, and a new assistant message. It never reuses,
  resurrects, or rewrites the old row, and the old row's history write is left
  final. `resume(oldRun)` replays bytes and never re-drives the producer.
- I12 — No automatic re-execution of any kind (decision 5). An interrupted run
  is labelled and surfaced for the user; the server never retries it.
- I13 — Multiple consumers of one stream are read-only. Only the guarded claim
  writes history, so N browsers still produce exactly one message (decision 6).

**Failure modes and handling:**

| Failure | Handling |
|---|---|
| Process killed mid-stream | boot sweep → `interrupted`; partial bytes replayable; Phase 3 retry |
| Producer task throws before `finalize` | library `onError`; store row stays `streaming` until the **boot sweep** settles it — TTL never deletes a `streaming` row (§10) — and the route already settles `chatRuns` failed in-process |
| Chunk write fails (disk full/locked) | `append` throws → producer task ends → in-process run settles failed; durable row finalized `error`; boot sweep backstop |
| Store row corrupt / integrity mismatch | `status()` reports error; `terminal_kind='interrupted'`; `ai.error` with `errorType:"StreamIntegrityError"` |
| Two clients resume the same stream | both are consumers (read-only); history written once by the guarded claim |
| Clock skew between TTL and boot | TTL is advisory for deletion only; `interrupted` never depends on it |
| Cleanup races an active read | chunk delete happens with the parent row in one transaction; `read` re-checks row presence each wait cycle and ends the iterator |
| History write fails after claim | `history_state` stays `claimed`; boot sweep re-arms after 10 min; message may be missing from history but the run outcome is intact |

## 16. Exact files, tables, and functions

Names below are the **implemented** ones. The design originally planned a single
`index.ts` process singleton; the implementation split it by lifecycle owner
instead, because boot recovery, the cleanup timer, and the live route have
genuinely different lifetimes, and one module holding all three would be a
grab-bag.

**New:**
- `src/services/chat-streams/schema.ts` — the single DDL definition
  (`chat_streams`, `chat_stream_chunks`, `idx_chat_streams_expires`) plus the
  shared vocabulary (`ChatStreamStatus`, `ChatStreamTerminalKind`,
  `ChatStreamHistoryState`). A leaf module, so `src/db/index.ts` can apply the
  DDL without an import cycle.
- `src/services/chat-streams/sqliteResumableStore.ts` — implements
  `ResumableStreamStore` against the two tables; exports
  `createSqliteResumableStreamStore({ db, bootId, ttlMs, now })` plus the TBAi
  primitives `settleDurable`, `recordRunVerdict`, `recoverOrphans`,
  `cleanupExpired`, `describe`.
- `src/services/chat-streams/boot.ts` — `APP_BOOT_ID` and
  `recoverOrphanedChatStreams()` (boot-only orphan sweep).
- `src/services/chat-streams/cleanup.ts` — the single cleanup timer owner:
  `startChatStreamCleanup` / `stopChatStreamCleanup` /
  `getChatStreamCleanupState`.
- `src/services/chat-streams/historyFinalizer.ts` — the detached-completion
  fallback: validates the final message, claims the row, calls
  `messageService.upsertStored`, and marks the row `done`/`skipped`. Never
  throws; every failure is a typed outcome.

**Modified:**
- `src/db/index.ts` — applies the shared DDL.
- `src/lib/resumable.ts` — swaps `createInMemoryResumableStreamStore()` for the
  SQLite store and exports the single shared instance as `chatStreamStore`;
  keeps `ttlMs` and the inert `onError` hook (Direct route is the single
  `ai.error` owner).
- `src/routes/chat.ts` — records the run verdict on every winning `chatRuns`
  terminal transition (inner `onEnd` outcome, `onAbort`, and the cancel
  endpoint) via `recordRunVerdict`; binds run context after
  `resumableContext.run()`; drives the detached history finalization from the
  inner `onEnd`; logs `ai.resume` with both axes plus `restarted` from the
  durable row, leaving the resume response contract untouched; and serves
  `GET /api/chat/stream-status/:streamId` (Phase 3's read-only projection).
- `src/server.ts` — `recoverOrphanedChatStreams()` before `initScheduler()`, then
  `startChatStreamCleanup()`; stop cleanup before `db.close()`; logs
  `ai.stream_verdict_preserved` separately from `ai.stream_recovered`.
- `web/src/runtime.ts` (Phase 3) — the live `onError` hook recognises a dead run
  from a still-pending resume pointer, resolves it against the status endpoint,
  and clears any recovery notice at the send funnel.
- `web/src/features/chat/state/streamRecovery.ts` (Phase 3) — the per-thread
  recovery state and the Retry safety gate (`classifyStreamStatus`).
- `web/src/lib/ui-messages.ts` (Phase 3) — `lastUserText`, extracted so the
  runtime's draft handoff and the retry share one definition.
- `web/src/components/Composer.tsx` (Phase 3) — third alert strip + guarded Retry.
- `docs/decisions.md`, `docs/architecture.md`, `docs/security.md` — the ADR, the
  data flow, and the plaintext-bytes-with-24h-TTL posture.

**Still to come:** nothing in Phase 2 or 3. The only deliberate gap is decision
3's crash window (§9), which is documented rather than repaired.

**Unchanged:** `src/services/chat-runs.ts` (stays process-local — an
`AbortController` cannot be durable; the DB row mirrors outcomes only),
`src/lib/model-messages.ts`, `src/lib/prune-messages.ts`, `src/lib/errors.ts`,
`src/lib/redact.ts`, `src/services/ai.ts`, `src/lib/validation.ts`,
`src/tools/**`, all of `src/services/opencode/**`, `src/routes/opencode.ts`, and
`web/src/features/opencode/**`.

## 17. Test strategy

**Store unit (`src/services/chat-streams/sqliteResumableStore.test.ts`)** —
implements the full `ResumableStreamStore` contract:
acquire produces then consumes; `acquireLease` token; superseded lease →
`append` raises `ResumableStreamError("missing")` and `finalize` no-ops;
`read` from `""` replays all; `read` from a cursor yields strictly after it and
waits for new appends; `read` after `error` yields then throws; `delete`
terminates readers; TTL expiry removes the row; `status` transitions
`streaming → done|error → missing`.

Plus the two-axis guarantees that the split in §4 exists to provide:
- `recordRunVerdict` mid-stream leaves `status='streaming'` and `append` still
  working, and a later `finalize('done')` keeps the recorded verdict — so a
  mid-stream failure is recorded as `status='done', terminal_kind='failed'`.
- `recordRunVerdict` never overwrites `cancelled` or `interrupted`, and never
  records `completed` on a `status='error'` row.
- `finalize` seeds `terminal_kind` only when the row has none.

**Route/integration (`tests/integration/chat-streams-durability.test.ts`)**:
- **restart** — run to a partial stream, simulate restart (new store instance
  + boot sweep against the same DB file), assert `interrupted` and that
  `boot_id` mismatch is reported as `restarted`.
- **detached completion** — controlled provider, cancel the response body
  mid-stream, let the producer finish; assert exactly one assistant message in
  `messages` in `ai-sdk/v6` shape with the correct `parent_id`, and
  `history_state='done'`.
- **truncated stream** — provider that ends without a terminal finish reason;
  assert `terminal_kind='failed'` (never `completed`), no history row written,
  and the integrity witness absent.
- **duplicate finalization** — invoke the finalizer twice plus a concurrent
  double-claim race; assert one message row, one `ai.response`/`ai.error` line,
  `history_state='done'`, and identical `order_seq`.
- **TTL cleanup** — backdate `expires_at`, run the sweep, assert row and chunks
  are gone; assert a `streaming` row is never touched by a periodic sweep
  (invariant I6) but *is* interrupted by the boot sweep.
- **retry safety** — completed run whose resume response is lost: the client
  must not offer Retry; interrupted run must. Also assert decision 4/I11
  end-to-end: Retry issues a new `POST /api/chat`, yields a different
  `stream_id` and a different assistant message id, and leaves the old row's
  `history_state='done'` untouched.
- **cancellation terminality (I10)** — cancel a run, then resume it three ways
  (immediate, after TTL refresh, after a simulated restart). Assert every resume
  replays the identical byte sequence ending in the abort marker, that
  `status`/`terminal_kind` never revert to `streaming`, that no lease is
  re-acquired, that the model is never called a second time (controlled endpoint
  request count stays at 1), and that no new message row appears.
- **multi-browser (I13)** — two concurrent resumes of one completed detached
  run: both receive the full replay, and the conversation ends with exactly one
  assistant message.
- **integrity violation** — flip `saw_terminal_part=0` on a `done` row; assert
  downgrade to `interrupted` and the `StreamIntegrityError` log with no raw text.

**Regression guards:** the Phase 1 suites must stay green unchanged —
`direct-hardening`, `error-hygiene`, `chat-runs`, `engine-guards`,
`approval-lifecycle`, `approval-secret-integrity`, `credentials`,
`error-taxonomy`, `resumable-stream`, `scheduler`.

**Isolation:** the new store tests must never close the shared `db` singleton
(the failure mode already proven with `client-request-id.test.ts`); use
`DATA_DIR` redirection or a private temp file, and never run them in the same
process as `shutdown-lifecycle.test.ts`.
