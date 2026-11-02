# TBAi Architecture Audit Report
*Audit date: 2026-11-02. Updated same day with durability/robustness findings from deeper code pass.*
*Read from production code only — no docs consulted during investigation.*

---

## Executive Summary

This is a **well-engineered, non-trivial desktop AI chat app** built with a deliberately small dependency surface. The core architecture is sound. Streaming, credentials, MCP, compaction, and scheduler patterns are all above average for a project of this size. There are real durability gaps — some are known and deferred, and **six are active robustness risks** identified by tracing code paths, not assumptions.

**Overall Grade: B+** — Excellent fundamentals. The streaming/resumable/compaction design is genuinely sophisticated. Six concrete robustness issues need action, with one (#1) being the most impactful incomplete feature in the codebase.

---

## Stack Verified From Code

| Layer | What's Actually Installed |
|---|---|
| Runtime | Bun (native SQLite, native HTTP) |
| Backend Framework | Hono 4.13 |
| AI SDK | `ai@7.0.145` — AI SDK v7 ✅ |
| Chat UI | `@assistant-ui/react@^0.15.30` + `@assistant-ui/ai-sdk@^0.0.14` ✅ |
| Frontend | React 19 + Vite + Tailwind v4 ✅ |
| State | Zustand (UI only, correctly scoped) ✅ |
| Validation | Zod v4 (thorough, on all routes) ✅ |
| MCP | `@modelcontextprotocol/client@2.3.1` + `@modelcontextprotocol/core@2.3.1` ✅ |
| Crypto | `@noble/ciphers` (AES-256-GCM) ✅ |
| Desktop shell | Tauri v2 |

---

## Architecture: What Works Well

### ✅ 1. Security — API Keys Never Reach the Browser
**Verified in:** `src/services/credentials.ts`, `web/src/runtime.ts`

- AES-256-GCM with a random per-install DEK stored in SQLite
- Browser sends only `providerId`, never the key
- MCP auth tokens follow the same encryption path
- `credentialStore.get(providerId)` is the single decryption point
- Trade-off (DEK co-located with ciphertext) is explicitly documented in `docs/security.md`

### ✅ 2. Streaming + Resumable Runs
**Verified in:** `src/lib/resumable.ts`, `src/routes/chat/index.ts`

- Resumable stream context backed by SQLite (`createSqliteResumableStreamStore`), not in-memory
- `APP_BOOT_ID` generation tag: a resumed row from a dead boot is distinguishable from a live one
- Three endpoints: `POST /api/chat`, `GET /api/chat/resume/:streamId`, `GET /api/chat/stream-status`
- Client recovery is keyed on `conversationId`, not the transport-owned stream pointer — correctly handles the case where the AI SDK clears the pointer before the error fires (observed in production, documented in source comments)
- Wall-clock timeout path correctly preserves `timedOut` state before `controller.abort()`

### ✅ 3. Chat Route Phase Architecture
**Verified in:** `src/routes/chat/index.ts`

Five well-separated phases:
1. **P1** — Validate & resolve (provider, model, messages)
2. **P2** — Create run + assemble context
3. **P3** — Gate assembled context (budget ceiling, overflow check)
4. **P4+P5** — Execute direct stream + durable settlement

The `streamWriter` holder pattern (shared between terminal output tap and the stream phase) is a deliberate, documented design choice to prevent split-stream bugs when two taps write to one batcher. The comment at line 64 explains why a plain `let` would silently drop all terminal output.

### ✅ 4. Provider Model is Correctly Abstracted
**Verified in:** `src/services/ai.ts`, `src/config/providers.ts`

- `getModel()` is the single mapping boundary: provider type → AI SDK factory
- `usesOpenAICompatibleModel()` correctly routes reasoning-content providers (DeepSeek/Qwen-style) through `@ai-sdk/openai-compatible` to preserve `reasoning_content` in the delta schema — this is a real, justified decision; `@ai-sdk/openai`'s chat-completions delta schema does not carry that field
- Ollama gets a synthetic `"ollama"` API key (the SDK requires a non-empty string for local gateways), documented inline

### ✅ 5. Message Pruner is Production-Grade
**Verified in:** `src/lib/prune-messages.ts`

- 5-pass algorithm: **collect** occurrences → **decide** keep-set → **apply** with legacy input promotion → **drop** empty turns → **merge** adjacent text-only user messages
- Tool lifecycle correctly models four states: `output / approval / incomplete / unreplayable`
- `hasUsableToolInput()` guards the `null`-vs-`??` trap: `input: null` is correctly treated as absent because the SDK uses `??` which skips `null`, so a part with `input: null` would silently fall back to `rawInput` text — the exact production defect Generation-400 fixed
- `withRecoveredToolInput()` promotes legacy `rawInput` text to `input` and drops `rawInput` to prevent dual-source ambiguity downstream
- Approval expiry correctly keys on "is there a later user message?" — an approved tool cannot execute retroactively on a future unrelated message

### ✅ 6. CORS is Narrowed and Correct
**Verified in:** `src/routes/index.ts`, `src/config/cors.ts`

- Origin derived dynamically from the live + replaced port — no hardcoded `*` wildcard
- `PATCH` is listed in `allowMethods` (its omission was a documented historical bug that silently blocked every PATCH request in the packaged desktop build)
- Path traversal in static file serving checked via `safeStaticPath()` — `../` sequences are stripped before `path.resolve`, and the resolved path is verified to start with `DIST_DIR`

### ✅ 7. Validation Layer is Comprehensive
**Verified in:** `src/lib/validation.ts` (883 lines)

- Every route's input has a corresponding Zod schema
- `chatRequestSchema` uses `.strict()` — client cannot inject `system`, `tools`, or `callSettings`, even accidentally; stray fields are rejected
- Cross-field rules enforced at schema level via `.superRefine()`: `workspaceFolderId` required for project chats, `cronExpression` required for cron schedules, `execAt` required for once schedules
- Memory content uses `.trim().min(1)` to block whitespace-only storage (the old route silently accepted `"   "` as valid content)

### ✅ 8. MCP is Properly Isolated
**Verified in:** `src/services/mcp/manager.ts` (1444 lines)

- `mcpManager` is the single owner of all MCP connections, transports, and tool discovery
- Chat route merges `mcpManager.getAiTools()` — there is no second MCP client anywhere in the codebase
- MCP is server-executed; the browser only reads config/status over `/api/mcp`; no MCP protocol code in the frontend
- The module size (1444 lines) is deliberately retained — it is a generation-guarded singleton and splitting it would add indirection on the critical path

### ✅ 9. Structured Logging with No Secrets
**Verified by:** Zero `console.log` calls in `src/` or `web/src/` production code (confirmed by full-tree grep; `console.log` exists only in `scripts/`)

- All production logging goes through `logger.<level>(scope, event, fields)` with stable snake_case event names
- `logger` uses `AsyncLocalStorage` for `requestId` — no global mutation, safe under concurrent requests
- Error fields go through `errorLogFields()` — raw exception text never crosses the HTTP boundary
- `AI_DEBUG_REQUESTS=true` enables sanitized outbound-request diagnostics without touching production log paths

### ✅ 10. Frontend Runtime Architecture Respects Boundaries
**Verified in:** `web/src/runtime.ts`

- Transport constructed per-thread inside `ResumableThreadRuntime`, so resumable-stream storage is scoped to that thread — one conversation's stream cannot resume inside another
- `sendConfigs` Map bounded to 60 entries with LRU-style pruning on overflow
- `operationId` snapshotted into `SendConfig` so tool-call continuations re-open the **same** operation, not a new one — a full tool-call turn is joinable by a single `operationId`
- `OpencodeDraftRedirectError` is a deliberate, clean abort for OpenCode threads that receive a Direct send (e.g. via Enter key) — the error is caught by the tab binding, the draft is dropped, and the prompt is handed off exactly once

---

## Real Issues Found

### 🔴 Issue 1: DB Migration Code Lives in a Single Giant Module (No Versioning)
**File:** `src/db/index.ts` (693 lines)

The `db/index.ts` file runs migrations at **module load time** via top-level `sqlite.run(...)` calls. Every `CREATE TABLE`, every `addColumnIfNotExists`, every `PRAGMA`, and two exported migration functions (`applyOpenCodeSessionImportMigration`, `repairSchedulerThreadChains`) all live in this one file.

**Specific risks:**

1. **Unversioned schema** — New installs and old installs are reconciled by probing column names with `PRAGMA table_info`. This is correct for additive migrations but gives no way to know "which migrations have run" or to roll back safely.

2. **`foreign_keys=OFF` window** — The `conversations` CHECK constraint rebuild (lines 215–265) disables FK enforcement, runs a DDL table rebuild inside a transaction, then re-enables FKs in a `finally` block. If the process crashes between `PRAGMA foreign_keys=OFF` and `PRAGMA foreign_keys=ON` (e.g. a Bun OOM), FKs remain disabled for subsequent connections — SQLite does not persist the `PRAGMA` across connections, but the session that opened the DB would have them off until `db.close()`.

3. **Migration failure is fatal** — `applyOpenCodeSessionImportMigration()` at line 376 throws if duplicate `opencode_session_id` bindings exist. A throw here kills the startup entirely with no recovery path. Users with a corrupted install have no way to bypass or patch.

4. **Testability** — Schema changes cannot be unit-tested independently; you have to import the whole module (and thus open the DB and run all migrations).

**Severity:** Medium-High

---

### 🟡 Issue 2: Business Logic + Raw SQL in Route Modules (Known Debt)
**Files:** `src/routes/memories.ts`, `src/routes/providers.ts`, `src/routes/conversations.ts`

`src/routes/memories.ts` imports `db` directly and runs raw SQL queries inline (e.g. `SELECT id, content ... FROM memories`). This violates the `routes → services → db` dependency direction mandated by the architecture.

`src/routes/conversations.ts` has a module-level idempotency state machine (`createInFlight`, `createCompleted` Maps at lines 66–67) living at the route layer — that state belongs in a service.

This is **acknowledged debt** in `AGENTS.md` §Maintainability ("raw SQL and business rules still live in `src/routes/{memories,providers}.ts`"). No new route should follow this pattern; existing violations should be extracted as part of planned refactors.

**Severity:** Medium (correctness is fine; it's a boundary violation that accumulates risk)

---

### 🟡 Issue 3: `src/lib/resumable.ts` Violates the `lib/` Purity Rule
**File:** `src/lib/resumable.ts`

`lib/` is defined as cross-cutting **pure** helpers. But `resumable.ts` imports:
- `../db` — the database layer
- `../services/chat-streams/boot` — a service module

This creates `lib → db` and `lib → services` edges that reverse the intended dependency direction.

**Severity:** Low — the module is small and its imports are carefully scoped. But it sets a precedent that `lib/` can hold stateful, DB-coupled singletons.

---

### 🟡 Issue 4: Zod Schemas Declared Outside `src/lib/validation.ts`
**Files:** `src/routes/opencode.ts`, `src/routes/mcp.ts`, `src/routes/tools.ts`

Per the architecture, `src/lib/validation.ts` is the **single source of truth** for all API input validation schemas. Some routes still declare Zod schemas inline. Finding the full validated shape of an endpoint requires checking both `validation.ts` and the route file.

This is listed as acknowledged debt in `AGENTS.md` ("Zod schemas for HTTP input are declared outside `src/lib/validation.ts` in `routes/{opencode,mcp,tools}.ts`").

**Severity:** Low

---

### 🟡 Issue 5: Large Frontend Components Without DOM Test Coverage
**Files:**
- `web/src/components/LogsPanel.tsx` — 983 lines, a whole feature with no `features/logs/` owner
- `web/src/components/Composer.tsx` — 701 lines
- `web/src/features/providers/ProviderDialog.tsx` — 560 lines

Per AGENTS.md §Maintainability, review is triggered when **both** conditions hold: a module over ~1000 lines, AND no automated test that would catch a behavior change. `LogsPanel.tsx` at 983 lines is approaching that threshold and has no DOM coverage. Splitting it now would produce an untestable refactor.

**Severity:** Low-Medium (accumulating risk, not an active bug)

---

### 🟢 Issue 6: `assistant-cloud` Dependency in Web — Needs Reachability Check
**File:** `web/package.json` — `"assistant-cloud": "^0.2.5"`

`assistant-cloud` is in `web/package.json` as a runtime dependency. This is a cloud sync package for `@assistant-ui/react`. If it is unused, it is dead weight and may import a second `@assistant-ui` context instance (the exact class of bug AGENTS.md §Dependency / context integrity warns against). If it is used, that usage needs to be verified as single-instance.

**Severity:** Unknown until reachability is confirmed

---

## Architecture Boundary Compliance

| Boundary | Status | Evidence |
|---|---|---|
| `web/src/runtime.ts` — only place wiring transport to `/api/chat` | ✅ Compliant | No other file calls `AssistantChatTransport` with `/api/chat` |
| `src/services/ai.ts#getModel` — only place mapping provider → model | ✅ Compliant | Switch statement is the sole factory call site |
| `src/services/mcp/manager.ts` — only place owning MCP connections | ✅ Compliant | No other module instantiates `@modelcontextprotocol/client` |
| `src/lib/validation.ts` — all API input validation | ⚠️ Partial | Some schemas inline in route files (known debt) |
| `src/routes/index.ts` — composition root, no domain logic | ✅ Compliant | Only CORS, logging, and mounting |
| `routes → services → db` dependency direction | ⚠️ Violated | `memories.ts`, `providers.ts`, `conversations.ts` (known debt) |
| No secrets in browser | ✅ Compliant | Only `providerId` in request body, key resolved server-side |
| OpenCode isolation (`src/services/opencode/`) | ✅ Compliant | No other backend module imports the OpenCode client |
| Scheduler boundary (`src/services/scheduler/scheduler.ts`) | ✅ Compliant | Single timer owner verified |
| `lib/` pure helpers only | ⚠️ Violated | `src/lib/resumable.ts` imports `db` and a service |

---

## Known Debt Inventory (All Documented, All Deferred)

These are confirmed present in the codebase and acknowledged in `AGENTS.md`:

| Debt | Location | Risk Level |
|---|---|---|
| Raw SQL in route files | `routes/memories.ts`, `routes/providers.ts` | Medium |
| State machine at route layer | `routes/conversations.ts` | Medium |
| Feature code without a feature directory | `components/LogsPanel.tsx` | Low-Medium |
| Wrong import direction | `components/ElicitationModal.tsx`, `components/Sidebar.tsx` | Low |
| Cross-feature import | `features/chat/directCompactEntries.ts` → `features/opencode` | Low |
| Monolithic intentional file | `context/compaction/contract.ts` (1028 lines) | Retained deliberately |
| Monolithic intentional file | `services/mcp/manager.ts` (1444 lines) | Retained deliberately |

---

## Recommended Actions

### Priority 1 — Address Soon

#### Action 1.1: Implement Versioned DB Migrations
**Target:** `src/db/index.ts` → `src/db/migrations/`

Replace the flat top-level DDL execution with a numbered migration system:

1. Create a `schema_migrations` table: `(version INTEGER PRIMARY KEY, applied_at INTEGER)`
2. Extract each logical DDL block into `src/db/migrations/NNN_description.ts`
3. A `runMigrations(db)` function reads the current version, runs all pending migrations in order inside individual transactions, and records each applied version
4. Wrap each migration in its own `BEGIN / COMMIT / ROLLBACK` so a failed migration does not leave the DB in an ambiguous state
5. The `foreign_keys=OFF` block during the conversations rebuild should be scoped to that migration's transaction only — re-enable immediately after `COMMIT`, not in a `finally` that runs after an error path

**Acceptance criteria:** A new install and an upgrade from any prior version follow the same code path. A failed migration logs the version number and exits cleanly without corrupting the schema.

---

#### Action 1.2: Audit and Remove `assistant-cloud` if Unused
**Target:** `web/package.json`

Run the orphan-module scanner:
```bash
bun run test  # includes tests/unit/tooling/no-orphan-modules.test.ts
```

If `assistant-cloud` appears as an orphan (zero inbound references from `web/src/`), remove it from `web/package.json` and do a clean reinstall:
```bash
bun install
bun run typecheck
```

If it is used, identify the exact import and verify it does not create a second `@assistant-ui/react` context instance (the scanner in `no-orphan-modules.test.ts` checks references but not context identity — context identity must be checked manually via the browser devtools React tree or by reading the import chain).

---

### Priority 2 — Next Planned Refactor Sprint

#### Action 2.1: Extract `memories` SQL to the Storage Service
**Target:** `src/routes/memories.ts` → `src/services/storage/memories.ts`

`src/services/storage/memories.ts` already exists. Move the raw `SELECT / INSERT / UPDATE / DELETE` queries from the route file into named functions there. The route then calls the service function and shapes the HTTP response. No behavior change — this is a pure mechanical extraction.

Steps:
1. Add `list()`, `create()`, `update()`, `delete()` to `src/services/storage/memories.ts`
2. Update `src/routes/memories.ts` to import and call those functions
3. Remove the `db` import from the route file
4. Run `bun run typecheck && bun run lint && bun run test`

---

#### Action 2.2: Move Inline Zod Schemas to `src/lib/validation.ts`
**Target:** `src/routes/opencode.ts`, `src/routes/mcp.ts`, `src/routes/tools.ts`

For each inline schema:
1. Copy the schema definition to the correct location in `src/lib/validation.ts` (follow the existing section grouping)
2. Export it
3. Replace the inline definition in the route with an import from `src/lib/validation.ts`
4. Run `bun run typecheck`

---

### Priority 3 — Before the Next Large Component Refactor

#### Action 3.1: Add DOM Tests for `LogsPanel.tsx` Before Splitting
**Target:** `web/src/components/LogsPanel.tsx`

Do **not** split `LogsPanel.tsx` without tests. The correct order:

1. Write characterization DOM tests that exercise the key behaviors: log rendering, level filtering, scope filtering, the live-stream toggle, clear action
2. Confirm tests pass on the current implementation
3. Extract `web/src/features/logs/` as the owning directory
4. Move `LogsPanel.tsx` there, verifying all tests still pass

The test file goes in `tests/dom/` following the existing convention; `bun run test:locations` will fail if it is placed elsewhere.

---

#### Action 3.2: Fix `src/lib/resumable.ts` Import Direction
**Target:** `src/lib/resumable.ts`

Option A — Move `resumable.ts` to `src/services/chat-streams/resumable.ts` where it naturally belongs (it is not a pure utility).  
Option B — Create a thin wrapper in `src/services/chat-streams/` that calls the `lib` helper, injecting the `db` dependency.

Either option must preserve the existing import path used by `src/routes/chat/index.ts`. If moving the file, update all consumers (enumerate with a static search before moving).

---

## What NOT to Change

These are deliberate design choices that must not be altered without a full architecture review:

- **`services/mcp/manager.ts`** — 1444-line singleton; splitting adds indirection on the hot path
- **`context/compaction/contract.ts`** — 1028 lines; single-owner module with section markers; splitting risks generation-guard regressions
- **`@assistant-ui` dependency train** — **frozen** per AGENTS.md; no upgrade, downgrade, replacement, or re-resolution without explicit compatibility review and approval
- **AES-256-GCM credential design** — trade-off (DEK co-located with ciphertext) is intentional and documented in `docs/security.md`
- **The message pruner** — load-bearing; has unit tests; do not simplify the 5-pass algorithm
- **`chatRequestSchema.strict()`** — the `.strict()` call on the chat envelope is a security boundary; removing it would allow clients to inject model policy

---

## Durability and Robustness Findings
*Second pass: deeper read of scheduler, compaction, settlement, and stream-reconciliation code.*

These are **active risks** found by tracing code paths in the installed production files — not hypotheses. Each one has a specific file and line reference.

---

### 🔴 D1: Overflow Recovery Gate is Built but NOT Wired — Context Overflow = Hard Error Today
**File:** `src/routes/chat/overflow-gate.ts` — line 74 (explicit warning comment in the source)

The file `overflow-gate.ts` contains a complete, proven overflow-recovery implementation (`withOverflowRecovery`) that intercepts a provider "context too long" rejection, triggers compaction, and retries the request transparently — all without the user seeing an error. The gate is designed, tested in integration, and its logic is correct.

However, the source file contains a prominent `⚠️ THE ROUTE MUST NOT WIRE THIS GATE YET` comment documenting a specific unresolved blocker:

> `streamText`'s own `onError` fires when the provider rejects — **before** the error part reaches this gate. A route that lets `onError` publish terminal state publishes the failure of an attempt the gate is about to discard.

**Current effect:** Context overflow always surfaces as a hard error to the user. The compaction machinery exists and works; the connection between it and the provider stream is missing.

**What is required to close this:**
1. The route's `streamText` `onError` callback must *capture* the error locally instead of publishing terminal state immediately
2. The gate's `onAttemptDiscarded` callback neutralises the first attempt's side-effects
3. The gate's `onFinalError` callback becomes the single publication authority for the attempt that survives
4. The route must verify whether `createUIMessageStream.onError` fires for a forwarded provider `error` chunk — if it does, moving publication out of the `streamText` callback is safe; if it does not, that logging path must be preserved separately

**Severity:** High — every long conversation that overflows hits a dead end instead of recovering.

---

### 🔴 D2: Scheduler Run Continues After `ensureJobConversation` Fails
**File:** `src/services/scheduler/scheduler.ts` — lines 206–231

In `fireJob`, when `ensureJobConversation` throws, the catch block logs a warning and sets `resolvedConversationId = undefined`. Execution then **continues** into `executeJobRun` with:

```ts
() => executeJobRun(job, run, resolvedConversationId ?? "", signal)
```

An empty string `""` is passed as the conversation ID. `executeJobRun` will either throw internally (logging a failure) or attempt to write messages to a non-existent conversation. The run is claimed, a controller is registered, and the promise is tracked — but there is no early exit that matches what the warning message implies.

**Fix:** In the `ensureJobConversation` catch block, call `schedulerStore.update(run.id, { status: "failed" })`, release the controller, and `return` — do not fall through to execution with an empty conversation ID.

**Severity:** High — a conversation-setup failure silently produces a run that writes nowhere.

---

### 🟡 D3: History Reconciler's `conflicted` Rows Re-queue Indefinitely
**File:** `src/services/chat-streams/historyReconciler.ts` — lines 97–101

When `finalizeDetachedRunHistory` returns `"conflicted"` — meaning the stored message row contradicts the captured reply's identity, ownership, or parent — the reconciler closes the loop with `report.conflicted += 1` and moves on. The row remains in `claimed` state.

On the next 60-second tick, `listPendingCompletedHistory` returns the same row again, and the same conflict is detected. This repeats **without bound**. There is no retry counter, no escalation, and no way for a permanently conflicted row to be marked `skipped` and evicted from the scan.

**Fix:** Add an attempt counter to the `chat_streams` row (or a separate tracking table). After N consecutive `conflicted` outcomes for the same `streamId`, call `store.skipHistory(row.streamId)` and log a `warn` with the conflict details so it can be diagnosed without the row blocking every scan tick.

**Severity:** Medium — silent steady-state overhead; in pathological cases the scan is dominated by one broken row.

---

### 🟡 D4: Compaction Race Loser Falls Through to Hard Overflow Failure
**File:** `src/context/compaction/orchestrate.ts` — lines 291–295

When two concurrent requests compact the same conversation:
- Request A wins the `persist()` race and stores its record
- Request B loses and correctly refuses to apply A's span using its own indices (the race-loser path was specifically audited and fixed to prevent mis-splicing)
- Request B calls `applyExistingCompaction` with A's record — but if A's span fingerprint is not locatable in B's message list, it returns `applied: false, reason: "lost_race_span_not_locatable"`
- The caller treats `applied: false` as "assemble normally" — which means assembling the full uncompacted history, which may still exceed the budget

The user then gets a context overflow error for a request where compaction actually *did* happen — A's record is durable — but B couldn't apply it.

**Fix:** After a `"lost_race_span_not_locatable"` result, re-read the winner's record directly from the DB (it was just written) and attempt a second `applyExistingCompaction` with the freshly read record before falling back to uncompacted assembly.

**Severity:** Medium — rare in practice (requires two concurrent sends to the same conversation), but the failure mode is a hard error for the user on a turn where compaction succeeded.

---

### 🟡 D5: Shutdown Drain Timeout Has No Consequence
**File:** `src/services/scheduler/scheduler.ts` — lines 622–654

`abortAllRuns(timeoutMs = 10_000)` correctly aborts in-flight runs and awaits their settlement, bounded by 10 seconds. It returns `{ aborted, settled, timedOut, deadlineHit }`.

The caller receives this report, but nothing in the shutdown spine **acts on `timedOut > 0`**. If 2 runs are still writing SQLite rows when the deadline expires, `db.close()` runs while those writes are in flight. Bun's SQLite binding will either throw or silently complete the write against a closed handle depending on timing.

**Fix:**
1. The shutdown spine must log a `warn` with the `timedOut` count when `deadlineHit` is true
2. Before calling `db.close()`, verify `hasPendingRuns()` is false; if not, force-finalize those runs as `interrupted` at the DB level (a single `UPDATE scheduler_runs SET status='interrupted' WHERE status='running'`) so they are not left as phantom `running` rows that block the next boot's `markInterrupted` from doing its job cleanly

**Severity:** Medium — a rare race only relevant under slow provider calls at shutdown, but the consequence (writes against a closed DB) is data corruption.

---

### 🟡 D6: Failed Recovery Job May Leave a Live Cron Handle
**File:** `src/services/scheduler/scheduler.ts` — lines 472–513

In `recoverEssential`, when a recurring job throws during recovery (e.g. `parseCron` succeeds and `Bun.cron()` registers a handle, but `computeNextRun` throws afterward), the catch block calls:

```ts
schedulerStore.update(job.id, { enabled: false, status: "failed", nextRunAt: null }, database);
```

This correctly marks the DB row as failed. But `clearTimer(job.id)` is **not called in the catch block** — it only runs at the top of `scheduleRecurring` for the *next* call. If the cron handle was registered before the exception, it remains live in the `timers` map and will continue firing for a job the DB considers failed.

**Fix:** Add `clearTimer(job.id)` as the **first statement** in the recovery catch block, before the `schedulerStore.update` call.

```ts
} catch (err) {
  clearTimer(job.id);  // ← add this
  schedulerStore.update(job.id, { enabled: false, status: "failed", nextRunAt: null }, database);
  ...
}
```

**Severity:** Low-Medium — only affects jobs that partially register during a specific failure window at startup; the phantom timer fires but `fireJob` guards on `job.status !== "active"` so it skips.

---

## Durability Issues: Priority Order

| # | Severity | What Breaks | Where |
|---|---|---|---|
| D1 | 🔴 High | Context overflow = permanent hard error, compaction unused | `src/routes/chat/overflow-gate.ts` |
| D2 | 🔴 High | Scheduler run executes with empty conversation ID | `src/services/scheduler/scheduler.ts` L206 |
| D3 | 🟡 Medium | Conflicted history rows loop every 60s indefinitely | `src/services/chat-streams/historyReconciler.ts` |
| D4 | 🟡 Medium | Race-loser compaction → hard overflow despite compaction succeeding | `src/context/compaction/orchestrate.ts` |
| D5 | 🟡 Medium | DB closes while scheduler writes are in flight | `src/services/scheduler/scheduler.ts` L622 |
| D6 | 🟡 Low-Med | Failed recovery job leaves live cron handle | `src/services/scheduler/scheduler.ts` L473 |

**D6 is a one-line fix. D2 is three lines. Do those first.**

---

*Audit performed by reading production code only (`src/`, `web/src/`, `src-tauri/`, root config files). No speculative claims — every finding traces to a specific file and observable behavior. Docs were used only after code reading to cross-check whether known debt was acknowledged.*
