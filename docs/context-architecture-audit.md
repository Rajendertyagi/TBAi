# Phase 1 — Context Architecture Audit (Direct AI engine)

Status: **audit only.** No production code, test, or dependency was changed. Every
claim below is cited to `file:line` or marked Unknown.

Audit date 2026-09-30. Scope: the **Direct** engine (`/api/chat`), with the
subagent path inspected only far enough to establish where its context lives.

> The roadmap names this file `docs/context-subagent-roadmap.md`. The file on disk
> is `docs/TBAi-context-subagent-roadmap.md`. Noted, not corrected.

---

## A. Current architecture

```text
SQLite  messages  (content = serialized UIMessage: { role, parts, metadata })
   │     conversations.system_prompt
   ▼
GET /api/conversations/:id/messages            src/routes/conversations.ts:270
   │   messageService.listThreadMessages        src/services/storage/index.ts:510-534
   │   SELECT id, parent_id, format, content … ORDER BY order_seq ASC, created_at ASC
   ▼
assistant-ui runtime (browser) — the AUTHORITY on turn content
   │   threadHistoryAdapter.load()              web/src/adapters/threadHistoryAdapter.ts:186-212
   ▼
POST /api/chat  { messages, id, providerId, model, reasoningLevel }
   │   validated                                src/routes/chat.ts:168-171, 239-260
   ▼
tools = { ...nativeTools, run_command(tap), ...mcpManager.getAiTools() }
   │                                            src/routes/chat.ts:321-332
   ▼
prepareModelMessages(messages, tools)          src/routes/chat.ts:341
   │
   ├─ pruneStaleMessages(messages)             src/lib/prune-messages.ts:107-193
   │     5 passes, ALL lifecycle/structure. NO size logic whatsoever.
   │
   └─ convertToModelMessages(pruned, {         src/lib/model-messages.ts:38-41
        tools,
        ignoreIncompleteToolCalls: true,        ← convertDataPart NOT passed
      })
   ▼
streamText({ model, messages: modelMessages, instructions, tools,
             toolApproval, stopWhen: stepCountIs(20), abortSignal })
   │                                            src/routes/chat.ts:515-630
   ▼
provider  (openai responses | chat-completions | anthropic | google | ollama)
   │   chosen by src/services/ai.ts:124-137 buildModel + :27-33 DEFAULT_PROTOCOL
   ▼
toUIMessageStream → browser → persisted verbatim
```

**The single most important structural fact:** the server **never re-reads
messages from SQLite to build a model request.** `messageService` is imported in
`chat.ts:45` and used exactly once, at `chat.ts:1024` (`endsWithReply`, a status
projection). Context is whatever the browser POSTs.

---

## B. Context inventory

| Context source | Enters model? | Where | Bounding / pruning | Verified? |
|---|---|---|---|---|
| System instructions (`conversation.systemPrompt`) | **Only if set** | `chat.ts:520` → `instructions` | none | **Yes** — and set for **0 of 47** conversations |
| Client `system` messages | **Refused, 400** | `chat.ts:252-258` "System messages are server-owned" | n/a | Yes |
| Client `tools` / `callSettings` / `config` | **Refused, 400** | `chat.ts:191-201` | n/a | Yes |
| User text | Yes | part `type: "text"` | none | Yes |
| Assistant text | Yes | part `type: "text"`, **`state` not checked** | none | Yes |
| Reasoning | **Yes, always** | `convertMessage.js:11711-11716` pushes `{type:"reasoning", text, providerOptions}` | **none; `state` not checked** | Yes |
| Tool calls (native + MCP) | Yes | `type: "tool-<name>"` | `ignoreIncompleteToolCalls: true` | Yes |
| Tool results (native) | Yes | `output` → `{type:"text", value}` | **render-only** bound (`BoundedBody`, `web/src/tools/body-budget.tsx:80`) | Yes |
| Tool results (**MCP**) | Yes | same, `output` is the full string | **NONE server-side** | Yes |
| Approval decisions | Yes, deliberately | `prune-messages.ts:140-149` keeps the last unexpired | protected by prune | Yes |
| Terminal output (`run_command`) | Yes | `data-tbai-terminal` + tool output | render-only | Yes |
| `data-*` parts (`data-tbai-progress`, `-terminal`) | **NO — silently dropped** | `convertDataPart` never passed | n/a | Yes — absence of an option, not a decision |
| MCP resources / prompts | **NO** | `readResource`/`getPrompt` have one caller each, both `/api/mcp` → composer draft | n/a | Yes |
| Files / images | Yes | part `type:"file"` | none | Yes |
| Sources | Not streamed by default | `sendSources = false` default | n/a | Yes |
| `memories` table | **NO** | `chat.ts` has zero memory reads | n/a | Yes |
| Subagent context | **N/A to this pipeline** | Code surface never calls `prepareModelMessages` | n/a | Yes |
| Detached/resumed stream | Not a context source | `chat/resume` replays bytes, no model call | n/a | Yes |

---

## C. Current invariants

Load-bearing, and each one is either enforced by code or by a passing test.

1. **Tool-call/result pairing.** `prune-messages.ts:16-24` classifies parts by
   `tool-call` / `dynamic-tool` / `tool-*`; identity is `toolCallId`; Pass 2 keeps
   the **last** occurrence that has a result, dropping superseded duplicates
   (`:135-139`). A completed interaction is never orphaned.
2. **Approval lifecycle survives, then expires.** An unexpired decision is kept so
   the server can execute the approved call or synthesize the denial
   (`:140-149`). Once a later user turn exists (`messageIndex < lastUserIndex`) the
   decision is **dropped** — a destructive action is never replayed onto an
   unrelated future message (`:142-148`). Pinned by
   `tests/integration/approval-lifecycle.test.ts` (8 pass).
3. **Stale incomplete tool calls are dropped.** `lifecycleOf` returns
   `"incomplete"` when there is neither output nor approval (`:44-54`), and
   Pass 2 Pass-3 removes every occurrence (`:151`).
4. **Empty assistant turns are removed.** After pruning, a turn left with only
   `step-start` is invalid provider input and is dropped (`:171-176`).
5. **Adjacent same-role runs are merged**, but only for text-only user messages
   (`:56-60`, `:178-190`) — function responses are never merged.
6. **The server owns the system prompt.** Client-supplied `system` is a 400, and
   so are `tools`/`callSettings`/`config` (`chat.ts:191-201`, `:252-258`).
7. **The tool lifecycle is never simplified to output-or-drop.** The distinction
   between `output` / `approval` / `incomplete` is deliberate and documented
   (`:26-41`).
8. **Ordering is `order_seq ASC, created_at ASC`** (`storage/index.ts:515`).
9. **A run is detached, not killed, on client disconnect**
   (`chat.ts:801-829`; `abortSignal` is the *run's* controller, `:533-535`), and
   a detached completion still lands in history (`:679-686`).
10. **No partial output is ever turned into a message by the server**
    (`historyFinalizer.ts:135-151`; `:22-23`).

---

## D. Current weaknesses

Evidence-supported only. No fixes proposed.

**D1 — There is no context size management of any kind.**
`pruneStaleMessages` contains **no** token, character, or message-count logic —
searched `token|length|char|size|limit|budget|max` across the file; the only hits
are `parts.length` (array length) and prose. Confirmed: no `countTokens`,
`estimateTokens`, `tiktoken`, `gpt-tokenizer`, or `approxTokens` anywhere in
`src/`. The roadmap's premise is correct, and stronger than stated: there is not
even a message-count cap (`validation.ts:41` is `z.array(z.unknown()).min(1)` with
no `.max()`), and no request body limit (`routes/index.ts:32,68` register only
`cors()` and correlation middleware).

**D2 — Output tokens are never reserved.**
`streamText` (`chat.ts:515-630`) sets no `maxOutputTokens`/`maxTokens`. The only
occurrence in `src/` is MCP sampling passthrough (`mcp/manager.ts:791-808`), a
client-supplied field. It is not configurable per model anywhere — the field does
not exist on `ModelOption`, `ProviderConfig`, the request schema, or the DB.

**D3 — Context-window overflow is unhandled and mis-reported.**
No pre-flight check, no retry-with-smaller-context, no context-length error
pattern. A provider 400 falls into `classifyError`'s generic `config` branch
(`errors.ts:182-186`); `CONFIG_RE` (`:53-54`) has no context-length pattern.
`sanitizeStreamError` has no `config` case, so `redact.ts:72-73` returns
**"Generation failed. Retry or pick another provider/model."** — the user is
never told the context was too large. And `DIRECT_MAX_RETRIES = 0` /
`DIRECT_STREAM_RETRIES = 0` (`chat.ts:54-55`) means nothing retries it either.

**D4 — `contextWindow` is display-only, and usually a guess.**
No backend code reads it. It is populated from a provider response **only for
Anthropic** (`modelDiscovery.ts:131`, `max_input_tokens`); OpenAI, Google, Ollama
and custom listings set none (`:111-119`, `:140-156`). Resolution is
`web/src/config/modelContext.ts:70-80`: live OpenCode limit → configured
`contextWindow` → `DEFAULT_MODEL_CONTEXT_WINDOW = 128_000` (`:21`). So the context
ring's percentage for a non-Anthropic model is computed against a number no
provider reported.

**D5 — MCP tool results are persisted verbatim, unbounded, and re-sent forever.**
`getAiTools` returns the full result string (`mcp/manager.ts:1053`), with no
length argument anywhere in `mcpContentToText` (`:1281-1295`). It becomes the
part's `output`, is persisted structurally-unchanged
(`validation.ts:192-201` "stored verbatim"; `historyFinalizer.ts:113-116`), and is
re-read and re-converted on **every later turn**. `BoundedBody` is a React
render-time component (`web/src/tools/body-budget.tsx:80`) and its own comment
concedes it bounds DOM, not serialisation (`:30-42`). Consequence: the UI may
*look* clipped while the full text sits in SQLite and in the model's context.

**D6 — Reasoning is re-sent unconditionally, including streaming fragments.**
`convertMessage.js:11711-11716` pushes every reasoning part with no `state` check.
A `state: "streaming"` fragment re-enters as a complete reasoning block.

**D7 — A truncated assistant turn can enter a later request.**
The client persists an assistant row when a run *starts*
(`message-persistence-policy.ts:4-21`), and `hasRenderableAssistantContent`
(`:55-71`) accepts a `text` part regardless of `state`. This is asserted as
intended by a passing test: `phantom-assistant-shell.test.ts:170-187`
"preserves a failed run's meaningful partial assistant content". On the next turn
that row is re-read, POSTed back, and converted as an ordinary assistant text
block. `prune-messages.ts` cannot catch it — `isMeaningfulPart` (`:62-64`) treats
any non-`step-start` part as meaningful, so Pass 4 keeps the turn.

**D8 — An interrupted MCP call is silently lost from context.**
No `mcp__*` name is in the `toolApproval` map (`chat.ts:525-532`), so an MCP part
can never be lifecycle `"approval"`. An MCP call with no output classifies
`"incomplete"` (`prune-messages.ts:53`) and is dropped by Pass 2. The only record
is a **debug** line carrying ids (`model-messages.ts:23-29`).

**D9 — `data-*` parts are dropped by omission, not by decision.**
`convertToModelMessages` has exactly three options; TBAi passes two
(`model-messages.ts:38-41`). With `convertDataPart` absent, `data-*` parts
evaluate to `undefined` and are filtered out. `grep convertDataPart` across
`src/`, `web/src/`, `tests/` → zero matches. The right outcome for a UI-only part,
but arrived at by not passing an argument.

**D10 — A resumed stream can re-issue a model request with client-side context
that differs from what SQLite holds.**
`/api/chat/resume/:streamId` (`chat.ts:850-897`) replays persisted bytes and
makes no model call. But the AI SDK then auto-continues
(`ai/dist/index.js:19311-19319`) when `shouldSendAutomatically()` passes, and
TBAi arms that predicate at `web/src/runtime.ts:484-486`. The follow-up is a
**fresh** `/api/chat` carrying `this.state.messages` — assembled client-side.

**D11 — The scheduler duplicates the reasoning tables instead of sharing them.**
`schedulerExecution.ts:192-211` has its own `isLite`, its own budget maps, and a
hardcoded `providerOptions.openai` namespace with **no `openaiCompatible` branch**
(vs `chat-provider-options.ts:140`); no `includeThoughts` for Google; no
Gemini-3 `thinkingLevel`. Plus `stepCountIs(10)` (`:348`) vs Direct's 20.

**D12 — Schema/data discrepancy: `messages.role` is NULL everywhere.**
`src/db/index.ts` declares `role TEXT NOT NULL CHECK(role IN ('user','assistant','system'))`,
but the live table reports `role TEXT notnull=0` with no CHECK, and **all 21 rows
have `role = NULL`**. This is currently harmless: `listThreadMessages` does not
select `role` at all (`storage/index.ts:515`) and the serialized `content` carries
its own role (21/21 rows; 11 user, 10 assistant). The column is vestigial for this
path. Reported, not fixed.

**D13 — The system prompt is never populated in practice.**
`chat.ts:520` supplies `instructions` only when `conversation.systemPrompt` is
truthy. **0 of 47** conversations have one set, and no `web/src` code writes it —
only the conversations API accepts it. Confirmed against the live database.

---

## E. Unknowns

1. Whether any provider in practice returns a 400 the classifier would mis-bucket.
   No test or fixture covers a context-length error.
2. The true token semantics of `usage.totalTokens` per provider — the vendored
   display element explicitly declines to assert it
   (`context-display.tsx:266-272`).
3. Real-world magnitude of D5/D7. Whether any configured server or long thread
   actually reaches a limit is a deployment fact, not derivable from the repo.
   This install has **0 MCP servers** and 21 stored messages totalling ~18 KB, so
   nothing here is under pressure.
4. Whether `@modelcontextprotocol/client` imposes its own transport frame limit
   upstream of `callTool` — not read.
5. Whether provider `request` overlays (headers/body) reach model calls; the v2
   docs state the session runner preserves but does not yet send them.
6. Whether the Code surface's OpenCode session is re-derived on resume — that path
   never enters this pipeline, so it is out of scope here.

---

## F. What a Context Budget Manager would need to know

Requirements, not a design.

1. **A per-model input limit that is actually reported.** Today only Anthropic
   supplies one (D4). Needs: which models have a real figure, and what to do for
   the rest rather than silently using 128k.
2. **A token count for the assembled request.** Nothing counts today (D1). Needs:
   a counting strategy, and whether it is exact or estimated — and if estimated,
   the error bound, because a budget that can be wrong by 15% is not a budget.
3. **An explicit output reservation.** Absent (D2). Needs: a per-model figure and
   whether the user can set it.
4. **A size classification per context category.** The inventory in §B is a
   *presence* table; a budget needs *sizes*, and the categories are not currently
   separable — one assistant message carries reasoning, text and N tool parts in
   a single stored blob.
5. **A server-side size bound on tool results, decided per source.** D5 is the
   sharpest case: the bound is currently React-only, so the model sees more than
   the reader does.
6. **A defined overflow behaviour.** D3: today the user gets a generic failure and
   cannot tell context from config from auth. A budget needs to know what to do
   *before* that point, not only how to report it after.
7. **The invariants in §C as constraints, not as trivia.** Compaction that drops a
   tool result or an unexpired approval decision is worse than no compaction —
   `approval-lifecycle.test.ts` and `prune-messages.test.ts` (15 pass) already
   encode this and would become the safety net.
8. **A rule for partial assistant turns (D7).** A budget cannot reason about
   content that may be a fragment of a dead run; this needs a decision before
   budgeting, not after.
9. **A rule for `data-*` and reasoning (D6, D9).** Both are in stored history; one
   is currently dropped by omission and one re-sent unconditionally. A budget
   needs to know which is intended.
10. **A client/server reconciliation story (D10).** The server cannot budget a
    context it does not assemble. Either the server must re-read and own
    assembly, or the budget is advisory to the client. That is the decision this
    phase exists to inform.

---

## Verification run

| Check | Result |
|---|---|
| `bun test tests/unit/prune-messages.test.ts` | 15 pass / 0 fail |
| `bun test tests/integration/approval-lifecycle.test.ts` | 8 pass / 0 fail |
| `bun test tests/integration/phantom-assistant-shell.test.ts` | 12 pass / 0 fail |
| `bun test web/src/components/ChatWindow.tool-output-once.test.ts` | 3 pass / 0 fail |
| Live DB probe (read-only) | 47 conversations, 0 system prompts, 21 messages, 0 MCP servers |

No repository file was modified.

## Files inspected

`src/lib/prune-messages.ts` (full), `src/lib/model-messages.ts` (full),
`src/routes/chat.ts` (context assembly, tools, resume, cancel, streaming, system
directives), `src/services/ai.ts` (provider/protocol selection),
`src/routes/chat-provider-options.ts` (reasoning options),
`src/services/storage/index.ts` (message persistence and reads),
`src/db/index.ts` (schema), `src/lib/validation.ts` (request/message schemas),
`src/lib/errors.ts`, `src/lib/redact.ts`, `src/lib/message-persistence-policy.ts`,
`src/services/chat-streams/` (finalizer, reconciler, resumable store),
`src/services/chat-runs.ts`, `src/services/mcp/manager.ts`,
`src/services/modelDiscovery.ts`, `src/config/providers.ts`,
`src/services/scheduler/schedulerExecution.ts`, `src/tools/index.ts`,
`web/src/runtime.ts`, `web/src/adapters/threadHistoryAdapter.ts`,
`web/src/config/modelContext.ts`, `web/src/components/context-ring.tsx`,
`web/src/tools/body-budget.tsx`, `web/src/lib/text-budget.ts`,
`node_modules/ai/dist/index.js` (converter + stream internals),
`node_modules/@opencode/client/dist/promise/client.d.ts`.
