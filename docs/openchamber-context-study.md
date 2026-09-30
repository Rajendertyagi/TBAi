# OpenChamber Context & Subagent Architecture Study

**Status:** architectural study only. No file in `D:\Temp\openchamber` or
`D:\Temp\ai-chat-app` was modified. No implementation proposed.

**Method:** read-only inspection, `node_modules` excluded from all searches.
Claims are marked **VERIFIED** (read in code), **INFERRED**, or **UNKNOWN**.

**Correction to my own preliminary brief:** I told the sub-agents this repo has
"no server package". That is misleading. There is a substantial server at
`packages/web/server/` (~50 modules: `lib/opencode`, `lib/session-goal`,
`lib/message-queue`, `lib/notifications`, `lib/permission-auto-accept`,
`lib/context-obligatory`, `lib/session-knowledge`, `lib/openchamber-sessions`,
`lib/small-model`, `lib/scheduled-tasks`, …). There is no `packages/server`
directory, which is what my initial path search found — the conclusion I drew
from it was wrong. This matters: OpenChamber has a real backend, and that backend
does more than pass text through.

---

## 1. Executive Summary

**The single most important finding: OpenChamber does not assemble model context
and cannot.** It sends one authored text per turn to OpenCode's `session.prompt`
API. It has no code path that builds a message array, no tokenizer, and no
history pruning. The transcript, the tool loop, the system prompt, the context
window and compaction are **OpenCode's**.

The proof is structural, not inferential — the request body of the one call that
sends user content contains no `messages` array and no parts array:

```ts
// packages/ui/src/lib/opencode/client.ts:1130-1141  — VERIFIED
this.clientFor(params.directory).session.prompt({
  sessionID: params.id,
  id: messageId,
  text: params.text,                                    // ← the entire model input
  files: ..., agents: ..., skills: ..., metadata: ..., delivery: ...
})
```

A search for `messages:` in `client.ts` returns **zero matches**. Four outbound
content calls exist — `session.prompt`, `session.synthetic`, `session.command`,
`session.shell` — and none accepts a parts array. VERIFIED.

Against that baseline, the interesting part is what OpenChamber *does* own, and
it is more than "a renderer":

- **MCP server configuration** (CRUD over `mcp.servers` in `opencode.json`).
- **Permission auto-accept policy**, including inheritance by nearest ancestor.
- **Post-compaction re-injection** (`context-obligatory`) — it re-sends pinned
  messages after OpenCode compacts, because compaction destroys the pinned
  context the tab still believes exists.
- **A "project knowledge" block** injected as a synthetic message on every send.
- **Goal Mode**, a real token-budgeted autonomous continuation loop.
- **Parent-idle compensation** — OpenCode idles a parent while a background
  child works, so everything treating idle as "done" must be corrected.

So the correct one-line characterisation is: **OpenChamber is a context
*contributor* and a context *observer*, never a context *assembler*.** It
manages what gets *added* to the model's context and it *displays* what OpenCode
reports, but it cannot see or bound the assembled request.

### Layer taxonomy — the distinction the brief demands

| Layer | Exists in OpenChamber? | Primary example |
|---|---|---|
| 1. UI/display truncation | **Yes, extensively** | `capToolOutputText` (512 KiB), reason preview (80 chars), tray labels, notification bodies |
| 2. Stored-data truncation | **Yes** (bounded caches/queues) | localStorage session snapshot cap 50; in-memory session cache 20; idle eviction 5 min |
| 3. Serialized-request truncation | **Yes, a handful — none for tool output** | message-queue 200 k chars; document extraction 500 k chars; knowledge block 8 000 chars; SDK guest clamps |
| 4. **Actual model-context management** | **NO** | compaction, summarization, pruning, window packing → **delegated to OpenCode** |

Layer 4 does not exist here. That is the honest headline.

---

## 2. Repository Architecture Relevant to Context

Monorepo `openchamber-monorepo@2.0.4`, workspaces under `packages/`:
`ui`, `sdk`, `web`, `vscode`, `electron`, `mobile`, `extensions`, `docs`.

| Component | Context-relevant role |
|---|---|
| `packages/ui` | React client. Sends prompts, consumes OpenCode events, holds in-memory message/part state, renders. **Never builds model input.** |
| `packages/web/server` | Local backend. Proxy + event fan-out (WebSocket/SSE) + OpenChamber-owned state: MCP config, permission policy, knowledge block, goal loop, message queue, scheduled tasks. |
| `packages/sdk` | Embedded SDK + host/guest protocol. **Contains real request-side clamps** (see §4.4). |
| `packages/vscode`, `electron`, `mobile` | Host shells. No context ownership. |
| `packages/extensions` | Extension host. Guest protocol, clamped payloads. |

**There is no database.** Searches for `indexedDB`, `idb`, `better-sqlite3`,
`drizzle`, `sqlite` under `packages/ui/src` return only *file-type icon names*
(`lib/fileTypeIconIds.ts`). No ORM anywhere in the client.

### Where state lives

| State | Location | Persisted? |
|---|---|---|
| Message/part data | Zustand `State.message` / `State.part` (`sync/types.ts:63-64`) | **No** — memory only |
| Session list | localStorage, capped 50 (`sync/persist-cache.ts:18,65`) | Yes |
| OpenChamber session metadata (goal, pins, cursors) | OpenCode session metadata, `metadata.openchamber` | Yes, in OpenCode |
| Pending outbound messages | `message-queue.json` on the server | Yes |

`persist-cache.ts:1-8` states it outright: *"VCS info, project metadata, icons,
and a bounded session-list snapshot are cached… **Message/part data is always
loaded from the server.**"* The persisted key union is closed at
`persist-cache.ts:65`: `"vcs" | "projectMeta" | "icon" | "sessions"`. VERIFIED.

---

## 3. Context Assembly Flow

```text
USER TYPES
   │
   ▼
ChatInput.tsx → session-ui-store.sendMessage → routeMessage
   │
   ▼
OpencodeService.sendMessage                   client.ts:1128-1142
   │   session.prompt({ sessionID, id, text, files?, agents?, skills?, metadata?, delivery? })
   ▼
┌──────────────────────────────────────────────────────────────────┐
│  OPENCHAMBER  — hands over one text string. STOPS HERE.          │
└──────────────────────────────────────────────────────────────────┘
   │
   ▼
OpenCode server  (not in this repository)
   │  • owns the transcript
   │  • owns the system prompt
   │  • runs the tool loop
   │  • applies the context window
   │  • performs compaction
   ▼
provider
   │
   ▼
events flow BACK:  session.reasoning.* / session.tool.* / message.part.delta
   │
   ▼
packages/web/server  event-stream  (SSE upstream → WebSocket downstream)
   │  DOCUMENTATION.md:53 — OpenCode 2.x sends no SSE `id:`; id is payload.id
   ▼
ui/sync/event-reducer.ts   — builds Zustand state
   │
   ▼
renderers (ToolPart.tsx, ReasoningPart.tsx, …)  — DISPLAY ONLY
```

**Owner of context assembly: OpenCode.** VERIFIED by absence — OpenChamber
contains no `toModelMessages`, no `convertToModelMessages`, no `ModelMessage`
construction, and no system-prompt concatenation.

### Attached context — prepended as synthetic messages

Context the user attaches does not go in the prompt body. It is sent as
**preceding `session.synthetic` messages** (`client.ts:1114-1127`, body
`{ sessionID, id, text, description?, metadata?, delivery?, resume: false }`).
The comment at `client.ts:1178-1179` explains why: *"so the command template
still expands on the server with the context already in the transcript."*
VERIFIED.

### System prompt

**OpenCode owns it.** OpenChamber has no system-prompt assembly for the chat
path. Two injections exist and both are *synthetic user-side text*, not system
messages:

1. **Project knowledge block** — `packages/web/server/lib/session-knowledge/runtime.js`.
   Built by `buildKnowledgeText` (`:26-28`), **truncated to
   `KNOWLEDGE_MAX_LENGTH = 8000`** (`:22`), dispatched as synthetic
   (`message-queue/runtime.js:536-543`).
2. **Pinned context re-injection** — `context-obligatory/runtime.js`, §11.

The motivation for (1)'s sibling design is documented at
`session-knowledge/runtime.js:11-16`: a browser-held signature *"survives
compaction: the tab goes on believing the agent still has context that has just
been summarised away."* The fix is a server-side cursor.

---

## 4. Context Budget & Token Management

### 4.1 No token counting anywhere

VERIFIED. Searched repo-wide for `countTokens`, `estimateTokens`, `tiktoken`,
`gpt-tokenizer`, `encoding_for_model`. The only `tokenize` matches are
CodeMirror/Markdown **lexers** (`composerHighlight.ts:2`, `markdownCore.ts:389`)
— text highlighting, unrelated to LLM tokens. There is no tokenizer dependency.

**Every token number is server-reported and passed through.**
`stores/utils/tokenUtils.ts` sums and formats it:

- `sumTokenBreakdown` (`:16`) — `input + output + reasoning + cache.read + cache.write`
- `contextTokensFromBreakdown` (`:42`) — prefers server `tokens.total`
- `findLatestContextFill` (`:87`) — walks back to the newest assistant message
  reporting tokens; returns `'compacted'` if a `role:'compaction'` message is newer
- `buildSessionContextUsage` (`:108`) → `{ percentage, thresholdLimit, normalizedOutput }`
- `computeCacheHitRate` (`:203`) — `cache.read / (input + cache.read + cache.write)`

All **display**. VERIFIED.

### 4.2 The only two places tokens drive behaviour — and neither is a context guard

**(a) Goal Mode budget** — `packages/web/server/lib/session-goal/runtime.js:729`:

```js
if (typeof goal.tokenBudget === 'number' && tokensUsed >= goal.tokenBudget) {
  await settleGoal({ ..., status: 'budgetLimited', statusReason: 'token budget reached' });
  return;
}
```

VERIFIED. This is a **stop condition for autonomous continuation turns**, not a
context-window guard. It does not prune, does not shrink a prompt, does not
refuse a user send. Sibling hard stops: `MAX_AUTO_TURNS = 20` (`:65`),
`AUDIT_FAIL_LIMIT = 2` (`:69`). Budget range validated to 1 000 – 100 000 000
(`openchamber-sessions/routes.js:48-49`).

Documented undercount: `runtime.js:663-669` notes the summarization call's own
tokens are reported as 0.

**(b) Small-model input char budget** — `packages/web/server/lib/small-model/index.js`:
`DEFAULT_CONTEXT_TOKENS = 64_000` (`:58`), `OUTPUT_RESERVE_TOKENS = 4_000`
(`:66-73`), `maxChars = (context − reserve) × 4` (a **chars-per-token
heuristic**), applied by `clampPromptToModelLimit` (`:93-105`) which truncates
(`prompt.slice(0, maxChars) + '…'`, `:104`) or throws 413 `context-too-small`.
VERIFIED.

**This is the only real output-token reservation in the repository, and it
applies to utility prompts — walkthrough digests, goal audits, notification
text — not to chat.** The chat path sets no output cap at all.

### 4.3 Context window — display denominator only

The number is **per-model, per-session, and comes from OpenCode's model
catalog** — there is no local table. VERIFIED chain:

1. `stores/useConfigStore.ts:498-583` — `limit?: { context, output }` from `GET /api/model`
2. `types/index.ts:33` — `limit?` on the model type
3. `hooks/useContextWindowLimits.ts:24-53` — precedence: session record's model → newest answering model's → composer selection. Docstring `:12-23` explains why the session record must win: under Auto the composer names no real model.
4. `lib/routing/contextWindowLimits.ts` — `limitsForAnsweringModel`

Every consumer is a readout — `Header.tsx:389`, `VSCodeLayout.tsx:731`,
`WorkStatusPrimaryGroup.tsx:165`, `MiniChatLayout.tsx:160`,
`ContextUsageDisplay.tsx:85`, `MobileSessionMetadata.tsx:404`,
`contextStore.ts:204-299` `getContextUsage`.

**VERIFIED: no branch anywhere refuses, degrades, or queues a send on high
fill.** `getContextUsage` returns a percentage; that is all it does.

Fallback denominators when the model reports nothing:
`DEFAULT_THRESHOLD_LIMIT = 200_000` (`tokenUtils.ts:105`),
`DEFAULT_CONTEXT_LIMIT = 200_000` (`work-status/contextUsage.ts:31`).
`stores/utils/contextUtils.ts:10-12` computes
`effectiveOutputReservation = Math.min(…, 32000)` and
`thresholdLimit = context − normalizedOutput` — **purely for the progress ring.**

### 4.4 Layer-3 truncation — every real request-side clamp

| Location | Constant | Value | What it actually does |
|---|---|---|---|
| `lib/message-queue/runtime.js:24,125` | `CONTENT_CHAR_LIMIT` | 200 000 | **Rejects (400)** an over-long queued message. Does not truncate. Queue admission, not prompt shaping. |
| `lib/small-model/index.js:66-105` | derived | `(ctx−4k)×4` chars | Truncates/413s a *utility* prompt. Not chat. |
| `lib/session-knowledge/runtime.js:22` | `KNOWLEDGE_MAX_LENGTH` | 8 000 | **Truncates the knowledge block injected on every send.** Real context loss, bounded to notes/plans/memory index — not the conversation. |
| `ui/src/sync/document-attachments.ts:13,650` | `MAX_EXTRACTED_TEXT_CHARS` | 500 000 | Truncates text extracted from .docx/.pptx/.xlsx/.odt before it becomes a prompt attachment. **Affects the request.** |
| `sdk/src/contract.ts:350-394` | `GUEST_*_MAX` set | 8k–2M | Clamps extension/guest payloads. `GUEST_GENERATE_OUTPUT_TOKENS_MAX = 4_000`; `GUEST_GENERATE_SYSTEM_MAX = 8_000`. |
| `lib/walkthrough/digest.js:4-7` | — | — | **Explicitly refuses to truncate.** Comment: *"a diff that does not fit the model's context is refused upstream"*. |
| `ui/src/components/chat/message/toolRenderers.tsx:35` | `TOOL_OUTPUT_MAX_CHARS` | 512 KiB | **RENDER ONLY** — see §6.1. |

### 4.5 What does not exist — searched and confirmed absent

VERIFIED absent: `historyLimit`, `maxMessages`, `messageLimit`, `condense`,
`elide`, any summarization model call touching history, any pre-flight context
check on the chat path, any retry-on-context-error, any local model-limit table.

**Not a single one of the `prune*` hits is history pruning.** They are
record-set maintenance: `pruneNotificationClaims`, `pruneMissingRepositories`,
`pruneSessionStatusRecords`, `pruneExpiredPending`, `pruneUiVisibility`.

---

## 5. Pruning / Compaction

### 5.1 Client-side history pruning does not exist

VERIFIED absent: no `historyLimit`, no `maxMessages`, no `messageLimit`, no
`condense`, no `elide`, no client-side summarization of the transcript.

**`compact()` in `event-reducer.ts` is a Zustand object-compaction helper, not
conversation compaction.** It is imported from `@/lib/opencode/model`
(`event-reducer.ts:3`) and used at `:200, 208, 217, 262, 278, 677` to strip
`undefined` keys from store updates. The name is a genuine collision hazard.
VERIFIED.

### 5.2 Compaction is OBSERVED, never PERFORMED — except one re-injection

OpenCode compacts. OpenChamber has exactly three reactions, all reactive:

**(a) Render a compaction card** — `sync/event-reducer.ts:159-163`
`findRunningCompaction`, `:458-461` (a settled compaction settles the running
record), `:524-531` (`message.compaction.delta` grows the running summary).
Display only.

**(b) Invalidate the context readout** — `stores/utils/tokenUtils.ts:87-103`.
`findLatestContextFill` returns `{state:'compacted'}` when a finished
`role:'compaction'` message is newer than any measured assistant message,
because *"a compaction's own assistant record describes the summarizing request,
not the window left behind"* (`:76-79`). The ring then shows unknown rather
than a stale number. The docstring is explicit: *"No number is right until the
next response reports tokens."*

**(c) Re-inject pinned context — the one real context-management behaviour
here.** `packages/web/server/lib/context-obligatory/runtime.js`:

```text
createContextObligatoryRuntime   :42
processPayload  → early-return unless payload?.type === 'session.compacted'  :159-168
tick  :70  → re-fetch pinned messages from OpenCode  :111-126
      → buildContextPrompt     :20-32
      → POST /api/session/{id}/synthetic  :135-144
idempotency: cursor context_obligatory_last_compaction_message_id  :109, :149-155
```

Pinned entries store only `{id, createdAt, role}` — **never the body**
(`:10-16`); text is re-fetched from OpenCode per pin (`:112-115`). Tested at
`runtime.test.js:78-96` (*"re-sends pinned messages after a finished compaction
and records the cursor"*) and `:96-105` (idempotency).

**This ADDS text to the context. It is not a compaction, prune, or budget.**

### 5.3 Summarization: the model path is RETIRED

VERIFIED — `packages/web/server/lib/text/summarization.js:119-122`:

```js
export async function summarizeText({ text, threshold = 200, maxLength = 500, zenModel, mode = 'tts' }) {
  const summary = fallbackByMode(text || '', maxLength, mode);   // local
```

`zenModel` is accepted and **never used**. The model-backed provider is retired:
`tts/routes.js:89-90` — *"Historical summarize request fields are intentionally
ignored. The model-backed summarization provider is retired."* Tests confirm
(`routes.test.js:76-108`, `summarized: false`,
`reason: 'Model summarization provider unavailable'`).

**Dead config remains:** `useConfigStore.ts:3528-3529` still clamps
`summarizeMaxLength` to `[50, 2000]`; `useUIStore.ts:1015` still carries
`maxLastMessageLength`. These settings do nothing.

The only model calls in the repo are (i) the small model for utility prompts
and (ii) the goal-progress audit (`session-goal/runtime.js:464-501`).
**Neither summarizes conversation history.**

---

## 6. Tool & MCP Context Handling

### 6.1 `capToolOutputText` — confirmed RENDER-ONLY, independently verified

```ts
// packages/ui/src/components/chat/message/toolRenderers.tsx:35-47  — VERIFIED
export const TOOL_OUTPUT_MAX_CHARS = 512 * 1024;
export const capToolOutputText = (output: string, maxChars = TOOL_OUTPUT_MAX_CHARS) => {
  if (typeof output !== 'string' || output.length <= maxChars) return output;
  const omitted = output.length - maxChars;
  const notice = `\n\n… [output truncated: ${omitted} more characters not shown to prevent the renderer from running out of memory]`;
  return output.slice(0, maxChars) + notice;
};
```

**I enumerated every call site myself.** Excluding tests, there are exactly
**two**:

1. `parts/ToolPart.tsx:564` — inside the tool-output render component
2. `parts/taskToolModel.ts:224` — a view-model builder for the subagent card

It is not imported by any store, any `sync/` module, `client.ts`, or any server
file. It is unreachable from the send path. The docstring at `:27-34` and the
tests (`toolRenderers.test.ts:11` — *"issue #2265 renderer OOM guard"*) state the
purpose: preventing a V8 **Zone Allocation failure** when a huge tool output is
parsed, highlighted and attached to the DOM. The truncation notice says "not
shown", not "not sent".

**Layer 1. There is no request-side bound on tool output anywhere.**

### 6.2 Arrival and representation

`ui/src/lib/opencode/events.ts:211` `translateWireEvent` maps:

| Wire event | Translation |
|---|---|
| `session.tool.input.started` / `.delta` / `.ended` | `pending` state (`model.ts:312`) |
| `session.tool.called` | `running` — carries `input`, `start` |
| `session.tool.progress` | `running` + `metadata` |
| `session.tool.success` | `completed` — `output`, `attachments`, `metadata`, `end` |
| `session.tool.failed` | `error` — `error`, partial `output` |

Part union — `ui/src/lib/opencode/model.ts:357`:
`TextPart | ReasoningPart | FilePart | AgentPart | ToolPart`.
Tool state machine — `model.ts:310-344`: `pending | running | completed | error`.

`projection.ts:92-98` `toolOutputText()` flattens output to a string, keeping
only `type === "text"` content items. File items are lifted to `attachments`
(`:100-118`). **Non-text tool output is dropped from the domain model at the
projection boundary** — a display-fidelity loss, not a context one.

### 6.3 Can tool output be re-sent? NO — structurally

VERIFIED. The only outbound content calls are `session.prompt`
(`client.ts:1130-1141`), `session.synthetic` (`:1116-1126`, `:1199-1209`),
`session.command` (`:1212-1220`), `session.shell` (`:1239-1241`). None accepts a
messages or parts array; all take authored `text`. Server-side equivalents
confirm: `message-queue/runtime.js:506-566`,
`openchamber-sessions/routes.js:612-640`, `scheduled-tasks/runtime.js:504-513`,
`context-obligatory/runtime.js:135-144`.

**Deduplicated: no. Summarized: no. Re-fetched: no.** There is no
content-dedup keyed on `callID`, no route to re-execute a tool, no route to
re-read a result by id.

The only way tool output can influence a future request is (i) OpenCode
re-reading its own persisted transcript, or (ii) an OpenChamber-authored text
that *quotes* a result. **(ii) happens — and drops tool parts.**
`context-obligatory/runtime.js:117-124` filters `part?.type === "text"` when
re-injecting pinned messages. `session-goal/runtime.js:261-267`
`messagePartsToText` is likewise text-only (used for audit, not injection).

### 6.4 Approvals are NOT in message history

**There is no permission/approval part type.** The `Part` union has no such
member. Permissions live in a separate store slice,
`State.permission: Record<string, PermissionRequest[]>` (`types.ts:58`), keyed
by session, never serialized into `message`/`part`. VERIFIED.

State machine as the code shows it:

```text
[no entry] --permission.asked-->  pending
pending    --permission.replied--> [entry removed]
pending    --permission.get 404---> [resolved]    client.ts:1455-1463
pending    --permission.get err---> [unknown]     must fail closed
```

| Transition | Mechanism | Location |
|---|---|---|
| enter | `permission.asked` → Binary.search insert-or-replace | `events.ts:768-769` → `event-reducer.ts:681-693` |
| exit | `permission.replied` → splice removal | `events.ts:770-771` → `event-reducer.ts:695-707` |
| answer | `POST /permission/reply` `{sessionID, requestID, decision, message?}` | `client.ts:1393-1408` |
| list all | `permission.request.list`, deduped by id | `client.ts:1471-1481` — **throws on failure by design**, so reconnect resync never conflates "failed" with "none pending" |
| create | returns `null` on any failure | `client.ts:1418-1448` — documented as *"unknown — do not act"* |

Decisions: `"once" | "always" | "reject"` (`model.ts:366`).

`form.*` (OpenCode v2's question mechanism) is a parallel machine
(`form.created` / `.replied` / `.cancelled` → `types.ts:60`). A pending
permission **or** form means "not working" (`useAssistantStatus.ts:11`) and
suppresses interrupted-turn marking (`sync-context.tsx:2155-2156`).

### 6.5 MCP: configured here, protocol not implemented here

OpenChamber **owns MCP server configuration** and **proxies MCP runtime
status**. It does not implement the protocol. VERIFIED.

- **Config CRUD** — `packages/web/server/lib/opencode/mcp.js`: `validateMcpName`
  (`:29-36`), layer precedence custom > project > user-override > user
  (`:52-59`), full CRUD (`:61-169`). Always writes the v2 `mcp.servers` shape
  (`:19-24`). v1 `mcp.<name>` is read and rewritten in place.
- **Shape conversion** — `config-v2.js`: `toMcpTimeout` (`:381`),
  `MCP_PROTOCOLS = {legacy, auto, 2026-07-28}` (`:394`), `toMcpProtocol` (`:397`),
  `toMcpOAuth` (`:402`), `toMcpEntity` (`:428`), `readLayeredMcpEntries` (`:505`).
- **REST** — `config-entity-routes.js:168-249` → `/api/config/mcp[/:name]`.
- **Runtime** — `client.ts:1683-1693`: `mcp.list`, `mcp.connect`, `mcp.disconnect`
  are **passthroughs**. `useMcpStore.ts:36-40` status vocabulary:
  `connected | failed | needs_auth`. Event `mcp.status.changed` (`:782-783`) →
  `event-reducer.ts:737-740`, which **refetches rather than patches** (returns
  `false`).

**MCP tool results take the identical path as native ones.** There is no MCP
branch in the tool path — `tools.ts:12-15` states the design: *"Names that are
not in this list (MCP servers, OpenChamber's own plugin tools) still flow through
the generic renderers."* VERIFIED.

**Resources and prompts never reach the model, and are explicitly discarded:**

```ts
// events.ts:832-835  — VERIFIED
// Resources of an MCP server; OpenChamber shows connection status only
case "mcp.resources.changed":
  return []
```

No `resources/list`, `resources/read`, `prompts/list` or `prompts/get` call
exists in `packages/ui/src` or `packages/web/server`. The `mcp__` prefix returns
**zero matches repo-wide**.

**Code Mode** (`codemode?: boolean` per server, `useMcpConfigStore.ts:89,99`) —
"Expose the server's tools through Code Mode instead of one tool each."
OpenChamber's side is the `execute` tool renderer: `tools.ts:70-74`
`isExecuteTool`, `:221-240` `executeToolCalls` (display-capped at
`MAX_EXECUTE_CALL_INPUT_LENGTH = 160`), `:331-341` `describeExecute`
(`MAX_DESCRIBED_TOOL_CALLS = 4`). **The JS execution and the MCP invocations are
OpenCode's.**

---

## 7. Reasoning / Thinking Content Handling

VERIFIED throughout.

**Representation** — `model.ts:289-293`:

```ts
export type ReasoningPart = PartBase & { type: "reasoning"; text: string; time: { start: number; end?: number } }
```

Two fields. **No `signature`, no `redacted`, no `providerMetadata`, no provider
part-id.**

**Arrives** via `session.reasoning.started | .delta | .ended` (`events.ts:556-590`),
using the same `message.part.delta` field-`"text"` machinery as text parts.
**History path:** wire `content[]` item → `projection.ts:214-226`
`projectAssistantContent`, id from `partIds.reasoning(messageID, ordinal)`.

**Stored:** yes, in `State.part[messageID]` — the same in-memory store as text
(`event-reducer.ts:634-646`). Not persisted to localStorage.

**Rendered:** `parts/ReasoningPart.tsx`. `SUMMARY_MAX_CHARS = 80` (`:38`) bounds
**only the collapsed header preview**; the expanded body renders full
`part.text`. `useStreamingTextThrottle` (`:13`) throttles cadence only.

**Re-sent: NO.** No reasoning field appears in any outbound body. The prompt
path cannot carry a reasoning part because it cannot carry a parts array at all.
VERIFIED.

**Signatures / encrypted content: NONE handled.** Zero matches for
`providerMetadata` or `providerOptions` in `packages/ui/src` or
`packages/web/server`. Zero matches for `redacted` / `redactedThinking` /
`encrypted` in the opencode lib or sync path. (`REDACTED` appears only in HAR
sanitization, `sync/attachment-files.ts:207-334`; `signature` only as
`hasValidImageSignature` for PNG/JPEG magic bytes.)

**One exception worth naming:** the literal string
`reasoning.encrypted_content` appears once, in
`ui/src/components/.../custom-provider-form.ts:187-198` `customVariantOverlay`,
written as a **static config value** into `opencode.json`:

| Protocol | Overlay |
|---|---|
| `openai-chat` | `{ settings: { reasoningEffort } }` |
| `openai-responses` | `{ settings: { reasoningEffort, reasoningSummary: 'auto', include: ['reasoning.encrypted_content'] } }` |
| `anthropic-messages` | `{ settings: { thinking: { type: 'adaptive', display: 'summarized' }, effort } }` |

That is configuration handed to OpenCode, not a per-turn signal.

---

## 8. Context Caching

### 8.1 Provider prompt caching: VERIFIED ABSENT

Searched `cache_control`, `cacheControl`, `prompt_cach`, `cachedContent`,
`cache_creation`, `ephemeral` across all packages. **Not one occurrence of an
Anthropic `cache_control` or any equivalent is ever sent.** VERIFIED.

I independently re-ran a narrower search (`cache_control|cacheControl|promptCach|cachedContent|ephemeral_`)
and got 11 hits, **all unrelated**: i18n message strings (`nl.ts:3303`), a
`config-v2.d.ts` type stub, and `tunnels/providers/{cloudflare,grok,index}.js`
— cloudflared/grok tunnel binaries. Zero context-caching hits.

Every `cache_read` hit is **cost/usage display data**, not control:
`types/index.ts:30` (a cost field), `useConfigStore.ts:495,580` (a $/M price),
`config-v2.js:598` (normalizing a cost table), `config-v2.test.js:361` (fixture).

`vscode/src/quotaProviders.ts:31,48-49,165` uses `*_limit` for
**quota/rate limits** — unrelated.

### 8.2 What *is* called "cache" is memoization — stated explicitly

| Mechanism | Location | What it caches |
|---|---|---|
| Zustand + `useMemo` | `useContextWindowLimits.ts:45`, `contextStore.ts:204`, `tokenUtils.ts:137` | derived percentages, keyed by `lastMessageId` |
| Session prefetch cache | `sync/session-prefetch-cache.ts` | pre-fetched message pages, in memory |
| Session cache retention | `sync/session-cache-retention.ts:34` | in-memory message arrays, **whole-session eviction** |
| localStorage | `sync/persist-cache.ts` | only `vcs`/`projectMeta`/`icon`/`sessions` |
| `@tanstack/react-virtual@3.14.5` (`ui/package.json:54`) | — | list windowing — **the only TanStack package; there is no react-query** |
| SWR / `persist` middleware | — | **absent** |

**None of this is prompt caching.** There is no cache key, no TTL, and no
invalidation for a provider prompt cache, because none is controlled here.
Prefix-cache behaviour is OpenCode's and is only **measured**
(`tokenUtils.ts:203` `computeCacheHitRate`).

### 8.3 The one cache-key-like mechanism — and why it exists

`packages/web/server/lib/session-knowledge/runtime.js:34-45`
`buildKnowledgeSignature` builds a content-identity string from `id:updatedAt`
of every note/plan/memory entry plus `m:on:c|p`. Compared at `:283`
(`signature === deliveredSignature` → send nothing). Stored at
`KNOWLEDGE_METADATA_KEY = 'knowledge_context_delivered'` (`:18`).

This is a **dedup key for a text block OpenChamber injects**, not a provider
cache. The comment at `:320-327` is the interesting part: the signature is
written **only after the send is accepted**, so a failed send does not falsely
mark context as delivered.

**It is not invalidated by compaction** — and that is the bug it was built to
fix. From `:11-16`: a browser-held signature *"survives compaction: the tab
goes on believing the agent still has context that has just been summarised
away."* The fix is the server-side cursor in `context-obligatory`.

---

## 9. Subagent Context Architecture

### 9.1 Two concepts that must not be conflated

**(a) OpenChamber's "agent" = a named persona/config.** `model.ts:48`:
`export type Agent = Omit<AgentInfo, "name"> & { name, displayName, mode, model, description, color, hidden, disabled, permissions, steps, request }`.
`mode` is the discriminator — `'primary' | 'subagent' | 'all'`
(`config-v2.js:307`, `AgentsPage.tsx:510-512`).

**(b) An OpenCode child session = operationally "a subagent".** A session **is** a
subagent iff `session.parentID` is truthy — `sync-context.tsx:1560-1570`
`isSubtaskSession()`. `model.ts:113` `parentID?: string`.

The v2 tool is named **`subagent`**, not `task` (`tools.ts:36`, with `tools.ts:5-6`
documenting the rename). `taskToolModel.ts` / `TaskToolSummary` are legacy v1
names retained for both.

`subagentType` does not appear anywhere. `delegation` appears only in prose in
`.opencode/agent/pr-review-bot.md:25` and `.agents/skills/triage-prs/SKILL.md:47`.

### 9.2 Creation: OpenChamber CANNOT create a subagent — proven structurally

OpenChamber's only session-creation chain:
`session-ui-store.ts:1995` → `:938` → `:953` → `session-actions.ts:942-989` →
`client.ts:811-830`. The body:

```ts
// packages/ui/src/lib/opencode/client.ts:816-828  — VERIFIED
this.clientFor(directory).session.create({
  id, title, agent, model, location, metadata
})
```

**No `parentID`. No `children`. No `subagent`. No `prompt`.** Six keys, none of
which can express parentage. I confirmed by search that no `session.create` call
site anywhere passes `parentID` — every `parentID` hit is a *read* of an
incoming session, a test fixture, or an unrelated `createFolder(parentId)`
sidebar call. VERIFIED.

**Corroborated server-side** — `openchamber-sessions/routes.js:463-465`:

```js
if (!isPrimaryAgentMode(agent.mode)) {
  throw new OpenChamberControlError(
    `Agent '${requestedAgent}' is a subagent and cannot receive a prompt directly`, 400);
}
```
`isPrimaryAgentMode` at `:71` accepts `undefined | 'primary' | 'all'`.

**What does create children:** OpenCode's model-side `subagent` tool call, and
OpenCode's own `subagent: true` command jobs. The single best doc comment in the
repo is `ui/src/lib/opencode/subagent-run.ts:1-14`:

> *"OpenCode 2.x runs a command configured with `subagent: true`, and a
> `subagent` tool call with `background: true`, as a job in a child session. The
> parent's transcript gets nothing when the job starts. When the job settles,
> **OpenCode appends one synthetic message** whose metadata names the child
> (`source: "subagent"`) and whose text wraps the result in a `<subagent …>`
> envelope (core `session/subagent-completion.ts`)."*

OpenChamber's only role in the command path is **writing config**:
`config-v2.js:340-348` persists `subagent: true`; `useCommandsStore.ts:408,471`
round-trips it. Then an ordinary `session.command` runs.

### 9.3 What a child receives: **nothing from OpenChamber**

The `subagent` tool's `input` is **model-authored**, not client-authored —
`tools.ts:118-143` `inputSchema` only *reads* `agent`/`description`/`command`;
it never constructs them.

A child gets (per `subagent-run.ts:1-14`):
- its own fresh session, `parentID = <parent>`
- the tool call's `input` as its task
- `input.agent` as its persona (`taskToolModel.ts:52`)
- `input.description` as its title (`taskToolModel.ts:54`)

A child does **NOT** get: the parent transcript (`subagent-run.ts:7` — *"The
parent's transcript gets nothing when the job starts"*), any filtered message
list, parent attachments, or any OpenChamber-composed context.

**OpenChamber's only two context-admission paths target the PARENT** —
`session.synthetic` before a command (`client.ts:1178-1210`), deliberately
pre-parented so the command template expands server-side with context already in
the transcript.

**Inherits the chat's model**, not OpenChamber's choice —
`.agents/skills/triage-prs/SKILL.md:47`.

### 9.4 Result return: three envelopes, all unwrapped client-side for DISPLAY

**Correction to a hypothesis I carried from earlier work.** I had recorded that
OpenCode strips `<task_result>` *server-side*. That is wrong about the location.
The tag is unwrapped **client-side, in the UI, for Markdown rendering** —
motivated by a parser bug, not by summarization.

Only one production file contains it:
`parts/taskToolModel.ts:189-224`. Comment at `:191-198`:

```
// OpenCode wraps a completed task result in an envelope:
//   <task id="ses_…" state="completed">
//   <task_result>…result Markdown…</task_result>
// </task>
// `marked` treats the leading tag line as a raw HTML block, so the Markdown
// below it stays literal (issue #3238).
```

`packages/web/server` contains **zero** references to `task_result` /
`task_metadata` / `<subagent`. VERIFIED.

| Envelope | Regex | Location | Trigger |
|---|---|---|---|
| `<task …><task_result>…</task_result></task>` | `TASK_RESULT_BLOCK_PATTERN` | `:189` | v1 `task` |
| `<subagent sessionID=… state=…>…</subagent>` | `SUBAGENT_ENVELOPE_PATTERN` | `:212` | v2 `subagent` (issue #4066) |
| `<task_metadata>{json}</task_metadata>` | `parseTaskMetadataBlock` | `:125` | legacy v1 |

Both v1/v2 patterns are **deliberately conservative** — the v2 pattern requires
the output to be *exactly* one envelope (`^\s*<subagent…>\r?\n([\s\S]*?)\r?\n</subagent>\s*$`).
Tests pin this: `taskToolModel.test.ts:100` (*"trailing prose" must pass
through*), `:114` (*literal* `<task_result>text</task_result>` *in prose* must NOT
unwrap).

**No summarization or compression step exists.** The test is literally named
*"unwraps the task result envelope and **preserves the result Markdown exactly**"*
(`taskToolModel.test.ts:61`). The only size control is the render-time 512 KiB cap,
justified at `:218-221` as a V8 Zone crash guard (issue #2265). **Truncated,
never summarized.**

Three return paths:
1. **Foreground** — the result text is already the tool's `output` in the parent transcript.
2. **Background** — OpenCode appends `role: "synthetic"`. `subagent-run.ts:41-53` `readSubagentRun()` parses it against a zod schema: `source: literal("subagent")`, `childID`, `agent?`, `state: enum(["running","completed","error","cancelled"])`, plus `ENVELOPE` regex.
3. **Reading child messages** — `buildTaskSummaryEntriesFromSession` (`:178-182`) walks the child's own messages; `projectMessageSummaryEntries` (`:153-176`) **skips `isSubagentTool`** (`:162`) to avoid recursion.

### 9.5 Session model

`packages/ui/src/lib/opencode/model.ts:111-139` — VERIFIED complete:

```ts
export type Session = {
  id: string
  parentID?: string
  projectID: string
  directory: string
  subpath?: string
  title: string
  agent?: string
  model?: ModelRef
  cost: number
  tokens: TokenUsageInfo
  outcome?: SessionOutcome          // "succeeded" | "failed" | "interrupted"
  time: { created; updated; idle?; viewed?; archived? }
  metadata?: Metadata
  permissions?: PermissionRuleset
  revert?: SessionRevert
  fork?: { sessionID: string; boundary: SessionForkBoundary }
}
```

Projection at `projection.ts:50-69` maps all of them.

**Child listing is supported.** `client.ts:413-422` `SessionListOptions` includes
`parentID?: string | null`, wired at `client.ts:788-795`. Server-side,
`lib/opencode/session-activity.js:49-68` `fetchChildSessionIds()` pages
`GET /api/session?parentID=`, with `CHILDREN_PAGE_SIZE = 50` (`:16-17`) and
`CHILDREN_MAX_PAGES = 8` (`:17`) ⇒ **max 400 children, else `null` (unknown)**.
Comment at `:43-47`: *"v2 has no `/session/{id}/children`."*

Client-side ancestor walk: `global-session-status.ts:84-85`
`MAX_SUBAGENT_DEPTH = 8` — *"Subagents nest; a deeper chain than this is treated
as unrelated."*

---

## 10. Subagent Lifecycle & Resource Controls

### 10.1 Cancellation — no subagent-specific path

VERIFIED. There is no "stop this child" control. `client.ts:1223-1227`
`abortSession` → `session.interrupt({sessionID: id})` is per-session and
documented *"Interrupts the running turn. Resolves false when nothing was
running."* `session-actions.ts:2100-2112` `abortCurrentOperation` has no
subagent branch; `abortDescendantIfBusy` (`:443-450`) aborts by session id,
guarded by `isSessionBusyNow`.

`WorkStatusSubagentsSection.tsx:64-76` `openChildSession` **only navigates**
(`setCurrentSession` or `openContextPanelTab`). It renders **no stop control**.

**Observable consequence (reported, not a recommendation):** opening a child
yields `readOnly: true` (`:75`), and `TimelineNotice.tsx:228` sets
`canCut = !isRunningSubagentRunMessage(...)`, so a running subagent can be
opened for viewing only.

### 10.2 Concurrency cap: **VERIFIED ABSENT**

Exhaustive search for `maxConcurrent|concurrency` across `packages/` returns
hits only in unrelated modules: `child-store.ts:315` (`bootstrapConcurrency` —
directory bootstrapping), `git/service.js`, `fs/search.js:1`
(`FILE_SEARCH_MAX_CONCURRENCY = 5`), `useGitStore.ts:25`, `useCommandsStore`.
**No limit anywhere governs subagent children.**

### 10.3 Permission inheritance — implemented in OpenChamber's server

VERIFIED: inherited from the **nearest explicit ancestor**.
`lib/permission-auto-accept/runtime.js:163,171` stores `parentID` per session and
records lineage; `:226` walks `current = info?.parentID ?? null` to find the
ancestor. `DOCUMENTATION.md:21`:

> *"`permissionDefaultMode` … is written onto each new **top-level** session when
> `session.created` arrives, and only when no policy exists for it yet… **Subagents
> inherit instead.** `ask` writes nothing."*

Tests: `runtime.test.js:109` *"uses nearest explicit ancestor policy for
subagents"*; `:113-114` a **grandchild** inherits; `:120` *"keeps a subagent's
lineage when a later partial update names only its title"* — because
`session.updated` sends partial records without `parentID` (documented `:193-197`).

**Permissions are a separate per-session field, not merged** — `Session.permissions`
(`model.ts:133`) is the child's own ruleset; `WorkStatusSubagentsSection.tsx:44`
reads `state.permission[child.id]`.

### 10.4 Resource controls — full table

| Control | Verdict | Evidence |
|---|---|---|
| Output size | **Render-time only** | `taskToolModel.ts:6,222-224` — 512 KiB, V8 crash guard. Truncation, not summarization. Applied *after* transfer. |
| Child enumeration | 400 max, then `null` (unknown) | `session-activity.js:16-17` |
| Nesting depth (walk) | 8 | `global-session-status.ts:85` |
| Panel rows | doc/code drift | `work-status/DOCUMENTATION.md:354-356` claims an 8-row cap; actual code `:92` uses `max-h-56 overflow-y-auto` (a CSS height) |
| **Concurrent children** | **NONE** | §10.2 |
| Child cost/turn budget | **NONE** | no cap found |

### 10.5 Parent-idle semantics — a genuine correctness problem OpenChamber solves

`lib/opencode/session-activity.js:4-8`:

> *"A parent session goes idle while a background subagent keeps working in a
> child session. When the child finishes, OpenCode delivers its result to the
> parent, which runs again and goes idle a second time. So the parent's first
> idle is a pause, not the end of the turn: anything that treats idle as 'done'
> (goal audits, ready notifications) has to check the children too."*

Handled in: `notifications/runtime.js:33-36` `isPausedForSubagents`;
`session-goal/runtime.js:570-587`; `global-session-status.ts:121-124`
`useSessionTurnActive` and `:189-190` — *"The turn timer keeps running through a
background-subagent pause."*

### 10.6 Nesting: **available, and the code assumes it**

**Correction to a hypothesis of mine.** I had recorded that OpenCode's built-in
`general` and `explore` agents cannot spawn further agents. **This repository
does not state that** — OpenCode's built-in agent definitions (`general`,
`explore`, `build`, `plan`) are not in `openchamber`; they come from the server.
The only agent definitions here are this repo's own dev-time agents
(`.opencode/agent/`: `issue-intake`, `pr-review-bot`, `pr-reviewer`,
`provider-smoke`, `simplifier`, `summarize`). **Marked UNKNOWN** rather than
imported from outside knowledge.

What the repo *does* show — strong evidence nesting is real and multi-level:

- `global-session-status.ts:84` — *"Subagents nest"* — the comment **presupposes** nesting; it is not defensive code for a hypothetical.
- `permission-auto-accept/runtime.test.js:113-114` **tests a grandchild** (`root → child → grandchild`).
- `useSubagentCostRollup.ts:37-40,58` `countDescendants()` recurses; `subagentCount` counts all depths.
- `work-status/DOCUMENTATION.md:103` — nested cost "rolls up under the immediate parent row".
- `changelog/1.16.1.md:11` — *"'Open subtask' works for **nested subagents**"*.
- `changelog/1.23.2.md:17` — archiving/deleting a parent *"includes **nested subagents, including those below an archived subagent**"*.
- `session-retention.test.ts:84` builds a 3-level chain.
- `taskToolModel.ts:162` skips `isSubagentTool` precisely to avoid rendering a child's own children.

**Nesting is therefore optional/per-agent, not structurally forbidden.** The
restriction mechanism is per-agent config: `.opencode/agent/pr-review-bot.md:8`
`task: deny` and `:25` *"Never use subagents, nested agents, task delegation, or
multi-agent workflows"* — normalized by `config-v2.js:92`
(`if (action === 'task') return 'subagent';`).

Parallel **siblings** are also used: `.agents/skills/triage-prs/SKILL.md:47` fans
out, and `triage-issues/SKILL.md:74` fans out ~15 issues.

---

## 11. Streaming / Resume / Partial-State Handling

### 11.1 Transport

**Upstream: HTTP SSE from OpenCode. Downstream: WebSocket with automatic SSE
fallback. No polling for events.** VERIFIED.
- `lib/event-stream/upstream-reader.js` `createUpstreamSseReader`, with
  `Last-Event-ID` tracking, stall abort, reconnect (`DOCUMENTATION.md:48`).
- OpenCode 2.x sends **no SSE `id:` lines**; the id is `payload.id` and the
  directory is `payload.location.directory` (`DOCUMENTATION.md:53`).
- Browser endpoints: `/api/global/event/ws` and `/api/event/ws`
  (`event-stream/protocol.js`).

**Fork handling** — `sync/forked-session.ts:5-8`: 2.x publishes no
`session.created` after a fork, so a synthetic one is synthesized and applied at
`btw.ts:148` — *"a missed insert here leaves…"*.

**Reconnect is deliberate about not lying about failure.**
`client.ts:1471-1481` `listPendingPermissions` **throws** on fetch failure so a
resync never conflates "failed" with "none pending";
`client.ts:1418-1448` returns `null` on any failure, documented *"unknown — do
not act"*; `fetchPermission` (`:1455-1463`) treats 404 as resolved and any other
error as unknown. `reconnect-recovery.test.ts:36,118,129,149` exercises child
sessions across reconnects.

### 11.2 Can a partial assistant/tool part be written to local state?

**Yes** — that is how streaming works. Parts accumulate in the Zustand store via
`event-reducer.ts` deltas. **But it can never become future model context**,
because the send path carries no parts. VERIFIED — the same structural proof as
§6.3 applies.

The load-bearing distinction: **in-memory partial state is safe; the danger would
be a *durable* partial that is replayed.** OpenChamber has no durable message
store, so that class of bug does not exist here.

### 11.3 Interrupted-turn semantics

A turn is not marked interrupted while a permission or form is pending
(`sync-context.tsx:2155-2156` `interruptedTurnToolParts`). A pending
permission/form makes the session read as "not working"
(`useAssistantStatus.ts:11`, `useSessionActivity.ts:42`).

### 11.4 The client mirrors server-side deletion rather than inventing it

`sync/event-reducer.ts:379-390`: on a revert/delete event,
`draft.message[sessionID] = messages.slice(0, from)`. The comment at `:375-378`:
*"OpenCode deleted the boundary message and everything after it without
per-message removals, so the same range goes here."* Not an independent client
truncation. VERIFIED.

### 11.5 Fork uses a cut point, not a replay

`ui/src/sync/session-actions.ts:2543` `forkAfterMessage` uses the loaded message
list to pick a **cut point**, then calls OpenCode's fork API with a `messageID`.
**It does not re-send message bodies.** The cut is at the first turn boundary
after the message (`TURN_BOUNDARY_ROLES = new Set(["user","compaction","shell"])`).
VERIFIED.

### 11.6 Compaction destroys pinned context — and the cursor repair

Covered in §5.2(c). The failure mode is precise: OpenCode compacts, pinned
messages are summarized away, and the tab still believes they are present. The
repair is a **server-side cursor**
(`context_obligatory_last_compaction_message_id`) rather than a client-held
signature — because the client signature survives compaction, which is the bug.

---

## 12. OpenChamber vs OpenCode Responsibility Boundary

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ OPENCHAMBER                                                            │
│                                                                          │
│  CONTEXT CONSTRUCTION  ·  CONTEXT LIMITS  ·  COMPACTION                  │
│  PRUNING  ·  CACHING (provider)  ·  TOOL EXECUTION                      │
│                                                                          │
│  ░░░ NONE OF THE ABOVE ░░░                                              │
│                                                                          │
│  ✓ contributes text        (prompt, synthetic, command, shell)          │
│  ✓ contributes config      (MCP servers, providers, agents, commands)   │
│  ✓ contributes policy      (permission auto-accept + inheritance)       │
│  ✓ contributes budget      (Goal Mode tokenBudget — continuation only)  │
│  ✓ contributes post-compaction repair (context-obligatory re-injection)│
│  ✓ observes compaction      (session.compacted events)                  │
│  ✓ observes usage           (token breakdown, cache hit rate)           │
│  ✓ bounds DISPLAY           (512 KiB tool cap, 80-char reason preview)  │
│  ✓ bounds its own caches    (50 sessions persisted, 20 cached, 5 min)    │
│  ✗ never builds model input · never counts tokens                       │
│  ✗ never bounds tool output in a request · never compacts               │
│  ✗ never creates a subagent · never sets provider cache-control         │
└──────────────────────────────────────────────────────────────────────────┘
                                  │  POST /api/session/{id}/message
                                  │  body: { sessionID, id, text, files?, … }
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ OPENCODE                                                                 │
│  ✓ transcript · ✓ system prompt · ✓ tool loop · ✓ tool execution        │
│  ✓ context window · ✓ compaction/summarization · ✓ child sessions        │
│  ✓ model switching · ✓ provider request construction · ✓ prompt caching │
└──────────────────────────────────────────────────────────────────────────┘
                                  │  provider request
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ PROVIDER / MODEL                                                          │
│  ✓ actual token accounting · ✓ cache read/write accounting              │
│  ✓ context-length enforcement (the only real limit in the system)        │
└──────────────────────────────────────────────────────────────────────────┘
```

| Concern | Owner | Evidence |
|---|---|---|
| Assembling model input | **OpenCode** | `client.ts:1130-1141` body has no messages array |
| Transcript persistence | **OpenCode** | `persist-cache.ts:1-8` "Message/part data is always loaded from the server" |
| System prompt | **OpenCode** | no system-prompt assembly in this repo |
| Tool execution | **OpenCode** | no tool invocation path; `execute` is OpenCode's |
| Context window | **OpenCode** | `limit.context` read from `GET /api/model` |
| Compaction | **OpenCode** | `session.compacted` observed at `event-reducer.ts:159-163` |
| Provider prompt cache | **OpenCode** | zero `cache_control` sent |
| Token accounting | **Provider** (reported via OpenCode) | `tokenUtils.ts:42` prefers server `tokens.total` |
| MCP server *config* | **OpenChamber** | `lib/opencode/mcp.js` CRUD |
| MCP runtime + tools | **OpenCode** | `client.ts:1683-1693` passthrough |
| MCP protocol | **OpenCode** | `events.ts:832-835` discards resources; no `resources/*` call exists |
| Permission policy/inheritance | **OpenChamber** | `permission-auto-accept/runtime.js:163,171,226` |
| Post-compaction re-injection | **OpenChamber** | `context-obligatory/runtime.js:70-155` |
| Knowledge block injection | **OpenChamber** | `session-knowledge/runtime.js`, capped 8 000 |
| Goal token budget | **OpenChamber** | `session-goal/runtime.js:729` |
| Subagent creation | **OpenCode** | `client.ts:816-828` sends no `parentID` |
| Subagent display + cost rollup | **OpenChamber** | `WorkStatusSubagentsSection.tsx`, `useSubagentCostRollup.ts` |
| Tool-output display bound | **OpenChamber** (render only) | `toolRenderers.tsx:35-47` |
| Capping concurrent children | **NOBODY** | no code found |
| Cancelling one specific child | **NOBODY** | `abortSession` is per-session only |

---

## 13. Important Invariants

Rules that must remain true for correctness. Each is enforced by code or pinned
by a test.

**Context integrity**

1. **The prompt path carries text, never parts.** If this ever changed, a
   locally-held partial part would become model input. This single structural
   property is what makes §11.2 safe. `client.ts:1130-1141`.
2. **A durable partial must never be replayed as history.** Currently guaranteed
   by having no durable message store. Any move toward local persistence must
   preserve this. `persist-cache.ts:1-8`.
3. **Compaction invalidates client-held context belief.** A client-held
   signature survives compaction and is therefore wrong. Cursors live server-side.
   `session-knowledge/runtime.js:11-16`.
4. **Re-injected context is text-only by design.** `context-obligatory/runtime.js:117-124`
   drops tool parts on re-injection — a child of the "pin ids, refetch bodies"
   pattern, not an oversight.

**Failure handling**

5. **Fail closed on unknown permission state.** 404 = resolved; any other error =
   unknown. `client.ts:1455-1463`.
6. **Never conflate "fetch failed" with "nothing pending."**
   `listPendingPermissions` throws deliberately. `client.ts:1471-1481`.
7. **Failure to act is `null`/unknown, not a default decision.**
   `permission.create` returns `null` on any failure. `client.ts:1418-1448`.
8. **A send is not marked delivered until the server accepts it.**
   `session-knowledge/runtime.js:320-327`.

**Subagent semantics**

9. **A parent's first idle is a pause, not the end of the turn.**
   `session-activity.js:4-8`.
10. **Cost attribution is derived, not authoritative.** `ownCost = totalCost − subagentCost`
    — client arithmetic (`useSubagentCostRollup.ts:54-57`).
11. **Envelope unwrapping must be conservative.** Trailing prose survives; a
    literal tag inside prose does not unwrap. `taskToolModel.test.ts:100,114`.
12. **Child summaries must not recurse.** `isSubagentTool` skipped at
    `taskToolModel.ts:162`.
13. **A running subagent's synthetic row is not a real message.** *"its id is
    not a message OpenCode knows, so nothing may revert or fork from it"*
    (`subagent-run.ts:57-61`); `canCut` guards it (`TimelineNotice.tsx:228`).

**Provider/config integrity**

14. **Credentials are never stored by this layer.** `providers.js:59-61`,
    `DOCUMENTATION.md:193`; `opencode/auth.js:2` is *"a READ-ONLY view"*.
15. **Omitted `headers`/`env` in a provider PATCH mean removal, not no-op.**
    `providers.js:191-197`.
16. **`settings.apiKey` is stripped before an entry returns to an editor.**
    `config-v2.js:678-689`.

---

## 14. Useful Architectural Patterns

Mechanisms actually present in the code. No recommendations.

**1. Pin ids, refetch bodies.** Store `{id, createdAt, role}` and re-fetch text
per pin, so OpenCode stays the single source of truth for content while the pin
survives locally. `context-obligatory/runtime.js:10-16,112-115`.

**2. Server-side cursor for post-compaction repair.** Idempotent re-injection
keyed on a message id recorded in session metadata, so a reconnect cannot
double-inject. `context-obligatory/runtime.js:109,149-155`; tested
`runtime.test.js:78-105`.

**3. Write-after-accept delivery marking.** A content signature is persisted only
after the send succeeds, so a failed send does not falsely suppress a retry.
`session-knowledge/runtime.js:283,320-327`.

**4. Unknown as a first-class state.** Three-valued permission resolution (resolved
/ unknown / pending) with a comment saying which way to fail.
`client.ts:1418-1448,1455-1463`. `SessionOutcome` models success/failure
separately (`model.ts:109`).

**5. Derived, not authoritative, cost.** Recursive subtree rollup with a cycle
guard and an honest comment that it is subtraction.
`useSubagentCostRollup.ts:37-57`.

**6. Conservative envelope parsing.** A regex plus anchoring plus two negative
tests, because the input is model-authored text.
`taskToolModel.ts:189-224`; `taskToolModel.test.ts:100,114`.

**7. Generic renderer with capability questions.** Unknown tool names flow
through the same path; helpers answer "no/unknown" instead of throwing.
`tools.ts:12-15`. This is why MCP needs no render branch.

**8. Refetch rather than patch on a status event.** `mcp.status.changed` returns
`false` from the reducer, triggering a re-read instead of a partial local edit.
`event-reducer.ts:737-740`.

**9. Explicit refusal to truncate.** Where a bound would be wrong, the code says
so: *"a diff that does not fit the model's context is refused upstream"*
(`walkthrough/digest.js:4-7`) rather than silently clipping.

**10. Retire a feature and say so in code.** A dead config path with a comment
naming the retirement (`summarization.js:119-122`, `tts/routes.js:89-90`) plus
tests asserting the fallback — rather than deleting the switch and letting
someone wonder.

**11. Bounded display, honest label.** The truncation notice says *"not shown"*,
not *"not sent"* — the UI never claims a bound it does not enforce.

**12. Small-model input clamping with an explicit overflow mode.**
`clampPromptToModelLimit` truncates or throws 413 `context-too-small` depending
on a parameter. `small-model/index.js:93-105`.

**13. Goal budget as a loop stop, not a context guard.** A token ceiling that ends
autonomous continuation with a reason code, leaving user sends untouched.
`session-goal/runtime.js:729`.

**14. Layered config precedence with in-place v1→v2 migration.**
`session-knowledge`-style layering in `mcp.js:52-59`; normalization in
`config-v2.js`.

**15. Whole-session eviction, never partial trimming.**
`session-cache-retention.ts:28-33` states this explicitly.

---

## 15. Risks / Limitations Observed in OpenChamber

Concrete limitations supported by code. No recommendations.

**L1 — The display bound and the model bound are the same number, but only one
is real.** 512 KiB is enforced on rendering only. Anyone reading the UI could
reasonably believe the model received less. `toolRenderers.tsx:35-47`.

**L2 — Zero client-side protection against context overflow.** No tokenizer, no
pre-flight check, no compaction, no prune. The only real limit is the provider's
own enforcement, surfaced as whatever error OpenCode passes through. `§4.1`, `§4.5`.

**L3 — No concurrency ceiling on children.** Nothing prevents a model from
fanning out without bound. `§10.2`.

**L4 — A running child cannot be stopped from the panel.** No stop control;
opening one is read-only. `§10.1`.

**L5 — "done" does not mean success.** `WorkStatusSubagentsSection.tsx:111-114`
derives `done` from *absence of busy status*. `Session.outcome` exists
(`model.ts:124`) and is **never read here** — a failed subagent displays as
"done". Error and cancelled are also visually merged (`:153`).

**L6 — A running subagent cannot be joined to its tool call after a page load.**
`resolveRunningTaskChildSessionId` (`taskToolModel.ts:36-79`) is a heuristic:
child of this parent, created after the call started, agent matches, not already
claimed, then narrowed by `title === description`. It **fails to `undefined`
unless exactly one candidate remains** — so parallel identical subagents are
simply not joined. The root cause is that OpenCode 2.x publishes the child id
only via the ephemeral `session.tool.progress` event.

**L7 — A fabricated ToolPart stands in for a synthetic message.**
`toSubagentToolPart` (`TimelineNotice.tsx:131-156`) synthesizes
`input.agent ?? 'subagent'` and `metadata = {sessionID: run.childSessionID}`. A
row is presented in tool-call shape that is not a real tool call.
`subagent-run.ts:57-61` acknowledges this.

**L8 — `agentType` can display a placeholder as a name.**
`ToolPart.tsx:1042-1045` defaults `agentType` to the literal `'subagent'` when
`input.agent` is absent, and it feeds the button label (`:1083`).

**L9 — Child enumeration silently becomes unknown past 400.**
`session-activity.js:16-17` → `null`. A parent with more children than that is
indistinguishable from one with none.

**L10 — Cost attribution is client arithmetic, not server allocation.**
`useSubagentCostRollup.ts:54-57`. A subtree cost is inferred by subtraction.

**L11 — Dead summarization config remains in the settings store.**
`useConfigStore.ts:3528-3529` clamps `summarizeMaxLength` for a retired
provider. `useUIStore.ts:1015` likewise.

**L12 — The knowledge block is silently truncated at 8 000 characters.**
`session-knowledge/runtime.js:22`. The truncation is real context loss; the
subject is bounded, so severity is limited.

**L13 — Doc/code drift on the subagent panel.** `DOCUMENTATION.md:354-356`
describes an 8-row cap; the code uses a CSS max-height. `§10.4`.

**L14 — A goal budget silently undercounts.** The summarization call's own tokens
are reported as 0 (`session-goal/runtime.js:663-669`), so a budget spends slightly
more than it appears to.

**L15 — Non-text tool output is lost at the projection boundary.**
`projection.ts:92-98` keeps only `type === "text"`. Display fidelity, not
context — but it means the UI can understate what the tool actually returned.

**L16 — `name` collision: `compact()` means two unrelated things.** Zustand
object-compaction (`event-reducer.ts:200,208,217,262,278,677`) vs conversation
compaction. A reader searching for compaction finds the wrong function.

---

## 16. TBAi-Relevant Findings

Comparison only. **No redesign of TBAi proposed.**

TBAi column reflects the Phase 1 audit of the Direct engine
(`src/lib/prune-messages.ts`, `src/lib/model-messages.ts`, `src/routes/chat.ts`).

| Area | OpenChamber / OpenCode behavior | TBAi current behavior (Direct) | Potential relevance |
|---|---|---|---|
| **Who assembles model input** | **OpenCode.** OpenChamber sends one `text` per turn; no parts array exists on the send path. | **TBAi's own backend does.** `prepareModelMessages` (`model-messages.ts:14`) → `convertToModelMessages`. The browser is the authority; the server never re-reads messages for a request. | TBAi is on the *other* side of this line from OpenChamber. A budget manager is possible for TBAi in a way it is not for OpenChamber. |
| **History source of truth** | OpenCode's store. Client holds an in-memory projection only; message data is never persisted locally. | SQLite (`messages` table). `listThreadMessages` (`storage/index.ts:510-534`) → serialized UIMessage with `role`/`parts`/`metadata`. | TBAi owns durable history and can therefore reason about it. |
| **Token counting** | **None.** No tokenizer, no estimation. All numbers server-reported. | **None.** No `countTokens`/`estimateTokens`/tiktoken anywhere in `src/`. | Both are blind. Neither can compute a budget today. |
| **Context window source** | OpenCode's model catalog (`limit.context`), per model per session. Falls back to a 200 000 display default. | Anthropic only, from `max_input_tokens` (`modelDiscovery.ts:131`). Others fall back to `DEFAULT_MODEL_CONTEXT_WINDOW = 128_000` (`modelContext.ts:21`). | Same shape of problem: a display percentage whose denominator may be a guess. |
| **Context window used for a decision?** | **No.** Display only; no branch refuses or degrades a send. | **No.** Display only (`context-ring`). | Identical. The ring is honest about being a readout. |
| **Output-token reservation** | Only for the *small model* utility path (`OUTPUT_RESERVE_TOKENS = 4_000`). **Not for chat.** | **None** in `streamText`; the only `maxTokens` in `src/` is MCP sampling passthrough. | Both leave chat output uncapped. |
| **Overflow handling** | No pre-flight check, no retry-on-context-error. Provider enforcement only. | No pre-flight check, no context-length error pattern. Falls into `classifyError`'s generic `config` branch; user sees *"Generation failed. Retry or pick another provider/model."* `DIRECT_MAX_RETRIES = 0`. | **TBAi is worse here** — it actively mis-reports the cause. |
| **Pruning** | **None client-side.** Compaction is OpenCode's; OpenChamber only observes `session.compacted`. | `pruneStaleMessages` — **lifecycle repair only.** No token/char/message-count logic. Not pruning in the size sense. | Both are "correct but not size-aware". Different mechanisms entirely. |
| **Tool-output bound** | 512 KiB, **render only**; 2 call sites, both render. Never reaches a request. | `BoundedBody` — **render only** (`web/src/tools/body-budget.tsx:80`), and its own comment concedes it bounds DOM, not serialisation. | **Structurally identical.** In both, the UI can look clipped while the model sees everything. |
| **Tool-output in the request** | Never re-sent by the client — no messages array exists. OpenCode re-reads its own transcript. | **Persisted verbatim and re-sent on every later turn.** MCP results unbounded server-side (`mcp/manager.ts:1053`, no length arg in `mcpContentToText`). | **Opposite outcomes for the same shape of problem.** TBAi actually re-sends; OpenChamber structurally cannot. |
| **Compaction** | OpenCode performs it. OpenChamber re-injects pinned context afterwards via a server cursor. | **None.** `stopWhen: stepCountIs(20)` (`chat.ts:523`) is a step cap, not compaction. | TBAi has no equivalent of the post-compaction repair, because it has no compaction. |
| **Partial assistant turns** | Safe: in-memory only, never replayed. | **Real exposure.** Client persists a row at run *start*; `hasRenderableAssistantContent` accepts text regardless of `state`. A passing test asserts this is intended. Re-enters context as ordinary assistant text. | **TBAi-specific risk** with no OpenChamber analogue. |
| **`data-*` parts** | No analogue (no parts array). | Silently dropped — `convertDataPart` never passed, and appears nowhere in the repo. Dropped by omission, not decision. | TBAi-only. |
| **Reasoning** | Display-only. Two fields, no signature, no `providerMetadata`. Never re-sent (structurally cannot be). | **Re-sent unconditionally**, streaming fragments included — `convertMessage.js:11711-11716` pushes every reasoning part with no `state` check. | **Directly opposed.** TBAi resends; OpenChamber cannot. |
| **Approvals in history** | **Not a part type at all.** Separate store slice, never serialized into messages. | A first-class part lifecycle: `output` / `approval` / `incomplete`, deliberately preserved by the pruner, pinned by 8 tests. | **TBAi is stronger.** OpenChamber's model cannot represent an approval in history at all. |
| **MCP** | Config owned by OpenChamber; protocol, tools and resources are OpenCode's. Resources explicitly discarded (`events.ts:832-835`). No MCP branch in the tool path. | Config + protocol + execution all TBAi's (`mcp/manager.ts`). `mcp__<id>__<tool>` static tools; results persisted and re-sent unbounded. | Same config/ownership split. TBAi additionally owns the unbounded result. |
| **Prompt caching** | **None.** Zero `cache_control` sent; only measured. All "cache" hits are memoization or cost data. | None found; `cachedInputTokens` exists only in a usage type (`chat-model.ts:97-104`). | Identical. Neither controls prefix caching. |
| **Subagents** | **Cannot create one.** `session.create` sends no `parentID` — structurally incapable. All orchestration is OpenCode's. Displays children, inherits permissions by policy, rolls up cost by subtraction. | The `subagent` tool is an **OpenCode** tool rendered on the Code surface. The Direct engine has no subagent. TBAi's Code surface calls OpenCode directly and never touches `prepareModelMessages`. | **Structurally identical.** Roadmap phases 7–9 are "verify OpenCode + add guards", not "implement". |
| **Subagent context** | Child gets nothing from the client; OpenCode decides. | Same. | Subagent context is out of scope for a TBAi Direct-engine budget manager. |
| **Child cancellation** | None specific; per-session interrupt only; panel is read-only. | Not applicable (no TBAi-owned child sessions). | — |
| **Parent-idle = pause** | Explicitly handled (`isPausedForSubagents`, turn timer). | Not applicable. | — |
| **Scheduler duplication** | n/a | `schedulerExecution.ts:192-211` duplicates the reasoning tables, has a hardcoded `providerOptions.openai` with no `openaiCompatible` branch, and `stepCountIs(10)` vs Direct's 20. | TBAi-only divergence. |
| **Durable client state** | None for messages. | SQLite is authoritative; `messages.role` is NULL in the live DB despite a `NOT NULL CHECK` in source, and the read path ignores it (content carries role 21/21). | TBAi-only. Currently harmless. |

### The one-line comparison

**OpenChamber delegates context to OpenCode and therefore cannot bound it;
TBAi owns context assembly and could bound it but currently does not.** The
risks are mirror images: OpenChamber's is that a display bound is mistaken for a
model bound, TBAi's is that a real, re-sent, unbounded history has no bound at
all.

---

## 17. Files / Symbols Worth Inspecting Later

**Context assembly / ownership**
- `packages/ui/src/lib/opencode/client.ts` — **the boundary.** `:816-828` create
  (no parentID), `:1128-1142` prompt, `:1114-1127` synthetic, `:1223-1227`
  interrupt, `:1683-1693` MCP passthrough, `:1418-1481` permission state.
- `packages/ui/src/lib/opencode/subagent-run.ts:1-14` — the single best
  explanation of OpenCode's subagent lifecycle in the repo.
- `packages/ui/src/sync/persist-cache.ts:1-8,65` — proof messages are not persisted.

**Budget / display**
- `packages/ui/src/stores/utils/tokenUtils.ts` — `:16`, `:42`, `:87`, `:108`, `:203`.
- `packages/web/server/lib/small-model/index.js:58-105` — the only output reservation + input clamp.
- `packages/ui/src/hooks/useContextWindowLimits.ts:12-53` — per-session limit resolution.
- `packages/web/server/lib/session-goal/runtime.js:729` — the only token-budgeted decision.

**Pruning / compaction**
- `packages/web/server/lib/context-obligatory/runtime.js:42-155` — post-compaction re-injection + cursor.
- `packages/web/server/lib/session-knowledge/runtime.js:11-16,22,34-45,283,320-327` — signature, 8 000 cap, write-after-accept.
- `packages/web/server/lib/text/summarization.js:119-122` + `tts/routes.js:89-90` — retired model summarization.
- `packages/ui/src/sync/event-reducer.ts:159-163,379-390,458-461,524-531` — compaction observation and server-mirrored deletion.

**Tool / MCP**
- `packages/ui/src/components/chat/message/toolRenderers.tsx:27-47` — the render-only 512 KiB cap.
- `packages/ui/src/lib/opencode/projection.ts:92-118,129-180` — output flattening, non-text loss, tool state machine.
- `packages/web/server/lib/opencode/mcp.js` — MCP config CRUD.
- `packages/ui/src/lib/opencode/events.ts:768-783,832-835` — permission/form state and MCP resource discard.

**Subagents**
- `packages/ui/src/lib/opencode/model.ts:48,111-139,256-267,281-357` — Agent, Session, roles, Part union, tool states.
- `packages/ui/src/components/chat/message/parts/taskToolModel.ts:36-79,125-224` — running-join heuristic, three envelope unwrappers.
- `packages/ui/src/components/chat/work-status/WorkStatusSubagentsSection.tsx:26-125` — the management view.
- `packages/ui/src/hooks/useSubagentCostRollup.ts:37-57` — derived cost rollup.
- `packages/web/server/lib/permission-auto-accept/runtime.js:142-238` — inheritance by nearest ancestor.
- `packages/web/server/lib/opencode/session-activity.js:4-8,16-17,43-68` — parent-idle semantics + enumeration bounds.
- `packages/ui/src/stores/global-session-status.ts:84-85,121-124,189-190` — depth bound, turn timer.

**Provider / config**
- `packages/web/server/lib/opencode/config-v2.js` — v1→v2 normalization: `:381-530` MCP, `:540-689` providers/models.
- `packages/web/server/lib/opencode/providers.js:19-251` — custom-provider validation, credential handling.
- `packages/web/server/lib/small-model/index.js:118` + `custom-provider-form.ts:15-19,187-198` — protocol ids and reasoning overlays.

**Caching**
- `packages/ui/src/sync/session-cache-retention.ts:7,28-33` — whole-session eviction, stated.
- `packages/ui/src/sync/session-prefetch-cache.ts`, `packages/ui/src/sync/session-message-loader.ts:25-37` — paging and cache bounds.

---

## 18. Unknowns / Questions Requiring Further Investigation

1. **OpenCode's built-in agent definitions are not in this repository.**
   Whether `general` and `explore` can spawn children is **UNKNOWN here**. I had
   previously recorded a claim to this effect from outside knowledge; the repo
   does not support it, and I have not carried it forward. The repo's own
   evidence (§10.6) shows nesting exists and is bounded by per-agent config
   (`task: deny`), which is a different claim.
2. **Whether OpenCode's `session.tool.progress` event is sufficient to join a
   running child to its call.** `taskToolModel.ts:37-39` asserts it is the *only*
   real-time source; the event is referenced by name but not implemented here.
3. **Whether `input.description` → child `title` is reliable.**
   `taskToolModel.ts:44-46` asserts OpenCode titles each child with its call's
   description. Not independently verifiable from this repo.
4. **The exact OpenCode compaction algorithm, trigger threshold, and what it
   preserves.** OpenChamber observes `session.compacted` but the algorithm is
   server-side. This is the single most important gap for anyone reasoning about
   context.
5. **Whether `tokens.total` is always present, and its exact semantics per
   provider.** `tokenUtils.ts:38-40` notes it is *"optional in the schema, absent
   on older servers"*. The schema is `@opencode/schema@2.0.18` (an external
   dependency) and was not readable.
6. **What a context-window overflow looks like as it passes through OpenCode** —
   error shape, whether it is retried server-side, whether compaction is
   triggered defensively before the provider rejects.
7. **Whether OpenCode sends Anthropic `cache_control` or any prefix-cache
   directive.** Definitively absent from *this* repo; whether OpenCode does it is
   unknown here.
8. **Whether OpenCode bounds tool output before persisting it.** OpenChamber does
   not, and reads what OpenCode returns. Whether OpenCode truncates server-side
   is unknown.
9. **Whether a resumed/backgrounded parent is guaranteed to receive the child's
   completion message.** `subagent-run.ts:8-9` states it, but delivery is
   server-side and unverified here.
10. **The real magnitude of every risk in §15.** This install has 0 MCP servers
    and a small transcript; nothing here is under pressure. L1, L3 and L15 are
    real by code reading but unobserved at runtime.
11. **`@opencode/client` wire types were not read.** `node_modules` is not
    installed on this machine, so wire shapes are cited from OpenChamber's
    consuming code rather than from the SDK's own declarations.

---

## 10–15 Most Important Findings Before Designing TBAi Phase 2

1. **OpenChamber cannot assemble model input, and this is structural.** The
   prompt body has no messages/parts array (`client.ts:1130-1141`); `messages:`
   has zero matches in `client.ts`. Context is OpenCode's. Do not look here for a
   model-context-management reference implementation — there isn't one.

2. **TBAi is on the opposite side of that line, and that is its advantage.** TBAi
   owns assembly and durable history, so a budget manager is *possible* for TBAi
   in a way it is structurally impossible for OpenChamber. The Phase 2 decision
   is therefore real, not theoretical.

3. **There is no context size management in either codebase.** No tokenizer, no
   estimation, no pre-flight check, no output reservation on the chat path
   (OpenChamber reserves only for its *small model*), no overflow classification.
   TBAi additionally mis-reports overflow as a generic config failure with
   `DIRECT_MAX_RETRIES = 0`.

4. **The 512 KiB tool-output cap is render-only in both systems.** OpenChamber:
   exactly 2 call sites, both render. TBAi: `BoundedBody`, render-only, with its
   own comment conceding it bounds DOM not serialisation. **Identical shape,
   identical trap: the UI can look clipped while the model sees everything.**

5. **But the *consequences* are opposite.** OpenChamber never re-sends tool
   output — it cannot. TBAi persists MCP results verbatim and re-sends them on
   every later turn, with no length argument in `mcpContentToText`. Same
   component, opposite outcome.

6. **TBAi's `pruneStaleMessages` is not a pruner.** It is lifecycle repair, and
   preserving approval decisions is load-bearing. It must not be repurposed as a
   budget mechanism without keeping those semantics — 23 tests currently encode
   them.

7. **Reasoning is resend policy, not a display detail.** OpenChamber drops it
   structurally; TBAi resends it unconditionally, streaming fragments included.
   This is a decision the roadmap must make, not an accident to inherit.

8. **TBAi has a real partial-state risk OpenChamber architecturally cannot
   have.** Rows are persisted at run *start* and text is accepted regardless of
   `state` — with a passing test asserting it. Pruning cannot catch it. If local
   persistence is ever added, this class of bug gets worse.

9. **TBAi's system prompt is dead in practice** — `NULL` for all 47
   conversations, with no `web/src` writer. Any Phase 2 design that budgets
   "system instructions" is budgeting an empty bucket.

10. **Permissions are TBAi's stronger invariant.** Approval decisions are a
    first-class part lifecycle and survive pruning by design. OpenChamber cannot
    represent an approval in history at all. Compaction that drops an unexpired
    approval is worse than no compaction.

11. **No prompt caching in either system.** Zero `cache_control` sent; all
    "cache" hits are memoization or cost display. A Phase 2 that assumes prefix
    caching exists would be building on nothing.

12. **Context windows are display denominators in both.** OpenChamber:
    server-reported, 200 000 fallback. TBAi: Anthropic only, 128 000 fallback
    elsewhere. In both, the ring's percentage may be computed against a number no
    provider reported. Neither refuses a send on high fill.

13. **Post-compaction re-injection is a pattern worth understanding before
    adding compaction.** OpenChamber's `context-obligatory` runtime exists
    precisely because compaction silently destroys context the UI still believes
    in, and its fix is a *server-side cursor* — a client-held signature is
    provably wrong. The failure mode is the thing to design against, not the
    mechanism.

14. **Subagent work is out of scope for a Direct-engine context budget, on both
    sides.** OpenChamber structurally cannot create a child; TBAi's Code surface
    never touches `prepareModelMessages`. Roadmap phases 7–9 are "verify OpenCode
    + add guards", and §18.1 means the first of those is not yet verifiable from
    source.

15. **The unbounded-fanout and unbounded-history risks are separate and both
    real.** OpenChamber caps nothing about concurrent children (L3) and cannot
    even stop one from its panel (L4); TBAi caps nothing about history growth.
    OpenChamber's client-side fanout bound is OpenCode's, not its own — so the
    *client* has no ceiling at all. Whatever Phase 2 does about context growth,
    it will not be bounded above by anything in this repository.

---

## Verification

Read-only inspection of `D:\Temp\openchamber` at commit `692ab16a6`, `node_modules`
excluded from all searches. No test suite was executed — this is a code-reading
study, and the claims are structural (call sites, request bodies, absence of
symbols) rather than behavioural.

Independently re-verified by the author (not taken on sub-agent report):
- `capToolOutputText` / `TOOL_OUTPUT_MAX_CHARS` — exhaustive call-site
  enumeration; 2 production sites, both render.
- `cache_control|cacheControl|promptCach|cachedContent|ephemeral_` — 11 hits,
  all i18n/type-stub/tunnel-provider, none context-related.
- `session.create` call sites — no `parentID` anywhere.
- `session.prompt` request body — read in full; no messages/parts array.
- `messages:` in `client.ts` — zero matches.
- `countTokens|estimateTokens|tiktoken|gpt-tokenizer|tokenBudget` repo-wide —
  every hit is Goal Mode plumbing, no chat-path counting.

**No file in either repository was modified.**


