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

The **official `@modelcontextprotocol/*` packages** (client v2.3.1, server v2.3.1, core v2.3.1) are the
allowed MCP implementation (they provide the
wire protocol, transports, and notification schemas). Do **not** hand-roll JSON-RPC/MCP framing or
add a second MCP client library. AI SDK v7 `tool()` wraps discovered MCP tools for the model; the
`@ai-sdk/mcp` helper is intentionally not used (see `decisions.md`).

## 8. Testing before "done"

Before declaring a feature complete: typecheck, build, start the app, verify a real
AI request works, verify streaming works, verify errors are handled, and verify
provider switching works when applicable.

The mandatory gates and what each one catches are in **`docs/engineering-quality.md`**.
Run them all with `bun run verify`.

- The suite is **green** when all ten `bun run verify` gate steps exit 0
  (measured 2026-10-20 at `ci/tauri-e2e-verify`): typecheck, lint,
  `format:check`, `test:locations`, build, unit/integration
  (4320 pass / 43 skip / 0 fail across 319 files), the three isolated
  lifecycle suites, and the DOM contract suite (518 pass / 0 fail across
  50 files). `docs/engineering-quality.md` is the single owner of the gate
  definitions and the measured counts; this bullet points at it rather than
  duplicating numbers that drift. An earlier note here claimed a baseline of
  "259 unique failing tests" from cross-file SQLite contention; that is no
  longer true and was removed rather than left to mislead.
- **A failure in-suite is still not automatically a regression.** One test is
  timing-sensitive under full-suite load and fails intermittently on its own:
  `MCP lifecycle (Phase 4) > disconnectAll on a mid-connect connection` in
  `tests/integration/mcp/mcp-v2.test.ts`. Its cause is real — `connect()` in
  `src/services/mcp/manager.ts` promotes a connection to `"connected"` without
  checking it is still the current, still-connecting entry, so an interrupted
  connect resurrects a connection that `disconnectAll` just closed. **Verify a
  suspected regression by running the single file in isolation** before believing
  or dismissing it.
- **A second MCP timing failure, measured on 2026-10-22, and NOT a
  regression.** The cases in `tests/integration/mcp/connection-lifecycle-race.test.ts`
  that interrupt a connect mid-handshake — *a connect interrupted by disconnect
  stays disconnected*, *an interrupted connect schedules no reconnect*, *a
  connect interrupted during the SSE probe does not reach connected*, and *a
  superseded attempt is abandoned and does not overwrite the newer one* — time
  out at **exactly 5000 ms** when the MCP integration directory is run
  **without the repository's `--timeout=30000`**. The cause is measured, not
  guessed:
  - The MCP SDK leaves `client.connect()` **pending** after `close()` (the
    test's own comment at `connection-lifecycle-race.test.ts:223` says so), so
    the interrupted attempt never settles.
  - `disconnectAll` therefore waits its full bound,
    `INFLIGHT_SETTLE_TIMEOUT_MS = 5000` (`src/services/mcp/manager.ts:85`).
  - Only one case in that file declares a timeout (`30000`). The rest inherit
    bun's **5000 ms default**, which is exactly that bound — so a
    `disconnectAll` that is *supposed* to take its whole bound is killed by the
    harness one millisecond before it finishes. Declaring `30000` on the
    affected case makes it pass (verified).
  - The child fixture is **not** the problem: its `requested` marker appears in
    **113 ms** (measured), so the handshake boundary is reached well inside the
    budget.
  - The fix is the **timeout declaration**, not the production bound: the
    production constant is load-bearing — it is what bounds a shutdown — and
    lowering it to fit a test would weaken the guarantee it exists to provide.
  - **It is pre-existing.** The same failures reproduce at commit `7de8555`
    (before the OpenCode runtime-remediation work), in a clean worktree, with
    the same 5000 ms signature: 3 fail at the base commit, 2-3 fail with the
    remediation applied.
  - **The repository's own gate does not hit it**: `bun run test` carries
    `--timeout=30000`, and with it the MCP integration directory is **49 pass /
    0 fail**. The failure appears only when the directory is run bare, which is
    why a single-file run under the default timeout is a misleading signal
    about this file.
- **A CI failure in the MCP area is not evidence of a regression in the change
  on the branch.** The CI run of `75ec732` failed with **1** failure — `F3 -
  unexpected session/transport loss > transitions to error and reconnects when
  transport closes unexpectedly` (**5790.68 ms**) — in a file that none of that
  commit's 14 changed files touch. The same case **passes** in isolation, under
  the whole-directory load, and on the next commit's CI run, which was green.
  The arithmetic points at one assertion. The case's first poll waits for the
  `connect outcome=error` log entry on a budget of **50 × 100 ms = 5000 ms**
  (`mcp-v2.test.ts:200`), and that entry is only emitted when the child's
  `close` event arrives — SIGTERM, to the child's death, to the transport's
  close. A **5790 ms** total is that budget **exhausted**: ≈790 ms of setup,
  then the full 5000 ms of polling, and the assertion at
  `mcp-v2.test.ts:213` (`expect(errorLogs.length).toBeGreaterThanOrEqual(1)`)
  failed. The number is also exactly where the *reconnect* would fire — the
  manager arms it 5000 ms after the kill — so on the CI runner the child's
  teardown was delivered **later than the reconnect delay**, and the poll gave
  up at the same instant the retry landed. Locally the same case delivers the
  error log immediately and the reconnect 5000 ms later, which is the
  timeline the test was written against. **The delivery delay itself has not
  been reproduced on a loaded runner here**, so this is recorded as a known
  flake with its arithmetic, not as a diagnosis. Verify a suspected MCP
  regression by running the single file under `bun run test`'s own timeout,
  not bare.
- **A test must not bind a port the application may be on.** On 2026-10-22
  `tests/integration/server/port-configurability.test.ts` restarted onto
  **3030**, which was held by a TBAi instance the maintainer was running
  outside the repository, so the full suite failed on a machine where the
  product worked. The number was never a product fact — the default is
  **3000** (`src/services/server-port.ts`) — it was a hardcoded fixture. The
  test now asks the OS for free ports (`Bun.serve({ port: 0 })`, several
  reserved at once so they cannot be handed the same number) and releases them
  before binding. A test's sockets come from the machine, never from the
  application's neighbourhood: the suite must pass while the real app is
  running.
- Because the gate can currently fail for the wrong reason (above), do not add a CI
  performance or size gate until that is fixed — it inherits the same noise, and a
  gate that cries wolf gets disabled. See `performance.md`.

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
