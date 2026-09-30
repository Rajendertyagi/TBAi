# Phase 2.1b — Context Assembly Contract (Design)

**Status:** Design / investigation. Nothing implemented.
**Inputs:** `docs/context-architecture-audit.md` (Phase 1), Phase 2.1a ownership validation.
**Scope:** Direct AI engine. No architecture chosen — that is 2.1d.

---

## 0. Evidence base

Verified by read-only inspection in this pass or carried from 2.1a with its citation.

| Fact | Evidence |
|---|---|
| Envelope schema is `.strict()` | `src/lib/validation.ts:53` — unknown top-level keys are rejected |
| `messages` is `z.array(z.unknown()).min(1)` | `validation.ts:41` — **no `.max()`, elements opaque** |
| `trigger` is **accepted and validated** | `validation.ts:42` `z.enum(["submit-message","regenerate-message"]).optional()` |
| **`trigger` is never read server-side** | grep of `src/routes/chat.ts` → **zero** matches for `trigger` |
| Direct has exactly one model call | `chat.ts:515` `streamText<NativeToolSet>` — the only one in `src/` outside the scheduler |
| Tools assembled server-side | `chat.ts:321-332` |
| Instructions server-owned, conditionally present | `chat.ts:520` |
| `prepareModelMessages` is the conversion seam | `chat.ts:341` → `model-messages.ts:14` |
| `prepareModelMessages` reads no storage | `model-messages.ts` imports only `ai`, `prune-messages`, `logger`; `threadId` used for log correlation only (`:25,:32`) |
| Ordering is server-defined | `storage/index.ts:515` `ORDER BY order_seq ASC, created_at ASC`; `order_seq` assigned by `upsertStored` (`:485-494`) |
| `parent_id` **is** client-supplied | `validation.ts` stored-message envelope; `chat.ts:658` derives it from in-memory branch state |
| Single message write method | `messageService.upsertStored` (`storage/index.ts:480-537`) |
| No content reconciliation | `/api/conversations/reconcile` (`conversations.ts:249-266`) is `existsMany` — `SELECT id` only |
| Approval map is static, no endpoint | `chat.ts:525-532`; `src/routes/` has no approval route |
| `toolApprovalSecret` is threaded into the SDK | `ai/dist/index.js:5435-5444`, `:6069` (`secret:`), 13 occurrences |
| Approval responses are ID-matched | `ai/dist/index.js:2914-2937` (`toolApprovalRequestsByApprovalId[approvalId]`) |
| Scheduler is a separate context path | `schedulerExecution.ts:344-349`; `:346` `messages: [{role:"user",content:fullPrompt}]` |

**156 existing tests pass, 0 fail** (suites listed in §10).

---

## 1. The assembly boundary

### 1.1 Definition

`assembleContext(...)` is **the single function that produces the three model-request layers for one Direct run.** It is not a "context manager", not a cache, and not a pruner. Its output is the input to `streamText`.

It sits at the convergence point of the three layers, which today happens to be split across `chat.ts:341` (Layer C) and `chat.ts:515-521` (Layers A and B):

```text
MODEL REQUEST
│
├── LAYER A — instructions / developer context
│     owner:  SERVER   (conversation.systemPrompt, chat.ts:520)
│     today:  passed as streamText({ instructions }) — CONDITIONALLY PRESENT
│
├── LAYER B — tool definitions
│     owner:  SERVER   (chat.ts:321-332)
│     B.1 native tools   (nativeTools + a run-scoped run_command closure)
│     B.2 MCP tools      (mcp__<serverId>__<tool>, connected servers only)
│     today:  passed as streamText({ tools })
│
└── LAYER C — messages[]
      owner:  BROWSER TODAY / contested (chat.ts:260 → :341)
      C.1 retained conversation history
      C.2 current user turn
      today:  passed as streamText({ messages: modelMessages })
```

⚠️ **Layers A and B are not `ModelMessage[]` entries.** They are separate
`streamText` arguments. Collapsing them into one flat structure would misdescribe
the current implementation and would break the Phase 3 cache-prefix reasoning
(§2.4 of the roadmap): the provider's cacheable prefix is the **concatenation**
A → B → C, so a change in Layer B invalidates Layer C's cacheability exactly as
much as reordering history would.

### 1.2 Contract by layer

| | Layer A — instructions | Layer B — tool definitions | Layer C — messages[] |
|---|---|---|---|
| **Owner** | Server | Server | **Contested — 2.1d** |
| **Accepted input** | `conversationId` only | `runId` (for the run-scoped `run_command` closure + MCP abort signal), `conversationId` | `conversationId` + posted `messages` (or stored rows, per option) |
| **Rejected input** | Any client value — `system` is a 400 (`chat.ts:252-258`) | Any client value — `tools` is a 400 (`:191-201`) | Client `system`/`tools`/`callSettings`/`config` are 400s (`:191-201`) |
| **Ordering defined** | Single value today; if multi-block, order is server-defined | **Undefined today** — `getAiTools` iterates `this.connections` (`manager.ts:1027-1061`), whose order is connection-dependent | `order_seq ASC, created_at ASC` (`storage/index.ts:515`) |
| **Validation** | None needed (server-produced) | None needed; **determinism not yet enforced** | `safeValidateUIMessages` (`chat.ts:239-242`); pairing by `pruneStaleMessages` |
| **Budget enforcement (future)** | Counted as a category | Counted as a category | Counted per part category |
| **Cache layer** | Stable prefix head | Stable prefix — **membership churn is the main risk** | Stable head + variable tail |

### 1.3 What the returned structure guarantees

The contract's return value is three named, separately-addressable layers plus
provenance. Its guarantees:

1. **Layer separation is explicit.** A, B, C are distinct fields. No layer may be reconstructed from another.
2. **Server-owned layers cannot be influenced by the client.** A and B are derived from `conversationId` and `runId` only.
3. **Layer C is either wholly from one authority or carries an explicit reconciliation record.** Never a silent mix.
4. **The current user turn is identifiable** — a stable reference to C.2, not an assumption about array position.
5. **Ordering is deterministic per layer.** Same inputs → byte-identical serialized request.
6. **Every mutation is logged** with `requestId` + `conversationId`.
7. **Provenance is attached to each layer** — which authority supplied C, and whether it matched storage.
8. **Lifecycle repair is separable.** The call to `pruneStaleMessages` is an explicit, named step in the pipeline, never an implicit side effect of size handling.

### 1.4 Placement

The seam is `chat.ts:341`. Evidence for it being sufficient to capture every
Direct turn: it is the **only** call to `prepareModelMessages` in the repo, and
`streamText` at `chat.ts:515` is the only Direct model call.

Four adjacent points must be inside the boundary for the guarantees to hold, but
they are not separate seams:

| Point | Line | Why it must be inside |
|---|---|---|
| Envelope parse + validate | `chat.ts:152-260` | G6/G8 — divergence is only detectable here |
| Provider/model resolution | `chat.ts:203-237` | G4 — selection must not reach the request body |
| Tool assembly | `chat.ts:321-332` | Layer B determinism |
| `streamText` argument assembly | `chat.ts:515-521` | Where A/B/C converge — the only place a three-layer contract is real |

---

## 2. Options A / B / C

**No winner is declared. No scoring. No ranking.**

### 2.1 Option A — Server-authoritative

Server reads SQLite history; the browser submits only current-turn information and identifiers.

**Data flow**

```text
POST /api/chat { id, providerId, model, messages: [currentTurn] }
  → chat.ts:341 assembleContext(conversationId, [currentTurn])
      → listThreadMessages(conversationId)          [SQLite READ]
      → validate pairing across STORED history
      → assemble Layer C from stored rows
  → streamText
```

**Consistency properties.** Browser and server cannot disagree about history,
because the server never accepts it. Divergence becomes structurally
impossible for history, though still possible for the current turn.

**assistant-ui.** ⚠️ **The hardest constraint on this option.** The runtime
sends the *full* array on every request including auto-continue
(`runtime.ts:425`, from `Chat.state.messages`). Making the server ignore it
requires either a transport-level change (stop sending it) or server-side
tolerance of a field the server does not trust. Both are real work in
`web/src/`, and the transport is partly library-owned
(`AssistantChatTransport`).

**Auto-continue.** ⚠️ **Needs a new server-side concept.** `addToolOutput` and
`addToolApprovalResponse` mutate in-memory state and re-POST. Under A the server
would have to already know the tool result — but the tool result was produced
*client-side* by `POST /api/tools/run-granted` + `addToolResult`
(`web/src/tools/filesystem/ui.tsx:523-555`). The server holds no copy at
continuation time. **Under A this requires a new server-side write path for tool
results that today exist only in the browser.** That is a materially larger change
than the roadmap's Phase 2 framing implies.

**Detached runs.** ✅ Already server-side; unaffected.

**Resume.** Byte replay unaffected. A resume→auto-continue cascade is a fresh
`POST /api/chat` and would be subject to the same authority rule.

**Interrupted approval.** ⚠️ The decision arrives in the browser's posted part
and nothing in SQLite records it. Under A the server would need the decision in
storage before it can honor it — i.e. a **new server-side approval write path**,
which the brief forbids inventing. **This is Option A's largest gap.**

**Persistence round-trip.** Trivially consistent — the server is the writer.

**Streaming.** No change; streaming is downstream of assembly.

**Future compaction.** ✅ Favourable: compaction is a stored-history mutation
and the server already owns that surface.

**Future memory injection.** ✅ Favourable: injected blocks become server
assembly with server-side provenance.

**Operational complexity.** Adds a SQLite read on the hot path. Requires the
`order_seq` tip to be correct at every turn, including mid-run.

**Migration risk.** ⚠️ **Highest.** Requires changing the browser transport and
adding at least one new server write path (tool results, approval decisions).

**Information still unavailable.** Nothing in history — that is the point. But
mid-flight state (a tool result produced client-side but not yet settled) is
unavailable to the server, which is a **capability loss**, not a bug.

### 2.2 Option B — Browser-authoritative, server-enforced

Browser continues supplying history; the server validates, measures, and enforces limits.

**Data flow.** Unchanged from today. `assembleContext` wraps the existing
`prepareModelMessages` call and adds measurement, determinism enforcement, and
budget — without changing the authority.

**Consistency properties.** Divergence is *bounded* (a budget caps the damage)
but not *detected* unless explicitly added. ⚠️ Today no content comparison exists
at all (`conversations.ts:249-266` is existence-only), so B without an added
reconciliation is "trust and bound" — not "verify and bound".

**assistant-ui.** ✅ No change. Zero frontend work.

**Auto-continue.** ✅ No change.

**Detached runs.** ✅ No change — already server-owned.

**Resume.** ✅ No change.

**Interrupted approval.** ✅ No change — decision already arrives in the posted
part. ⚠️ The server is trusting a client field for a destructive action, and
U26 (secret verification) is not fully traced.

**Persistence round-trip.** ⚠️ Divergence persists silently unless reconciliation
is added. A server-finalized detached reply is invisible to the next model call
until the browser reloads the thread.

**Streaming.** No change.

**Future compaction.** ⚠️ Workable but awkward: compaction is a stored-history
change, while the model's view is client-supplied. Compaction would only take
effect after the client reloads — **a correctness hazard if the client never
reloads.**

**Future memory injection.** ⚠️ Awkward for the same reason: an injected memory
block would be server-produced but must travel through a client-authoritative
path to be included, or the client must fetch and forward it.

**Operational complexity.** ✅ Lowest.

**Migration risk.** ✅ Lowest.

**Information still unavailable.** The server cannot know what the client
omitted. Cannot know whether a posted turn ever existed. Cannot detect a
forged or stale array.

### 2.3 Option C — Hybrid explicit seam

`assembleContext(conversationId, postedMessages)`; authority and fallback rules explicit; divergence detectable.

**Data flow**

```text
POST /api/chat { id, providerId, model, messages }
  → assembleContext(conversationId, messages)
      → try: listThreadMessages(conversationId)        [SQLite READ]
      → compare against postedMessages
      → MATCH  → use stored (or posted; equivalent)
      → DIFFER → explicit rule, logged, provenance recorded
      → fallback: posted content, marked as such
  → streamText
```

**Consistency properties.** Divergence becomes **detectable** — the property B
lacks and A gets only by refusing the input. Fallback is explicit, so a
divergent request is never silently served.

**assistant-ui.** ✅ No change required. The seam is server-side only.

**Auto-continue.** ⚠️ **The same gap as A, but bounded.** Mid-flight state the
server lacks is not in storage, so the seam must treat "present in posted,
absent in storage" as an expected, non-divergent condition — not a mismatch.
Distinguishing *expected* transience from *real* divergence is the hard part of
this option and must be specified, not assumed.

**Detached runs.** ✅ Unaffected.

**Resume.** ✅ Unaffected.

**Interrupted approval.** ✅ Decision still arrives in the posted part; the seam
can additionally **log** it, which A cannot do without a new write path.

**Persistence round-trip.** ✅ Best of both: stored content is available as a
cross-check without refusing the client's array.

**Streaming.** No change.

**Future compaction.** ✅ Favourable — the server holds the history to compact.
⚠️ With the same "client must reload" caveat as B unless the seam prefers stored
content when they differ.

**Future memory injection.** ✅ Favourable — injected blocks are server-produced
and server-provenanced, and the seam is where they enter.

**Operational complexity.** Medium. Requires a comparison policy and a
provenance record.

**Migration risk.** Medium. No frontend change; new server logic.

**Information still unavailable.** The same as B for mid-flight state — the seam
can *observe* it but not *recover* it.

### 2.4 Factual comparison

| Dimension | A | B | C |
|---|---|---|---|
| Frontend/assistant-ui change | **Required** | None | None |
| New server write path (tool results) | **Required** | None | None |
| New server write path (approvals) | **Required** | None | None |
| Detects client/server divergence | N/A (impossible) | No (today) | **Yes** |
| Bounded regardless of client | Yes | Yes | Yes |
| Server sees stored history | Yes | No | **Yes** |
| Compaction (Phase 4) position | Strong | Weak | **Strong** |
| Memory injection (Phase 5) position | Strong | Weak | **Strong** |
| Hot-path SQLite read added | Yes | No | Yes |
| Operational complexity | High | **Low** | Medium |
| Migration risk | **High** | **Low** | Medium |
| Loses mid-flight visibility | **Yes** | No | No |

⚠️ **One row is decisive and should not be skipped: A loses mid-flight
visibility.** Today the server has no copy of a client-produced tool result or
approval decision until the client persists it. A server that trusts only
storage would *not know* those exist. That is a capability regression, not just
extra work.

---

## 3. The 17 mandatory guarantees

Restated as testable contract obligations.

| # | Guarantee | Where it lives | Provable today? |
|---|---|---|---|
| 1 | One Direct context-assembly path | `chat.ts:341` is the sole `prepareModelMessages` call | ✅ Yes |
| 2 | Server-owned instructions stay server-owned | `chat.ts:252-258`, `:520` | ✅ Yes |
| 3 | Server-owned tool definitions stay server-owned | `chat.ts:191-201`, `:321-332` | ✅ Yes |
| 4 | Provider/model selection cannot inject request structure | `.strict()` envelope (`validation.ts:53`); resolution `chat.ts:203-237` | ✅ Yes — *but see note* |
| 5 | Tool-call/result pairing validated before conversion | `prune-messages.ts:134-152` + `ignoreIncompleteToolCalls` | ✅ Yes |
| 6 | Approval state resolved by an explicit rule | `prune-messages.ts:52,:142-148` + ID match `ai:2937` | ⚠️ Partial — see §5 |
| 7 | Ordering deterministic, server-defined where persisted ordering applies | `storage/index.ts:515`; `order_seq` server-assigned (`:485-494`) | ⚠️ `order_seq` yes; **Layer B no** |
| 8 | Context mutations observable/loggable | `model-messages.ts:23-36` logs prune + approval events | ⚠️ Partial — no divergence logging exists |
| 9 | Budget enforcement server-side | Not implemented; `validation.ts:41` has no `.max()` | ❌ No — Phase 2.3 |
| 10 | No later phase bypasses the boundary | Architectural rule | ❌ No — a rule, not code |
| 11 | Current user turn identifiable from retained history | ⚠️ Today inferred from array position | ❌ No |
| 12 | Detached execution not confused with a new client request | Detached runs write server-side only; no client exists to post | ✅ Yes |
| 13 | Resume-triggered auto-continue treated as a fresh Direct request | ⚠️ `trigger` accepted (`validation.ts:42`) but **never read** | ❌ No |
| 14 | Compaction operates through the same contract | Phase 4 | ❌ No — Phase 4 |
| 15 | Phase 5 memory injection through the same budgeted contract | Phase 5 | ❌ No — Phase 5 |
| 16 | Tool/MCP reductions before provider serialization | `BoundedBody` is render-only | ❌ No — Phase 2.5 |
| 17 | Lifecycle repair distinct from size management | `prune-messages.ts` has no size logic | ✅ Yes |

**Six are provable today, five partially, six are future work.** G4 is provable
*at the envelope* but ⚠️ **the `messages` elements are `z.unknown()`** — opaque
and uninterpreted, so "cannot inject request structure" holds for the envelope,
not for message content. That gap is inherent to any option that accepts posted
history (B and C), and is precisely what A removes.

**G13 is the notable finding.** `trigger` is validated and then discarded. The
server could already distinguish `submit-message` from `regenerate-message` and
does not. It could not distinguish a **resume cascade** — `ai:19311-19319` re-POSTs
with `trigger: "submit-message"`, identical to a genuine user submit. **So
G13 as written is not satisfiable with the current enum**; either the enum needs
a third value or the guarantee must be redefined in terms of run state
(`chatRuns`) rather than client intent.

---

## 4. Current-architecture findings, carried forward unaltered

Phase 2.1a facts, restated without reinterpretation.

| # | Finding | Contract consequence |
|---|---|---|
| 1 | **Browser-posted messages are the Direct authority** | Layer C ownership is the contested decision (2.1d) |
| 2 | **Auto-continue uses in-memory `Chat.state.messages`** (`runtime.ts:425` ← `ai:19207-19216`) | Posted history legitimately differs from storage *mid-run*. A divergence check must not flag this as an error |
| 3 | **Resume is byte replay server-side but cascades into a fresh POST** (`ai:19204-19217` skips send; `:19311-19319` re-POSTs) | G13 is unsatisfiable as written (§3) |
| 4 | **Detached runs continue from server-held in-memory state**; `abortSignal` is `run.controller.signal`, never the request signal (`chat.ts:533-535`) | A detached run has no client, so it can never be a "new client-authored request" — G12 holds |
| 5 | **Approval decisions arrive in browser message parts**; no server-side store, no endpoint | The largest gap under Option A (§5) |
| 6 | **No message-content reconciliation** (`conversations.ts:249-266` is `SELECT id`) | G8 is unimplemented; C is the only option that adds detection without refusing input |
| 7 | **`order_seq` is server-defined** (`storage/index.ts:485-494,:515`) | C.1 ordering is already safe — the client cannot influence it |
| 8 | **`parent_id` is client-influenced** (`chat.ts:658` derives it from in-memory branch) | Branch structure is *not* server-defined. A contract that claims "all ordering server-defined" is **false for parent_id** |
| 9 | **Scheduler is a separate path** (`schedulerExecution.ts:344-349`) | §7 |
| 10 | **`prepareModelMessages` is the Direct conversion seam** (`chat.ts:341`, sole call site) | §1.4 |

⚠️ **Finding 8 is a contract defect in the roadmap's own wording.** §2.4 of the
roadmap asserts "server-defined ordering (never client-defined)" for Layer C.
That is true of *sequence* and false of *parentage*. The contract must state
both, or the guarantee is overstated.

---

## 5. Approval-state contract

Treated as first-class. **No server-side approval persistence is invented here.**

**Origin of requests.** Server-side, from the static map at `chat.ts:525-532`:
`write_file`, `edit_file`, `delete_file`, `run_command`, `process_kill`,
`browser_action` → `"user-approval"`. Identical for every request. A run carrying
`run.controller.signal` is the only per-request element.

**Origin of decisions.** **The browser's posted message part.** The client calls
`respondToApproval`; `ai:19011-19022` → `makeRequest` → `POST /api/chat`. The
decision arrives as `part.approval.{id, approved, resolution}` on the tool-call
part, and the SDK emits
`{type:"tool-approval-response", approvalId, approved, reason}`
(`ai:11785-11793`), plus a synthesized `execution-denied` tool-result when denied
(`ai:11794-11805`).

**ID matching is enforced server-side.** `ai:2937` looks up
`toolApprovalRequestsByApprovalId[approvalResponse.approvalId]` and throws
`InvalidToolApprovalError` (`:2939`) on no match. So a decision is bound to a
request the server itself emitted **in this run** — not to any prior request.

**What is persisted.** The `approval-requested` part is persisted **while paused**
(`useExternalHistory.ts:322-324` — `isReady = isTerminal || (isAwaitingToolCalls && adapter.update !== undefined)`), and the `approval-responded` state lands at the next settle (`:224-235`). So the *gate* is restorable from SQLite.

**What is NOT persisted.** ⚠️ **Any record that a user approved a specific
action.** No table, column, or endpoint. Nothing in SQLite says "user approved
tool X on conversation Y". The `role` column is never written either
(`storage/index.ts:461`).

**What must survive an approval pause.** The `approval-requested` part (already
does, via the pruner's `"approval"` classification at `prune-messages.ts:52`, and
via the paused-row write above).

**What must expire.** A decision once a later user turn exists.
`prune-messages.ts:142-148` drops it — so *"a destructive action is never
executed retroactively on an unrelated future message"* (`:95-100`).

**How replay onto a later turn is prevented.** Three independent mechanisms:

1. **The pruner** drops an approval part when `messageIndex < lastUserIndex`.
2. **ID matching** (`ai:2937`) requires a matching request *in the current run*; a stale `approvalId` from an old run finds nothing and throws.
3. **The secret** is passed per-run (`chat.ts:524`, `credentialStore.getToolApprovalSecret()` at `:264`).

⚠️ Mechanism 2 is the strongest and is **not currently claimed anywhere in the
roadmap**. It is load-bearing and belongs in the contract.

**U26 — `experimental_toolApprovalSecret`.** Partially resolved. The secret **is**
threaded into the SDK's approval path — 13 occurrences, including
`secret: toolApprovalSecret` (`ai:5435-5444`) and `secret: experimental_toolApprovalSecret`
(`ai:6069`). So it is not inert. ⚠️ **What remains untraced: whether it is
*verified* against a response, versus merely present on generated approval
requests.** The verification site was not located. Until it is, the contract must
treat mechanism 3 as **unverified** and rely on 1 and 2, which are code-verified.

**Contract obligation.** The decision arrives client-side. The contract must:
resolve it by ID against requests emitted in the current run; expire it at a later
user turn; and **record the decision's presence in logs without inventing
storage for it**.

---

## 6. Partial / paused assistant state

Using the **corrected** Phase 1 finding: the mid-run persistence exposure is an
**approval-paused** assistant row, not a streaming-start row. 2.1a established
`useExternalHistory.ts:208-221` returns early while `isRunning`, and `:224`
acts only on the true→false transition.

Four states the contract must distinguish:

| State | Detection | Persisted? | Must survive? |
|---|---|---|---|
| **Completed assistant turn** | `status.type === "complete"` / `undefined` / `"incomplete"` (`useExternalHistory.ts:316-319`) | Yes, at settle | Yes, as history |
| **Approval-paused assistant turn** | `status.type === "requires-action" && reason === "tool-calls"` (`:49-51`), plus `isReady` (`:322-324`) | **Yes — mid-run** | **Yes**, as a replayable gate |
| **Incomplete / dead tool call** | `lifecycleOf` → `"incomplete"` (`prune-messages.ts:53`) | Possibly | **No** — dropped by design |
| **Contentless assistant shell** | `isContentlessAssistantMessage` (`message-persistence-policy.ts:79-83`); refused at `conversations.ts:326-333` | **No** | No |

**Contract obligations.**

- The assembly contract must carry the **approval-paused** state through unchanged — it is the one mid-run state with a valid reason to exist in history.
- A `"completed"` turn and a `"requires-action"` turn must **never** be budgeted or compacted identically: the first is inert history, the second is a **pending executable action**. A budget that dropped a paused turn would strand a gate the user can still answer.
- A `"dead"` tool call is dropped by the pruner and must **not** be resurrected by any later phase.
- A contentless shell must **never** enter context; the guard is fail-open
  (`message-persistence-policy.ts`: *"FAIL-OPEN on anything unrecognised"*), which means an **unknown part type is treated as real content**. ⚠️ A new part type introduced by a later phase would be treated as substantive until classified.

⚠️ **Unresolved policy (deliberately not decided here):**
1. Whether an approval-paused turn participates in the budget as a full turn or a reserved slot.
2. Whether a paused turn may be a compaction boundary (Phase 4).
3. Whether a paused turn's re-entry after reload is safe when the underlying run is gone — the *gate* is restorable from SQLite, but the **decision** is not, and the original run's approval request no longer exists, so a reload + approve would hit `ai:2937` with no matching request.

⚠️ That third point is a **real, currently-reachable defect**: reload while
paused, then approve. Flagged, not fixed (per scope).

---

## 7. Scheduler

**Current path.** `schedulerExecution.ts:344-349`:

```ts
const result = streamText({
  model,
  messages: [{ role: "user", content: fullPrompt }],   // :346
  stopWhen: stepCountIs(10),                            // :348
  abortSignal: controller.signal,                       // :349
});
```

It reads `getThreadTip` (`:333`) for **parent derivation only**, and writes via
`upsertStored` (`:338`, `:357`, `:412`). It **does not** call
`prepareModelMessages`, **does not** read stored history, and **does not** run
the pruner.

**Why it is separate.** It is unattended. It has no client, so there is no
posted history to trust and no approval gate to honour. It also carries the
duplicated reasoning tables noted in Phase 1 (D11) and a different step cap
(10 vs 20).

**Is `assembleContext(...)` intended for Direct only?** ⚠️ **The contract as
specified in §1 is Direct-only**, because its inputs are the posted envelope.
Extending it to Scheduler would mean a different input contract
(`jobId` + stored history, no posted messages).

**What would have to change for Scheduler to adopt it.** Scheduler would need to
gain a real history read and pruner pass; its step cap reconciled; its duplicated
reasoning tables replaced by the shared ones; and its approval model stated
(unattended runs currently have no approval path — `schedulerExecution.ts`
carries no `toolApproval`, so gated tools are unavailable to it, which may be
intentional and should be confirmed).

**Scope decision required in 2.1d:** either (a) Direct-only, explicitly recorded
as such, or (b) a shared abstraction with two input adapters. ⚠️ **Not decided
here.** Option (b) is not obviously cheaper — it couples two paths with different
authority models — and the deferred option risks a permanent second context path
that no later phase audits.

**No Scheduler implementation changes made.**

---

## 8. Streaming / resume / detached compatibility

| Behaviour | Compatible? | Note |
|---|---|---|
| Ordinary streaming | ✅ | Assembly is upstream of `streamText`; no streaming coupling |
| Client disconnect / detached | ✅ | Run continues on `run.controller.signal` (`chat.ts:533-535`); server writes at settle (`chat.ts:679-686`) |
| `/api/chat/resume/:streamId` | ✅ | `GET`, byte replay, no model call, no message read (`chat.ts:850-897`) |
| Resume-triggered auto-continue | ⚠️ | Re-POSTs with `trigger: "submit-message"` (`ai:19311-19319`) — indistinguishable from a user submit |
| Interrupted approval | ⚠️ | Decision client-carried; gate restorable, decision not |
| Persistence finalization | ✅ | `upsertStored` at run end; `parentId` from in-memory branch (`chat.ts:658`) |

**Guarantees that cannot currently be proven from the repository:**

| # | Unprovable | Why |
|---|---|---|
| U25 | A resume cascade cannot leave **two** assistant rows | Reconciliation between the replayed message id and the new placeholder is untraced |
| U26 | `experimental_toolApprovalSecret` is **verified**, not merely present | Verification site not located (§5) |
| U27 | `parent_id` cannot produce an inconsistent branch | `chat.ts:658` derives parent from in-memory state; `getThreadTip` is unused there |
| U28 | A reload-while-paused + approve cannot reach `ai:2937` with no matching request | The reload path is asserted by reasoning, not traced to a conclusion |
| U29 | Auto-continue's posted array never diverges from storage in a way that matters | No divergence metric exists |

---

## 9. What Phase 2.1c must verify

Twelve scenarios. These are **defined, not run** — no implementation exists yet.

| # | Scenario | Must demonstrate | Available today |
|---|---|---|---|
| 1 | Normal request | Layer C from posted history; A/B server-owned; one assembly path | ✅ `prune-messages` suite |
| 2 | Auto-continue after tool output | Posted array == storage; tool result present once; no duplication | ❌ |
| 3 | Auto-continue after approval response | Decision ID-matched; executed or denial synthesized; not replayed later | ⚠️ partial — `approval-lifecycle` (8) |
| 4 | Detached completion | Server-written row lands; client absent; next turn sees it | ✅ `detached-history-finalization` (26) |
| 5 | Resume **without** auto-continue | Byte replay only; **no** new model request | ❌ |
| 6 | Resume **followed by** auto-continue | Second model call occurs and is a *fresh* request; no duplicate row (**U25**) | ❌ |
| 7 | Approval pause | Paused turn persists, survives reload, and is **not** compacted as inert history | ❌ |
| 8 | Interrupted tool call | Classified `"incomplete"`, dropped, not resurrected | ✅ `prune-messages` (15) |
| 9 | Browser/history vs SQLite mismatch | Divergence **detected and logged**, not silently served | ❌ — no metric exists |
| 10 | Persisted ordering | `order_seq ASC, created_at ASC` holds; client cannot influence sequence | ⚠️ unverified by test |
| 11 | Malformed tool lifecycle | Bad/absent `toolCallId` rejected at validation, not at conversion | ⚠️ unverified by test |
| 12 | Server-owned injection | `system`/`tools`/`callSettings`/`config` → 400; unknown envelope key → 400 (`.strict()`) | ⚠️ unverified by test |

**Highest-risk scenarios for 2.1c: 6, 7, 9.** Each exercises a guarantee that is
currently *unprovable* (U25, U28) or *unimplemented* (G8 divergence logging).

---

## 10. Verification performed

**Read-only inspection.** Files read in this pass: `src/routes/chat.ts` (200–360,
513–552), `src/lib/validation.ts`, `src/lib/model-messages.ts`,
`src/lib/prune-messages.ts`, `src/lib/message-persistence-policy.ts`,
`src/services/storage/index.ts`, `src/services/chat-runs.ts`,
`src/services/chat-streams/{historyFinalizer,sqliteResumableStore}.ts`,
`src/services/scheduler/schedulerExecution.ts`, `src/routes/conversations.ts`,
`src/routes/tools.ts`, `web/src/runtime.ts`,
`node_modules/@assistant-ui/ai-sdk/src/runtime/useExternalHistory.ts`,
`node_modules/ai/dist/index.js`.

**Tests run — existing only, none modified:**

| Suite | Result |
|---|---|
| `tests/unit/prune-messages.test.ts` | 15 pass / 0 fail |
| `tests/integration/approval-lifecycle.test.ts` | 8 pass / 0 fail |
| `tests/integration/phantom-assistant-shell.test.ts` | 12 pass / 0 fail |
| `tests/integration/detached-history-finalization.test.ts` | 26 pass / 0 fail |
| `tests/unit/scheduler.test.ts` | 65 pass / 0 fail |
| `web/src/features/chat/state/streamRecovery.test.ts` | 30 pass / 0 fail |
| **Total** | **156 pass / 0 fail** |

No test created, modified, or deleted. No code, schema, or dependency changed.

---

## 11. Contradictions found

| Source | Claim | Status |
|---|---|---|
| Roadmap §2.4 / G7 | "server-defined ordering (never client-defined)" for Layer C | ⚠️ **Overstated** — true of `order_seq`, **false of `parent_id`**, which the client influences (`chat.ts:658`) |
| G13 | Resume-triggered auto-continue identifiable as distinct | ❌ **Not satisfiable** — the `trigger` enum has no resume value, and the field is never read |
| G4 | Selection cannot inject request structure | ⚠️ True at the envelope (`.strict()`), but `messages` elements are `z.unknown()` and uninterpreted |
| `message-persistence-policy.ts:4` | Client persists a row at run **start** | ❌ **Already contradicted in 2.1a** — library writes on `isRunning` true→false; the real mid-run write is an approval pause |
| Phase 1 F11 | "truncated streaming row enters later context" | ⚠️ **Restated** — the exposure is the approval-paused row; the guard remains correct, the stated trigger was wrong |
| U26 | Secret verification unknown | ⚠️ **Partially resolved** — threaded into the SDK (`ai:5435-5444`, `:6069`); verification site still untraced |

---

## 12. Unresolved architectural questions

| # | Question | Blocks |
|---|---|---|
| Q1 | A / B / C — the 2.1d decision | Phase 2 lock |
| Q2 | G13: extend the `trigger` enum, or redefine the guarantee in terms of `chatRuns` run state? | Contract §3 |
| Q3 | G11: how is the current user turn identified — array position, an explicit marker, or `messageId`? | Contract §1.3 |
| Q4 | Is Scheduler in scope for `assembleContext`, or explicitly deferred? | §7 |
| Q5 | Is `parent_id` brought under server authority as part of this work? | Finding 8, U27 |
| Q6 | Divergence policy: what counts as *expected* transience (mid-run) vs *real* divergence? | Scenario 9 |
| Q7 | Does an approval-paused turn consume budget as a full turn or a reserved slot? | §6 |
| Q8 | Reload-while-paused then approve — fix, or document as a known limitation? (**U28**) | §6 |
| Q9 | Where does the request-side tool/MCP limit live relative to the seam? | G16, Phase 2.5 |
| Q10 | Does `assembleContext` remain synchronous, or become async for a SQLite read under A/C? | API shape |

---

## 13. The 2.1d decision record — required shape

To be written to `docs/decisions.md` **during 2.1d**, not now. It must contain:

1. **Chosen option** (A / B / C) with the specific configuration — e.g. "C, with stored-preferred and posted-fallback".
2. **Fallback rule**, stated explicitly: under what condition does stored content win, and under what condition does posted content win.
3. **Divergence policy**: what is logged, at what level, and what is *not* an error.
4. **Scope boundary**: whether Scheduler is included (Q4).
5. **Reversibility**: the specific change that would reverse the decision, and whether it is cheap. ⚠️ Option A→C is cheap; **C→A is not** — it needs the frontend transport change and two new server write paths. A reversible decision must record which direction is being made cheap.
6. **Guarantees accepted as deferred**: which of the 17 are not satisfied at 2.1d, and which phase owns each.
7. **Evidence cited** — the specific files and lines relied upon.
8. **Date and author.**

⚠️ **Q2 and Q10 should be resolved before 2.1d**, because both change the
signature of `assembleContext(...)` and therefore constrain which options remain
cheaply reversible.

---

## 14. What this document does not do

- It does not choose A, B, or C.
- It does not implement `assembleContext(...)`, or any part of it.
- It does not modify the roadmap, production code, tests, schema, or dependencies.
- It does not resolve Q1–Q10.
- It does not assert that any guarantee is met except where marked provable in §3.

The Phase 1 audit and the 2.1a validation remain the authoritative record of
current behaviour. Where this document reasons beyond them, it is marked
INFERRED and names the evidence it rests on.
