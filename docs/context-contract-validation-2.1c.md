# Phase 2.1c — Contract Validation Report

**Status:** Validation only. Nothing implemented, no architecture chosen.
**Inputs:** `docs/context-architecture-audit.md`, `docs/context-assembly-contract-2.1b.md`, Phase 2.1a findings.

---

## A. Validation summary

The 2.1b contract is **substantially sound**. The Direct assembly seam is real, the three layers are genuinely distinct, and 8 of 12 scenarios pass on current behavior.

**One hypothesis is falsified.** U28 (reload-while-paused → approve) was asserted as a reachable defect in 2.1b. It is **not** reachable. The converter emits `tool-approval-request` from the `approval` object, not from live run state, so a reloaded gate re-registers and the ID match succeeds. My 2.1b reasoning was wrong.

**One roadmap guarantee is contradicted.** G13 (resume-triggered auto-continue is distinguishable) is unsatisfiable: the SDK uses three `trigger` values, TBAi's Zod enum accepts two, and **the server reads the field zero times**.

**One mechanism is stronger than 2.1b claimed** and is now the primary replay defense: `convertToModelMessages` → `processApprovalResponses` ID-matching.

| Result | Count |
|---|---|
| Scenarios PASS | 5 |
| Scenarios PARTIAL | 4 |
| Scenarios FAIL | 0 |
| Scenarios UNKNOWN | 3 |
| Guarantees PROVABLE | 6 |
| Guarantees PARTIAL | 4 |
| Guarantees NOT PROVABLE | 2 |
| Guarantees CONTRADICTED | 1 |
| Guarantees FUTURE | 4 |
| Tests | **194 pass / 0 fail**, 10 suites, none modified |

---

## B. Direct request-path validation

Traced end to end.

```text
POST /api/chat                                            chat.ts:148
  → chatRequestSchema.safeParse (Zod, .strict())           chat.ts:152 / validation.ts:35-53
  → engine guard (conversationService.get)                 chat.ts:179-189
  → directive refusal: system|tools|callSettings|config    chat.ts:191-201
  → resolveChatModel                                       chat.ts:205-224
  → credential check                                       chat.ts:226-237
  → safeValidateUIMessages                                 chat.ts:239-260
  → chatRuns.create (run-owned AbortController)            chat.ts:290-296
  → resolveConversationWorkspace                            chat.ts:302
  → tool assembly                                          chat.ts:321-332
  → buildToolsContext                                      chat.ts:333-340
  → prepareModelMessages(messages, tools, {threadId})      chat.ts:341   ← SEAM
       ├─ pruneStaleMessages                               model-messages.ts:19
       └─ convertToModelMessages                           model-messages.ts:38-41
  → streamText<NativeToolSet>({                            chat.ts:515
        messages, instructions?, tools, toolsContext, ... })
```

**Is `chat.ts:341` the correct single Direct seam? YES — proven, not assumed.**

| Check | Evidence |
|---|---|
| Any Direct path bypasses it? | **No.** `prepareModelMessages` has exactly 2 call sites: `model-messages.ts:14` (definition) and `chat.ts:341`. No other caller exists in `src/` or `web/src/`. |
| Any second Direct `streamText`? | **No.** Exhaustive: `chat.ts:515` (Direct), `schedulerExecution.ts:344` (Scheduler, separate), `ai.test.ts:159` (test). |
| Does anything mutate context after `prepareModelMessages`? | **No.** `modelMessages` is assigned once at `:341`, declared at `:319`, and read only at `:517`. No reassignment, no in-place mutation. |
| Do the three layers stay distinct at `streamText`? | **YES.** `instructions` (`:520`, conditional spread), `tools` (`:521`), `messages` (`:517`) are three separate properties of one call. `instructions` is **absent** when `conversation.systemPrompt` is falsy. |

**Verdict: the seam is correctly identified and correctly documented.**

⚠️ One nuance worth recording: `instructions` is **conditionally omitted** (`:520`), not defaulted. A conversation with no system prompt produces a request with *no* Layer A at all. Any Layer A budget/counting logic must tolerate absence.

---

## C. Twelve-scenario validation matrix

| # | Scenario | Status | Evidence | Contract impact |
|---|---|---|---|---|
| 1 | Normal Direct request | **PASS** | Context source = posted `messages` (`chat.ts:260`); assembly `:341`; A/B server-owned (`:191-201`, `:520`, `:321-332`); persistence at settle via `useExternalHistory.ts:224-235` | Contract holds as written |
| 2 | Auto-continue after tool output | **PASS** | `addToolOutput` → `ai:19041-19052` → `makeRequest({trigger:"submit-message"})` → `transport.sendMessages({messages: this.state.messages})` (`ai:19207-19216`) → `runtime.ts:425` `messages`. State is mutated in-memory at `ai:19034` `replaceMessage` | Layer C is legitimately mid-run-divergent; a divergence check must allow this |
| 3 | Auto-continue after approval response | **PASS** | `ai:19011-19022` → same POST. Approval part carries `part.approval.{id,approved}`; converter emits request (`ai:11729-11738`) + response. Second model call occurs | Scenario 3 is exercised by `approval-lifecycle` (8 tests) |
| 4 | Detached completion | **PASS** | `monitorStream.cancel()` `chat.ts:801-829` → `markDetached` (`chat-runs.ts:184-190`, sets `detachedAt`, does NOT abort). Run continues on `run.controller.signal` (`:533-535`). Persistence at `:679-686` → `historyFinalizer.ts:204-209` → `upsertStored`. **No second assembly** — the finalizer writes a message, it does not call `prepareModelMessages` | G12 holds. Covered by `detached-history-finalization` (26 tests) |
| 5 | Resume without auto-continue | **PASS** | `chat.ts:850-897` is `GET`; contains no `streamText`, no `prepareModelMessages`, no `messageService` read. Replays `chat_stream_chunks` (`sqliteResumableStore.ts:933-969`) | G5/§5 of contract holds: byte replay only |
| 6 | Resume → auto-continue | **UNKNOWN** | See §H. Resume creates a placeholder with a **new** id (`ai:19194 this.generateId()`) while `lastMessage` is `undefined` (`:19193`); the replayed bytes carry the **original** run's id. The reconciliation between them was **not traced to a conclusion** | Blocks any claim about duplicate rows. See §H |
| 7 | Approval pause | **PASS** | `isReady = isTerminal \|\| (isAwaitingToolCalls && adapter.update !== undefined)` (`useExternalHistory.ts:322-324`); TBAi supplies `update` (`threadHistoryAdapter.ts:164-166`) → paused row IS persisted mid-run. `lifecycleOf` → `"approval"` (`prune-messages.ts:52`) → survives pruning | The one mid-run state with a valid reason to exist in history. Confirmed |
| 8 | Reload while paused → approve | **PARTIAL** | **U28 FALSIFIED** — see §G. Converter emits `tool-approval-request` from `part.approval != null` (`ai:11729-11738`), **not** from live run state. Remaining gap: whether `approval` survives the storage round-trip | §6 of the contract is correct; my 2.1b warning was wrong |
| 9 | Browser vs SQLite mismatch | **PARTIAL** | Two states coexist routinely (scenario 2). `/api/conversations/reconcile` is `existsMany` → `SELECT id` (`conversations.ts:249-266`, `storage/index.ts:280-297`) — **existence only**. No content comparison anywhere. `hasStoredMessage` is `SELECT id` (`storage/index.ts:436-443`) | G8 is unimplemented. Detectable in principle; **not** implemented |
| 10 | Persisted ordering | **PASS** | `order_seq` server-assigned: existing value preserved on conflict, else `MAX(order_seq)+1` (`storage/index.ts:485-494`). Read order `order_seq ASC, created_at ASC` (`:515`). Client sends only `{id,parent_id,format,content}` — **cannot influence sequence** | Ordering is server-defined. **Branch topology is separate** — see §K |
| 11 | Malformed/incomplete tool lifecycle | **PASS** | `prune-messages.ts`: `lifecycleOf` `:44-54`; Pass 2 `:134-152` keeps last `"output"`, drops `"incomplete"` `:151`, expires approvals at a later user turn `:142-148`. `ignoreIncompleteToolCalls: true` (`model-messages.ts:40`) filters again (`ai:11610-11617`) | Lifecycle protections intact. 15 tests pin this |
| 12 | Server-owned injection | **PARTIAL** | Client `system` → 400 (`:252-258`); `tools`/`callSettings`/`config` → 400 (`:191-201`); tools server-built (`:321-332`); provider server-resolved (`:205-224`); `systemPrompt` from server state (`:520`). `.strict()` (`:53`) rejects unknown envelope keys. ⚠️ **But `messages` elements are `z.unknown()`** (`validation.ts:41`) | G4 holds at the envelope, **not** at message content. See §C.1 |

### C.1 G4 limitation — stated exactly

**What is protected:** the envelope is `.strict()` (`validation.ts:53`), so an unknown top-level key is a validation failure. The four server-owned directive fields are explicitly checked and rejected (`chat.ts:191-201`). `system` inside `messages` is rejected post-parse (`:252-258`).

**What is not protected:** `messages: z.array(z.unknown()).min(1)` (`validation.ts:41`) — **elements are opaque and uninterpreted** by the Zod layer. `safeValidateUIMessages` (`chat.ts:239-242`) applies UI-message structural rules, but:

- there is **no `.max()`** — array length is unbounded;
- part *content* is not schema-constrained at the envelope layer;
- `chatMessageMetadataSchema` is deliberately opaque (`validation.ts:4-8`: *"Message metadata is intentionally opaque to the Direct route"*).

So: **the envelope is closed, the payload is open.** A client can post arbitrarily many arbitrarily large messages, and arbitrarily shaped parts, within the UI-message structural rules.

---

## D. Seventeen-guarantee validation matrix

| # | Guarantee | Status | Evidence | Required treatment in 2.1d |
|---|---|---|---|---|
| 1 | Single Direct assembly path | **PROVABLE** | `prepareModelMessages` has one call site, `chat.ts:341`; one Direct `streamText`, `:515` | Record as an invariant to preserve, not to create |
| 2 | Server-owned instructions | **PROVABLE** | `:252-258` (400), `:520` (server value) | Note Layer A is *conditionally absent* |
| 3 | Server-owned tool definitions | **PROVABLE** | `:191-201` (400), `:321-332` (server build) | — |
| 4 | Provider/model cannot inject request structure | **PARTIAL** | `.strict()` `validation.ts:53`; resolution `chat.ts:205-224`. But `messages` elements `z.unknown()` (`validation.ts:41`) | ⚠️ Must be restated as "envelope closed, payload open" or 2.1d inherits an overstated guarantee |
| 5 | Tool pairing validated before conversion | **PROVABLE** | `prune-messages.ts:134-152`; `ai:11610-11617` | — |
| 6 | Approval state resolved by explicit rule | **PROVABLE** | Rule 1: converter emits request from `part.approval` (`ai:11729-11738`). Rule 2: `processApprovalResponses` ID-match, throws `InvalidToolApprovalError` (`ai:2937-2941`). Rule 3: pruner expiry (`prune-messages.ts:142-148`) | **Upgrade this to the primary defense** — see §G |
| 7 | Deterministic ordering, server-defined where persisted ordering applies | **PARTIAL** | `order_seq` server-assigned (`storage/index.ts:485-494`) and read order server-defined (`:515`) — **PROVABLE**. **Layer B (MCP tool order) NOT deterministic** — `getAiTools` iterates `this.connections` (`manager.ts:1027-1061`) | 2.1d must split: "persisted ordering deterministic (provable)" vs "tool ordering deterministic (Phase 2.4 requirement, not today)" |
| 8 | Context mutations observable/loggable | **PARTIAL** | Prune + approval events logged (`model-messages.ts:23-36`); `chat_request_received` (`chat.ts:359`). **No divergence logging exists** | 2.1d must scope whether G8 means "assembly is logged" (satisfied) or "divergence is logged" (unimplemented) |
| 9 | Future server-side budget enforcement | **FUTURE** | Not implemented. `validation.ts:41` has no `.max()`; `streamText` (`chat.ts:515-630`) sets no output reservation | Phase 2.3. Not a defect in this phase |
| 10 | No later phase bypasses the seam | **FUTURE** | Architectural rule; no code enforces it | Must be a review gate, not a code guarantee |
| 11 | Current user turn identifiable | **NOT PROVABLE** | Today inferred from array position only. `chatRequestSchema` has `messageId` (`validation.ts:43`) but **`chat.ts` never reads it** | 2.1d must decide the identification mechanism. `messageId` is an unused hook |
| 12 | Detached execution ≠ new client request | **PROVABLE** | A detached run has no client to post (`chat.ts:679-686` is the only writer for that case); `markDetached` does not abort (`chat-runs.ts:184-190`) | — |
| 13 | Resume-triggered auto-continue is a fresh request | **CONTRADICTED** | `trigger` enum = 2 values (`validation.ts:42`); SDK uses 3 (`ai:19193`, `:19204`, `:19141` including `"resume-stream"`); **server reads it zero times**; resume **replaces** trigger with `"submit-message"` (`ai:19311-19319`) | ⚠️ **Must be rewritten or rescoped.** See §E |
| 14 | Compaction through the same contract | **FUTURE** | No compaction exists (Phase 4) | Phase 4 |
| 15 | Memory through the same budgeted contract | **FUTURE** | `memories` service exists (`storage/index.ts:580-603`) but is never read on the chat path | Phase 5 |
| 16 | Tool/MCP reduction before serialization | **FUTURE** | `BoundedBody` is render-only (`web/src/tools/body-budget.tsx:80`); `mcpContentToText` takes no length (`manager.ts:1281-1295`) | Phase 2.5 |
| 17 | Lifecycle repair distinct from size management | **PROVABLE** | `prune-messages.ts` contains no size logic — search for `token\|length\|char\|size\|limit\|budget\|max` returns only `parts.length` (array length) and prose | **Must be preserved as a hard boundary** — 15 tests depend on it |

**Summary: 6 PROVABLE · 4 PARTIAL · 2 NOT PROVABLE · 1 CONTRADICTED · 4 FUTURE.**

⚠️ **The four FUTURE entries are not defects.** They name work owned by Phases 2.3, 2.5, 4, and 5. Listing them as failures would misstate the contract's scope.

---

## E. Q2 — trigger semantics

### Current definition and every consumer

| Where | Value(s) |
|---|---|
| `validation.ts:42` | `z.enum(["submit-message", "regenerate-message"]).optional()` — **2 values** |
| `ai:19129,19141,19193,19204,18980` | `"resume-stream"` — **a 3rd value the Zod enum does not accept** |
| `ai:19016,19046,19311-19319` | `"submit-message"` (re-emitted on every auto-continue) |
| `chat.ts` | **zero reads.** grep for `trigger` in `src/routes/chat.ts` → no matches |
| `runtime.ts:327,374,392,426` | Client-side: passes it through, and **does** distinguish one value — `:374` `trigger === "regenerate-message" && hasPendingPick` |

**Does any code distinguish values today?** Only the **client**, and only to
recover a one-shot model-picker override (`runtime.ts:374`). The **server**
distinguishes nothing.

**Does resume preserve or replace the trigger?** ⚠️ **Replaces.** `ai:18980` enters
with `trigger: "resume-stream"`; `ai:19311-19319` then calls
`makeRequest({ trigger: "submit-message", ... })`. The resume origin is **destroyed
before the second request leaves the client**.

**Exactly what information is lost today:**
1. Whether a request originated from a user action, a regeneration, or a resume cascade.
2. Whether a request is a *continuation* (auto-continue) or a *first* send.
3. Whether a run is being resumed at all — the server learns this only because the client separately calls `GET /api/chat/resume/:streamId`, and nothing correlates that with the subsequent POST.

⚠️ **`"resume-stream"` would be rejected by the Zod enum if it ever arrived.** It does not arrive, because the client replaces it — but this means the enum and the SDK are already out of sync, and any future SDK that forwards the original trigger would produce a **400**.

### Smallest viable formulations for 2.1d

Not a decision — three options for the maintainer.

| # | Formulation | Cost | Residual gap |
|---|---|---|---|
| **Q2-a** | **Extend the enum** with `"resume-cascade"` (or `"continuation"`); client sets it; server branches on it | Requires a frontend change (2 lines in `runtime.ts`) + schema | Still cannot see *why* a run was resumed; relies on client honesty |
| **Q2-b** | **Server/run-state derivation** — ignore `trigger`; the server knows a `streamId` exists and can check `chatRuns` / `chat_streams` for a prior unsettled or resumable run | Zero frontend change | Requires the POST to carry a stream/conversation correlation the server can resolve; does not work after a process restart |
| **Q2-c** | **Redefine the guarantee** — drop "distinguishable by trigger"; require only that a resume cascade is *treated as* a fresh Direct request (which it already is), and that resume-origin is observable via the existing `GET /api/chat/resume` audit log | Zero change | The server cannot tell a cascade from a user send in the POST itself |

⚠️ **Q2-c is the only formulation satisfied by today's code.** Q2-a and Q2-b both
require work. If 2.1d picks A or C, Q2-b is the natural fit (the server already
reads storage). If it picks B, Q2-c or Q2-a are the only options.

---

## F. Q10 — async/sync contract

Determined from what the contract must eventually consume, not from style.

| Requirement | Async? | Evidence |
|---|---|---|
| **SQLite — retained history** | **FORCES ASYNC** | `listThreadMessages` is `async` (`storage/index.ts:544`); also `getThreadTip` `:419`, `hasStoredMessage` `:436`, `upsertStored` `:480` |
| **SQLite — reconciliation / divergence check** | **FORCES ASYNC** | Requires the same reads plus a comparison |
| **Memory retrieval (Phase 5)** | **FORCES ASYNC** | `memories.list()` is `async` (`storage/index.ts:580`) |
| **Model metadata / context limit (Phase 2.3)** | **FORCES ASYNC** | `discoverModels` is `async` with a network fetch (`modelDiscovery.ts:158`, `fetchJson` `:21`); `contextWindow` from `max_input_tokens` (`:131`) |
| **Compaction (Phase 4)** | **FORCES ASYNC** | Reads + writes history; regenerates a summary via a model call |
| **Tool/MCP normalization** | does **NOT** force async | `getAiTools` is **synchronous** — `manager.ts:1027` `getAiTools(requestSignal?): Record<string, any>` |
| **Token measurement** | does **NOT** force async | Pure computation over an in-memory `ModelMessage[]` |
| **Lifecycle repair** | does **NOT** force async | `pruneStaleMessages` is synchronous |
| **`convertToModelMessages`** | already async-capable | `createToolModelOutput` is awaited at `ai:11745` |

**Verdict: async is forced by 5 of 7 requirements — and the two that don't force
it (MCP normalization, token measurement) are the ones earliest in the pipeline.**

⚠️ **The decisive practical fact: `prepareModelMessages` is *already* `async`**
(`model-messages.ts:14`). Making `assembleContext` async is therefore a
**non-breaking change** at the call site (`chat.ts:341` already awaits). Option B
— keeping it synchronous — would require either a pre-fetched history handle
passed in, or giving up the SQLite/memory/metadata requirements.

**Recommendation-shaped, not a decision:** async is the only formulation
compatible with the full contract. Whether it *blocks on SQLite* is precisely
what distinguishes A and C from B — and that is the 2.1d question, not a Q10
question.

---

## G. Approval / reload — U28 findings

### The hypothesis is falsified

2.1b §6 asserted: *"reload while paused, then approve — would reach `ai:2937`
with no matching request."*

**That is wrong.** The mechanism is not live run state. It is the messages array:

```js
// convertToModelMessages — ai/dist/index.js:11729-11738
if (part.approval != null) {
  content.push({
    type: "tool-approval-request",
    approvalId: part.approval.id,
    toolCallId: part.toolCallId,
    isAutomatic: part.approval.isAutomatic,
    ...(part.approval.requestReason != null ? { reason: ... } : {}),
    ...(part.approval.signature != null ? { signature: ... } : {}),
  });
}
```

**The guard is `part.approval != null` — NOT `state === "approval-requested"`
and NOT "this run emitted it."** Any tool UI part carrying an `approval` object
emits a `tool-approval-request`, whether it came from a live stream 200 ms ago or
from a row loaded at startup.

And the consumer scans the whole array, not the current turn:

```js
// ai:2914-2924  (inside a function over `messages`)
for (const message of messages) {
  if (message.role === "assistant" && typeof message.content !== "string") {
    for (const part of message.content) {
      if (part.type === "tool-approval-request") {
        toolApprovalRequestsByApprovalId[part.approvalId] = part;   // :2920
      }
    }
  }
}
```

So the reload path is:

```text
reload → SQLite row carries the tool part with `approval: {id, ...}`
       → loaded into runtime → user approves → part becomes approval-responded
       → POST /api/chat → convertToModelMessages
       → emits BOTH tool-call (:11721) AND tool-approval-request (:11731) from the same part
       → SDK scan (:2915-2924) finds the request
       → ID match (:2937) SUCCEEDS
       → approval honored
```

⚠️ **The one remaining unverified link:** whether the `approval` object survives
the **storage round-trip** (assistant-ui storage format encode → SQLite → decode).
Evidence that it does: `toStoredMessageContent` (`historyFinalizer.ts:113-116`) is
`const { id: _id, ...content } = message` — a structural copy, so `approval`
travels with the part; and 2.1a confirmed stored content carries `state` and
`output` verbatim. But the **client-side** encode/decode in
`threadHistoryAdapter.ts` was not read line-by-line in this pass.

**Scenario 8 status: PARTIAL** — the mechanism is sound; one storage link
remains INFERRED.

### The strongest replay defense is not the one 2.1b led with

2.1b presented three mechanisms and ranked the pruner's expiry first. Evidence
reorders them:

| Rank | Mechanism | Evidence | Strength |
|---|---|---|---|
| **1** | **ID match against requests in the request array** | `ai:2937-2941` — throws `InvalidToolApprovalError` on no match | **Strongest.** Fails closed, and it is a *type-level* invariant, not a heuristic |
| 2 | Pruner expiry at a later user turn | `prune-messages.ts:142-148` | Real, but a policy decision — a bug elsewhere could defeat it |
| 3 | Per-run secret | `chat.ts:524`, `:264` | ⚠️ **Weakest of the three.** Threaded into the SDK (`ai:5435-5444`, `:6069`, 13 occurrences) but **the verification site was not located** — U26 remains open |

⚠️ **G6 should be rewritten to lead with mechanism 1.** A stale `approvalId` from
an earlier run finds no matching request and throws. That is a harder guarantee
than the pruner's rule.

### Unresolved policy (unchanged from 2.1b)

1. Does an approval-paused turn consume budget as a full turn or a reserved slot?
2. May a paused turn be a compaction boundary (Phase 4)?
3. ⚠️ **New, and narrower than the falsified U28:** if the `approval` object does
   *not* survive the storage round-trip, the reload path degrades to the failure
   I hypothesised. **Verify the round-trip before relying on it.**

---

## H. Resume / duplicate-state — U25 findings

**Not resolved. Both halves are partial, and the repository does not settle it.**

### What is proven

```js
// ai:19191-19197
const response = {
  state: createStreamingUIMessageState({
    lastMessage: trigger === "resume-stream" || trigger === "regenerate-message"
      ? void 0                                    // :19193  → no snapshot
      : this.state.snapshot(lastMessage),
    messageId: this.generateId()                  // :19194  → NEW id, always
  }),
  abortController
};
```

⚠️ **`this.generateId()` runs unconditionally — including for `resume-stream`.** So
a resume **does** mint a new assistant message id, while `lastMessage` is
`undefined`.

Meanwhile the replayed bytes are the **original** run's recorded stream
(`chat_stream_chunks`, `sqliteResumableStore.ts:933-969`), so any message id
inside them is the **original** run's id.

**Therefore two ids exist in play during a resume**: the fresh placeholder
(`ai:19194`) and the original (inside the replayed bytes). **Which one survives
was not traced.**

### Double-write protection (server side) — proven

Two independent guards, both verified:

| Guard | Evidence | Effect |
|---|---|---|
| `claimHistory` | `sqliteResumableStore.ts:721-734`; store refuses a non-completed claim (`:730`) | The reconciler cannot re-finalize a run the client already settled |
| `messageExists` | `historyFinalizer.ts:194` → `hasStoredMessage` → `SELECT id` (`storage/index.ts:436-443`) | Server write is skipped if the row already exists. Rationale at `historyFinalizer.ts:88-98`: not to `ON CONFLICT DO UPDATE`-overwrite a reply the client legitimately wrote |

⚠️ **`messageExists` is keyed on the message id.** So whether it prevents a
duplicate depends entirely on **which id** the reconciler's captured
`final_message_json` carries — and that is the original run's id, while the
client's post after resume would carry the *new* id if the placeholder survived.
⚠️ **In that case the guard would not match, and two rows could be written.**

### The unanswered question

Does `useExternalHistory` persist the placeholder or the replayed message?
Its dedupe is `persistedInnerMessages.current.get(innerId)` keyed on the inner
message id (`useExternalHistory.ts:340`), and `historyIds` tracks message ids
(`:332-334`). If the two ids differ, **two appends occur.**

**U25 remains UNKNOWN.** It requires either a traced reconciliation path in
`processUIMessageStream` or a live reproduction. **2.1d must treat it as an open
risk, not a resolved one.**

---

## I. Scheduler boundary findings

All five claims from the brief: **confirmed.**

| Claim | Evidence |
|---|---|
| Does not use `prepareModelMessages` | `schedulerExecution.ts` imports `streamText, stepCountIs, tool, type UIMessage` (`:13`) — **no** `prepareModelMessages` import |
| Does not use the Direct pruner | No `pruneStaleMessages` import; no `prune-messages` reference in the file |
| No historical context assembly | `messages: [{ role: "user", content: fullPrompt }]` (`:346`) — a single synthetic user message, built fresh |
| Separate step limit | `stopWhen: stepCountIs(10)` (`:348`) vs Direct's `stepCountIs(20)` (`chat.ts:523`) |
| No Direct approval handling | No `toolApproval` in the `streamText` call (`:344-349`) — gated tools are **unavailable** to unattended runs |

It reads `getThreadTip` (`:333`) for **parent derivation only**, and writes via
`upsertStored` (`:338`, `:357`, `:412`). It shares only `getModel` + `streamText`
(`:344`) with Direct — **the context path is entirely separate.**

### Can the contract remain Direct-only without contradiction?

**Yes — with one condition.** The contract's input is the *posted envelope*
(§1.2 of 2.1b), which Scheduler does not have: it is unattended, so there is no
posted `messages` array. Sharing the abstraction would require a **second input
adapter** (`jobId` + stored history, no posted messages).

⚠️ **The condition:** a Direct-only `assembleContext` must not be described as
"the context boundary" in general terms. If any later phase (4, 5) needs
unattended context — scheduled jobs that reason over a conversation — the
Direct-only scope becomes a gap rather than a deferral.

⚠️ **Scheduler's absent `toolApproval` is worth confirming as intentional.** A
scheduled job that reaches a gated tool has no approval path at all. That is
arguably correct for unattended execution, but it is currently undocumented.

**No Scheduler changes made. No redesign attempted.**

---

## J. Provenance / compaction implications

Assessed against the 2.1b contract **without implementing anything.** OpenChamber
is used only for the previously-established invariant, not its mechanism.

| Requirement | Does the 2.1b contract leave a place? | Evidence |
|---|---|---|
| **Retained-history provenance** | ⚠️ **Partially.** The contract requires "provenance attached to each layer" (§1.3) but does not define *what* provenance is | The returned structure is unspecified; this is a design gap, not a structural one |
| **Injected-context provenance** | ⚠️ **Yes, structurally.** Injected blocks enter as Layer C content under server control; the contract's Layer A/B/C separation gives them a named home | 2.1b §1.2 assigns Layer C to the contested authority — an injected block's authority is well-defined even when history's is not |
| **Compaction boundaries** | ✅ **Yes.** Compaction is a mutation of retained history, which is Layer C — the layer the contract already owns | — |
| **Memory provenance** | ✅ **Yes, structurally.** Same as injected context: a server-produced Layer C block with a known origin | Phase 5 |
| **Deterministic insertion order** | ⚠️ **Not for Layer B today.** `getAiTools` iterates `this.connections` (`manager.ts:1027-1061`) — insertion order is connection-dependent | Must be fixed in Phase 2.4 regardless |
| **Surviving metadata after reload/resume** | ❌ **No place today.** A reload reconstructs from `content` JSON only; nothing in the stored shape records "this block was injected at turn N by source S" | `toStoredMessageContent` (`historyFinalizer.ts:113-116`) copies the message verbatim — **it has no field for injected-block origin** |

### The invariant, restated

> **After compaction, the system must know which externally-injected context is still present.**

⚠️ **TBAi currently satisfies this only trivially**, because no externally-injected
context exists yet — the system prompt is unpopulated (Phase 1 §1.4) and memory
never reaches the chat path. **The invariant is untested by current behavior
because there is nothing yet to invalidate.**

**Consequence for 2.1d:** the contract needs a **provenance carrier** in the
returned structure, and the storage shape needs somewhere to persist it, or
Phase 4 and Phase 5 will each have to invent one. ⚠️ **Adding a storage field is
outside Phase 2 scope** and would be a schema change — so 2.1d should record
this as a *Phase 4 prerequisite*, not a Phase 2 deliverable.

**Not implemented. No provenance mechanism proposed.**

---

## K. Contradictions found

| # | Source | Claim | Status |
|---|---|---|---|
| **1** | **2.1b §6 (mine)** | Reload-while-paused then approve reaches `ai:2937` with no matching request | ❌ **FALSIFIED.** The converter emits `tool-approval-request` from `part.approval != null` (`ai:11729-11738`), so a reloaded gate re-registers. I incorrectly assumed live run state |
| **2** | 2.1b §5 (mine) | The pruner's expiry is the primary approval-replay defense | ⚠️ **REORDERED.** The ID match (`ai:2937-2941`) is stronger — it fails closed and is type-level |
| **3** | 2.1b §5 (mine) | Three mechanisms "roughly equal" | ⚠️ The per-run secret is the **weakest** — threaded (`ai:5435-5444`) but its verification site is unlocated (U26 open) |
| **4** | Roadmap G13 | Resume-triggered auto-continue is identifiable | ❌ **CONTRADICTED.** Enum has 2 values, SDK uses 3, server reads 0, resume **replaces** the value (`ai:19311-19319`) |
| **5** | Roadmap §2.4 / G7 | "Server-defined ordering (never client-defined)" for Layer C | ⚠️ **OVERSOLD.** True of `order_seq`; **false of `parent_id`**, which the client supplies (`chat.ts:658`) |
| **6** | 2.1b §3 (G4) | Provider/model cannot inject request structure | ⚠️ **IMPRECISE.** Envelope is `.strict()`; `messages` elements are `z.unknown()` with no `.max()` |
| **7** | Phase 1 F11 | Truncated streaming row enters later context | ⚠️ **Superseded** by 2.1a: the real mid-run write is the approval-paused row. Guard correct, stated trigger wrong |
| **8** | `message-persistence-policy.ts:4` | Client persists at run **start** | ❌ Already contradicted in 2.1a — library writes on `isRunning` true→false |

**Nothing in 2.1b's structural analysis was falsified.** The seam, the three
layers, the server-ownership guarantees, and the tool-lifecycle protections all
held.

---

## L. Remaining UNKNOWNs

| # | Unknown | Why it matters | How to resolve |
|---|---|---|---|
| **U25** | Can a resume cascade produce two assistant rows? | The `messageExists` guard is id-keyed; if the placeholder id and the replayed id differ, the guard misses | Trace `processUIMessageStream` id reconciliation, or reproduce live |
| **U26** | Is `experimental_toolApprovalSecret` *verified*, not merely present? | Determines whether the third replay mechanism has any force | Locate the verification site in `ai/dist` |
| **U30** | Does `approval` survive the assistant-ui storage round-trip? | ⚠️ **The single link between the falsified U28 and a real defect** | Read `threadHistoryAdapter.ts` encode/decode; or a store→load→convert test |
| **U31** | Does the client ever POST `trigger: "resume-stream"`? | The Zod enum would **400** it | Confirm the SDK never forwards it (currently replaced) |
| **U32** | Is Scheduler's absent `toolApproval` intentional? | An unattended run reaching a gated tool has no path | Confirm with the maintainer |
| **U14** | Why is `conversation.systemPrompt` never written? | Layer A is empty in practice, so any Layer A budgeting is untested | Trace the writer; none exists in `web/src` |
| **U33** | `messageId` (`validation.ts:43`) is accepted and never read | It is the natural hook for G11 (current-turn identification) | Decide whether 2.1d adopts it |

---

## M. Tests run and results

**Existing suites only. None created, modified, or deleted.**

| Suite | Result | Covers |
|---|---|---|
| `tests/unit/prune-messages.test.ts` | **15 pass / 0 fail** | Lifecycle repair, G17 |
| `tests/integration/approval-lifecycle.test.ts` | **8 pass / 0 fail** | Scenario 3, G6 |
| `tests/integration/phantom-assistant-shell.test.ts` | **12 pass / 0 fail** | Contentless-shell guard |
| `tests/integration/detached-history-finalization.test.ts` | **26 pass / 0 fail** | Scenario 4, G12 |
| `tests/unit/scheduler.test.ts` | **65 pass / 0 fail** | Scheduler boundary |
| `web/src/features/chat/state/streamRecovery.test.ts` | **30 pass / 0 fail** | Resume/recovery client logic |
| `tests/integration/direct-hardening.test.ts` | **20 pass / 0 fail** | Direct route hardening (located this pass) |
| `web/src/features/chat/state/resumable-stream.test.ts` | **4 pass / 0 fail** | Resume stream pointer (located this pass) |
| `web/src/lib/transport-errors.test.ts` | **7 pass / 0 fail** | Transport error paths (located this pass) |
| `web/src/components/ChatWindow.blocks.test.ts` | **7 pass / 0 fail** | `requires-action` rendering (located this pass) |
| **TOTAL** | **194 pass / 0 fail** | — |

**No test covers:** auto-continue message content (scenario 2), browser/SQLite
divergence (scenario 9), `order_seq` assignment (scenario 10), or the approval
storage round-trip (U30).

---

## N. Exact inputs 2.1d must use

**Decision inputs, with evidence:**

1. **The seam is real and singular** — `chat.ts:341` is the sole
   `prepareModelMessages` call; `chat.ts:515` the sole Direct `streamText`.
   No Direct path bypasses it; nothing mutates context after it.
2. **Option A's mid-flight gap is the decisive fact** — the server holds no copy
   of a client-produced tool result (`ai:19034` `replaceMessage`, in-memory only)
   or approval decision (no server-side store, no endpoint) until the client
   persists. A storage-authoritative server **would not know they exist**.
3. **Auto-continue is legitimately divergent** (scenario 2) — a
   stored-vs-posted comparison must treat mid-run state as expected, not as
   divergence. This constrains Option C's fallback rule.
4. **Ordering is server-defined; branch topology is not** — `order_seq`
   server-assigned (`storage/index.ts:485-494`); `parent_id` client-supplied
   (`chat.ts:658`). Do not collapse these.
5. **Scheduler is a separate path** with no posted history, a different step cap,
   and no approval model. Direct-only scope is viable but must be recorded as a
   boundary, not left implicit.
6. **Q10 is settled by evidence, not style** — async is forced by SQLite, memory,
   model metadata, reconciliation, and compaction; and `prepareModelMessages` is
   **already async**, so it is a non-breaking change.
7. **Q2 is unresolved and shapes the contract** — three formulations offered; only
   Q2-c is satisfied by today's code.

**Guarantees 2.1d must restate (currently inaccurate):**

| Guarantee | Restate as |
|---|---|
| G4 | "Request **envelope** is closed (`.strict()`); message **payload** is open (`z.unknown()`, no `.max()`)" |
| G6 | Lead with the **ID match** (`ai:2937`), not the pruner's expiry rule |
| G7 | Split: "persisted ordering deterministic (provable)" vs "tool ordering deterministic (Phase 2.4 requirement)" |
| G13 | ⚠️ **Not satisfiable as written.** Choose Q2-a, Q2-b, or Q2-c — or defer explicitly |
| G11 | Currently unprovable; `messageId` (`validation.ts:43`) is an unused hook |

**Open risks 2.1d must record, not resolve:** U25 (resume duplicate rows), U30
(approval storage round-trip), U26 (secret verification), and the provenance
carrier gap (J) — which is a **Phase 4 prerequisite**, not a Phase 2 deliverable,
because it would require a storage change outside Phase 2's scope.

---

Phase 2.1c validation complete. Architecture decision remains open for Phase 2.1d.
