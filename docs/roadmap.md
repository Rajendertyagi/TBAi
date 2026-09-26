# Roadmap

Kept intentionally small. Update continuously.

## Completed

- Application shell: responsive sidebar + header + view switching (chat / settings / memories).
- Provider system: SQLite-backed CRUD, in-memory `ProviderRegistry`, provider adapter (`getModel`).
- Conversations + messages + memories endpoints and storage services.
- Chat streaming migrated to **AI SDK v7** (`streamText` + `convertToModelMessages` + `toUIMessageStreamResponse`).
- Frontend chat migrated to **@assistant-ui/react** (`Thread` / `Composer` / `Message`); removed custom chat store and custom SSE parsing.
- Security: API keys never sent to the browser; `GET /api/providers` returns only metadata + `credentialConfigured` (no key, no ciphertext); the browser sends only `providerId`. Keys are encrypted at rest with AES-256-GCM under a local per-install DEK (`src/services/credentials.ts`), persisted in the `credential_key` table so the portable app folder is self-contained. No master password / unlock / login, no OS keychain, no `.env` required. `PUT` preserves keys on partial updates; a `Test connection` endpoint validates providers without persisting. Logs/errors are redacted.
- Input validation with **Zod** on all API routes (`src/lib/validation.ts`).
- Removed redundant custom streaming code while retaining the official
  `assistant-stream/resumable` utility for resumable byte storage. The direct
  dependency is pinned to `0.3.43` in both manifests, matching assistant-ui.
  `toUIMessageStream()` remains the chat protocol; `assistant-stream` is not a
  second chat runtime. Also removed `drizzle-orm`/`drizzle-kit` (unused).
- Documentation set created under `docs/` and `/AGENTS.md`.
- **End-to-end chat path confirmed working (2026-09-08):** typecheck + build pass; a real AI request streams through the vite proxy (5173) → backend (3000) → Google Gemini → assistant-ui renders it. Error handling (400 on invalid body; graceful streamed `error` event on a bad provider) and provider switching (routed to a second OpenAI provider via `providerId`) are both verified.
- **Navigation is now configuration-driven:** labels, icons, badges, target views, children, ordering, and visibility live in `web/src/config/navigation.ts` as the single source of truth. `Sidebar`/`App` consume it; the Search item is gated by a `features.search` flag. Adding/removing/reordering/hiding/renaming a nav item requires no component change.
- **DeepChat persistence study — completed:** audited DeepChat's conversation/message data model, SQLite persistence layer (`better-sqlite3-multiple-ciphers` + custom `BaseTable`/v10 migrations), history UX, and state flow. Produced `docs/deepchat-persistence-study.md` with a minimal TBAi design and a minimum-code classification. (This is research only — conversation persistence is **not yet implemented**; see Next.)
- **Conversation message-history persistence — implemented (2026-09-08):** built on
  assistant-ui's native thread architecture rather than a custom store. `RemoteThreadListRuntime`
  (`web/src/runtime.ts`) owns thread/message state; `RemoteThreadListAdapter`
  (`web/src/adapters/remoteThreadListAdapter.tsx`) handles list/create/rename/archive/delete
  over `GET|POST|PATCH|DELETE /api/conversations`; `ThreadHistoryAdapter`
  (`web/src/adapters/threadHistoryAdapter.ts`) implements `withFormat()` to load/append/update/
  delete messages via `GET|POST /api/conversations/:id/messages`, storing the runtime's opaque
  storage format verbatim. Backend gained `conversations.status`, `messages.parent_id`/
  `order_seq`/`status`/`format`, and idempotent migrations. `useConversationsStore` (Zustand)
  was removed. Verified end-to-end in the browser: new thread created on send, user + assistant
  messages persisted (`ai-sdk/v6` format), reload restores the thread list, opening a thread
  restores messages, multiple threads are isolated, search filters, and the `⋯` menu archives/
  renames/deletes. `bun run build` (backend + web) passes.
- **Generic MCP client — implemented (2026-09-08):** standards-based MCP support via the official
  `@modelcontextprotocol/sdk`. A `McpManager` singleton (`src/services/mcp/manager.ts`) connects to any
  MCP server over **STDIO**, **Streamable HTTP**, or **legacy SSE**, discovers tools/resources/prompts
  + server capabilities, handles notifications (progress, list-changed, logging) and bounded
  reconnect, and exposes discovered tools to the model as AI SDK v7 `tool()` wrappers merged into the
  chat route (`tools: { ...serverToolSchemas, ...mcpManager.getAiTools() }`, namespaced
  `mcp__<serverId>__<tool>`). Config lives in the `mcp_servers` SQLite table (auth tokens encrypted at
  rest with the local DEK). A `/api/mcp` REST API backs a non-coder-friendly `McpPanel` GUI
  (add/edit/delete, enable toggle, connect/disconnect/refresh, **Test connection**, browse
  tools/resources/prompts, live events). STDIO + Streamable HTTP verified via `scripts/test-mcp.ts`;
  the REST API verified via `scripts/test-mcp-api.mjs` against a running server; typecheck + build pass.
  SSE is implemented but not yet live-tested; Desktop Commander MCP (`npx -y @wonderwhy-er/desktop-commander@latest`)
  is the intended first real-world server (requires Node/npm/npx; validated via a Bun minimal server in
  this env). See `mcp.md` and `decisions.md`.
- **MCP resources/prompts + advanced client capabilities — implemented (2026-09-08):** discovered
  **resources** and **prompts** are now usable from the MCP panel — *Insert* reads a resource and drops
  its text into the chat composer; *Use* resolves a prompt (with its arguments) into the composer
  (`McpManager.readResource`/`getPrompt` + `/api/mcp/servers/:id/resource/read` and `/prompt/get`,
  applied via `unstable_useComposerInput().setText`). The full client capability set is now consumed:
  **roots** (per-server URI list answered on `roots/list`), **sampling** (server `sampling/createMessage`
  fulfilled via the active provider's `generateText`), and **elicitation** (server `elicitation/create`
  surfaced to a global `ElicitationModal` that posts the answer to `/api/mcp/elicit/resolve`). Verified
  via `scripts/test-mcp.ts` (STDIO + HTTP, incl. resource read + prompt get) and `scripts/test-mcp-api2.mjs`
  (live REST). SSE and end-to-end sampling/elicitation remain pending live runs.

## Current

- **Direct AI SDK v7 boundary hardening (2026-09-25):** explicit transport
  validation, `safeValidateUIMessages`, persisted system instructions, signed
  tool approvals, producer-side UI-stream outcome settlement, no replay after
  output starts, sanitized Direct logs, and assistant-stream dependency alignment.
  Durable SQLite resumable chunks **shipped (2026-09-26)**: `chat_streams` /
  `chat_stream_chunks` behind the official `ResumableStreamStore` interface, boot
  recovery, TTL cleanup, detached-run history finalization, and a Composer recovery
  notice with a guarded Retry. Live-verified against `agnes-2.5-flash` with a
  mid-stream `SIGKILL`. See `docs/2026-09-25-phase2-durability-design.md` and the
  Direct Chat durability rows in `docs/phases.md`.
- The smallest end-to-end chat path is **confirmed working**. Provider-agnostic chat via assistant-ui + AI SDK v7 is operational.
- Conversation message history is **persisted** via assistant-ui's thread architecture (RemoteThreadListRuntime + ThreadHistoryAdapter) and survives reloads. The history sidebar supports new/open/switch/auto-persist/reload-restore/rename/archive/delete/search.
- **Native toolkit architecture (2026-09-10):** 11 native tools are one `defineToolkit` registration (render-only backend entries); server executes in `streamText` with `toolApproval` gates for write/edit/delete/run/kill; continuation via official `sendAutomaticallyWhen` helpers. Zero human tools; `/api/tools/*` kept as manual/test surface. See decisions.md ADR.
- **Renderer hardening (2026-09-10):** status-driven tool cards (running/requires-action/incomplete/complete), cancelled/expired gates render closed state, `display: standalone` on gated entries, defensive approval options/prompts, approval a11y labels. Last deprecated primitives migrated (`Empty`→`AuiIf`, `Messages` children fn). Dev-only assistant-ui DevTools mounted (null in production).
- **Centralized logging (2026-09-10):** one logger contract server+frontend, `req_<id>` correlation via AsyncLocalStorage, redaction, error normalization, JSON-lines file logging in production, `AI_DEBUG_REQUESTS` sanitized AI diagnostics. Gemini 400 root cause made observable (see decisions.md).
- **Approval/pruning durability fix (2026-09-10):** approval decisions survive history pruning while they are the active continuation; expired decisions (conversation moved on) are dropped and require fresh approval; production history path extracted to `prepareModelMessages` so tests cannot bypass pruning. Fixed live regression: approved tools never executing (login.html loop).
- **UI overhaul (2026-09-10):** shadcn dual-theme system (light/dark toggle, default dark) with zero hardcoded colors/values; fixed white dropdowns, transparent menus, per-message red strips, card-size mismatches, tiny diffs, stale rename (now inline via runtime), reload landing (thread restore); added entrance animations, ScrollToBottom, message action bars, icon composer, view fade. See decisions.md ADR.

## Feature options (logged from docs audit — unprompted, unbuilt)

Message action bars + branch picker · suggestions grid · scroll-to-bottom · message editing · slash/mentions/input history · attachments · quote-selection · voice/dictation · LaTeX · MCP App widgets · generative UI · Streamdown partial modernization (does not replace DiffViewer).
- **Reconciliation implemented (2026-09-10, NOT yet test-verified — another agent runs tests):**
  abort propagation (route→streamText→MCP tools), ErrorPrimitive + sanitized copy,
  resumable streaming + resume route + per-thread keys, usage/model/finish metadata +
  trivial token readout, FTS5 server content search, LoadMore UI, roots list-changed
  push + notify route. MCP SDK deliberately stays v1.30 (v2 = gated roadmap item).
- **Application foundation — implemented (2026-09-11, tests + live E2E by the test agent):**
  `react-router` v8 hash routing (`/`, `/chat/:threadId?`, all settings pages, `*`→`/`), chat tabs
  over one shared thread-list runtime (background streams survive switches by architecture; E2E must
  prove it), split-screen-ready tab model (`groupId`), backend `routes/` split into per-concern
  modules (identical paths), modular `app/` + `features/` frontend, dashboard landing, Recent-5 +
  Show More sidebar, settings split (Providers/Appearance/Workspace + shared grammar). One new dep
  (`react-router@8.3.1`). See ADR-018. Pending: `bun test` (incl. new `tests/unit/foundation.test.ts`)
  + the 20-step live browser E2E in the task brief.
- **Built-in scheduler / cron — implemented (2026-09-11, NOT yet test-verified — another agent runs tests):**
  SQLite-backed (`scheduler_jobs` / `scheduler_runs`, UNIQUE occurrence guard), `Bun.cron` recurring +
  `setTimeout` one-time, restart recovery (interrupted reconciliation + missed-run grace policy),
  `skip_if_running` overlap, transient-only retries, explicit per-job provider/model/thinking/workspace/
  prompt, unattended-safe tools (destructive tools always refuse, no MCP tools in V1), deterministic
  execution via `getModel` + `generateText`, `/api/scheduler` REST + non-coder Scheduler GUI (presets,
  live preview, run history). Zero new dependencies. See `scheduler.md` + ADR-017. Pending: test run
  (`tests/unit/scheduler.test.ts`) + the live E2E checklist in `scheduler.md`.

## Next

- Provider switching UI: choose the active provider from the chat view; backend model switching is already verified server-side.
- Add a typecheck/lint script and a minimal smoke test for `/api/chat`.
- Live-test the **SSE** transport against a legacy SSE server; add a `testConnection`/reconnect e2e.
- Confirm **Desktop Commander MCP** end-to-end on a machine with Node/npm/npx (file-system tool surface).
- Exercise **sampling** and **elicitation** end-to-end with a provider key and a server that uses them
  during a chat (both are fully wired; not yet run live in this environment).

## Deferred (do not build until the basic path is confirmed)

- Tool calling / function execution (now partially covered by MCP tools; native app tools still TBD).
- RAG / retrieval.
- File handling / uploads.
- Advanced persistent memory supplied to the model.
- Auth, multi-user, and deployment hardening.
