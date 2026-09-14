# Architecture Decisions

Recorded so future changes have context. Add new decisions here.

## Stack choices

- **@assistant-ui/react + @assistant-ui/ai-sdk** — Provides chat message state,
  streaming transport, message rendering, and tool-call UI out of the box.
  Library-first; avoids reimplementing chat primitives. Provider-agnostic.
- **AI SDK v7** — Primary AI layer (`streamText`, `convertToModelMessages`,
  `toUIMessageStreamResponse`). Unifies provider SDKs behind one interface and
  produces the UI-message stream protocol that assistant-ui consumes.
- **Hono + Bun** — Lightweight, TypeScript-native server. Hono's routing/middleware
  keep the backend small; Bun runs TS directly with fast startup.
- **SQLite via `bun:sqlite`** — Local-first persistent storage with zero external
  services. Satisfies the persistence requirement without a server process.
- **Zustand** — Minimal shared client/UI state. Not used as a persistence layer.
- **Tailwind CSS v4** — Utility-first styling with design tokens in `globals.css`.

## Removed dependencies (with reasons)

- **`assistant-stream`** — Only used by `createProviderStream` (dead code; no route
  called it). Its `createAssistantStreamResponse` emits the older *Assistant Stream
  Protocol*, which `AssistantChatTransport` does **not** consume (it expects the AI
  SDK UI-message stream). `streamText().toUIMessageStreamResponse()` is the
  library-provided, correct equivalent. Removed.
- **`drizzle-orm` + `drizzle-kit`** — Configured but never used; the app talks to
  SQLite directly via `bun:sqlite`. Removed to keep the dependency surface small.
  If a query builder is later needed, re-evaluate and record here.

## Security model

- API keys are backend-only. The browser sends `providerId`, never the key.
  `GET /api/providers` returns only metadata + `credentialConfigured`. (See `security.md`.)

## Credential encryption: local DEK, no master password

- **Decision:** Provider API keys are encrypted at rest with **AES-256-GCM** under a
  random **per-install Data Encryption Key (DEK)**, stored in the `credential_key`
  table. There is **no master password, unlock screen, or login**, and **no OS keychain /
  credential-manager** dependency. The user enters a key once and TBAi remembers it
  automatically across restarts.
- **Why:** TBAi is a personal-use, portable application. A master-password / unlock
  workflow was prototyped and then removed — it added friction (create/unlock/lock UI,
  Argon2id derivation on every unlock) with no benefit for a single-user portable tool
  where the app folder is already trusted. Portability (the data folder travels with the
  app) and convenience were prioritized.
- **Why not OS keychain:** avoids per-OS backends (WinCred / Keychain / Secret Service)
  and keeps the app fully portable and dependency-light. The `CredentialStore` interface
  is the single swap point if OS storage is later desired.
- **Why not a hardcoded key:** the DEK is generated randomly per install, so no universal
  key ships in source.
- **Trade-off / limitation:** because the DEK lives in the same local DB as the
  ciphertext, anyone with read access to the app's `data/` folder can recover the keys.
  Accepted for a personal tool; documented in `security.md` threat model.
- **Dependencies:** `@noble/ciphers` (AES-256-GCM). `@noble/hashes` was evaluated for
  Argon2id but dropped when the master-password approach was removed; random bytes use
  `crypto.getRandomValues` and hex via `Buffer`. Crypto is isolated in
  `src/services/credentials.ts`; `src/lib/redact.ts` scrubs secrets from logs/errors.

## Conversation persistence: assistant-ui thread architecture

- **Decision:** Persist conversation/message history using assistant-ui's **native thread
  runtime** (`RemoteThreadListRuntime` + `RemoteThreadListAdapter` + `ThreadHistoryAdapter`),
  backed by the existing SQLite store. We do **not** introduce a second Zustand
  conversation/message store.
- **Why:** The runtime already owns thread/message state; a parallel store would duplicate
  it and drift out of sync. `ThreadHistoryAdapter.withFormat(storageFormatAdapter)` lets us
  persist exactly what the AI SDK runtime serializes (`{ id, parent_id, format, content }`)
  without re-implementing message serialization. `RemoteThreadListRuntime` wires the
  thread list, selection, and `threadId` so a selected thread survives reload.
- **Why not a custom store:** Minimum-custom-code principle — chat message state, history
  load/append, and the history UI (`ThreadListPrimitive` / `ThreadListItemPrimitive`) are all
  provided by the library. Custom code is limited to two thin HTTP adapters.
- **Storage format:** `messages.content` stores the runtime's opaque storage format as JSON
  (verified as `ai-sdk/v6`); `messages.format` records the format tag so it can be decoded on
  load. We never parse message internals.
- **Schema:** `conversations.status` (`regular`/`archived`) drives the regular vs. archived
  lists; `messages.parent_id`/`order_seq` preserve the message tree and order. Migrations are
  idempotent (guarded `ALTER TABLE … ADD COLUMN`; the legacy `role NOT NULL` messages table
  is recreated when upgrading an old DB).
- **Rename caveat:** `ThreadListItemPrimitive.Title` is read-only, so rename is implemented as
  a `window.prompt` + direct `PATCH /api/conversations/:id` (not via the primitive).

## Thinking-model latency

- `gemini-flash-latest` resolves to a thinking model; we disable thinking with
  `thinkingConfig.thinkingBudget = 0` for non-lite models to reduce latency.
  Revisit if the provider changes model aliasing.

## MCP client: official SDK + AI SDK v7 tool wrappers (server-side)

- **Decision:** TBAi connects to MCP servers through the **official `@modelcontextprotocol/sdk`**
  (`@modelcontextprotocol/sdk/client` `Client` + `StdioClientTransport` /
  `StreamableHTTPClientTransport` / `SSEClientTransport`, notification schemas from
  `@modelcontextprotocol/sdk/types`). Discovered tools are wrapped with **AI SDK v7 `tool()`** and
  merged into the chat route's `tools` map. The MCP `Client` runs **server-side**; the browser only
  drives config/status over a `/api/mcp` REST API.
- **Why this SDK:** it is the canonical, spec-track implementation and already handles the three
  transports, capability negotiation, and notification schemas. Hand-rolling JSON-RPC/MCP framing
  would duplicate a large, evolving standard and risk interop bugs. Minimum-custom-code principle.
- **Why AI SDK v7 `tool()` and not `@ai-sdk/mcp`:** wrapping each discovered tool ourselves keeps the
  connection lifecycle, live status, cancellation (`abortSignal` → `client.callTool`), and
  capability surfacing (tools/resources/prompts, server info) fully under our control for the GUI and
  for the chat route's tool merge. `@ai-sdk/mcp` hides that lifecycle behind its own client.
- **Why server-side execution:** MCP servers may be local subprocesses (STDIO) or remote HTTP/SSE
  endpoints; running the `Client` in the backend avoids shipping server credentials/CLIs to the
  browser and keeps one connection per server for the whole app. Tool names are namespaced
  `mcp__<serverId>__<toolName>` to avoid collisions and stay stable across reconnects.
- **Transports:** STDIO (command + args + env), Streamable HTTP, and legacy SSE are all implemented.
  HTTP/SSE auth is constructed from `auth_type`/`auth_token` (bearer / basic / oauth); the token is
  encrypted at rest with the same local DEK as provider keys (`encryptSecret`/`decryptSecret`).
- **Status / resilience:** per-connection status + a recent-events buffer (progress, list-changed,
  logging, errors) are surfaced to the GUI; unexpected transport closes trigger bounded reconnect
  (`MAX_RECONNECT_ATTEMPTS` = 5, `RECONNECT_DELAY_MS` = 5000). `testConnection(input)` validates a
  server without persisting it.
- **Verification:** STDIO + Streamable HTTP verified via `scripts/test-mcp.ts`; the REST API verified
  via `scripts/test-mcp-api.mjs` against a running server. SSE is implemented but not yet exercised
  against a live legacy SSE server. Desktop Commander MCP (`npx -y @wonderwhy-er/desktop-commander@latest`)
  is the intended first real-world test server; it requires Node/npm/npx on `PATH` (absent in the
  current Windows test env, which has only Bun), so it was validated via a Bun-based minimal MCP
  server instead.
- **Follow-up (now implemented):** MCP resources/prompts are insertable into the chat composer from the
  MCP panel (`readResource`/`getPrompt` + REST + `unstable_useComposerInput().setText`); roots, sampling,
  and elicitation are consumed via `setRequestHandler` for `ListRootsRequestSchema` /
  `CreateMessageRequestSchema` / `ElicitRequestSchema`, with elicitation surfaced through a global modal
  (`/api/mcp/elicit/pending` + `/elicit/resolve`). See `mcp.md` "Advanced client capabilities".
- **Still deferred / pending live test:** a live SSE server run, and end-to-end sampling/elicitation with
  a real provider key + a server that uses them during a chat.

## Rich response rendering: official assistant-ui registry components

Assistant messages now render rich content using the official assistant-ui
composition rather than a custom renderer (ADR-equivalent of the AIPM
project's ADR-009, re-implemented natively for this codebase):

- **Markdown**: the official markdown-text registry component on top of
  @assistant-ui/react-markdown (MarkdownTextPrimitive) + emark-gfm
  (GFM tables, task lists, strikethrough). Streaming-safe: parses
  incrementally with smooth reveal; data-status mirrors part state.
- **Syntax highlighting**: the official shiki-highlighter element over
  eact-shiki. Tokenization is deferred while a code block streams and
  settles afterwards without layout shift.
- **Code blocks**: language label + copy button ship in the registry
  component's CodeHeader; long lines scroll inside the block.
- **Diffs**: the official diff-viewer element (parse-diff + diff),
  routed from `diff fences through a small SyntaxHighlighter override.
  Unified view, add/del coloring, +/- stats.
- **Reasoning/tools**: official easoning, 	ool-group, 	ool-fallback
  elements rendered through MessagePrimitive.GroupedParts +
  groupPartByType (current API; components.ChainOfThought is legacy).
  Reasoning renders only when the provider emits reasoning parts; thinking
  budgets are configured per provider (see Thinking-model latency above).
- **Dependencies added**: @assistant-ui/react-markdown, emark-gfm,
  eact-shiki (brings shiki), diff, parse-diff, adix-ui (unified
  package for Collapsible/Tooltip), 	w-shimmer (CSS). cva,
  clsx, 	ailwind-merge were already present.

### Custom code ledger (rendering)
| Custom piece | Size | Why |
|---|---|---|
| `diff -> DiffViewer routing (HighlightingSyntax in ChatWindow.tsx) | ~15 lines | MarkdownText's SyntaxHighlighter slot is language-agnostic; routing diff fences to the official DiffViewer is app glue. |
| prettyToolName (rendering-glue.ts) | ~10 lines | MCP tool names are mcp__<serverId>__<toolName>; displayed as "server - tool" for readability. |
| asChild adaptation in tooltip-icon-button.tsx | 1 line | Installed radix-ui@1.6.7 TooltipTrigger supports asChild but not the newer ender prop used by the registry file. |
| ui/button + ui/tooltip + ui/collapsible + ui/textarea | ~150 lines | Registry elements import these shadcn primitives; this project had a different Button/Input/Textarea set in ui.tsx. Adapted to the existing dark-first token style. |

Everything else is verbatim official registry code.

## ADR: approval lifecycle + history pruning durability (2026-09-10)

- **Regression fixed:** the Gemini-400 pruner treated
  `approval-responded (approved, no output yet)` as stale and deleted it —
  so the continuation request reached the server without the approval
  decision, nothing executed, and the model re-raised the gate in a loop
  (observed live: 4× write_file/login.html, all approved, none executed).
- **Lifecycle rule now:** per toolCallId — (1) a resolved occurrence
  (output-available/error/denied, including cancel-synthesized errorText)
  always wins; (2) otherwise the last approval decision (requested or
  responded) is kept **only while no user turn follows it** (active
  continuation); (3) no result + no decision = genuinely stale → dropped.
  Assistant turns left step-start-only are dropped; adjacent text-only user
  turns merge.
- **Approval lifetime decision:** an approval is actionable only within its
  continuation. If the continuation is lost and the conversation moves on,
  the decision expires (part dropped) and a fresh approval is required —
  destructive actions are never executed retroactively on an unrelated future
  message. Approval state lives in per-thread message history only; it never
  crosses threads and is never persisted anywhere else.
- **Production-path test guarantee:** `prepareModelMessages`
  (`src/lib/model-messages.ts`) is the one prune+convert path used by both
  the chat route and the integration tests — a test can no longer bypass the
  pruner by mirroring the route.
- **UI:** approved-but-not-executed parts render "Approved — will execute
  with your next message…" / "Approved — executing…", never "Failed".
- **Diagnostics:** `stale_part_pruned`, `approval_preserved` (chat scope),
  `tool_execution_started/completed` (tools scope) — toolCallIds only, never
  content.

## ADR: centralized logging + request correlation (2026-09-10)

- **Decision:** one canonical server logger (`src/lib/logger.ts`: debug/info/
  warn/error, scope + stable snake_case event names, structured fields) used
  by HTTP, chat, provider, MCP, native tools, and storage boundaries. A
  matching frontend logger (`web/src/lib/logger.ts`) mirrors the contract with
  a console backend and global error hooks. No SaaS, no new runtime deps.
- **Correlation:** every inbound request gets `req_<id>` (trusted incoming
  `x-request-id` accepted only if `[A-Za-z0-9_-]{1,64}`), carried in an
  AsyncLocalStorage context — never global mutable state, concurrent requests
  isolated (unit-proven). Errors returned to the client include `requestId`;
  stream errors append `[ref:req_…]` to the user-visible copy so a user can
  report "Error reference req_123".
- **Levels/destinations:** dev → debug (console, human-readable), production
  → info (JSON-lines file `data/tbai.log`, size-rotated 5 MB × 3). Overrides:
  `TBAI_LOG_LEVEL`, `TBAI_LOG_FILE`, `TBAI_LOG_MAX_MB`, `TBAI_LOG_KEEP`.
- **Redaction:** structured key redaction (api key/authorization/token/
  password/cookie/credential/dek…) plus value-pattern scrubbing
  (sk-/AIza/xox/Bearer). Unit-proven negatives: API keys, Authorization
  headers, DEK material never appear in log output.
- **AI diagnostics:** `AI_DEBUG_REQUESTS=true` emits a sanitized structural
  record (`ai_request_diagnostic`) of the outbound model request — roles,
  part types, tool names/schemas, toolCall/approval ids, signature presence
  (`{present,length}`) — never raw user text, tool argument values, or
  signature values. This is what made the Gemini 400 root cause observable
  (orphaned duplicate functionCall turns + consecutive user turns; fixed
  separately by `pruneStaleMessages`).
- **Normalization:** one `normalizeError()` (type, message, cause, status,
  code; stack only locally) feeds every error log; user responses never
  receive stacks.
- **Why custom:** no dependency was added because the contract (AsyncStorage
  context + redaction + rotation) is ~300 lines total; pino/winston would add
  transitive weight without changing the semantics we need.
- **Ledger:** `src/lib/logger.ts` ~330 lines, `src/lib/ai-diagnostics.ts`
  ~200, `web/src/lib/logger.ts` ~110, wiring ~120 lines across routes/
  manager/server; tests ~230 lines.
- **Live Logs panel:** in-memory ring buffer (1000 post-redaction entries)
  inside the logger + SSE endpoint (`/api/logs/stream`, backlog + push,
  heartbeat, abort-clean) + polling fallback (`/api/logs/recent?since=`).
  Client (`LogsPanel.tsx`, ~230 lines) filters level/scope/text client-side
  (≤1000 entries — no server-side query needed), pause/resume, auto-scroll.
  No dependencies; same redacted data as console/file, nothing new exposed.

## ADR: industry-standard dual-theme UI (2026-09-10)

- **Decision:** full shadcn CSS-variable contract (`:root` light + `.dark`
  overrides, oklch-free hex tokens preserving the existing dark look,
  `@theme inline` bridge, `@custom-variant dark`, `color-scheme` per theme)
  with a Vite ThemeProvider (`light|dark`, `localStorage`, class on
  `<html>`, FOUC-blocking pre-apply script, default dark). No `next-themes`
  (Next-only), no media-query strategy (toggle requires class strategy).
- **No inline styles, no hardcoded values:** every surface uses theme tokens
  (`success`/`warning` pairs added; red/green/amber literals eliminated;
  `text-[11px]` unified to `text-xs`; diff sizes mapped to scale).
- **Kept native `<select>`** (color-scheme makes the OS popup follow the
  theme; Radix rewrite unjustified for short single-choice lists), kept
  registry `elements/*` frozen (zero hardcoded colors found inside).
- **Canonicalized** `ui/button.tsx` variants/sizes, `ui/input.tsx` (new),
  `ui/textarea.tsx`; collapsed `ui.tsx` duplicates into re-exports.
- **Bugs fixed in the same pass:** red error strip on every message (gated
  with `MessagePrimitive.Error`), transparent thread menu (popover tokens),
  card-width mismatch (`ToolCard w-full`), tiny diffs (`w-full` + loose-fence
  fallback), stale rename (runtime `rename()` + inline editor), reload
  landing (threadId hydrate/persist/validate).
- **Feel:** `tw-animate-css` activates the registry's entrance animations;
  message entrance, ScrollToBottom, Copy/Reload action bars, icon composer
  with tooltips + autofocus, view-switch fade, sidebar active indicator.
- **Ledger:** globals.css rewrite (~140), theme provider + toggle (~90),
  ui/* canonicalization (~120 net), renderer/card/diff fixes (~60),
  rename + restore (~110), feel additions (~60).

## ADR: resume-404 self-healing (2026-09-10)

- **Symptom:** `GET /api/chat/resume/:id → 404` retried on every reload.
  Root cause chain (verified in installed packages): the server's resumable
  store is in-memory, so any restart wipes it; finished streams are
  finalized; and error-terminated streams never tripped our finish detector
  (it only watched `finish` + abort markers). The stale stream id stayed in
  per-thread `sessionStorage`, so each reload re-attempted the dead resume —
  and the failed attempt left the thread in error state.
- **Fix (client only, official hooks):** `isFinishEvent` now also treats
  `"type":"error"` SSE chunks as terminal (markers match raw SSE text only;
  message content is JSON-escaped and cannot trip them), and `useChatRuntime`
  gets `onResumeError` which clears the stale per-thread resume pointer.
  Persisted messages are never touched — only the pointer clears. One 404,
  then never again.
- **Not changed:** the server 404 itself is correct behavior (unknown stream
  ⇒ 404); no server code touched.

## ADR: assistant-ui DevTools guard fix (2026-09-10)

- **Problem:** `<DevToolsModal/>` rendered in every browser bundle yet waited
  forever ("Waiting for assistant-ui instance..."). Root cause is upstream,
  not TBAi: the modal renders unless `process` exists with
  `NODE_ENV=production`, while `AssistantRuntimeProvider` registers the
  runtime only under that same condition — and browsers have no `process` at
  all, so the panel renders and the registration never happens.
- **Decision (option B):** `main.tsx` installs a minimal dev-only shim
  (`window.process.env.NODE_ENV="development"`, non-clobbering, only under
  `import.meta.env.DEV`); `App.tsx` mounts `<DevToolsModal/>` only under
  `import.meta.env.DEV`. Verified preconditions: Vite injects no `process`,
  nothing depends on its absence, devtools package is `sideEffects:false`.
- **Verified:** production `vite build` output contains zero DevTools strings
  and no devtools chunk. Debugging aid only; not a TBAi feature — no further
  DevTools work planned.

## ADR-017 — Built-in scheduler / cron (Bun-native, SQLite-backed)

- **Status:** Accepted
- **Date:** 2026-09-11
- **Context:** TBAi needs unattended scheduled AI runs (one-time + recurring)
  without adding infrastructure. The project rules forbid Redis/Postgres/
  Docker and extra scheduler services.
- **Decision:** SQLite (`scheduler_jobs` / `scheduler_runs`) is the source of
  truth; `Bun.cron(expr, cb, { timezone })` drives recurring jobs (verified
  against installed Bun 1.4.2: 5 fields, no seconds, `timezone`/`tz` option,
  handle has `stop()`/`unref()`); `setTimeout` drives one-time `exec_at`
  jobs. Timers are an execution cache, rebuilt from the DB on startup, job
  change, and recovery. No `node-cron`/Bree/BullMQ/Redis, no polling loop.
- **Duplicate prevention:** UNIQUE(job_id, occurrence_id) claim insert —
  recurring slot `cron-<utc-minute>`, once `once`, manual `manual-<unique>`.
  Conflict ⇒ already claimed ⇒ no execution. Retries update the same run
  row (`attempt`++). No "exactly once" claim across provider side effects.
- **Recovery:** orphaned `running`/`scheduled` runs → `interrupted` (never
  auto-retried); recurring timers rebuilt; pending once timers rebuilt;
  overdue once jobs follow the missed-run policy (≤ grace → run once,
  else `missed` + disabled, never late).
- **Unattended safety:** destructive native tools always throw an
  approval-required refusal in scheduled runs (approval cannot be granted,
  so gates cannot be bypassed); MCP tools excluded in V1; workspaces
  confined to the TBAi root via the same traversal/symlink policy.
- **Reuse, not duplication:** execution goes through canonical `getModel` +
  AI SDK `generateText` (no second provider system, no second streaming
  stack); thinking mapping mirrors the chat route; jobs store explicit
  provider/model/thinking/workspace/prompt (never the active UI state).
- **V1 limits:** minute granularity; `skip_if_running` only; no MCP tools;
  no full message mirroring (excerpt on run row); one row per occurrence.
- **Ledger:** `schedulerTypes.ts` (~80), `cron.ts` (~380, validation +
  presets + tz-aware next-run via Intl only), `schedulerStore.ts` (~330),
  `schedulerExecution.ts` (~300), `scheduler.ts` (~300), `routes/scheduler.ts`
  (~330), `SchedulerPanel.tsx` + store (~700), tests (~330). Zero new
  dependencies. Full detail: `docs/scheduler.md`.

## ADR-017.1 — Consolidate scheduler AI tools into one action-dispatched tool

- **Status:** Accepted
- **Date:** 2026-09-12
- **Context:** The native toolkit exposed six separate scheduler tools
  (`create_scheduled_job`, `list_scheduled_jobs`, `get_scheduled_job`,
  `update_scheduled_job`, `delete_scheduled_job`, `run_scheduled_job_now`). Six
  near-identical `backend` entries and renderers add surface area with no
  behavioral gain, and the model must learn six names for one capability.
- **Decision:** Collapse to a single `scheduler` tool whose `action` enum selects
  the operation (`create | list | get | update | delete | run_now`), mirroring a
  CLI command with subcommands. Schema is a `z.discriminatedUnion("action", …)`
  in `lib/validation.ts`; read variants (`list/get/delete/run_now`) use `.strict()`
  so stray write fields are rejected. A single `runScheduler(args)` dispatcher in
  `schedulerTools.ts` reuses the existing `schedulerToolHandlers` (persistence +
  timers) with no logic duplication; `jobId` from the tool schema is mapped to the
  handlers' `id`. Results are returned as a uniform `{ ok, action, summary, … }`
  envelope (no thrown errors surfaced to the model). `schedulerStore.list(status?)`
  gained an optional status filter so list filtering stays server-side. The REST
  API (`schedulerJobCreateSchema`/`schedulerJobUpdateSchema`) is untouched — only
  the AI-tool re-export changed. Native toolkit count: 20 → 15.
- **Ledger:** `lib/validation.ts` (`schedulerSchema`), `schedulerStore.list`
  status param, `schedulerTools.ts` (`runScheduler` + `SchedulerResult`/
  `SchedulerJobView`), `tools/index.ts` + `tools/schemas.ts` (single entry),
  `web/src/tools/toolkit.ts` + `web/src/tools/scheduler/ui.tsx` (single renderer),
  `tests/unit/toolkit.test.ts` + `tests/unit/scheduler-ai-tools.test.ts`.

## ADR-018 — Application foundation (router, tabs, modules)

- **Status:** Accepted
- **Date:** 2026-09-11
- **Context:** Every feature re-litigated navigation/state placement
  (ad-hoc `activeView` switching, an 810-line `routes/index.ts`, a
  monolithic SettingsPanel, an unbounded sidebar list). Needed: one stable
  platform for dashboard, multi-chat tabs, future split-screen, and all
  settings areas — verified against the ecosystem compatibility study
  (React Router v8, assistant-ui multi-thread, AI SDK v7, shadcn).
- **Router: `react-router` v8 `createHashRouter`, Data Mode, no loaders
  initially.** v7 is security-maintenance-only, so v8 (`8.3.1` installed,
  exports verified under Bun 1.4.2) — not the v7 originally sketched.
   Hash routing picked over BrowserRouter: identical Data-Mode API, zero
   server rewrites, works from `file://` and under the Tauri desktop shell
   (portable zip). Framework Mode explicitly rejected (no SSR/file-routes
   needed). One new dependency; recorded here per dependency discipline.
- **Tabs without duplicate runtimes:** open tabs = Zustand id list +
  `groupId` (`"main"`; split-screen later adds groups, no rewrite). ONE
  shared `useRemoteThreadListRuntime`; tab switch = `threadId` prop
  change. The runtime caches per-thread runtimes, so background streams
  survive switches (docs-confirmed; live E2E must still prove it). No
  message store, no mirrored state. `/chat/new` = unsent draft;
  first-send id attaches via `attachRealId`; stale ids redirect to a
  draft; tab state persists in localStorage with validation.
- **Backend split:** `routes/index.ts` → composition root + per-concern
  modules (`chat/tools/providers/conversations/memories`, existing
  `mcp/logs/scheduler` untouched). Identical paths, no logic changes.
- **Frontend modules:** `app/` (router/shell/adapter/URL-sync) +
  `features/<name>/` + `components/shared/` (settings grammar). Moved,
  not rewritten: providers page (ex-SettingsPanel), appearance, workspace
  (existing sysinfo endpoint only), dashboard, chat views.
- **Sidebar anti-flood:** Recent-5 + Show More (+5, session-only) over the
  existing adapter paging; search stays server-side; settings always
  visible.
- **Ledger:** `react-router@8.3.1` (only new dep); ~10 new frontend files,
  5 new backend route modules; `SettingsPanel.tsx` deleted after its move;
  `tests/unit/foundation.test.ts` added (tab store + route→nav map).
- **Follow-up (same session, codeg re-study):** unified tabs (chat + page
  tabs in one strip, old string-shape state migrates automatically);
  dashboard deleted (`/` → active tab or fresh chat — codeg has no
  dashboard); sidebar bottom icon-grid replaced with full-width rows (New
  Chat, Chat, conversations, one Settings row); settings sub-sidebar added
  (`SettingsLayout`, entries from `navigation.ts`); Memory/MCP/Scheduler/
  Logs converted onto the shared settings grammar without logic changes.
  Page tabs later removed (codeg tabs are conversations-only); close-last
  opens a draft; URL sync chat-scoped.
- **Follow-up: scheduler hardening + codeg parity (same session).**
  Reconciled a half-landed migration (cancel plumbing + thread persistence
  without a matching signature — tree didn't compile; fixed by adding the
  `conversationId` parameter properly). Then: @-macros normalized
  server-side, cancel-run with real abort + route, 30-day run prune,
  prompt-on-edit fetch fix, once defaults (now) + quick picks, thread
  jump column, trigger gallery with runs/24h, template gallery (templates
  now set the repeat mode too — previously silently overwritten),
  When-section rewrite (mode chips, auto live sentence, custom
  collapsible), duplicate/use-again + honest enable guard (dead
  `cancelled` rule removed, tests rewritten), sent-vs-shown prompt split,
  run-now disabled while running + auto-refresh, trigger icons, sidebar
  failure badge + auto-clear, relative next-run, soft-delete retaining
  runs. Verified: in-process Bun.cron is exempt from the Windows
  48-trigger cap (docs table), so odd steps work as-is.
- **Not done here:** split-screen UI (model ready), MCP/scheduler/memory
  logic (untouched), shadcn CLI primitives (adopt incrementally).

## ADR: assistant-ui docs audit — explicit non-replacements (2026-09-10)

Full docs-index audit (all guides, primitives, runtimes, tools, migrations,
utilities) against this codebase returned **zero replacements**. Recorded so
future agents don't re-litigate:

- **Streamdown ≠ DiffViewer replacement.** Covers ~60% of the markdown stack,
  needs new packages (`@assistant-ui/react-streamdown`, `streamdown`), and its
  own guide says to keep custom `diff`-language renderers. Partial
  modernization at best, not a deletion.
- **MessageTiming hook complements but can't replace `MessageUsage`.**
  Disjoint data (hook: durations/speed; ours: backend model + finish reason).
- **CLI `add` rejected.** Next.js/shadcn-oriented; `add --overwrite` would
  destroy intentionally-diverged glue (Radix `asChild` shim, DiffViewer
  routing, streaming guards). `upgrade --dry` / `info` may be used around
  version bumps.
- **`@assistant-ui/react-mcp` rejected.** Browser OAuth + plain-text local
  storage would violate the secrets-stay-server-side invariant.
- **`AISDKToolkit`/`frontendTools` rejected.** Requires the excluded
  generative compiler + `@ai-sdk/mcp`. Our manual server/client split stands.
- **Persistence adapters verified compliant** with the custom-adapter contract
  (opaque `{id,parent_id,format,content}`, no content inspection).
- **MCP manager scope intentionally larger than docs.** Docs cover per-request
  static clients; ours is a persistent GUI-managed multi-server client with
  reconnect, sampling/elicitation/roots, and encrypted auth. No overlap to
  merge.
- **`useAssistantToolUI` migration verified complete** (zero remaining uses);
  `ThreadPrimitive.Empty` → `AuiIf` and `Messages components` → children fn
  migrated (were the last deprecated usages).
- **Resumable store stays in-memory** (documented dev default); the
  `ResumableStreamStore` interface is the future swap path, not a migration.

## ADR: native toolkit architecture (2026-09-10) — replaces human-tool UIs

- **Decision:** all 11 native tools are one `defineToolkit` registration
  (`web/src/tools/toolkit.ts`, `type: "backend"` render-only entries) wired via
  `AssistantRuntimeProvider config`; server owns contract + execution
  (`nativeTools` + `toolApproval` gates in `src/routes/index.ts`); zero human
  tools; `useAssistantToolUI`/`ToolRegistrations`/`ToolUIs.tsx` deleted.
- **Why:** the schema-only + `addResult()` arrangement stalled after approval
  (no `sendAutomaticallyWhen` was configured, and nothing in that design
  resubmitted the thread). Approval cards also conflated "UI supplies result"
  with "user authorizes server action". The toolkit + server-gate model makes
  each lifecycle explicit and uses only official mechanisms.
- **Why not the generative compiler:** the project has no `@assistant-ui/vite`
  plugin; `defineToolkit` passes explicit-`type` entries through unchanged
  (verified in installed `core@0.3.17`). Marker factories (`humanTool()` etc.)
  throw at runtime by design and are never called.
- **Why keep `/api/tools/*`:** manual/test/debug surface; removing them buys
  nothing while the new path proves itself. Deliberate temporary retention.
- **Continuation:** `sendAutomaticallyWhen` = tool-calls-complete OR
  approval-responses-complete (official `ai` helpers); backend-approval tools
  must use the approval predicate, never the human one.
- **Trade-offs/limits:** v0.0.4 transport drops rich approval prompts
  (prompt/options/text never render — plain allow/deny only); reload drops a
  pending gate by design; `outputSchema: z.unknown()` is loose on purpose.
- **Custom-code ledger:** `nativeTools` defs (~110 lines — model contract must
  live next to execution; AI SDK has no registry for it); toolkit entries +
  11 renderers (~330 lines — assistant-ui provides no file/process UI);
  `BackendToolView` gate dispatcher (~80 lines — three-state approval logic is
  app-specific); `AutoOpenToolGroup` (~20 lines — auto-open-while-running is
  not a registry behavior); `sendAutomaticallyWhen` wiring (~5 lines).

## Agentic human tools: coding + computer set (2026-09-10)

- **Pattern (doc-backed):** schema-only server tools + client "human tool" UIs that
  execute via `/api/tools/*` and feed results back with `addResult` — the exact
  pattern assistant-ui's Tool UI docs bless for "the entire execution happens
  through user interaction". No architecture change from the original 4 tools.
- **Tool set (11 total):** read/write/edit/run (original) + `list_dir`,
  `search_files`, `file_info` (auto-run) + `delete_file`, `process_kill`
  (Approve/Deny) + `process_list`, `system_info` (auto-run, read-only).
- **Approval policy:** reads auto-run; writes/deletes/commands/kills ask first.
  Server-side `toolApproval` gates were evaluated and rejected — they apply to
  server-executed tools, while ours execute in the UI.
- **Safety:** everything file-scoped stays inside `WORKSPACE_DIR` (traversal +
  symlink-escape rejected); `runKill` refuses pid ≤ 4 and the server's own pid;
  search skips `node_modules`/`.git`/binaries with caps; search `truncated`
  means strictly more hits than returned.
- **Debt:** `useAssistantToolUI` is deprecated upstream in favor of
  `defineToolkit` toolkits. New tools stay on the existing API for consistency;
  migrating all 11 UIs to toolkits is a separate future task.
- **Tests:** `tests/unit/tools.test.ts` runs against an isolated tmp workspace
  (`tests/setup.ts` now also sets `WORKSPACE_DIR`); `credentials.test.ts` no
  longer overwrites `DATA_DIR` or closes the shared db singleton (it broke
  parallel test files with "Database has closed").
- **Superseded same day:** the human-tool arrangement above was replaced by the
  toolkit ADR at the top of this section (server execution + server approval
  gates). Tool set, approval policy, safety rules and tests carry over
  unchanged; only the registration/execution/approval mechanism changed.

## Reconciliation (2026-09-10): streaming hardening + persistence UX + roots push

- **Abort propagation:** `c.req.raw.signal` → `streamText({abortSignal})` (route) and
  → `getAiTools(requestSignal)` → per-tool `callTool(..., {signal, timeout:120000})`
  with `options.abortSignal ?? requestSignal` fallback. No custom protocol.
- **Stream errors:** `sanitizeStreamError()` maps auth/rate-limit/network/abort to stable
  user copy + `logStreamDiagnostic()` server-side; `ErrorPrimitive.Root/Message`
  (`AssistantError` in ChatWindow) renders it per assistant message.
- **Resumable:** official `assistant-stream/resumable` in-memory context + resume route
  + per-thread `sessionStorage` keys + abort/finish `isFinishEvent`. Pinned
  `assistant-stream@0.3.41` in `web/package.json` (was transitive-only float risk).
- **Metadata:** official `messageMetadata` (`finish→{usage,finishReason}`,
  `finish-step→{modelId}`) + trivial `MessageUsage` readout from
  `message.metadata.custom` via `useAuiState`. No new tables; opaque persistence kept.
- **Content search:** FTS5 `conv_fts` sidecar + triggers + one-time backfill (additive,
  existing DBs preserved) with LIKE fallback; `list({search})` queries title + message
  content; adapter forwards `?search=`; Sidebar debounces 300ms + runtime reload, client
  title filter kept as fallback.
- **LoadMore:** official `ThreadListPrimitive.LoadMore` (auto-hides when no `nextCursor`);
  appends via existing adapter `after→offset` contract, no duplicate thread state.
- **Roots push:** client caps flipped to `roots:{listChanged:true}`; new
  `notifyRootsChanged(id)` → `client.sendRootsListChanged()`; roots/notes-only edits skip
  reconnect and push instead; `POST /servers/:id/roots/notify` exposed.
- **MCP SDK v1.30 vs v2:** STAY on v1.30 (deliberate debt). Push ships in installed v1.30;
  v2 needs package split, zod3→4, node>=20/Bun revalidation, handler-signature churn,
  era-negotiation design — disproportionate without a live-test window. Revisit when a
  2026-07-28-only server is required.

### Custom code ledger (reconciliation)| Custom piece | Size | Why |
|---|---|---|
| `sanitizeStreamError` + `logStreamDiagnostic` (redact.ts) | ~35 lines | AI SDK has no user-copy mapping; avoids raw SDK text in ErrorPrimitive. |
| `getAiTools(requestSignal)` fallback + timeout (manager.ts) | ~5 lines | AI SDK may call execute without options.abortSignal; request fallback + 120s cap. |
| `notifyRootsChanged` + reconnect-skip (manager.ts) + roots/notify route | ~45 lines | v1.30 SDK exposes the primitive but no manager wiring/route. |
| `conv_fts` sidecar + triggers + backfill + search SQL (db/storage) | ~60 lines | SQLite FTS needs app-side DDL/triggers; no ORM in this codebase. |
| `threadListSearchQuery` bridge + debounced reload (adapter/Sidebar) | ~20 lines | RemoteThreadListAdapter list() has no first-class search param in installed version. |
| `MessageUsage` readout (ChatWindow) | ~25 lines | Registry has no usage-footer element; reads official metadata.custom. |
| Progress tracker + TodoList renderer | ~180 lines (3 new files) | Agent work visibility derived from tool calls, not model-controlled. Server→client via data-tbai-progress part type. |

## ADR-016 — Server-derived agent progress stages (tbai-progress)

- **Status:** Accepted
- **Date:** 2026-09-10
- **Context:** Users need visibility into what the agent is doing during long tool chains. Model-controlled todo lists are unreliable (the model may skip, reorder, or omit them).
- **Decision:** Derive progress stages server-side from actual tool-call events using `onToolExecutionStart` / `onToolExecutionEnd` callbacks in `createUIMessageStream`. Group known tools into semantic categories (inspect/search/read/modify/run/system). Unknown/MCP tools map to a generic "Executing tools" stage. Multiple calls to the same category aggregate into one stage entry.
- **Data contract:** Each progress update is a `data-tbai-progress` data part (id: `"progress"`) with shape `{ kind: "tbai-progress", version: 1, stages: [{ id, label, status: "pending"|"active"|"completed"|"failed" }] }`. Partial updates are transient (live UI only); the final snapshot is non-transient and persists in the message history.
- **Client:** `TodoList` component registered as the `tbai-progress` data renderer via `makeAssistantDataUI` in `App.tsx`. Renders inside the assistant message via assistant-ui's data-part flow.
- **Rationale:** No model involvement means stages are always accurate. Hybrid persistence avoids bloating stored messages with intermediate snapshots. One renderer per app — no per-thread config needed.

## ADR-019 — Per-conversation AI config ownership + provenance metadata

- **Status:** Accepted
- **Date:** 2026-09-11
- **Context:** The composer picker listed only the active provider's models, its choice was sticky, the thinking chip was unwired UI, set-active flipped local state without checking the server, and no per-response provenance existed. Verified against installed `ai` 7.0.93 + `@assistant-ui/ai-sdk` 0.0.4 typings and the official docs patterns.
- **Decision:** Each conversation **owns** its AI config (provider + model + reasoning level), with SQLite as the source of truth:
  - `conversations.model_id` / `conversations.reasoning_level` (added idempotently in `src/db/index.ts`) hold the conversation's persisted default.
  - **Create** (`src/routes/conversations.ts`): when a field is omitted, it defaults to the active provider's `model` / `thinking` (or `"off"`), so every conversation owns a concrete config from creation.
  - **Update** (`PATCH /api/conversations/:id`): `providerId` / `modelId` / `reasoningLevel` patch without clobbering other fields; a literal `null` is normalized to "absent" so a partial `updateCustom` never wipes a persisted value.
  - **Client projection** (`remoteThreadListAdapter.tsx`): `toMetadata` projects the row to `threadListItem.custom.{providerId, modelId, reasoningLevel}`; `updateCustom` PATCHes it back. The browser only ever sends these three ids/levels — never secrets or protocol.
  - **Effective config resolution** (three layers, most specific first — `src/routes/chat-model.ts` on the server, mirrored in `web/src/runtime.ts` + `PaseoComposer.tsx`): `one-shot picker override` → `threadListItem.custom (conversation default)` → `global active provider default`. The wire field is **`reasoningLevel`** (Zod `off|low|medium|high`), not `thinkingLevel`.
  - **One-shot picks** (provider + model + reasoning from the composer chips) apply to the NEXT send only and are cleared via `revertChatTarget` after the transport consumes them; they layer on top of the conversation default and never write back. The transport snapshots the effective config per thread + last-user-message so tool/approval continuations keep the picked model mid-run; history is immutable, so previous messages are never re-resolved.
  - **Provenance:** the server attaches `{providerId, modelId, reasoningLevel}` via `toUIMessageStream({messageMetadata: () => ({custom})})`, persisted through the existing `withFormat` path and rendered as footer chips (which provider/model/thinking actually produced THIS response — one-shot picks vary per message). Set-active checks the response, reloads from the server, and shows errors. Footer streaming detection additionally requires `thread.isRunning` (message timing is never persisted, so timing-only detection stuck every reloaded message in "streaming").
- **Removed:** a dead second `streamText()` call in the chat route whose result was never consumed (double provider invocation risk); replaced by nothing — the inner call already carried the full config.
- **Ledger:** backend (`src/routes/chat-model.ts` seam —    single resolution point the chat route calls; validation field `reasoningLevel`; conversations create/update defaults; metadata), `stores` (`selectedProviderId` / `selectedModelId` / `selectedReasoningLevel` one-shots + `selectChatTarget` / `revertChatTarget`), `runtime.ts` (send-key snapshots + three-layer resolution), `PaseoComposer` (grouped picker + wired thinking chips that persist to `custom`), `ChatWindow` (provider/reasoning footer chips), `ProvidersPage` (honest set-active). Zero new dependencies. Wire contract uses `reasoningLevel`; the one-shot body fields are `providerId` / `model` / `reasoningLevel` / `id`.

## ADR-020 — Desktop shell: Tauri 2 + bundled Bun sidecar (replaces ElectroBun)

- **Status:** Accepted
- **Date:** 2026-09-12
- **Context:** TBAi shipped on **ElectroBun** (Hutch devkit) as a portable Windows app. We studied
  `D:\Temp\codeg` (the reference desktop app) and confirmed its key property: **two shells, one
  router** — a Rust Tauri backend serving a plain HTTP API + static SPA, and a React frontend that
  talks to that API over fetch. Because TBAi's backend is already a plain Hono/Bun HTTP server, the
  same `web/src/runtime.ts` fetch transport works in both the browser and a Tauri webview with **no
  Transport abstraction** (codeg needed one only because its desktop backend is Rust IPC vs HTTP in
  web; TBAi's fetch transport already works in both).
- **Decision:** Replace ElectroBun with **Tauri 2** wrapping the existing web app. Architecture is a
  strict stack: `Tauri 2 → Bun sidecar → existing Hono API → existing React/assistant-ui app`.
  - **Bundled Bun sidecar** (`src-tauri/binaries/bun-*.exe`, portable download, spawned in
    `src-tauri/src/main.rs`) runs the bundled backend (`bun build src/index.ts --target bun
    --outdir dist` → `dist/index.js`). Env `PORT=3000`, `WEB_DIST_DIR=<resources>/web`,
    `DATA_DIR=<app>/data` are injected by Rust before spawn. The window loads `http://localhost:3000`.
  - **Full desktop-tab treatment, now:** custom title bar (drag region) + native window controls
    (`WindowControls`), a draggable **tab strip** (`TabStrip`) built on the **existing
    `chatTabs` Zustand store** with `@dnd-kit/sortable` reorder (writes through the store's
    `reorder` action — **no second tab-state system**), left/right **edge chrome** for native
    resize, and a **keyboard shortcut controller** (`ChromeShortcuts`: Ctrl/Cmd+T/W/Tab/1-9).
  - **Isolation:** every Tauri capability is reached through `web/src/lib/platform.ts` via dynamic
    `import("@tauri-apps/...")`; the chrome components are loaded by `AppShell` through
    `React.lazy(() => import("../../components/DesktopChrome"))` gated on `isTauri()`
    (`"__TAURI_INTERNALS__" in window`). Therefore the **browser bundle never pulls in
    `@tauri-apps/*`** — verified: Tauri runtime lives in separate lazy chunks
    (`DesktopChrome-*.js`, `window-*.js`); the main bundle only holds the dynamic-import
    specifier string. In a plain browser `isTauri()` is false, the chrome renders nothing, and the
    layout is unchanged (browser-mode parity preserved).
  - **No changes to existing AI streaming:** `web/src/runtime.ts`, the chat route, and assistant-ui
    remain exactly as in the web build.
- **Build constraint (deliberate):** the Rust/Tauri toolchain is **never installed locally**; the
  portable `.zip` (no installer) is produced **only** by `.github/workflows/tauri-build.yml`
  (Windows runner: setup Bun + Rust, download portable Bun sidecar, `tauri icon`, `tauri build
  --bundles zip --target x86_64-pc-windows-msvc`, upload artifact). `bundle.targets: ["zip"]`
  (not NSIS) — portable only. All other steps (typecheck, web build, `bun test`) run locally as
  before.
- **Removed:** `src/bun/*` (ElectroBun main process + portable-path env shim),
  `src/types/electrobun*.ts`, `electrobun.config.ts`, `hutch.config.ts`, `scripts/post-package.ts`;
  the `electrobun` tsconfig path alias and the `electrobun:*` npm scripts. `.gitignore` now covers
  `src-tauri/{target,gen,binaries,icons}`.
- **Capabilities** (`src-tauri/capabilities/default.json`): `core:default` + window
  drag/resize/close/set-title + `opener:open-path`. The Bun sidecar is spawned from Rust, so the
  frontend needs no shell-execute permission.
- **Ledger:** `src-tauri/` (Cargo.toml, build.rs, tauri.conf.json, src/main.rs, capabilities,
  app-icon source), `web/src/lib/platform.ts` (~70), `web/src/components/{WindowControls,
  DesktopTitleBar, TabStrip, LeftEdgeChrome, RightEdgeChrome, ChromeShortcuts, DesktopChrome}.tsx`
  (~430 total), `AppShell` lazy-mount (~10), `chatTabs.reorder` (+12), `package.json` scripts +
  `@tauri-apps/*`/`@dnd-kit/*` deps, `scripts/gen-icon.ts`, `.github/workflows/tauri-build.yml`.
  Zero new backend dependencies.
- **Verification done locally:** `bun run typecheck` (0 errors), `bun run build` (backend + web),
  `bun test` (188 pass, 0 fail), and a browser smoke test (`bun run dev` serves `localhost:3000`
  SPA + `/api/conversations` 200 — no regression). Tauri desktop build is verified by the GitHub
  workflow artifact (cannot run `tauri build` locally by design).

## Sidebar rework: codeg-parity left sidebar (shadcn, zero hardcodes)

- **Scope:** `Sidebar.tsx` rebuilt on codeg `layout/sidebar` geometry � fixed `h-10`
  header (locate-active / expand-collapse-all / eye view-menu), one fixed `New Chat`
  pill, persisted `Chats / Recent / Archived` sections. The `ActivityBar` icon rail
  is untouched. No MCP/Scheduler/Logs rows in the sidebar (rail owns all routes);
  no folders/worktrees/pinned (no backend model for them).
- **Search moved to the chrome (codeg rule):** the sidebar search box is deleted;
  search is a toggle+search cluster in the never-unmounting `LeftEdgeChrome`
  overlay (works collapsed) with global `Ctrl/CMD+K`, `Escape` closes+clears, query
  in the store, debounced server `?search=` + reload. Opening search opens the
  sidebar so results are visible. The composer's dead `"CMD+K to focus"` hint is
  removed (no handler ever existed; `CMD+K` now owns conversation search).
- **State (Option B):** `desktopLayout` Zustand store extended, versioned (`v1` +
  field-by-field `migrate`, `partialize` excludes transient search UI): `sidebarSort`,
  `sectionOrder` (always a full permutation via `normalizeSectionOrder`),
  `sectionCollapsed`, `showRecent`, `archivedExpanded`. Pure list logic in
  `lib/sidebar-sections.ts` (tested: `tests/unit/sidebar-sections.test.ts`, 12 pass).
  Config in `config/sidebar.ts` (limits, debounce, defaults, copy � no literals in
  components). New files under `features/sidebar/` (header/nav-button/section/rows/
  view-menu/order-control + `useThreadListQuerySync` hook); `Sidebar.tsx` composes.
- **Real sort:** backend `GET /api/conversations` gains whitelisted `?order=created`
  (`ORDER BY created_at DESC`; default `updated_at DESC`; same allowlist pattern as
  `status`), adapter passes it through + projects `createdAt` via `custom` (open bag,
  never secrets; `updateCustom` stays selective so it never hits PATCH).
- **shadcn refinement (from current docs):** `ui/dropdown-menu.tsx` completed to the
  canonical grammar (Group/Label/Checkbox/Radio/Sub/Shortcut, lucide indicators �
  no new dep); sidebar theme tokens added (`--sidebar*` light/dark + `@theme`
  mappings); rows use `TooltipIconButton`/`Button`/`Input`/`Collapsible` atoms.
- **No inline styles:** `lib/chrome-vars.ts` publishes `--sidebar-width`,
  `--left-chrome-width`, `--right-chrome-reserve` from `window-chrome.ts` tokens;
  `AppShell` consumes only `var(--�)` classes (the `w-20` overlay + all
  `style={{width/right}}` reserves are gone). `w-[var(--sidebar-width,224px)]`
  keeps its defensive fallback (mirrors `SIDEBAR_DEFAULT_WIDTH`).
- **Known approximation:** Recent = first N runtime items (server newest-first, no
  client reorder � `Items` fixes iteration order and item primitives bind by index,
  so sections share the runtime order); Chats and Recent mount separate `Items`
  (bounded duplication = `recentSectionLimit`). `navigation.ts` drops dead
  `newWorkspaceLabel`/`historyLabel` branding (sections own their labels now).
- **Verification done locally:** `bun run typecheck` (0), `bun run build`
  (backend+web), new unit tests (12 pass), existing suites pass, backend smoke
  (`/api/conversations?order=created|updated` 200, SPA + scheduler summary 200).
  Desktop bundle verified only via the GitHub Tauri workflow (no local toolchain).

## Batch 1 � Windows-x64-only application shell

- **Platform lockdown:** `platform.ts` stripped to `isTauri` + window ops
  (`minimize`/`toggleMaximize`/`isMaximized`/`onResized`/`close`); the UA-based
  `Platform`/`getPlatform`/`isMac`/`isWindows`/`isLinux` fork, `ResizeDir`, and
  `windowStartResizeDragging` are gone. `window-chrome.ts` drops the macOS
  traffic-light inset, zoom params (no zoom UI exists), Linux grip tokens, and
  dead exports; `winLinuxCaption` is renamed to `captionStrip` (`isTauri()`).
- **Linux grips deleted:** `WindowResizeHandles.tsx` removed (Windows resizes via
  Tauri`s WndProc hook; the component could never activate on this target).
- **Caption buttons (frameless-correct):** `WindowControls` tracks maximized state
  via `onResized` and swaps Maximize ? Restore glyph/labels (codeg pattern);
  labels in new `config/chrome.ts`; button width from `--caption-button-width`.
- **Tokenized bands:** `--title-bar-height` / `--activity-bar-width` published by
  `chrome-vars.ts`; the `h-10`, `w-12`, `left-12`, `w-[46px]` literals in
  `AppShell`/`ActivityBar`/`SidebarHeader`/`WindowControls` are gone.
- **Verification:** typecheck 0, full build green, unit suites pass, backend smoke
  (health/SPA/conversations+order 200). Desktop geometry via CI artifact only.

## Batch 2 � Top bars (tab strip, breadcrumb header, status bar)

- **Tab strip (codeg embedded geometry):** equal-width `basis-48 grow-0 shrink
  min-w-0` tabs with fade-mask titles (new `.tab-title-fade` in globals.css),
  active tab `bg-background` raised, inactive hover fill (top-border indicator
  retired). Active tab auto-scrolls into view; middle-click closes; running
  threads show a pulse dot from runtime `isRunning` (display-only, no new
  store fields). `role=tablist/tab`, `aria-selected`, full-title tooltips.
  Right-click gains **Close All** (composed from `close()`; never-zero-tabs
  draft rule holds). dnd-kit stays � no new dependency. Double-click stays a
  no-op (no pin field; out of "functions we have now").
- **Breadcrumb header (new `ChatHeader`, chat routes only):** `h-10`
  transparent bar � workspace root crumb (� `/workspace`) + truncated chat
  title + overflow menu (New / Rename-dialog / Archive-Unarchive / Copy ID /
  Delete-via-confirm). Narrow primitive subscriptions (title/status strings)
  so streaming never re-renders it; dialog targets snapshotted at open;
  draft guards (actions disabled until first send persists). Rename needs no
  new dep; delete-confirm uses new canonical `ui/alert-dialog.tsx`.
- **New backend endpoint:** `GET /api/workspace` (`routes/workspace.ts`,
  registered in composition root) returns `{ name, path }` of `WORKSPACE_DIR`
  � the only surface exposing the absolute root (tools stay relative).
  Header falls back to `"Workspace"` when unreachable.
- **New shadcn files:** `ui/dialog.tsx` + `ui/alert-dialog.tsx` (radix-ui meta
  package already installed); `DropdownMenuItem` gains the `variant`
  ("default" | "destructive") prop mirroring `ContextMenuItem`.
- **Status bar (codeg geometry):** `h-8` muted band; left = quick-actions
  launcher (new `StatusBarQuickActions`: New Chat, all `getSettingsNav()`
  areas with their own icons/labels, both toggles � the always-on fallback)
  + connection dot + provider; right = model + desktop gear. Copy in new
  `config/statusBar.ts`; visibility gated once (AppShell), internal check
  removed; inverted `bg-primary` retired.
- **Verification:** typecheck 0, full build green, 28 unit tests pass, backend
  smoke on a FRESH server (stale-port lesson: kill + count processes first) �
  health/workspace/conversations+order/scheduler/SPA all 200, and
  `/api/workspace` returns the real root name. Desktop visuals via CI only.

## Batch 3 � Context-menu consistency pass

- **One grammar everywhere:** raw Radix menu markup now lives only in `ui/`
  primers (the shadcn pattern � verified by grep); every feature menu goes
  through `ui/context-menu` / `ui/dropdown-menu` (right-click vs trigger).
  Separators use the canonical default (TabStrip`s `bg-border` override
  removed); widths are scale classes (`min-w-44/56`, `min-w-30/55`,
  `max-h-80`); check marks are lucide `Check` icons, not text glyphs.
- **Copy centralization:** composer picker labels (model/thinking/attach) move
  to new `config/composer.ts`; thread-row menu labels (rename/archive/
  unarchive/delete/copy/open-in-tab) move to `sidebarConfig.copy`. Menu item
  icons kept (codeg parity: icons on menus, none on tab menu).
- **Logger rule enforced:** `PaseoComposer` attach stubs used `console.log`
  (banned for feature code) � now `logger.debug("composer",
  "attach_not_wired", �)`.
- **Left alone deliberately:** message/panel `text-[10px]/[11px]` outside menus
  (message timestamps, log view, badges) � separate typography pass, not menus.
- **Verification:** typecheck 0, full build green, 28 unit tests pass, backend
  smoke on a fresh server (health/workspace/SPA 200). Desktop visuals via CI.

## Dedicated settings window (codeg parity)

- **Native window (Option A):** Rust `open_settings_window(section?)` command in
  `main.rs` (+ `invoke_handler`, `url = "1"` dep for URL parsing) � label
  `"settings"`, decorated 1080x700 (min 1080x600), centered, serving the SPA
  settings routes from the Bun sidecar. Reuse-if-open: focuses + eval-navigates
  to the section instead of duplicating. Independent top-level window (never a
  child), mirroring codeg`s window discipline. Capability extended to
  `["main", "settings"]`.
- **Chromeless shell:** top-level `#/settings-window/:section?` route renders
  `SettingsWindow` (nav + section content, native frame supplies the rest) �
  no rail/tabs/status/overlays. Section?component map covers the same 8
  pages; unknown sections fall back to the default (never redirect to chat).
  `SettingsNav` extracted and shared with in-app `SettingsLayout`, so the two
  surfaces cannot drift. `document.title` set for the window.
- **Entry points (keep both):** gear, page-menu "Open Settings", and
  quick-actions areas call `openSettingsWindow()` (new dynamic-invoke helper
  in `platform.ts`, bundle contract preserved) on Tauri � areas deep-link to
  their section; plain in-app navigation on web. In-app routes untouched.
- **Verification:** typecheck 0, full build green, backend smoke (health/
  providers/SPA 200) on a fresh server. Rust compiles on CI only (no local
  toolchain) � `main.rs` follows codeg`s command shape exactly; needs the
  workflow artifact as proof.

## Web settings second tab (codeg openAppWindow parity)

- **Named tab, not in-app:** web entry points (gear, page menu, quick-actions
  areas) open `#/settings-window/<section>` via `window.open(path,
  "tbai-settings")` � one reused tab, focused on repeat opens (new
  `lib/settings-window.ts`). Called synchronously in the click stack (no
  pre-await), so popup blockers stay quiet � codeg`s reservation dance is
  unnecessary here since we need no round trip first.
- **Never a dead click:** blocked popup ? toast + in-app fallback; failed
  Tauri invoke ? toast + in-app fallback (the old fire-and-forget `void`
  calls are gone from all three entry points). Blocked/invoke copy lives in
  `chromeConfig.copy`.
- **Cramp solved on web too:** the chromeless settings shell carries no rail,
  sidebar, tabs, or status bar � settings get the full tab width. In-app
  routes stay as the fallback + direct-URL surface (no auto-collapse hack).
- **Verification:** typecheck 0, build green, route + tab name present in the
  bundle, 22 unit tests pass, fresh-server smoke 200. Click-level proof needs
  a real browser (automation host has no localhost).

## Scheduler promotion + single rail gear (codeg automations parity)

- **Scheduler is a top-level page now:** removed from `SETTINGS_VIEWS`
  (settings sub-sidebar, settings window, and quick-actions lose it by
  derivation), routed as a direct `AppShell` child rendering new
  `SchedulerPage` (breadcrumb strip + existing panel). New
  `SchedulerTitleStrip` mirrors codeg `WorkbenchPageTitle` (back-to-chats �
  title, `h-10` transparent bar, label from `navigation.ts` via new
  `getNavItem()`); panel drops its duplicate `h1`. Rail icon + failure
  badge + `/scheduler` route unchanged.
- **Single-gear rule:** rail renders new `getRailNav()` � chat, scheduler,
  and ONE Settings gear (areas get `railVisible: false`; gear opens the
  dedicated surface). Top-bar and status-bar gears deleted; right cluster
  token shrinks 80 ? 48. Status-bar provider/model buttons join the surface
  flow (hardcoded `/providers` �3 + `/desktop` gone). Page-menu entry and
  quick-actions already used the flow � all three now share one
  `openSettingsSurface(navigate, section?)` helper (triplication removed).
- **Tests:** settings-nav membership updated (scheduler out); new rail test
  locks `["chat", "scheduler", "settings"]`.
- **Verification:** typecheck 0, build green, 29 unit tests pass, fresh-server
  smoke 200. Desktop visuals via CI.

## Settings back in the main window (revert of window/tab surface)

- **No separate surface:** the gear opens settings in the main window again
  (rail gear ? last-visited section; page menu, quick-actions, status bar ?
  their sections, all in-app navigation). Removed as dead code: the Rust
  `open_settings_window` command + `invoke_handler`, the `url` dep, the
  `"settings"` capability entry, `SettingsWindow.tsx`, `lib/settings-window.ts`
  (incl. the named-tab + toast flows). `SettingsNav` stays as the shared
  sub-sidebar; `lastSettingsRoute`/`rememberSettingsRoute` moved to
  `navigation.ts` (proper layering) with new `isSettingsRoute()`.
- **Cramp fix (the actual complaint):** `AppShell` auto-collapses the
  conversation sidebar on settings routes (frees ~224px beside the
  sub-sidebar) and restores it on return � via transient `settingsStash`
  (never persisted); a manual toggle meanwhile always wins over the restore.
- **Verification:** typecheck 0, build green, 29 unit tests pass,
  fresh-server smoke 200.

## Settings title strip; sidebar stays visible (revert auto-collapse)

- **Shared `PageTitleStrip`** (codeg `WorkbenchPageTitle` geometry): back-to-
  chats � title, transparent `h-10` bar. `SchedulerTitleStrip` reuses it;
  `SettingsLayout` renders it above the sub-sidebar with the active section
  label (fallback `"Settings"`).
- **Auto-collapse removed:** the conversation sidebar now stays visible on
  settings routes, exactly as on the Scheduler page. Deleted the `settingsStash`
  transient, the `AppShell` route effect, and the now-unused
  `isSettingsRoute()` helper.
- **Verification:** typecheck 0, build green, 29 unit tests pass,
  fresh-server smoke 200.

## Native todo + browser tools (agent-browser, no MCP)

- **Single toolkit architecture:** both new capabilities are first-party native
  tools built on the existing `AISDKToolkit` (server) + `defineToolkit` (client)
  pattern — no `useAssistantToolUI`, no second registry, no MCP. `generativeTools`
  is deprecated and intentionally not used.
- **Todo:** a durable, per-conversation notepad. SQLite `todos` table keyed by
  `thread_id` (FK `conversations` ON DELETE CASCADE). All CRUD lives in
  `src/services/todos.ts` (service owns SQL; no SQL in tool definitions). Every
  successful action returns the current list so the UI always reflects backend
  state. No approval required (benign, user-scoped).
- **Thread identity:** `AISDKToolkit` strips AI SDK `runtimeContext` from the
  `execute` second argument, so `threadId` is injected via a per-request closure
  (`withThreadContext` in `src/tools/index.ts`, applied in `src/routes/chat.ts`).
  Missing thread context is rejected by the service.
- **Browser:** uses the external **agent-browser** CLI (persistent Chromium daemon)
  via `Bun.spawn` in `src/services/browser.ts`. No browser automation, no MCP, no
  auto-install. Split into two tools: `browser` (read/navigation: open, snapshot,
  get, screenshot, extract — no approval) and `browser_action` (click, fill, press,
  act — gated by the existing `toolApproval: "user-approval"`). Command construction
  is explicit and typed per action (no arbitrary action+args passthrough); results
  are structured `{ action, ok, exitCode, stdout, stderr, path?, mimeType? }` with
  screenshot `path`/`mimeType` preserved for future image rendering. Missing binary
  returns a clear install instruction instead of throwing.
- **Validation:** action-specific Zod schemas in `src/lib/validation.ts`
  (`todoSchema`, `browserReadSchema`, `browserActionSchemaFull`) with `superRefine`
  required-field rules, re-exported from `src/tools/schemas.ts` as the single source
  of truth for both server and client.
- **Verification:** typecheck 0 (server + web), `bun test` 224 pass (added
  `src/services/todo.test.ts`, `src/services/browser.test.ts`; updated
  `tests/unit/toolkit.test.ts` to 20 native tools), full `bun run build` green.

## Scheduler page rebuilt on codeg automations (cards/list/detail)

- **Layout:** borderless toolbar (All/Enabled/Disabled pills + pill New Job +
  unseen-failures mark-seen) above ONE rounded shell: job list (32%) +
  detail (68%), fixed CSS split (no new dep). List panel muted, detail
  card-toned. Onboarding template gallery when empty.
- **Rows:** `h-8` pills (status dot by last run, name, next/last relative
  time, spinner while running, hover �). One action definition drives BOTH
  the � dropdown and right-click (Run now / Enable-Disable / Edit /
  Duplicate / Delete-via-AlertDialog). Selection never shifts row height.
- **Detail:** stat facts (Schedule, Next/Last run + chip, AI, Workspace,
  Conversation target with open-thread link), full run timeline (status-ring
  nodes, durations, error + output text, attempt #, thread links, cancel),
  actions. Blocks separated by rules, never nested cards.
- **Gallery:** blank card + the 7 existing JOB_TEMPLATES (icon tiles,
  human schedule chips � never raw cron) for empty state + New flow.
- **Editor:** the existing form relocated verbatim into self-contained
  `JobEditor` (keyed remount per target, back-to-templates/back-to-list
  exits); template seeding via lib `seedDraftFromTemplate`/`blankSeed`/
  `duplicateSeed` (the setter-based `applyTemplate` is gone). Weekday names
  via Intl, all copy in `config/scheduler.ts` (incl. validation strings).
- **Deleted:** `components/SchedulerPanel.tsx` (1760 lines) � nothing
  imported it besides the page. Store/API untouched.
- **Verification:** typecheck 0, build green, 41 unit tests pass (12 new
  lib tests), fresh-server smoke 200. Click-level proof needs a real
  browser; desktop bundle via CI.

## Scheduler border + cron-form alignment (codeg editor grammar)

- **White-border root cause:** `.dark` never defined `--border`, so every
  `border-border` fell back to the light `#e4e4e7` in dark mode. Added
  `--border: #27272a` (the only missing dark token � full `:root`/`.dark`
  diff done).
- **Divider fix:** list column`s `border-r` deleted � one shell border plus
  the muted/card tonal step only (codeg`s "no wedged divider" rule).
- **Toolbar pill:** active filter `bg-foreground` ? `bg-accent` (muted family).
- **Cron form (codeg trigger grammar):** Once/Repeat as a segmented group in
  a bordered container (raised active segment); once-datetime and repeat
  controls each fold into a schedule card; redundant inner Repeat label
  dropped; advanced cron input is mono. All fields, validation, save, and
  preview logic untouched.
- **Verification:** typecheck 0, build green, 35 unit tests pass,
  fresh-server smoke 200. Visual sign-off needs a real browser.

## Scheduler editor alignment + simplification (codeg form grammar)

- **Title unit:** borderless large name + plain subtitle description (the
  heading row keeps only back/X). Section titles all share one micro-label.
- **Buttons aligned:** chips are `xs`+outline (active `default`); icon-only
  buttons are `icon-xs`. Rule: chips = xs+outline, icons = icon-xs,
  actions = sm, primary CTA = default.
- **Sentence schedule row:** one dynamic line per mode (Every [N] min,
  At [H]:[M], weekday/month variants) with compact inline inputs � the
  labeled input maze and quick-pick chips are gone. Patterns show in
  Advanced mode only.
- **Seeded summary:** template/duplicate seeds start the When section
  collapsed to a one-line summary + Change; blank/edit start expanded.
- **Execution ? collapsed disclosure** (values still load/validate/save);
  **thinking capability-gated** (hidden where the provider registry offers
  no thinking; reset to off on provider switch). Prompt rows 5 ? 3.
- **Verification:** typecheck 0, build green, 35 unit tests pass,
  fresh-server smoke 200. Visual sign-off needs a real browser.

## Scheduler pane separation (single-color wash fix)

- **Cause:** dark `--muted` and `--card` are both `#171717`, so list
  (`bg-muted/50`) and detail (`bg-card/50`) rendered identically � verified
  against codeg, whose dark card (0.205) and muted (0.269) differ. Global
  retoken was rejected (whole-app blast radius, no visual proof available).
- **Fix (scoped):** detail + onboarding shells go solid `bg-card`; list stays
  `bg-muted/50`. Dark: #171717 vs ~#0e0e0e; light: #ffffff vs ~#fafafa � same
  direction as codeg (detail darker than list). Selected rows (`bg-accent`)
  keep their contrast on both.
- **Verification:** typecheck 0, build green. Visual sign-off needs eyeballs.

## Durable dark theme: adopt codeg`s neutral-dark scale

- **Stop patching, adopt the system:** `.dark` now uses codeg`s scale
  verbatim (oklch) � card 0.205, muted/secondary 0.269, accent 0.371,
  border/input translucent white, sidebar set to match, destructive
  lightened for dark. Only `--background` stays ours (#0a0a0a identity).
  Light theme untouched. This replaces the solid-vs-wash tricks: detail is
  back to `bg-card/50`, toolbar pill to plain `bg-accent` � the scale
  carries them correctly.
- **Why it works:** panes/rows/chips/dialogs all inherit codeg`s measured
  relationships (list lighter, detail darker; selected elements lift via
  accent 0.371). Future components get it free � no per-surface compensation.
- **Verified live (agent-browser, computed styles + screenshots):** scheduler
  panes/step/rows/chips/gallery, chat + composer, providers settings cards,
  sidebar/rail/status/tab strip. Dark first, light unchanged by construction
  (untouched block).
- **Note:** initial load served stale CSS (browser cache) � `reload` before
  measuring; build output verified to contain the new values first.

## Terminal Block migration (official assistant-ui element, live output)

- **Element (vendored, not forked):** `terminal-block.tsx` + `surfaces.tsx` +
  `utils/range.ts` copied verbatim from assistant-ui registry
  (packages/ui/.../elements/). Registry CLI cannot resolve in this repo
  (`terminal-block` 404s under every flavor path; `npx` absent, bunx path
  tried). The ONLY adaptation: `CheckIcon`/`Loader2Icon` aliased to
  `Check`/`Loader` (installed lucide-react lacks the Icon-suffixed names).
  No styling/behavior/API changes; file header documents this. `ink`
  variant chosen for the dark UI (verified live).
- **runBash stays UI-independent:** optional `onOutput({stream, chunk})`
  only; without it the return shape is byte-identical. Pump uses one
  TextDecoder per stream (no cross-stream split corruption), listener
  errors swallowed, timeout/kill/workspace/limits untouched.
- **Live streaming (existing transport only):** `withThreadContext` wires
  `run_command.execute(args, opts)` � `toolCallId` comes from the standard
  AI SDK `ToolExecutionOptions` (verified in provider-utils typings:
  "use it e.g. when sending tool-call related information with stream
  data"). `src/lib/terminal-stream.ts` batches into `data-tbai-terminal`
  parts (150ms/4KB flush, 400-part cap, done part always lands, per-call
  isolation). `chat.ts` emits via the existing writer + closes on
  `onToolExecutionEnd` with exit metadata. No smoothing (`useSmooth` /
  `smoothStream` explicitly out � terminal shows real timing).
- **Read path (fallback-first):** `terminal-ui.tsx` renders the official
  block from the final tool result always (complete on reload/history).
  Live lines merge from message-scope `data-tbai-terminal` parts matched by
  `toolCallId`. Critical fix found in verification: the assistant-ui
  converter normalizes wire `{type:"data-tbai-terminal"}` to
  `{type:"data", name:"tbai-terminal"}` (verified in
  @assistant-ui/ai-sdk convertMessage.js) � the initial check missed this
  and live lines silently returned []. Unregistered data parts render
  nothing (no stray UI; progress parts use the same path).
- **Exits:** official header hardcodes `exit 0` (no failure prop � do not
  fork). TBAi chrome below the block shows red `exit N` / `timed out �
  process killed`. Non-zero is never presented as success.
- **Verification:** backend tsc 0, `bun test` 271 pass / 0 fail (incl. 16
  terminal-lines + 7 batcher + 5 runBash tests), web build green. Live E2E
  in real chat: multiline output, mid-run spinner+cursor, completion
  checkmark, failing command red exit footer, approval?execute?result,
  denial?zero execution. Live stderr/timeout-kill covered at unit level
  only (same code paths). Transient provider "network error" seen twice
  (also on tool-free sends) � external endpoint flake, unrelated.

## Welcome new-chat screen (Codeg parity, UI-only)

- **Decision:** centered welcome (WelcomeScreen: hero + Code/Office/Research quick actions + folder-scope picker + tall composer) rendered only on 	hread.isEmpty; thread creation carries pending {workspaceMode, workspaceFolderId} via adapter initialize() with simple-chat fallback. No new deps, no backend change.
- **Why:** matches Codeg start-chat UX while keeping assistant-ui runtime, untime.ts wiring, and SQLite workspace model untouched; config-first copy in config/welcome.ts, UI state in eatures/chat/state/welcomeScope.ts.
- **Edges:** deleted folder falls back to simple, kind=chat never listed, bound threads show static scope, storage keys namespaced with safe-parse.


- **Single composer update:** one <PaseoComposer/> tag owned by ChatWindow (footer slot carries the Codeg-style folder chip row inside the composer box); welcome and docked placements share identical size/features. Folder chip trigger/panel and quick-action accent cards + skill rail converge on Codeg classes without adding cmdk (DropdownMenu substitute, documented). Verified live via browser: 1 textarea on /chat/new and on existing threads.


- **Refresh-flash fix (identity gate):** welcome renders iff draft route (ChatView passes isDraft) AND thread empty; bound threads never mount WelcomeScreen, even while history loads. Composer footer scope row always rendered (editable chip on drafts, static chip from 	hreadListItem.custom on bound threads) so box size is identical. E2E (web/e2e, Playwright + system Edge headed): single-composer + refresh-flash specs; @playwright/test added as web devDependency.


- **Identical composer box:** docked wrapper uses the same mx-auto w-full max-w-3xl px-4 container as welcome (one class-token change, no inline styles); headed e2e asserts welcome/docked textarea boxes equal (710x40 at x=421).


- **Chip row below the box:** folder scope chip renders as a separate row beneath the composer (not Codeg's inside-the-box attached row) per user call; composer box is textarea + button row only, unconditionally identical on both screens.


- **Identical composer+chip gap:** welcome column wraps composer + picker in the same px-1 pt-1 sub-structure as docked (was column gap-6 = 24px vs pt-1 = 4px); measured 4px on both screens.


- **Status CHECK rebuild (2026-09-13):** live DB predated the status-vocabulary change and kept CHECK(status IN ('regular','archived')) while code writes in_progress � all conversation creation 500d. Fixed with a gated table rebuild (copy 12 cols, convert values in SQL, preserve ids/indexes/triggers/FTS). Old DB backed up to data/backup-20260913/; user then opted to delete the live DB instead, so production runs a fresh DB. dapter.initialize() now throws on failed creation instead of resolving an undefined remoteId.


- **Binary conversation status (regular/archived):** removed the 4-status model (nothing fully used it; it broke archive/unarchive which PATCH binary values). DB CHECK rebuilt, scheduler guard reads archived, sidebar shows runtime running dots + Archive/Unarchive only. conversation persistence (regular/archived) != runtime activity (isLoading/isRunning) != job execution (scheduler_runs.status).


- **Composer bar pass:** single Composer.tsx (renamed from PaseoComposer); primitive owns textarea autoresize (custom grow hook deleted); single-slot Send/Stop via documented AuiIf idiom with identical footprint; thinking/model chip order; searchable keyboard-navigable model picker (no virtua � small lists); own composer context menu (atomic clipboard ops, quick messages); all icons retained.


- **Providers Codeg visuals, our domain:** rows/badges/toolbar/header/dialogs copy Codeg classes verbatim (rounded-md border px-3 py-2.5 rows, Badge secondary text-3xs, h-8 w-40 filter Select, sm:max-w-md dialogs) while keeping our provider model (types, models/discovery, thinking, set-active, test-connection, in-use delete guard). Inline add/edit form moved into Add/EditProviderDialog; list stays mounted. New ui/select.tsx + ui/badge.tsx copied from Codeg (radix-ui meta-package already installed — no new deps).

- **Logs sink reuse (no new appender):** the files card reads the logger's existing rotated JSON-lines sink (data/tbai.log*, 5 MB x 3) — zero writer/rotation code added or touched. Empty in dev (file sink off by default); copy says so.

- **Logs scope semantics:** overrides match dot-separated scope prefixes (longest wins, `mcp` covers `mcp.client`), validated by SCOPE_RE; Codeg's `::` EnvFilter syntax does not apply to our flat scopes. No `trace` level anywhere (never emitted): capture/view offer off + debug/info/warn/error only.

- **Logs spans omission:** our LogEntry has no span chain, so the expanded detail is fields-grid only — Codeg's spans breadcrumb has nothing to render from.

- **Logs virtualization deferred:** plain scrollbox keeps Codeg look (h-[30rem] mono viewport, stick-to-bottom at 80px); add virtua only if scroll jank is observed with the 2000-row client cap. Transport stays SSE (UI-invisible); pause closes the stream like Codeg instead of buffering.

- **Theme tokens from Codeg:** --radius-4xl (calc(var(--radius) * 2.6), same 0.625rem base so identical 26px) plus text-2xs (11px) / text-3xs (10px) font-size-only utilities; replacing text-[10px]/[11px] arbitrary values is zero-diff at 100% zoom.

- **Pill Button/Input/Textarea base, app-wide:** ui/button.tsx + ui/input.tsx + ui/textarea.tsx copied from Codeg verbatim (rounded-4xl base, border-transparent buttons, bg-input/30 outline/inputs, select-none, active press translate, asChild/Slot support). Blast radius is every button/input in the app by design — that IS the Codeg look (the logs/providers rounding complaints came from mixing pill Selects with rounded-md buttons). Size/variant names match 1:1 so call sites are untouched; icon-xs/sm/lg keep working. Verified by full unit + headed e2e.

- **Self-hosted Inter:** @fontsource-variable/inter added (first intentional UI font dep) + :root --font-sans stack, 16px/1.5em, font-synthesis none, optimizeLegibility, antialiased/grayscale smoothing — mirrors Codeg's root typography. Mono stacks untouched (Codeg also uses the Tailwind default mono for UI).

- **Stale-server JSON banner (2026-09-14):** "Unexpected token '<' ... not valid JSON" on /#/logs means the running server predates /api/logs/settings + /files (SPA fallback serves index.html). The banner is correct handling; fix is restarting the :3000 server, not code.

- **Logs DOM leak: duplicate React keys (2026-09-14):** "logs escaping the box" was tens of thousands of leaked row nodes, not styling. Two compounding causes, both fixed: (1) the h-[30rem] viewport's inner list had no height bound, so rows spilled past the border — inner is now `h-full overflow-y-auto overflow-x-hidden` with the scroll ref on it. (2) Every page load appended the SSE backlog on top of the initial GET /recent snapshot, duplicating every seq; duplicate keys desync React reconciliation and orphan DOM nodes on each update (~1300/sec). mergeLogEntries (web/src/lib/log-entries.ts, unit-tested) now drops re-delivered seqs, and a server bootId (fresh per process, sent with /recent + stream) replaces state on restart instead of colliding with reused seqs. Note: the elicit/pending poller emits ~500 entries/sec, so the 1000-entry ring holds ~2s of history — silence noisy scopes via overrides or calm the poller as follow-up.

- **Centralized logging refinements (2026-09-14):** RequestContext stays minimal (requestId, conversationId, toolCallId, jobId, providerId, modelId — correlation only). docs/logging.md charter holds the hard funnel rule (one owning funnel per event; lower layers never re-log lifecycle). Event taxonomy standardized: http.request/http.error, ai.request/response/error, tool.start/finish/error, scheduler.run/admin/maintenance, credential.error, mcp.operation — ~60 call sites migrated, established one-off diagnostics kept. src/lib/errors.ts#classifyError is the single classifier (category/statusCode/provider/retryable/message/errorType); onError, sanitizeStreamError, and isRetryableError all consume it (scheduler keeps its documented abort nuance). Edge middleware auto-logs every 4xx/5xx response, which let us DELETE the scattered route error lines (tools, mcp routes, providers test/discover converted to ai.error since they return 200). Storage stays replaceable: only logger.ts knows entry/file formats; files endpoint serves opaque bytes. Explicitly NOT added: separate logging service, Redis, Elasticsearch, OpenTelemetry, custom event bus, per-function logging, logging-driven retries.

- **SSE idle kills (2026-09-14):** ERR_INCOMPLETE_CHUNKED_ENCODING on /api/logs/stream was Bun.serve's ~10s idle timeout killing quiet streams — our heartbeat was 15s, so any silence over 10s (capture off, filtered scopes) died mid-chunk. Heartbeat is now 5s (~7 bytes per ping; documented in routes/logs.ts). Client additionally reconnects SSE with backoff (5 tries) before degrading to polling, instead of abandoning SSE on the first error. Proven live: idle stream held 25s+ receiving pings on an isolated server.

- **Server transport hardening, Phase 1 (2026-09-14):** Bun.serve idleTimeout 10s -> 240s global backstop (Bun maximum is 255; 240 leaves headroom). Streaming endpoints (POST /api/chat, GET /api/chat/resume/:streamId, GET /api/logs/stream) additionally disable the timeout per-request via disableIdleTimeout() in routes/shared.ts, using server.timeout(req, 0) reached through Hono's env (verified live: c.env.timeout is a function in our stack) with a graceful no-op guard. 5s SSE heartbeat kept (beats proxies too). No bytes injected into the UI-message stream; no client changes. Research basis: Bun docs prescribe per-request disable over global raises; industry (model-lens ADR, LiteLLM, RFC 8895) confirms keepalive-comments + conservative-global + reconnect layering. Quiet SSE held 30s+ on an isolated server post-change.

- **Emit hardening + 24h retention (2026-09-14):** file sink is async-batched (10ms/64KB flush, unref'd timer, drop-with-counter over 5000 queued, sync drain on exit); ring+console stay synchronous. Rotation check cached (byte estimate + 60s); prune piggybacks the flush path hourly — no new timer system. Policy 5MB x 20 / 100MB total / 24h age (all runtime-configurable + persisted, env-overridable); file toggle in the capture card. Elicit poll 1.5s -> 3s and routine 200s demoted to debug via a DEBUG_PATHS table (pending hits stay info at the MCP funnel). sample() ships tested for Phase 5, no production caller yet (verified by grep).
/files also exposes writer {queued, dropped} so batching/load-shedding is
observable without trusting internals.

- **Tail contract + viewer durability + governance (2026-09-14):** polling
fallback retired (SSE-only; since+bootId dedupe makes redelivery safe).
virtua Virtualizer added (recorded here per dependency rule) wrapping the
existing scroll container — Codeg's exact pattern, all stick/scroll logic
untouched; ring + client caps raised to 5000. Time-range query (from/until,
server + client), export-to-JSON-lines, "/" + "End" keyboard, capture-off and
reconnecting indicators, requestId-searchable filter (documented Codeg
deviation). Token-bucket throttle (burst 100, 1/sec, info/debug non-http) with
in-stream scope.throttled markers + snapshot in /settings + capture-card note.
E2E lesson recorded: datetime-local inputs interpret as LOCAL time —
toISOString (UTC) silently lands in the past; build test datetimes from local
components. Live measurement 2026-09-14: elicit
polls at ~3/sec aggregate from multiple open tabs (stale pre-fix tabs still on
1.5s cadence + old polling fallback) — code ships 3s + debug demotion; users
reload tabs to converge. Our sink is data/tbai.log, not the .agnes path from
an unrelated report (different app). Existing rotation test updated to the batch contract (flush-per-round, lossless line count instead of byte totals).

- **Funnels built (2026-09-14):** tool funnel = instrumentedExecute in src/lib/tool-funnel.ts (leaf module, zero cycle risk by construction after rejecting a tools/index.ts home that cycled via schedulerTools); all 16 native entries + withThreadContext rebinds + MCP bridge + 11 scheduler tools pass through it. AI funnel = taxonomy boundary emitters at both streamText sites (chat keeps its pipeline shape; shared streamChat helper deferred to a third site). Scheduler funnel = run lifecycle taxonomy + jobId/providerId/modelId context bound at both executeJobRun call sites. Credential funnel = decrypt-failure lines only. extendRequestContext skips undefined (never wipes outer bindings); emit() now merges the full context — a funnel unit test caught that gap before it shipped. AI SDK tool() overloads need the generic-passthrough wrapper shape (fixed signature poisons input/output inference); three scheduler literals needed explicit any.

- **Server-owned chat runs + explicit cancel (2026-09-14):** the isolated signal experiment proved c.req.raw.signal fires identically (AbortError: The connection was closed) on client-disconnect, Bun idle-kill, and explicit cancel — the server cannot distinguish causes, so an explicit cancel channel is mandatory, not optional. src/services/chat-runs.ts owns runs keyed by streamId (own AbortController per run, 30-min wall clock via TBAI_CHAT_RUN_TIMEOUT_MS, 1h terminal TTL via TBAI_CHAT_RUN_RECORD_TTL_MS, 2000-record cap, lazy sweep on every mutation, unref'd timers). src/routes/chat.ts binds model + MCP tools to run.controller.signal, never the request signal; disconnect marks detached (ai.run_detached) and the run continues. POST /api/chat/cancel/:streamId is the only path that stops a run: settles synchronously (markCancelled → single ai.error/category=cancelled log → controller.abort) so onAbort no-ops on the terminal record instead of racing the API response; repeated cancel returns cancelled:false with current status (404 on unknown id). Frontend Stop fires it fire-and-forget via sessionStorage tbai-resume:${threadId}. Orphan policy: abandoned-running runs continue detached until explicit cancel or wall clock; terminal records swept after TTL/cap — no background loop. Mount-path resume unchanged. Explicitly out: mid-run auto-resume trigger (no public seam in @assistant-ui/ai-sdk 0.0.4 / ai 7.0.93; Option B classification + copy + observability only). Test-seed lesson: black-hole providers must be type ollama (keyless by design) — type custom requires a stored key and the route correctly 400s. Proven: 7 unit + 2 integration + 419 full suite + 9 e2e (2 empty-DB skips) + live temp-server proof (abort→detached→cancel→idempotent). Wall-clock kill covered by unit fake-timers only.

