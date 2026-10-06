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
- **No decrypted secret is retained beyond the request that needed it.**
  `CredentialStore` re-reads the encrypted value and decrypts per request, so
  deletion or corruption cannot be hidden by an in-memory cache. Do not add a
  decrypted-key cache for latency; use a prepared statement and an index instead.
- Log/error output is redacted via `src/lib/redact.ts`.

## 4. Configuration-first

- Avoid hardcoded provider names, models, navigation, feature flags, UI dimensions,
  and application behavior.
- Use database / configuration-driven values wherever practical.
- Keep provider-specific code isolated behind the provider adapter/registry.
- **Tool UI copy is configuration-driven.** User-facing strings in TBAi-owned tool
  renderers (running labels, empty states, summaries, fallback cards) live in
  `web/src/config/tools.ts` (`toolsConfig.copy`). Renderers must consume this config
  rather than defining inline string literals. Dynamic values (queries, filenames,
  counts, results) remain parameterized. Third-party vendored assistant-ui elements
  (such as `web/src/components/assistant-ui/elements/web-search.tsx`) are left untouched.
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

- The suite has a documented baseline of **259 unique failing tests** from
  cross-file SQLite contention (all test files in a process share one database via
  `tests/setup.ts`). A failure in-suite is therefore not evidence of a regression.
  **Verify a suspected regression by running the single file in isolation** before
  believing or dismissing it. The known cause is `tests/unit/db.test.ts` opening
  that shared database three times concurrently.
- Because the gate cannot currently fail for the right reason, do not add a CI
  performance or size gate until the baseline is fixed — it inherits the same
  noise, and a gate that cries wolf gets disabled. See `performance.md`.

## 9. Performance

- **Measure before optimizing.** An unmeasured cost is a guess. Optimizing a
  subsystem that was already measured and found adequate is a defect, not
  diligence. Record real numbers in the subsystem's own doc, with the date and
  conditions.
- **Blocking I/O is a defect in a route handler and correct in a tool handler.**
  Route handlers must not block the event loop. Tool handlers are synchronous by
  contract so a read-modify-write cannot be interleaved by a client abort — do
  not "modernise" them to async, that introduces the race.
- **Bound the read, not the result.** A size cap applied after the allocation is
  not a cap. Stat first, or stream to the limit.
- No decrypted secret is retained beyond the request that needed it (see §3).
- Every other in-memory cache needs a bound, an eviction rule that actually
  executes, and a lifecycle clear path. A bare `Map` is a leak until proven
  otherwise. A cache keyed by an id needs a delete path.
- No second library for a problem something already installed solves — one
  virtualizer, one markdown pipeline, one diff renderer.
- Detail, budgets, and the current open findings live in `performance.md`.

## 10. Documentation

- Keep `docs/` current: `architecture.md`, `development-rules.md`,
  `performance.md`, `ai-integration.md`, `provider-system.md`,
  `state-management.md`, `security.md`, `roadmap.md`, `decisions.md`.
- `AGENTS.md` holds the permanent rules for future agents.
- Record important architectural decisions in `docs/decisions.md`.
