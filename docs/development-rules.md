# Development Rules

These rules are permanent. They are also summarized in `/AGENTS.md`.

## 1. Minimum custom code

Before writing custom functionality, check whether it already exists in:
`@assistant-ui/react`, `@assistant-ui/ai-sdk`, AI SDK v7, shadcn/ui, Radix,
Hono, or the standard library. Prefer the library implementation.

Do **not** recreate:
- chat message state
- streaming transport
- message rendering
- tool-call UI
- basic chat runtime behavior
- standard UI primitives

## 2. Library-first

The AI/chat stack is fixed:
- **AI SDK v7** is the primary AI layer (`streamText`, `convertToModelMessages`,
  `toUIMessageStreamResponse`).
- **@assistant-ui/react** + **@assistant-ui/ai-sdk** for chat UI and runtime.
- No second custom streaming protocol unless technically required, and only after
  documenting why.

## 3. Security

- Never expose provider API keys to the browser. `GET /api/providers` returns only
  metadata + `credentialConfigured`; it never returns a key or ciphertext.
- Provider secrets are encrypted at rest (AES-256-GCM under a local per-install DEK in
  `src/services/credentials.ts`). The browser only ever sends a `providerId`.
- No master password, unlock screen, or login. No OS keychain / credential-manager
  dependency. No `.env` required for normal use. This is a deliberate portability/
  convenience trade-off for a personal-use app (see `security.md` threat model).
- All crypto is isolated in `CredentialStore`; do not add encryption logic to routes,
  providers, or UI.
- **MCP auth tokens** follow the same rule: stored encrypted at rest (`mcp_servers.auth_token`
  via `encryptSecret`), never returned to the browser — only `auth_type` is echoed. See `mcp.md`.
- MCP tools are **server-executed** (the MCP `Client` lives in the backend); the browser only
  drives config/status over `/api/mcp`. Do not connect to MCP servers from frontend code.
- Validate **all** API input with Zod (`src/lib/validation.ts`).
- Do not store secrets in client state. The frontend `ProviderConfig`/`McpServerConfig` types have
  no `apiKey`/`authToken` field; secrets never reach `localStorage`/Zustand.
- Log/error output is redacted via `src/lib/redact.ts`.

## 4. Configuration-first

- Avoid hardcoded provider names, models, navigation, feature flags, UI dimensions,
  and application behavior.
- Use database / configuration-driven values wherever practical.
- Keep provider-specific code isolated behind the provider adapter/registry.
- **Navigation is configuration-driven.** All navigation items (labels, icons,
  badges, target views/routes, children, ordering, visibility) and branding strings
  live in `web/src/config/navigation.ts` as the single source of truth. Components
  such as `Sidebar`/`App` must consume this config and must **not** contain
  hardcoded navigation definitions. Adding, removing, reordering, hiding, renaming,
  or flagging a navigation item is done in that config file only — never by editing
  the component. Optional items are gated by feature flags in the same config.

## 5. State management

- **SQLite / bun:sqlite** → persistent data (providers, conversations, messages, memories).
- **assistant-ui runtime** → owns conversation/message/thread state. Conversation history
  is persisted through assistant-ui's native thread architecture
  (`RemoteThreadListRuntime` + `RemoteThreadListAdapter` + `ThreadHistoryAdapter`), not a
  custom store. Do **not** reintroduce a second Zustand conversation/message store — that
  duplicates state the runtime already manages.
- **Zustand** → shared client/UI state that genuinely needs to be shared (settings, memory
  list, active view). It is **not** the persistence layer and must not hold conversation or
  message data.
- **React local state** → component-local state.

## 6. Memory separation

- conversation history, persistent user memory, and temporary UI state are separate.
- Do not claim "memory" is implemented until it is actually retrieved and supplied
  to the model during relevant conversations.

## 7. Keep the project small

Do **not** add: LangChain, LangGraph, Mastra, Redis, PostgreSQL, Docker, or
unnecessary agent frameworks / abstractions. Add a dependency only with a clear
technical reason, recorded in `docs/decisions.md`.

The **official `@modelcontextprotocol/sdk`** is the allowed MCP implementation (it provides the
wire protocol, transports, and notification schemas). Do **not** hand-roll JSON-RPC/MCP framing or
add a second MCP client library. AI SDK v7 `tool()` wraps discovered MCP tools for the model; the
`@ai-sdk/mcp` helper is intentionally not used (see `decisions.md`).

## 8. Testing before "done"

Before declaring a feature complete: typecheck, build, start the app, verify a real
AI request works, verify streaming works, verify errors are handled, and verify
provider switching works when applicable.

## 9. Documentation

- Keep `docs/` current: `architecture.md`, `development-rules.md`,
  `ai-integration.md`, `provider-system.md`, `state-management.md`, `security.md`,
  `roadmap.md`, `decisions.md`.
- `AGENTS.md` holds the permanent rules for future agents.
- Record important architectural decisions in `docs/decisions.md`.
