# AGENTS.md — Permanent Development Rules (TBAi)

Read this before changing code.

## Project goal

A small, provider-agnostic AI chat app. Minimum custom code; libraries do the heavy
lifting. Chat must remain provider-agnostic.

## Supported stack (do not diverge without a decision)

- Frontend: React 19 + Vite + TypeScript + Tailwind v4.
- Chat: `@assistant-ui/react` + `@assistant-ui/ai-sdk`.
- AI: **AI SDK v7** (`streamText`, `convertToModelMessages`, `toUIMessageStreamResponse`).
- Backend: Hono + Bun.
- Persistence: SQLite via `bun:sqlite`.
- Client state: Zustand (UI state only).
- Validation: Zod.
- MCP client: official `@modelcontextprotocol/sdk` (transports + protocol) + AI SDK v7 `tool()`
  wrappers. Do **not** hand-roll JSON-RPC/MCP framing or add a second MCP client library.

## Core rules

1. **Minimum custom code.** Before writing functionality, check `@assistant-ui/react`,
   `@assistant-ui/ai-sdk`, AI SDK v7, shadcn/ui, Radix, Hono, and the stdlib. Prefer
   the library. Do not recreate chat state, streaming transport, message rendering,
   tool-call UI, or basic runtime behavior.
2. **Library-first for AI.** Use AI SDK v7 + assistant-ui. No second custom streaming
   protocol unless technically required and documented.
3. **Security.** Never expose provider API keys to the browser. Keep secrets
   backend-only and encrypted at rest (AES-256-GCM under a local per-install DEK in
   `src/services/credentials.ts`). No master password / unlock / login, no OS keychain,
   no `.env` required for normal use. The browser sends `providerId`, not the key.
   **MCP auth tokens** follow the same rule (`mcp_servers.auth_token` encrypted via
   `encryptSecret`; only `auth_type` is echoed). **MCP tools are server-executed** — the
   MCP `Client` lives in the backend; the browser only drives config/status over `/api/mcp`.
   Validate all API input with Zod.
4. **Configuration-first.** Avoid hardcoded provider names, models, nav, flags, UI
   dimensions, behavior. Keep provider logic behind the registry/adapter.
5. **State management.** SQLite → persistent data; Zustand → shared UI state; React
   local state → component-local. Zustand is not the persistence layer.
6. **Memory separation.** Keep conversation history, persistent memory, and temp UI
   state separate. Don't claim memory works until it is retrieved and supplied to the
   model.
7. **Keep it small.** No LangChain, LangGraph, Mastra, Redis, PostgreSQL, Docker, or
   unnecessary agent frameworks/abstractions. Add a dependency only with a clear
   reason, recorded in `docs/decisions.md`.

## Architecture boundaries

- `web/src/runtime.ts` — only place that wires the chat transport to `/api/chat`
  (sends `providerId` only).
- `web/src/components/ChatWindow.tsx` — assistant-ui primitives only; no custom
  rendering of messages.
- `src/services/ai.ts#getModel` — only place that maps provider type → model.
- `src/config/providers.ts` — registry boundary between config and provider logic.
- `src/services/mcp/manager.ts` (`mcpManager`) — only place that owns MCP connections /
  transports / tool discovery; chat route merges `mcpManager.getAiTools()` into tools.
- `src/routes/mcp.ts` — `/api/mcp` REST boundary (Zod-validated); the browser's only
  window into MCP config/status.
- `web/src/components/McpPanel.tsx` + `web/src/stores/mcpStore.ts` — MCP GUI/state only;
  no MCP protocol code in the frontend.
- `src/lib/validation.ts` — all API input validation (Zod).
- `web/src/app/router.tsx` (`createHashRouter`) — only place that defines
  application surfaces (`/`, `/chat/:threadId?`, settings pages, `*` → `/`).
  The router owns pages, never message state. `web/src/app/layout/AppShell.tsx`
  — shell (sidebar + outlet) rendered inside the runtime provider.
  `web/src/features/chat/state/chatTabs.ts` — open/active tabs + `groupId`
  (UI state only, never messages). `web/src/config/navigation.ts` — labels,
  icons, routes, descriptions, order, visibility (single source of truth).
  Backend: `src/routes/index.ts` composes per-concern modules (`chat/tools/
  providers/conversations/memories/mcp/logs/scheduler`) — put new endpoints
  in the owning module, never back into index. One feature → one
  `web/src/features/<name>/` area; shared settings grammar lives in
  `web/src/components/shared/settings.tsx`. Only dependency rule: no second
  router/state-framework/UI-framework; record additions in `docs/decisions.md`.
- `src/services/scheduler/scheduler.ts` (`initScheduler`/`fireJob`/`scheduleJob`) — only place that owns
  scheduler timers (Bun.cron handles + one-time timeouts); SQLite is the source of truth, the timer map
  is an execution cache. `src/services/scheduler/schedulerStore.ts` — only job/run persistence
  (UNIQUE claim guard); `src/services/scheduler/cron.ts` — cron validation + tz-aware next-run;
  `src/services/scheduler/schedulerExecution.ts` — unattended execution (read-only tools run,
  destructive tools always refuse, no MCP tools in V1). `src/routes/scheduler.ts` — `/api/scheduler`
  REST boundary. Never add another scheduler library/service; never auto-approve tools for runs.
- `src/lib/prune-messages.ts` + `src/lib/model-messages.ts` — the only history
  repair/conversion path (`prepareModelMessages`). Tool-lifecycle states are
  load-bearing: approval decisions (requested/responded) must survive pruning
  until the conversation moves past them; never "simplify" the pruner to
  output-or-drop.
- `src/lib/logger.ts` (server) + `web/src/lib/logger.ts` (frontend) — the only
  logging entry points. Log through `logger.<level>(scope, event, fields)` with
  stable snake_case event names and structured fields; never `console.log`
  feature code, never log secrets/tokens/message text. Every request carries a
  `requestId` (AsyncLocalStorage) — include it when adding new boundaries.
  `AI_DEBUG_REQUESTS=true` enables sanitized outbound-request diagnostics.

## Testing before "done"

Typecheck → build → start → real AI request works → streaming works → errors handled
→ provider switching works (when applicable).

## Documentation

Maintain `docs/`: `architecture.md`, `development-rules.md`, `ai-integration.md`,
`provider-system.md`, `state-management.md`, `security.md`, `mcp.md`, `roadmap.md`,
`decisions.md`. Record architectural decisions in `docs/decisions.md`.

## How to make architectural changes

Propose in `docs/decisions.md` with the reason and alternatives considered. Keep the
project small; prefer removing unused code/dependencies over adding new ones.
