# TBAi — Model Context Roadmap

**Status:** Phase 1 complete · Phase 2 implemented · Phases 3–5 not started
**Scope:** Model context assembly, budgeting, provider prompt caching, compaction, and memory-to-context. The Direct AI engine.

> This is a planning artifact. Nothing listed under Phases 2–5 is implemented.

**Evidence base**

| Source | Location |
|---|---|
| Phase 1 Context Architecture Audit (**complete**) | `docs/context-architecture-audit.md` |
| OpenChamber / OpenCode Context & Subagent Architecture Study | `docs/openchamber-context-study.md` |
| Live TBAi code | `src/lib/model-messages.ts`, `src/lib/prune-messages.ts`, `src/routes/chat.ts`, `src/services/mcp/manager.ts` |

Phase 2 is built on the audit's findings **F1–F14** and the **10 verified
invariants** recorded in §1.3. Every later phase cites those rather than
re-deriving them.

**Sources of truth for wording in this roadmap:** claims marked ✅ VERIFIED were
read in code. Claims marked ⚠️ INFERRED are reasoned from code but not observed
at runtime. Claims marked ❓ UNKNOWN are recorded as open questions and must not
be treated as facts.

---

## Terminology (binding for this roadmap)

"Pruning" is **not** used as a general term for context reduction in this
document. Six distinct mechanisms are involved, and conflating them is the main
way context systems acquire silent, untraceable behaviour.

| Term | Precise meaning | Exists in TBAi today? |
|---|---|---|
| **Lifecycle repair** | Removing or superseding structurally invalid or stale message parts while preserving semantic state (tool pairing, approval decisions, replayable turns) | ✅ Yes — `pruneStaleMessages` (`src/lib/prune-messages.ts`). This is **all** it does |
| **Request-size limiting** | Bounding the serialized size of one content source before it enters model input, independent of any budget | ❌ No — nothing bounds the request path |
| **Context budgeting** | Allocating a measured input allowance across prioritized context categories, with an explicit reserve | ❌ No |
| **Truncation** | Discarding a defined portion of content with no replacement | ❌ No on the request path. Render-only caps exist and are not truncation of model input |
| **Compaction** | Replacing a span of conversation with a shorter generated or derived representation | ❌ No |
| **Summarization** | The generation of a condensed representation; a possible *mechanism* used by compaction | ❌ No |
| **Provider prompt caching** | Provider-side reuse of a previously processed request prefix | ❌ No |

**Rule 1.** Do not describe `pruneStaleMessages` as pruning, compaction, or
budgeting. It is lifecycle repair and nothing else. ✅ VERIFIED — the file
contains no size, token, character, or message-count logic.

---

## Phase 1 — Context Architecture Audit ✅ COMPLETE

**Status:** COMPLETE. Read-only; no production code, test, or dependency was changed.

Traced the full Direct-engine path from stored conversation state to the final
model request, and inspected the subagent path only far enough to establish
where its context lives.

### 1.1 The current pipeline ✅ VERIFIED

```text
SQLite  messages  (content = serialized UIMessage: { role, parts, metadata })
        conversations.system_prompt
   ▼
GET /api/conversations/:id/messages              src/routes/conversations.ts:270
   │   listThreadMessages                         src/services/storage/index.ts:510-534
   │   ORDER BY order_seq ASC, created_at ASC    :515
   ▼
assistant-ui runtime (browser) — AUTHORITY on turn content
   ▼
POST /api/chat { messages, id, providerId, model, reasoningLevel }
   ▼
prepareModelMessages(messages, tools)             src/routes/chat.ts:341
   ├─ pruneStaleMessages(messages)                src/lib/prune-messages.ts:107-193
   └─ convertToModelMessages(pruned, { tools, ignoreIncompleteToolCalls: true })
                                                    src/lib/model-messages.ts:38-41
   ▼
streamText({ model, messages, instructions, tools, toolApproval,
             stopWhen: stepCountIs(20), abortSignal })   src/routes/chat.ts:515-630
   ▼
provider  (openai responses | chat-completions | anthropic | google | ollama)
   │  chosen by src/services/ai.ts:124-137 buildModel
   ▼
toUIMessageStream → browser → persisted structurally unchanged
```

### 1.2 Findings carried forward

| # | Finding | Evidence |
|---|---|---|
| **F1** | **No real context-size management of any kind exists.** No token counting, no character budget, no message-count cap, no request body limit | `countTokens`/`estimateTokens`/`tiktoken`/`gpt-tokenizer`/`approxTokens` → 0 matches in `src/`. `prune-messages.ts` search for `token\|length\|char\|size\|limit\|budget\|max` returns only `parts.length` (array length) and prose. `validation.ts:41` is `z.array(z.unknown()).min(1)` with no `.max()`. `routes/index.ts:32,68` register only `cors()` + correlation |
| **F2** | **`pruneStaleMessages` is lifecycle repair, not size-based pruning** | `src/lib/prune-messages.ts` — 5 passes, all structural: superseded duplicate tool parts, expired approvals, stale incomplete tool calls, empty assistant turns, text-only user-run merge |
| **F3** | **No token counting or estimation exists** | Same search as F1. Every token number TBAi sees is read *back* from a provider response (`chat.ts:581-583`, `chat-model.ts:116-124`) |
| **F4** | **No explicit context budget exists** | Nothing anywhere computes an input allowance |
| **F5** | **No output-token reservation for Direct chat** | `streamText` (`chat.ts:515-630`) sets no `maxOutputTokens`/`maxTokens`. The only `maxTokens` in `src/` is MCP sampling passthrough (`mcp/manager.ts:791-808`), a client-supplied field. Not configurable per model — the field does not exist on `ModelOption`, `ProviderConfig`, the request schema, or the DB |
| **F6** | **No pre-flight context check exists** | No size check before `streamText` |
| **F7** | **No context-length-specific error handling exists** | A provider 400 falls into `classifyError`'s generic `config` branch (`errors.ts:182-186`); `CONFIG_RE` (`:53-54`) has no context-length pattern; `redact.ts:72-73` returns *"Generation failed. Retry or pick another provider/model."* — the user is never told the context was too large. `DIRECT_MAX_RETRIES = 0` / `DIRECT_STREAM_RETRIES = 0` (`chat.ts:54-55`), so nothing retries it |
| **F8** | **The browser supplies the request context; the server does not rebuild the conversation from SQLite for the request** | `messageService` is imported at `chat.ts:45` and used exactly once, at `chat.ts:1024` (`endsWithReply`, a status projection). Context is whatever the browser POSTs. `listThreadMessages` exists but is not on the request path |
| **F9** | **MCP/tool results can become large and are persisted and replayed into later context** | `getAiTools` returns the full result string (`mcp/manager.ts:1053`) with no length argument in `mcpContentToText` (`:1281-1295`). It becomes the part's `output`, is persisted structurally unchanged (`validation.ts:192-201`; `historyFinalizer.ts:113-116`), and is re-read and re-converted on every later turn. The only bound is `BoundedBody`, a React render-time component (`web/src/tools/body-budget.tsx:80`) whose own comment (`:30-42`) concedes it bounds DOM, not serialisation |
| **F10** | **Reasoning is currently resent** | `node_modules/ai` `convertMessage.js:11711-11716` pushes every reasoning part with **no `state` check** — `state:"streaming"` fragments re-enter as complete reasoning blocks |
| **F11** | **Partial assistant state can enter later context** | The client persists an assistant row when a run *starts* (`web/src/lib/message-persistence-policy.ts:4-21`) and `hasRenderableAssistantContent` (`:55-71`) accepts a `text` part regardless of `state`. Asserted as intended by a **passing test** (`tests/integration/phantom-assistant-shell.test.ts:170-187`). `prune-messages.ts` cannot catch it — `isMeaningfulPart` (`:62-64`) treats any non-`step-start` part as meaningful, so Pass 4 keeps the turn |
| **F12** | **`data-*` parts are silently omitted** | `convertToModelMessages` has three options; TBAi passes two (`model-messages.ts:38-41`). `convertDataPart` is never passed and appears **nowhere** in `src/`, `web/src/`, or `tests/` — 0 matches. The outcome (dropping a UI-only part) is correct but arrived at by omission, not decision |
| **F13** | **Subagent execution is OpenCode-owned** | `prepareModelMessages` is called only from `model-messages.ts:14` and `chat.ts:319,341`. The Code surface has its own runtime and never enters this pipeline. Independently confirmed by the OpenChamber study: `session.create` sends no `parentID` (`client.ts:816-828`), so a client is structurally incapable of creating a child session, and OpenChamber's own control route refuses to prompt a subagent-mode agent (`openchamber-sessions/routes.js:463-465`) |
| **F14** | **Context-window numbers are primarily readouts, not enforcement** | `contextWindow` is read by no backend code. It is populated from a provider response **only for Anthropic** (`modelDiscovery.ts:131`, `max_input_tokens`); OpenAI, Google, Ollama and custom listings set none (`:111-119`, `:140-156`). Resolution is `web/src/config/modelContext.ts:70-80` → live OpenCode limit → configured `contextWindow` → `DEFAULT_MODEL_CONTEXT_WINDOW = 128_000` (`:21`). For a non-Anthropic model the ring's percentage is computed against a number no provider reported. No branch anywhere refuses or degrades a send on fill |

### 1.3 Verified invariants that must survive every later phase ✅ VERIFIED

Encoded in `prune-messages.ts` and pinned by 38 passing tests
(`prune-messages` 15, `approval-lifecycle` 8, `phantom-assistant-shell` 12,
`tool-output-once` 3).

1. **Tool-call/result pairing.** Parts classified by `tool-call`/`dynamic-tool`/`tool-*`; identity is `toolCallId`; Pass 2 keeps the **last** occurrence that has a result (`:135-139`).
2. **Approval lifecycle survives, then expires.** An unexpired decision is kept so the server can execute the approved call or synthesize the denial (`:140-149`). Once a later user turn exists, the decision is **dropped** — a destructive action is never replayed onto an unrelated future message (`:142-148`).
3. **Stale incomplete tool calls are dropped.** `lifecycleOf` → `"incomplete"` when there is neither output nor approval (`:44-54`); removed (`:151`).
4. **Empty assistant turns are removed** (`:171-176`) — invalid provider input.
5. **Adjacent same-role runs merge only for text-only user messages** (`:56-60`, `:178-190`); function responses are never merged.
6. **The server owns the system prompt.** Client `system` is 400; so are `tools`/`callSettings`/`config` (`chat.ts:191-201`, `:252-258`).
7. **The tool lifecycle is never simplified to output-or-drop.** The `output`/`approval`/`incomplete` distinction is deliberate and documented (`:26-41`).
8. **Ordering is `order_seq ASC, created_at ASC`** (`storage/index.ts:515`).
9. **A run is detached, not killed, on client disconnect** (`chat.ts:801-829`; `abortSignal` is the *run's* controller, `:533-535`); a detached completion still lands in history (`:679-686`).
10. **No partial output is ever turned into a message by the server** (`historyFinalizer.ts:135-151`).

### 1.4 Observations deliberately excluded from this roadmap

The audit surfaced additional findings outside context engineering — including a
schema/data discrepancy where the live `messages` table lacks the `NOT NULL
CHECK` declared in `src/db/index.ts` and every stored row has a NULL `role`
(harmless today: the read path does not select `role`, and the serialized
`content` carries role 21/21). These are **not** tracked here. They belong in a
data-integrity ticket and must not be bundled into context work.

One context-relevant observation *is* recorded: `instructions` is supplied only
when `conversation.systemPrompt` is truthy (`chat.ts:520`), and no `web/src` code
writes it — the field was `NULL` for all 47 conversations in the live database at
audit time. Phase 2 must budget system instructions without assuming that
channel is populated. ⚠️ INFERRED (code + DB observation; not re-confirmed since).

### 1.5 Audit verification run

| Check | Result |
|---|---|
| `bun test tests/unit/prune-messages.test.ts` | 15 pass / 0 fail |
| `bun test tests/integration/approval-lifecycle.test.ts` | 8 pass / 0 fail |
| `bun test tests/integration/phantom-assistant-shell.test.ts` | 12 pass / 0 fail |
| `bun test web/src/components/ChatWindow.tool-output-once.test.ts` | 3 pass / 0 fail |
| Read-only live DB probe | 47 conversations · 0 system prompts · 21 messages · 0 MCP servers · ~18 KB total content |

⚠️ This install was under **no** context pressure. F9 and F11 are real by code
reading but **unobserved at runtime**.

---

## Phase 2 — Context Foundation

**Status:** IMPLEMENTED (2026-10-01). Typecheck exit 0, build exit 0, 2853 pass /
2 skip / 0 fail, and the accept + overflow paths live-verified against a real
local provider. **This is the gating phase for all others.**

Implementation report: `docs/phase-2-context-foundation-implementation-report.md`.
Decision: `docs/adr-2026-10-01-direct-context-assembly.md`.
Commits: `0fb6f61` (ADR), `3f384cd` (implementation), `230e538` (tests).

**What was delivered:** the single Direct assembly seam
(`src/context/assemble.ts`) producing three separated layers; pessimistic
measurement with a stated error model; per-model limit resolution **with
provenance**; an input budget that reserves output before computing input; an
explicit output reservation applied to the request; deterministic Layer B
ordering; request-side tool/MCP reduction (64 KiB/result) with observable
truncation; a distinct `context_overflow` classification with pre-flight
rejection and an actionable message; divergence reconciliation that reports
rather than merges; and content-free structured diagnostics.

**Deliberately not delivered, and why:**

- **Stored-data truncation** — bounding what is written to SQLite is a separate decision from bounding the request. Recording it here would conflate §2.5's four limit layers.
- **Provenance storage** — `toStoredMessageContent` copies a message verbatim with no field for injected-block origin. Adding one is a **schema change**, so it is a **Phase 4 prerequisite**, not a Phase 2 deliverable.
- **A "stable prefix" as a cached object** — Phase 2 makes the request *cache-ready* (deterministic ordering). Caching itself is Phase 3.
- **Scheduler integration** — recorded as an explicit Direct-only boundary; see the ADR.

**Unverified at implementation time:** near-boundary acceptance (unit-tested only),
a live request carrying MCP tools (`mcp_servers` is empty on this install), and
divergence in a real detached-reply scenario.

**Residual unknowns carried forward:** U14, U26 (partially resolved — the SDK's
`AI_InvalidToolApprovalSignatureError` proves a verification path exists, but its
semantics were not traced and G6 does not rely on it), U27, U32, U34, U35.
**Blocks:** Phase 3 (needs a stable prefix), Phase 4 (needs measurement),
Phase 5 (needs a budget to allocate against).

Phase 2 introduces four capabilities that do not exist today: an explicit
**context ownership contract**, **measurement** of model input size, a **hard
budget** with an output reserve, and **deterministic assembly** producing a
stable reusable prefix. Nothing in Phases 3–5 is meaningful without all four.

### 2.0 Why this phase exists, and why TBAi can do it

TBAi and OpenChamber sit on **opposite sides of the same architectural line**,
and this is the central planning fact of the workstream.

The OpenChamber study established, from code, that OpenChamber **cannot**
implement a context budget:

- `session.prompt` receives `{ sessionID, id, text, files?, agents?, skills?, metadata?, delivery? }` and **no messages or parts array** (`packages/ui/src/lib/opencode/client.ts:1130-1141`).
- `messages:` returns **zero matches** in `client.ts`. The four outbound content calls (`prompt`, `synthetic`, `command`, `shell`) all take authored `text` only.
- OpenChamber has **no tokenizer**, **no client-side history pruning**, and **no compaction** — it only *observes* OpenCode's `session.compacted` events.
- It holds **no durable message history**: `packages/ui/src/sync/persist-cache.ts:1-8` states *"Message/part data is always loaded from the server."*

Therefore: **OpenChamber is a context contributor and observer, never the model-context assembler.** It cannot budget a context it neither assembles nor stores.

**TBAi is architecturally different.** The Direct engine already owns
model-message preparation (`prepareModelMessages`, `model-messages.ts:14`) and
has durable history in SQLite (`messages` table, read via
`listThreadMessages`, `storage/index.ts:510-534`).

**Consequence:** TBAi *can* implement a context-budget layer that OpenChamber
itself cannot. This is an advantage to be spent deliberately — and it also
means TBAi owns the failure mode. There is no upstream engine to catch a bad
assembly.

⚠️ OpenChamber is therefore an **architectural comparison**, not an
implementation to copy. Where this roadmap cites it, the citation is to a
*lesson* or a *boundary*, never to a mechanism to adopt.

### 2.1 Context ownership and the assembly contract

**Status: RESOLVED (2026-10-01) — Option C, hybrid explicit seam.** Recorded in
`docs/adr-2026-10-01-direct-context-assembly.md`. This section remains the
contract; the ADR records the decision and why A and B were rejected.

Server-owned instructions, tool definitions, the budget and every enforcement
decision, the limit and its provenance, and persisted ordering are authoritative.
The browser-posted `messages` array is a **claim about** history, reconciled
against storage and **reported** — never merged, never used to rewrite storage.

Enforcement is authoritative because the client does not decide: it can lie about
*what* the history is, never about *whether it may be this large*.

#### Stage 2.1a — Inspect and validate current ownership

Establish, from code, exactly who controls what today. Phase 1 already
established the core facts (F8); this stage re-confirms them against the current
tree and closes the open items:

- Which parts of the request are browser-chosen (turn set, order, part content).
- Which parts the server validates today: `messages` is
  `z.array(z.unknown()).min(1)` with **no `.max()`** (`validation.ts:41`);
  `tools`/`callSettings`/`config` are 400s (`chat.ts:191-201`); client `system`
  is a 400 (`chat.ts:252-258`).
- Whether any cross-check exists between posted `messages` and SQLite contents.
  **None does** — `messageService` is imported at `chat.ts:45` and used once, at
  `chat.ts:1024`, for a status projection.
- What the server could reconstruct from `listThreadMessages`
  (`storage/index.ts:510-534`) — which is everything, since `content` is a
  serialized `UIMessage` carrying its own `role` and `parts`.
- **Close U13** (resumed-stream auto-continue carrying client-side context) and
  **U14** (why `conversation.systemPrompt` is never written).

#### Stage 2.1b — Define the single `assembleContext(...)` contract

Introduce **one** server-side boundary through which every model request is
assembled, and route all callers through it. This stage establishes the seam
**without changing ownership** — the browser remains authoritative for the
immediate path.

The contract must guarantee all of the following:

| # | Guarantee | Basis |
|---|---|---|
| G1 | **Server-owned instructions / tools / config** — never taken from the client | Existing refusals (`chat.ts:191-201`, `:252-258`) must not regress |
| G2 | **Server-side budget enforcement** — enforcement in the browser is not enforcement | Phase 2.3 |
| G3 | **Tool-call/result validation** before conversion, not assumed from client structure | Invariant 1 |
| G4 | **Approval semantics** — the server can execute an approved call or synthesize a denial without trusting the client's view | Invariant 2 |
| G5 | **Deterministic ordering** of the serialized request | §2.4 |
| G6 | **Divergence detection and logging** — a mismatch between stored and posted history is detectable and diagnosable after the fact, with `requestId` | `src/lib/logger.ts` |

Plus the standing rules: **a single assembly path** (no route or test may bypass
it), and **server-defined ordering** (never client-defined).

#### Stage 2.1c — Validate the seam against streaming, persistence, and resume

A boundary that silently re-reads SQLite will diverge from what the client
believes it sent. The two paths where that divergence is most likely:

- **Detached / resumed runs** (`chat.ts:801-829`, `:679-686`) — a run that
  continues after client disconnect, and a resumed stream that triggers a fresh
  `/api/chat` carrying `this.state.messages` assembled client-side
  (`web/src/runtime.ts:484-486`, **U13**).
- **Interrupted approvals** — a gate left open across a disconnect/resume cycle
  (invariant 2).

Both **must** be exercised while the seam is new. This is the cheapest moment to
catch the failure, and the stage exists specifically to do so.

Also validate: persistence round-trip (a turn written, re-read, re-assembled,
identical output) and that no existing invariant test regresses.

#### Stage 2.1d — Record the final ownership decision

**DONE (2026-10-01). Option C selected** and recorded in
`docs/adr-2026-10-01-direct-context-assembly.md` — a dedicated ADR rather than an
entry in `docs/decisions.md`, because that file held another workstream's
uncommitted ADRs and committing it would have mixed unrelated work.

The analysis that produced it:

| Position | Verdict |
|---|---|
| **A — server-authoritative** | **Rejected on a hard constraint, not a cost.** TBAi owns no server-side record of client-produced tool results or approval decisions, so a storage-authoritative server would be blind to state that demonstrably exists. Making it non-blind needs two new server write paths plus a frontend transport change, and re-opens the approval boundary that U30 proved works. |
| **B — browser-authoritative, server-enforced** | **Rejected.** Cannot distinguish a faithful history from an incomplete one; all three cases are bounded identically and none is reported. The budget becomes a ceiling on a client-supplied number. |
| **C — hybrid explicit seam** | **Selected.** Enforcement is authoritative because the client does not decide — it can lie about *what* the history is, never *whether it may be this large*. Reconciled and reported, never merged. |

**Reversibility is asymmetric and was a reason to choose C:** C → A is expensive
(two additive write paths; the seam's shape does not change), A → C is trivial, and
C → B is a deletion.

The three positions are retained below as the analysis that was performed.

| Position | Mechanism | Benefit | Cost / risk |
|---|---|---|---|
| **A — server-authoritative** | Server re-reads SQLite; browser posts only `conversationId` + the new turn | Budget is exact; client/stored divergence cannot occur. Enables resume correctness | Larger change; must handle the in-flight turn and unpersisted partials (F11) carefully; server becomes a hot read path |
| **B — browser-authoritative, server-enforced** | Status quo + budget | Smallest change; budget and overflow handling land first | Budget is only as trustworthy as the client; divergent or forged arrays are bounded but not detected |
| **C — hybrid explicit seam** | Browser-authoritative today; one `assembleContext(conversationId, postedMessages)` that prefers SQLite and falls back to posted content | Makes ownership **reversible** without re-architecting; the seam is where A would later be enforced | Requires discipline to keep one assembly path; the fallback must be explicit and logged, never silent |

⚠️ **The decision must be made before the final Phase 2 implementation path is
locked.** 2.1b/2.1c are designed to be valid under all three — which is why they
come first.

#### Acceptance criteria — 2.1

- [ ] 2.1a: current ownership documented; U13 and U14 closed
- [ ] 2.1b: one `assembleContext(...)` boundary; guarantees G1–G6 implemented and tested
- [ ] 2.1c: **detached/resumed run** and **interrupted approval** both exercised; persistence round-trip verified; no invariant regression
- [ ] 2.1d: ownership decision recorded in `docs/decisions.md` with alternatives, evidence, and rationale
- [ ] Single assembly path — no route or test bypasses it
- [ ] Server-owned-field refusals preserved and covered
- [ ] Divergence between stored and posted history detectable and logged

### 2.2 Measurement

TBAi must be able to state, before sending, how large the assembled input is.

**Measured vs reported must never be conflated:**

| | Source | When | Trust |
|---|---|---|---|
| **Estimated input size** | TBAi computes it from the assembled `ModelMessage[]` before `streamText` | Pre-request | Decision-grade, but an **estimate** |
| **Reported usage** | Provider response, read back via `onEnd` (`chat.ts:581-583`) and `buildChatMessageMetadata` (`chat-model.ts:116-124`) | Post-request | Authoritative for what the provider counted; arrives too late to prevent anything |

⚠️ **An estimate that can be wrong by 15% is not a budget.** The estimation
method, its unit (tokens vs characters), its error bound, and its
provider/model applicability must be documented and tested before it gates a
send. Prefer a provider-authoritative tokenizer where one exists; otherwise a
documented heuristic with a stated worst case and a safety margin sized against
it. A character heuristic (e.g. ~4 chars/token) is acceptable **only** with the
margin and the bound stated explicitly — the same approach OpenChamber uses for
its *small-model* utility prompts (`small-model/index.js:66-73`, where
`maxChars = (context − reserve) × 4`), and there it is a clamp on a non-chat
prompt, not a chat guard.

**Every model-visible content category must be measured:**

| Category | Where it enters | Notes |
|---|---|---|
| System / developer instructions | `streamText({ instructions })` from `conversation.systemPrompt` (`chat.ts:520`) | Currently unpopulated in practice (see 1.4) |
| User text | part `type:"text"` | |
| Assistant text | part `type:"text"` — **`state` not checked** | |
| Reasoning | `convertMessage.js:11711-11716` — **resent unconditionally** (F10) | Must be counted; also a Phase 2 policy decision |
| Tool **calls** | `type:"tool-<name>"` | |
| Tool **results** | `output` → `{type:"text", value}` | Currently unbounded for MCP (F9) |
| **MCP output** | `mcp/manager.ts:1053` returns the full string; `mcpContentToText` (`:1281-1295`) takes no length | The largest single-source risk |
| Attachments / files | part `type:"file"` | Not currently bounded |
| Data parts | `type:"data-*"` | Silently dropped today (F12); Phase 2 must make this an explicit decision |
| Memory | **does not enter context at all today** | Phase 5 introduces it as a *measured* category |
| Anything else model-visible | — | Enumerated by walking the assembled `ModelMessage[]`, not by guessing |

#### Acceptance criteria — 2.2

- [ ] One documented measurement function; unit and method stated
- [ ] Every category in the table above is measured
- [ ] Error bound documented and tested
- [ ] Estimated input size and provider-reported usage are stored and displayed as distinct fields
- [ ] A regression test proves measurement runs on the real production path

### 2.3 Hard budget

```text
Model input limit for (provider, model)      ← VERIFIED per model, or unknown
              ↓
      − safety margin                         ← documented, sized against estimator error
              ↓
      = input context budget
              ↓
      − output reservation                    ← explicit, configurable per model
              ↓
      = usable input allowance
              ↓
      allocated across measured categories     ← deterministic priority order
```

Requirements:

- **Input context limit — resolved per (provider, model), and provenance known.** Today `contextWindow` exists only for Anthropic (F14); everything else falls back to `DEFAULT_MODEL_CONTEXT_WINDOW = 128_000` (`modelContext.ts:21`). Phase 2 must distinguish *provider-reported* from *configured* from *defaulted*, and never present a defaulted number as a limit.
- **Behaviour when the limit is unknown must be explicit** — conservative reserve, refuse, or warn-and-proceed. Silently assuming a large limit is not acceptable.
- **Safety margin** — a documented fraction or absolute value covering the estimator error from 2.2, plus per-message overhead the estimate may miss.
- **Output reservation — explicit, and not zero.** F5: nothing is reserved today. Per-model, configurable, and applied to the request rather than assumed.
- **Behaviour when the context is too large — defined, deterministic, and distinguishable from other failures.** This directly addresses F7: today a provider context error surfaces as *"Generation failed. Retry or pick another provider/model."* The user must be told the context was too large, and the remediation must be named.

#### Acceptance criteria — 2.3

- [x] Per-(provider, model) input limit with recorded provenance — **R1 implemented**: `LimitSource` carries `provider_reported` / `configured` / `conservative_default` / `unknown`; the seam now passes the stored `ModelOption` through (`assemble.ts`); 46 dedicated tests in `src/context/provenance.test.ts`
- [x] Unknown-limit behaviour implemented and tested — `conservative_default` (128 000), bounded and reported as a stand-in; `enforceable: false` path retained for a genuinely absent ceiling
- [x] Safety margin documented with its derivation — `SAFETY_MARGIN_FRACTION = 0.25`, sized against the ±~20% estimate band (`budget.ts`)
- [x] Output reservation exists, is per-model configurable, and is applied — **R1 split this into two quantities**: `outputReservation` (input held back) and `generationCap` (the model's own ceiling, sent as `maxOutputTokens`), with `input + output <= ceiling` guaranteed explicitly
- [x] Over-context behaviour is deterministic, tested, and produces a distinct user-facing message — `context_overflow` category; pre-flight rejection verified live (HTTP 400 in 48 ms, no provider call)
- [x] A context-overflow error is classified as such (`errors.ts` / `redact.ts` updated with a real pattern, not a generic `config` fallback)

⚠️ **Still open, and a PRODUCT decision rather than a gap:** the standing 128 000
ceiling rejects roughly three quarters of the usable window of a model this
install's provider documents at 512K. The resolver now *can* honour a real limit;
this installation simply has no model carrying one (0/3 configured models have
`contextWindow`). Recorded as P1/P2 in `docs/r1-context-limit-decision.md` §15.

### 2.4 Deterministic assembly and a stable reusable prefix

#### The request has three layers, not one

TBAi's model request is **not** a single `ModelMessage[]`. `instructions` and
tool definitions are passed to `streamText` as **separate arguments**
(`chat.ts:515-630`) and are serialized into the provider request differently
from conversation messages. Treating them as ordinary entries in `ModelMessage[]`
conflates two different things and makes the caching reasoning in Phase 3 wrong.

The normative structure:

```text
MODEL REQUEST  (what the provider actually receives)
│
├── LAYER A — instructions / developer context
│     source: conversation.systemPrompt  →  streamText({ instructions })
│     NOT a message in messages[]
│
├── LAYER B — tool definitions
│     source: native tools + mcpManager.getAiTools()
│     B.1  native tools
│     B.2  MCP tools   (mcp__<serverId>__<tool>, connected servers only)
│     NOT messages[]; NOT a message role
│
└── LAYER C — messages[]   (ModelMessage[])
      ├── C.1  retained conversation history   (order_seq ASC, created_at ASC)
      └── C.2  current user turn              (always retained, always last)
```

⚠️ **Do not describe instructions or tool definitions as entries in
`ModelMessage[]`** unless the implementation actually converts them there. Today
it does not, and Phase 2 must not silently change that without a decision.

#### Determinism is required *within* each layer

| Layer | Requirement |
|---|---|
| **A** — instructions | Single source, server-owned. No per-request interpolation, or the prefix churns |
| **B.1** — native tools | Stable definition set and **stable ordering** |
| **B.2** — MCP tools | **Deterministic ordering**, not insertion order. `getAiTools` (`mcp/manager.ts:1027-1061`) iterates `this.connections`, whose population order is connection-dependent. An explicit sort key is required |
| **C.1** — history | `order_seq ASC, created_at ASC` (`storage/index.ts:515`) — server-defined, never client-defined |
| **C.2** — current user turn | Always retained, always last |

**Layer B membership is a cache hazard.** Tools come only from
`status === "connected"` servers (`manager.ts:1030`), so **connecting or
disconnecting a single MCP server changes Layer B and invalidates the reusable
prefix** — identically to reordering history.

#### Cacheability is determined by concatenation order, not by array order

The provider sees one serialized request. Its cacheable prefix is the
concatenation:

```text
reusable prefix  =  Layer A  →  Layer B  →  (start of Layer C)
```

Therefore:

- **A change in Layer B invalidates Layer C's cacheability exactly as much as reordering history would.** This is the consequence that only becomes visible once the layers are separated, and it promotes MCP connection churn from incidental to a first-class Phase 3 risk.
- **Memory and any other injected context block (Phase 5) sit in Layer C** and change the prefix when they change.
- **Compaction (Phase 4) rewrites Layer C** and may therefore change the cacheable prefix.

⚠️ **Do not assume OpenChamber provides this mechanism.** The study shows no
such mechanism exists there: OpenChamber never assembles a message array at all
(§2.0). Its nearest analogue is a *dedup signature* for a text block it injects
(`session-knowledge/runtime.js:34-45`) — deduplication of an application-level
block, **not** deterministic model-input assembly, and **not** prompt caching.

#### Acceptance criteria — 2.4

- [ ] Written layer contract; §2.4 is its normative form
- [ ] Each layer has a documented deterministic ordering
- [ ] Layer A / B are **not** represented as `ModelMessage[]` entries unless that conversion is a deliberate, recorded change
- [ ] Determinism test per layer, and for the serialized request as a whole: identical inputs → byte-identical output, run repeatedly
- [ ] No ordering dependence on `Map`/`Object` iteration of concurrently populated collections
- [ ] MCP tool ordering stable across restarts, reconnects, and connect/disconnect churn
- [ ] Current user turn provably always last and always retained
- [ ] The reusable prefix is stable whenever underlying inputs are unchanged
- [ ] Cache-invalidation triggers identified per layer and carried into Phase 3

### 2.5 Request-side tool and MCP output limits

**TBAi must not rely on `BoundedBody` as context protection.** It is a React
render-time component (`web/src/tools/body-budget.tsx:80`); its own comment
(`:30-42`) states it bounds DOM, not serialisation. A tool result can look
clipped in the UI while the full text sits in SQLite and in the model's context
(F9). The same trap exists in OpenChamber, where `capToolOutputText`
(`toolRenderers.tsx:35-47`, 512 KiB) has exactly two production call sites,
**both render paths** — which is why it is cited here as a cautionary parallel,
not a mechanism.

**The four limits must be distinguished and defined separately:**

| Limit layer | Applies to | Exists today? | Required in Phase 2 |
|---|---|---|---|
| **Render limit** | What the user sees | ✅ `BoundedBody` | Keep; label honestly as display-only |
| **Stored-data limit** | What is written to SQLite | ❌ | Define — bounding storage is a **separate** decision from bounding the request |
| **Request-serialization limit** | What enters the outgoing `ModelMessage[]` | ❌ | **The one that protects the context.** Must be implemented server-side |
| **Model-context limit** | What the provider accepts | ❌ | Covered by 2.3 |

Design requirements:

- **The request-serialization limit is authoritative for context purposes**, applied in the server assembly path, and it must apply identically to native and MCP results — no per-source exception.
- **Bound on write, not only on read.** Bounding only at serialization time still leaves unbounded text in SQLite; bounding only at write time can lose data the user may want. Decide explicitly which is true of TBAi and record it.
- **Truncation must be visible.** A truncated result must be marked as truncated *in the model-visible text*, not silently clipped. OpenChamber's notice string is a good honesty pattern (`toolRenderers.tsx:46` says "not shown"); TBAi needs the request-side equivalent.
- **Classification before truncation.** Prefer structured reduction (paths and counts for listings, exit-code plus tail for command output) over blind character slicing, so the model retains actionable information.
- **Bounded results must remain valid provider input** — a truncated `tool-result` must still satisfy tool-result pairing (invariant 1).

#### Acceptance criteria — 2.5

- [ ] Four limit layers defined and documented separately
- [ ] Request-serialization limit implemented server-side, applied to native **and** MCP results
- [ ] Truncation is explicit in the model-visible text
- [ ] Structured reduction preferred over blind slicing, with the strategy per tool source documented
- [ ] Bounded results still satisfy tool-call/result pairing
- [ ] `BoundedBody` is documented as display-only and is not cited anywhere as context protection

### 2.6 Preserving TBAi's existing invariants

**`pruneStaleMessages` must not be repurposed into a budget manager.** It is
lifecycle repair (F2, terminology rule 1). Budgeting, truncation, and compaction
are **new, separate** concerns with their own modules. Extending the pruner with
size logic would conflate "this part is invalid" with "we have too much", and the
latter has entirely different correctness requirements — most importantly, size
pressure must never be allowed to drop an unexpired approval decision.

Every capability in Phase 2 must preserve:

| Invariant | Source of truth |
|---|---|
| Tool-call/result pairing | `prune-messages.ts:16-24`, `:135-139` |
| Approval lifecycle (`output`/`approval`/`incomplete`) | `prune-messages.ts:26-54`, `:140-151` |
| Approval preservation until the conversation moves past it | `prune-messages.ts:140-149` |
| Existing `pruneStaleMessages` lifecycle semantics unchanged | 15 passing tests |
| Server-owned system prompt / tools / config | `chat.ts:191-201`, `:252-258` |
| Resume behaviour: detached runs continue and still land in history | `chat.ts:801-829`, `:679-686` |
| Streaming semantics: no server-side partial→message conversion | `historyFinalizer.ts:135-151` |
| MCP behaviour: connected servers only; `mcp__<id>__<tool>` naming intact | `mcp/manager.ts:1030`, `:1032` |

**Two open policy decisions Phase 2 must make explicitly** (both are F-list items
that are currently accidental rather than chosen):

- **Reasoning (F10).** Resent unconditionally today, streaming fragments included. Phase 2 must decide: resend all, resend only `state:"done"`, or drop. Whichever is chosen, it must be a decision with a test, not an emergent property of the SDK converter.
- **`data-*` parts (F12).** Dropped by omission today. Phase 2 must make this an explicit contract (either pass `convertDataPart`, or document the omission as intended).

A third, **partial assistant state (F11)**, is called out separately because it
is a correctness risk rather than a policy choice: a truncated turn currently
persists and later re-enters context as ordinary assistant text, and a passing
test asserts this is intended. Phase 2 must decide whether it remains intended,
and a budget manager cannot reason about content that may be a fragment of a
dead run. ⚠️ This needs a maintainer decision, not just an implementation.

#### Acceptance criteria — 2.6

- [ ] `pruneStaleMessages` unchanged; its 15 tests still pass unmodified
- [ ] New budgeting/truncation modules are separate from lifecycle repair
- [ ] Reasoning policy decided, implemented, tested
- [ ] `data-*` part contract decided and documented
- [ ] Partial-assistant-state policy decided and tested
- [ ] All 38 Phase 1 invariant tests still pass

### 2.7 Phase 2 exit criteria

- [ ] Context ownership decision recorded
- [ ] Written assembly contract implemented behind one path
- [ ] Measurement available for every model-visible category, with a documented error bound
- [ ] Hard budget with explicit output reservation, safety margin, and unknown-limit behaviour
- [ ] Over-context failure is deterministic and distinctly reported
- [ ] Assembly is deterministic and produces a stable prefix
- [ ] Request-side tool/MCP limits implemented; `BoundedBody` no longer cited as protection
- [ ] All existing invariants preserved and tested

---

## Phase 3 — Provider Prompt Caching

**Status: CERTIFIED WITH RESIDUAL RISKS** (closed 2026-10-01). Code, tests,
boundary enforcement and per-request diagnostics are complete. **No provider cache
write or read has ever been observed** — no Anthropic/OpenAI/Google credential
exists in this environment. That residual is isolated and classified, and is why
this reads "with residual risks" rather than a clean certification.

| Deliverable | Status |
|---|---|
| Capability registry keyed by exact provider + protocol + model | **IMPLEMENTED, VERIFIED** |
| Unknown-model policy (send nothing) | **IMPLEMENTED, VERIFIED, LIVE-VERIFIED** |
| Anthropic + OpenAI request-level cache controls | **IMPLEMENTED, VERIFIED** (gated on exact model) |
| Stable-prefix identity + invalidation reasons | **IMPLEMENTED, VERIFIED** |
| Anthropic request shape (byte-exact append growth; no ids serialised) | **IMPLEMENTED, VERIFIED** |
| Cache observation + `cache_observed` diagnostics | **IMPLEMENTED, LIVE-VERIFIED** |
| Two-request verification protocol (mode-aware) | **IMPLEMENTED, VERIFIED** |
| Sizing-eligibility rule | **CORRECTED** — states the basis, not the ceiling's provenance |
| **Cache key** | **DECIDED — none sent**, structurally; deferred with a trigger |
| **P3-R3 Anthropic breakpoint** | **RESOLVED** → KNOWN LIMITATION |
| **P3-R2 live cache write/read** | **UNAVAILABLE_TO_VERIFY** — no compatible credential |
| Explicit per-block breakpoints | **DEFERRED** — needs a Phase 2 contract change |

Full record: `docs/phase-3-provider-prompt-caching.md` ·
`docs/phase-3-provider-prompt-caching-report.md` ·
**`docs/phase-3-closure-report.md`**.

### 3.0.1 Binding safety rule — a stand-in ceiling may not size an experiment (R1, 2026-10-01)

```text
A conservative_default or unknown context ceiling
  MAY     be used for safety enforcement
  MUST NOT size a cache prefix
  MUST NOT choose a provider cache breakpoint
  MUST NOT segment a cache experiment
  MUST NOT claim cache effectiveness
  MUST NOT interpret cache hit / read / write results
```

Phase 3 may proceed on an experiment **only** when the context-capability data
behind it carries trustworthy provenance. Only `provider_reported` qualifies; a
`configured` figure is this installation's belief about a model, not a statement
by the model — the same distinction §3.6 draws for cache thresholds, applied to
the input window.

This is enforced in code, not left to discipline:

- `isPhase3ExperimentEligible(limit)` (`src/context/limits.ts`) returns true only
  for `provider_reported`.
- `budgetDiagnostics` emits `phase3ExperimentEligible` on **every** assembled
  request, so Phase 3's log analysis can exclude ineligible runs rather than
  averaging a fictional ceiling into a cache-effectiveness result.

**Why this is a rule and not a caution:** the failure is silent. Measured against
the 128k stand-in while a model documents 512K, a prefix-splitting experiment
would depress observed cache-hit rate and yield a confidently wrong conclusion
about whether caching helps. R1 verified this is a live condition for this
installation's configured model.

### 3.0 Scope boundary — what this phase is and is not

**This phase is provider-side prompt caching only.**

An application-level "context construction cache" (memoizing TBAi's own
assembly work) is **out of scope** and is explicitly not the primary cache. Two
reasons:

1. It optimizes TBAi's CPU, which is not the bottleneck — the dominant costs are
   provider latency and input tokens.
2. It risks becoming a second, divergent context path, which is precisely the
   ownership ambiguity Phase 2 exists to remove.

⚠️ **Every value in §3.2 is a documented value, current as of the access date
shown, and MUST be re-verified against provider documentation immediately before
implementation.** Provider capabilities change per model release; the
`MINIMUM` column is a compatibility floor, not a guarantee (§3.5).

⚠️ **Do not assume OpenChamber implements provider cache control.** The study
found **none**: zero `cache_control` / `cacheControl` / `promptCach` /
`cachedContent` occurrences in the request path. All `cache_read` hits are
cost/usage display data (`types/index.ts:30`, `useConfigStore.ts:495,580`,
`config-v2.js:598`) or unrelated quota limits
(`vscode/src/quotaProviders.ts:31,48-49,165`). Every `cache_read` /
`cache_creation` number TBAi currently sees is a **reported cost field**
(`chat-model.ts:97-104`), not a controlled cache.

⚠️ **This says nothing about OpenCode.** "OpenChamber sends no cache control" is
not evidence that OpenCode does not (Still Unknown **U5**). Do not chain them.

### 3.1 Stable-prefix prerequisites from Phase 2

Caching is an optimization for a **sufficiently large, stable prefix**. Provider
guidance is explicit that stable prefixes and stable tool ordering improve
reuse — OpenAI's caching guide states that static content (instructions, examples)
belongs at the **beginning** of the prompt and variable content at the **end**,
and that images and tools "must be identical even in their ordering between
requests" (https://developers.openai.com/api/docs/guides/prompt-caching).

Per the three-layer model in §2.4:

| Layer | Prefix risk |
|---|---|
| **A** — instructions | Any per-request interpolation churns the prefix. Note `conversation.systemPrompt` is currently unpopulated (§1.4), so this layer may be empty or unstable — **U14** |
| **B.1** — native tools | Definition or ordering change invalidates the prefix |
| **B.2** — MCP tools | **Connecting/disconnecting one server changes Layer B** (`manager.ts:1030`) — the highest-likelihood churn source in TBAi |
| **C.1** — history | Every new turn appends; only the *stable* head is cacheable |
| **C.2** — current user turn | Correctly excluded from the prefix — it is the variable tail |
| **Memory / injected blocks** (Phase 5) | A changed memory block changes the prefix |
| **Compaction** (Phase 4) | Rewrites Layer C and may change the cacheable prefix |

⚠️ **Determinism (§2.4) is a hard prerequisite, not a nicety.** A non-stable
prefix makes Phase 3 worthless, and the failure is silent — the request still
succeeds, it simply never caches (§3.4).

Caching must also not be introduced before a budget exists (Phase 2.3): Phase 4
compaction rewrites history, so attempting caching first would have its
precondition invalidated immediately.

### 3.2 Provider capability table — single source of truth

**Owner:** this section. One maintainable table, keyed by **full provider +
model identifier**. Per-model minimums change with every model release, so
scattering them through prose guarantees they go stale silently.

⚠️ **One threshold per provider family is wrong.** Anthropic's documented
minimums are **non-monotonic across generations** — Opus 4.5 requires 4,096 while
the *newer* Opus 4.8 requires 1,024. Any family-level lookup is wrong by
construction and must not be introduced.

**Schema — every entry carries all of:**

| Field | Purpose |
|---|---|
| `provider` | Provider identifier as TBAi's registry knows it |
| `model` / pattern | **Full** model id or exact pattern — never a family |
| `cache support` | supported / unsupported / **UNKNOWN** |
| `cache mode` | automatic (implicit) / explicit markers / both |
| `min cacheable input tokens` | **Documented** minimum (§3.5) |
| `explicit breakpoints` | supported / not supported / UNKNOWN |
| `max breakpoints` | Provider cap, or UNKNOWN |
| `TTL options` | e.g. 5m / 1h, or UNKNOWN |
| `cache-control parameters` | Exact request fields this model/version accepts |
| `verify via usage fields` | Exact fields that prove a write and a read |
| `source` | Documentation URL |
| `verified on` | Access date — **re-verify before implementation** |
| `notes / caveats` | Version-gated behaviour, platform differences |

**Current documented values** (re-verified **2026-10-01**; superseded the
2026-09-30 table below in `docs/phase-3-provider-prompt-caching.md` §3):

⚠️ **CORRECTION (2026-10-01).** The 2026-09-30 table below states *"Caching is
**explicit** on Anthropic: `cache_control` markers are required. Without a marker
nothing is cached."* **That is no longer true.** Anthropic now documents
**automatic caching**: a single **top-level** `cache_control` field, with the system
moving the breakpoint to the last cacheable block as the conversation grows,
available on every platform except legacy Amazon Bedrock (Opus 4.6 and earlier,
where it returns a **400**). This correction is load-bearing — automatic caching is
the request-level control Phase 3 needs.

✅ **The non-monotonic-minimums warning below is confirmed** and is now enforced by
a test rather than by prose.

#### OpenAI — https://developers.openai.com/api/docs/guides/prompt-caching

⚠️ **Do not hardcode a single 1,024-token threshold for all OpenAI models.**

| Model family | Min cacheable input | Explicit breakpoints | `prompt_cache_options` | `prompt_cache_key` | Notes |
|---|---|---|---|---|---|
| GPT-5.6 and later | **1,024** visible input tokens (strict) | Supported | Supported | Optional | Cache-write charged at 1.25× uncached input; 30-minute exact TTL via `prompt_cache_options.ttl` |
| GPT-5.5 / GPT-5.5 Pro | **Varies by request settings** (1,024–2,048) | Not supported | Not supported | **Recommended** (cache routing) | Implicit breakpoints at regular 2,048-token intervals |
| Earlier models | **Varies by model and request settings** (1,024–2,048) | Not supported | Not supported | **Recommended** | Do not assume any explicit control |

- ⚠️ **GPT-5.6-specific cache controls must not be blindly sent to pre-GPT-5.6 models.** Requests including `prompt_cache_options` / `prompt_cache_breakpoint` on unsupported models **return a 400** (confirmed on the Azure Foundry mirror of the guide).
- The minimum "varies with request settings, including tools, images, output schemas, reasoning effort, and verbosity" — so it is not a constant per model id.
- Cached-token reporting: GPT-5.6+ reports the exact eligible boundary; earlier models exclude hidden tokens and **round down to a multiple of 128**.
- **Verify via:** `usage.input_tokens_details.cached_tokens` (Responses API) or `usage.prompt_tokens_details.cached_tokens` (Chat Completions).
- OpenAI's own guidance: a prefix qualifying on one model may be too short on another — **measure the reusable prefix with the model and settings actually used.**

#### Anthropic — https://platform.claude.com/docs/en/build-with-claude/prompt-caching

**Per-model table. Do not normalize into a family-level rule.**

| Model | Min cacheable tokens | TTL | Max breakpoints |
|---|---|---|---|
| Claude Fable 5.1, Mythos 5.1, Opus 5.5, Opus 5, Fable 5, Mythos 5 | **512** | 5m / 1h | 4 |
| Claude Opus 4.7, Mythos Preview | **2,048** | 5m / 1h | 4 |
| Claude Opus 4.6, Opus 4.5 | **4,096** | 5m / 1h | 4 |
| Claude Opus 4.8, Sonnet 5, Sonnet 4.6, Sonnet 4.5, Opus 4.1, Opus 4, Sonnet 4 | **1,024** | 5m / 1h | 4 |
| Claude Haiku 4.5 | **4,096** | 5m / 1h | 4 |
| Claude Haiku 3.5 | **2,048** | 5m | 4 |

- Caching is **explicit** on Anthropic: `cache_control` markers are required. Without a marker nothing is cached. ⚠️ **SUPERSEDED 2026-10-01 — see the correction above: automatic caching is now documented and needs only a top-level field.**
- **Breakpoint placement and order matter.** Up to **4** explicit breakpoints per request.
- TTL: standard **5-minute**, extended **1-hour**. Bedrock documents the ordering constraint — longer-TTL blocks must appear *after* shorter-TTL ones.
- ⚠️ The minimum is **cumulative across the entire cacheable prefix before each checkpoint**, including `tools`, `system`, and `messages` — not just the marked block.
- **Automatic and explicit caching differ by platform** (Claude API, AWS, Google Cloud, Microsoft Foundry). Minimums are stated as applying everywhere each model is available, but this must be re-checked per surface TBAi actually uses.
- **Verify via:** `cache_creation_input_tokens` (write) and `cache_read_input_tokens` (read). If **both are 0**, nothing was cached — most commonly because the prompt was below minimum.
- If a prompt falls just short of the minimum, Anthropic notes expanding cached content to reach the threshold is often worthwhile, because cache reads are substantially cheaper.

#### Gemini — https://ai.google.dev/gemini-api/docs/caching

| Model | Min cacheable input tokens |
|---|---|
| Gemini 3.x Flash (3.8 / 3.7 / 3.6 / 3.5) | **4,096** |
| Gemini 3.1 Pro Preview | **4,096** |
| Gemini 2.5 Flash | **2,048** |
| Gemini 2.5 Pro | **2,048** |

- **Implicit caching is enabled automatically** for Gemini 2.5 and newer — no client action required; savings apply automatically on a hit.
- The **Interactions API supports implicit caching only.** Explicit caching (manually created cache objects) requires the **`generateContent` API**.
- Vertex additionally documents **6,144** tokens for Gemini 3.0 Flash Preview / 3.1 Pro Preview (implicit only). TBAi's surface determines which applies.
- **Verify via:** returned usage fields — `cached_content_token_count` / `UsageMetadata.cachedContentTokenCount`.
- ⚠️ **Do not transfer Gemini assumptions to other providers**, or vice versa.

#### Other providers

For every provider reachable through `services/ai.ts` (`buildModel` `:124-137`;
`DEFAULT_PROTOCOL` `:27-33`) that is not in the tables above: record the entry
with `cache support = UNKNOWN` and verify before adding any explicit support.
**"No supported mechanism" is a valid, documented outcome** — it must be
recorded, not left blank.

### 3.3 Cache invalidation

Must account for changes to:

- Instructions (Layer A)
- Tool definitions, native **and** MCP (Layer B) — including a single MCP server
  connecting or disconnecting
- MCP configuration and server set
- Model selection and variant
- Memory / injected context blocks (Phase 5)
- Compaction events (Phase 4)
- Any prefix-ordering change

### 3.4 Verification: a successful request does **not** prove caching occurred

**The rule:** below-minimum requests **succeed without caching and return no
error**. All three providers converge on this. Anthropic's guidance is that
silent no-cache is the most common reason teams conclude caching "isn't
working."

Therefore Phase 3 verification must inspect provider usage fields on a
deliberate two-request pattern:

```text
request 1
  stable prefix, nothing else
  → inspect CACHE WRITE / CREATION usage fields      ← expect a write

request 2
  identical stable prefix + changed suffix
  → inspect CACHE READ usage fields                  ← expect a read
```

**Success is judged on observed cache usage, never on absence of an error.**

Record for both requests:

| Metric | Why |
|---|---|
| Cache **write** / creation tokens | Proves the prefix was cacheable at all |
| Cache **read** tokens | Proves reuse actually happened — the entire point |
| **Uncached** input tokens | Separates cache effect from total input size |
| Latency (TTFT) | The user-visible benefit |
| Cost | The financial benefit |

⚠️ **Do not claim "caching enabled" merely because the request succeeded.** A
zero-write result at request 1 means the prefix is below the effective minimum —
record it in §3.5 and fix the prefix, not the claim.

### 3.5 Documented threshold vs observed threshold

**Published minimums are compatibility and documentation thresholds, not
guarantees of observed cache hits.** Two real cases, both from provider issue
trackers and forums rather than documentation:

- **Claude Sonnet 4.6** — multiple production reports that caching does not engage below ~2,048 tokens despite a documented 1,024, while **Sonnet 4.5 behaves correctly at 1,024** (consistent with a quietly raised threshold the docs did not reflect).
- **Gemini 2.5 Flash** — engineers reportedly confirmed a practical threshold of ~6,000–8,000 tokens against a documented 1,024 at the time; current documentation lists 2,048.

⚠️ **These are reports, not established facts for TBAi's models** — and they are
recorded here as *evidence that the gap exists*, not as thresholds to code
against.

**Two separate fields are kept. Never overwrite one with the other:**

| Field | Meaning |
|---|---|
| `min cacheable input tokens` | **Documented** value, with source and access date |
| `observed threshold` | **Empirically measured** for this provider + model + request shape |

When implementation or testing reveals a higher practical threshold, record:

- provider
- exact model
- observed threshold
- **request shape / settings** (tools, images, output schemas, reasoning
  effort, verbosity, breakpoints — several providers vary by these)
- date
- source / evidence

⚠️ **Do not overwrite the documented value with an anecdotal one.** A raised
observed threshold is a property of a model *and a request shape* at a point in
time; the documented value remains the compatibility floor.

### 3.6 Unknown model / unknown capability policy

**Rule (binding):**

```text
UNKNOWN MODEL  or  UNKNOWN CAPABILITY
   ↓
send NO provider-specific explicit cache parameters
   ↓
rely only on provider-native implicit/automatic caching, if documented as supported
   ↓
record the capability as UNKNOWN in the §3.2 table — never as a default
   ↓
verify before adding explicit support
```

⚠️ **A conservative low threshold may be used only as an estimation or
eligibility aid. It must never authorize an unsupported provider parameter.**

This distinction is required because provider controls are **model- and
version-specific**: sending `prompt_cache_options` to a pre-GPT-5.6 OpenAI model
returns a **400**, and sending `cache_control` to a model that does not honour it
is silently ineffective. A guessed threshold that authorizes a parameter turns a
cache miss into a hard failure.

An unknown model is therefore **not** "treat it as the lowest known threshold" —
it is "send nothing provider-specific, and record the gap."

### 3.7 Scope limit — caching is not a universal optimization

**Below the provider's minimum cacheable length there may be no cache benefit.**

With documented minimums of 512–4,096 depending on provider and model, **a short
personal-assistant conversation may sit below every one of them.** Phase 3 must
not be read as a default optimization, and "enable caching" is not a free win.

- Short conversations may never cache at all.
- The benefit is proportional to prefix size and reuse rate; OpenAI's own cookbook reports roughly 7% TTFT improvement at ~1,024 tokens rising to ~67% at 150k+.
- It can be *counterproductive* to pad a prompt toward a threshold if reuse is low — but can be net-positive once reuse is reliable, since cached reads are substantially cheaper than uncached input.

Record measured cost/latency **with and without** caching before claiming a
benefit.

### 3.8 Application-level context cache — explicitly out of scope

A TBAi "context construction cache" (memoizing assembly work) is **not** the
primary cache and is not planned. Two reasons:

1. It optimizes TBAi's CPU, not the bottleneck — the dominant costs are provider latency and input tokens.
2. It risks becoming a second, divergent context path, which is exactly the ownership ambiguity Phase 2 exists to remove (PM rule 14).

### 3.9 Measuring whether caching worked

`chat-model.ts:97-104` already types `cachedInputTokens` and
`ChatFinishUsage.cacheRead`; Phase 3 must surface cache read/write **separately**
from ordinary input tokens, and must never merge them into a single "input"
figure — a merged number makes cache effectiveness unmeasurable, which is the
failure mode §3.4 exists to prevent.

⚠️ OpenChamber computes a cache hit rate (`tokenUtils.ts:203`
`computeCacheHitRate`) but never controls a cache, so the number describes
something TBAi cannot act on. Do not copy the metric without the control.

#### Acceptance criteria — 3

- [ ] §3.2 table is the single source of truth; entries keyed by full provider + model id
- [ ] Every reachable provider has an entry, including `UNKNOWN` / "no supported mechanism"
- [ ] Values re-verified against current documentation immediately before implementation; access dates updated
- [ ] No family-level threshold rule anywhere in the codebase
- [ ] Unknown-model policy (§3.6) implemented: no provider-specific parameters sent, capability recorded as UNKNOWN
- [ ] Two-request verification (§3.4) implemented; success judged on cache usage fields
- [ ] Documented and observed thresholds stored as **separate** fields
- [ ] Stable-prefix prerequisites from §2.4 verified, including MCP connect/disconnect churn
- [ ] Cache read/write surfaced separately from ordinary input tokens
- [ ] Cost and latency measured with and without caching, at realistic conversation sizes
- [ ] Version-gated parameters (e.g. `prompt_cache_options`) guarded so they are never sent to unsupported models


---

### 3.10 Implementation record (2026-10-01)

**Delivered:** `src/context/cache/{types,capabilities,request,observe,prefix,verification,index}.ts`
plus `cache.test.ts` (49 tests), and route wiring in `src/routes/chat.ts`.

**The architectural decision that shaped the phase.** **Request-level cache
controls only; per-block markers are DEFERRED.** Both remaining providers' explicit
controls are per content block (the AI SDK reads Anthropic's `cache_control` from
each *message part's* providerOptions; OpenAI's `prompt_cache_breakpoint` is an
*input content-block field*). Expressing either would mean writing
provider-specific fields into the Layers B and C that `assembleContext` produced —
breaching the capability boundary, the no-bypass rule, and the ban on provider
branches in the orchestration layer at once. Both vendors document a request-level
mode needing no per-block markers and recommend it for an append-only
conversation, so Phase 3 enables those.

⚠️ **Known limitation of that choice.** Anthropic's automatic caching places the
breakpoint at the **last cacheable block**, which its own guide identifies as the
wrong choice when a varying block is last — and TBAi's current-turn tail is exactly
that. Anthropic caching may therefore underperform until explicit marker placement
exists. Recorded as P3-R3.

**Two bugs the tests caught during implementation**, both now fixed:

1. **Anthropic cache options were being emitted under the `openai` namespace key**,
   where the Anthropic provider silently ignores them — a failure indistinguishable
   from "caching did not happen". The namespace is now recorded *with* the
   capability rather than passed in by the caller.
2. **Phase 3 broke a Phase 2 invariant, and the Phase 2 test was right.**
   `ChatWindow.tool-output-once.test.ts` pins that `chat.ts` contains **zero**
   `instructions:` occurrences, because `instructions` is the reserved `streamText`
   Layer A key. My first `computePrefixIdentity({ instructions: … })` reintroduced
   it. Renamed to `layerAText`; the Phase 2 test was **not** weakened.

**Provider capability is UNKNOWN for `custom` / `ollama`.** Protocol compatibility
is not cache capability, and `@ai-sdk/openai-compatible` exposes no cache control
at all — only a passive read. The installed provider (`agnes`, type `custom`)
therefore sends **no** cache parameter, which is the correct request.

**Live verification** (server on `:3012`, provider config unmodified): normal
request HTTP 200 / 63 SSE frames; oversized 4 MB HTTP 400 in 62 ms; the
`cache_observed` line reports `cacheControlSent=false`,
`cacheControlOmissionReason=capability_unknown`, `documentedMinimumPrefix=null`,
`prefixStable=true`, `contextLimitSource=conservative_default`,
`phase3ExperimentEligible=false`.

**No cache write or read has been observed.** No Anthropic or OpenAI credential is
configured, and provider configuration was deliberately **not** modified to
manufacture one. **No cache hit is claimed.**

**What Phase 4 inherits:** `computePrefixIdentity` can show whether a compaction
preserved a cacheable prefix, and `evaluateCacheExperiment` reports
`inconclusive_prefix_mismatch` when it did not. OpenAI's guide states compaction
"can prevent reuse from the first changed token onward", so Phase 4 must **measure**
rather than assume. See `docs/phase-3-provider-prompt-caching.md` §13.

## Phase 4 — Automatic Summarization / Compaction

**Status: CERTIFIED WITH RESIDUAL RISKS** (2026-10-01). All 22 exit criteria
PASS. **Live summarisation is UNVERIFIED** — no compatible provider credential
exists in this environment. Full record: `docs/phase-4-compaction-report.md`;
architecture: `docs/adr-2026-10-01-context-compaction.md`.

Phase 4 is **not** an extension of `pruneStaleMessages` (F2). Compaction
*generates* a condensed representation of a span of history; lifecycle repair
*removes* structurally invalid parts. Different mechanism, different correctness
requirements, different module. `pruneStaleMessages` is **byte-for-byte
untouched** — verified by `git diff --name-only`.

### 4.0 Implementation record (2026-10-01)

**Delivered:** `src/context/compaction/{contract,summarize,orchestrate,index}.ts`
plus `src/services/compaction.ts`, the additive `conversation_compactions` table
in `src/db/index.ts`, wiring in `src/context/assemble.ts` and `src/routes/chat.ts`.
**100 tests** across `compaction.test.ts` (35), `runtime.test.ts` (31) and
`seam.test.ts` (34).

**The architectural decision that shaped the phase.** **A durable marker applied
at assembly; stored history is never rewritten.** This was not a preference. Phase 1
finding F8 established that the server never re-reads messages for a request — the
browser re-posts the whole `messages` array every turn — so rewriting
`messages.content` would be *functionally inert*: it would change the database and
have **no effect on what the model sees**. A marker is the only representation that
can affect the request, because the server is what assembles it.

**What compaction is for.** Converting the hard `CONTEXT_OVERFLOW` rejection into
graceful degradation. Not a cost optimisation, not a cache optimisation, and not a
message-deletion policy — each of those would need its own evidence.

⚠️ **KNOWN LIMITATION K1 — the user/model divergence.** The browser owns thread
state, so the server cannot compact the visible transcript without a second
authority. The user sees full history; the model sees a compacted form. Nothing is
deleted from the user's view, and the model's context is deterministic and durable
across reload, resume and detached completion. Lifting this needs a client-side
change and a decision about thread-state ownership.

⚠️ **KNOWN LIMITATION K2 — single-pass size bound.** Once a conversation outgrows
the summariser's one-call input capacity, compaction **declines** with
`span_exceeds_summarizer_capacity`, checked at plan time before any provider call.
Both alternatives were rejected as worse: summarising a *prefix* of the span and
presenting it as the whole span is a fabrication, and summarising the summaries is
the recursive growth path Phase 4 forbids.

**Two design rules that generalise, both learned the hard way:**

1. **Capacity ≠ budget.** `budget.usableInputTokens` is what a *turn* may send;
   `limit.maxInputTokens` is what the *model* can accept. Deriving the summariser's
   ceiling from the budget undershot real capacity and refused essentially every
   real compaction — a conversation large enough to *need* compaction is by
   definition larger than the budget.
2. **Plan over what the client re-posts.** Compaction originally planned its span
   over the already-compacted view, which contains a server-injected
   `tbai-compaction:*` block the client never receives. A second compaction
   therefore recorded an unlocatable id, so on the next request the record could
   not be found, compaction silently stopped applying, and the conversation
   reverted to full history and **grew without bound, with no error anywhere**.
   Every covered id must be one the client will re-post. This applies to *any*
   future server-derived block, including Phase 5 memory.

**Hysteresis is durable state.** A `latched` column on the record, set on
compaction and cleared when the seam *observes* usage below the release fraction.
Deriving it from current usage was the first implementation and it could never
clear: the condition only cleared below `release`, which is also below `trigger`,
so a conversation compacted once could never be compacted again.

**Off by default.** Gated on `TBAI_COMPACTION_ENABLED` (`"1"` / `"true"`), following
the existing `TBAI_CHAT_STREAM_TTL_MS` precedent. An unwired seam cannot compact by
accident, so every existing caller is unaffected.

### 4.1 Trigger

- Based on **measured input size** against the budget from 2.3 — not on message
  count and not on character count.
- Hysteresis is required: a single threshold causes compaction every turn once
  crossed. Define a trigger point and a re-entry point below it.
- Compaction must never be triggered by, or interfere with, lifecycle repair.
- ⚠️ A turn in flight (streaming, awaiting approval) is not a compaction
  candidate. OpenChamber's `max-h-56`-style thinking and its
  permission-pending-means-not-working rule (`useAssistantStatus.ts:11`,
  `sync-context.tsx:2155-2156`) reflect the same caution.

### 4.2 What may be compacted, and what must always be retained

**Always retained** — each maps to a Phase 1 invariant:

| Retained | Invariant |
|---|---|
| System / developer instructions | Server-owned (`chat.ts:191-201`, `:252-258`) |
| The **current** user request | It is the task; losing it loses the turn |
| Unresolved approval decisions | Approval preservation (`prune-messages.ts:140-149`) |
| All tool calls whose results are retained | Pairing (`:135-139`) |
| Recent conversation tail | Model needs local coherence |

**Compactable candidates:** older conversation spans, large tool outputs (already
bounded at 2.5), large MCP responses, old reasoning (subject to the 2.6 policy
decision), repeated/redundant output.

⚠️ **A compaction that drops a tool result or an unexpired approval decision is
worse than no compaction.** `approval-lifecycle.test.ts` (8 tests) and
`prune-messages.test.ts` (15 tests) already encode this and are the safety net
that must keep passing.

### 4.3 Keeping tool-call/result relationships valid

Compaction operates on **spans**, but provider validity is per-part. Required:

- A tool call and its result must be compacted **together or not at all**, or the
  pairing invariant (1) is broken and the provider may reject the request.
- A span boundary may not fall between a tool call and its result.
- If a tool call is compacted away, its result must go with it — never leaving an
  orphaned result.
- Compaction must go through the **same assembly path** as Phase 2, not a
  parallel one, so pairing verification applies uniformly.
- ⚠️ This is the single highest-risk area in Phase 4 and needs dedicated
  property-style tests: for any conversation and any compaction boundary, the
  assembled output must contain no orphan tool result and no unpaired tool call.

### 4.4 Preserving approvals across compaction

- An approval decision **pending** at compaction time must survive, because the
  server must still be able to execute the approved call or synthesize the denial.
- A decision **already consumed** (answered, with a result) is ordinary history
  and may be compacted with its span.
- A decision **expired** by the existing rule (a later user turn exists —
  `prune-messages.ts:142-148`) is not resurrected by compaction.
- Compaction must never create a *new* executable approval. That would be a
  security regression: a destructive action replaying onto an unrelated turn.

### 4.5 Partial and incomplete turns

⚠️ F11 is unresolved and directly relevant: today a truncated assistant turn
persists and re-enters context as ordinary assistant text, and a passing test
asserts this is intended.

- A compaction boundary must not be placed inside a partial turn.
- A partial turn must be **identified as partial**, not treated as complete
  assistant output. Phase 2.6 owns the underlying decision; Phase 4 inherits it.
- A turn interrupted mid-tool-call must retain its lifecycle classification
  (`output` / `approval` / `incomplete`, `prune-messages.ts:26-54`) through
  compaction.

### 4.6 Reasoning

Subject to the Phase 2.6 policy decision (F10 — resent unconditionally today,
streaming fragments included). Compaction must apply the **same** policy as
live context: if reasoning is not resent, it must not be re-introduced by a
summary; if it is resent, the summary must not silently include reasoning that
the live path would have excluded. Mixed policy between compacted and live
segments is a defect.

### 4.7 Summary generation strategy

- **Deterministic and provider-agnostic at the orchestration layer** wherever
  possible (PM rule 12).
- The summary is **model output** — it must be bounded by an explicit output
  reservation, or the compaction step can itself overflow the window (Phase 2.3
  applies recursively).
- Must not silently lose: decisions, user constraints, unresolved questions,
  named entities the user introduced. A summary that drops a stated constraint is
  worse than no summary.
- ⚠️ Verify: does the summarization call itself count against the same budget,
  and is its own token usage accounted for? OpenChamber documents a known
  undercount of exactly this — the summarization call's own tokens report as 0
  (`session-goal/runtime.js:663-669`). TBAi must not inherit that blind spot.

### 4.8 User-visible compaction indication

- The user must be able to see that compaction happened and what it covered.
- Report **what was compacted and what was preserved**, not just a count:
  how many messages, how many tool outputs, how many MCP responses; and the
  preserved set (instructions, active tool state, current request, recent turns).
- Compaction must not be silent. A user who cannot see it will believe the
  assistant forgot something.
- Compaction state must be persisted so a resumed or reloaded conversation shows
  the same indication rather than an unexplained history gap.

### 4.9 Persistence and resume

- Compaction is a **durable** change to what the conversation means. It must be
  persisted, not recomputed per request.
- A detached/resumed run (`chat.ts:801-829`) must see the same compacted history
  as a fresh turn.
- ❓ **Open:** whether compaction should rewrite stored history or layer a
  compaction marker over it. Layering is safer (reversible, auditable) but
  requires the marker to travel with the messages. This must be decided before
  implementation — it determines the schema.

### 4.10 The post-compaction invariant (from the OpenChamber study)

The OpenChamber study's most transferable lesson, and the reason this section
exists.

**The invariant:**

> **After compaction, the system must know which externally-injected context is
> still present.**

OpenChamber discovered this the hard way. Its `context-obligatory` runtime exists
because OpenCode's compaction **summarized away pinned context the UI still
believed was present**. Its own code names the failure mode
(`session-knowledge/runtime.js:11-16`):

> *"it survives compaction: the tab goes on believing the agent still has context
> that has just been summarised away."*

Its fix was a **server-side cursor** rather than a client-held signature, because
a client-held signature is precisely what survives the event it is meant to
track. On compaction it re-fetches pinned messages by id and re-injects them as
synthetic messages (`context-obligatory/runtime.js:70-155`), idempotently, keyed
on `context_obligatory_last_compaction_message_id` — with the content itself
**never** stored locally (ids only, `:10-16`, `:112-115`).

⚠️ **Do not copy that mechanism blindly.** TBAi differs materially: it has
durable history (SQLite) rather than an OpenCode-owned transcript, so
"re-fetch from the authority" is not the same operation. What transfers is the
**invariant and the failure mode**, not the cursor.

TBAi-specific consequences:

- Every **externally injected** context block — memory (Phase 5), attachments,
  injected workspace/project context — must carry a **known provenance** so that
  after compaction TBAi can answer "is this still present?"
- Provenance must survive compaction and resume; it must not itself be compacted
  away.
- A block that was injected before compaction and is absent after must be
  detectable, not silently absent.
- **Phase 5 depends on this.** Memory is externally injected context; introducing
  it before this invariant exists would repeat OpenChamber's bug.

#### Acceptance criteria — 4

- [ ] Trigger defined against measured size, with hysteresis
- [ ] Retained set defined and tied to specific invariants
- [ ] Tool call/result pairs are never split by a compaction boundary; property tests prove no orphans
- [ ] Pending approvals survive; consumed approvals may compact; no approval is ever resurrected
- [ ] Partial turns identified as partial; boundaries never fall inside one
- [ ] Reasoning policy identical in compacted and live segments
- [ ] Summary generation bounded by an explicit output reservation and accounted for
- [ ] Compaction is visible to the user with what-was-removed and what-was-preserved
- [ ] Compaction is persisted; resumed and reloaded runs see identical history
- [ ] Storing-vs-layering decision recorded in `docs/decisions.md`
- [ ] Every injected context block carries provenance that survives compaction
- [ ] Post-compaction presence of injected context is determinable

---

## Phase 5 — Memory → Model Context

**Status:** NOT STARTED. **Blocked by Phase 2** (measurement + budget) and
**Phase 4.10** (provenance must exist before injected memory can be tracked
across compaction).

### 5.1 Current state — verified, not assumed

✅ TBAi has a `memories` table (`db/index.ts`) and a MemoryPanel UI. ✅ **Memory
is storage-only: it does not reach model context.** `chat.ts` contains **zero
memory reads** on the chat path. No retrieval exists.

Per the project's own rule — *do not claim retrieval works until it is retrieved
and supplied to the model* — memory-to-context is **entirely unbuilt**. There is
no partial implementation to extend.

⚠️ ICM is named in `docs/architectural-principles.md` as the durable shared
memory engine behind `MemoryService`. Phase 5 must not bypass that boundary; this
roadmap describes the **context-side contract**, not the memory store's design.

### 5.2 Memory as a controlled context source

Memory is **not** a special channel. It enters the same budget as every other
category, in a defined position in the deterministic order (2.4, section 4 —
between MCP tool definitions and history).

```text
query
  ↓
retrieval            ← relevance, not recency alone
  ↓
ranking              ← deterministic
  ↓
budget allocation    ← same budget as history and tool results
  ↓
injected block       ← carries provenance (Phase 4.10)
  ↓
model
```

**Memory must participate in the same context-budget system rather than bypass
it.** A memory block that is injected outside the budget is the exact class of
bug Phase 2 exists to prevent.

### 5.3 Requirements

**Retrieval and relevance**
- Define what qualifies as a memory (the old roadmap's categories — user
  preference, user fact, project fact, decision, instruction, temporary context
  — are a reasonable starting taxonomy, not a decided one).
- Retrieval must be relevance-based, with recency as one signal.
- Retrieval must be **deterministic**: the same query and memory set must
  produce the same selection, or the stable prefix from 2.4 is broken.

**Size and budget**
- Per-memory size limit and total memory-block budget.
- Memory competes for space with history on a defined priority. ⚠️ This is a
  **product decision**: if memory and the current task conflict, which wins? The
  current task must — the current user request is always retained (4.2).
- Oversized individual memories are bounded using the **same** request-side
  mechanism as tool results (2.5), not a separate path.

**Ordering**
- Memory ordering is part of the deterministic assembly contract (§2.4). It must
  not depend on retrieval-engine internal iteration.
- Memory is a **Layer C** content block. A changed memory block changes the
  reusable prefix, so memory churn is also a Phase 3 cache-invalidation source
  (§3.3).

**Stale memory and invalidation**
- Define staleness: superseded, contradicted, or aged-out entries.
- A memory contradicted by the current conversation must not be injected as
  fact.
- Memory must be re-evaluated after compaction (Phase 4.10) — it is externally
  injected context, so its presence must be knowable.

**Update and user control**
- Retrieval must be inspectable: a user must be able to see which memories were
  selected for a turn and why. Without this, memory injection is
  indistinguishable from the model "remembering something" it never said.
- Stale or wrong memory must be correctable by the user.
- User-visible behaviour where a memory materially changed an answer.

**Testing**
- Conflicting/stale memory behaviour must be tested.
- Budget interaction must be tested: a turn at the budget ceiling with memory
  present must degrade deterministically.
- ⚠️ Injecting memory changes model behaviour for **all** providers and models.
  It must be provider-agnostic at the orchestration layer (PM rule 12) and must
  be verifiable as present-or-absent in the assembled request.

#### Acceptance criteria — 5

- [ ] Memory taxonomy decided
- [ ] Retrieval defined, deterministic, relevance-based
- [ ] Per-memory and total memory budgets defined and enforced via the Phase 2 system
- [ ] Ordering integrated into the deterministic assembly contract
- [ ] Stale/contradicted memory handling defined and tested
- [ ] Memory provenance carried and knowable after compaction
- [ ] User can inspect which memories were injected into a turn
- [ ] Memory goes through the same budget as every other category — no bypass path

---

## OpenChamber / OpenCode Lessons Applied to TBAi

**Status:** Reference. Derived from the completed study; not a TBAi work phase.

**How to read this table.** OpenChamber is an **architectural comparison, not a
reference implementation.** The study found OpenChamber cannot assemble model
input at all — so there is no mechanism here to copy. What transfers is
(a) where responsibilities fall, (b) failure modes that were hit in production,
and (c) the boundaries TBAi can exploit.

**Responsibility key:** **T** = TBAi · **O** = OpenCode · **P** = provider/model

| Area | OpenChamber / OpenCode | TBAi | Planning consequence |
|---|---|---|---|
| **Context ownership** | **O** assembles. OpenChamber sends one authored `text`; no messages/parts array exists on the send path (`client.ts:1130-1141`; `messages:` → 0 matches) | **T** assembles — `prepareModelMessages` (`model-messages.ts:14`), called from `chat.ts:341` | TBAi owns what OpenChamber cannot. Phase 2.1 must make this ownership explicit and recorded, not implicit |
| **Durable history** | **O** is the source of truth. Client persists no message data (`persist-cache.ts:1-8`); in-memory Zustand only | **T** owns SQLite (`messages`, `listThreadMessages`, `storage/index.ts:510-534`) | A budget needs a stable, authoritative history. TBAi has one; OpenChamber's absence is *why* it cannot budget. **TBAi's advantage** |
| **Token measurement** | **O** reports; **O**/UI only displays. No tokenizer, no estimation (`tokenUtils.ts:16,42,87,108,203`) | Same gap today — no counting in `src/`; only post-hoc `usage` (`chat.ts:581-583`) | Both blind. Phase 2.2 must build it for TBAi, and must state the error bound — an unbounded-error estimate cannot gate a send |
| **Context-window enforcement** | **P** enforces. `limit.context` from OpenCode's catalog, per model per session (`useContextWindowLimits.ts:24-53`); every consumer is a readout; no branch refuses a send | **P** enforces. Populated for **Anthropic only** (`modelDiscovery.ts:131`); else `128_000` default (`modelContext.ts:21`) | Both display-only. Identical trap: a ring percentage computed against a number no provider reported. Phase 2.3 must carry **provenance** (reported / configured / defaulted) |
| **Pruning / lifecycle repair** | **None client-side.** No `historyLimit`, `maxMessages`, `condense`, or `elide`. All `prune*` hits are record-set maintenance | `pruneStaleMessages` — **lifecycle repair only**, no size logic (F2) | Both correct, neither size-aware — by different means. **Do not** repurpose TBAi's pruner into a budget; conflating "invalid" with "too much" risks dropping approvals |
| **Compaction / summarization** | **O** performs it; OpenChamber only observes `session.compacted` (`event-reducer.ts:159-163`). Its model-summarization provider is **retired** — dead config remains (`summarization.js:119-122`, `tts/routes.js:89-90`) | **None.** `stepCountIs(20)` (`chat.ts:523`) is a step cap, not compaction | TBAi builds this from scratch. Phase 4 must not inherit OpenChamber's known undercount, where the summarization call's own tokens report as 0 (`session-goal/runtime.js:663-669`) |
| **Post-compaction injected context** | **T-equivalent lesson.** OpenChamber had to re-inject pinned context because compaction summarized it away while the UI still believed it present. Fix: **server-side cursor**, not a client signature — a client signature survives the very event it tracks (`session-knowledge/runtime.js:11-16`, `context-obligatory/runtime.js:70-155`) | **Must be designed up front.** No externally injected block exists yet | **The single most transferable lesson.** Phase 4.10 states the invariant; Phase 5 memory depends on it. Do not copy the mechanism — copy the invariant |
| **Tool-output limits** | **Render only.** `capToolOutputText` / `TOOL_OUTPUT_MAX_CHARS = 512 KiB` (`toolRenderers.tsx:35-47`) has exactly **2 production call sites, both render**. Never reaches a request | **Render only.** `BoundedBody` (`web/src/tools/body-budget.tsx:80`) bounds DOM, not serialisation — its own comment (`:30-42`) says so | **Same trap in both.** UI looks clipped; model sees everything. But consequences **differ**: OpenChamber cannot re-send; TBAi persists MCP results verbatim and resends every turn (F9). Phase 2.5 requires the **request-side** limit TBAi lacks |
| **Reasoning** | Display-only. Two fields, no signature, no `providerMetadata` (`model.ts:289-293`). **Never resent** — the send path cannot carry a part | **Resent unconditionally**, streaming fragments included (`convertMessage.js:11711-11716`, F10) | **Directly opposed.** OpenChamber drops by architecture; TBAi resends by default. Phase 2.6 must make this a decided policy, not an SDK accident |
| **Partial streaming state** | **Safe by architecture.** In-memory projection only, never persisted, never replayed | **Real exposure.** Row persisted at run *start*; text accepted regardless of `state`; a passing test asserts it's intended (`phantom-assistant-shell.test.ts:170-187`) | **TBAi-specific risk with no OpenChamber analogue.** Phase 2.6 must decide, and Phase 4.5 inherits it — compaction boundaries cannot fall inside a partial turn |
| **MCP** | Config owned by the client (`lib/opencode/mcp.js` CRUD); **protocol, tools, execution are O's**. Resources explicitly discarded (`events.ts:832-835`); zero `resources/*` calls exist | **T** owns config + protocol + execution (`mcp/manager.ts`). `mcp__<id>__<tool>` static tools; results unbounded (F9) | Same config/execution split. TBAi additionally owns the unbounded result — so Phase 2.5 must bound it, and MCP connect/disconnect churn invalidates the Phase 3 prefix |
| **Prompt caching** | **None implemented.** Zero `cache_control` in the request path; all `cache_read` hits are cost display or unrelated quota limits | **None.** `cachedInputTokens` exists only as a usage type (`chat-model.ts:97-104`) | Identical. Neither controls a prefix cache. Phase 3 must verify provider behaviour independently — **do not assume OpenChamber's non-implementation implies anything about OpenCode's** |
| **Subagents** | **O** owns entirely. OpenChamber **cannot create one**: `session.create` sends no `parentID` (`client.ts:816-828`), and its own route refuses to prompt a subagent-mode agent (`openchamber-sessions/routes.js:463-465`) | Subagent execution is **O**-owned. The Code surface has its own runtime and **never** calls `prepareModelMessages` (F13) | **Same boundary on both sides.** Subagent context is not TBAi Direct-engineering work → subagent phases removed (§ below). Confirmed independently from two directions |
| **Subagent result handling** | Three envelopes unwrapped **client-side for Markdown rendering only** (`taskToolModel.ts:189-224`); `packages/web/server` has zero references to `task_result`. No summarization — the test asserts result Markdown is preserved *exactly* | Same conclusion for TBAi's Code surface: OpenCode owns the envelope | ⚠️ **Corrects an earlier assumption** that the strip was server-side summarization. It is display formatting. Do not reason about subagent result size from OpenChamber's behaviour |
| **Error reporting on overflow** | No pre-flight check, no context-error classification; provider enforcement only | Provider 400 → generic `config` branch → *"Generation failed. Retry or pick another provider/model."* `DIRECT_MAX_RETRIES = 0` (F7) | **TBAi is worse** — it actively mis-reports the cause. Phase 2.3 must add a real context-length pattern so the user learns the context was too large and what to do |
| **Concurrency / resource limits** | No cap on concurrent children anywhere; no way to stop one specific child from the panel (only per-session interrupt) | Not applicable — TBAi owns no child sessions in Direct | ⚠️ OpenChamber's absence of a fan-out ceiling is **not** an argument that fan-out is safe; it means the client enforces nothing and relies on OpenCode |

### Boundary summary

| Concern | Owner |
|---|---|
| Model-message assembly | **T** (TBAi) — `prepareModelMessages` |
| Durable conversation history | **T** (TBAi) — SQLite |
| Context budgeting, measurement, request-side limits | **T** (TBAi) |
| Compaction and summarization | **T** (TBAi) — Phase 4 |
| Memory retrieval and injection | **T** (TBAi) / ICM behind `MemoryService` |
| Subagent creation, child context, child execution | **O** (OpenCode) |
| Code-surface transcript | **O** (OpenCode) |
| Actual token accounting | **P** (provider), reported back |
| Actual context-window enforcement | **P** (provider) |
| Provider-side prefix caching | **P** (provider), controlled by **T**'s request shape |

---

## Still Unknown / Requires Verification

❓ **These are open questions. None are facts. None may be treated as facts
without the verification named.**

**OpenCode internals — not verifiable from the OpenChamber repository**

| # | Unknown | Why it matters | How to resolve |
|---|---|---|---|
| U1 | **Exact OpenCode compaction algorithm** — what it summarizes, at what granularity, in what form | Phase 4 must not conflict with or double-apply compaction on the Code surface | Read OpenCode's server source; not present in `D:\Temp\openchamber` |
| U2 | **Exact compaction trigger** — threshold, hysteresis, whether it is proactive or reactive to a provider error | Determines whether the Code surface can overflow before OpenCode intervenes | Same as U1 |
| U3 | **Exact preservation rules during OpenCode compaction** — whether tool pairing, approvals, and instructions survive | If OpenCode does not preserve what TBAi's invariants require, the two surfaces diverge | Same as U1 |
| U4 | **Whether OpenCode bounds tool output before persisting it** | OpenChamber reads what OpenCode returns and never re-sends; if OpenCode does not bound it, the Code surface has unbounded history too | Same as U1 |
| U5 | **Actual OpenCode provider-cache behaviour** — whether it sends `cache_control` or any prefix-cache directive | The study proved only that **OpenChamber** sends none. It says nothing about OpenCode | Inspect outbound OpenCode requests |
| U6 | **Whether a resumed/backgrounded parent is guaranteed to receive a child's completion message** | `subagent-run.ts:8-9` asserts it; unverified | Same as U1 |

⚠️ **U5 in particular:** "OpenChamber has no cache control" ≠ "OpenCode has no
cache control." Do not chain these.

**Provider behaviour — partially resolved 2026-09-30, re-verify before Phase 3**

⚠️ The **documented** values in §3.2 were verified against provider
documentation on 2026-09-30 with sources and access dates recorded per entry.
They are recorded as documented values, **not** as verified live behaviour, and
**must be re-verified immediately before implementation** — provider
capabilities change per model release.

| # | Unknown | Status |
|---|---|---|
| U7 | OpenAI caching: mode, minimum, TTL, reuse conditions | ⚠️ **Documented values recorded** (§3.2, source + date). Still open: whether `reasoning.encrypted_content` affects reuse; the exact per-model minimum for TBAi's configured models; **observed** thresholds for those models |
| U8 | Anthropic `cache_control`: placement rules, minimums, breakpoints, TTL, platform differences | ⚠️ **Documented values recorded** (§3.2, source + date). Still open: how to express them through AI SDK v7's adapter without hand-rolling request fields; per-surface differences for TBAI's actual endpoint; **observed** thresholds |
| U9 | Gemini and all other providers reachable via `services/ai.ts` (`buildModel` `:124-137`; `DEFAULT_PROTOCOL` `:27-33`) | ⚠️ **Gemini documented values recorded** (§3.2). Still open: every provider **not** in the §3.2 tables — recorded as `UNKNOWN` until verified. "No supported mechanism" is a valid recorded outcome |
| U10 | Whether any provider accepts an explicit input-limit declaration from the client, or whether the limit is server-side only | ❓ **Still fully open.** Unrelated to caching; belongs to Phase 2.3 limit provenance |
| U23 | **Which models TBAi's provider registry actually exposes** — §3.2's documented minimums are frequently 2,048–4,096, so a phase built around 1,024-token prefixes would be worthless against several of them | ❓ **Still open.** Must be checked before Phase 3 scope is fixed |
| U24 | **Observed** cache thresholds for TBAi's actual models and request shapes (see §3.5; published minimums are floors, not guarantees) | ❓ **Still open.** Requires measurement |

⚠️ No U7–U9 or U23–U24 value is asserted as live behaviour anywhere in this
roadmap. §3.2 records what documentation states; §3.4 defines how TBAi will
measure what is actually true.

**TBAi — observed but not reproduced**

| # | Unknown |
|---|---|
| U11 | **Exact overflow/error behaviour per provider** — F7 was established by code reading (generic `config` classification, no context-length pattern). No provider has been observed returning a context-length error in TBAi. Reproduce deliberately before Phase 2.3 finalises error handling |
| U12 | **Real-world magnitude of F9 (unbounded MCP output) and F11 (partial turns entering context)** — the audit install has **0 MCP servers** and 21 messages (~18 KB). Both are real by code reading and **unobserved at runtime** |
| U13 | **Whether the resumed-stream auto-continue path can carry client-side context that diverges from SQLite** — a resumed stream can trigger a fresh `/api/chat` carrying `this.state.messages` assembled client-side (`web/src/runtime.ts:484-486`). Not reproduced |
| U14 | **Why `conversation.systemPrompt` is never written** — no `web/src` code writes it; `NULL` for all 47 conversations at audit time. A missing UI, an intentional default, or a dead field changes Phase 2.1's design |

**Design decisions still open** (recorded in-line above, listed here for tracking)

| # | Decision | Phase |
|---|---|---|
| U15 | Server-authoritative (A) vs browser-authoritative/server-enforced (B) vs hybrid explicit seam (C) | **2.1d** — resolved after 2.1a–2.1c, recorded in `docs/decisions.md` |
| U16 | Reasoning policy: resend all / resend only `state:"done"` / drop | 2.6 |
| U17 | Partial assistant turns in context — remains intended, or fixed | 2.6 |
| U18 | `data-*` parts: explicit drop, or `convertDataPart` | 2.6 |
| U19 | Tool results: bound at write time, at serialization time, or both | 2.5 |
| U20 | Compaction: rewrite stored history, or layer a marker over it | 4.9 |
| U21 | Memory taxonomy and retrieval strategy | 5.3 |
| U22 | Memory vs current task: which wins at the budget ceiling | 5.3 |

---

## Phases Removed From This Roadmap

Removed, with reasons:

| Removed | Reason |
|---|---|
| **Subagent Context Isolation** (old Phase 7) | Subagent context is **OpenCode-owned**. `prepareModelMessages` is called only from `chat.ts` (F13); the Code surface has its own runtime. Independently confirmed: `session.create` sends no `parentID`, so a client structurally cannot create a child. **Not TBAi Direct context-engineering work** |
| **Subagent Lifecycle & Resource Management** (old Phase 8) | Same boundary. Depth limits, concurrency caps, cancellation, and per-child budgets would govern child sessions **TBAi does not own and cannot create** |
| **Subagent Result Compression & Integration** (old Phase 9) | Result envelopes and integration are OpenCode's. OpenChamber unwraps them client-side for Markdown rendering only, preserving content exactly — **not** a compression mechanism, and not evidence about model-visible size |
| **Project / File Context System** (old Phase 10) | A generic retrieval/indexing feature, not context engineering. It belongs in a retrieval workstream. Phase 2.5 bounds attachments that already exist; Phase 2.4 reserves an ordered slot for any future injected context block |
| **Context Observability** (old Phase 4) | **Folded into Phase 2** rather than dropped. 2.2 requires estimated input size and provider-reported usage to be stored and displayed as **distinct fields**; 2.3 requires over-context failures to be deterministically reported; 4.8 requires compaction to be visible. A standalone phase would have had no implementation to observe until Phase 2 existed |
| **"Context Budget Manager" / "Intelligent Pruning & Compaction" framing** (old Phases 2–3) | Replaced by Phase 2 (Context Foundation) and Phase 4 (Automatic Summarization / Compaction). The old titles implied a single manager; the work is four separable capabilities with different dependencies and different failure modes |

**These are not deleted from the project.** Subagent concerns remain live —
`docs/subagent-management-plan.md` tracks them, and the boundary facts above are
the reason they belong in a separate workstream rather than the context
roadmap.

---

## Execution Order

```text
Phase 1  Context Architecture Audit                    ✅ COMPLETE
              ↓
Phase 2  Context Foundation                            NOT STARTED
         2.1a  inspect current browser/server ownership
         2.1b  define assembleContext(...) contract   ← the seam
         2.1c  validate vs streaming / persistence / resume
         2.1d  record ownership decision (A / B / C) in docs/decisions.md
              ↓
         · token measurement (2.2)
         · hard context budget + output reservation (2.3)
         · deterministic layered request + stable prefix (2.4)
         · request-side tool/MCP limits (2.5)
         · preservation of TBAi invariants (2.6)
              ↓
         ┌────────────┴────────────┐
         ↓                         ↓
Phase 3  Provider Prompt     Phase 4  Summarization /
         Caching                    Compaction
         NOT STARTED                NOT STARTED
         (needs stable         (needs measurement
          prefix = §2.4)          + budget)
         └────────────┬────────────┘
                      ↓
Phase 5  Memory → Model Context
         NOT STARTED
         (needs budget + §4.10 provenance)
```

Phase 3 and Phase 4 may proceed in parallel after Phase 2. Phase 5 must follow
Phase 4.10.

⚠️ **2.1d is a gate, not a formality.** The Phase 2 implementation path cannot
be locked until the ownership decision is recorded — the three positions have
materially different costs (§2.1d).

---

## PM Rules for This Workstream

1. **Audit before implementation.** Phase 1 is complete and is the evidence base for every later claim.
2. **Use the right term.** Six distinct mechanisms (see Terminology). Never describe lifecycle repair as pruning, compaction, or budgeting.
3. **Do not repurpose `pruneStaleMessages`.** It is lifecycle repair. Budgeting, truncation, and compaction are separate modules with separate correctness requirements.
4. **A display bound is not a context bound.** `BoundedBody` and `capToolOutputText` are render-time. Request-side limits are the only context protection.
5. **Estimate ≠ report.** An estimate with an unstated error bound cannot gate a send. Estimated input size and provider-reported usage are separate fields.
6. **Determinism is a prerequisite for caching, not a nicety.** Non-deterministic ordering makes Phase 3 worthless.
7. **Verify provider behaviour before claiming it.** Nothing in Phase 3 is asserted; everything must be checked against current documentation.
8. **Never break tool-call/result or approval-state invariants.** Compaction that drops either is worse than no compaction.
9. **Memory participates in the same budget as everything else.** No bypass path.
10. **Every context transformation must be testable**, and every optimization needs an invalidation strategy.
11. **Every injected context block carries provenance** that survives compaction. This is the OpenChamber lesson, generalized.
12. **Live-provider behaviour must be reproduced** before it is claimed. Code reading establishes intent, not behaviour.
13. **Stay provider-agnostic at the orchestration layer** wherever possible; provider specifics belong behind the adapter.
14. **No new context path.** Any new assembly route, tool, or cache must go through the Phase 2 contract or it does not ship.
15. **Document unknowns as unknowns.** § Still Unknown is not a backlog to be quietly closed by assumption.
16. **The request has three layers.** Instructions, tool definitions, and `messages[]` are distinct layers of the serialized provider request. Do not describe one as entries in another (§2.4).
17. **Per-model, never per-family, for any provider capability.** Minimums are non-monotonic across generations; a family rule is wrong by construction (§3.2).
18. **Unknown capability means send nothing provider-specific.** A conservative threshold may inform estimation, but must never authorize a provider parameter (§3.6).
19. **A successful request is not evidence of caching.** Success is judged on observed cache usage fields (§3.4).
20. **Documented and observed thresholds are separate fields.** Never overwrite one with the other; record the request shape and date alongside any observed value (§3.5).

---

## Definition of Done for This Workstream

Complete only when TBAi has:

- [ ] A recorded context ownership decision (A / B / C) in `docs/decisions.md`, and an implemented assembly contract behind one path
- [ ] The seam validated against detached/resumed runs, persistence, and interrupted approvals
- [ ] Measurement of every model-visible category, with a documented error bound
- [ ] An explicit input budget with a real output reservation and a defined unknown-limit behaviour
- [ ] Deterministic **layered** request (instructions / tool definitions / `messages[]`) producing a stable reusable prefix
- [ ] Request-side tool/MCP limits; render bounds documented as display-only
- [ ] A distinct, actionable over-context failure — not a generic provider error
- [ ] Compaction that never splits a tool pair, never loses a pending approval, and never resurrects one
- [ ] User-visible compaction with what was removed and what was preserved
- [ ] Provenance on every injected block, knowable after compaction
- [ ] Memory integrated into the shared budget with user-visible selection
- [ ] Per-model provider caching capability table, re-verified before implementation
- [ ] Caching **proven by observed cache usage** across the two-request pattern — not by request success
- [ ] Documented and observed cache thresholds stored as separate fields
- [ ] Unit/integration coverage for every context invariant
- [ ] No known uncontrolled context-growth path in the Direct engine
- [ ] Every ❓ unknown resolved or explicitly accepted as residual risk

**Do not mark the workstream complete because individual phases compile or pass
tests.** Phase 1 exists because code reading and runtime behaviour diverge, and
that lesson applies to every phase here.

---

## Provenance

| Section | Basis |
|---|---|
| Phase 1 | `docs/context-architecture-audit.md` — **complete**; TBAi code, tests, and a read-only live-DB probe. Findings F1–F14 and invariants 1–10 are the evidence base for every later phase |
| Phases 2–5 | The audit's findings plus `docs/openchamber-context-study.md`, used as architectural comparison and as a source of failure modes |
| OpenChamber citations | `D:\Temp\openchamber` at commit `692ab16a6`, read-only, `node_modules` excluded |
| Ownership boundary (F13) | Confirmed independently twice: TBAi call-graph (`prepareModelMessages` only in `chat.ts`) **and** OpenChamber (`session.create` sends no `parentID`) |

No production code, test, dependency, or schema was changed in producing this
roadmap.