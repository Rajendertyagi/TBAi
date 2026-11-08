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
- MCP client: official `@modelcontextprotocol/*` packages (client v2.3.1, core v2.3.1) + AI SDK v7 `tool()`
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
- `web/src/features/mcp/components/McpPanel.tsx` + `web/src/features/mcp/state/mcpStore.ts`
  — MCP GUI/state only; no MCP protocol code in the frontend.
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
  `web/src/features/opencode/` is the ONLY frontend code that depends on
  `@opencode/client` at runtime (one type-only import of `ToolContent` lives in
  `web/src/tools/opencode/adapt.ts`); it owns the native V2 client, event
  reduction, history, permissions, forms, cancellation, and external-store
  controller.
  `ChatWindow.tsx`, the chat runtime, and all other UI never import the
  OpenCode client or feature internals — Code mode composes through the shared
  `mode="agent"` prop. New OpenCode capability (permissions, forms, models,
  agents) → new module under the owning `opencode/` dir, called through a small
  named function — never inline OpenCode logic in TBAi core files.
- `web/src/config/tools.ts` — single source of truth for TBAi-owned tool UI copy
  (running labels, empty states, summary notices, decisions). Individual tool
  renderers import copy from this module; vendored assistant-ui elements retain
  their upstream copy.

## File ownership — mandatory

Ownership is decided by **what the code is about**, never by convenience. Every
new file has exactly one owning directory. Putting something in a shared
directory because that directory already exists is a defect, not a shortcut.

### Frontend (`web/src/`)

| Directory | Owns |
|---|---|
| `app/` | Application composition: routing, shell integration, application-level wiring. Never message, thread, or tool state. |
| `features/<feature>/` | Everything specific to one feature: UI, state/stores, hooks, types, API clients, request logic, feature config. |
| `components/` | Genuinely shared UI: reusable primitives and cross-feature components. Not feature UI parked in a shared folder. |
| `lib/`, `config/` | Genuinely shared utilities and shared configuration. Not feature code placed there for convenience. |
| `adapters/` | The HTTP bridge to assistant-ui runtime contracts (`RemoteThreadListAdapter`, `ThreadHistoryAdapter`). |
| `tools/` | TBAi-owned tool UI metadata and rendering glue, grouped per tool engine in `tools/<engine>/`. |

- Feature-specific code must not be added to `components/`, `lib/`, or `config/`.
- Cross-feature sharing needs a stated justification and an owner that is not one
  of the two features. If no such owner exists, the code stays duplicated until
  one does.
- There is no shared `web/src/stores/`. A store whose subject is one feature
  belongs in that feature's `state/`.
- **`web/src/tools/<engine>/` is grouped by tool engine, not left as a shared
  bin.** The engine subdirectories are `browser/`, `computer/`, `filesystem/`,
  `opencode/`, `scheduler/`, and `todo/`; each is owned by that engine, and new
  tool rendering joins the matching engine's directory. This is tool rendering,
  not feature state: feature UI, stores, hooks, and types belong in
  `web/src/features/<feature>/`. `tools/opencode/` is the frontend's OpenCode
  tool-UI owner, which is why it may hold a type-only `@opencode/client` import.
- **The Direct/OpenCode split is a runtime boundary, not a preference.**
  `web/src/features/opencode/` is the only frontend code that depends on
  `@opencode/client` at runtime; the single exception is a type-only import of
  `ToolContent` in `web/src/tools/opencode/adapt.ts`. `ChatWindow.tsx`,
  `Composer.tsx`, `runtime.ts`, and the rest of the shared UI stay
  engine-neutral and compose through the `mode="chat" | "agent"` prop. Do not
  merge the two runtimes, and do not let OpenCode-only capability (Shield,
  permissions, forms, terminal, diff) leak into Direct Chat. See **Durable
  forward architecture** below.

### Backend (`src/`)

| Directory | Owns |
|---|---|
| `routes/` | The HTTP boundary: request handling, validation, status codes, response shaping. No domain logic. |
| `services/` | Business logic, orchestration, domain behavior. No HTTP concerns. |
| `db/` | Database connections, schema/DDL, row mappers. |
| `lib/` | Cross-cutting pure helpers: logger, validation schemas, message pruning/conversion. |
| `tools/` | Native AI SDK `tool()` definitions and their Zod schemas. It declares tools; it does not run them. |
| `context/`, `config/` | Context-window assembly and configuration registries consumed by services. |

The intended dependency direction is **`routes → services → database`**, one way.

- **Tool declaration and tool execution have separate owners.** `src/tools/`
  holds the `tool()` definitions; `src/services/tools.ts` executes them,
  consumes grants, and confines **path arguments** to the conversation
  workspace root. `runBash` confines only its starting directory — the command
  body runs with the server's own privileges. **Do not describe shell execution
  as sandboxed**; `src/services/tools.ts` states this in its own header.
- The database layer must never import from `routes/` or from `services/`. If a
  persistence helper needs domain behavior, that behavior moves up into
  `services/`. A route may reference a `db/schema/*` type (`import type`), which
  creates no runtime edge — but any value-level or runtime dependency from a
  route straight into `db/` needs a stated reason.
- Persistence helpers and domain modules have explicit owners. A module that
  accumulates unrelated aggregates gets split along them, keeping a barrel that
  preserves existing import paths — as `services/storage/` was split into
  `conversations.ts` / `messages.ts` / `memories.ts`.
- Reorganizing modules must preserve lifecycle ordering, transactions, external
  contracts, and runtime behavior. A structural move that changes behavior is a
  different task and needs explicit authorization.

### Tests and supporting files

- Every test source and test-only asset lives under `tests/`. That rule is
  enforced by `bun run test:locations`; see **Test location — hard rule** below.
  Do not restate it here — follow it.
- Scripts belong in `scripts/`, documentation in `docs/`.
- Temporary, generated, and scratch artifacts do not belong in the repository
  root and must never be committed. Bundles, logs, patches, and evidence go
  outside the repository.
- Before relocating production code or a test, enumerate **every** consumer:
  static importers, **dynamic** `import()`, source-text guards that match the
  file's text, path strings in configuration, docs that name the path, and CI or
  Playwright config. A move that updates only the obvious importers is
  incomplete.

## Change workflow — mandatory checklist

Applies to file additions, moves, extractions, splits, and feature work.

1. **Inspect first.** Read the tree, this file, the relevant `docs/` architecture
   pages, and one or two comparable existing modules. Match their shape instead
   of inventing a new one.
2. **Name the owner.** Decide which feature or architectural layer owns the
   responsibility, and state it, before creating the file.
3. **Extend before adding.** Prefer extending the correct existing module over
   creating a competing implementation, a parallel abstraction, or a second
   helper that almost does what you need.
4. **Place it correctly.** Every new file goes in its owning directory, with a
   one-line purpose.
5. **Enumerate consumers before moving anything.** See the relocation rule
   above; dynamic imports and source-text guards are the ones that get missed.
6. **Preserve contracts.** Public APIs, wire formats, persistence schemas,
   lifecycle ordering, and runtime behavior stay as-is unless the task explicitly
   authorizes a change.
7. **Verify.** Read the complete diff, then run typecheck, lint, format check,
   and the affected tests. Report real exit codes and real counts.
8. **Report.** List every file created, moved, split, or removed; give each an
   owner; and state any unresolved architectural exception.

Ordinary file creation does **not** require prior approval. These operations must
be surfaced explicitly, with written rationale, **before** implementation:

- changing an architectural boundary (a new top-level ownership area or shared
  directory);
- merging previously isolated runtimes — Direct Chat and OpenCode especially;
- reversing the `routes → services → db` dependency direction;
- changing a persistent data contract (schema, column, or migration).

## Maintainability protocol

Written 2026-10-13 from a full-tree audit, and every number in it is measured
against this repository rather than asserted. The rules exist because of
specific defects that were found here — each rule names the evidence, so a
future agent can tell which parts are load-bearing and which are guidance.

Ownership and dependency rules live in `docs/architecture.md` (§File ownership)
and are not restated here. This section covers *how to work*, not *where things
live*.

### 1. File size and complexity — a review trigger, never a gate

Measured distribution of the 844 TypeScript files under `src/`, `web/src/`,
`tests/` and `scripts/`:

| Lines | Files |
|---|---|
| ≤ 250 | **611** |
| 251–500 | 156 |
| 501–800 | 51 |
| 801–1200 | 24 |
| > 1200 | 2 |

This tree is already well-factored. **Do not add a line-count lint rule and do
not split a file because it is long.** A gate that fires on a quarter of the
tree trains people to ignore it, and §6b rule 8 says a gate must be able to
fail — a gate nobody can satisfy is a gate nobody trusts.

Review is triggered by two conditions, and both must hold:

- **Size**: a single function over ~400 lines, or a module over ~1000 lines.
- **Consequence**: the file has no automated test that would fail if a
  behaviour changed during the split.

The largest components by single-function length are
`scheduler/components/JobEditor.tsx` (837), `components/LogsPanel.tsx` (751),
`components/Composer.tsx` (695) and `providers/ProviderDialog.tsx` (560). **All
four are deferred, not fixed**, because none has DOM coverage: splitting them
cannot be shown to preserve behaviour, and "it still compiles" is not evidence.
The correct next step for any of them is characterization tests first, then the
split. By contrast `services/mcp/manager.ts` (1258) and
`context/compaction/contract.ts` (1028) are **retained deliberately**: both are
single-owner modules with explicit section markers, and splitting a generation-
guarded singleton's methods across files would add indirection and risk exactly
the class of regression that its recent history had to repair.

### 2. Single responsibility and ownership

Decide the owner from *what the code is about* before writing it, and say so in
the report. "Extend the existing module" beats adding a second helper that
almost does the same thing.

**Moving logic between layers needs written justification.** The direction rules
in `docs/architecture.md` are load-bearing, and this audit found real debt
against them which is **recorded and deferred, not silently fixed**: raw SQL and
business rules still live in `src/routes/{memories,providers}.ts`, an
idempotency state machine with module-level mutable state lives in
`src/routes/conversations.ts`, `src/lib/resumable.ts` imports both `../db` and a
service subtree, and Zod schemas for HTTP input are declared outside
`src/lib/validation.ts` in `routes/{opencode,mcp,tools}.ts`. Each is a
`routes → services` extraction that changes where logic lives and what owns the
SQLite handle. That is a separate, authorized piece of work — do not fold it
into a cleanup.

The frontend has the same shape of debt, also deferred: `components/LogsPanel.tsx`
(1047 lines) is a whole feature with no owning `features/logs/`,
`components/ElicitationModal.tsx` and `components/Sidebar.tsx` import from
`features/`, and `features/chat/directCompactEntries.ts` imports from
`features/opencode`. Relocating these changes the public surface of three
features at once.

### 3. Duplication and abstractions

**Prove duplication before consolidating.** Two helpers that look alike are not
duplicates until their semantics match. Checked and deliberately left alone:
`formatDuration` in `tools/elapsed.tsx` vs `features/scheduler/lib/scheduler-format.ts`
(different output formats by documented decision); `formatRelativeTime` in
`lib/utils.ts` vs `formatRelative` in the scheduler formatter (past-absolute vs
forward-relative); the vendored assistant-ui `utils/range.ts`. Conflating these
would have been a regression dressed as a cleanup.

**A shared helper needs a second real caller.** See
`docs/architecture.md` §Shared helpers, and what makes one dead.

**When a value must live in one place, delete the others in the same change.**
The `aui-disclosure-timing` failure mode is in §1b: an abstraction added *beside*
the duplication it claims to remove is worse than no abstraction, because it
reads as solved.

### 4. Dead code

Three whole modules and a duplicated constant were removed in the 2026-10-13
audit, and a fourth (a barrel) with them. The rule now has a gate:
**`tests/unit/tooling/no-orphan-modules.test.ts` fails when a source module in
`src/` or `web/src/` has zero recognized direct inbound references.**

That is the whole claim, and it is weaker than "unreachable": a dead module that
imports another dead module leaves the second one with a reference, so it passes.
The known limits live in the test's header — do not restate it as a reachability
proof.

The scan reads code and string data separately, so a commented-out import, a
`{@link import("../x")}` inside JSDoc, and an `import("./thing")` written as test
fixture data are not counted as references. Aliases come from the `paths` maps in
the tsconfig files, and are resolved against the **importing file's own project
first** — `@/` means `web/src/*` in a web file and `src/*` in a backend file, so
a web import is never credited to a backend module of the same name.

**Scan scope is four trees: `src`, `web/src`, `tests`, `scripts`.** The first two
are the subjects; the other two are read only for references. **Configuration
files are outside it** — `vite.config.ts`, `web/playwright.config.ts`,
`biome.jsonc` and `package.json` are never read as importers (the tsconfigs are
read only for their `paths` maps). A module referenced only from a configuration
file would therefore be reported as an orphan. No such module exists today, so
that is currently true rather than enforced. Do not describe this gate as
comprehensive.

**When the scan cannot read a file — a non-literal dynamic `import(...)`, or an
alias that resolves nowhere — the suite FAILS and names the file**, rather than
reporting an orphan verdict derived from an incomplete view. Its single allowed
orphan must keep carrying the sentence that explains why it is kept.

Unused *exports* are deliberately **not** gated. The set is large and several
entries are intentional (`features/opencode/v2Tools.ts` is a documented
test-only drift guard; `components/assistant-ui/elements/approval-card.tsx` is
asserted dead on purpose). The manual criterion: **before you add an export,
confirm something imports it**; an export nothing imports is either dead or a
signal that the owner is wrong.

### 5. Testing and behavior preservation

- A structural change needs a test that **would have failed before it**. Write
  or identify that test first; if none exists, write characterization tests
  first and defer the refactor. This is why §1 defers four large components.
- **Prove a guard can fail.** Make the defect, run the test, watch it fail,
  revert. Two guards added in this audit were verified this way, and one of them
  caught a real error in its own first draft — it matched the *consumers* of
  `--animation-duration` instead of the setter, and passed while the defect was
  present. A guard never exercised against its defect is a comment.
- Assert the **invariant, not the layout**: match the dependency, not the
  formatter's line wrapping.

### 6. Change isolation

- **One diff, one concern.** Do not bundle unrelated changes because they touch
  the same file. If a cleanup exposes a functional defect, record it separately
  and report it — do not fix it in passing.
- **Pre-existing findings are named, not absorbed.** A failure that exists at the
  base commit is classified as pre-existing and reported with the base numbers
  beside the new ones. Never make a red gate green by deleting or relaxing a
  test.
- **Never touch another contributor's uncommitted work.** Run `git status` and
  `git log` first; do this class of work in its own worktree.
- Report real numbers: exit codes, pass/fail/skip counts, and what you skipped.

### 7. Exceptions

An intentional deviation is acceptable when it states the owning layer, the
dependency consequence, and why the standard placement is inappropriate. It is
recorded in `docs/decisions.md` and disclosed in the report — never introduced
silently.

Two enforceable exceptions exist and both are self-checking:
`no-orphan-modules.test.ts`'s allowed-orphan list (each entry must still carry
its stated reason), and the Biome `files.includes` exclusions in `biome.jsonc`
(each carries a comment saying why it is off). If you widen either, you are
making a decision, not adding a suppression.

## Exceptions and enforcement

- Follow existing repository convention where it does not conflict with these
  rules. Where it does conflict, these rules win and the convention changes.
- **Do not move files to make the tree look tidy.** Shared ownership and runtime
  boundaries matter more than visual uniformity. A file in an odd-looking place
  with a clear single owner beats a cosmetically uniform tree with ambiguous
  ownership.
- When a genuine exception is necessary, record the owning layer, the dependency
  consequences, and why the standard placement is inappropriate.
- Agents must **disclose** violations and unresolved exceptions in their report
  rather than introducing them silently.
- These rules apply to features, bug fixes, refactors, tests, and maintenance —
  not only to newly created features.

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
- **MCP** uses the official `@modelcontextprotocol/*` packages (client v2.3.1, core v2.3.1). No hand-rolled
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

Maintain `docs/`: `architecture.md`, `development-rules.md`, `engineering-quality.md`,
`ai-integration.md`, `provider-system.md`, `state-management.md`, `security.md`,
`mcp.md`, `roadmap.md`, `decisions.md`, `performance.md`. Record architectural
decisions in `docs/decisions.md`.

`docs/engineering-quality.md` defines the mandatory local and CI checks and is the
executable form of the rules in §6b. Keep it accurate: if a gate changes, that file
changes in the same commit.

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

- `docs/2026-10-12-biome-suppression-inventory.md` — point-in-time inventory of all
  44 `biome-ignore` suppression sites (41 raw line + 3 range pairs), verified
  against source on 2026-10-12. Re-verify before trusting it; it is a snapshot,
  not a live gate.

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

Re-audited 2026-10-13 against the current tree. `web/src` holds **12** inline
style objects and 16 `style` bindings in total, down from 15 and 19: the three
that were removed were identical copies of one value. **Every remaining one is a
legitimate runtime or library contract** — measured geometry, an interactive
transform, a CSS custom property carrying a computed value, a caller-supplied
passthrough, or a colour that *is* the data.

- **Static presentation lives in Tailwind utilities or CSS.** A fixed colour,
  width, height, spacing, position, or border belongs in a class or a
  stylesheet, not a `style={{}}` object.
- **Repeated or genuinely complex styling gets one owner.** A Tailwind v4
  `@utility`, a semantic class in `styles/globals.css`, or an existing shared
  component. Prefer the simplest option that fits the actual usage.
- **Centralising a value is not done until every old copy is deleted.** The
  `aui-disclosure-timing` utility existed with a comment explaining that it had
  replaced six copies of `200` — while every copy was still there. An
  abstraction introduced *beside* the duplication it claims to remove is worse
  than none: it reads as solved. When you centralise, remove the originals, and
  prove it with a test rather than a comment. See
  `tests/unit/web/components/disclosure-timing.test.ts`, which fails if the CSS
  half and the JS half drift apart.
  **Count before you write the number.** An earlier version of this rule
  repeated that comment's "six" verbatim and called it a "six-file edit". The
  literal actually appeared in **four** places: three
  `ANIMATION_DURATION = 200` constants (`reasoning`, `tool-group`,
  `tool-fallback`) plus the stylesheet's `--animation-duration`. The three
  inline `style` props never contained the literal — they interpolated the
  constant — so they were specification *sites*, not copies. The original "six"
  counted three declarations plus three style props; it was a valid count of
  something else, and it was never a count of copies.
- **Where two halves of one value genuinely cannot merge, pin them.** CSS cannot
  read a TS constant, and TS cannot read a custom property at module scope, so
  the disclosure duration is one literal in the stylesheet and one in
  `components/shared/disclosure-timing.ts`. That is acceptable only because a
  test fails the moment they disagree.
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
  only; feature chrome belongs to its own component. If a token and a literal
  state the same number, derive the literal from the token rather than repeating
  it.

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

### 6b. Quality gates — the enforceable rules

**`docs/engineering-quality.md` is the executable form of this section.** Read it
before starting work; it lists every mandatory check, what each one catches, and how
each is enforced in CI. Run them all with `bun run verify`.

These are gates, not recommendations. Each one is enforced by a CI step, and
several of them are traps that have already been fallen into in this repository:

1. **No feature implementation until the required quality gates pass.** A red gate
   is the next piece of work, not a follow-up.
2. **Read-only investigation before modifying unfamiliar or concurrently-changed
   work.** `git status`, `git log`, and the file itself. Another agent's in-flight
   changes are not yours to overwrite, and formatting a file mid-edit destroys the
   edit.
3. **A reproducible defect or a clear requirement precedes a production change.**
4. **Tests cover meaningful behaviour**, including failure paths and how features
   interact — not just the happy path.
5. **Root-cause fixes.** No suppression, no arbitrary retries, no weakened
   assertion standing in for a fix. If the honest answer is "the rule is wrong
   here", the suppression must state why.
6. **Never delete a test to make a check pass.** Deletion is only correct with
   evidence that the test is obsolete, duplicated, invalid, or superseded, and that
   evidence goes in the commit message.
7. **Never weaken TypeScript or lint settings to get a green check.** No `any`, no
   `as unknown as`, no `@ts-ignore`/`@ts-nocheck`, no relaxing `strict`, no adding a
   file to an `exclude` list, and no downgrading a lint rule to `warn`. `bun run
   lint` runs with `--error-on-warnings` precisely so this cannot be done quietly.
8. **A gate must be able to fail.** A check whose reported result and exit code
   disagree is broken, not noisy. This is not hypothetical: `biome check` once
   exited 0 while reporting 30 warnings, so the CI lint step passed having checked
   nothing.
9. **A test that passes intermittently hides a real race.** Find the race; do not
   retune the timing. One such test is currently known and documented in
   `docs/development-rules.md` §8.
10. **Review the full diff** for unintended changes and regressions.
11. **Report exact commands and real results**, including every skip and every
    unresolved failure.
12. **Compilation, or a passing test count, is not completion.**

Two further traps, both specific to this repository's tooling:

- **A suppression comment is anchored to the expression on the next line.** If a
  formatter re-wraps that expression, the suppression silently detaches and the rule
  starts reporting again. Use a range suppression (`biome-ignore-start` /
  `-end`) whenever the formatter can move the line.
- **Source-text guards must assert the invariant, not the layout.** Many tests here
  match the text of a source file. A pattern that also pins the line wrapping will
  fail the next time the formatter runs, for a contract that never changed. When you
  change such a guard, make the defect, confirm the test fails, then revert — a
  guard that cannot fail is worse than none.

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
