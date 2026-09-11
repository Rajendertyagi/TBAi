# Architecture

TBAi is a small, provider-agnostic AI chat application. The guiding principle is
**minimum custom code**: chat message state, streaming transport, message rendering,
and tool-call UI are all provided by libraries (`@assistant-ui/react`,
`@assistant-ui/ai-sdk`, AI SDK v7). Application code only wires them together.

## Layers

```
Browser (React + Vite)
  ├─ @assistant-ui/react      → Thread / Composer / Message rendering
  ├─ @assistant-ui/ai-sdk      → AssistantChatTransport + useChatRuntime
  ├─ RemoteThreadListRuntime  → owns thread/message state (single source of truth)
  │   ├─ RemoteThreadListAdapter   → list / create / rename / archive / delete (HTTP)
  │   └─ ThreadHistoryAdapter      → withFormat(): load/append/update/delete (HTTP)
  ├─ Zustand (UI state only)   → providers, memories, active view (NOT conversations)
  └─ web/src/runtime.ts        → useRemoteThreadListRuntime wires transport to /api/chat
        │  HTTP POST /api/chat (UIMessage[] + providerId)
        ▼
Backend (Hono + Bun)
  ├─ src/routes/index.ts       → validation (Zod) + provider resolution
  ├─ src/config/providers.ts   → ProviderRegistry (in-memory, metadata only)
  ├─ src/services/credentials.ts → CredentialStore (AES-256-GCM, local DEK; the only place key material lives)
  ├─ src/services/ai.ts        → getModel(config) → provider-specific LanguageModel
   ├─ AI SDK v7 streamText()    → convertToModelMessages() + toUIMessageStreamResponse()
   ├─ createUIMessageStream()   → wires onToolExecutionStart/End + onFinish into data-tbai-progress parts
   ├─ src/lib/progress-tracker.ts → per-request state machine (stage classification + lifecycle)
   ├─ src/lib/progress-stages.ts  → ProgressStage/ProgressData types + TOOL_STAGE_MAP
   ├─ McpManager (src/services/mcp/manager.ts) → generic MCP client (STDIO/HTTP/SSE),
   │   discovery, notifications, reconnect; getAiTools() merges MCP tools into streamText
   ├─ Scheduler (src/services/scheduler/) → SQLite-backed cron (Bun.cron for
   │   recurring, setTimeout for one-time exec_at; UNIQUE(job_id, occurrence_id)
   │   claim guard; unattended-safe tool set; /api/scheduler REST + Scheduler GUI)
    └─ bun:sqlite (SQLite)       → provider_configs (encrypted_api_key), credential_key, conversations,
       messages, memories, mcp_servers (encrypted auth_token), conv_fts (FTS5 title+content sidecar),
       scheduler_jobs, scheduler_runs (UNIQUE job_id+occurrence_id)
```

> **MCP tools are server-executed.** The MCP `Client` lives in the backend; the browser only drives
> config/status over `/api/mcp`. MCP tools are wrapped with AI SDK v7 `tool()` and merged into the
> chat route's `tools` map alongside the pre-existing client-side schema-only tools. See `mcp.md`.

> **Conversation history is owned by assistant-ui's runtime, not by the app.** The
> app only provides two HTTP adapters (`RemoteThreadListAdapter`, `ThreadHistoryAdapter`)
> that read/write SQLite through the backend. There is deliberately **no second
> Zustand conversation/message store** — that would duplicate state the runtime already
> manages. See `state-management.md` and `decisions.md`.

## Directory layout

```
ai-chat-app/
├─ src/                      # backend (Bun + Hono)
│  ├─ index.ts               # entry: serve Hono on :3000
│  ├─ routes/                # one module per concern (see below)
│  │  ├─ index.ts            # composition root: middleware + mounts + health
│  │  ├─ chat.ts             # /api/chat + resume + native tool definitions
│  │  ├─ tools.ts            # /api/tools/* manual surface
│  │  ├─ providers.ts        # provider CRUD + test/discover
│  │  ├─ conversations.ts    # threads + messages persistence API
│  │  ├─ memories.ts         # memories API
│  │  ├─ mcp.ts              # /api/mcp sub-app (MCP server CRUD + connect/refresh/test)
│  │  ├─ logs.ts             # /api/logs sub-app (live log stream)
│  │  ├─ scheduler.ts        # /api/scheduler sub-app (jobs + runs)
│  │  └─ shared.ts           # storageError helper
│  ├─ config/providers.ts    # ProviderRegistry (singleton)
│  ├─ services/ai.ts         # getModel() — provider adapter
│  ├─ services/mcp/         # McpManager (generic MCP client) + types
│  ├─ services/storage/      # conversation / message / memory persistence
│  ├─ db/index.ts            # bun:sqlite connection + schema (conversations.status,
│  │                        #   messages.parent_id/order_seq/status/format/content,
│  │                        #   mcp_servers)
│  ├─ lib/validation.ts      # Zod schemas for all API input
│  └─ types/index.ts
├─ web/                      # frontend (React + Vite)
│  ├─ src/
│  │  ├─ main.tsx, App.tsx   # shell: ThemeProvider → App (runtime) → RouterProvider
│  │  ├─ app/
│  │  │  ├─ router.tsx       # createHashRouter: index→chat, /chat/:threadId?,
│  │  │  │                   #   settings pages under SettingsLayout, * → /
│  │  │  ├─ adapter.ts       # thread-list adapter singleton
│  │  │  ├─ TabUrlSync.tsx   # tab-store → URL sync (URL → store lives in views)
│  │  │  └─ layout/AppShell.tsx # sidebar + tab strip + <Outlet/> (inside the runtime)
│  │  ├─ features/
│  │  │  ├─ chat/            # ChatView + TabStrip (chats + pages) + chatTabs store
│  │  │  ├─ providers/       # ProvidersPage (moved from SettingsPanel)
│  │  │  ├─ appearance/      # AppearancePage (theme surface)
│  │  │  └─ workspace/       # WorkspacePage (sandbox policy + sysinfo)
│  │  ├─ components/shared/  # settings-page grammar (page/section/row)
│  │  ├─ runtime.ts          # useAppChatRuntime() → useRemoteThreadListRuntime
│  │  ├─ adapters/
│  │  │  ├─ remoteThreadListAdapter.tsx  # RemoteThreadListAdapter (HTTP)
│  │  │  └─ threadHistoryAdapter.ts      # ThreadHistoryAdapter (HTTP, withFormat)
│  │  ├─ config/navigation.ts # SINGLE SOURCE OF TRUTH for nav + branding
│  │  ├─ config/history.ts    # historyConfig (page size, date grouping, feature flags)
│  │  ├─ components/
 │  │  │  ├─ ChatWindow.tsx   # assistant-ui Thread/Composer (provider-agnostic)
 │  │  │  ├─ PaseoComposer.tsx  # Paseo-inspired composer (button row, model/thinking chips)
 │  │  │  ├─ SettingsPanel.tsx, MemoryPanel.tsx, Sidebar.tsx, McpPanel.tsx, ui.tsx
 │  │  │  └─ assistant-ui/elements/
 │  │  │     ├─ markdown-text.tsx, reasoning.aui.tsx, shiki-highlighter.*
 │  │  │     ├─ tool-group.tsx, tooltip-icon-button.tsx
 │  │  │     └─ todo-list.tsx     # tbai-progress data renderer (agent stages)
│  │  ├─ stores/index.ts      # Zustand: settings / memory / mcp (UI state only)
│  │  └─ styles/globals.css  # design tokens
│  └─ package.json
└─ docs/                     # this documentation set
```

## Data flow (send a message)

1. User types in the assistant-ui `Composer`.
2. `AssistantChatTransport` POSTs to `/api/chat` with the `UIMessage[]` and the
   selected `providerId` (the API key is **never** sent to the browser).
3. The Hono route validates the body with Zod, resolves the provider metadata from the
   registry, and (for keyed providers) fetches the encrypted credential from
   `CredentialStore`, decrypts it **in memory only**, and builds the model via
   `getModel(config)`.
4. `streamText({ messages: convertToModelMessages(uiMessages), providerOptions })`
   runs on the backend; the key is decrypted server-side and is never placed in a
   response body.
5. `result.toUIMessageStreamResponse()` streams the AI SDK UI-message protocol,
   which `@assistant-ui/react` renders live.

## Application foundation (routing / tabs / ownership)

Hash routing (`react-router` v8 `createHashRouter` — the hash never reaches
the server, so it works under vite dev, the Bun SPA fallback, and the
ElectroBun desktop bundle). The router owns **pages only**:

| Owner | Owns | Lives in |
|---|---|---|
| Router | application surface (`/`, `/chat/:threadId`, settings pages) | `web/src/app/router.tsx` |
| Chat-tab store | open tabs, active tab, order, `groupId` (split-screen later) | `features/chat/state/chatTabs.ts` (Zustand, UI only) |
| assistant-ui runtime | threads, messages, streams, tool state (one shared thread-list runtime; background thread runtimes stay cached, so tab switches never abort generation) | `web/src/runtime.ts` + `App.tsx` |
| SQLite | persistence (threads/messages via ThreadHistoryAdapter) | `src/services/storage/` |
| Navigation config | labels, icons, routes, descriptions, order, visibility | `web/src/config/navigation.ts` |

`/chat/123` → router renders ChatView → ChatView opens tab 123 → runtime
switches threads. Store-initiated changes (close, first-send id attach)
flow back to the URL via `TabUrlSync` (chat tabs and page tabs share one
strip; page tabs register from SettingsLayout). `/` redirects straight to
the active tab or a fresh chat — there is no dashboard, matching codeg's
open-into-work behavior. The main sidebar holds full-width rows only (New
Chat, Chat, conversations, one Settings row); the settings area has its own
sub-sidebar. The sidebar shows Recent-5 +
Show More (session paging over the existing adapter limit/offset) with
search; settings entries always stay visible. Full contract: ADR-018 in
`decisions.md`.

## Configuration-driven navigation

Navigation (the bottom nav bar, branding, and view routing) is **configuration-driven**.
`web/src/config/navigation.ts` is the single source of truth: it defines each nav
item's `label`, `icon`, target `view`, `badge`, `order`, `children`, and `visible`
flag, plus branding strings and feature flags (e.g. `features.search` gates the
Search item). `Sidebar` and the `App` shell only *consume* this config — they contain
no hardcoded navigation definitions. To add, remove, reorder, hide, rename, or flag a
navigation item, edit that config file only; no component change is required.

## Conversation persistence (assistant-ui thread history)

Conversation and message history is persisted with assistant-ui's **native thread
architecture**, not a custom state layer:

- **`RemoteThreadListRuntime`** (`web/src/runtime.ts`) is the top-level runtime. Its
  `runtimeHook` builds the per-thread chat runtime (`useChatRuntime` + `AssistantChatTransport`);
  its `adapter` is the `RemoteThreadListAdapter`; `threadId`/`onThreadIdChange` are held
  in `App` state so a selected thread survives reload.
- **`RemoteThreadListAdapter`** (`web/src/adapters/remoteThreadListAdapter.tsx`) implements
  `list / initialize / rename / archive / unarchive / delete / fetch` by calling the
  backend `GET|POST /api/conversations` and `PATCH /api/conversations/:id`. `list()`
  returns **all** threads (regular + archived); the runtime splits them by each thread's
  `status` into the regular and archived lists. `unstable_Provider` + `unstable_useAdapters`
  inject the per-thread `history` adapter via `RuntimeAdapterProvider`.
- **`ThreadHistoryAdapter`** (`web/src/adapters/threadHistoryAdapter.ts`) implements
  `withFormat(storageFormatAdapter)`. The AI SDK runtime calls `withFormat` and uses the
  returned adapter to `load()` / `append()` / `update()` / `delete()` messages. The
  adapter stores exactly what the format adapter produces (`{ id, parent_id, format,
  content }`) and hands it back verbatim on load — it never interprets message internals.
  `append`/`update` call `aui.threadListItem.initialize()` to create the conversation row
  on first message, then POST the stored entry.
- **Backend** (`src/routes/index.ts`, `src/services/storage`) persists conversations
  (`conversations` table, `status` column) and messages (`messages` table; `content` stores
  the serialized storage format as JSON, `format` records the runtime format, `parent_id`/
  `order_seq` preserve the message tree/order). `GET /api/conversations?status=all` powers
  the thread list; `GET|POST /api/conversations/:id/messages` load/append messages;
  `PATCH` renames/archives; `DELETE` removes.

The result: a new thread is created on first send, messages stream and persist automatically,
reloading the page restores the thread list, and opening a thread restores its messages —
all without any application-owned message state.

## Type-checking notes (Bun / ElectroBun / AI SDK)

These are the deliberate, non-suppression fixes required to get a clean `bun run typecheck`.
They are documented so future changes don't regress them.

### ElectroBun type resolution

`electrobun` and `electrobun/main` are resolved by the **Hutch bundler at build time**, not by
the TypeScript module resolver, so `tsc` cannot find them through normal node resolution. Two
small shims bridge this:

- `src/types/electrobun.d.ts` — an ambient `declare module "electrobun/main"` declaring the
  minimal `BrowserWindow` / `PATHS` surface the app uses (`src/bun/index.ts`, `src/bun/env.ts`).
  The full devkit SDK source is intentionally *not* imported here: pulling it into `tsc` would
  also drag in native FFI / WebGPU modules that only mean something inside the Hutch build.
- `src/types/electrobun-config.ts` — re-exports the real `ElectrobunConfig` type from the
  Hutch devkit (`.hutch/devkit/api/config/ElectrobunConfig`) so `electrobun.config.ts` stays
  type-checked against the actual build-tool contract. It is wired into `tsconfig.json` `paths`
  (`"electrobun": ["./src/types/electrobun-config.ts"]`).

Do **not** add `@ts-ignore`/`@ts-expect-error` or exclude these files; the shims are the fix.

### bun:sqlite (`bun-types`) binding + query typings

The installed `bun-types` (Bun 1.4.2) types model SQLite bindings strictly:

- `db.run(sql, values)` takes the bind parameters as a **single array**
  (`run<ParamsType extends SQLQueryBindings[]>(sql, ...bindings: ParamsType[])`), so call sites
  pass `db.run(sql, [a, b, c])` — not the variadic `db.run(sql, a, b, c)` form.
- `db.query(sql)` takes **only** the SQL string; bind values go on `get`/`all`
  (`db.query(sql).get(id)`, `db.query(sql).all(id)`), not on `query` itself.
- `db.query` is generic over **two** type arguments — `db.query<Row, ParamsType>(sql)` — so
  result rows are typed and `unknown`-access errors are avoided. `ParamsType` is normally
  `SQLQueryBindings[]`.

Row shapes are modeled with small interfaces (`ConversationRow`, `MessageRow`, `MemoryRow`,
`ProviderConfigRow`) and passed as the first generic; `SQLQueryBindings` (from `bun:sqlite`) is
the bind-parameter type.

## Non-goals (current)

- RAG / retrieval, file uploads, and advanced persistent memory supplied to the
  model are **deferred** (see roadmap.md). MCP **tool** integration (connect to any MCP server, expose its tools
  to the model) is implemented; MCP resource/prompt *invocation from chat* and SSE live-testing are
  still pending (see `mcp.md`).

## Built-in scheduler (TBAi cron)

SQLite (`scheduler_jobs` / `scheduler_runs`) is authoritative; the
coordinator (`src/services/scheduler/scheduler.ts`) keeps only timer
handles in memory. Recurring jobs run on `Bun.cron` (5-field, per-job IANA
timezone); one-time jobs run on a persistent `exec_at` + `setTimeout`.
Duplicate execution is prevented by an atomic
UNIQUE(job_id, occurrence_id) claim — never by in-memory state. Restart
recovery marks orphaned runs `interrupted`, rebuilds timers, and applies
the missed-run policy (grace window → run once, else `missed`). Overlap
defaults to `skip_if_running`; retries cover transient failures only.
Scheduled runs reuse `getModel` + AI SDK `generateText`; destructive tools
always refuse (approval is unavailable unattended) and MCP tools are
excluded in V1. GUI: `Scheduler` nav view (table + preset form + preview +
run history); API: `/api/scheduler/*` (Zod-validated). Full contract:
`docs/scheduler.md`; decision: ADR-017 in `decisions.md`.

## Rich response rendering

`
MessagePrimitive.GroupedParts (official groupPartByType)
  |- group-chainOfThought
  |    |- group-reasoning -> reasoning element (collapsible Thinking)
  |    - group-tool      -> tool-group element (count + per-tool fallback)
  |- tool-call leaves     -> tool-fallback element (running/complete/error)
  - text leaves          -> markdown-text element
       |- GFM markdown (headings/lists/tables/blockquotes/links/inline code)
       |- fenced code -> language label + Copy button + Shiki highlighter
       |   (tokenization deferred while streaming)
       - `diff fences -> DiffViewer element (parse-diff, add/del rows)
`

- Components come from the official assistant-ui registry
  (r.assistant-ui.com/base/{name}.json) copied into
  web/src/components/assistant-ui/elements/ + web/src/components/ui/,
  rendering through @assistant-ui/react-markdown and react-shiki.
- Streaming-safe: markdown parses incrementally; Shiki skips tokenization
  while a code block is still arriving.
- Security: markdown renders through react-markdown (no
  dangerouslySetInnerHTML for model output); external links use
  target="_blank" rel="noreferrer" via the official components.a override.
- Tool names: MCP tools exposed as mcp__<serverId>__<toolName> render as
  "server - tool" (rendering-glue.ts).
- Native tools (11) follow the assistant-ui Toolkit architecture
  (`web/src/tools/toolkit.ts`, one `defineToolkit` registration via
  `AssistantRuntimeProvider config`). All entries are render-only
  `type: "backend"`: execution lives server-side (`nativeTools` in
  `src/routes/index.ts`, sandboxed `services/tools.ts`). Privileged tools
  pause at a server `toolApproval` gate answered with `respondToApproval()`.
  Tool groups auto-open while running. No human tools, no `useAssistantToolUI`.
  `/api/tools/*` endpoints remain as a manual/test surface only.

## Tool lifecycles

```
Normal native:   AI → server tool → result → AI
Approval native: AI → approval gate → user decision → server tool (0/1×) → result → AI
MCP external:    AI → MCP server → result → AI
```

Continuation is explicit: `useChatRuntime({ sendAutomaticallyWhen })` combines
the official `ai` helpers for tool-call completion and approval-response
completion, so Approve/Deny always resubmits the thread and the model
continues. Cancel-on-new-message still synthesizes the documented
"User cancelled tool call" error result by design.

## Tool lifecycle & history pruning

Native tool parts move through these AI SDK v7 states:

```
input-streaming → input-available → (tool-approval-request → approval-responded)
                  → output-available | output-error | output-denied
```

`prepareModelMessages` (`src/lib/model-messages.ts`) is the single production
history path (prune → convert). Pruning rules (`src/lib/prune-messages.ts`):

- **Resolved parts are always kept**: output-available/error/denied (including
  synthesized cancel `output-error` with only `errorText`).
- **Approval decisions are kept** (requested or responded, approved or denied)
  while they are the active continuation — i.e. no user turn follows them.
  The server needs the decision to execute the approved call or synthesize
  the denial.
- **Approval decisions expire**: once a user turn follows an unexecuted
  decision, the part is dropped — a destructive action is never executed
  retroactively on an unrelated future message, and a fresh approval is
  required instead. Approval state lives in per-thread history only (never
  crosses threads).
- **Duplicates collapse per toolCallId**: the approval-responded snapshot of an
  interaction that later completed is superseded by the completed part.
- **Genuinely stale parts** (no result, no decision — the stream died before
  anything happened) are dropped; assistant turns left with only step-start
  are dropped (empty model turns are invalid provider input); adjacent
  text-only user messages merge.

The integration tests (`tests/integration/approval-lifecycle.test.ts`) run
through `prepareModelMessages` — the same function the chat route uses — so
pruning can never be bypassed by a test mirror.

## Centralized logging + request correlation

One logger contract spans server and frontend (`src/lib/logger.ts`,
`web/src/lib/logger.ts`): levels debug/info/warn/error, `scope` +
snake_case `event` + structured fields, automatic secret redaction
(keys, Authorization, tokens, DEK material), `normalizeError()` for error
shape. Every request carries `req_<id>` in an AsyncLocalStorage context —
follow one operation across HTTP → chat → provider → tools → MCP → storage
by that id; errors returned to the client include it
(`"Generation failed. Retry or pick another provider/model. [ref:req_…]"`).

- Levels: dev → debug (console, human-readable); production → info
  (JSON-lines `data/tbai.log`, rotated 5 MB × 3). Env: `TBAI_LOG_LEVEL`,
  `TBAI_LOG_FILE`, `TBAI_LOG_MAX_MB`, `TBAI_LOG_KEEP`.
- Diagnostics: `AI_DEBUG_REQUESTS=true` logs a sanitized structural snapshot
  of the outbound model request (`ai_request_diagnostic`) — part types, tool
  names/schemas, ids, signature presence; never raw user text or secrets.
- Never log: tokens/chunks, full message history, credentials, stacks to users.
- **Live Logs panel** (`Logs` view): streams the server's in-memory ring
  buffer (last 1000 entries, post-redaction) over SSE `/api/logs/stream`
  (backlog + live push, polling fallback `/api/logs/recent?since=`). Filters:
   level, scope, free text (incl. `req_…` references); pause/resume,
   auto-scroll, clear-view. Same data as the console/file, nothing extra.

## Agent progress (tbai-progress data parts)

During a chat run, the server derives a sequence of high-level work stages
from actual tool-call events — not from the model. This gives reliable,
order-preserving visibility into what the agent is doing.

- **Classification** (`src/lib/progress-stages.ts`): a `TOOL_STAGE_MAP` maps
  known native tool names to semantic stage IDs and labels
  (e.g. `list_dir` / `file_info` → "Inspecting workspace";
  `write_file` / `edit_file` → "Modifying files"). Unknown or MCP tools
  fall through to a generic "Executing tools" stage.
- **State machine** (`src/lib/progress-tracker.ts`): per-request tracker
  subscribes to `onToolExecutionStart` (marks stage → `active`) and
  `onToolExecutionEnd` (marks stage → `completed` or `failed`). Multiple
  calls to the same stage category are aggregated — one entry per category,
  not per call.
- **Streaming** (`src/routes/index.ts`): the chat route uses
  `createUIMessageStream` with the tracker's callbacks. Each transition
  emits a transient `data-tbai-progress` part; the final snapshot on
  `onFinish` is non-transient and persists in message history. On abort,
  active stages are marked `failed`.
- **Rendering** (`web/src/components/assistant-ui/elements/todo-list.tsx`):
  registered globally in `App.tsx` via `makeAssistantDataUI` under the
  name `"tbai-progress"`. Renders inside the assistant message via
  assistant-ui's data-part flow — a compact list with status icons
  (spinning loader / check / X), done stages struck through, active count
  in the header. Hidden when there are no stages.
