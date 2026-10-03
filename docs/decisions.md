# Architecture Decisions

Recorded so future changes have context. Add new decisions here.

## Durable architecture direction

- **Decision:** TBAi uses thin composition around mature runtimes. The full
  forward-looking contract lives in `docs/architectural-principles.md` (linked
  from `AGENTS.md` and `docs/architecture.md`).
- **Reason:** reduce custom infrastructure, avoid duplicated runtimes/frameworks,
  isolate provider/vendor-specific behavior behind adapters, and keep memory/UI/
  runtime responsibilities cleanly separated. TBAi owns orchestration and policy
  (state, scheduler, providers, security, memory policy); assistant-ui owns
  chat UI/runtime, AI SDK owns Direct execution/streaming, OpenCode owns
  coding-agent execution behind its adapter, MCP uses the official client, and
  ICM is durable shared memory behind TBAi's `MemoryService`.
- **Alternatives rejected:**
  - a second chat runtime or message state framework
  - a universal custom tool-rendering framework (prefer official assistant-ui
    elements; TBAi-specific renderers only for demonstrated capability gaps)
  - merging ICM with TBAi's application SQLite (databases stay separate; ICM is
    authoritative for memory, TBAi SQLite for application state)
  - spreading OpenCode protocol details through generic UI/application code
  - treating questions as approval interactions (questions are forms returning
    `answers[][]`; permissions are a separate allow/deny contract)
- **Status:** this is the target architecture, not a requirement to preserve
  every existing custom implementation — prefer deleting obsolete custom code
  when upstream capability becomes sufficient.

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

## Added dependencies (with reasons)

- **`@ai-sdk/openai-compatible@3.0.44`** — chat-completions providers (`custom`,
  `ollama`, or an `openai` provider explicitly set to chat-completions) are now
  built with this factory instead of `@ai-sdk/openai`'s chat model.
  **Reason:** `@ai-sdk/openai`'s chat-completions delta schema declares only
  `role`, `content`, `tool_calls` and `annotations`. A gateway's
  `reasoning_content` — how DeepSeek/Qwen-style models stream their thinking — is
  therefore discarded before it can become a message part, and the UI can never
  render a thinking block. Verified live against this deployment's gateway
  (`https://apihub.agnes-ai.com/v1`): it streams `delta.reasoning_content`, and
  the SDK dropped it. The compatible provider declares that field.
  **Version pinned exactly** (`3.0.44`, not `^`): it is the release whose
  `@ai-sdk/provider` (4.0.10) and `@ai-sdk/provider-utils` (5.0.36) match the
  three existing provider packages. A newer release pulls a *second* copy of
  `@ai-sdk/provider`, which makes the provider types structurally incompatible
  and fails typecheck. Verified after install: both factories resolve the same
  single instance.
  **Alternatives rejected:** a custom `fetch` rewriting the SSE stream (the SDK's
  schema strips unknown delta fields, so no rewrite can surface reasoning); and
  pointing the gateway at the Responses API (third-party gateways do not
  implement `POST /responses`).

## Reasoning ("thinking") — decisions

- **`Off` is a selectable level, not a "Default" placeholder.** The composer chip
  used to map the disabled state onto a "Default" label and offered no `off`
  entry at all, so a conversation with thinking switched off still read as if
  something would happen — and could not be switched off explicitly. The chip now
  shows the level actually in use from a single shared
  `ReasoningLevel = "off" | "low" | "medium" | "high"` union (`web/src/types`).
  The Code-mode chip keeps a different, server-driven vocabulary (variants) on
  purpose — see `docs/ai-integration.md`.
- **`chat-provider-options.ts` is the only place reasoning options are shaped.**
  It was extracted from the chat route because each branch is a provider quirk
  whose failure mode is silence, not an error: `includeThoughts` (Google returns
  no summaries without it), `thinkingLevel` vs `thinkingBudget` by Gemini
  generation, the Gemini-2.5-only lite gate, and the factory-dependent
  `providerOptions` namespace.
- **New providers still default to `thinking: "off"`.** Enabling thinking by
  default would make every reply slower and costlier, so the default stays
  conservative and the chip states the level plainly instead. Revisit if the
  silence turns out to be the bigger problem.

## Process decision — `scripts/verify-reasoning.ts`

Reasoning defects were found one provider at a time, each with a throwaway
script, because every one of them fails **silently**. The harness is now a kept,
committed script: it prints the option shape for every provider type × model
generation without a key, and with `--live` makes one real call per configured
provider and reports the reasoning-delta count. Two hard-won rules are baked into
it: the probe prompt must be substantial (reasoning models skip thinking on
trivial questions, which reports a false negative), and the intercepted `fetch`
must return a **well-formed terminating SSE** or the SDK buries the report in a
stack trace.

## Dependency decisions

- **`assistant-stream`** — The old application-owned `createProviderStream` path
  and `createAssistantStreamResponse` are removed because they emit the older
  Assistant Stream Protocol, which `AssistantChatTransport` does not consume.
  The official `assistant-stream/resumable` API is retained for resumable byte
  storage, and the library's no-op `generateTitle` stream remains a small
  `RemoteThreadListAdapter` utility; neither is a second chat runtime or message
  protocol. The direct dependency is aligned to `0.3.43`, the same version
  resolved by the assistant-ui packages.
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

## Server startup and shutdown ordering (2026-09-25)

- **Decision:** Provider registry and credential initialization complete before
  scheduler recovery, because overdue-job recovery can execute a real model
  call. Independent MCP/workspace cleanup still runs in parallel. Graceful
  shutdown closes owned resources, then sets `process.exitCode` and lets the event
  loop drain instead of forcing `process.exit()`, so piped stdout/file logs are
  not truncated.
- **Why:** `Promise.all` across every boot task removed a real ordering
  guarantee; forced exit removed the final shutdown evidence on piped stdout.
- **Alternatives rejected:** keeping boot fully parallel for speed, and a
  timeout-based forced-exit flush workaround.

## Direct AI SDK boundary hardening (2026-09-25)

- **Decision:** The Direct route treats the AI SDK v7 UI-stream outcome as the
  authority for chat-run settlement. `toUIMessageStream.onEnd` records the
  producer outcome; a response-body drain is observational and can never promote
  an error or unknown stream to success. The route logs successful completion as
  `ai.response` and failures as `ai.error` with sanitized classification fields.
- **Validation:** The Direct transport envelope is explicit, and message
  internals are validated with `safeValidateUIMessages` before the existing
  approval-aware pruning/conversion path. Non-empty client `system`, `tools`,
  `callSettings`, and `config` directives are rejected; persisted conversation
  instructions are passed server-side as AI SDK `instructions`.
- **Approval security:** Direct `streamText` calls use a stable, separately
  generated per-install `experimental_toolApprovalSecret`, encrypted in the
  existing `app_settings`/`CredentialStore` boundary. First initialization may
  provision the setting; every later request re-validates it, so missing or
  corrupt material fails closed. Unsigned historical approvals are not
  re-signed.
- **Retry policy:** Direct `streamText` uses explicit zero request/stream retry
  budgets. Once any output has arrived, replaying the call can duplicate text,
  reasoning, or tool effects; the UI provides an explicit user retry instead.
  `stop`, `length`, `tool-calls`, and `content-filter` are accepted terminal
  provider outcomes; `error`, `other`, and a missing finish reason fail closed.
- **Logging:** Direct lifecycle logs contain correlation IDs, provider/model
  names, counts, durations, and classifications only. Prompt text, system text,
  provider endpoint URLs, tool payloads, approval signatures, and raw provider
  error messages are excluded.
- **Alternatives rejected:** blanket `finishReason: "other"` fallback, model- or
  provider-specific exceptions, a custom SSE rewriter, blanket stream retries,
  and a second Direct persistence/runtime layer.
- **Deferred boundary:** the current official in-memory resumable store remains
  process-local. A SQLite-backed chunk store and durable run registry require a
  separate storage/lease/retention design; they are not smuggled into this
  correctness/security change.

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
  @assistant-ui/react-markdown (MarkdownTextPrimitive) + 
emark-gfm
  (GFM tables, task lists, strikethrough). Streaming-safe: parses
  incrementally with smooth reveal; data-status mirrors part state.
- **Syntax highlighting**: the official shiki-highlighter element over
  
eact-shiki. Tokenization is deferred while a code block streams and
  settles afterwards without layout shift.
- **Code blocks**: language label + copy button ship in the registry
  component's CodeHeader; long lines scroll inside the block.
- **Diffs**: the official **code-diff** element (`CodeDiff`), vendored to
  `web/src/components/assistant-ui/elements/code-diff.tsx`. Routed from ```diff
  fences through the same `SyntaxHighlighter` override as before, and from
  OpenCode `edit` patches. Unified view, add/del tinting, +/- counts.

  **CodeDiff replaces the legacy DiffViewer; diff rendering uses TBAi semantic
  `--diff-*` tokens rather than hardcoded palette colors.** Upstream tints rows
  with Tailwind palette classes (`emerald`/`red`); those are replaced by the
  same `var(--diff-add-bg|--diff-add-rule|--diff-add-text, <default>)` pattern —
  and the `--diff-del-*` trio — that the legacy viewer used, so a theme can
  override them exactly as before and the default look is unchanged. The
  `--diff-*-rule` tokens are honoured as the inset rule bar, which upstream's
  element had no equivalent for.

  The second deviation: the counts and the gutter use a **hyphen**, not U+2212
  (`-1`, not `−1`) — what the legacy viewer rendered, so the migration changes no
  visible character and the existing `rendering.test.tsx` assertions hold
  unmodified.

  `diff-viewer.tsx` (599 lines) is **deleted**; `diff` was removed from
  `web/package.json` and the lock, since that file was its only importer.
  `parse-diff` stays — `patchToCodeDiffs` uses it. `class-variance-authority`
  stays — four other components use it.

  Text → structure conversion lives in `web/src/lib/patch-to-diffs.ts`
  (`patchToCodeDiffs`): `parse-diff` for a well-formed patch, then the
  **`parseLooseDiff` fallback** for the header-less `+`/`-` diffs models
  routinely emit (load-bearing — without it those fences collapse), and
  multi-file aware, returning one structured diff per file. Nothing is
  fabricated: a file the patch does not name gets an empty filename.

  Not carried over from the legacy viewer, because nothing used them: the split
  view, the `oldFile`/`newFile` content-diff mode, line numbers, and the
  size/style variants.
- **Reasoning/tools**: official 
easoning, 	ool-group, 	ool-fallback
  elements rendered through MessagePrimitive.GroupedParts +
  groupPartByType (current API; components.ChainOfThought is legacy).
  Reasoning renders only when the provider emits reasoning parts; thinking
  budgets are configured per provider (see Thinking-model latency above).
- **Dependencies added**: @assistant-ui/react-markdown, 
emark-gfm,
  
eact-shiki (brings shiki), diff, parse-diff, 
adix-ui (unified
  package for Collapsible/Tooltip), 	w-shimmer (CSS). cva,
  clsx, 	ailwind-merge were already present.

### Custom code ledger (rendering)
| Custom piece | Size | Why |
|---|---|---|
| `diff -> DiffViewer routing (HighlightingSyntax in ChatWindow.tsx) | ~15 lines | MarkdownText's SyntaxHighlighter slot is language-agnostic; routing diff fences to the official DiffViewer is app glue. |
| prettyToolName (rendering-glue.ts) | ~10 lines | MCP tool names are mcp__<serverId>__<toolName>; displayed as "server - tool" for readability. |
| asChild adaptation in tooltip-icon-button.tsx | 1 line | Installed radix-ui@1.6.7 TooltipTrigger supports asChild but not the newer 
ender prop used by the registry file. |
| ui/button + ui/tooltip + ui/collapsible + ui/textarea | ~150 lines | Registry elements import these shadcn primitives; this project had a different Button/Input/Textarea set in ui.tsx. Adapted to the existing dark-first token style. |
| context-display.tsx (tooltip import + arrow) | 2 lines | Vendored Radix flavor imports `@/components/ui/radix/tooltip`; ours lives at `@/components/ui/tooltip` (same exports). Upstream hides `[&_[data-slot=tooltip-arrow]]`; our Arrow carries no such slot, so the popover hides `[&_svg]` instead. Shared tooltip untouched. |
| context ring wiring (context-ring.tsx + OpenCodeContextRing.tsx + modelContext.ts + chat.ts metadata) | ~200 lines | Registry has no TBAi wiring: backend attaches `usage` on the AI SDK `finish` part; Direct ring reads the official `useThreadTokenUsage()`; Code ring reads `V2ThreadState.usage.tokens` (no second store); window prefers OpenCode `model.limit.context`, else the model's configured `contextWindow` from provider settings (Zod/DB/API already carried it; dialog now shows + edits it per model), else one documented fallback constant — no per-model table in code. No pricing, no fabricated splits; hidden until usage exists. |
| context-display click pin (deviation #3) + #185 selector split | ~40 lines | Upstream trigger is hover/focus-only: Root holds a `pinned` flag (`open={pinned \|\| undefined}`, released on native dismiss) toggled from Trigger clicks — unpinned behavior is byte-identical upstream. Pure `nextPinState`/`pinnedOpenProp` carry the click contract (unit-tested; the no-DOM repo can't render Radix). Separately, the OpenCode selector now returns the store-held tokens reference with mapping memoized outside (`useMemo`), because allocating in the external-store selector loops React (#185). |

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
  + per-thread `sessionStorage` keys + abort/finish `isFinishEvent`. The direct
  dependency is pinned to `assistant-stream@0.3.43` in both root and web
  manifests, matching the assistant-ui train. The Direct stream producer's
  `onEnd` outcome, not response drain, settles server-owned runs.
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
- **Why:** matches Codeg start-chat UX while keeping assistant-ui runtime, 
untime.ts wiring, and SQLite workspace model untouched; config-first copy in config/welcome.ts, UI state in features/chat/state/welcomeScope.ts.
- **Edges:** deleted folder falls back to simple, kind=chat never listed, bound threads show static scope, storage keys namespaced with safe-parse.


- **Single composer update:** one <PaseoComposer/> tag owned by ChatWindow (footer slot carries the Codeg-style folder chip row inside the composer box); welcome and docked placements share identical size/features. Folder chip trigger/panel and quick-action accent cards + skill rail converge on Codeg classes without adding cmdk (DropdownMenu substitute, documented). Verified live via browser: 1 textarea on /chat/new and on existing threads.


- **Refresh-flash fix (identity gate):** welcome renders iff draft route (ChatView passes isDraft) AND thread empty; bound threads never mount WelcomeScreen, even while history loads. Composer footer scope row always rendered (editable chip on drafts, static chip from 	hreadListItem.custom on bound threads) so box size is identical. E2E (web/e2e, Playwright + system Edge headed): single-composer + refresh-flash specs; @playwright/test added as web devDependency.


- **Identical composer box:** docked wrapper uses the same mx-auto w-full max-w-3xl px-4 container as welcome (one class-token change, no inline styles); headed e2e asserts welcome/docked textarea boxes equal (710x40 at x=421).


- **Chip row below the box:** folder scope chip renders as a separate row beneath the composer (not Codeg's inside-the-box attached row) per user call; composer box is textarea + button row only, unconditionally identical on both screens.


- **Identical composer+chip gap:** welcome column wraps composer + picker in the same px-1 pt-1 sub-structure as docked (was column gap-6 = 24px vs pt-1 = 4px); measured 4px on both screens.


- **Status CHECK rebuild (2026-09-13):** live DB predated the status-vocabulary change and kept CHECK(status IN ('regular','archived')) while code writes in_progress � all conversation creation 500d. Fixed with a gated table rebuild (copy 12 cols, convert values in SQL, preserve ids/indexes/triggers/FTS). Old DB backed up to data/backup-20260913/; user then opted to delete the live DB instead, so production runs a fresh DB. adapter.initialize() now throws on failed creation instead of resolving an undefined remoteId.


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

- **Shared approval-card shell (2026-09-14):** Paseo study showed their permission card is deliberately minimal -- flat 8px card, no shadow, no animations, no per-state colors, no timeout; all engineering in correctness (exact action-ID round-trip, double-submit guard, stale-snapshot guards). Adopted: inline stacked cards, flat no-shadow shell, exit-by-removal, dismiss-as-deny, persist-until-resolved. Skipped: their RN tokens (we use our own -- rounded-2xl / border-border / bg-card, the inner-panel step our composer/Select already use; old rounded-md bg-background/60 card was the outlier), their zustand pending-Map (approval state stays in the assistant-ui runtime message graph by architecture -- no store change), animations beyond tw-animate-css. New web/src/components/shared/approval-card.tsx (ApprovalCard + ApprovalActions + useApprovalExit, our tokens only, vars-driven dark mode, zero hardcoded colors) feeds both BackendToolView/ApprovalGate and ToolFallbackApproval (which gains the toolName as card title). Deny stays outline-muted, never danger-red, per Paseo evidence. No approval timeout exists on either side (user-confirmed); "timed-out" proof uses the existing run_command execution-timeout display. Single judgment call to review: the requested 100ms fade-out cannot work with zero logic touch (parent-driven unmount kills CSS exit animations), so submits defer via a local 100ms setTimeout (runWithExit; cleared on unmount, reverted on refused submit) -- approval payloads and semantics identical, no deps, no store. Enter is 150ms fade+zoom on mount via tw-animate-css (already installed).
- **Approval card sizing + collapse (2026-09-14):** follow-up to the shared shell. Card width stays inherited (w-full in the max-w-3xl column, ~736px max) -- no fixed width. Height: min-h-[140px] stops layout jumps when gate swaps to spinner/result; max-h-[60vh] with internal scroll guards pathological previews; submit buttons always stay below the scroll region (whole-card max-h was rejected because it could trap buttons). Footer moved lower with its own divider (mt-4 border-t border-border pt-3) so action sections read as separate blocks. Decided states collapse into a slim one-line row (status icon + truncated title + outcome Badge + chevron, Radix Collapsible, existing Badge variants; denied uses the soft destructive chip) with expand-on-click: approved-pending/denied/cancelled/failed/closed/auto all collapse; live executing spinner and successful result summaries stay expanded. Fallback decided states stay null (its trigger row already carries status). Inter-card separation my-1 to my-2.
- **Simple-chat workspace migration (2026-09-15):** every simple chat owns workspace/chats/<conversationId> (stable, canonical, conversation-owned) instead of data/chat/<uuid>. New conversations bind the new path at creation (conversationService.create passes the id into createChatWorkspace, so no new legacy debt accrues). Pre-existing legacy rows migrate lazily on first filesystem resolve: copy (cpSync recursive-force, resume-safe) -> verifyTreeCopy (relative set + byte sizes, exported for tests) -> UPDATE the SAME folders row (ownership preserved, UNIQUE(path) safe) -> retain legacy + utimes grace so startup GC spares it another stale-window. Crash before the row switch retries; after it no retry needed; verify failure throws migration_verify_failed with legacy + row untouched; missing legacy dir creates fresh with a warning. gcOrphanChatDirs now sweeps both data/chat and workspace/chats against one canonical live-path set. Project rows never touched. resolveConversationWorkspace() is the shared contract (absolute canonical stable dir, opaque to consumers) � proven pre- and post-migration via external consumer probes, including cross-process re-resolve. Grants/outside-flow operate on the resolved dir unchanged; permission + containment suites pass unmodified as canaries.



- **Workspace single source of truth (2026-09-15):** `useWelcomeScopeStore` + `WelcomeScopePicker` are the ONE folder/directory control for all four engine/workspace combinations (Direct × simple, Direct × folder, OpenCode × simple, OpenCode × folder). No Code-only folder list. Simple chat auto-creates `workspace/chats/<conversationId>` in the background. A bound Code conversation shows a display-only folder chip below the composer (no mid-session re-rooting); the chip reads the bound conversation's `workspaceMode`/`workspaceFolderId` via the thread's `custom` bag and reuses the same static chip as bound Direct threads. `ChatWindow` mounts `WelcomeScopePicker editable={false}` in the agent branch when a bound conversation exists.



- **Repaired a corrupt untracked scratch file (2026-09-16):** `scripts/perf.ts` was an untracked scratch file that had been saved with assistant prose injected mid-file, splitting it into a truncated first copy and a complete second copy behind a ` ```ts ` fence — which made `bun run typecheck` fail with 64 syntax errors and nothing else. Repaired by keeping the complete copy (the corrupt original is at `D:/tmp/perf.ts.corrupt-backup`). Worth noting as the reason a green typecheck is now meaningful: every one of those 64 errors was in that one file, and no file touched by the live-stream fix had any.


- **Reply Markdown is not re-animated: `smooth` explicitly disabled (2026-09-16):** the reply renderer now passes `smooth={false}` to `MarkdownTextPrimitive` (`web/src/components/assistant-ui/elements/markdown-text.tsx`). `@assistant-ui/react-markdown@0.14.15` defaults `smooth` to **`true`** (`src/primitives/MarkdownText.tsx:193`), which routes arriving text through `useSmooth` (`:209`) — a client-side typewriter that reveals one character at a time on `requestAnimationFrame` (`@assistant-ui/react/src/utils/smooth/useSmooth.ts`: `drainMs` 250, `maxCharIntervalMs` 5) and reports the part as still `running` until that animation catches up (`:283`). The rendered reply was therefore not the text that arrived, it was an animation of it. That contradicted the project's own rule for live output — the terminal entry above already records smoothing as "explicitly out … terminal shows real timing" — the terminal block honoured it, the reply bubble did not. **`defer` is retained** (it only lowers the priority of re-parsing the growing message; it does not re-animate text). Nothing else changed: remark plugins, GFM, markdown components, code blocks, terminal rendering and non-streaming messages are untouched — `smooth` only gates the `useSmooth` reveal, and the code-block streaming state is read from the **real** part status (`shiki-highlighter.aui.tsx` → `useAuiState(s => s.optional.part?.status.type)`), never the smooth status, so `smooth={false}` cannot change Shiki behaviour. **Verified:** `bun run typecheck` exit 0; `bun run test` **608 pass / 2 skip / 0 fail** across 67 files (+4 from the new guard); the web bundle was built and the artifact diffed — the previous bundle (`index-DPbgjNIZ.js`) contained **0** occurrences of `smooth:!1`, the new one (`index-BJ-1841k.js`) contains it as `…className:"aui-md",components:n,smooth:!1,defer:!0`. Live warm-browser run on a fresh Code conversation (headless Edge), two messages: first visible text at **300 ms** and **157 ms**; Markdown intact (`strong` 1 + 2 list items on message 1; `strong` 1 + inline `code` 1 on message 2); no refresh required; a refresh left the thread identical (4 messages / 2 assistant before and after). The regression guard `web/src/components/assistant-ui/elements/markdown-text.test.ts` is deliberately **source-level, not behavioural**: `web/` has no component-test runner (no vitest/jest/testing-library and no DOM harness), so the prop contract is asserted against the source — mutation-checked, i.e. removing `smooth={false}` fails it and the `defer` assertion is independent of the `smooth` one. **Explicitly NOT claimed:** this does not explain the separate "later lines appear before the first line finishes" ordering artifact, which a prefix reveal cannot produce; and it is not the dominant latency source — the same run measured a 63-character reply taking **79.6 s** wall clock, so the model/agent, not the renderer, is where the time goes. Note also that `bun run build`'s web step is blocked **in this sandbox** by the CLI bulk-delete shim on Vite's own `emptyDir` (`SAFE_DELETE_BULK_CONFIRM_REQUIRED`, 320 files > threshold 50); the bundle was produced non-destructively with `vite build --emptyOutDir false` into the same `web/dist` (verified safe: `web/.gitignore:6` ignores `dist`, 0 tracked files).


- **Assistant replies render as separate blocks, not one nested stack (2026-09-17):** the reported defects — "tools permission in nested block and other block are also in one big block and then sub blocks not as separate blocks" — had four independent causes, all in `web/src/components/ChatWindow.tsx` and all verified in the installed library rather than assumed. (1) **One wrapper bubble**: the whole `GroupedParts` tree sat inside a single `max-w-[85%] … rounded-xl bg-muted px-3.5 py-2.5` div, so no sub-block could read as its own block. (2) **Tools nested inside the thinking block**: the group map was `"tool-call": ["group-chainOfThought", "group-tool"]`, and `groupPartByType` coalesces by **shared path prefix** (`groupParts.d.ts:15-24`), so every tool group was rendered as a *child* of the `group-chainOfThought` node. (3) **A permission card could hide inside a collapsed group**: `AutoOpenToolGroup` opened only when `part.status.type === "running"`, but a tool awaiting approval is `requires-action`, not running — so the group stayed collapsed with the card inside it. This is very likely the "tools permission in nested block" the user actually saw. (4) **The synthetic `indicator` part was dropped**: `GroupedParts` emits a trailing `{type:"indicator"}` while a message runs (default mode `"no-text"`, `MessageGroupedParts.d.ts:42-53`) and the switch had no case for it, so the official streaming affordance rendered nothing. **Fix, using only official mechanisms:** the map is flattened to `reasoning: ["group-reasoning"]`, `"tool-call": ["group-tool"]`, `"standalone-tool-call": []` — a tool group is now a **sibling** of a reasoning block, and adjacent tool calls still coalesce into one `group-tool` so the "N tool calls" collapsible survives. The single bubble is gone and each top-level node owns its own surface (`max-w-[85%]` carried over, so the column width is unchanged — only the shared background and padding are removed). Group status now comes from `GroupPart.counts` (`MessageGroupedParts.d.ts:8-14`) instead of one part's status, and `pending={part.counts.requiresAction > 0}` opens a group that is waiting on approval, which is what makes a permission card visible. `case "indicator"` renders a `ThinkingIndicator`, marked `aria-hidden` because the action bar already announces streaming state and the live timer — double-announcing would be worse than silence — and **gated on `threadIsRunning`**. That gate was not in the first cut: the library's own condition is per-**message**, so a message left marked `running` (this repo has one — an errored turn that produced no text) emitted a permanent pulsing affordance beside a live, idle composer. The first headless run showed exactly that, which is how it was caught; `thread.isRunning` is the same signal the composer trusts to unmount its send button, so the affordance can now only appear while work is real. **Deliberately shared, not forked:** `ChatWindow` is used by both Direct and Code modes, and the single-bubble/nested-tool layout was equally wrong for Direct tool calls, so both surfaces change together; reversible in one commit. Explicitly *not* touched: user bubbles, the action-bar/provenance row, error rendering, `MessagePrimitive.Root`, the composer, the grouping helper itself, and the Phase 1 permission logic. **Verified:** `bun run typecheck` exit 0; **118 web tests pass / 0 fail** (up from 111 — the 7 new ones are the structure guard); web bundle built non-destructively and **artifact-diffed against the pre-change bundle**: the control (`index-DupkyReR.js`) contains `group-chainOfThought` **1**, `case"indicator"` **0**, `counts.running` **0** and the old bubble class **1**, while the shipped build (`index-B3Gzg2i6.js`) contains **0 / 1 / 1 / 0** — i.e. the nesting key and the wrapper are gone, and the two new mechanisms plus the thread gate are all present. The guard `web/src/components/ChatWindow.blocks.test.ts` is source-level for the same documented reason as the other two guards (`web/` has no component-test runner). **A trap worth remembering:** the first version of that guard asserted `not.toContain("group-chainOfThought")` against the *whole file* and failed — because the explanatory comment above the map names the removed prefix. The assertions are scoped to the `groupPartByType({...})` literal instead; this is the same class of error as regex-grepping a minified bundle, where prose or minifier folding defeats a naive text assertion. **Browser-confirmed, not just asserted:** a headless-Edge run opened a real Code-mode conversation that contains a `write` tool call (`live-stream verify`, session `ses_f54cc688effeRQZdSnEacw7FA1`) and probed the live DOM plus a screenshot. Measured: `nestedInReasoning: 0` (the tool group is **not** inside a reasoning container), `oldBubbleNodes: 0` (the single wrapper is gone), `markdownBlocks: 4` (four independently-rendered text blocks), `toolGroups: 1`, `indicators: 0` after the gate (it was `1` before, pulsing on an idle thread), and no page errors. The screenshot confirms the reading directly: each Reasoning panel is its own outlined block, the reply text is bare, and the tool group sits *below* the reasoning panel as a sibling. **Caveat on what that does and does not settle:** this verifies structure and the absence of the reported nesting on a real thread; it is not a substitute for the user's own look, and the tool group still wraps a single call in a "1 tool call" collapsible (the library's adjacent-run grouping, unchanged). **Phase 3 is planned but deliberately not started**, and preparing it surfaced two blocking findings recorded in the current Code tool contract: the existing rich UIs read *our* native field names (`p.args.path`, `r.content`) so OpenCode's `filePath`-shaped parts need a small `adapt()` reshape rather than bare reuse; and routing permission-gated tools (`bash`, `edit`, `write`) to a rich UI goes through `BackendToolView` → `ApprovalGate`, which has its own submit path and **no** stale-permission guard, so mapping them without adding parity would reintroduce the exact wedge Phase 1 fixed.


- **All-phases tracker (2026-09-17):** new `docs/phases.md` is the single index for every phase across all tracks (lifecycle hardening 0–7, Code-mode rendering 2/3A–3D/4, OpenCode V2 migration, queued + deferred work). Statuses recorded from evidence on disk, detail stays in the owning docs (linked, never copied). Update protocol: whoever finishes a phase flips its row in the same change. No code, no dependencies, no behavior change.

- **Tauri Windows autostart via official plugin (2026-09-18, UNVERIFIED — GitHub build only):** `tauri-plugin-autostart = "2"` (Cargo) + `@tauri-apps/plugin-autostart ^2.0.0` (web) + `.plugin(tauri_plugin_autostart::init())` in main.rs + `autostart:default` capability. No custom registry/Startup-folder/Task-Scheduler code anywhere. UI: `StartupSection` on the Desktop settings page (Tauri-only render), switch bound to the OS truth (`isEnabled()` on open, `enable()`/`disable()` + re-read on toggle, pending guard, toast + revert-to-actual on failure). Platform-boundary rule kept: `platform.ts` dynamic-imports only, browser bundle untouched. Local installs forbidden on this PC, so the package resolves only in CI: `web/src/types/tauri-autostart.d.ts` carries ambient signatures (official v2 `enable/disable/isEnabled`) to keep `tsc` green. Verified: `bun run typecheck` exit 0, backend build green; `build:web` fails ONLY on resolving the uninstalled package (environmental, proves nothing else is inconsistent). Pending GitHub workflow (install → build → Tauri bundle) + manual toggle ON/OFF + restart-persistence check. No commit/push yet per maintainer instruction.

- **Tool UI copy centralization (2026-09-19):** Centralized TBAi-owned tool UI copy into `web/src/config/tools.ts` (`toolsConfig.copy`), mirroring `web/src/config/composer.ts` and `web/src/config/scheduler.ts`. Removed scattered string literals (`Reading…`, `Writing…`, `Editing…`, `Running…`, `Searching…`, `No output.`, etc.) from all native tool renderers (`web/src/tools/filesystem/ui.tsx`, `computer/ui.tsx`, `computer/terminal-ui.tsx`, `scheduler/ui.tsx`, `todo/ui.tsx`, `browser/ui.tsx`, `opencode/ui.tsx`). Dynamic parameters (command, query, path, counts, results) remain parameterized via formatters. Upstream/vendored assistant-ui elements (e.g. `web/src/components/assistant-ui/elements/web-search.tsx` and `terminal-block.tsx`) remain strictly untouched per AGENTS.md §1/§4.

- **Web server port is configurable with explicit restart (2026-09-19):** TBAi has exactly ONE application web server (`Bun.serve` in `src/server.ts`); changing its port never restarts implicitly. Port precedence: explicit `PORT` env wins (UI locks, same pattern as the log env locks), then `app_settings["server.port"]`, then 3000. Persistence reuses the `app_settings` upsert pattern from log-settings, plus a one-line `data/port` mirror file that is the cross-process contract the Tauri shell reads at startup (opening SQLite from Rust was rejected as heavier than a text file). `startServer` keeps full subsystem init; `restartListener` rebinds ONLY the listener (DB/scheduler/MCP survive): bind-new-first (conflict throws, old untouched) → persist (failure rolls back by closing the new listener) → swap active → close old after 500 ms so the in-flight restart response flushes (documented ordering, not a timing fix). Signal handlers registered once and resolve `activeServer` lazily so a post-restart SIGINT/SIGTERM shuts down the current listener. Routes (`src/routes/server.ts`, mounted `/api/server`): `GET /` (active/configured/persisted/envLocked), `PUT /port` (save without restart), `POST /restart` (validate→persist→rebind; occupied→409, invalid→400, never claims success), `POST /check-port` (pre-flight probe: any HTTP response or stalled accept = occupied, only refused = free; advisory, bind re-validates). Tauri `main.rs` resolves the port from the mirror file (validated 1–65535, fallback 3000) and uses it for sidecar env, readiness wait, and webview URL — no hardcoded port remains in the shell; `tauri.conf.json` keeps 3000 as the dev-time default only. Frontend `ServerSection` (Desktop settings, extended surface): Active row with live status dot (15 s identity poll, never steals typed input) + Copy URL; Port field with Save (dirty vs configured) / Test / Restart-to-apply (pending vs active); restart pre-flights check-port, polls new `/healthz`, then navigates preserving path+hash (same-origin relative API calls make navigation the entire reconnect). Live-verified on scratch ports (3221↔3222, user 3000 untouched): 20/20 script checks (save-only split, invalid 400, free/active/occupied probes, occupied-restart 409 with old alive, rebind with old closed, same-port and default-port no-ops, move-back) + env-lock boot (PUT/restart 409, server stays up). `bun run typecheck` exit 0, `bun run build` exit 0.

- **Tauri startup is identity-safe: never navigate on a bare open port (2026-09-19):** the packaged exe showed the dev instance because `wait_for_port` (TCP connect) cannot tell whose server answered — dev holding :3000 made the probe pass for the wrong server. New invariant: `TCP open ≠ TBAi ready`; ready = `GET /api/server/instance` returning the expected UUID. Backend: per-boot `INSTANCE_ID` (`TBAI_INSTANCE_ID` env from the launcher, else `crypto.randomUUID()`; process memory only, never persisted/derived), served at `GET /api/server/instance` as exactly `{instanceId}`; boot bind self-heals (explicit `PORT` env occupied fails honestly; otherwise scan up ≤100, persist the winner so mirror/DB/next boot agree). Rust (`main.rs`): fresh UUIDv4 per attempt → mirror pre-heal (bounded probe, written back) → spawn sidecar with `TBAI_INSTANCE_ID` (NO `PORT` env, so Settings stays editable; the mirror is the rendezvous, re-read every poll for TOCTOU heals) → poll identity → match navigates, anything else (mismatch/404/timeout/exit) renders the bundled `resources/startup-error.html` via `document.write` (zero backend, zero navigation, JSON-encoded payload; Retry = `invoke("retry_startup")` + 5 s auto-re-verify backstop so recovery never depends on the invoke). Same-folder second copy is refused by a HELD `fs2` exclusive lock on `data/.lock` (handle kept in managed state; Windows releases on crash — create-and-delete was rejected as crash-unsafe). One sidecar/listener/ID per attempt: retry kills the previous child first. New deps `uuid`, `ureq` (sync poll; hand-rolled HTTP rejected), `fs2` — no second client, no behavior change to chat/MCP/permissions. Capability `remote.urls` widened to `http://localhost:*/**` + `http://127.0.0.1:*/**` (URLPattern standard, documented for varying localhost ports; same command set as before, localhost-only, no privilege expansion). Frontend unchanged (same-origin relative). Live-verified backend on scratch ports: env id served verbatim, `{instanceId}`-only shape, occupied-3000 healed to 3001 persisted+mirrored, two boots minted distinct UUIDs. `bun run typecheck` exit 0, `bun run build` exit 0. Rust compiles in CI (no toolchain on this machine); cases A–F with real packaged copies are user acceptance on the machine that owns the failing environment.

- **Route/service import cycles are load-bearing defects, not test bugs (2026-09-19):** `routes/server.ts` imported listener functions from `../server`, closing `routes/index → routes/server → server → routes/index`. Production survived only by entry order (`index.ts` → `server.ts` first); loading the routes standalone (as `logs-settings.test.ts` does for edge coverage) died with `Cannot access 'app' before initialization` — and the failure was misread as pre-existing because it reproduced in isolation. Fix: extracted all listener ownership + per-boot identity into `services/server-listener.ts` (fetch handler injected at boot; imports only logger + server-port), which routes import freely. `server.ts` keeps init/shutdown/signals/static-serving. Verified: the 2 failing cases now pass (9/0), backend typecheck + backend build clean, live unlocked restart 3000→3255 with old listener confirmed dead (an earlier `restarted:false` in the same session was a PowerShell curl-quoting artifact — the body never parsed and the configured-port fallback no-op'd honestly, which is itself the designed behavior). Test mocks that import `../server` for these functions move to the service path with the test agent.

- **Desktop tray: close hides, quit is explicit (2026-09-19):** the frameless window's ❌ used to end the whole app (window + server) with no recourse. New contract: close → hide to tray, server keeps running; full quit ONLY via tray Quit or Settings "Quit TBAi" (both funnel into `quit_owned`: stop owned sidecar, `app.exit`, lock releases via handle drop). Tray (core `TrayIconBuilder`, no new plugin) has Open (show + focus; same on left-click) and Quit, with a live `TBAi · port N` tooltip set at verified navigate. Boot-to-tray via `server.startMinimized` (app_settings + `start-minimized` mirror file, same rendezvous pattern as the port — Rust reads it pre-spawn) with a switch in the Startup section next to autostart; Settings Quit asks `confirm()` first. Frontend reaches all of it through `platform.ts` (dynamic imports preserved, browser bundle clean). `bun run typecheck` exit 0, `bun run build` exit 0 (one transient TS6133 in an unrelated file, gone on re-run — concurrent-agent race, not this change). Rust compiles in CI.

- **Code-mode composer chips: instant reflect + dismiss + live runtime (2026-09-19):** two reported bugs shared one root — chip state had no write-through. (1) Changing agent/model on a bound chat PATCHed the server but updated nothing locally: the label reads a fetch-once config hook, and the runtime defaults derive from the same hook at mount — so neither label nor next send reflected the pick until reload. Fix: `useOpenCodeConversationConfig` gained a module-level override map (`updateConversationConfig`, called only after successful PATCH) merged into every instance via `useSyncExternalStore` — chips, `OpenCodeView` defaults, and therefore next sends (the native V2 controller reads the selected agent and model on every send) all update instantly; overrides are keyed by conversationId (no cross-chat leak) and failed writes change nothing visible. (2) Chip menus had zero dismiss wiring — `OpenCodeChipMenu` now closes on outside pointerdown + Escape with cleanup on unmount. All in `OpenCodeChipShared` + the config hook; the three chip components only pass `onClose`. Typecheck + build green; interaction guards handed to test agent (no DOM runner in web/).

- **Composer + status bar + sidebar batch (2026-09-19):** (1) Code model menu: search field + provider-grouped sections (`w-64`), copy in `welcomeConfig.copy`, no API change. (2) Status bar background token `--statusbar` (`#262626` dark) replacing `bg-muted/40`. (3) Status bar content: deleted the static "Local" label and Direct-only provider button; left shows live `:port` (reachability dot + active port, click through to Desktop settings) via shared `useServerIdentity()` (also adopted by `ServerSection`); right is route-aware - `/code/*` shows the conversation's live agent and model (override-reactive, empty while loading, never stale), everything else keeps Direct provider and model. While wiring this, a concurrent agent's backend-availability feature (`availabilityStore`, four-state `/readyz` machine) was found mid-flight - integrated rather than overwritten: the dot + label follow its state machine, the port suffix is new. (4) Sidebar is Folders, Chats, Recent; the Archived section moved to a rail surface (`/archived`, after Scheduler, reusing the archived list hook + rows). **Deliberate CodeG parity break:** CodeG keeps Archived in-sidebar (verified in its source: `SIDEBAR_SECTION_KEYS` + "glance-able where was I" comment); TBAi moves it to the rail for a cleaner sidebar at the cost of one more click to reach archives. Stale persisted section orders drop the retired id via an allow-list filter; the `archivedExpanded` store field + config default were removed outright (persisted payloads tolerate absence). Typecheck + build green.

- **Native server tools are AI SDK `tool()` definitions, not `AISDKToolkit` entries (2026-09-23):** the direct-chat tool assembly moved from the assistant-ui `AISDKToolkit` + `ServerToolEntry` + `withThreadContext` pattern to native AI SDK v7 `tool()` definitions with typed `contextSchema`/`toolsContext`, deleting `ServerToolEntry`, the `js()` Zod→JSON-Schema conversion, `entries`, `aiToolkit`, and `withThreadContext` outright (~110 lines removed from `src/tools/index.ts`). The audit that motivated this corrected the record: (1) there was NO concurrency bug in `withThreadContext` (it rebuilt the execute map per request over a freshly-spread `ToolSet`); the migration is about deleting the adapter layer, not fixing a race. (2) `runtimeContext` never reaches `execute` — only per-tool `context` (validated `toolsContext` entries) does — so the old closure injection is replaced by the official `toolsContext` map keyed by tool name. (3) `AISDKToolkit`'s execute wrapper forwards only `{ toolCallId, abortSignal, human }`, which is exactly why native tools must bypass it to receive context. **Shape:** static module-scope `tool()` defs (`nativeTools`) with Zod schemas passed directly as `inputSchema`; three context schemas — `workspaceContext` (`workspaceDir` required + optional `threadId`) for the 8 fs tools + `run_command`, `todoContext` (optional `threadId`; the service still throws without a thread), `schedulerContext` (`workspaceDir` + optional `providerId`/`modelId`, defaults injected on `create` only) — and no `contextSchema` on process/system/browser tools (browser keeps using `opts.abortSignal` natively). The chat route builds one `toolsContext` per request (`buildToolsContext`, fail-closed with `ToolError` on a missing root), merges MCP tools unchanged, and passes `toolsContext` to `streamText` with an explicit `streamText<NativeToolSet>` generic (without it the MCP `Record<string, any>` spread would erase the context types and collapse `toolsContext` to `never`). The single exception to static defs is `run_command`'s terminal tap: a function cannot ride validated Zod context, so `withTerminalOutput()` rebuilds just that tool per request with the `onTerminalOutput` closure (single funnel instrumentation, not stacked). **Parity preserved line-for-line:** funnel `conversationId` on exactly fs + run + todo (now derived from `context.threadId` inside `instrumentedExecute` instead of a static `funnelExtra` — scheduler/browser/process/MCP emit none, as before); scheduler defaults on `create` only with explicit IDs winning; `todo` throwing without a thread; grant scopes unchanged; the `toolApproval` map and client `defineToolkit` renderers (name-keyed contract) untouched. **Untouched by design:** OpenCode backend/frontend (own tools, own adapter), MCP manager (already native `tool()`), scheduler execution set (already native `tool()`), `/api/tools/*` manual surface. **Train freeze:** no dependency version changed — `@assistant-ui/ai-sdk` stays for the client `useChatRuntime` transport; only the server's `AISDKToolkit` *usage* was removed. Earlier entries describing `AISDKToolkit`/`withThreadContext` as current architecture (native todo+browser tools 2026-09-1x, terminal block, funnels) are superseded by this one and kept as history. `tests/unit/terminal-wiring.test.ts` imports the deleted `withThreadContext` — rewritten by the test agent, not here.

## OpenCode native V2 boundary

- **Decision:** TBAi uses the official `@opencode/client@2.0.16` in both direct consumers. The backend creates it in `src/services/opencode/client.ts`; the browser creates it in `web/src/features/opencode/v2Client.ts` through the same-origin proxy.
- **Runtime:** Code mode uses the native V2 external-store controller, event reducer, history loader, prompt lifecycle, permission lifecycle, form lifecycle, and cancellation path under `web/src/features/opencode/`.
- **Model variants:** agent, model, and thinking variant remain independent persisted conversation settings. The selected variant is sent in the native `session.create` model reference; the UI derives available variants from the V2 model list.
- **Server boundary:** the managed server is constrained to `>=2.0.15 <2.1.0`. Session, agent, model, tool, permission, form, and event behavior use only the generated V2 contract.
- **Policy ownership:** TBAi retains conversation persistence, workspace/session bootstrap, auto-approval policy, proxy/auth enforcement, and UI composition. OpenCode wire formats remain inside the OpenCode service/feature boundary.
- **UI contract:** assistant-ui owns chat primitives; the Code feature supplies native V2 projections and the existing shared tool renderers. Forms return `answers[][]`; permissions remain a separate allow/deny contract.
- **Dependency rule:** no second OpenCode client, streaming protocol, MCP client, or context provider is introduced.
- **Hydration isolation:** server/session/history are required for readiness. Inbox, permission, and form snapshots are auxiliary; a failed auxiliary snapshot starts empty and is repopulated by later events.
- **Strict V2 data boundaries:** agent rows require the generated `name`, token usage maps the generated `TokenUsageInfo` fields, session lookup treats only the official missing-session response as absent, Code thread metadata carries the TBAi conversation id separately from the OpenCode session id, and chip writes merge complete Agent/Model/Thinking state.

## ADR: Direct Chat durable resumable streams (2026-09-25)

- **Status:** approved architecture and **implemented** — store, boot recovery, cleanup, route wiring, detached history finalization, resume observability, and the Phase 3 recovery notice with its guarded Retry. The one deliberate gap is decision 3's crash window, documented in the design doc §9. The full design, with the on-disk contracts it was derived from, lives in `docs/2026-09-25-phase2-durability-design.md`. Scope is Direct chat only — the OpenCode boundary above is untouched.
- **Core decision:** replace the **implementation** of the resumable byte store, not the streaming contract. `src/lib/resumable.ts` keeps `createResumableStreamContext`; only the store behind it changes from `createInMemoryResumableStreamStore()` to a SQLite-backed implementation of the same official `ResumableStreamStore` interface. The AI SDK v7 UI-message protocol, the `assistant-stream/resumable` lease/read protocol, and the existing `/api/chat/resume` route all stay exactly as they are.
- **Why this shape:** the official interface already abstracts the store, so durability is a substitution rather than a rewrite. That is what keeps this phase from becoming a second streaming protocol — the wire format, the headers, the resume mount, and the client's knowledge are unchanged.
- **Run registry split:** `chat_runs` remains **process-local** and keeps its current job — the active producer/`AbortController` registry, the wall clock, and the in-process settlement latches. An `AbortController` and a timer cannot be made durable, so durability is not attempted there.
- **Durable mirror:** a new `chat_streams` table records persistence and outcome state for each run. It mirrors the outcome; it does not replace the run registry and never resurrects a run.
- **Two status axes, deliberately separate, with one owner each:** the official stream status is `streaming | done | error` (the assistant-stream contract, with `missing` derived from row absence) and answers *"did the byte stream end?"* — only the official `finalize` and boot recovery write it. TBAi terminal semantics are `completed | failed | cancelled | interrupted` and answer *"did the run succeed?"* — only the Direct route writes it, through `recordRunVerdict`, which touches `terminal_kind` and nothing else. `interrupted` has no official equivalent, so it rides on a `status='error'` row. The split is what lets resume tell a genuine provider failure from a dead producer, and it drives different user copy.
- **Why the route must not own `status`** (corrected during implementation, after four Direct tests failed): the route's failure settlement fires from `onError`, which runs **while the producer is still appending** the parts that carry the error. Closing the row there makes the library's next `append` throw `finalized`, so the producer aborts and the client loses the structured `error` part it needs. Waiting for the library's `finalize` first does not help either: the library finalizes the byte stream as `done` even for a failed run, so the verdict would then need a `done → error` downgrade, which re-breaks the live response. Consequently `status='done'` with `terminal_kind='failed'` is a normal, expected combination — the UI stream closed cleanly and carries its own `error` part in the bytes — and both settlement paths keep the first verdict on the row (`COALESCE`) so nothing later relabels a run. `cancelled` and `interrupted` are final, and an aborted byte stream is never recorded as `completed`.
- **First writer wins, and this was a real defect.** The settlement originally read `terminal_kind = COALESCE(?, terminal_kind)`, which is *last*-writer-wins: the library's `finalize('done')` silently overwrote a recorded `failed` (and blanked the recorded finish reason and error category), so the exact combination the split exists to represent could not occur. Corrected to `COALESCE(terminal_kind, ?)` across `terminal_kind`, `terminal_finish_reason` and `terminal_error_category`; `error_text` stays an assignment, because a failed byte stream must carry some stored text and the generic string is the security decision.
- **A completed run is never relabelled `interrupted` (the duplicate-reply trap).** The history write lands before `store.finalize`, so a crash in between leaves a `streaming` row whose verdict is already `completed` and whose reply is already in history. Boot recovery closes its byte stream but **keeps** the recorded verdict, reporting it as `preservedVerdicts` / `ai.stream_verdict_preserved` rather than counting it as an interruption. Relabelling it would tell the client a finished reply needs a retry, and the retry would create a second assistant message for it.
- **The documented limitation is scoping, not impossibility:** no structured final message is persisted and no boot path reconstructs one (decision 3). The stored bytes do contain the whole message, so a later phase can revisit that. The window is the interval between the durable `completed` verdict and the history write — narrow, because both happen in the same turn of the producer's completion.
- **Dead producer:** a producer that dies mid-stream becomes `interrupted`. Partial output is **never** written as a completed assistant reply, and interrupted runs are never automatically re-executed — they are labelled, surfaced, and the user initiates a new run.
- **Detached finalization:** a run that completes with no browser attached is finalized **server-side** through the existing `messageService.upsertStored` path, using the existing assistant-ui/AI SDK persisted format (`format: 'ai-sdk/v6'`) — the same call the connected client's `ThreadHistoryAdapter` makes, which stays the normal path and is not reimplemented. No second message store, no new format, no new table.
- **The persisted shape is the adapter's, and `"ai-sdk/v6"` is a format label, not a dependency version.** `aiSDKV6FormatAdapter.encode` is `({ message: { id: _id, ...message } }) => message`: the id is hoisted into `messages.id` and stripped from `content`, so the server writes exactly that and both writers emit the same representation. The label names the serialized message shape and predates `ai@7`; changing it would make every stored row undecodable. `schedulerExecution.ts` embeds the id inside `content` — tolerated only because the two ids are equal, and not the shape to copy.
- **Parent id is the branch, not "the last user message":** `messages[messages.length - 2]?.id ?? null`, taken from the array the AI SDK hands `onEnd`. That is what the browser's adapter records and it stays correct for a continuation, where the last user message is not the previous message. The design's `getThreadTip` fallback was dropped: with the user message unpersisted it chains the reply onto an earlier message, and a false parent is worse than `null`.
- **Run metadata is bound durably (`bindRunContext`):** the official contract knows nothing about conversations, so `conversation_id` was `NULL` on every row and the finalizer had no target. The route binds it right after `resumableContext.run()` returns, fill-only and never repointing a field. Keeping it only in the process-local run registry would fail the durability requirement outright.
- **Detachment is `chatRuns.detachedAt`, read before settling:** the design's `consumers` counter was dropped — it needed another persisted signal and was strictly worse. A client that drained the response and vanished is not detached; a client that resumed before completion is attached again; `attach()` clears the mark regardless of run status, so the value is read **synchronously before** `settleRun` in the same turn.
- **No genuine async work in `onEnd`:** the AI SDK awaits it in `TransformStream.flush`, so real async work there would delay the last byte. `upsertStored` performs only synchronous SQLite writes, so the row is durable by the time it resolves. Any future step added to that path must preserve this.
- **Never fabricate:** an aborted, absent, id-less, non-assistant or empty-parts final message yields a typed `chat_history_skipped` and `history_state='skipped'` — never a message assembled from partial chunks. The claim itself re-checks `terminal_kind='completed'`, so the store refuses a failed, cancelled or interrupted run even if a caller asks.
- **No `claimed` tombstone:** ADR decision 3 removed the boot re-arm, so a failure after the claim marks the row `skipped`. `PRAGMA foreign_keys=ON` makes the write throw when a conversation was deleted mid-run; the finalizer catches, marks `skipped`, and logs `chat_history_finalize_failed` with scalars only. The finalizer never throws, so bookkeeping cannot turn a successful run into a reported stream error.
- **Exactly-once finalization:** the history claim is a single-round-trip guarded conditional update where only `changes === 1` proceeds, and it suppresses duplicate **work** — the message id is the real idempotency key, plus `upsertStored`'s `ON CONFLICT(id) DO UPDATE` preserving `order_seq`, so a browser write and a server write converge on one row in either order and neither can reorder a thread. There is no second history writer and no second message format.
- **Disconnect semantics unchanged:** a browser disconnect never aborts the producer. It detaches only, the run continues, and — the point of this phase — the bytes survive process exit so a later resume can replay them.
- **No producer re-election, no lease stealing:** `stream_id` is server-minted per run, so a client can never cause a second acquisition. Orphans are resolved at boot rather than by a later producer seizing a lease; the lease token remains defence in depth. Replay never acquires, so it cannot resurrect a terminal row or re-drive the model.
- **Boot sweep vs periodic cleanup are different jobs.** The boot sweep may classify pre-existing `streaming` rows as `interrupted` — at boot no producer can have survived, so this cannot be a false positive. Periodic cleanup only removes expired **terminal** rows and never relabels a live producer; a slow-but-healthy run must not be mislabelled mid-flight.
- **Integrity stays inside the store:** snapshot + sequence is an internal property of the store's `read`/finalize path, invisible above the interface. Terminality is authoritative from the producer's `finalize`, witnessed by the terminal part marker, and a `done` row missing that witness is downgraded to `interrupted` with a sanitized integrity log line. No snapshot frame, event envelope, or client-side protocol concept is introduced.
- **Resume of a terminal cancelled stream** replays the **exact** stored bytes, including the abort terminal marker, and never turns into a new execution. **Terminality is one-way:** once a row leaves `streaming` nothing writes it back, and no path re-acquires it. A cancelled run stays cancelled for its retention window and is replay-only.
- **Retry is not resume:** `retry(oldRun)` mints a **new** `stream_id`, a new run, and a new assistant message; `resume(oldRun)` only replays bytes and never re-drives the producer. The old row is never reused, resurrected, or rewritten, and there is deliberately no API that re-drives a terminal stream, so a retry cannot be expressed as a resume by accident.
- **Multi-consumer is read-only:** several browsers may resume the same stream, but only the guarded claim writes history, so N clients still produce exactly one assistant message.
- **Bytes at rest stay plaintext,** consistent with `messages.content`, which already stores model output the same way. Encrypting only resumable chunks would split one security model across two behaviours for identical data; retention is the bound instead.
- **Retention and cleanup:** default **24 hours**, sliding on each append, configurable via `TBAI_CHAT_STREAM_TTL_MS` (same env style as the existing run-record TTL). Cleanup runs at boot and periodically, reports what it pruned, and is owned by one service so timer ownership stays single.
- **Resume endpoint unchanged:** `/api/chat/resume/:streamId` remains the resume endpoint and keeps the official resumable-stream contract. Complete vs interrupted is expressed by what the replayed bytes end in, not by a new status code or header; a missing stream still answers `404` as it does today, which keeps the existing self-healing path intact.
- **Prior art, cited narrowly:** the snapshot+sequence, rendered-recovery-state, and distinct-`restarted`-signal patterns were re-derived from the OpenChamber checkout (see the design doc for exact files). Its WebSocket relay, terminal sync layer, and transport model were **not** adopted — that is a different stack, and adopting them would have meant a second streaming protocol.
- **Phase 3 is separate:** the resume-failure Composer notice and its guarded Retry affordance are user-facing work that follows the durability implementation, so the storage contract lands and is proven before any copy is designed around it.
- **Phase 3 corrected the trigger, not the goal.** The design classified the durable reason in the transport's `onResumeError`, but that hook is **unreachable** with the installed `ai@7.0.93`: `makeRequest` never rejects (`ai/dist/index.js:19120-19320` — a failed reconnect is caught at `:19176`, an errored replayed stream at `:19273`), and `onResumeError` is only called from `chat.resumeStream().catch(...)`. The live hook is `onError`, which fires for both. The dead hook is kept, because it is the documented contract and costs nothing, with a comment saying why it is not the signal.
- **`GET /api/chat/stream-status/:streamId` (Phase 3).** A read-only projection of the same `chat_streams` row the resume protocol replays — `status`, `terminalKind`, `restarted`, `historyState`, and byte counters, safe scalars only. It exists because the only alternative was making a **Retry safety decision** by matching the server's English sentence in the client, which is precisely the fragility worth removing. `404` for a missing row and `400` for a malformed id are deliberately distinct: a client deciding on a Retry must be able to tell "gone" from "never existed".
- **Retry is gated on the server's verdict AND on having the prompt.** The server must report `interrupted` — the one terminal kind a live send can never produce, so a run that actually **completed** can never satisfy it. And the prompt must be non-empty, because a crashed run's user message was never written to history (the server was down when the browser tried), so there is genuinely nothing to re-send; a Retry that silently does nothing is worse than no button. Both conditions failing closed is the whole duplicate-message guarantee. Retry appends the last user turn as a **new** message with `startRun`, so it mints a new `stream_id` and a new assistant message id; the interrupted row is never re-driven.
- **Recovery is asked and answered per CONVERSATION, not per stream id.** The resumable pointer proved unusable as a key: it is transport-owned, the transport clears it when a send fails (before the failure is reported), and it does not survive an app restart. Verified live — a crash produced no recovery state at all, and hunting for one caused seven resume replays in ~20ms. `GET /api/chat/stream-status?conversationId=` reads the same durable row the resume protocol replays, so a client holding no pointer at all can still recognise a dead run. A side effect worth stating: the client no longer needs the resume machinery to learn what happened, so the replay storm **disappears** (zero replays measured) rather than being mitigated.
- **The re-read chain is owned by recovery, not by the availability poller.** A crash is always detected while the backend is down, so the first read always fails. Hooking the retry to the poller's offline→online transition was tried and failed: a single `/readyz` poll was observed across a whole crash-and-restart, so the transition can be missed entirely. The chain therefore backs off on its own (1.5s → 25s, five attempts, single scheduler) and stops as soon as a verdict arrives. It answers "has this conversation's verdict arrived?" — a different question from "is the backend reachable?" — so there remains exactly one reachability authority. An unreadable status is never read as "nothing happened": a thread that demonstrably had a run keeps an unconfirmed notice so the chain has something to upgrade.
- **Two findings from live verification that this phase did NOT fix**, both pre-existing and client-driven: (1) the app already renders its own "Connection interrupted. The AI run could not be resumed." notice, so the recovery strip is a second notice for one event; (2) 37 no-content assistant rows already exist in real user history. Both are recorded here rather than changed unilaterally.
- **An assistant message with nothing renderable is not persisted (phantom-blank-bubble fix).** The client posts an assistant row the moment a run *starts*, holding only TBAi's UI-only progress part; if the run then dies, nothing updates it and it renders as a blank bubble (`TodoList` returns `null` for an empty stage list). Measured on a real interrupted run: **0 rows had `parts: []`** — every phantom carried exactly one `data-tbai-progress` part with `stages: []`, so the defect is "renders nothing", not "empty array". The rule is enforced at the **client write boundary** (`POST /api/conversations/:id/messages`), which refuses a contentless assistant message and returns `{ success: true, persisted: false }`; `messageService.upsertStored` is untouched, so server-side writers (detached finalization, scheduler) are unaffected.
- **Why prevention, not cleanup.** A post-hoc delete would need run↔message identity that does not exist durably without changing the stream store, or would mean guessing from "latest message" — both forbidden. Refusing the write needs no run linkage, is idempotent by construction, cannot be resurrected by a reconnect, and cannot race a real reply (which arrives later as an update to the same id and is accepted). Verified live: the interrupted run alone leaves **no** assistant row, and a retry adds exactly one.
- **The rule is about the message, never the run's outcome.** At shell-write time the run is still in flight, so the outcome is unknowable; a guard cannot distinguish interrupted from cancelled from healthy, and one that pretended to would have to guess. So interrupted, failed and cancelled behave identically by construction: contentless is not yet a reply. The predicate **fails open** — any unrecognised part type is treated as real content, because silently dropping a part we do not understand would destroy a genuine reply. A progress part with stages is kept, since the user really saw it.
- **Pre-existing phantom rows are left in place.** Removing historical rows would mean deleting stored assistant messages on the strength of a heuristic, which is exactly what "do not delete a partially/fully persisted assistant response" forbids. A one-time cleanup, if wanted, is a separate and explicitly-approved operation.
- **Recovery notices clear at the send funnel**, not in the component, so Enter, the Send button, touch submit, and programmatic sends all clear it and no path can leave a stale Retry behind.
- **Dependency rule:** no Redis, no second database, no WebSocket relay, no second message store, and no custom streaming envelope is introduced.
- **Alternatives rejected:** keeping bytes in memory and accepting loss on restart; making `chat_runs` durable (a controller cannot be persisted, and 

## ADR: The orphan chat sweep refuses an unvouched-for workspace pairing (2026-09-26)

- **Status:** implemented and live-verified. `evaluateOrphanSweepSafety` in `src/services/workspace.ts`, applied by `gcOrphanChatDirs()` before any filesystem call.
- **The defect, twice.** `gcOrphanChatDirs()` decides whether a directory is still bound to a chat purely from the `folders` table, then hard-deletes (`rmSync`, no trash) everything unbound and older than 10 minutes. That is only sound when the database and the workspace belong to the same install. It has now destroyed real directories twice: **11** in one incident, and **1** more on 2026-09-26.
- **Why the existing empty-database guard did not prevent the second one.** `hasEstablishedConversations()` already stood the sweep down on an empty table, and it worked — until a boot used a scratch/verification database that *did* contain conversations. A populated foreign database is indistinguishable from a healthy one, so that guard was structurally incapable of catching this class. The hazard was known and documented in that function's own docstring, and it still shipped.
- **The rule:** a relocated `DATA_DIR` is only safe if the operator **also** stated `WORKSPACE_DIR`. Without that second statement the database cannot vouch for the workspace it is about to sweep, so the sweep stands down. Skipped instances log the existing `gc_skipped` event with `reason: "relocated_data_dir"` plus `dataDir`/`workspaceDir` and both boolean facts — paths and flags only, never a file or directory name.
- **Checked first, before the empty-database check, and before any destructive call.** Whether the sweep may run at all is a fact about how the process was launched. It must not depend on what the database happens to contain, because that is precisely the input a foreign database gets wrong.
- **A degradation, never an outage.** The only shape this affects is "relocated data directory, default workspace", and for that shape the cost is a leaked scratch directory instead of a deleted one. A normal install (both paths default) and a deliberately co-located install (both paths set) are untouched. This is why it was chosen over hard-failing the boot, which would convert silent data loss into a startup failure for setups that are perfectly legitimate.
- **Path comparison is canonical, not string equality.** `samePath`/`canonicalizeRoot` resolve `..` and Windows case/separator drift, so an equivalent spelling of the default directory is not mistaken for a relocation (which would silently disable the sweep on a normal Windows install).
- **Pure and exported** — the predicate takes the facts and returns the verdict, so the whole truth table is testable with no database and no filesystem. `WORKSPACE_DIR`'s *explicitness* is read from the environment at call time; `DATA_DIR` is already a module constant for the process lifetime, so the two can never disagree about which database is in play.
- **Verified by A/B in a disposable sandbox**, because testing a safety guard against the thing it protects is not a test. Same directory, same *established* database, same staleness, twice; only `WORKSPACE_DIR` differs. Unstated: `removed: 0`, file **present**, `gc_skipped reason=relocated_data_dir`. Stated: `removed: 1`, file **DELETED**. The guard is therefore provably what spared the directory, and the sweep is provably still armed rather than quietly neutered. Four cases added to `tests/unit/workspace-gc-guard.test.ts` (10 → 14).
- **Not changed, deliberately:** the empty-database guard stays as an independent second line — the two failures are different and neither subsumes the other. The reverse hazard (real database, relocated workspace) is out of scope: it can only damage the scratch workspace the operator themselves pointed at, never the live one.
- **Operational rule this encodes:** any isolated run, test, or verification harness must set `DATA_DIR` **and** `WORKSPACE_DIR` together. `tests/setup.ts` (bunfig preload) already does; a hand-rolled harness that sets only `DATA_DIR` is what caused both incidents.

## ADR: Provider-response conformance is its own category, recognised by SDK error name (2026-09-26)

- **Status:** implemented and unit-tested (16 cases, `tests/unit/error-provider-response.test.ts`). Closes the last open item from the Direct Chat plan.
- **The gap:** a provider answering 200 with a body the SDK cannot read — unparseable JSON, a payload failing schema validation, a stream part of an unknown shape — had no category. It fell into `network`, `transport`, `validation` or `tool` depending on incidental wording, and the user was shown the generic *"Generation failed. Retry or pick another provider/model."* That copy invites a retry which re-sends a request that produced garbage. This is the defect class behind the Agnes gateway, which emits no terminal `finish_reason` and therefore settles `failed` with no way to tell "provider misbehaved" from "network flaked".
- **Recognised by the AI SDK's error NAME**, never by matching prose. `normalizeError` already surfaces `errorType` (`logger.ts:359`), and the names are authoritative: `AI_InvalidStreamPartError`, `AI_StreamProviderError`, `AI_InvalidResponseDataError`, `AI_TypeValidationError`, `AI_JSONParseError`, `AI_EmptyResponseBodyError`. `AI_APICallError` is excluded because it carries every 401/429/5xx; it qualifies only on a 2xx with an unusable body, which is defence rather than a hot path.
- **It is a COARSE base, not a `refineCategory` refinement — and that is the load-bearing decision.** The first draft of the plan put it in `refineCategory`, on the theory that a refinement cannot change retry behaviour and therefore cannot misfire. An independent review executed `classifyError` against the real module and proved the placement **never fires**: `VALIDATION_RE`'s first alternative is `/\bvalidation\b/`, so `AI_TypeValidationError` ("Type validation failed…") was claimed as `validation`; and `TOOL_SUBJECT_RE` × `TOOL_OUTCOME_RE` claimed `AI_InvalidStreamPartError` on a tool-call delta as `tool` — the single most common malformed stream part. A refinement is unreachable once a prose heuristic owns the bucket, and owning that bucket ahead of the prose is the entire point. Precedence is now: `cancelled` → status-derived (`auth`/`rate_limit`/`config`/`provider`) → **SDK name** → prose heuristics.
- **One intentional retry-policy change, declared rather than assumed.** Because `invalid_stream` is a coarse base it does reach the `retryable` computation, and it is deliberately **not** retryable — the same reasoning as `DIRECT_MAX_RETRIES = 0`. The observable change: a malformed stream part whose text mentions a fetch failure was `network`/`retryable: true` and is now `invalid_stream`/`retryable: false`. The draft's claim that this was "already non-retryable" was false and is withdrawn. Every other category's retryability is untouched, which is what the `refineCategory` discipline still guarantees.
- **Billing stays a FLAG, and that is unchanged.** Reading it in `sanitizeStreamError` requires hoisting the whole `ClassifiedError` (the function previously switched on `.category` and discarded the rest, making `billing` unreachable). The flag outranks `rate_limit` in copy only, because "wait briefly and retry" is the wrong advice for an exhausted balance. `BILLING_RE`'s bare `402` gained a word boundary in the same change: once the flag outranked `rate_limit`, an unanchored `402` would have turned any rate-limit message containing a request id or byte count into "check your billing". Pinned with a negative test.
- **`transport` gained copy; `validation`/`database`/`lifecycle`/`runtime` deliberately did not.** Those four are faults in this application, not provider conditions, so there is no provider-side action to suggest and the generic copy is the honest one.
- **No provider is special-cased.** Agnes is the occasion, not the subject: the category is derived from SDK error names that every provider path produces.

## ADR: The display layer states no durable verdict (2026-09-26)

- **Status:** implemented. `web/src/lib/transport-errors.ts`, one exported constant.
- **The defect:** the client transport classifier matched raw browser/proxy signatures with a regex and then returned *"Connection interrupted. The AI run could not be resumed."* — a claim about **what became of the run**, derived from evidence that cannot support it. The recovery strip's own configuration comment states the rule this broke: the durable reason is chosen *"never by matching an error string"*, because the client cannot see why. A regex cannot distinguish a run that finished, one that was never resumable, and one that is resuming at that instant.
- **Live symptom:** after a crash the user saw two notices for one event, the message-level copy and the strip's *"The app restarted while this reply was streaming. Nothing was sent — retry?"*, restating the same fact twice.
- **Fix:** the copy is now the exported `TRANSPORT_ERROR_COPY` = `"Connection lost."` — only what this layer observes — and the strip keeps the verdict, because it is driven by the server's durable terminal kind. The two notices now carry **disjoint** facts instead of overlapping ones. A test asserts the copy contains no outcome claim (`resume`/`interrupted`/`restart`).
- **Ownership corrected against a wrong first draft.** The draft proposed moving the string into `web/src/config/composer.ts` to create "one owner". A grep showed the literal already had exactly **one** code owner (this file) — the only other occurrences were a test, two docs, and the draft. `composer.ts` also scopes itself to *composer menu copy*, so parking a chat-transport error notice there would have introduced the ownership smell it claimed to remove. The owner did not move; the claim did.
- **One notice versus two is still a product decision, not taken here.** Collapsing to a single notice means suppressing assistant-ui's message-level error, i.e. custom message-error rendering inside a frozen dependency, for a pure preference. Left to the maintainer.it would duplicate the store); storing the stream in a second database; replaying partial bytes of a dead run as if they were the answer; auto-retrying an interrupted run; and encrypting chunks while message content stays plaintext.


## ADR: Sidebar sections are scoped server-side, keyed on workspace_mode (2026-09-26)

- **Status:** implemented. `conversationsListQuerySchema` (`src/lib/validation.ts`), `conversationService.list` scope clauses (`src/services/storage/index.ts`), Zod-validated `GET /api/conversations`, `SearchResults.tsx`, store-level search debounce.
- **The defect:** the sidebar's three sections were not sections at all. `ChatsItems` and every `FolderConversationRow` called `useConversationsList({ status: "regular" })` with no scope, so **every** conversation appeared in Chats **and** was duplicated under **every** registered folder. `FolderConversationRow` received `folderId` and discarded it as `folderId: _folderId` - the underscore kept the unused-destructure lint quiet and hid the defect from review.
- **Why the scope is a SERVER clause, not a client filter.** The list hook derives paging from the row count (`hasMore = rawThreads.length >= queryLimit`, `offset` fixed at 0). Filtering client-side would leave the count describing rows that were never shown, so "Load more" and the totals stay wrong permanently. Scope therefore rides to SQLite and is AND-ed with `status` and `search`, leaving `total`/`nextCursor` describing exactly the rows rendered.
- **Why `workspace_mode` and NOT `workspace_folder_id IS NULL`.** The original plan assumed NULL marks a non-folder chat. It does not: `conversationService.create` assigns a folder id on **every** row - the registered folder for a project chat, and an auto-created hidden `kind='chat'` folder for a simple one (`storage/index.ts`). `workspace.ts` states it outright: *"Every conversation has a `workspace_folder_id`."* A NULL test would have returned an **empty** Chats section. `workspace_mode` is the only correct discriminator, and `folders.ts` already used it that way in reverse for folder membership (`workspace_folder_id = folders.id AND workspace_mode = 'project'`); the new `folderId` clause copies that predicate verbatim so a hidden chat folder can never be addressed as a project folder.
- **Scope and search are orthogonal params, which is what makes global search free.** Absent scope = every conversation. So Recent and the archived page are unchanged, and the search list gets folder chats, non-folder chats, and both engines (Direct + OpenCode) from one unscoped query - no special-case branch on "is searching" in the storage layer, and the sections keep their contract (a project chat never shows in Chats outside an active search).
- **Search UX: one global list replaces the three sections.** The alternative - letting each section search everything - would show the same conversation simultaneously in Chats, in its folder, and in Recent, breaking the very contract this change establishes.
- **`status=all` is a declared sentinel, not an accident.** The route previously coerced an unrecognised `status` to "no filter", and the live assistant-ui adapter (`remoteThreadListAdapter.tsx`) depends on that: it requests `status=all` and splits regular from archived itself. Naive Zod-validating the query would have 400'd the runtime's thread list. `all` is now in the enum and mapped to "no clause" in the route, keeping `ConversationStatus` (the row vocabulary) free of a value SQLite never holds.
- **Intentional behaviour change to flag:** an unrecognised `status` (e.g. `?status=completed`) now returns **400** instead of being silently ignored, per the "validate all API input with Zod" rule. `tests/integration/conversation-config.test.ts` asserts the old 200 and must be updated.
- **Fixed in passing, both found while scoping this change.** (1) The sort menu was inert: the hook sent `order=newest|oldest|title` while the server only understood `created`, so every value collapsed to `updated` and "Newest first" did nothing; the hook's `order` type is now `"updated" | "created"`, matching `SidebarSortMode` and the server one-for-one with no translation table. (2) Search was debounced nowhere, so each keystroke fired one request per section - and one per registered folder. The debounce now lives once at the input boundary in the store (`searchInput` -> `searchQuery` after `searchDebounceMs`).
- **Dead code removed rather than preserved:** `dateGrouping` was already `false`, so its whole rendering branch was unreachable - removed with `dateGroupLabel` and the unused `sortThreads`/`filterThreads`/`SidebarThread`; `chatsPageSize` was never read; and `moveSectionInOrder` was dead because the store reimplemented it inline (the store now calls the shared helper, preserving its same-reference no-op contract so zustand still skips notification).

## ADR: The desktop sidecar IS the backend (supersedes the bundled-Bun-sidecar entry) (2026-09-26)

- **Status:** implemented and verified on the compiled artifact. Supersedes the "Bundled Bun sidecar" bullet above; that entry is left as written history.
- **What changed.** The portable build shipped four things: `TBAi.exe`, a downloaded `bun.exe` (82.1 MB), `backend/index.js` (2.9 MB) from `bun build src/index.ts --target bun`, and `web/` (12.0 MB). It now ships three: `TBAi.exe`, `tbai-server.exe`, and `web/`. The backend is built with `bun build src/index.ts --compile`, which embeds the Bun runtime, so the sidecar is no longer *a runtime that runs a script* — it is the server. `main.rs` drops `resolve_resource("backend/index.js")` from `StartupConfig` and spawns it with `.args([])` instead of `.args(["run", path])`.
- **It is NOT a size optimisation, and the numbers say so.** Measured: `bun.exe` 82.1 MB + `dist/index.js` 2.9 MB = **85.0 MB**, versus an 85.0 MB compiled binary. The runtime is embedded either way, so the payload is unchanged. The actual gains are that there is one artifact instead of two, and that no `bun.exe` can be shipped that does not match the bundle.
- **Why the runtime download was the real hazard.** The workflow pulled `bun-windows-x64.zip` from `releases/latest` on every build while also setting `bun-version: latest`. That made two builds of the same commit able to differ, and it is why the runtime/app mismatch was possible at all. Both are now pinned (Bun `1.4.2`, the version verified locally) and the download step is gone.
- **The frontend was being shipped twice, and one copy was dead.** `build.frontendDist: "../web/dist"` embedded all 323 files / 12.0 MB into the executable, but the window is `visible: false` and both terminal paths in `main.rs` (`navigate_verified`, `render_error`) navigate or `eval` to `http://localhost:{port}` — where Bun serves the SPA from `WEB_DIST_DIR`. The embedded assets were never fetched. `frontendDist` is required by Tauri, so it now points at a ~1 KB `src-tauri/frontend-placeholder` stub, and the loose `web/` folder (the copy that is actually served) is retained.
- **A failed "prune the 12 MB" idea, recorded so it is not retried.** `web/dist` is 11.64 MB of JS across 313 files, and it is tempting to read that as waste. It is not: those are assistant-ui's **lazily loaded** shiki grammar chunks, fetched on demand when a code block in that language renders. They are needed, and they live inside the vendored `markdown-text` element of a frozen dependency — pruning them would mean patching `@assistant-ui/*`, which AGENTS.md forbids. There is no win here.
- **`--sourcemap=external` was also tried and reverted.** Measured at +2.1 MB in the binary, and the 6.5 MB `.map` would have to ship alongside for it to be worth anything — 8.6 MB for a diagnostic aid on an app that already captures sidecar stderr into a startup error page. Not worth it; dropped rather than left as dead weight.
- **The failure mode this introduces is RUNTIME, not build time.** A mismatch between `externalBin: ["binaries/tbai-server"]`, the `sidecar("tbai-server")` lookup in `main.rs`, and the triple-suffixed filename the workflow stages will compile cleanly and then fail to spawn. That is precisely why the workflow now runs the compiled binary and polls `/api/server/instance` for a real instance id before assembling the artifact. Readiness is an exact id match, never "a port is listening" — the same invariant `main.rs` already enforced.
- **The release pipeline had no gate at all.** It went checkout -> build -> ship, never running typecheck, lint, or tests, which is how two known-failing tests reached a tagged build. The workflow now runs `bun run typecheck && bun run lint && bun test` before compiling. Deliberately not `bun run verify`, which ends in `bun run build` and would build twice alongside `beforeBuildCommand`.
- **Rust was floating too.** `dtolnay/rust-toolchain@stable` is now pinned to `1.98.1` via a `toolchain` input. Note `Cargo.toml`'s `rust-version = "1.77.2"` is an MSRV floor, not a pin — an easy thing to mistake for one.
- **Not done, deliberately:** code signing (unsigned means a SmartScreen prompt on every launch for every user — the largest remaining distribution problem), `tauri-plugin-updater`, `bundle.active: true`, and `csp: null`. `bundle.active: false` is why the workflow still hand-assembles the folder; turning the bundler on would make `resources`/`externalBin` authoritative and is the prerequisite for signing and the updater.
- **Verification performed:** `bun run typecheck` exit 0; `bun run build` exit 0; the compiled `dist/tbai-server.exe` was run against an isolated `DATA_DIR`/`WORKSPACE_DIR`, answered `/api/server/instance` with its minted id, and created `chat.db` with a populated WAL — proving both that `--compile` boots and that `bun:sqlite` initialises inside it. The workflow's smoke-test block was executed verbatim locally against that binary before being committed. The Rust and Tauri halves could not be compiled locally (no Rust toolchain on the maintainer's machine), so they are verified on the first CI run.

## ADR: The window is revealed on page load, not at navigation time (2026-09-27)

- **Status:** implemented. `on_page_load` on the app builder, `show_on_load: AtomicBool` in `StartupOwned`, `SHOW_FALLBACK`, and no `url` on `app.windows[0]`. Rust is unverified locally (no toolchain on the maintainer's machine); CI's new `cargo check` step is the gate.
- **The symptom.** Left-clicking the app to open it showed a frame for a few milliseconds that could be neither seen properly nor clicked, then the real UI. Pre-existing, not a regression from the packaging work: `app.windows[].url`, `visible: false`, and `navigate_verified` were all untouched by it.
- **Two causes, not one.** (1) `app.windows[0]` carried `"url": "http://localhost:3000"`, a hardcoded port that is almost never the real one — the backend self-heals to a free port and mirrors it — so the window was aimed at an origin that usually had nothing listening. (2) `navigate_verified` called `win.show()` immediately after firing `location.href`, so the window was made visible while the webview was still mid-navigation. Together they painted an intermediate frame that is blank, unpaintable, and unclickable.
- **The fix follows Tauri's own documented pattern** for a `visible: false` main window: reveal on `PageLoadEvent::Finished`, not at navigation time. `on_page_load` goes on the **app builder** (not inside `setup`, and not `WebviewWindowBuilder::on_page_load`), because the window is created from `tauri.conf.json` and the per-window builder is not in play; the callback receives a `WebviewWindow`, so the reveal is `webview.window().show()`.
- **Dropping the hardcoded `url` gives the placeholder a real job.** With no `url`, the window opens on the embedded `frontendDist` — the ~1 KB stub added to stop shipping 12 MB of never-fetched frontend — which reads *"Starting the local server…"*. The frame that used to be a refused connection is now an honest loading state, so the size fix and the flash fix reinforce each other.
- **`AtomicBool`, not `Mutex<bool>`, and that is the load-bearing detail.** The flag is set once and consumed once, so `swap(false)` **is** the atomic take. It also keeps a lock — and its poisoning, plus a panic path — out of a UI-thread callback. A `Mutex<bool>` here would have been the wrong primitive twice over.
- **Exactly one of the two paths shows the window.** `on_page_load` (Finished) and the `SHOW_FALLBACK` (3 s) thread both `swap(false)`; whichever runs first gets `true` and shows. There is no double-show and no race, and a load event that never fires degrades to a slightly-late window rather than an app that never appears. Taking *both* signals is what Tauri documents as acceptable; taking only the event would risk a permanently invisible app.
- **Deliberately not gated:** `render_error` and both tray-open paths. The error page is written with `document.write` and has no assets to await, and a tray click is an explicit user request. Only the verified-success path has a pending navigation, so only it is gated.
- **Boot-to-tray is untouched.** `navigate_verified` returns *before* arming when `minimized` is set, so neither the page-load handler nor the fallback can reveal a window the user asked to keep hidden.
- **The initial placeholder load is a no-op here.** `on_page_load` fires for it too, but nothing has armed the flag at that point, so the `swap` returns false. That is why the handler needs no "am I the verified navigation?" test of its own.
- **Known platform context, not our bug:** WebView2 has a documented initial-load white-flash ([tauri#5170]). Tauri also exposes a Windows-only `noRedirectionBitmap` for exactly this, but it applies to **transparent** windows and ours is `transparent: false`, so it was not used.
- **Verification added, because Rust is not covered by `bun run typecheck`.** The workflow now runs `cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc` before the full build: no codegen, so a one-line type error surfaces in about a minute instead of after a ~10-minute `tauri build`. It is safe to run before any build because `tauri-build` validates `build.frontendDist`, which now points at the committed `src-tauri/frontend-placeholder/`.

## ADR: assistant-ui elements are installed from the official registry, not reimplemented (2026-09-27)

- **Status:** implemented. Supersedes the earlier entry in this file that described these two elements as hand-written.
- **What happened, stated plainly.** The first attempt hand-wrote `mermaid-diagram.aui.tsx` and `tool-timeline.aui.tsx` from the documentation, and named them `.aui.tsx` — the filename this repo already uses for genuine vendored upstream code. That was wrong twice over: the project rule is "prefer the library, do not recreate", there was no capability gap to justify a reimplementation, and the naming actively disguised hand-written code as vendored code. Both hand-written elements are now deleted and replaced by the registry's own source.
- **The mechanism is the documented one.** `npx assistant-ui@latest add mermaid-diagram elements-tool-timeline`, which fetches full TypeScript source from `r.assistant-ui.com` into the repo. This required adding `web/components.json`, which the project did not have; it is configured for the Radix flavour (`radix-ui` 1.6.7 is the installed primitive package, so a `base-` style would have fetched mismatched components) and for this repo's real paths (`@/components`, `@/lib/utils`, `src/styles/globals.css`).
- **Registry item names are not the obvious ones.** `tool-timeline` does not exist; the item is `elements-tool-timeline` (`elements-timeline` is an unrelated generic component). The docs' component names are not the registry's. Read the registry index before assuming.
- **The version freeze held, and it was checked rather than assumed.** No `@assistant-ui/*` package was added, moved or removed: `@assistant-ui/react` is still `^0.15.20` and `@assistant-ui/react-markdown` still `0.14.15`. The lockfile hash was captured before the install and re-checked after. The CLI does install dependencies as a side effect, so this was verified, not inferred.
- **The one new dependency is `beautiful-mermaid`, not `mermaid`.** The element renders through `beautiful-mermaid`, a small synchronous SVG renderer. The heavyweight `mermaid` package added by the discarded attempt was removed. This also settles a question the earlier entry got wrong: there is no `securityLevel` knob here, because `beautiful-mermaid` is not `mermaid`. The SVG is injected with `dangerouslySetInnerHTML` and its escaping is the renderer's responsibility, so the source is still treated as untrusted model output.
- **`beautiful-mermaid` supports a SUBSET of mermaid, and this is user-visible.** Measured against the installed package: `flowchart TD` renders, while `graph TD;` fails with "Invalid mermaid header" and the user sees the fallback panel. A trailing semicolon on the header is common model output, so this will be seen in practice. Pinned as a characterisation test (`web/e2e/mermaid-diagram.spec.ts`) rather than left unknown. NOT worked around: normalising the header would mean editing vendored upstream code and silently forking it, which is a decision for the maintainer, not a local patch.
- **Files were placed back into the repo's existing layout.** The CLI wrote to `src/components/` because registry paths are flattened by default; they were moved to `assistant-ui/elements/` and `assistant-ui/utils/range.ts`, which is where upstream's own relative imports (`./surfaces`, `../utils/range`) resolve. The CLI also created a duplicate `surfaces.tsx` and rewrote two files it was not asked to touch — `ui/collapsible.tsx` (it stripped `"use client"`) and `styles/globals.css`; both were reverted. The repo's `surfaces.tsx` differs from upstream by one Tailwind easing value, and the repo's copy was kept.
- **Two exports share the name `MermaidDiagram`, and the obvious import is the wrong one.** `mermaid-diagram.tsx` is the base (props `code` / `streaming`); `mermaid-diagram.aui.tsx` is the `SyntaxHighlighter` wrapper that `componentsByLanguage` requires. Importing the base type-checks and silently receives the wrong props at runtime. The wiring imports the `.aui` module, and the reason is commented at the import site.
- **The step mapping stays app-owned, and this one is genuinely upstream's design.** The element is presentation only; its docs state there is no runtime primitive for the step list, so the app supplies it. `session-timeline.tsx` maps TBAi's tool names (registered in `src/tools/index.ts` and `web/src/tools/toolkit.ts`) to verb, chip, icon and file-change stats, with 13 unit tests. An unrecognised tool still renders a truthful row using its raw name. One API correction during the swap: upstream's `TimelineStep.icon` is a `LucideIcon` COMPONENT, not a rendered node.
- **The per-part tool renderers are NOT silenced.** Upstream advises silencing them so steps are not shown twice. This app has real per-tool UIs (`part.toolUI`, `AutoOpenToolGroup`, a terminal block for shell calls) that carry output a verb/chip row cannot, so removing them would delete working capability to avoid a cosmetic overlap. The timeline is a COLLAPSED SUMMARY above the parts, and renders nothing at all for a message with no tool calls.
- **The load-bearing rendering rule.** `useAuiState` compares its selector result BY REFERENCE. An allocating selector — `s.message.parts.filter(...)` — returns a fresh array every call, so the reference always differs and the component re-renders until React aborts with "Maximum update depth exceeded" (error #185). This was hit for real during this work. The parts array is selected whole and filtered in `useMemo`, which is assistant-ui's documented rule ("return one primitive per call, or select an array whole").
- **Coverage, and its one honest gap.** `web/e2e/mermaid-diagram.spec.ts` seeds a completed assistant turn through the conversations API and asserts, in a real browser, that a valid fence mounts a real SVG, that the fence is NOT also left as a code block, that the zoom affordance is present, and that both invalid forms degrade to the fallback. It runs in both browser projects (15/15 spec files green in each). The Code surface renders the identical `MarkdownText`, so it is covered structurally and by this test — but it has NO Code-specific diagram test, because the harness has no way to seed an OpenCode assistant turn deterministically (its existing spec cannot even guarantee a real reply). Closing that gap is a test-agent task, not something to fake.

## ADR: Context menus deviate from shadcn's ContextMenuShortcut, on purpose (2026-09-29)

- **Status:** implemented. `web/src/components/ui/context-menu.tsx` (the shortcut span), both menu components, and a guard in `web/tests/context-menu-copy.test.ts`.
- **The deviation, stated up front.** `ContextMenuShortcut` in this repo is NOT byte-identical to the shadcn registry's `context-menu.json`. It adds `aria-hidden="true"`. Items that carry a shortcut additionally pass `textValue`, and — only where the key is genuinely bound — `aria-keyshortcuts` on the item itself. Re-syncing the file from the registry will undo all three; the comment above the component says so.
- **Why the bare span was a real bug, not a style preference.** The shortcut is a visual affordance at the trailing edge of a row. Left readable, it joins the item's accessible name: "Cut Ctrl+X". That is wrong for a screen reader, and it also breaks every `exact: true` name lookup in the committed e2e spec — `web/e2e/context-menu-spellcheck.spec.ts:191`, `:201` and `:209` look up "Copy", "New Chat", "Toggle Sidebar" and "Open Settings", all of which are shortcut-bearing items. Playwright's default `name` matching is a case-insensitive substring, which is why the NON-exact lookups at `:54`/`:55`/`:157` kept passing and made the breakage look intermittent; `exact: true` compares the whole string and is where it surfaced.
- **Why `aria-hidden` alone is not enough, and `textValue` is required.** Radix builds its typeahead index from the item's own `textContent` (`@radix-ui/react-menu`, `MenuContentImpl`), which ignores ARIA entirely. So the shortcut stays in the search key even when hidden from assistive tech, and typing "b" would match "Paste as plain text Ctrl+V". `textValue` on the item is what pins typeahead to the label. This is the documented Radix mechanism, not a workaround.
- **The truthfulness rule for `aria-keyshortcuts`.** MDN documents the attribute for shortcuts *an author has implemented*. That makes it falsifiable, and the audit found three hints that were pure fiction: `ChromeShortcuts.tsx` binds exactly `Ctrl/Cmd+T`, `+W`, `+Tab` and `+1..9`, so the page menu's "Ctrl+B" (toggle sidebar), "Ctrl+Shift+S" (status bar) and "Ctrl+," (settings) advertise keys nothing responds to. Those three therefore carry the visible label and NO `aria-keyshortcuts`; only the two real ones (New Chat, and the browser-native Ctrl+C on the captured selection) declare it. A visible label advertising a shortcut that does nothing is recorded in `web/src/config/sidebar.ts` as needing a maintainer decision — bind the key or drop the label. The composer edits do declare theirs, because the textarea natively performs exactly what each item does.
- **Deliberately not done.** The whole `context-menu.tsx` was NOT re-vendored from the registry: unrelated restyling in that same file would have been clobbered, for a three-attribute change. No jsdom or happy-dom was added (`web/src/testing/source-scope.ts:11` records them as excluded). No a11y-linter dependency.
- **The deviation is now enforced, not just documented.** The fast guard fails if `aria-hidden` is dropped from the span, if ANY `ContextMenuItem` in either menu loses its `textValue`, or if the number of `aria-keyshortcuts` claims drifts away from the two that are real.

## ADR: The composer menu replaces the OS spelling menu, and the dictionary is fetched on right-click only (2026-09-29)

- **Status:** implemented. `web/src/lib/spellcheck.ts`, the composer's `resolveSpellingOffer`, and the lazy-load guard in `web/tests/context-menu-copy.test.ts`.
- **We render our own spelling suggestions because a web app cannot ask for the native ones.** There is no web API to open the OS spelling menu. `window.spellcheck` is unrelated — it controls whether the browser spellchecks editable content at all — and is not a request for suggestions. Firefox additionally shows its native spelling menu on Shift+right-click WITHOUT dispatching a `contextmenu` event, so that path cannot even be intercepted; it is a documented platform difference, left alone rather than fought.
- **The dictionary is ~540 KB of text and it is fetched exactly once, from a right-click.** Measured in the build output: a dedicated `en_US-*.js` chunk at 551.80 kB (197.91 kB gzip), which is the boundary working — the dictionary is a separate lazily-imported chunk, not part of the main bundle. It is loaded only after a right-click lands on a word that first passes the cheap `couldBeMisspelling` shape check, so right-clicking `TypeScript`, `utf8` or a two-letter token never pays for it.
- **A prewarm bought nothing, which is why it was removed rather than kept.** typo-js v1.3.2 memoises both `check` and `suggest` on `this.memoized[word]`, so a warm dictionary makes no lookup faster — it only makes the same lookup happen earlier and unconditionally. An `onFocus`/`onMouseEnter` prewarm therefore paid 540 KB on first hover and returned nothing for it. Reintroducing one is now a test failure: the guard counts call sites (one), and rejects any `onFocus`/`onMouseEnter`/`onPointerEnter`/`onMouseOver` binding on the trigger.
- **A missing dictionary degrades the menu, it does not break right-click.** typo-js `suggest()` throws a **raw string**, `"Dictionary not loaded."` (`typo.js:629-631`), not an `Error` — so a `catch` that assumes `error.message` reads `undefined`. The composer's async path awaits `ensureSpellchecker()` inside a try/catch, logs `spellcheck_load_failed`, and returns "no suggestions".
- **The guard tier was itself defective, and that was the real finding.** A regression shipped with the fast suite red for the wrong reason: the one failing test asserted `constBody(composer, "resolveSpellingOffer")` and went red because the function was RENAMED — a rename that changed no behaviour — while the structural regression in the same diff, the spelling header demoted from a `menuitem` to a bare `<div>`, left every test green. Two rules came out of it and now shape the whole file: do not pin a function name (the caret assertions follow the call from the `onContextMenu` attribute one hop, and assert the open-time callback does NOT read the selection), and pin the element rather than a string (`toContain("SpellCheck")` passes against a bare `div`; the guard now requires `<ContextMenuItem disabled`, plus no raw `<div>` anywhere in either top-level menu).
- **Verified by mutation, not by assertion that the tests pass.** Each regression was reintroduced on purpose and the guard observed going red: the bare-`<div>` header, the raw-element rule, and the focus/hover prewarm all failed. Then the helper was renamed and the suite stayed green — the exact scenario that made the old guard cry wolf.
- **Known gap, stated rather than hidden.** The Quick Messages submenu's empty state is still a centred placeholder `<div>`, which is the same ARIA class of problem. It is pre-existing, and converting it to a disabled item would restyle it, so the "no raw element" guard is scoped to the two TOP-LEVEL menus and says so in a comment instead of quietly excluding it.
- **Verification:** `bun run typecheck` exit 0; `bun run lint` exit 0; `bun test ./web/src ./web/tests` 1193 pass / 0 fail; `bun run build` exit 0. `web/tests/context-menu-copy.test.ts` alone: 32 tests, 32 pass, 0 fail, 78 `expect()` calls (from 26 tests / 25 pass / 1 fail / 47 expects). Behaviour in a real browser remains owned by `web/e2e/context-menu-spellcheck.spec.ts`, which is not part of `bun run verify`.

## ADR: Tray window reveal + persistent window state (2026-09-29)

- **Status:** implemented. Rust compiles in CI only (no local toolchain); the workflow's `cargo check` step now uses `--all-targets` so the new unit tests are compile-verified too.
- **The tray bug, root-caused.** The click handler matched `TrayIconEvent::Click { .. }` with no `button`/`button_state` pattern, so **every** click — including the right-click that opens the OS context menu — ran `show()` + `set_focus()`. That is the whole defect cluster: the menu flickered (the window stole focus from the menu), the menu dismissed itself when the window was already visible, and "Open TBAi" appeared to do nothing (the window was already focused, so `set_focus` was a no-op and the menu vanished). The fix is a pure predicate, `is_tray_left_click_up(&TrayIconEvent) -> bool`, matching `button: MouseButton::Left, button_state: MouseButtonState::Up` exactly (CodeG parity, verified verbatim against `D:\Temp\codeg\src-tauri\src\commands\windows.rs:2460-2469`). Right-click stays OS-owned: the menu shows, the window never moves. `.show_menu_on_left_click(false)` stops the OS from also popping the menu on left-click (tauri#11413).
- **One reveal helper for every path.** `show_main_window(&AppHandle)` does `unminimize()` → `show()` → `set_focus()`. `set_focus` alone is not enough — tao skips it while the window is hidden or minimized — and the ❌ close button hides the window to the tray, so every reveal path (startup page-load, `SHOW_FALLBACK`, render-error, tray menu "Open", tray left-click) funnels through the same sequence. The gated startup reveal is unchanged: `visible: false` + `PageLoadEvent::Finished`/fallback still owns first show; the helper only replaces the scattered `show()`+`set_focus()` pairs.
- **Window state via the official plugin, not a hand-rolled file.** `tauri-plugin-window-state` (v2, `Builder::new().with_state_flags(...).with_filename("window.json")`) persists position, size, and maximized. `StateFlags` is explicit `SIZE | POSITION | MAXIMIZED` — **VISIBLE is excluded** because the plugin's `restore_state` calls `show()`+`set_focus()` on window-ready when VISIBLE is set, which would break the gated reveal; **DECORATIONS is excluded** because TBAi is undecorated by design (a stale saved `true` would re-add the native title bar); FULLSCREEN is unused. Off-screen recovery is the plugin's documented behaviour: a saved position is restored only if the rect intersects an available monitor, otherwise the OS places the window — it does not clamp coordinates.
- **Portability preserved.** The plugin stores/loads via `app.path().app_config_dir()`. TBAi is portable (`<exe>/data`), so `tauri.conf.json` gains `app.appDirectoriesOverride: { "config": "./data" }` — the `Directories` form, camelCase keys, relative paths resolving against the exe dir on desktop (verified in tauri's `resolve_override_path`). Only the `config` directory is overridden; `data`/SQLite/port/start-minimized semantics are untouched. CodeG is NOT portable (`app_data_dir()`); this override is what lets the plugin coexist with TBAi's portable contract.
- **MSRV floor raised to `1.90`.** Both `tauri = "2"` (floating to 2.12.0) and `tauri-plugin-window-state = "2"` (2.5.0) declare `rust_version: "1.90"`; the old `1.77.2` floor was already stale. CI pins 1.98.1, which satisfies it. No `Cargo.lock` (repo intentionally untracked).
- **`@tauri-apps/cli` had to be raised to `^2.12.0`, and the first CI run of this change failed on it.** The CLI validates `tauri.conf.json` against the JSON schema bundled in its own npm package, which is a version line **independent** of the `tauri` crate that `tauri-build` parses the same file with. `bun.lock` had the CLI pinned at 2.11.4 (stale, since `^2.0.0` and `--frozen-lockfile` never re-resolve it) while `tauri = "2"` floated to 2.12.0. The build died on schema errors before compiling a single line: `build`: `'windows' was unexpected`, `app`: `'appDirectoriesOverride' was unexpected`. `appDirectoriesOverride` is a 2.12.0 key and cannot be avoided — it is what keeps the plugin's state file inside TBAi's portable `<exe>/data` contract. **`build.windows.staticVCRuntime` was the same break and was pre-existing**: it landed in `6298f7d` (2026-09-27, already on `origin/main`) and had never been through a successful CI run, because the workflow only fires on `workflow_dispatch` and `v*` tags. Diagnosis was confirmed by validating the file against both shipped schemas: 2 errors against 2.11.4, **0 errors against 2.12.0**. The floor is declared as `^2.12.0` rather than left at `^2.0.0` so a future install cannot silently resolve back to a CLI that cannot read the committed config. Not pinned exactly, because `tauri = "2"` floats too and an exact pin would rot into the same class of failure. A comment at the `Build Tauri` step records the coupling.
- **Verification:** `bun run typecheck` / `bun run lint` / `bun test` / `bun run build` run as regression (frontend only — `src-tauri/` is outside `bun run verify`). Rust compile + the four `is_tray_left_click_up` unit tests are verified by the GitHub workflow (`cargo check --all-targets` + `tauri build`). Manual click-tests remain: right-click hidden/visible, left-click reveal, "Open TBAi", resize/move/quit→restore, and `window.json` appearing under `<exe>/data`.

## ADR: The OpenCode Configuration page edits the file OpenCode actually reads (2026-09-29)

- **Status:** implemented. `src/services/opencode/configDocument.ts`, the two routes in `src/routes/opencode.ts`, `web/src/features/opencode/openCodeConfig.ts` + `OpenCodeConfigPage.tsx`, `web/src/config/opencodeConfig.ts`, nav entry `/opencode-config`.

- **The configuration source was DISCOVERED, and the obvious answer was wrong.** TBAi spawns `opencode serve` with `cwd = data/opencode-home` (`serverManager.ts:271`), which makes `data/opencode-home/opencode.json` look authoritative. It is not. Asked directly (`GET /api/config` on the running managed server, 2.0.15/2.0.16), the server reports four sources in precedence order:

  | # | Path | Carries |
  |---|---|---|
  | 1 | `D:\IT\Coding\OpenCode\.config\opencode\opencode.json` | **permissions**, shell, providers |
  | 2 | `D:\IT\Coding\OpenCode\.config\opencode` (directory) | � |
  | 3 | `D:\IT\Coding\OpenChamber\.chamber-data\opencode.managed.json` | plugins |
  | 4 | `D:\Temp\ai-chat-app\data\opencode-home\opencode.json` | model, small_model |

  The path is XDG-resolved on the host (`XDG_CONFIG_HOME` / `OPENCODE_CONFIG_DIR` are set in this environment), so it is not computable from the repo. The module therefore **asks the server** rather than walking the filesystem; a path-shaped rule would have picked #4, which parses fine and is not the permission source. Selection is by CONTENT (first document carrying a `permissions` array), never by filename or directory, and the page lists all four so the difference is visible rather than asserted.

- **Preservation is structural, not a promise.** The write route accepts one `(action, resource, effect)` triple � never a document. The backend re-reads the file, edits exactly one array entry, and rebuilds the text. There is no payload in which an unrelated rule, a rule's position, an unknown future field, or the four `deny` rules protecting `config/RULES.md` / `config/opencode.json` / the plugin directory could be lost. A test asserts the four protected denies survive a real round trip against a copy of the user's actual file, credentials included, and the live e2e asserts the same against the real one. A page-wide "apply my edited copy of the whole ruleset" was explicitly rejected: it would require shipping a ruleset TBAi authored, which is the shadow-policy failure this feature exists to prevent.

- **Refusals are real, and one of them was a bug found live.** A malformed document, a non-array `permissions`, and an empty candidate all produce NO write and a 422. The first implementation reported a broken global config as `editable: true` with 0 rules: a config the server cannot parse is **dropped from its own listing**, so selection fell through to the OpenChamber managed file and the page offered to edit a document that is not the policy, while the file actually breaking OpenCode went unmentioned. The `directory` entry is the only place the real path is knowable, so the global config is now re-read directly and reported as the malformed target. Two regression tests cover it. This is the concrete argument for reading the real file rather than trusting a listing: the listing is lossy exactly when it matters most.

- **JSONC is reported read-only, deliberately.** OpenCode accepts `opencode.jsonc`; `JSON.parse` does not. Editing such a file with a JSON serializer would delete the user's comments on the first save, so it is surfaced as malformed rather than silently rewritten.

- **CodeG's model was read, not copied.** `D:\Temp\codeg\src\lib\opencode-permissions.ts` models the **v1** `permission` object form (`{"bash": "ask"}`, `findLast` over a flattened key list) and `opencode-behavior.ts` models `autoupdate` / `snapshot` / `compaction.tail_turns`. The installed V2 schema uses a `permissions` ARRAY of `{action, resource, effect}` and different behaviour keys, so copying either file would have produced a page that renders nothing and writes config the `$schema` rejects. The transferable parts are structural: read ? parse ? targeted change ? preserve unrelated content ? safe write, and the "delete the key rather than write the default" rule for unsetting. The reference's `globCovers` shadowing analysis is not reproduced: it exists to detect v1 key-order hazards, and V2's array form is order-explicit and displayed by index.

- **`ALWAYS_ELIGIBLE_PERMISSION_ACTIONS` is deliberately KEPT.** Once the real `question` rule is set to `allow` in the configuration, OpenCode raises no permission for it and the exemption has no input to fire on � but the V2 permission flow has not been re-proven end-to-end in a live turn, so removing it now would be deleting a live safety net on the strength of a types-level argument. It goes when the runtime behaviour is observed, not before.

- **Verified live against the running server and the real file:** page opens; all 9 rules listed in order with their real effects; the four `deny` rules render as Deny; a `question` change writes the file, persists across reload, and leaves the other 8 rules at their original index and effect; providers and credentials byte-identical; an injected unknown top-level field survives a save; a malformed global config reports read-only and the PUT is refused with the file byte-unchanged. `web/e2e/opencode-config-live.spec.ts` green in Edge and Chromium (8 passed, 2 skipped), with `afterEach` restoring the maintainer's original effect.

- **Status:** implemented. `web/e2e/helpers/cpuProfile.ts`, `web/e2e/renderer-cpu-profile.spec.ts`, `web/e2e/helpers/stubProvider.ts` (`setStubStreamShape` / `resetStubStreamShape`), `scripts/e2e-stub-provider.ts` (`/__e2e/stream` control, `splitIntoDeltas`).

## ADR: Measure renderer CPU in the e2e suite, not in a profiler session

- **The problem was located, not guessed.** A live sample of the packaged app (4s delta) showed `TBAi.exe` and `tbai-server.exe` at 0% while the `msedgewebview2` tree carried the load: 15-20% on 8 cores, bursty, absent at idle. So the cost is in the RENDERER, and the maintainable place to measure it is the suite that already owns renderer behaviour.

- **Four candidate costs were equally plausible from the code** - markdown re-parse per token, Shiki WASM tokenization, synchronous mermaid `dangerouslySetInnerHTML`, and the absence of virtualization. Reading the source establishes all four are POSSIBLE and cannot rank them, so the harness is designed around A/B comparisons whose RESULT is the finding rather than around asserting a budget nobody has measured yet.

- **The existing stub could not have measured the leading hypothesis.** `startStubProvider` emitted the whole reply as ONE delta, so the browser received a complete message in one shot and never rendered a partial reply. The O(n^2) per-token re-parse cost is invisible under that shape. Chunking is therefore opt-in and defaults to the historical single-delta behaviour, because the stub is shared across the whole suite and a non-zero default would silently change what every other spec exercises. `splitIntoDeltas` snaps boundaries to whitespace (a mid-word cut would model a stream no provider produces) and is verified lossless at sizes 1/3/5/24/1000, with no empty deltas.

- **Deliberately NOT a gate.** The specs assert only that the measurement was real (non-zero samples, non-zero task and script time), so a broken harness fails loudly instead of reporting a clean zero. Budget thresholds come after the first real run, the same baseline-first discipline `scripts/perf.ts` uses with its `-1` thresholds. A profiler that fails the build on a slow machine trains people to ignore it.

- **Fidelity caveat is recorded in the helper, not just here.** The suite runs in msedge/chromium, not the packaged WebView2. Same engine family, so RELATIVE attribution carries over and is what the harness is for; ABSOLUTE milliseconds do not, and a real fix must be confirmed against the packaged app.

- **First real run, and it refutes the leading hypothesis.** 3 passed (chromium-headless). Script time dominates (989ms of a 1454ms window; layout only 33ms, so DOM churn and mermaid are NOT the cost). Doubling reply length grew script time 1.76-1.80x, which is LINEAR, not the ~4x that per-token re-parsing of the whole growing message would produce - so `defer` is doing its job and hypothesis 1 is largely wrong as stated. Code-heavy vs prose-only at equal length is 1.56x, and `wasm-CG6Dc4jp.js` plus `wasm-function[25]` appear only in the code-heavy profile, which puts Shiki tokenization as the largest single identified lever. The dominant `(program)` frame is native and unnamed in the minified bundle, so the next step is a symbolicated build before attributing the remainder.

- **Status:** implemented. `web/vite.config.ts` (`TBAI_PROFILE_BUILD` mode), `scripts/profile-web.ts`, `package.json` (`build:web:profile`, `profile:web`), `web/e2e/helpers/cpuProfile.ts` (frameless bucketing), `web/e2e/renderer-cpu-profile.spec.ts` (idle + scroll added), `.gitignore` (`web/dist-profile/`).

## ADR: A symbolicated build cannot attribute the biggest frame, and that is now provable rather than assumed

- **The task was to make the dominant `(program)` frame attributable.** It is not attributable, and three measurements say so. This ADR exists so the question is not re-litigated against the next profiler.

- **Probe 1 - it is not mangled application code.** A trivial arithmetic loop written in the spec itself produced 85.6% `(program)`, with an empty script URL and ZERO positionTicks. A source map maps generated positions back to original ones; a frame with no position and no script has nothing to map. Probing five workload types gave `idle 100%`, `arithmetic 94.9%`, `string-build 78.6%`, `regex 78.9%`, `json 97.0%`, `dom-churn 94.4%` - and **100% on a fully idle page**, which is the tell. Time with no work in it is not a function that lost its name.

- **Probe 2 - the JIT is not the cause.** The plausible theory was that V8 optimising to native code destroys the JS frame, so `--js-flags=--jitless` (which stops compilation) should have restored attribution. It did not: `idle 88.4%`, `arithmetic 83.0%`, `string-build 86.5%`, essentially unchanged from the JIT-on run. The theory predicted a large drop and predicted wrong.

- **Consequence for the reporting, which is the part that matters long-term.** `(program)`, `(idle)` and `(garbage collector)` are now totalled as an `unattributable` bucket and are NEVER ranked beside real functions. Left inline, `(program)` at 18-24% would sit above every actual function in every report forever, and the readable names - the only actionable output - would be buried under a number that no build can improve. The idle floor is now explicit (96.3% frameless, 159ms task over a 3s window), so a busy-window figure can be read against a known baseline.

- **What the build IS good for, and it earned its place.** Disabling minification is what makes the profile readable at all, and the payoff was immediate and specific rather than cosmetic: the top frames went from `L0r`, `a`, `r`, `mGt` to `AssistantMessage` (2.9%), `subtokenize` (1.8%), `consume` (1.5%), `subcontent` (1.4%), `compile` (1.4%), `areChildrenEqual` (1.1%), plus `renderWithHooks` and `UserMessage` elsewhere. The largest single attributable frame is now `AssistantMessage` itself, with the react-shiki tokenizer (`subtokenize` / `subcontent` / `start`) and the markdown/rehype pipeline (`compile` / `check` / `atBreak` / `visit2`) all individually visible and separately targetable. No trace-mapping dependency was added: unminified output means the names are already in the code, so nothing needs resolving.

- **Deliberately fenced off from shipping.** Gated on `TBAI_PROFILE_BUILD`, and it writes to `web/dist-profile/`, never `web/dist/`. Unminified output is 8.1MB against 3.7MB and parses slower, so letting it near a production path would make the app worse while looking like a profiling aid. The artifact is gitignored, and `WEB_DIST_DIR` - which already existed in `src/routes/index.ts:161` - is the only seam used to serve it, so the e2e isolation model is untouched.

- **`cross-env` was not added.** `TBAI_PROFILE_BUILD=1 bun run build` is a plain POSIX assignment that Bun evaluates natively, and a dependency for one env var fails the "clear reason recorded in decisions.md" bar.

- **The three probe specs were deleted after the finding.** They answered their question; keeping them would leave three slow specs in the suite that assert a V8 implementation detail. What survives is the conclusion, in the helper's doc comment and here.

- **Second run (symbolicated, all 5 scenarios green).** Confirms and sharpens the first run: script time still dominates (1005ms of a 1442ms window, layout 36ms); **idle costs 159ms task over 3s** and **scrolling 12 turns costs 210ms** - both far below the streaming windows, so the 15-20% figure is about STREAMING specifically, not about sitting in a long conversation; the markdown tokenizer and react-shiki WASM (`wasm-function[25]` at 1.5-2.1%, only in code-heavy) remain the identifiable levers. The prose-vs-code ratio moved 1.56x -> 1.48x and the length-scaling growth 1.76x -> 1.97x with real names available - still LINEAR, so the O(n^2) re-parse hypothesis stays refuted, now with attribution rather than just a total.

## ADR: The assistant-ui DevTools panel was mounting in production because both of its guards read a `process` object Vite browsers do not have

- **The symptom.** The packaged app displayed "Waiting for assistant-ui instance...". That string is not TBAi copy; it is `@assistant-ui/react-devtools` `DevToolsPanel.tsx:186`, rendered whenever the panel has no `ctx`.

- **It was shipping, verified rather than assumed.** "Waiting for assistant-ui instance" was present in `web/dist/assets/DevToolsModalImpl-*.js` AND in the packaged build at `D:\tbai-windows-x64-portable\web\assets\DevToolsModalImpl-*.js` � a 160.8 KB chunk. `<DevToolsModal />` was rendered unconditionally from two shells (`app/layout/ChatShell.tsx:103`, `features/opencode/OpenCodeView.tsx:305`).

- **Root cause: the guard is written for a bundler that injects `process`.** `DevToolsModal.tsx:24` bails out only on `typeof process !== "undefined" && process.env?.NODE_ENV === "production"`. Vite browsers have no `process`, so `typeof process !== "undefined"` is false, the whole condition is false, and the early return never runs. The panel mounts.

- **Why the message was permanent rather than transient.** The same `process` assumption exists on the OTHER side of the handshake, but with the opposite polarity. `AssistantRuntimeProvider.tsx:43` reads `if (typeof process === "undefined" || ... ) return;` � with no `process`, this returns EARLY, so `DevToolsProviderApi.register` never ran in production. So the data-source side correctly bailed out while the panel side failed to, leaving a mounted panel with a permanently null `ctx`. The mismatch is the message. This is precisely what `main.tsx:9-23` already documents, and its DEV-only `process.env.NODE_ENV = "development"` shim is why dev works: it satisfies both guards.

- **The fix, and why it is not an inline condition.** `config/devtools.ts` owns one constant, `DEV_TOOLS_ENABLED = import.meta.env.DEV`, and `components/DevToolsGate.tsx` is the only place that reads it. Both shells now render `<DevToolsGate />` and neither imports the dev-only package. A wrapper rather than `{DEV && <DevToolsModal/>}` at each call site, because the decision must not be able to drift between the chat branch and the Code branch, and because it keeps a third-party dev dependency out of two feature files.

- **`import.meta.env.DEV` specifically, not `process.env.NODE_ENV`.** Vite statically replaces it, so the constant folds to `false` in a production build and the `lazy()` panel chunk becomes unreferenced. Result: the chunk is GONE from the build, not merely invisible. Verified � after the change, no `DevTools*` chunk exists in `web/dist`, the string is absent, and no main bundle references it. ~160 KB less shipped JS, and it can never be reached.

- **Development is unaffected, and this was checked rather than assumed.** Fetched the module from a live `vite dev` server: it resolves `import.meta.env` to `{DEV: true, PROD: false}`, so the panel still mounts and the `main.tsx` shim still satisfies the library's registration guard. (An earlier check using `vite build --mode development` was invalid and reported a false failure � `vite build` always sets `DEV=false` regardless of `--mode`; the mode name only selects which `.env` file loads. Corrected by testing the dev server directly.)

- **Honest scope on the CPU work: this is NOT the 15-20%.** Registration was already skipped in production (above), so the panel was mounted-but-inert: a static React subtree, a document-level `keydown` listener, and a `useSyncExternalStore` with no event source behind it. There is no `setInterval` or `requestAnimationFrame` in the package. That is dead weight and a wrong message in the shipped app, not a streaming hot path, and removing it should not move the CPU profile. Recording this so it is not later mistaken for the performance fix the profiling is still hunting.

## ADR: Streaming cost is per-delta render work, NOT repeated syntax highlighting - and the experiment that refuted the highlight hypothesis

- **The question.** A trace showed scripting dominating (19.6s script / 1.7s rendering / 82.4s wall), and the first profile had named react-shiki and Shiki WASM as the visible cluster. So: is highlighting being repeated unnecessarily for the same accumulated code? Four candidate fixes were on the table - reduce highlight frequency, avoid re-highlighting unchanged fences, defer highlighting until the message settles, or change the highlighting implementation. The right one depends on the answer, and guessing would have been a 4-way coin flip on the main-thread cost.

- **The experiment (`renderer-cpu-profile.spec.ts`, "is highlighting repeated per delta, or done once per fence").** Stream the EXACT same reply text twice, changing only how it is delivered: one delta, versus ~40 characters per delta. Identical final DOM, so any extra work in the many-delta run is by definition redundant.

- **Two confounds had to be removed before the numbers meant anything.**
  - *WASM instantiation.* The first run measured 121ms of WASM against the second's 11ms, which looked like proof that chunking causes highlighting and was actually just ordering - oniguruma's module and the Shiki grammars are paid for once per renderer. Added an unmeasured warm-up stream; the gap collapsed to 13ms against 0ms.
  - *The profile window closed before the work happened.* Highlighting runs AFTER the stream completes, so the window (which ended when the Stop button vanished) captured none of it for the fast run and all of it for the slow one - an artifact that would have read as "many deltas cause highlighting". The settle wait now runs INSIDE the profiled work.

- **The answer: the hypothesis is REFUTED. Shiki is not the problem.** With the module warm, WASM self time is **0ms in BOTH runs, in every run**. Delivering identical content 40 characters at a time does not add highlighting work - `defer` on the markdown element is doing its job. This is the one result that reproduced without exception across three executions, and it is the one the decision turns on.

- **What the cost appears to be - but the magnitude is NOT yet trustworthy.** Script time for piecemeal delivery was higher than for one-delta delivery in all three executions, but by wildly different amounts: **3.2x** (61ms vs 194ms), **1.7x** (115ms vs 198ms), and **1.09x** (186ms vs 203ms). The direction is consistent; the ratio is not. At ~200ms windows and a 1ms sampling interval these runs carry only ~200 samples each, which is far too few to quote a multiplier. The earlier "3.2x" in this entry was one of those three and should not have been written as a finding.

  So: per-delta render overhead is the leading candidate and is directionally supported, but the size is unmeasured. Treat "coalesce deltas" as the hypothesis to test, not a known win. Getting a real number needs either a much longer stream, a finer sampling interval, or several repetitions with the spread reported - none of which this harness does yet.

- **The largest single attributable frame is not Shiki at all, and this one IS solid.** It is `useThreadViewportAutoScroll` in `@assistant-ui/react` - 3.3% self time, more than any named function, named by reading the served bundle at the frame's reported position (`index-Dzhdlcws.js:50473`, inside `const useThreadViewportAutoScroll = ({autoScroll, ...})`). It reads `scrollTop`/`scrollHeight`/`clientHeight` and flips `isAtBottom` on every update. assistant-ui is a frozen dependency (see the 2026-09-15 train freeze), so this is a candidate for upstreaming or for working around at our boundary - not for patching in node_modules.

- **The fence re-highlight counter is not a usable measurement, despite looking like one.** It reported 36, then 84, then 358 "re-highlights" for the same configurations across three runs of the same code. Two reasons: the MutationObserver's first-vs-repeat split is structurally unmeasurable (it is delivered after the batch, so a freshly inserted fence already carries spans), and the per-fence map picks up fences from PRIOR messages being re-rendered when a new message is appended. It is retained as instrumentation for the per-fence update distribution, but no conclusion in this entry rests on it. The WASM comparison is what carries the conclusion, because WASM frames are unambiguous.

- **What this rules out.** "Reduce highlight frequency", "avoid re-highlighting unchanged fences" and "change the highlighting implementation" are all aimed at a cost that is not there. "Defer highlighting until the message settles" is already what `defer` does. The remaining candidates are delta coalescing (render the message fewer times per stream) and reducing per-render AST work.

- **Two bugs in my own instrumentation, both caught by checking reality instead of reasoning.**
  - *Call paths were always empty.* A CDP `Profile` node carries `children` but NO `parent` field, so the ancestor walk silently produced nothing and printed "(no attributable call paths)". Verified against the payload (2024 nodes, 1943 with children, all 105 sampled nodes resolvable to a parent) and fixed by inverting `children`. This is what turned the hottest frame from `() => {` into a named hook.
  - *Frames were keyed by name only,* so every anonymous function in a chunk collapsed into one meaningless "(anonymous) index-*.js" row holding 8% of self time. Keyed by position now.
  - *A fence re-highlight detector reported 0 on a reply that rendered 4 fences and 48 spans* because it walked UP for a `<pre>`; react-shiki inserts the whole `<pre>` into its container, so the `<pre>` is a DESCENDANT of the mutation target. Both directions are checked now. Its `firstHighlights` counter remains structurally unmeasurable (MutationObserver delivers after the batch), and is documented rather than asserted.

- **Still not explained.** These runs profile one stream. The user's 82-second trace is far longer, so whatever dominates a real session over that span is still unattributed. `AssistantMessage`, the AST walk and the viewport hook are the named candidates from the streaming window; confirming the fix against the packaged app is still required, since the harness runs in msedge/chromium and not WebView2.

## ADR: Mermaid was a STATIC import, putting 1.85 MB of layout engine in the startup chunk

- **What prompted it.** A renderer trace contradicted everything the streaming profiles had pointed at. It attributed 2,523 ms of "Script Evaluation" to ONE 3.5 MB chunk and estimated 2,693 KiB of it unused. Script Evaluation is module top-level execution - a STARTUP cost, paid once, before anything is interactive. Every streaming scenario in the harness profiles a LOADED page, so it structurally cannot see this.

- **Two different problems, and the earlier work had been answering the wrong one.** The streaming profiles describe per-delta work while a reply arrives. This trace describes what the browser evaluates before the first paint. They are not the same cost, and a fix for one does not move the other. The sustained 15-20% the user reported is not explained by a one-time evaluation cost; that remains a separate, still-unfixed question.

- **The cause.** `mermaid-diagram.tsx` did `import { renderMermaidSVG } from "beautiful-mermaid"` at the top level. `beautiful-mermaid` depends on **elkjs**, a standalone graph layout engine: 1.53 MB. Together 1.85 MB - 22% of the startup chunk - was parsed and evaluated on every launch to serve a feature most sessions never reach.

- **The fix.** Dynamic `import()` inside the effect that renders, with the resolved renderer cached in a module binding. The cache is not cosmetic: `import()` of an already-evaluated module still resolves in a microtask, so without it every diagram after the first would flash the loading skeleton for a frame - a thread switch would visibly flicker. Module-load failure is now also routed to the existing error fallback, which is strictly better than the synchronous version where a load failure was impossible because there was no load.

- **Measured, not assumed (`renderer-cpu-profile.spec.ts`, "cold start").** Reads Resource Timing rather than summing files off disk, so it reports bytes the browser ACTUALLY fetched.

  | | initial JS | time to interactive |
  |---|---|---|
  | before (static import) | 7914 KB | 1365 ms |
  | after (lazy import)   | 4437 KB |  856 ms |

  A 44% cut in initial JS, and the mermaid chunk is no longer in the startup payload at all (cold start now fetches exactly 1 script). The production build's main chunk went 3580 KB -> 2099 KB. Both numbers are from a real A/B: the "before" row was produced by stashing the change and rebuilding, not by recalling the old size.

- **What was deliberately NOT done.** No route-level `lazy()`. The router has none, so every settings page, the scheduler and the whole OpenCode Code mode ship to a user who opened a chat - but first-party code is only 1.52 MB of the 6.41 MB main chunk, and the genuinely required libraries (ai, react-dom, @assistant-ui/core, react-router, zod) are ~2.5 MB of irreducible floor. The headroom is real but modest, and `lazy()` would add a Suspense boundary inside the chat runtime provider that owns thread state - a much larger blast radius than the win justifies, and one that risks exactly the kind of conditional-mount context bug the dependency rules in AGENTS.md warn about. Worth revisiting with a measurement, not on principle.

- **`assistant-cloud` (0.06 MB) is a dead direct dependency in our package.json** - nothing in `web/src` imports it. It is also a PEER dependency of `@assistant-ui/react`, which is under the 2026-09-15 train freeze, so removing it is not ours to do unilaterally. Left alone deliberately.

- **Still unmeasured.** Whether the 15-20% sustained CPU is startup-related at all. A one-time evaluation cost cannot produce a sustained figure, so something else is still burning CPU during use. The streaming profiles remain the best evidence for that, and their conclusion - that Shiki is NOT implicated - still stands.

## ADR: The persisted tab mirror is reconciled against a request-driven existence endpoint, never a conversation list (2026-09-30)

- **The symptom.** A browser session held ~20 tabs whose conversations no longer existed. Every load re-probed each one, got a truthful `404`, and re-rendered them as "Untitled" - forever. Live check: `GET /api/conversations?status=all` returned 7 rows, all 7 answered `200` by id, and all 20 tab ids answered `404` with zero overlap.

- **The cause.** `localStorage["tbai:openTabs"]` is a set of live references into SQLite, and it had a convergence story for only one of its two necessary halves. It converged on write, from exactly one producer - `closeByRef` is called only by the in-app delete flow. It did not converge on read at all: `loadPersisted` -> `healTab` validates tab *shape*, never existence. Since `DELETE /api/conversations/:id` is a public REST contract also called by the e2e suite's cleanup, the scheduler, and any other client, divergence was monotonic - the mirror could only accumulate. Worse, re-validation was non-destructive by default (`TabStrip` swallowed every probe error into "Untitled"), so probing could never reduce anything. A check that cannot act is only cost.

- **The deeper defect.** Five surfaces probed `GET /api/conversations/:id` with four different error policies, and three of them used `r.ok ? r.json() : null` - an expression that collapses "this row is gone" and "the server is broken" into one value. Existence-checking was a property of whichever view happened to be mounted rather than a property of the state owning the mirror, so it would be re-implemented, differently, indefinitely. The adapter already had the correct semantics; it just was not the path most code took.

- **The contract** (`web/src/features/chat/state/conversationExistence.ts`): `2xx -> exists`, `404 -> gone`, every other status -> `unknown`; network throw / abort / unreadable body -> `unknown`. `unknown` is never `gone`. A 5xx is evidence about the server, not about the row, and treating it as absence is how a UI destroys a user's tabs because a laptop lid closed. One home, one classifier, no throws - every failure resolves to a verdict, so no call site can forget the `unknown` branch.

- **Why a purpose-built endpoint, not the list.** `GET /api/conversations` is scoped (`workspaceMode`, `folderId`, `status`) and capped (`limit <= 500`, ordered by `updated`), so absence from it is not proof of nonexistence. This is not theoretical: verified live during implementation, an **archived** conversation answers `exists` to the new endpoint while being correctly absent from `?status=regular&limit=500`. A list-based prune would have closed a live tab. The new `POST /api/conversations/reconcile` is complete *by construction* - the handler walks the request array to build the response, so an id can never be omitted even when the query matches nothing for it. That property, not request count, is the argument for it. It discloses only `{id, status}`.

- **Two halves, both required.** Boot (`tabReconciliation.ts`) is the one moment the client owns the complete reference set, so it settles the whole mirror in one batch request. Steady state is the per-tab probe `TabStrip` already issued, so deletion *while the app is open* costs zero extra requests. Different triggers, different mechanisms; conflating them is how one gets built and the other silently assumed.

- **The property that makes it safe.** Reconciliation is **removal-only**: `exists` has no write path at all. Resurrection is therefore impossible by construction rather than lock-protected, and `unknown` cannot erase anything because it has no write path. A late or stale `exists` cannot re-add a tab; a duplicate `gone` for an already-closed ref is a no-op (`closeByRef` on an absent ref is already covered by `chatTabs.lifecycle.test.ts`). A response missing any requested id invalidates the whole pass, so a server bug degrades to "retain everything" instead of mass eviction.

- **Ownership.** The module owning `tbai:openTabs` owns the eviction rule. Views receive a verdict; they no longer decide "404 means delete this tab" - including `useConversationTab`, whose hand-rolled per-key close loop was a second removal path and now goes through `evictIfGone`. One mutation (`closeByRef`), one eviction rule, one `tab.evicted` log line.

- **Retry rides the existing mechanism.** No new poller and no second sync system: the pass re-runs as one step in the existing coordinated recovery sequence, and the browser's `storage` event remains the cross-tab path (untouched - it already converges peers, and the writer updates its own store directly because the browser never fires `storage` at the writer). No BroadcastChannel.

- **What was deliberately NOT done.** No conversation-index / N+1 refactor (the sidebar, header, and Code chips still each fetch their own row - separate architectural change). No existence-only single-id API: an earlier draft proposed one and pointed the four data-reading consumers at it, which would have forced a second request per consumer to re-fetch fields they already had - turning one correct fetch into a guaranteed N+1. `probeConversation` returns the row data alongside the verdict, and the row type mirrors what `mapConversation` actually sends (`engine` / `workspaceMode` are coalesced to a default, so they are never null on the wire - a fact the old untyped `.json()` had been hiding). No 404-to-200, no null-for-missing, no tab trimming, no retry-that-deletes, no periodic poll, no console suppression. `TabStrip` keeps routing through `threadListAdapter` because an existing architectural guard asserts that path, and the adapter now delegates to the contract anyway.

- **Deliberately unchanged: the server's 404.** A missing row is a truthful 404 and stays one. `docs/decisions.md`'s resume-404 self-healing entry and the confirmed-vs-indeterminate doctrine both depend on 404 being meaningful; returning `200 {error}` to quiet a symptom would delete the vocabulary the retry story is written in.

## ADR: The application — not the provider SDK — guarantees replayable history (2026-10-02)

- **The symptom.** A Direct conversation against an OpenAI-compatible gateway
  (`agnes`, `custom` + `chat-completions`) became permanently unusable. Eighteen
  consecutive sends answered HTTP 400 and the user saw *"Generation failed. Retry
  or pick another provider/model."* Nothing about the conversation changed
  between the five successful sends before it and the eighteen failures after,
  and another conversation on the same provider and model kept working.

- **The cause, end to end.** A prior run's `write_file` tool call had its
  arguments cut off mid-object by the gateway, so the AI SDK could not parse
  them and recorded the interaction as

  ```json
  { "type": "tool-write_file", "toolCallId": "call_92b1…",
    "state": "output-error", "input": undefined,
    "rawInput": "{\"path\": \"project-console/projects.json\"" }
  ```

  `ai@7.0.93`'s `convertToModelMessages` substitutes `rawInput` for the missing
  `input`, and `@ai-sdk/openai-compatible@3.0.44` then serializes it as
  `arguments: JSON.stringify(part.input)`. The wire therefore carried a JSON
  **string** where a JSON **object** is required, and every retry re-sent the
  identical malformed payload. Measured on the exact production history: one
  invalid field in a twelve-message request, at
  `messages[9].tool_calls[0].function.arguments`.

- **The invariant.** Before `convertToModelMessages` receives persisted history,
  every tool part that CAN become a provider tool call must carry usable
  arguments. A provider SDK is not a history-repair layer: it faithfully
  converts what it is given, and it has no way to know that a stored interaction
  can never be replayed. `src/lib/prune-messages.ts` is the only seam between
  stored history and conversion, so the invariant lives there and nowhere else.

  Replayable means `input !== undefined`, or — for the legacy `output-error`
  shape only — a `rawInput` that recovers to a **non-null plain object**.
  Anything else is `unreplayable`.

- **"Parses" is not the bar.** A recovery that only checked `JSON.parse` would
  accept `"[]"`, `"null"`, `"42"` and `'"text"'`, each of which serializes to a
  value the wire rejects. The recovered value must be a plain object, so the
  check is `isPlainObject`, not "did it parse".

- **Lenient recovery, and why it must WRITE the recovered object.** Keeping a
  recoverable legacy part is not sufficient, and the integration test caught this:
  the SDK substitutes `rawInput` **verbatim**, so an un-promoted part still puts
  raw text on the wire — the same defect. Recovery is therefore promoted into
  `input` (on a copy; the persisted part is never mutated) and `rawInput` is
  dropped, so a replayed part carries exactly one authoritative source of
  arguments. Genuine arguments are preserved rather than discarded, and the
  history stays replayable.

- **The `unreplayable` lifecycle extends the existing model rather than
  replacing it.** `output` / `approval` / `incomplete` are untouched. An
  unreplayable occurrence simply matches neither of the two keep rules in Pass 2,
  so it falls through to the existing removal path and is recorded in
  `removedToolParts`. **Atomicity is a property of the architecture, not extra
  code:** the SDK derives the assistant-side tool call AND the `tool` role
  message from the same parts, so removing the part removes both. No orphan
  `tool` message can survive, and an assistant turn left with only `step-start`
  is already dropped by the existing Pass 4. The keep-set is per *occurrence*,
  so an id with both a replayable and an unreplayable occurrence keeps the good
  one.

- **Approval state is NOT the deciding criterion — replayability is.** The
  question asked is "can this part produce a valid provider tool call", never
  "does it carry a decision". Concretely, and all four measured against the
  installed SDK:

  | state | usable input | outcome | why |
  |---|---|---|---|
  | `approval-requested` | yes | preserved, `preservedApprovals` | filtered before conversion; never reaches the wire |
  | `approval-requested` | no | preserved | same; dropping it would break the AGENTS.md invariant to fix a defect it cannot cause |
  | `approval-responded` | yes | preserved and replayable | the continuation contract |
  | `approval-responded` | no | `unreplayable` | it IS replayed, so the SDK emits a call whose `arguments` is absent entirely |

  Valid approval state is never blanket-dropped. `approval-requested` is absent
  from `PROVIDER_TOOL_CALL_STATES` precisely because that set is what makes the
  distinction safe.

- **An SDK upgrade is explicitly NOT the remedy.** Verified rather than assumed:
  the installed resolution is `ai@7.0.93`, `@ai-sdk/provider@4.0.10`,
  `@ai-sdk/provider-utils@5.0.36`, `@ai-sdk/openai-compatible@3.0.44`,
  `LanguageModelV4` (`specificationVersion: "v4"` observed at runtime), and the
  compiled portable binary contains the *same* resolution — identical bun
  integrity hashes, and `bun.lock` is byte-identical to the build commit.
  Upstream `main` (npm `ai@7.0.127`) **still contains** the same
  `part.input ?? part.rawInput` fallback, and
  `warnIfUIMessageHasDeprecatedRawInput` states the position outright:

  > `rawInput` in `output-error` UI message parts — *"Use the `input` field
  > instead. The `rawInput` field will be removed in the next major version."*

  So the shape is a DEPRECATED shape the SDK merely tolerates, not an SDK defect,
  and upgrading within v7 changes nothing. The next major would not fix it either:
  with the fallback gone, `input` is `undefined` and the wire carries no
  `arguments` at all — the `approval-responded`-without-input case above, which
  this repair also removes.

- **The 4xx copy split is independent of the repair, and separately justified.**
  `classifyError` maps every 4xx to `config`, and `config` is never retryable
  (`DIRECT_MAX_RETRIES = 0`), so the generic copy's first clause — "Retry" —
  recommended the one thing that cannot work. The bucket also conflated two
  causes needing OPPOSITE advice: a rejected MODEL (switch model) versus a
  rejected REQUEST (retrying reproduces the rejection). A new `modelIdentity`
  FLAG splits them without touching the category, retryability, log fields or
  any existing policy. Deliberately narrower than `CONFIG_RE`'s bare `not found`,
  which also matches our own text ("Conversation not found"), and checked against
  the REFINED category so a claimed refinement wins outright. A `config` failure
  with no 4xx status is one of our own refusals (workspace bounds, approval
  required) and keeps the generic copy.

- **Observability is allowlisted, and `responseBody` is never read.**
  `APICallError` carries three things that must be treated differently: `data`
  (the provider's parsed error object), `responseBody` (the same content
  unparsed — a gateway that echoes the offending request puts the prompt, the
  tool arguments and file contents there), and `requestBodyValues` (the entire
  outbound request, by definition). The new `ai.provider_error_code` event reads
  only `error.type`, `error.code` and `error.param` from `data`. These are
  machine identifiers the provider chose to label its own failure with, which is
  what makes them safe while remaining actionable: a gateway answering
  `param: "messages[9].tool_calls[0].function.arguments"` names the exact wire
  defect and quotes none of the user's data. `errorLogFields` keeps its
  deliberate omission of the provider message, and the diagnostic is a SEPARATE
  event so `ai.error` is byte-for-byte as narrow as before.

- **Verified at the boundary, not by mirroring.** The integration suite stands a
  local OpenAI-compatible endpoint behind a seeded provider and audits the
  captured outbound request; the endpoint answers 400 to any non-object
  `arguments`, so it REPRODUCES the production rejection rather than tolerating
  it. The exact production history — dumped verbatim from the failing
  conversation into a scratch SQLite database — was replayed against it:
  **before** repair the stub answered `400 messages[9].tool_calls[0](write_file).arguments parses to string`
  with 1 tool call and 1 orphan tool message; **after** repair the stub
  accepted the request with 0 tool calls and 0 tool messages. No production
  provider was contacted and no quota was spent.

- **What was deliberately NOT done.** No AI SDK change, no dependency change, no
  patch to `node_modules`, no provider-specific branch, no second history-repair
  layer, and no change to the Direct route's structure, provider options, retry
  mechanics, or the approval continuation contract. `model-messages.ts` is
  untouched: the architecture is unchanged, only the content handed to it is.
  The compiler fix found while implementing — that a bare `approval-requested`
  part without `input` is rejected by the route's own UIMessage schema — was
  deliberately NOT "fixed": a request that cannot be persisted cannot poison
  history, and loosening the schema to accept it would weaken a real boundary to
  accommodate an unreachable shape.

---

## Generation-400 final defect fix - the replayable-input SHAPE, and not inventing a cause

An independent audit of `78101a8` (the `unreplayable` lifecycle) accepted the
architecture and the `output-error` recovery, then found one blocker and one
secondary copy defect. Both are closed here.

### Blocker: ``input !== undefined`` is not "usable arguments"

The repair asked only whether ``input`` was present:

    if (part.input !== undefined) return true;

That is the wrong question. The wire contract is a JSON **object**, and the SDK
substitutes with ``part.input ?? part.rawInput`` (``ai@7.0.93``) while
``@ai-sdk/openai-compatible@3.0.44`` serializes whatever it received as
``arguments: JSON.stringify(part.input)``. Because ``??`` treats ``null`` as
ABSENT, a part carrying ``input: null`` fell straight through to its
``rawInput`` and put text on the wire - the production defect, reachable
through a key the repair had never inspected. Every other non-object shape was
unrepaired for the same reason: an array, a string, a number and a boolean each
reached the provider where an object is required.

Reachable, not theoretical: the route validates messages with the SDK's own
``safeValidateUIMessages``, whose tool-part schema types ``input`` as
``z.unknown().optional()`` and therefore ACCEPTS ``null``.

- **The fix is the shape, never presence.** ``hasUsableToolInput`` now tests
  ``isPlainObject(part.input)`` - the same rule the file already used to decide
  what ``rawInput`` recovery yields, so there is ONE definition of "usable" in
  the file rather than two that can disagree. ``withRecoveredToolInput`` uses
  the same test, which is what lets a part with a non-object ``input`` AND a
  recoverable ``rawInput`` be repaired instead of discarded: leniency should
  cost nothing. Anything neither shape covers is unreplayable and takes its
  synthesized tool result with it, because the conversion derives both from the
  same parts.

- **Approval semantics are untouched, and asserted.** Replayability - never
  approval state - is still the deciding criterion, and it is still gated by
  ``emitsProviderToolCall``. An open ``approval-requested`` gate is filtered
  before conversion, so it is preserved for ANY ``input`` shape including
  ``null`` and arrays; a RESPONDED approval IS replayed, so it needs usable
  arguments and is dropped without them.

- **Reproduced before and after at the boundary.** The new integration suite
  drives the real ``POST /api/chat`` against a local validating stub and audits
  the captured outbound request. Against pre-fix ``15ffcef`` the exact
  production payload carrying ``input: null`` put
  ``messages[1].tool_calls[0](write_file).arguments`` on the wire as a JSON
  **string** and the stub answered **400**; the same suite reported 24 failures
  across the shape cases. After the fix all 69 cases pass, with 0 tool calls and
  0 orphan tool results. The stub's own validator is asserted case-by-case, so
  its authority to fail a request is proven rather than assumed.

### Secondary: ``MODEL_IDENTITY_RE`` must not invent a cause

The pattern ended with ``\bmodel\b[^.]{0,80}\b(?:not found|...)\b``. That gap
bridges ordinary English, so gateway prose that merely mentions the model and
later reports something ELSE as not found was claimed as a model-identity
failure - telling the user to switch models when switching model would change
nothing, which the pattern's own comment called the worse error:

    "The model output did not contain the required tool; not found"
      -> "The provider rejected this model. Pick another model ..."

Every clause must now name the model as the thing that is missing: a fixed
provider phrase (``model_not_found``, ``no such model``, ``unknown model``), or
a gap that is a MODEL ID - introduced by a colon/equals, or identifier-shaped -
followed by a specific predicate. Free English between "model" and the predicate
is never bridged. The true positives that matter keep working (OpenAI's
``model_not_found``, Anthropic's ``model: claude-x not found``,
"The model `x` does not exist", the underscore spellings), the flag is still
checked against the REFINED category so a claimed refinement wins, and it still
never makes a failure retryable.

### Alternatives considered and rejected

- **Loosen the route's UIMessage schema to reject ``input: null``.** Rejected:
  it duplicates a rule the repair already owns, and the SDK owns the schema. A
  boundary that is stricter about shape but silent about the *other* unreplayable
  states (``[]``, ``"x"``, ``42``) fixes one symptom and leaves the defect.
- **Normalize a non-object ``input`` to ``{}`` and keep the part.** Rejected:
  it invents arguments the model never produced, and the model would then be
  shown a tool result for arguments it did not choose. Dropping a part that
  cannot be replayed, and recovering one whose real arguments are recoverable,
  are both truthful.
- **Validate on the wire instead of in history.** Rejected: a provider SDK is
  not a history-repair layer, and by then the malformed payload is already being
  sent. The application owns the repair.

### What was deliberately NOT done

No AI SDK version change (still ``ai@7.0.93`` /
``@ai-sdk/openai-compatible@3.0.44``), no patch to ``node_modules``, no
dependency or lockfile change, no change to Part 4/5 architecture
(``model-messages.ts`` untouched - only the content handed to it changed), no
provider behaviour change, no raw request/response logging (the
``ai.provider_error_code`` allowlist is unchanged and still reads only
``error.type``/``code``/``param``), and no real provider call of any kind.

### Verified

Focused repair suites, the previously audited Generation-400 suites, approval
lifecycle, error taxonomy/hygiene, the Direct route suites, and the Part 2/3/4/5
context-compaction-cache-memory regressions are green; ``typecheck`` and
``build`` both exit 0. Numbers are recorded against this commit's SHA in the
audit hand-off rather than restated here.

## 2026-10-03 — The SPA builds into `dist/web`, beside the server binary, not into `web/dist`

**The problem was a split artifact, not untidiness.** `build:backend` compiled the
server to `<repo>/dist/` while `build:web` emitted the SPA to `web/dist`, so one
shippable product lived in two trees. The cost was that the local layout could
silently diverge from the shipped one: the portable/tauri workflow already copied
the SPA to `$out/web/` beside `tbai-server.exe`, so `dist/` was already the shape
of the artifact being distributed, while a local build produced something else.

**`dist/web` is the single output location.** `web/vite.config.ts` emits to
`../dist/web`, and the `DIST_DIR` default in `src/routes/index.ts` resolves to
`<cwd>/dist/web`. Local and packaged output are now the same layout and `dist/` is
one folder to copy. `WEB_DIST_DIR` remains the only seam that redirects the served
artifact, which is what still lets the CPU-profiling run and the e2e suite point at
a different build without touching production code.

**`emptyOutDir` is explicit on both branches because the outDir left the Vite
root.** Vite refuses to empty an outDir it cannot prove is safe and only warns
when it skips. Since every build emits new content hashes, a skipped clean would
strand stale `assets/*.js` in the output forever. It empties `dist/web` and never
`dist/`, so the web step cannot delete `tbai-server` — verified by building with
the binary already present.

**Alternatives considered and rejected.** *Flat `dist/`* — `index.html` and
`assets/` directly beside `tbai-server.exe`. Rejected: it mixes a compiled
executable with a web root, so anything that serves or copies the SPA must know to
exclude the binary, and the packaged build already establishes `web/` as the SPA
subfolder. *Keep `web/dist` and change only the server default* — rejected: the
local/shipped divergence is the actual defect, so that treats the symptom.

**Every dependent reference moved together**, because a partial move is exactly
the failure mode that leaves CI green and the shipped package empty:
`src-tauri/tauri.conf.json` `bundle.resources`; all four `web/dist` sites in
`.github/workflows/tauri-build.yml` (the `Test-Path` precondition, the
prerequisites comment, `WEB_DIST_DIR`, and the `Copy-Item` into `$out/web`);
`scripts/start-e2e-server.ts`'s precondition check; and the `WEB_DIST_DIR`
fallback in `web/e2e/renderer-cpu-profile.spec.ts`. `.gitignore` needed no change —
`dist/` already covers `dist/web`, confirmed with `git check-ignore`.

**The profiling build was deliberately left in a different tree.** It stays at
`web/dist-profile`, which after this change is a genuinely separate tree from
`dist/web`. The rule that a profiling artifact can never overwrite the shippable
output therefore became structural rather than conventional, and
`scripts/profile-web.ts` plus the performance docs keep working untouched.

**Verified.** `bun run build` exit 0, emitting `dist/tbai-server.exe` and
`dist/web/{index.html, assets/, app-icon.png}`. The compiled binary, launched with
no `WEB_DIST_DIR` set, serves `GET /` 200 containing `<div id="root">` and an
`assets/index-*` reference, and `GET /api/health` 200 `{"status":"ok"}` — so the new
default resolves at runtime, not only at build time. `bun run typecheck` exit 0.
`bun run lint` exit 0, with no warning in any changed file. The stale `web/dist` tree
was deleted so it cannot be mistaken for the live output.

**Not claimed:** the CI workflow and the tauri bundle were edited but not executed
here — `tauri build` was not run, so the packaged artifact is verified by path
consistency and by the layout already proven locally, not by a fresh CI run.
