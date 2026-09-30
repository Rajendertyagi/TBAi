# U25 / U30 Investigation Report

**Status:** Investigation only. No architecture chosen, no production change, no test created or modified.
**Inputs:** `docs/context-architecture-audit.md`, `docs/context-assembly-contract-2.1b.md`, `docs/context-contract-validation-2.1c.md`.

## Results

| Unknown | Conclusion |
|---|---|
| **U25** — resume → auto-continue persistence identity | **CLOSED** — the SDK reconciles the message id; one identity per logical turn |
| **U30** — approval pause → storage → reload → approval | **CLOSED** — the `approval` object and its id survive the round trip verbatim, proven empirically |
| **U26** — `experimental_toolApprovalSecret` verification | **Still OPEN** — not addressed by this investigation |

---

# U25 Investigation

## Question

Can a resume followed by an SDK auto-continue create **two assistant rows**, or otherwise produce inconsistent persisted message state?

## Exact ID lifecycle

Seven identifiers are in play. Each is traced to its assignment site.

| # | Identifier | Created at | Fate |
|---|---|---|---|
| 1 | **Original assistant message id** | SDK `generateId()` during the first run's `makeRequest` — `ai:19194` | Emitted into the stream's first `start` chunk; **recorded in `chat_stream_chunks`** |
| 2 | **Resumable stream id** | `chatRuns.create` → `chat-runs.ts:151`; surfaced as `streamId` (`chat.ts:296`) | Set in the `RESUMABLE_STREAM_ID_HEADER` response header (`chat.ts:835`); used by `GET /api/chat/resume/:streamId` |
| 3 | **Replayed message id** | **Not created** — the replayed bytes are the original run's recording, so any `messageId` in them is identifier 1 | Re-delivered to the client on resume |
| 4 | **New placeholder id** | `ai:19194` `this.generateId()` — **runs unconditionally, including for `resume-stream`** | **Overwritten** by the replayed `start` chunk (see below) |
| 5 | **`parentId`** | `chat.ts:658` `messages[messages.length - 2]?.id ?? null` — from the **in-memory branch**, not the stored tip | Written to `messages.parent_id` by `upsertStored` |
| 6 | **Chunk-carried id** | First SSE frame: `{"type":"start","messageId":"<original>"}` | Overwrites identifier 4 |
| 7 | **`messageExists` / `upsertStored` key** | `getId: (message) => message.id` (`aiSDKV6FormatAdapter`); `ON CONFLICT(id)` (`storage/index.ts:496-516`) | Since ids 1, 4 and 6 converge on one value, the guard matches |

### The reconciliation

```js
// createStreamingUIMessageState — ai:6959-6975
message: (lastMessage?.role) === "assistant" ? lastMessage
        : { id: messageId, metadata: void 0, role: "assistant", parts: [] }
```

For `resume-stream`, `lastMessage` is `undefined` (`ai:19193`), so a **fresh placeholder with a new id is created**.

```js
// start-chunk handler — ai:7551-7552
if (chunk.messageId != null) {
  state.message.id = chunk.messageId;      // ← OVERWRITES the placeholder id
}
```

**This is the reconciliation point.** The replayed stream's `start` chunk carries the **original** run's id, and it overwrites the freshly minted placeholder.

## Resume path

```text
GET /api/chat/resume/:streamId                    chat.ts:850-897
  → chatRuns.attach(streamId)                     chat.ts:854
  → resumableContext.resume(streamId)             chat.ts:878
  → store.read → SELECT seq, chunk FROM chat_stream_chunks
                                              sqliteResumableStore.ts:933-969
  → replays recorded BYTES. No message read, no model call.
```

**The recorded bytes always begin with the `start` chunk**, because the whole response body is wrapped from byte 0:

```ts
// chat.ts:720
wrappedStream = await resumableContext.run(streamId, () => response.body!);
```

`createUIMessageStreamResponse` emits a complete UI message stream, whose first frame is always `{"type":"start","messageId":…}` — **empirically verified, see Reproduction evidence.**

## Auto-continue path

```text
replayed stream consumed → start chunk overwrites placeholder id  ai:7551-7552
  → shouldSendAutomatically() passes?
  → makeRequest({ trigger: "submit-message", messageId: this.lastMessage?.id })
                                                            ai:19311-19319
  → transport.sendMessages({ messages: this.state.messages })   ai:19207-19216
  → POST /api/chat  (runtime.ts:419-430, messages at :425)
  → server: prepareModelMessages → convertToModelMessages → streamText
  → a genuinely NEW assistant turn begins (correct: it is a new model call)
```

⚠️ **The follow-up `makeRequest` mints another new id at `ai:19194`** — but that is
correct and expected, because it is a **distinct assistant turn**, not a
continuation of the resumed one. The resumed message is carried as *history* in
the posted array, under the **original** id.

⚠️ `trigger: "resume-stream"` is **replaced** by `"submit-message"` at
`ai:19311-19319` — the resume origin is destroyed before the POST leaves the
client. This is the G13 finding from 2.1c and is unchanged.

## Persistence/reconciliation behavior

Both server-side guards now match, because the ids converge:

| Guard | Evidence | Effect |
|---|---|---|
| `messageExists` | `historyFinalizer.ts:194` → `hasStoredMessage` → `SELECT id` (`storage/index.ts:436-443`) | The client persisted under the **original** id, so the reconciler's check **matches** and it skips |
| `claimHistory` | `sqliteResumableStore.ts:721-734`; refuses a non-completed claim (`:730`) | The reconciler cannot re-finalize a settled run |
| `upsertStored` | `ON CONFLICT(id) DO UPDATE` (`storage/index.ts:496-516`) | A re-write of the same id **updates** rather than duplicates |

**Duplicate-row possibility: eliminated** for the paths traced, because the
placeholder id is overwritten before persistence.

⚠️ **One residual edge, not a duplicate-row risk:** if a stream is recorded with
**zero** chunks, there is nothing to resume and no `start` chunk to reconcile
against. The resume would return no usable stream (`chat.ts:879-896` → 404/500).
That is a failed resume, not a duplicated turn.

## Reproduction evidence

**Probe 1 — stream shape (executed, then removed).** Built a real
`createUIMessageStream` + `createUIMessageStreamResponse` and read the raw SSE bytes:

```
data: {"type":"start","messageId":"msg_ORIGINAL_RUN_ID"}   ← frame 0
data: {"type":"start-step"}
data: {"type":"text-start","id":"t1"}
data: {"type":"text-delta","id":"t1","delta":"hello"}
data: {"type":"text-end","id":"t1"}
data: {"type":"finish"}
data: [DONE]

first frame type        : start
first frame messageId   : msg_ORIGINAL_RUN_ID
matches original run id?: true
```

**This is the load-bearing fact.** A replayed stream always re-delivers the
original run's `messageId` in its first frame, so `ai:7551-7552` always has an id
to reconcile against.

⚠️ **Limitation:** a **full end-to-end** reproduction (live provider, browser
disconnect mid-stream, real resume, real auto-continue) was **not** performed —
it needs a real credential and a browser. What is proven is the two links that
were previously unknown: the placeholder-id overwrite and the stream's first
frame. The remaining links (`chat.ts:720` wrapping from byte 0, the client's
resume entry) are read from code.

## Conclusion

## **U25 — CLOSED**

Original and resumed/continued assistant ids are **guaranteed identical**, by
construction: the placeholder id is unconditionally overwritten by the replayed
`start` chunk before any persistence can occur, and the stream always leads with
that chunk. The `messageExists` guard and `ON CONFLICT(id)` therefore both
operate on the same value.

**No duplicate assistant row, no duplicate logical turn, no orphaned row, and no
`messageExists` miss is reachable through resume → auto-continue.**

Residual unknown: whether the client can ever *skip* the resume (and so never
receive the `start` chunk) while still holding a placeholder — no such path was
found, but the client's resume entry (`useChatThread.ts:286`) was not traced
line-by-line.

---

# U30 Investigation

## Question

Does an approval request survive the client-side persistence and reload process
so that a user can approve it **after** a reload?

> **Note:** the previously suspected U28 defect was falsified at the SDK level in
> 2.1c. That falsification is **not** reopened here. The question below is
> strictly about the **storage round trip**, which was the one remaining link.

## Approval object lifecycle

| Stage | Where | `approval` state |
|---|---|---|
| 1. Model emits a gated tool call | `streamText` with `toolApproval` map (`chat.ts:525-532`) | SDK attaches `approval: { id, isAutomatic, requestReason, signature }` |
| 2. Run pauses | status becomes `requires-action` / `tool-calls` | Part `state: "approval-requested"`, `approval` present |
| 3. Paused row persisted | `useExternalHistory.ts:322-324` `isReady`; TBAi supplies `update` (`threadHistoryAdapter.ts:164-166`) | `approval` on the part |
| 4. POST to server | `threadHistoryAdapter.ts:150-155` `encode()` → `appendStored` (`:81-85`) | `content` = `formatAdapter.encode(item)` |
| 5. SQLite | `upsertStored` (`storage/index.ts:480-537`) | `content` JSON, verbatim |
| 6. Reload | `threadHistoryAdapter.ts:186-212` `load()` → `formatAdapter.decode(...)` | `approval` restored |
| 7. User approves | part becomes `state: "approval-responded"`, `approval.approved` set | same `approval.id` |
| 8. POST `/api/chat` | `runtime.ts:425` | converter gate applies |
| 9. Converter | `ai:11729-11738` | `part.approval != null` → emits `tool-approval-request` |
| 10. SDK match | `ai:2915-2924` scan → `ai:2937` | id found → honored |

## Storage serialization

**The encoder is a structural rest-spread that removes only `id`:**

```js
// assistant-cloud@0.2.1 — dist/ai-sdk/index.js:4-15
const aiSDKV6FormatAdapter = {
  format: "ai-sdk/v6",
  encode: ({ message: { id: _id, ...message } }) => message,   // :6
  decode: (stored) => ({ parentId: stored.parent_id, message: { id: stored.id, ...stored.content } }),  // :7-13
  getId: (message) => message.id                              // :14
};
```

⚠️ **Correction to my own 2.1c note:** I wrote that `assistant-cloud` was
"missing." It is **present** — installed under Bun's isolated store at
`node_modules/.bun/assistant-cloud@0.2.1+…/node_modules/assistant-cloud` and
declared in `web/package.json`. No defect. My initial root-level search simply
missed the `.bun` layout.

TBAi's own adapter is a **pure passthrough** and states so
(`threadHistoryAdapter.ts:41-42`): *"We persist exactly what the format adapter
produces… and hand it back verbatim on load — we never interpret the message
internals."*

## Reload hydration

`threadHistoryAdapter.ts:186-212`: `GET /api/conversations/:id/messages` →
`formatAdapter.decode({ id, parent_id, format, content })` (`:200-206`).
Filtering is `.filter((e) => e.content != null)` (`:198`).

Server read: `listThreadMessages` (`storage/index.ts:544-568`) — `ORDER BY
order_seq ASC, created_at ASC`, `JSON.parse` with `null` on parse failure, and
contentless rows filtered out (`:567`).

## Approval submission

`respondToApproval` → `ai:19011-19022` → `makeRequest({ trigger: "submit-message" })`
→ auto-continue POST. The part in the posted array carries `approval.approved`.

## SDK matching

```js
// ai:11729-11738 — the converter's gate
if (part.approval != null) { content.push({ type: "tool-approval-request", approvalId: part.approval.id, ... }); }
```

```js
// ai:2915-2924 — the consumer scans the WHOLE messages array
for (const message of messages) { ... if (part.type === "tool-approval-request") toolApprovalRequestsByApprovalId[part.approvalId] = part; }
```

```js
// ai:2937-2941 — fails closed
const approvalRequest = toolApprovalRequestsByApprovalId[approvalResponse.approvalId];
if (approvalRequest == null) throw new InvalidToolApprovalError({ approvalId: approvalResponse.approvalId });
```

Because the request part is regenerated from the **reloaded** message rather than
from live run state, a reload followed by an approval **matches**.

## Reproduction evidence

**Probe 2 — real format-adapter round trip (executed against the installed
package, then removed).** Took an assistant message paused on an approval gate
through encode → `JSON.stringify`/`parse` (what SQLite does) → decode:

```
=== 1. ENCODE ===
  id stripped : true
  approval.id       survives encode : appr_ZXY001
  approval.requestReason survives  : destructive
  toolCallId        survives encode : call_abc789
  part state        survives encode : approval-requested

=== 2. STORED ROW (SQLite content column) ===
  approval.id       survives JSON    : appr_ZXY001

=== 3. DECODE (reload) ===
  message id  : msg_ORIGINAL_123
  approval.id       survives decode : appr_ZXY001
  part state        survives decode : approval-requested
  getId(message)                    : msg_ORIGINAL_123

=== 4. THE U30 GATE ===
  part.approval != null  -> true
  => converter WOULD emit tool-approval-request with approvalId: appr_ZXY001

=== 5. POST-APPROVAL ===
  approval.id       unchanged        : appr_ZXY001
  approval.approved now             : true
  part state                        : approval-responded
  part.approval != null (gate)      : true

approval.id identical across encode/store/decode : true
approval.id unchanged after the approval response  : true
toolCallId identical                               : true
```

**Every field survives, and the id never changes.**

## Conclusion

## **U30 — CLOSED**

`approval.id`, `approval.requestReason`, `toolCallId`, and part `state` all
survive encode → SQLite → decode verbatim. The converter's gate
(`part.approval != null`) therefore holds on a reloaded message, the SDK
re-registers the request from the array, and the id match at `ai:2937` succeeds.

**A user can approve a tool after a full page reload, and the approval is
honored.**

### U30-C — replay protections re-verified

| # | Protection | Status |
|---|---|---|
| 1 | SDK current-array ID matching | **PROVABLE** — `ai:2937-2941`, throws `InvalidToolApprovalError` on no match. Fails closed |
| 2 | Pruner expiration | **PROVABLE** — `prune-messages.ts:142-148` drops an approval part once a later user turn exists |
| 3 | Stale approval ID submitted | **PROVABLE** — no matching `tool-approval-request` in the array ⇒ `ai:2939` throws |
| 4 | Reloaded ID treated as the same request | **PROVABLE** — proven by Probe 2; the id is byte-identical, so the match succeeds |
| 5 | Duplicate approval IDs coexisting | **NOT PROVABLE** — nothing forbids two tool parts carrying the same `approval.id`; `toolApprovalRequestsByApprovalId[id]` would keep the **last** write (`ai:2920`). No test covers it. **Low practical risk** (ids are provider/SDK-generated) but unproven |

⚠️ **Correction to my 2.1b ranking:** mechanism 1 (ID match) is the strongest —
it is type-level and fails closed. The per-run secret is the **weakest**, because
its verification site was never located. U26 remains open and is **not** resolved
by this investigation.

---

# Architecture Impact

Factual consequences only. **No option is selected, ranked, or recommended.**

## Option A — Server-authoritative

- **Mid-flight approval visibility: LOST.** The server has no server-side record of an approval decision — no table, no column, no endpoint. Today the decision arrives in the browser's posted part. Under A the server would need a **new server-side approval write path**, which this investigation confirms is the largest structural gap.
- **Does it require additional persistence? YES** — approval decisions and client-produced tool results would each need a server write path that does not exist today.
- **Does resume require ID reconciliation? NO — the question disappears.** U25 is a *browser* id-reconciliation problem. A server-authoritative server owns one identity per stored row; the placeholder/replay divergence cannot arise server-side.
- **Does it change current behavior? YES** — requires a frontend transport change (stop sending full history) plus the two new write paths.
- **Capability regression? YES, narrowly** — a storage-only server cannot see a client-produced tool result or approval decision that has not been persisted.
- **U25: easier** (eliminates the class). **U30: harder** (requires new persistence that does not exist).

## Option B — Browser-authoritative + server-enforced

- **Mid-flight approval visibility: PRESERVED.** Unchanged — the decision still arrives in the posted part, and U30's round trip already works.
- **Does it require additional persistence? NO.**
- **Does resume require ID reconciliation? YES, and it already works.** U25's reconciliation is a client concern, unaffected by a server-side budget. The closed U25 finding means B inherits a working mechanism with no new work.
- **Does it change current behavior? NO** — zero frontend change.
- **Capability regression? NO.**
- **U25: unchanged — already correct.** **U30: unchanged — already correct.**
- ⚠️ Consequence: B preserves two behaviors that are correct **only because** of client-side mechanisms (`ai:7551-1552` overwrite, `aiSDKV6FormatAdapter.encode`). Neither is a TBAi-owned guarantee; both are library behaviors that a dependency upgrade could change.

## Option C — Hybrid explicit seam

- **Mid-flight approval visibility: PRESERVED**, and additionally *observable* — the seam can log the decision without inventing storage for it.
- **Does it require additional persistence? NO** for the decision itself. Provenance for injected blocks (2.1c §J) *would* require a storage field, which is a Phase 4 question, not Phase 2.
- **Does resume require ID reconciliation? YES — the same client mechanism, unchanged.** The seam does not touch it.
- **Does it change current behavior? NO frontend change**; adds server-side comparison.
- **Capability regression? NO.**
- **U25: unchanged — already correct.** The seam is a server-side comparison and does not participate in browser id reconciliation.
- **U30: unchanged — already correct**, and the seam can *detect* a stale approval id earlier than the SDK currently does.
- ⚠️ C's one new obligation: a divergence rule must distinguish **expected mid-run transience** (scenario 2) from real divergence. U25's finding helps here — after a resume the posted id **equals** the stored id, so a resume does **not** register as divergence.

---

# Remaining Unknowns

| # | Unknown | Status |
|---|---|---|
| **U26** | Is `experimental_toolApprovalSecret` **verified**, or merely threaded into the SDK? | **STILL OPEN.** Threaded (`ai:5435-5444`, `:6069`, 13 occurrences) but the verification site was not located. Unaffected by this investigation |
| **U31** | Can the client ever POST `trigger: "resume-stream"`? The Zod enum would **400** it | **STILL OPEN.** Currently replaced by the client (`ai:19311-19319`) |
| **U34** | Can two tool parts carry the same `approval.id`? The scan keeps the last write | **NEW — NOT PROVABLE.** Low practical risk; no test |
| **U35** | Can the client skip the resume (never receiving the `start` chunk) while holding a placeholder? | **NEW — narrow.** No such path found; the client's resume entry was not traced line-by-line |
| **U32** | Is Scheduler's absent `toolApproval` intentional? | **STILL OPEN** from 2.1c |
| **U14** | Why is `conversation.systemPrompt` never written? | **STILL OPEN** from 2.1c |
| ~~U25~~ | — | **CLOSED** |
| ~~U30~~ | — | **CLOSED** |

---

# Evidence

| File | Symbol | Lines | Conclusion |
|---|---|---|---|
| `node_modules/ai/dist/index.js` | `makeRequest` | 19191-19197 | Placeholder created with a **new** id even for `resume-stream`; `lastMessage` is `undefined` |
| `node_modules/ai/dist/index.js` | `createStreamingUIMessageState` | 6959-6975 | A fresh `{id: messageId, role:"assistant", parts:[]}` when there is no assistant `lastMessage` |
| **`node_modules/ai/dist/index.js`** | **`start`-chunk handler`** | **7551-7552** | **`state.message.id = chunk.messageId` — the U25 reconciliation point** |
| `node_modules/ai/dist/index.js` | resume branch | 19204-19205, 19141-19149 | Resume reuses `resumeStream`; skips `transport.sendMessages` |
| `node_modules/ai/dist/index.js` | auto-continue | 19311-19319 | Re-POSTs with `trigger: "submit-message"` — **resume origin is replaced** |
| `node_modules/ai/dist/index.js` | `convertToModelMessages` | 11729-11738 | Emits `tool-approval-request` iff **`part.approval != null`** — not run state |
| `node_modules/ai/dist/index.js` | approval scan | 2914-2924 | Scans the **whole messages array**, keyed by `approvalId` |
| `node_modules/ai/dist/index.js` | `processApprovalResponses` | 2937-2941 | ID match; **throws `InvalidToolApprovalError`** on no match |
| **`node_modules/.bun/assistant-cloud@0.2.1/dist/ai-sdk/index.js`** | **`aiSDKV6FormatAdapter`** | **4-15** | **`encode` strips only `id`; `decode` restores it. Every part field survives — the U30 closure** |
| `node_modules/@assistant-ui/ai-sdk/src/runtime/useExternalHistory.ts` | `isReady` / persist | 208-235, 316-330 | Writes on `isRunning` true→false, **plus** an approval-paused row mid-run |
| `web/src/adapters/threadHistoryAdapter.ts` | `withFormat` | 149-213 | **Pure passthrough**; never interprets message internals (`:41-42`) |
| `web/src/adapters/threadHistoryAdapter.ts` | `appendStored` | 66-89 | POSTs `{id, parent_id, format, content}`; throws on non-ok |
| `src/routes/chat.ts` | `resumableContext.run` | 720 | Wraps the response body **from byte 0** ⇒ the replay always includes the `start` chunk |
| `src/routes/chat.ts` | resume handler | 850-897 | `GET`; byte replay; **no** model call, **no** message read |
| `src/routes/chat.ts` | `prepareModelMessages` | 341 | Sole Direct conversion seam |
| `src/routes/chat.ts` | `streamText` | 515-535 | Sole Direct model call; `abortSignal` is the run controller |
| `src/services/chat-streams/historyFinalizer.ts` | `messageExists` | 194 | Existence guard, keyed on message id |
| `src/services/chat-streams/sqliteResumableStore.ts` | `claimHistory` / `record` | 721-774 | Prevents re-finalizing a settled run; captures `final_message_json` |
| `src/services/storage/index.ts` | `upsertStored` | 480-537 | `ON CONFLICT(id) DO UPDATE` — **id is the dedupe key** |
| `src/lib/prune-messages.ts` | Pass 2 | 134-152 | Approval preserved while current; expired by a later user turn |
| `web/package.json` | `assistant-cloud@^0.2.1` | — | Declared dependency (correcting my 2.1c "missing" note) |

---

# Verification

**Tests run — existing only, none created, modified, or deleted:**

| Suite | Result |
|---|---|
| `tests/unit/prune-messages.test.ts` | 15 pass / 0 fail |
| `tests/integration/approval-lifecycle.test.ts` | 8 pass / 0 fail |
| `tests/integration/detached-history-finalization.test.ts` | 26 pass / 0 fail |
| `tests/integration/phantom-assistant-shell.test.ts` | 12 pass / 0 fail |
| `tests/integration/direct-hardening.test.ts` | 20 pass / 0 fail |
| `web/src/features/chat/state/streamRecovery.test.ts` | 30 pass / 0 fail |
| `web/src/features/chat/state/resumable-stream.test.ts` | 4 pass / 0 fail |
| `tests/unit/scheduler.test.ts` | 65 pass / 0 fail |
| **Total** | **180 pass / 0 fail** |

**Manual reproduction traces — both executed, both removed:**

| Probe | Location | Result |
|---|---|---|
| U25 stream shape | `node_modules/ai` real `createUIMessageStream` | First SSE frame is always `{"type":"start","messageId":<original>}` — **7 frames, ordered** |
| U30 round trip | `assistant-cloud@0.2.1` real `aiSDKV6FormatAdapter` | `approval.id`, `requestReason`, `toolCallId`, `state` all identical across encode → JSON → decode |

Both probes were written to a temp directory outside the repo; the U25 probe was
briefly copied into the repo root purely to resolve `ai` from the project's
`node_modules`, and **was deleted immediately after execution**. Verified: no
`tmp-*`, `*probe*`, `.orig`, or `.bak` files remain anywhere in the tree.

**Limitations:**

1. **No live end-to-end reproduction.** A full resume → auto-continue cycle needs a real provider credential and a browser. What is proven are the two previously-unknown links (id overwrite, stream shape); the remaining links are read from code.
2. **The client's resume entry was not traced line-by-line** — `useChatThread.ts:286` `resumeStream()` and the `pendingStreamId` effect were located but not fully walked. U35 remains narrow-open.
3. **U26 is untouched** — the secret's verification site was not searched in this pass.
4. **No test covers either closure.** U25 and U30 are closed by code reading plus two mechanical probes, not by a regression test. A future test would lock them in; creating one was out of scope here.

**No production code, schema, dependency, test, or the roadmap was changed. No commit. No push.**

U25/U30 investigation complete. Phase 2.1d architecture decision remains open.
