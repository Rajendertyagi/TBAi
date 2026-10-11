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

## Dependency / context integrity (learned 2026-09-15)

Before adding, upgrading, downgrading, pinning, or directly importing any
library that provides React context, runtime state, or provider infrastructure:

1. Inspect the existing dependency tree and installed versions.
2. Determine which package owns the canonical provider/context.
3. Prefer the public API exposed by the application's canonical top-level package.
4. Do not directly import lower-level/internal packages when doing so can create
   a second provider/context instance.
5. Do not solve dependency/context conflicts with Vite dedupe, overrides,
   aliases, or package churn unless the canonical package architecture
   explicitly requires it.
6. Never rely on undeclared transitive dependencies.
7. After dependency changes, perform a clean install and inspect the resolved
   dependency tree.
8. Verify that context-bearing packages have a single effective instance for
   the active application path.
9. Test the error/loading/provider paths, not only the normal happy path,
   because duplicate-context bugs may remain hidden until a conditional
   component mounts.
10. Keep isolated feature boundaries (e.g. OpenCode) from consuming the main
    application's context unless explicitly designed to share it.

### Mandatory acceptance rule

A dependency change is not complete merely because typecheck/build passes. It
must also prove: correct provider/context identity; clean install; no
unintended duplicate context instances; existing runtime/error paths still
work. When uncertain, STOP and audit first rather than repeatedly
adding/removing dependencies.

### Train freeze (2026-09-15)

The assistant-ui dependency train is frozen. No `@assistant-ui/*`
upgrade, downgrade, replacement, or independent re-resolution without an
explicit compatibility review and approval.

## Architecture boundaries

- `web/src/runtime.ts` — only place that wires the chat transport to `/api/chat`
  (sends the selected provider/model identifiers and transport metadata, never
  secrets or client model directives).
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
- OpenCode isolation boundary (service/feature, never inline):
  `src/services/opencode/` is the ONLY backend code that talks to the managed
  `opencode serve` process or the official `@opencode/client` — process
  ownership in `serverManager.ts`, session lifecycle in `sessions.ts`. The
  rest of the backend (chat route, workspace, tools, scheduler) never imports
  the client; the OpenCode module receives `conversationId` + the already-resolved
  dir via existing entry points (`resolveConversationWorkspace`).
  `web/src/features/opencode/` is the ONLY frontend code that imports
  `@opencode/client`; it owns the native V2 client, event reduction, history,
  permissions, forms, cancellation, and external-store controller.
  `ChatWindow.tsx`, the chat runtime, and all other UI never import the
  OpenCode client or feature internals — Code mode composes through the shared
  `mode="agent"` prop. New OpenCode capability (permissions, forms, models,
  agents) → new module under the owning `opencode/` dir, called through a small
  named function — never inline OpenCode logic in TBAi core files.
- `web/src/config/tools.ts` — single source of truth for TBAi-owned tool UI copy
  (running labels, empty states, summary notices, decisions). Individual tool
  renderers import copy from this module; vendored assistant-ui elements retain
  their upstream copy.

## Durable forward architecture

Agents MUST read `docs/architectural-principles.md` before making architectural
changes. It is the forward-looking contract for the system. Key non-negotiables:

- **TBAi is the orchestration/policy layer.** It owns application state,
  policy, workspace rules, conversation persistence, scheduler, provider
  configuration, security, and memory policy. It does **not** own infrastructure
  already solved well by assistant-ui, AI SDK, OpenCode, MCP, or ICM.
- **assistant-ui** owns chat UI primitives, runtime state, and the
  message/tool rendering contract. No second generic component framework, no
  universal custom tool-card framework.
- **AI SDK** owns Direct model execution, streaming, and the tool
  execution/continuation contract. No second streaming protocol, no
  application-owned message runtime.
- **OpenCode** owns coding-agent sessions/tools/execution behind the OpenCode
  feature boundary. Do not spread OpenCode wire-format assumptions through
  generic TBAi code.
- **MCP** uses the official `@modelcontextprotocol/sdk`. No hand-rolled
  JSON-RPC, no second MCP client.
- **ICM** is the durable shared memory engine, behind TBAi's `MemoryService`.
- **TBAi SQLite** remains authoritative for application state (conversations,
  messages, providers, workspaces, scheduler, settings). ICM's database is
  authoritative for memory; never merge the schemas.
- **UI is library-first.** Prefer official assistant-ui elements before custom
  renderers; a TBAi-specific renderer is justified only by a real capability
  gap. Execution stays with the backend/runtime — rendering never takes over
  execution.
- **Questions are forms, not approval cards.** A question routes through a
  QuestionForm and returns `answers[][]`; it must not use ApprovalGate,
  `respondToApproval`, or permission APIs. Permissions remain a separate
  allow/deny contract.
- **Provider/vendor protocols stay behind runtime or feature boundaries** (AI SDK,
  OpenCode, MCP).
- **No framework multiplication.** No second chat runtime, state framework,
  router, or MCP implementation.
- **Prefer deleting obsolete custom code** when upstream capability becomes
  sufficient; do not preserve custom architecture merely because it exists.

## Test location — hard rule

**Every test source file and every test-only asset lives under the root `tests/`
directory. Nothing else.** No test beside the code it covers, no fixture in
`src/`, no harness in `web/`.

This is enforced, not advisory:

- `bun run test:locations` fails on any test file or test-only asset outside
  `tests/`, including untracked files.
- It runs as a gate in the `verify` and `e2e` CI jobs.

The reason it must be a gate rather than a convention: every runner scopes
discovery to `tests/` — `bun run test` to `./tests/unit ./tests/integration`,
`test:dom` to `./tests/dom`, Playwright's `testDir` to `../tests/e2e`. A test
file written anywhere else is **collected by none of them**. It would not fail;
it would simply never run, and the suite would stay green while losing coverage.
Documentation alone cannot prevent that.

Structure is layer first, feature second: `tests/<layer>/<feature>/`. A test
that moved out of its source tree must resolve paths from the repository root
(`tests/helpers/repo-root`), never by counting parent directories from its own
location — see `tests/README.md`.

## Testing before "done"

Typecheck → build → start → real AI request works → streaming works → errors handled
→ provider switching works (when applicable).

## Documentation

Maintain `docs/`: `architecture.md`, `development-rules.md`, `ai-integration.md`,
`provider-system.md`, `state-management.md`, `security.md`, `mcp.md`, `roadmap.md`,
`decisions.md`, `performance.md`. Record architectural decisions in
`docs/decisions.md`.

`docs/performance.md` is the performance guideline: how to build software that stays
fast. Every rule is marked **Always** (correct by default, follow it while writing
code) or **Verify first** (real, but expensive and possibly unnecessary — measure
before committing to it). It contains no repo-specific facts by design, so it should
not need updating.

Two companion files are historical and are not guidance:

- `docs/performance-baseline.md` — the former guideline, preserved for its measurement
  trail and decision reasoning. Contains statements known to be out of date.
- `docs/TBAiPERFORMANCEAUDIT.md` — a superseded point-in-time source survey.

Read only the baseline to answer "why did we decide this?" Never execute anything from
it.

## How to make architectural changes

Propose in `docs/decisions.md` with the reason and alternatives considered. Keep the
project small; prefer removing unused code/dependencies over adding new ones.

Full contract: `docs/architectural-principles.md` (read it before making
architectural changes; see the "Durable forward architecture" section above for
the non-negotiable rules).

## Engineering standards — non-negotiable, every file touched, new or existing

### 1. No hardcoding

- Magic numbers, strings, URLs, paths, colors, timeouts, feature flags:
  none of them inline. Centralize into typed config/constants modules.
- Every repeated value gets a named constant or config entry the first
  time it appears a second time.
- If two places need the same value, that value lives in exactly one
  place and both import it.

### 1b. Styling standard (Tailwind v4 + theme tokens)

Established from the 2026-10-11 inline-style audit, which found **14** inline
style objects across `web/src` — of which **1** was a genuine duplication defect
and **13** were legitimate runtime or library contracts.

- **Static presentation lives in Tailwind utilities or CSS.** A fixed colour,
  width, height, spacing, position, or border belongs in a class or a
  stylesheet, not a `style={{}}` object.
- **Repeated or genuinely complex styling gets one owner.** A Tailwind v4
  `@utility`, a semantic class in `styles/globals.css`, or an existing shared
  component. Prefer the simplest option that fits the actual usage.
- **Theme tokens beat literal colours.** Use `bg-background`, `text-muted-foreground`,
  `border-border`, `bg-sidebar-accent` and friends. A hex literal in
  `web/src` is legitimate only when the colour IS the data — a user-selectable
  palette, a theme definition, or a value read back out of storage.
- **Runtime `style` props are allowed.** Do not read this section as a blanket
  ban. The following are correct and must not be "cleaned up":
  - measured geometry — virtualizer total size, row offsets, measured widths and
    heights (`VirtualizedTranscript`, `V2FormCard`, `surfaces`)
  - interactive transforms — drag positions, diagram zoom/pan
  - CSS custom properties carrying a runtime value (`--usage-width`)
  - caller-supplied `style` passthrough props (`shiki-highlighter`)
  - DOM-level styling a technique requires (`clipboard`'s off-screen textarea,
    a scroll lock during fullscreen)
- **A retained runtime style should be self-explanatory.** If the reason is not
  obvious from the code, say so in a comment. "Why is this inline?" should never
  require archaeology.
- **Shell geometry has one source of truth.** `lib/window-chrome.ts` holds the
  numbers, `lib/chrome-vars.ts` is the only module that turns them into CSS
  variables, and components consume `var(--sidebar-width)` and friends. Do not
  add widths, offsets or reserves anywhere else. `AppShell.tsx` composes chrome
  only; feature chrome belongs to its own component.

Enforcement: TypeScript plus the existing Biome gate. There is deliberately
**no custom lint rule** banning `style=` — a blanket rule would fail the
legitimate runtime cases above and would have to be suppressed at a dozen call
sites, which is worse than the problem it claims to solve.

### 2. Modular & layered

- Small, single-responsibility modules. No god-files, no 500-line components.
- Clear dependency direction: UI → store → service → data. No
  circular imports. No reaching across layers.
- Public API of each module is minimal. Internal helpers stay private
  (non-exported) unless genuinely reusable across modules.
- When you add a new feature, you add a new module. You do NOT
  append 200 lines to an existing "utils" or "index" file.

### 3. Standard practices

- Named exports over default (except components where the convention differs).
- Types are explicit at module boundaries. No `any`, no `as unknown as X`
  casts to silence the compiler.
- Error handling: catch at the boundary, surface a typed result or
  throw a domain error. No silent `catch {}` swallows.
- Tests: every new public function gets at least one happy-path +
  one edge-case test. Tests describe behavior, not implementation detail.
- Naming: descriptive, intent-revealing. `isEligible` not `flag2`.
  `getUserBy(id)` not `fn()`.

### 4. No hacks, no workarounds

- If you find yourself writing `// TODO: fix properly`, stop and
  fix it properly now.
- No `setTimeout` to "fix" a timing bug — fix the actual race.
- No `!important` to override a CSS layering mistake.
- No duplicating a function because "the other one almost did what
  I need" — refactor the shared primitive.
- No commenting out code to make tests pass. Delete it or fix the test.
- If a library does something "by accident" that you rely on,
  that's a bug waiting to happen. Pin the behavior explicitly or
  wrap it in your own module with tests.

### 5. Durable by default

- Code you write today should be readable by a new developer in 6
  months without asking you.
- Prefer boring, well-understood patterns over clever ones.
- If a solution requires 3+ lines of comment to explain WHY, the
  design is probably wrong — redesign instead.
- Every public function has a one-line doc comment: what it does,
  what it returns, what it throws.
- Configuration is externalized: env vars or a config file, not
  scattered `if` checks in component code.

### 6. Before you submit any change

- `git diff` — read it like you've never seen it before. Would a
  stranger understand it in one pass?
- If the diff adds more "fix this later" notes than it removes, it's not done.
- Run the full test suite. Report the actual numbers, not "should be fine."

### Definition of DONE (binding on every agent + the planner)

A phase is complete only when ALL hold:
1. Planner disk-review ACCEPTED (adapter shapes, route order, boundary
   greps for SDK/adapter leakage, no stale references).
2. `bun run typecheck` (backend + web) exit 0 AND `bun run build` exit 0,
   independently re-run — agent-reported green is not sufficient.
3. Test-agent suite numbers recorded (suite + case counts, actual numbers).
No commit/push until the end-to-end verification passes. Anything marked
complete without all three is in-progress with a named owner.

### Output when you're done with a task

- What you changed (files + one-line per file)
- What tests cover it (test file + case names)
- What you deliberately did NOT touch, and why
- Any assumption you made that I should confirm

### UI changes — extend surfaces, prove flows (learned 2026-09-15)

P1 built a new dialog that bypassed the existing welcome surface instead of
extending it. Never again:
- Every UI pack names the EXACT surface/component to extend. Creating a new
  dialog, page, route, or entry flow requires explicit maintainer approval —
  default is extend, never duplicate.
- Every UI report walks the user-visible flow step by step (entry → surface →
  creation → resulting route): what the user clicks, what renders, what gets
  created and when. Typecheck + build green is necessary but never sufficient
  for UI work.
- When mimicking a reference implementation (e.g. CodeG), the pack cites the
  exact file/lines embodying the pattern, and the planner verifies them on
  disk BEFORE the pack is issued — never from memory.
- Creation timing is a design decision, not an implementation detail: the
  pack states whether the conversation/row is created up-front or at first
  send, and the report confirms the flow matches.
- Behavior first, files second: the maintainer is not a coder. Every UI pack
  and every UI review leads with what the user clicks and sees, step by
  step, anchored to the reference app ("same as CodeG's new-chat tab, except
  an Engine row on top") — file lists come last. If it can't be described as
  visible behavior, it isn't specified clearly enough.

## Agent division of labor (applies alongside the standards above)

- Any agent can implement features, author test files, and run the test suite.
- The coding agent's "done" report still uses the Output format above, with
  the tests section stating the actual suite numbers where applicable, and its
  verification is `bun run typecheck` → `bun run build` with actual output.
