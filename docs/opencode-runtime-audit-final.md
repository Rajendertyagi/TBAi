# OpenCode Runtime Reliability Audit

> **Superseding note (2026-10-28).** This report is a snapshot dated 2026-10-23
> and every version reference below describes that snapshot. Since then the CI
> binary pin and `@opencode/client` moved from 2.1.2 to 2.2.0, and the supported
> range is now `>=2.0.15 <2.2.1`. Statements that CI "installs/provisions
> 2.1.2" describe the audited snapshot; the workflow now pins 2.2.0 with the
> registry's own `dist.integrity`. **That pin has not yet run on a runner.**
> The measurements quoted below - cold start, and the RT-013 3-of-8 compaction
> failures - were taken at 2.1.2 and are not restated as 2.2.0 results.

## 1. Audit metadata and source snapshot

| Item | Value |
|---|---|
| Branch | `ci/tauri-e2e-verify` |
| Local HEAD (audit snapshot) | `9cc7c294551d17377198a7b511ca9d39ad416d38` — "docs(opencode): reconcile acceptance plan status" |
| Public remote HEAD (`origin/ci/tauri-e2e-verify`) | `fe1025596e5efd0f787c5664f85d9eb4f80552c1` — "docs(opencode): record G2 CI build and packaged smoke result" |
| Distance | Local HEAD is **1 commit ahead** of the public remote; the public remote HEAD does **not** contain `9cc7c29`. |
| Snapshot provenance | **Local, unpublished commit.** `9cc7c29` is not reachable from the public branch, so this snapshot is **not independently reproducible from the public remote**. |
| Snapshot integrity | The only local-vs-remote diff is the addition of `docs/2026-10-23-opencode-retry-and-recovery-plan.md` (a docs file). **No source, test, or configuration file differs between `fe10255` and `9cc7c29`.** |
| Practical audit base | Because the source code is byte-identical between `9cc7c29` and `fe10255`, **every source and test citation in this report is equally valid against the public remote HEAD `fe10255`**, which *is* independently reproducible. The only difference is the plan document, which is not audited source. |
| Working tree | This report is the untracked `docs/opencode-runtime-audit-final.md`. The working tree additionally carries unrelated, pre-existing uncommitted edits in `src/services/storage/messages.ts`, `web/src/adapters/threadHistoryAdapter.ts`, `web/src/components/VirtualizedTranscript.tsx`, and the untracked `tests/unit/web/adapters/threadHistoryAdapter.phase4.test.ts`; none of those were made by this audit and none of them touch OpenCode source. |
| Audit date | 2026-10-23 |
| Auditor | Independent (this agent) |
| Verification environment | Windows (win32), Bun 1.4.2 (per CI `BUN_VERSION`). No local OpenCode binary available for live testing in this session; GitHub Actions run results are **not** directly accessible from this environment, so CI evidence below is derived from the workflow files and the in-repo prose references to specific runs. No Actions run result is cited as verified unless it is a committed in-repo reference. |

### Files inspected (source)

- `src/services/opencode/serverManager.ts` (spawn, readiness, restart, shutdown, port allocation, database lease, `ensureBaseUrl` caching)
- `src/services/opencode/sessions.ts` (`ensureOpenCodeSession`, `terminateOpenCodeSession`, `getOpenCodeSessionActivity`, singleflight, stale-pointer detection)
- `src/services/opencode/ownership.ts` (database path resolution, named mutex, Restart Manager, post-readiness child verification, `acquire()` return-exists)
- `src/services/opencode/runtime.ts` (binary resolution, version validation, auth password, both env names)
- `src/services/opencode/client.ts` (official V2 client, observing transport, status observation)
- `src/services/opencode/proxyAuthorization.ts` (session → conversation → folder → directory resolution)
- `src/services/opencode/proxyRoutes.ts` (upstream route allowlist, global/location/session scopes)
- `src/services/opencode/errors.ts` (failure classification)
- `src/services/opencode/capabilities.ts`, `sessionModel.ts`, `commands.ts`, `configDocument.ts`, `configRedaction.ts`
- `src/config/opencode.ts` (version range, `startupTimeoutMs`, `shutdownTimeoutMs`, `maxRestartAttempts`)
- `src/routes/opencode.ts` (HTTP boundary, proxy forwarding, config, permissions)
- `src/routes/conversations.ts` (DELETE: `terminateOpenCodeSession` + conversation row deletion)
- `src/services/storage/conversations.ts` (conversation persistence, `findByOpenCodeSessionId`)
- `src/lib/validation.ts` (Zod input schemas)

### Files inspected (frontend)

- `web/src/features/opencode/v2ThreadController.ts` (connection, retry, cancel, hydration, generation lifecycle, `awaitReady`/`ensureLoaded`)
- `web/src/features/opencode/v2Client.ts` (official client wrap, scoped per generation/session, `inboxCancel`, `interrupt`)
- `web/src/features/opencode/config.ts` (timeouts, caps, thresholds: `OPENCODE_V2_READY_TIMEOUT_MS`, reconnect budget, event buffer)
- `web/src/features/opencode/sync/attempt.ts`, `sync/startupGate.ts`, `sync/eventPipeline.ts`, `sync/historyReplay.ts`, `sync/optimistic.ts`, `sync/promptsInFlight.ts`, `sync/retention.ts`
- `web/src/features/opencode/OpenCodeStatus.tsx`, `OpenCodeRecoveryNotice.tsx`, `recoveryEpoch.ts`, `v2Runtime.ts`
- `web/src/tools/opencode/adapt.ts` (type-only `@opencode/client` import), `ui.tsx`

### Files inspected (tests)

- `tests/unit/opencode/*.ts` (15 files: `serverManager`, `sessions`, `ownership`, `runtime`, `client`, proxy allowlist, config, capabilities, etc.)
- `tests/unit/web/opencode/*.ts` (61 files: `v2ThreadController`, `eventPipeline`, `historyReplay`, `startupGate`, retry, retention, permissions, forms, etc.)
- `tests/integration/opencode/*.ts` (21 files, including the 8 opt-in real-server suites)
- `tests/e2e/opencode/*.spec.ts` (7 specs)
- `tests/dom/opencode/*.ts`
- `tests/harness/opencodeRuntimeHarness.ts` (`runtimeTestsRequested`, `runtimeUnavailableReason`)

### Files inspected (docs)

- `docs/2026-09-17-lifecycle-hardening.md` (prior F1–F3 lifecycle findings, now verified fixed)
- `docs/2026-10-16-backend-lifecycle-audit.md`
- `docs/2026-10-20-opencode-runtime-remediation-plan.md`
- `docs/2026-10-23-opencode-retry-and-recovery-plan.md`
- `docs/pm-opencode-store-audit.md`, `pm-opencode-frontend-audit.md`, `pm-opencode-store-audit-answers.md`

### CI inspected

- `.github/workflows/tests.yml` (jobs: `verify`, `e2e`, `e2e-big-pickle`, `tauri`)
- `.github/workflows/tauri-build.yml` (release build)
- `.github/actions/install-opencode/action.yml` (pinned OpenCode CLI 2.1.2 + SHA-512 at audit time; 2.2.0 since 2026-10-28, not yet run on a runner)
- `package.json` (scripts: `test`, `test:e2e`, `test:locations`, `test:shutdown`, `test:startup-rollback`, `test:lifecycle-integration`, `test:dom`, `test:quarantine`, `verify`, `lint`, `typecheck`, `build`)
- `scripts/run-e2e.ts` (Playwright spec selection)
- `web/playwright.config.ts` (testDir, live-spec exclusion, projects)

---

## 2. Executive verdict

**Certification decision: Hold.**

The OpenCode runtime subsystem carries genuinely strong, source-confirmed mechanisms: a single-flight managed child with a bounded restart budget, fail-closed database-ownership acquisition via a per-path named mutex and Windows Restart Manager, interrupt-then-remove session termination that never orphans a live session, a proxy allowlist checked bidirectionally against the real client, and attempt-scoped frontend state with a bounded reconnect budget. The principal findings are **summarized below** for reference; §11 distinguishes which of them are **mandatory Tier 1 blockers** (the ones that prevent certification) from the **Tier 2 findings** that close through documented scope or accepted behavior. "Prevents certification" is reserved for the Tier 1 blockers. Each finding listed here is a real, source-confirmed or evidence-bounded gap — not a stylistic concern.

1. **RT-001 (Session-creation persistence race — Source-confirmed, High):** `ensureOpenCodeSession` performs the remote `session.create` **before** it persists the session id to the conversation row. A failure between the two steps orphans the remote session: TBAi holds no pointer, nothing can remove it, and subsequent calls create more orphans. The ordering is source-confirmed; a controlled test has **not** reproduced the orphan outcome.

2. **RT-011 (Remote session handle lost on conversation deletion — Source-confirmed, High):** `DELETE /api/conversations/:id` awaits `terminateOpenCodeSession()` but **ignores its result**. When remote removal fails (returns `{ terminated: false }`), the persisted pointer is retained on the row — and the row is then destroyed, eliminating TBAi's only handle to a possibly-live remote session that can never be removed.

3. **RT-003 (Database-lease failure-path retention — Source-confirmed, Low, non-blocking):** The database ownership lease is acquired **before** port allocation and child spawn. Two failure paths can retain the lease without calling `databaseLease.release()`: a synchronous port-allocation or spawn error before the readiness `try` block, and the readiness-failure catch (readiness timeout or post-readiness ownership-verification failure). In the latter path, the catch clears `child`/`port`/`readyPromise` and kills the child. The outer `ensureBaseUrl()` rejection handler clears the cached `readyPromise` on every failed start; the lease is also released on the post-acquisition stopping branch, on restart exhaustion, and on `shutdown()`. `acquire()` returns the existing lease for the same ownership instance, so a retried start by the **same manager** reuses it (it is not blocked); the lease may remain held across either failure path described above. The *demonstrated* effect is that a **second** manager is refused by the named mutex — the intended fail-closed behavior, not a defect. A release-on-failure change is optional; this is a source-confirmed observation with **unproven impact** and is not a certification blocker.

4. **RT-004 / RT-008 (No active health check and no stuck-stream detection — Verification gap, Medium):** Recovery is `onExit`-driven. A process that is alive but unresponsive (frozen, deadlocked, or an event stream that stays open but silent) is **not** detected by any probe: a resolved `readyPromise` is returned without re-contacting the server, and there is no silent-stream detector. The distinction is: **process-exit recovery works** (a crash fires `onExit` and restarts if budget allows); **live-but-unresponsive detection is absent**.

5. **RT-007 (Real-server suites are opt-in; default CI coverage is partial — Verification gap, Medium):** The default `verify` and `e2e` jobs install OpenCode CLI (2.1.2 at audit time; 2.2.0 since 2026-10-28) but **never set `TBAI_OPENCODE_RUNTIME_TESTS`**, so all 8 deep real-server integration suites self-skip. The only OpenCode E2E spec the default `e2e` job runs is `opencode-v2-code-route.spec.ts` (real managed server, no live model call). Crash-recovery, hard-kill, restart-exhaustion, and cross-version behavior are unproven in the standard gate.

6. **RT-012 (Frontend ready timeout does not bound end-to-end startup — Source-confirmed, Medium):** `awaitReady()` first calls `ensureLoaded()` (connection + hydration), then applies the remaining `OPENCODE_V2_READY_TIMEOUT_MS` deadline to the readiness gate. The 20 s budget therefore does **not** establish an end-to-end connection-and-hydration deadline: a connection or hydration promise can remain unresolved beyond the advertised figure. This is a distinct risk from the frontend/backend timeout mismatch in RT-009.

**Prior findings F1–F3** from `docs/2026-09-17-lifecycle-hardening.md` (readiness-timeout orphaning the child, the exit-during-readiness clobber race, and the restart-budget reset) are **verified as fixed in the current source** — see §9 (Verified strengths). No other prior finding blocks certification on its own.

The verdict is **Hold**, not "accept." Certification items are tiered (§11). **Tier 1 mandatory blockers** are **RT-001, RT-011, RT-008, RT-012, and RT-007** — the two High source-confirmed orphan-handle defects (RT-001, RT-011), the two Medium source-confirmed reliability gaps (no stuck-stream detector; no end-to-end startup deadline), and the **coverage gap** (RT-007): crash-recovery, hard-kill, restart-exhaustion, and cross-version behavior are unproven in the standard gate, and a reliable-subsystem certification requires that behavior to be exercised by the real-server and live-model suites — a successful default-CI run does not substitute for it. **Tier 2** findings — **RT-003, RT-004, RT-006, RT-009, RT-010** — close through documented scope or accepted behavior and do not by themselves hold the verdict: in particular, **RT-006** (pre-admission fire-and-forget cancel; the admitted/executing paths await the result; the inbox-cancel-vs-execution-start race is open) is an accepted-behavior/documentation item, not a mandatory blocker. Each Tier 1 blocker maps to a concrete closure criterion in §11.

---

## 3. System boundary and component map

The subsystem is a managed-process boundary: TBAi owns the **lifecycle and policy** (start/stop, database ownership, session binding, authorization, transport) while the OpenCode child owns **execution and its own history database**. The boundary between the two is the managed `opencode serve` child process and the official `@opencode/client` V2 transport.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Frontend (web/src/)                          │
│  ChatWindow / Composer (mode="agent")                               │
│    └─ features/opencode/                                            │
│        ├─ v2ThreadController.ts   — connection, retry, cancel,     │
│        │                          hydration, generation lifecycle   │
│        ├─ v2Client.ts             — official @opencode/client wrap, │
│        │                          scoped per generation/session     │
│        ├─ sync/attempt.ts         — attempt-scoped ownership        │
│        ├─ sync/startupGate.ts     — readiness gate, one owner       │
│        ├─ sync/eventPipeline.ts   — event loop, retry budget        │
│        ├─ sync/historyReplay.ts   — history + live event merge      │
│        ├─ sync/optimistic.ts      — optimistic message IDs          │
│        ├─ sync/promptsInFlight.ts — in-flight prompt tracking       │
│        ├─ sync/retention.ts       — bounded retention sets          │
│        ├─ OpenCodeStatus.tsx      — UI status + retry banner        │
│        ├─ OpenCodeRecoveryNotice  — session-reuse notice            │
│        └─ config.ts               — timeouts, caps, thresholds      │
│  tools/opencode/                                                   │
│        ├─ adapt.ts        — type-only @opencode/client import       │
│        └─ ui.tsx          — tool rendering                          │
└─────────────────────────────────────────────────────────────────────┘
                               │ HTTPS fetch (proxy: /api/opencode/*)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       Backend (src/)                                 │
│  routes/opencode.ts          — Hono boundary: session create/get,    │
│                                proxy forwarding, config, permissions │
│  routes/conversations.ts     — DELETE: terminateOpenCodeSession +    │
│                                conversation row deletion             │
│  services/opencode/                                                 │
│    ├─ serverManager.ts       — managed `opencode serve` child:      │
│    │   spawn, readiness, restart, shutdown, port alloc, DB lease    │
│    ├─ sessions.ts            — session create/adopt/terminate,       │
│    │   singleflight dedup, stale-pointer detection                   │
│    ├─ client.ts              — official V2 client + transport        │
│    │   observation (last-status seam)                                │
│    ├─ proxyAuthorization.ts  — session → conversation → folder →    │
│    │   directory resolution; refusal on unknown session id,         │
│    │   mismatched session id, or unresolvable workspace — NOT a     │
│    │   verified refusal of a current-workspace-vs-actual-dir        │
│    │   mismatch (RT-005)                                             │
│    ├─ proxyRoutes.ts         — allowlist of upstream routes         │
│    ├─ ownership.ts           — DB path, named mutex, Restart Mgr,   │
│    │   post-readiness child verification                             │
│    ├─ errors.ts              — OpenCode failure classification       │
│    ├─ runtime.ts             — binary resolve, version validation,   │
│    │   auth password (both env names)                                │
│    ├─ capabilities.ts        — model/agent discovery                 │
│    ├─ sessionModel.ts        — session model resolution              │
│    └─ commands.ts            — command feed                          │
└─────────────────────────────────────────────────────────────────────┘
                               │ stdio / HTTP loopback
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   Managed `opencode serve` child process             │
│  - Owns its SQLite database (XDG_DATA_HOME / OPENCODE_DB)           │
│  - Enforces its own permission rules (allow/ask/deny)               │
│  - SSE event stream: GET /api/session/:id/event                     │
│  - V2 HTTP API: session/prompt, interrupt, remove, etc.             │
└─────────────────────────────────────────────────────────────────────┘
                               │ SQLite file
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Persistence (bun:sqlite)                        │
│  - conversations.opencode_session_id  — TBAi→remote session binding │
│  - conversations.engine               — "opencode" vs "direct"      │
│  - folders / workspace table          — directory scope             │
└─────────────────────────────────────────────────────────────────────┘
```

**Component responsibility map** (supplemental; the binding assessments are in §4):

| Component | Owns | Key files |
|---|---|---|
| Frontend runtime | Connection, retry, cancel, hydration, generation lifecycle | `v2ThreadController.ts`, `v2Client.ts`, `sync/*` |
| Frontend sync | Event pipeline, history replay, retry budget, retention | `sync/eventPipeline.ts`, `attempt.ts`, `startupGate.ts`, `historyReplay.ts`, `retention.ts` |
| Backend routes | HTTP boundary, session create/get, DELETE (conversation + session teardown) | `routes/opencode.ts`, `routes/conversations.ts` |
| Process & daemon lifecycle | Managed `opencode serve` child: spawn, readiness, restart, shutdown, port alloc, DB lease | `serverManager.ts` |
| Session lifecycle | `ensureOpenCodeSession` adoption, termination, singleflight dedup | `sessions.ts` |
| Database ownership | Path resolution, named mutex, Restart Manager, post-readiness verify | `ownership.ts` |
| Proxy authorization | Session → conversation → folder → directory resolution; refusal of unknown sessions / mismatched session ids / unresolvable workspaces (a current-workspace-vs-actual-directory mismatch is **not** verified as refused — see RT-005) | `proxyAuthorization.ts` |
| Proxy allowlist | Route allowlist checked bidirectionally | `proxyRoutes.ts` |
| Transport & client | Official V2 client, transport observation, status observation | `client.ts` |
| Error classification | Five failure kinds with HTTP status codes | `errors.ts` |
| Version & auth | Binary resolve, version validation, password handling (both env names) | `runtime.ts` |
| State synchronization | Frontend domain state, retry budget, retention | `v2ThreadController.ts`, `v2Events.ts` |

**Boundary rule (non-negotiable):** TBAi is the orchestration/policy layer; it does not reimplement OpenCode's coding loop, tool execution, or database schema. OpenCode's own permission system is not TBAi's to revoke (§8, §11).

---

## 4. Seven-area responsibility assessment

Each area summarizes **current behavior**, **guarantees**, **limitations**, and **evidence quality**. The seven are the binding assessments; they are not a substitute for the findings register (§5).

### R1 — Process & Daemon Lifecycle

**Current behavior.** The `OpenCodeServerManager` singleton (`serverManager.ts:540`) owns one managed `opencode serve` child. `ensureBaseUrl()` (`serverManager.ts:297-314`) is single-flight: it returns the cached `readyPromise` if present (`:302`), otherwise runs `start()` and caches the attempt, clearing the cache only if the cached value is the failed attempt (`:308-313`). `start()` (`:352-437`) resolves and validates the binary, acquires the database lease **before** spawning (`:357`), allocates a loopback port (`:362`), spawns the child (`:363`), waits for authenticated readiness via `waitForHttpReady` probing `GET /api/info` with Basic auth (`:380-391`), then post-readiness verifies that only TBAi + the child hold the DB files (`:396`). On success it resets the restart budget (`:434`). On failure the catch clears `child`/`port`/`readyPromise` only if it still owns them (`:406-410`), SIGKILLs the child for the timeout/ownership-verification failure modes (`:417-429`), and rethrows. `onExit` (`:471-507`) is the restart driver: on an unexpected exit it clears state and re-enters `ensureBaseUrl()` while `restartAttempts < maxRestartAttempts` (`:487`), logging `restart_failed` when the budget is exhausted. `shutdown()` (`:509-536`) sets `stopping`, sends SIGTERM, escalates to SIGKILL after `shutdownTimeoutMs`, clears state, and releases the database lease.

**Guarantees.** Binary version is validated before spawn (`runtime.ts`, range `>=2.0.15 <2.2.1` per `config/opencode.ts:74-75`; the ceiling is the audited 2.2.0 release). Fail-closed database ownership: unresolvable path, held mutex, foreign holder, or unanswerable Restart Manager query all refuse startup. The restart budget bounds consecutive failed restarts (3); a successful start resets it. Shutdown escalates SIGTERM → SIGKILL with a bounded wait. The readiness-timeout and ownership-failure paths kill the child so a slow-starting server cannot become an orphan (F1 fix confirmed).

**Limitations.** No active health check: a live-but-unresponsive process is not re-probed — a resolved `readyPromise` is returned without contacting the server (RT-004). On non-Windows, `detached: process.platform !== "win32"` (`serverManager.ts:344`) means the child can outlive TBAi if TBAi dies ungracefully (RT-010). The post-readiness database check has a documented race window: a foreign process opening the DB **after** `verifyChild` passes is outside the enforceable boundary (`ownership.ts:19-21`). Total startup time across restarts is unbounded: each attempt gets `startupTimeoutMs` (30 s) but the restart chain can extend indefinitely. Two failure paths can retain the database lease without calling `release()`: synchronous port-allocation/spawn errors before the inner `try`, and readiness/ownership-verification failures handled by the inner catch (RT-003). The outer rejection handler still clears the cached `readyPromise`.

**Evidence quality.** Source-confirmed for all lifecycle claims. Prior F1–F3 verified fixed (§9). The lease non-release on failure and the absent health check are source-confirmed absences, not reproduced defects.

### R2 — Connection & Error Recovery

**Current behavior.** Backend `waitForHttpReady` (`serverManager.ts:157-241`) races the readiness probe against process exit and shutdown cancellation, producing distinct error types: `OpenCodeProcessExitedError`, `OpenCodeReadinessTimeoutError`, `OpenCodeReadinessCancelledError`. The frontend `eventPipeline.ts` owns the event-stream loop: it maintains an ordinal, buffers events arriving during history load, and schedules reconnects with exponential backoff bounded by `OPENCODE_V2_MAX_RECONNECT_DELAY_MS` (10 s background) and `OPENCODE_V2_FOREGROUND_RECONNECT_CAP_MS` (5 s foreground), charging `reconnectAttempt` against `OPENCODE_V2_MAX_RECONNECT_ATTEMPTS` (10). At the ceiling the attempt is terminal and retired; a manual `retry()` resets the budget and starts a fresh attempt.

**RT-004 — the key distinction (corrected).** Do **not** claim that the next `ensureBaseUrl()` detects a live, unresponsive process. `readyPromise` is **cached**: once resolved, subsequent `ensureBaseUrl()` calls return the cached promise without a fresh health probe (`serverManager.ts:302`). Detection of a **crashed** daemon happens via `onExit` (the child exited → `readyPromise` cleared → restart, if budget allows). A process that is **alive but unresponsive** (frozen, deadlocked, or an event stream that is open but silent) does **not** fire `onExit` and is not re-probed. The recovery paths are:

| Scenario | Detection mechanism | Classification |
|---|---|---|
| Process exits (crash) | `onExit` fires, `readyPromise` cleared, restart if budget allows | Source-confirmed; tested with fake child |
| Process alive but unresponsive (HTTP frozen) | **None** — next `ensureBaseUrl()` returns the cached promise; no active probe | **Verification gap** (RT-004) |
| Event stream open but silent | **None** — no stuck-stream detector after readiness | **Verification gap** (RT-008) |
| HTTP readiness failure during startup | `waitForHttpReady` timeout → `OpenCodeReadinessTimeoutError`, child killed | Tested (fake child, hermetic) |

**Guarantees.** Bounded readiness deadline (30 s backend for the probe; 20 s frontend for the gate wait only — see RT-012). Bounded exponential backoff with two ceilings. Terminal failure at budget exhaustion, with a manual retry seam. 401 on the readiness probe is reported with credential context.

**Limitations.** No active health check (RT-004). No stuck-stream detection (RT-008). The distinction between a crashed daemon and a live-but-unresponsive one is process-exit-only (RT-004). The deep real-server recovery suites are opt-in (RT-007).

**Evidence quality.** Source-confirmed for the caching and backoff mechanics; the two "no detection" rows are source-confirmed absences, not reproduced live.

### R3 — Session Lifecycle

**Current behavior.** `ensureOpenCodeSession` (`sessions.ts:239-372`) is single-flight per conversation (`sessionEnsuresInFlight` at `:258`, dedup at `:245-256`). If a stored `opencodeSessionId` exists it is probed for liveness via `fetchOpenCodeSession`; a stale pointer (server no longer knows it) logs `opencode.session_stale` and falls through to a fresh create (`:293-298`). The remote create happens **first** (`:358`), then the id is persisted (`:369`). `terminateOpenCodeSession` (`:448-504`) is interrupt-then-remove: it calls `session.interrupt` then `session.remove`, clears the pointer **only** when the remote removal succeeds, and returns `{ terminated: false, reason }` on `remote-removal-failed` or `unreachable`. It is idempotent and never throws for an absent session.

**Guarantees.** Singleflight prevents duplicate concurrent creates for one conversation. Stale-pointer detection prevents adopting a dead session id as live. Termination never clears the pointer on a failed removal, so a live session is not silently orphaned by the *termination* path.

**Limitations.** The create-before-persist ordering (RT-001) orphans the session if the persistence step fails. The termination path is safe *by itself*, but the **conversation-delete** path ignores its result (RT-011). A crash between remote create and persistence is unrecoverable from the TBAi side.

**Evidence quality.** Source-confirmed. No controlled test reproduces the RT-001 orphan outcome; the ordering is the evidence.

### R4 — Workspace Confinement & Permission Enforcement

**Current behavior.** The proxy mounts at `/api/opencode` (`routes/opencode.ts`) and forwards only allowlisted routes (`proxyRoutes.ts`, scopes `global` / `location` / `session`). `proxyAuthorization.ts` (`:93-143`) resolves a session-scoped request as sessionId → conversation (`conversationService.findByOpenCodeSessionId`) → `resolveConversationWorkspace` → absolute directory. A path/header session-id mismatch is 400; an unknown session or an unresolvable workspace is 403/400. The proxy strips `x-tbai-session`, `x-opencode-directory`, and `location[directory]` from forwarded requests so the client cannot redirect the server's working directory.

**RT-005 — the corrected boundary (do not overstate).** The proxy resolves the session id to a conversation (`proxyAuthorization.ts:122`) and then resolves that conversation's *current* workspace (`resolveConversationWorkspace`, `:129-130`). The source does **not** establish that it compares that current workspace with the remote OpenCode session's *actual* `location.directory`. `sessions.ts:302-306` and `:360-361` confirm the session is rooted in the *submitted* conversation workspace directory (the V2 `location.directory` response field is preferred, but it is read back, not reconciled against a live check). The confinement rule (request cannot redirect the directory; it is fixed from the folders table) is source-confirmed. What is *not* proven: that a mismatch between the session's *actual* on-disk directory and the conversation's *current* workspace causes cross-workspace file access, a refused session operation, or an event-subscription failure. Those consequences are **unverified** — no test demonstrates them — so only the confinement mechanism and the "directory is fixed, not request-supplied" rule are source-confirmed.

**Guarantees.** The allowlist refuses everything not named (a whitelist, not a blocklist) and is checked bidirectionally against the real client in tests. The session id is a selector only; the directory always comes from the folders table. Credentials are redacted in API responses (`configRedaction.ts`).

**Limitations.** Application-level authorization is not OS-level confinement: the OpenCode server runs with the TBAi process's OS privileges, so there is no filesystem sandbox or command-execution confinement (§8, §11). TBAi cannot revoke OpenCode's persistent "Always" permission rules. The proxy fixes the directory to the conversation's *current* workspace; it does not reconcile that against the session's actual `location.directory`, so the file-access/session-op/event-subscription consequences of a stale-workspace mismatch are unverified (RT-005).

**Evidence quality.** Source-confirmed for the allowlist/authorization mechanics and the confinement rule; the unproven mismatch consequences are flagged as unverified, not claimed.

### R5 — Transport & Event Streaming

**Current behavior.** The backend uses the official `@opencode/client` V2 client (`client.ts`) with an observing transport that records the last 8 responses per client (URL + status only; body untouched). `lastStatusForSessionLookup` reads status off responses for session-not-found detection, because the client throws `ClientError("UnsupportedContentType")` on empty 404 bodies and discards the status. The proxy forwards SSE with `extractEventType` parsing and `reader.cancel(reason)` on stream cancel. The frontend `v2Client.ts` creates a generation-scoped client with `connectionSignal` and `lifecycleSignal` abort signals; `eventPipeline.ts` manages the read loop, a coalesced buffer (`OPENCODE_V2_EVENT_BUFFER_LIMIT = 4096`), the retry timer, and the budget.

**RT-008 — the corrected boundary (open-but-silent vs disconnected).** A **disconnected** stream (read loop error, `result.done`, abort) *is* handled: it triggers the reconnect/backoff path and, at the ceiling, terminal failure. An **open-but-silent** stream (the SSE connection stays up but no events arrive, e.g. the server is wedged) has **no dedicated stuck-stream detector** — there is no "no event for N seconds" watchdog after readiness. Justifying severity: the impact is on **task progress and state freshness** (a silently wedged stream stalls every in-flight retry/task with no UI signal until the manual reconnect or the budget clock runs down elsewhere); it is *not* a data-loss or a crash path, hence Medium, not High.

**Guarantees.** The official client is used, not a hand-rolled JSON-RPC transport. Session-not-found is distinguishable from a generic server error via status observation. Stream cancellation propagates the abort signals. The buffer coalesces adjacent deltas per streaming target and drops oldest on overflow (counted). Event ordering is by message-ID identity, not by a server clock; ordinals are local counters that only answer "which buffered events arrived after the history read started."

**Limitations.** No stuck-stream detector after readiness (RT-008). Backpressure is native ReadableStream pull only; there is no application-level backpressure signal beyond the buffer limit. A silently wedged stream degrades task progress and state freshness until a manual reconnect.

**Evidence quality.** Source-confirmed. `client.test.ts` and `clientStatusObservation.test.ts` use fake/mocked transports; the absent stuck-stream detector is a source-confirmed absence.

### R6 — State Synchronization & Reconciliation

**Current behavior.** `v2ThreadController.ts` reconciles three streams of truth: **history** (`historyReplay.ts` merges server history with buffered live events), **live events** (`eventPipeline.ts` applies events by ordinal and message-id identity), and **optimistic message ids** (`optimistic.ts`, matched against the server's authoritative ids on the round-trip). `promptsInFlight.ts` tracks in-flight prompts so a reconnect does not double-submit; `retention.ts` bounds the in-memory retention sets. `recoveryEpoch` (and `recoveryEpoch.ts`) marks a generation boundary so a restarted attempt does not replay stale state as current. The retry/reuse state is projected honestly: a durable `session.retry.scheduled` record replayed during hydration becomes **transcript evidence only**, never a live countdown (confirmed in `v2RetryActivity.test.ts`).

**Guarantees.** The generation-lifecycle and attempt-scoped ownership mean a new connection cannot adopt a dead attempt's state. Optimistic ids are reconciled, not trusted. The no-fabricated-countdown invariant is test-covered. History and live events are merged by message-id identity, so a reconnect does not duplicate or reorder visible messages.

**Limitations.** Reconciliation is only as fresh as the event pipeline: a silent stream (RT-008) or a cached unresponsive daemon (RT-004) leaves the reconciled state stale with no active signal. The reconciliation correctness is proven for the tested paths; the open-but-silent degradation is a limitation, not a reproduced defect.

**Evidence quality.** Source-confirmed; the no-fabricated-countdown and optimistic-reconciliation invariants are test-covered (`v2RetryActivity.test.ts`, `v2History.test.ts`, `historyReplay.test.ts`).

### R7 — Abort & Cancellation Plumbing

**Current behavior.** Cancellation is intentionally split across four distinct mechanisms, and the corrected distinction is:

| Mechanism | Path | Effect |
|---|---|---|
| `inboxCancel` | `v2Client.ts:268-271` → `session.inbox.cancel` | Cancels a **queued** prompt by inbox id |
| `session.interrupt` | `v2Client.ts:260-263` → `session.interrupt` | Interrupts a **live** execution |
| HTTP request abort | `connectionSignal` / `lifecycleSignal` on the client | Aborts the in-flight fetch; a *queued* cancellation is fire-and-forget |
| Client-generation disposal | `v2ThreadController.dispose()` (`:1904-1915`): `pipeline.cancelReconnect()`, `retireAttempt`, `lifecycle.abort()`, `prompts.disposeAll()` | Tears down the whole generation |

`v2ThreadController` routes cancellation by execution state: for `submitting`/`reconciling` it dispatches `cancel_requested` (phase `prompt-request`); for `admitted` it calls `inboxCancel` and settles (`:1605-1618`); for `executing`/`streaming`/`cancelling` it calls `interrupt` (`:1620-1642`).

**RT-006 — the corrected boundary (narrowed to the asynchronous path).** Cancellation is state-routed, and the distinction is load-bearing:

- **Cancel requested *before* admission** → `cancelAdmittedPrompt()` (`v2ThreadController.ts:1577-1588`). This is the **asynchronous** path: `void ... inboxCancel(...)` is fired (`.catch` at `:1582-1586` logs `prompt_cancel_failed`) and `execution_settled` is dispatched **immediately** (`:1587`) — the UI settles *before* the inbox-cancel result is known. Callers: the "cancel owed" admission paths (`:702`, `:1512`).
- **Already-admitted queued prompt** → `cancel()` admitted branch (`:1605-1618`). This **awaits** `generation.operations.inboxCancel(...)` (`:1613`) *before* dispatching `execution_settled` (`:1617`). Not fire-and-forget.
- **Executing or streaming prompt** → `cancel()` execution branch (`:1620-1641`). Dispatches `cancel_requested` (phase `execution`), then **awaits** `session.interrupt(...)` (`:1640`) and calls `refresh()` **if the interruption is not confirmed** (`:1641`).

So the **settle-before-result-known** behavior is specific to the *pre-admission* `cancelAdmittedPrompt()` path, not to executing-state cancellation: the executing/streaming path does **not** settle before the interrupt result is known — it awaits and refreshes. The residual, unverified concern is the **race between an in-flight inbox cancellation and the prompt beginning execution** (a cancel that lands as `admitted` but whose execution starts before the cancel lands); that outcome is not established by a controlled test and remains an open question.

**Guarantees.** The four mechanisms are kept distinct and state-routed (pre-admission vs admitted-queued vs executing/streaming vs disposed). Disposal (`:1904-1915`) tears down all in-flight operations and the generation. Interrupt-before-remove in termination (R3) preserves the ordering contract.

**Limitations.** The pre-admission cancel is fire-and-forget and settles before the result is known (source-confirmed). The admitted-queued and executing/streaming paths await the cancellation result (source-confirmed). The inbox-cancel-vs-execution-start race is **unverified** — no controlled test establishes whether a cancel that arrives as `admitted` but whose execution has already begun is honored or ignored (RT-006).

**Evidence quality.** Source-confirmed for the state-routed distinction and for both the fire-and-forget and the awaited settle paths. The race outcome is marked unverified, not claimed.

---

## 5. Findings register

The register contains **exactly one entry per stable ID, RT-001 through RT-012.** IDs are preserved; no finding was merged into another or duplicated elsewhere. Evidence classes: **Reproduced**, **Source-confirmed**, **Verification gap**, **Design limitation.** Status and minimum closure evidence are explicit.

| ID | Title | Severity | Evidence class | Concrete failure path / limitation | Evidence-supported impact | Source & test references | Status | Minimum closure evidence |
|---|---|---|---|---|---|---|---|---|
| **RT-001** | Session-creation persistence race | High | Source-confirmed | `ensureOpenCodeSession` performs the remote `client.session.create` (`sessions.ts:358`) **before** `conversationService.update(conversationId, { opencodeSessionId })` (`:369`). A persistence failure (or a crash between the two steps) leaves a live remote session with no TBAi pointer. | The remote session is orphaned: TBAi holds no handle, nothing can remove it, and subsequent creates produce more orphans. **Source-confirmed ordering**; an orphan outcome has **not** been reproduced by a controlled test. | `src/services/opencode/sessions.ts:239-372`; the mocked create/adopt/error paths live in `tests/unit/opencode/sessions.test.ts` and `tests/unit/opencode/sessions-concurrency.test.ts` (both mock the client and storage; neither exercises the create→persist failure window) | Open | A controlled test that forces `conversationService.update` to fail immediately after a successful remote create and asserts the resulting state (orphan is detected/recorded or the create is retried against a persisted pointer). Until then the finding stands as source-confirmed ordering, not a reproduced defect. |
| **RT-002** | Remote-removal failure retains the pointer | Medium | Design limitation | `terminateOpenCodeSession` (`sessions.ts:448-504`) returns `{ terminated: false, reason }` on `remote-removal-failed` / `unreachable` and **retains** the persisted pointer by design: clearing it while the server still holds the session would orphan the only handle to a live session. The intended behavior is "never clear a pointer to a session we could not confirm is gone." | The retention is correct *for the termination path*. The separate concern is what happens when the owning **conversation row is deleted** while the pointer is still retained — that is **RT-011**, not a defect of the retention itself. | `src/services/opencode/sessions.ts:448-504` (the `remote-removal-failed` / `unreachable` branches at `:475-497`); the pointer-clear-only-on-success rule at `:498` | Open (by design) | No code change is the correct disposition for the retention itself. Closure = documentation confirming the retention is intentional and that the delete-path consequence is owned by RT-011. |
| **RT-003** | Database-lease failure-path retention | Low (downgraded from Medium; demonstrated impact unproven) | Source-confirmed | Distinguishing the paths: (a) the lease is acquired **before** port allocation and child spawn (`serverManager.ts:357`); (b) a synchronous port-allocation or spawn error between acquisition (`:357`) and the readiness `try` block (`:380`) escapes the inner catch and leaves the lease held with **no** child, but the **outer** rejection handler in `ensureBaseUrl()` (`:308-311`) still clears the cached `readyPromise` when the attempt rejects, so no failed start is cached; (c) readiness-timeout and post-readiness ownership-verification failures are handled by the inner catch (`:403-431`), which clears `child`/`port`/`readyPromise` and SIGKILLs the child but **does not call `databaseLease.release()`**; (d) the post-acquisition `stopping` branch (`:358-360`) *does* release the lease (throws `OpenCodeReadinessCancelledError` after `release()`); (e) automatic restart re-enters `acquire()`, which returns the *existing* lease for the same ownership instance (`ownership.ts:238-240`) - so a retry by the **same manager** reuses the held lease, it is **not** blocked; (f) restart exhaustion and `shutdown()` (which *does* release, `:535`) are the other release paths; (g) a **second** manager/ownership instance attempting the same DB path is refused by the named mutex (`acquire` throws `OpenCodeDatabaseBusyError` when the mutex is already held, `ownership.ts:265-270`). Net: both the synchronous port/spawn-error path before the inner `try` and the readiness/ownership-verification catch can retain the lease without calling `release()`. `readyPromise` is cleared by the outer handler on **every** failed start, and the lease is also released on the post-acquisition stopping branch, on restart exhaustion, and on `shutdown()`. | Retained-lease impact is **demonstrated only for (g)**: a foreign second manager is refused by the mutex, which is the *intended* fail-closed behavior - not a defect. For the same-manager case, retention is consistent with a manager-lifetime reservation and does **not** block retries. Unproven: whether the post-failure held lease is a *correctness* hazard (e.g. masking a later legitimate foreign-holder refusal) or merely redundant. No controlled test demonstrates a user-visible defect from the retention, so the finding is reclassified as a source-confirmed observation with **unproven impact**, not a certification blocker. | `src/services/opencode/serverManager.ts:354-431` (acquire `:357`; post-acquisition stopping release `:358-360`; pre-`try` port/spawn `:362-369`; catch `:403-431`); `:297-314` (`ensureBaseUrl` outer rejection handler clears `readyPromise`); `:509-536` (`shutdown` releases at `:535`); `src/services/opencode/ownership.ts:238-329` (`acquire` return-exists `:240`, mutex-busy refusal `:265-270`, `release` `:323-329`); `tests/integration/opencode/serverManager.test.ts` (fake child, no-op lease - does not exercise failure-path release); `tests/unit/opencode/ownership.test.ts` (isolated acquire/release/mutex-refusal, not cross-failure) | Open (non-blocking; documentation or a release-on-failure change) | Either document the manager-lifetime retention as the intended contract (noting that the second-manager mutex refusal is the actual safety mechanism and that the outer handler clears `readyPromise` on every failed start), or implement lease release for **both** failure paths: synchronous port-allocation/spawn errors before the inner `try`, and readiness/ownership-verification failures in the inner catch. If choosing release-on-failure, add controlled tests for each path that assert `databaseLease.release()` is called. Retain as a certification blocker **only** if a consistency proof is later established that the retention masks a foreign-holder refusal. |
| **RT-004** | Unresponsive daemon not detected | Medium | Verification gap | `ensureBaseUrl()` returns the cached resolved `readyPromise` without re-contacting the server (`serverManager.ts:302`). Recovery is `onExit`-driven (`:471-507`). A process that is alive but HTTP-unresponsive does not fire `onExit`, so no restart and no fresh health probe occur. | A wedged-but-alive daemon is indistinguishable from a healthy one by the current recovery paths. **Process-exit recovery works**; **active health checks are absent.** The impact is a silent stall, not data loss. | `src/services/opencode/serverManager.ts:297-314` (caching), `:471-507` (`onExit`); no periodic probe exists in the module (source-confirmed absence); `tests/integration/opencode/serverManager.test.ts` covers crash-restart with a fake child only | Open | Either an active health-check/liveness probe after readiness, or explicit documentation that live-but-unresponsive detection is out of scope with the user-visible stall behavior. A test of the "alive but unresponsive" case is not currently possible without a probe. |
| **RT-005** | Workspace-directory mismatch | Low | Source-confirmed (confinement rule) / unverified (consequences) | `proxyAuthorization.ts` (`:93-143`) resolves the session id to the conversation (`:122`) and then to the conversation's **current** workspace (`:129-130`), fixing the forwarded directory there; the request cannot redirect it. The source does **not** establish that the proxy compares that current workspace against the remote OpenCode session's *actual* `location.directory` (the session is rooted in the submitted directory; see `sessions.ts:302-306`, `:360-361`). | The **confinement rule** (directory is fixed from the folders table, not request-supplied) is source-confirmed. The report does **not** claim the proxy refuses a mismatch between the session's actual directory and the conversation's current workspace. The consequences of such a mismatch — file access in the wrong workspace, refused session operations, or broken event subscriptions — are **unverified** unless a test proves them. | `src/services/opencode/proxyAuthorization.ts:93-143`; `src/services/opencode/sessions.ts:302-306`, `:360-361`; `src/services/opencode/proxyRoutes.ts:70-94` (scopes); `tests/integration/opencode/opencode-proxy-allowlist.test.ts` (allowlist + refusal paths) | Open (low) | A test that creates a session in one folder, then drives a proxied request against a conversation whose current workspace was moved, and asserts the actual outcome. Until such a test exists, keep the confinement rule source-confirmed and mark all mismatch consequences unverified. |
| **RT-006** | Cancellation: settle before result known (narrowed to the async pre-admission path) | Medium | Verification gap | Cancellation is state-routed (`v2ThreadController.ts:1590-1642`): (a) cancel requested *before* admission → `cancelAdmittedPrompt()` (`:1577-1588`) fires `void ... inboxCancel(...)` (`:1581`) and dispatches `execution_settled` **immediately** (`:1587`) — settle-before-result-known, **asynchronous**; (b) already-admitted queued prompt → `cancel()` awaited `inboxCancel()` (`:1613`) **before** settling (`:1617`); (c) executing/streaming prompt → `cancel()` awaited `session.interrupt()` (`:1640`) and refreshes if unconfirmed (`:1641`). The mechanism split (`inboxCancel` `v2Client.ts:268-271`, `interrupt` `:260-263`, HTTP abort via `connectionSignal`/`lifecycleSignal`, generation disposal `:1904-1915`) is source-confirmed. | The settle-before-known concern is **narrowed to path (a)** — the pre-admission `cancelAdmittedPrompt()` path. Executing-state cancellation does **not** settle before the interrupt result is known (path (c) awaits it). The unverified concern is the **race between an in-flight inbox cancellation and execution beginning** (a cancel that lands as `admitted` but whose execution has already started); that outcome is not established by a controlled test and is not claimed. | `web/src/features/opencode/v2ThreadController.ts:1577-1588` (async path), `:1605-1618` (admitted awaited), `:1620-1641` (executing/streaming awaited interrupt), `:1904-1915` (dispose); `web/src/features/opencode/v2Client.ts:260-271`; `tests/unit/web/opencode/v2InboxCancellation.test.ts` (queued cancel only) | Open | A controlled test that establishes the inbox-cancel-vs-execution-start race outcome (does a cancel arriving as `admitted` still honor a prompt that has begun executing?), or documents the pre-admission fire-and-forget settle as the accepted contract with matching degraded-state copy. Do **not** claim executing-state cancel settles before the interrupt result. |
| **RT-007** | CI coverage is opt-in for the real-server suites | Medium | Verification gap | The default `verify` and `e2e` jobs install OpenCode CLI (2.1.2 at audit time; 2.2.0 since 2026-10-28) (`.github/actions/install-opencode`) but **never set `TBAI_OPENCODE_RUNTIME_TESTS`** (`tests/harness/opencodeRuntimeHarness.ts:41,62-66` is the only consumer). All 8 deep real-server integration suites (`opencode-retry-runtime`, `opencode-retry-restart`, `opencode-database-compat`, `opencode-ownership-runtime`, `opencode-context-meter-runtime`, `opencode-native-compaction-conformance`, `opencode-stub-provider-spike`, `opencode-runtime-auth`) self-skip. The only OpenCode E2E spec the default `e2e` job runs is `opencode-v2-code-route.spec.ts` (`tests.yml:331-340`). | Crash-recovery, hard-kill, restart-exhaustion, and cross-version (2.0.15/2.0.22) behavior are unproven in the standard gate. The default E2E job runs an **explicit 7-file subset**, not "every spec in the repository"; the 6 `-live.spec.ts` OpenCode specs are excluded unless `TBAI_E2E_LIVE=1`. | `.github/workflows/tests.yml:52-340` (`verify` + `e2e` jobs), `:382-427` (`e2e-big-pickle`, gated on `live_opencode`); `scripts/run-e2e.ts:87-102` (spec selection); `web/playwright.config.ts:44-45,67` (live-spec exclusion); `tests/harness/opencodeRuntimeHarness.ts:41,62-66` (opt-in gate) | Open | A CI job or a documented opt-in invocation that sets `TBAI_OPENCODE_RUNTIME_TESTS=1` (plus `OPENCODE_BINARY`) and runs the 8 gated suites, with the results attached to the gate; and a separate opt-in `TBAI_E2E_LIVE=1` run for the 6 live specs. Distinguish this clearly from the ordinary real-server Code-mode coverage (`opencode-v2-code-route`, non-live) that already runs. |
| **RT-008** | No stuck-stream / silent-stream detector | Medium | Verification gap | After readiness, the event pipeline has no "no event for N seconds" watchdog. A disconnected stream (read error, `done`, abort) is handled by reconnect/backoff (`eventPipeline.ts:471-512`), but an **open-but-silent** stream is not distinguished from a healthy one. | Impact is on **task progress and state freshness**, not data loss: a silently wedged stream stalls every in-flight retry/task with no UI signal until a manual reconnect or the reconnect clock. The open-but-silent case is a Verification gap; the disconnected case is covered. | `web/src/features/opencode/sync/eventPipeline.ts:455-469` (read loop), `:471-512` (reconnect budget), `:557-560` (buffer overflow); no heartbeat/stuck watchdog exists in the module (source-confirmed absence); `tests/unit/web/opencode/eventPipelineBuffer.test.ts`, `eventBufferOverflow.test.ts` (buffer only, not silence) | Open | A stuck-stream detector (idle-timeout on the open stream that triggers the same reconnect/terminal path as a disconnect), with a test that a connected-but-silent stream is detected and reconnected. Distinguish it explicitly from the disconnected-stream path that already exists. |
| **RT-009** | Frontend/backend timeout mismatch | Low | Source-confirmed | The frontend readiness deadline `OPENCODE_V2_READY_TIMEOUT_MS = 20_000` (`web/src/features/opencode/config.ts:33`) is shorter than the backend startup deadline `startupTimeoutMs = 30_000` (`src/config/opencode.ts:17`). The value mismatch is source-confirmed. | The *claimed* user-visible timing consequence — that the UI reports a readiness timeout at 20 s while the backend still probes to 30 s — is **unverified**: it depends on the actual request path and no test establishes it. In particular, `awaitReady()` awaits `ensureLoaded()` (connection + hydration) *before* applying the remaining deadline to the gate (`v2ThreadController.ts:1356-1381`), so the observed user-visible timing is not simply "20 s vs 30 s." A guaranteed false failure at 20 s is **not** claimed. This remains a *distinct* Low risk from RT-012, which is the source-confirmed finding that the gate deadline does not bound the complete connection-and-hydration sequence. | `web/src/features/opencode/config.ts:33`; `src/config/opencode.ts:17`; `web/src/features/opencode/v2ThreadController.ts:1356-1381` (`awaitReady`); `web/src/features/opencode/sync/startupGate.ts:142-161`; `tests/unit/web/opencode/sessionBootstrap.test.ts`, `retryCountdown.test.ts` | Open | Trace the actual request/readiness sequence and confirm with a test the user-visible timing consequence; or document the intentional divergence with the *measured* outcome. Do not assert a guaranteed false failure at 20 s. |
| **RT-010** | Non-Windows process-ownership no-op | Low | Design limitation | On non-Windows platforms the database-ownership no-op (`ownership.ts:239` returns `null` off-Windows) and `detached: process.platform !== "win32"` (`serverManager.ts:344`) mean the named-kill-on-close job chain and the per-DB mutex are **not** enforced; a child can outlive an ungraceful TBAi death on Unix. | This is a platform limitation, not a defect on the supported product platform (Windows x64 is the packaging target). It is **not** a certification blocker for the Windows x64 artifact; it is a documented limitation for any non-Windows deployment. | `src/services/opencode/ownership.ts:239`; `src/services/opencode/serverManager.ts:344`; `tests/integration/opencode/ownership.test.ts` (non-Windows no-op case at `:100`); `src-tauri/src/shell_job.rs` (Windows kill-on-close job, no Unix equivalent) | Open (documented limitation) | No code change required for the Windows artifact. Closure = a documented statement that non-Windows process-ownership/leak behavior is a known limitation, with the Windows kill-on-close job as the enforced mechanism. It becomes a blocker only if a non-Windows platform is a supported product target — that decision is outside this audit. |
| **RT-011** | Session handle lost on conversation deletion | High | Source-confirmed | `DELETE /api/conversations/:id` (`routes/conversations.ts:483-522`) awaits `terminateOpenCodeSession(id)` (`:490-503`) but **ignores its return value** (only the exception is caught and logged). The delete then proceeds: `messageService.deleteByConversation` and `conversationService.delete` (`:504-505`) run regardless of the termination outcome. | If remote removal fails (the `{ terminated: false }` case that RT-002's retention path intentionally preserves), the persisted `opencodeSessionId` pointer is retained on the row — and the row is then destroyed. TBAi's only handle to a possibly-live remote session is eliminated; the session can never be removed by TBAi. | `src/routes/conversations.ts:483-522` (the ignored result at `:490-503` and the row deletion at `:504-505`); the retention contract in `src/services/opencode/sessions.ts:448-504`; `tests/integration/core/engine-guards.test.ts` (the `test:quarantine`-adjacent delete cases use a service seam and do not assert the lost-handle consequence) | Open | A test that drives a delete where `terminateOpenCodeSession` returns `{ terminated: false, reason: "remote-removal-failed" }` and asserts either (a) the conversation row is not deleted, or (b) the live session is recorded/orphan-detected so the lost handle is not silent. Until then the finding stands as source-confirmed. |
| **RT-012** | End-to-end startup deadline not established | Medium | Source-confirmed | `awaitReady()` (`v2ThreadController.ts:1356-1381`) computes `deadline = now + readyTimeoutMs`, then calls `await ensureLoaded()` (`:1360`) **before** applying the remaining deadline to `live.gate.waitWithDeadline(remaining)` (`:1374`). `ensureLoaded()` runs the connection + hydration phase with **no** deadline of its own. | The `OPENCODE_V2_READY_TIMEOUT_MS = 20_000` gate bounds only the *readiness-gate wait*, not the preceding connection-and-hydration phase. A connection or hydration promise can remain unresolved beyond the advertised figure, so the gate timeout does **not** establish an end-to-end connection-and-hydration deadline. This is distinct from RT-009 (timeout value mismatch). | `web/src/features/opencode/v2ThreadController.ts:1280-1290` (`ensureLoaded`), `:1356-1381` (`awaitReady` ordering); `web/src/features/opencode/sync/startupGate.ts:142-161` (`waitWithDeadline` bounds only the gate promise); `web/src/features/opencode/config.ts:33`; `tests/unit/web/opencode/v2ThreadController.baseline.test.ts`, `sessionBootstrap.test.ts` | Open | A controlled test that forces `ensureLoaded()` (connection or hydration) to stall past the advertised deadline and proves `awaitReady()` rejects or times out within the end-to-end budget. Merely documenting an unbounded stall does **not** close this Tier 1 reliability blocker. |

**Register integrity check:** RT-001 through RT-012 each appear **exactly once** in the table above. No finding was merged, deleted, or duplicated. RT-002 and RT-011 are kept distinct: RT-002 is the *intentional pointer-retention design*; RT-011 is the *delete-path consequence* of that retention. RT-004 and RT-008 are kept distinct: RT-004 is the *absent active health check* (live-but-unresponsive daemon); RT-008 is the *absent stuck-stream detector* (open-but-silent stream). RT-009 and RT-012 are kept distinct: RT-009 is the *frontend/backend budget mismatch*; RT-012 is the *missing end-to-end deadline* around connection + hydration.

---

## 6. Test and CI coverage matrix

Coverage is separated into the eight categories below. A successful workflow is **not** represented as proof of an unexecuted scenario.

| Category | What it covers | Entry point / gate | What it actually proves |
|---|---|---|---|
| **Mock-based unit tests** | Frontend controller/pipeline/reducer logic; backend session/capability/config logic; proxy allowlist round-trip against the real client with a fake transport | `bun run test` → `tests/unit/web/opencode/*.ts` (61 files), `tests/unit/opencode/*.ts` (15 files) | Unit-level behavior of state machines, budgets, and allowlists; **not** process, network, or database behavior |
| **Fake-child lifecycle tests** | `serverManager` spawn/readiness/restart/shutdown against a fake `Subprocess` and a no-op database lease | `tests/integration/opencode/serverManager.test.ts` | Readiness-timeout kill, exit-during-readiness single restart, restart-budget exhaustion, SIGTERM→SIGKILL shutdown. **Not** real child, **not** real lease release on failure (RT-003 gap) |
| **Default real-managed-server E2E** | The single OpenCode E2E spec in the default `e2e` job, driving a real managed `opencode serve` 2.1.2 with no live model call (prompt refused, refusal surface asserted) | `bun run test:e2e opencode-v2-code-route.spec.ts` (`.github/workflows/tests.yml:331-340`); the 7-file default subset | The real managed server starts and the real V2 runtime round-trips on the default gate. **Not** crash/restart/cross-version, **not** the 6 live specs |
| **Opt-in real-server integration tests** | The 8 deep suites: retry-runtime, retry-restart, database-compat, ownership-runtime, context-meter-runtime, native-compaction-conformance, stub-provider-spike, runtime-auth | `TBAI_OPENCODE_RUNTIME_TESTS=1` (+ `OPENCODE_BINARY`) → `bun test tests/integration/opencode` | Real-server retry/restart/ownership/cross-version behavior. **Not** run by default CI (RT-007) |
| **Opt-in live-model Playwright tests** | The 6 `-live.spec.ts` OpenCode E2E specs against a real managed server with a live model | `TBAI_E2E_LIVE=1` → `bun run test:e2e opencode/<spec>.ts`; gated by `web/playwright.config.ts:44-45` and `scripts/run-e2e.ts:62` | Live-model task completion/permission/edit flows. **Not** run by default CI |
| **Packaged Tauri build and smoke tests** | The `tauri` job (tests.yml) and `tauri-build.yml`: build the Rust shell, build Tauri, assemble the portable app, smoke-test the sidecar | `tauri` job smoke step (`tests.yml:516-560`); `tauri-build.yml:146-203` | The packaged app compiles and the sidecar serves. **Not** a proof that killing the shell kills the OpenCode child — see the "Shell-kill child-cleanup evidence" row below. |
| **Forced shell termination** | The Tauri smoke `finally` block forcibly stops the launched `TBAi.exe` (`$proc.Id`) and, by name, `tbai-server` (`tests.yml:555-560`) | `tauri` job cleanup | The test cleanup terminates the two processes it launched. **Not** a proof of automatic child-cleanup on shell death |
| **Shell-kill child-cleanup evidence (fixture + real-server, not packaged)** | The G2 named-kill-on-close job chain (Rust shell → sidecar → children) that reclaims the OpenCode grandchild when the shell dies | Four distinct levels: **(1)** `tests/integration/opencode/process-ownership.test.ts` — fixture shell/sidecar/grandchild processes, **no real OpenCode**; proves the named-job mechanism in isolation. **(2)** `tests/integration/opencode/opencode-ownership-runtime.test.ts` — a **real 2.1.2 OpenCode child** with the shell fixture (opt-in, Windows); proves real-server ownership. **(3)** the Tauri build + smoke (`tauri` job `tests.yml:516-560`, `tauri-build.yml:146-203`) — proves the packaged app compiles and the sidecar serves; the smoke is **graceful** start/stop. **(4)** the packaged cleanup (`tests.yml:555-560`) forcibly stops **both** `TBAi.exe` and `tbai-server` by name. | Levels (1)–(2) are **meaningful evidence for the named-job mechanism** and for real-server ownership. Level (4) is **manual, separate termination of both processes** and does **not** prove the packaged Rust shell automatically terminates the child when the shell *alone* is killed. **The exact packaged-desktop hard-kill guarantee — kill only `TBAi.exe` and observe the Rust shell's named-job chain reclaiming the OpenCode grandchild — is UNVERIFIED:** no test exercises the packaged desktop executable in that way. Classify it unverified, not proven. |

### CI runs and job conclusions (verified against workflow files; runs are in-repo references, not live-fetched)

- **`verify` job** (`.github/workflows/tests.yml:52-250`): typecheck, lint, format:check, test:locations, build, `bun run test`, test:shutdown, test:startup-rollback, test:lifecycle-integration, test:dom, test:quarantine. Provisions OpenCode CLI 2.2.0 (integrity-checked; 2.1.2 at audit time, and the 2.2.0 pin has not yet run on a runner). All steps independent; no `needs:`.
- **`e2e` job** (`tests.yml:268-340`): test:locations + a scoped `test:e2e` over an explicit 7-file subset; the only OpenCode spec is `opencode-v2-code-route.spec.ts`.
- **`e2e-big-pickle` job** (`tests.yml:355-427`): **skipped on every push/PR**; runs only on `workflow_dispatch` with `live_opencode=true` (`if: github.event_name == 'workflow_dispatch' && inputs.live_opencode`). It runs the `opencode-big-pickle-live.spec.ts` live model suite with `TBAI_E2E_LIVE=1`.
- **`tauri` job** (`tests.yml:432-576`): Rust type-check, Rust tests, Tauri build, portable assembly, packaged-app smoke test (graceful start/stop).
- **In-repo run references (not live-fetched this session):** `docs/2026-10-23-opencode-retry-and-recovery-plan.md` references workflow run `39930829361` (commit `029229e`, G1 packaged-app) and `39951140626` (commit `fe10255`); `docs/decisions.md` references run `39160063675` (commit `697cfa3`) and run `39379368389` (live spec). These are human-written cross-references, **not** in-repo log captures. No Actions log or status file is committed; live results require the GitHub UI.

---

## 7. Security assessment

The security boundary has four layers that must not be conflated:

1. **TBAi server-side proxy allowlist + workspace authorization.** `proxyRoutes.ts` is a whitelist (not a blocklist), checked bidirectionally against the real client. `proxyAuthorization.ts` resolves every session-scoped request to the folder-table directory and refuses unknown sessions, mismatched ids, and unresolvable workspaces. The proxy strips the client-controlled directory headers. **Source-confirmed; test-covered.**
2. **OpenCode's own permission system.** The managed child enforces allow/ask/deny rules on its own operations (file edits, shell commands, etc.). This is OpenCode's responsibility, not TBAi's. TBAi only reads/edits the config document with redaction; it does not re-implement OpenCode's permission engine.
3. **Absence of TBAi-enforced OS-level sandboxing.** TBAi's authorization is application-level. The OpenCode server runs with the TBAi process's OS privileges; there is **no** OS-level filesystem sandbox or command-execution confinement enforced by TBAi. A malicious or misconfigured OpenCode tool that bypasses its own permission rules is not contained by TBAi. **Design limitation, not a defect** (RT-005 / §11).
4. **Persistent OpenCode "Always" permissions that TBAi cannot revoke.** OpenCode's persistent permission grants (e.g. "Always allow" for a tool/command) live in OpenCode's config and outlive any single session. TBAi cannot revoke them from inside the subsystem; that is OpenCode's data. **Design limitation.**

**Secret handling:** the OpenCode server's auth credential is generated under **both** env names (`OPENCODE_PASSWORD` for 2.0.22, `OPENCODE_SERVER_PASSWORD` for earlier 2.0.x; `serverManager.ts:325-329`). Config responses are redacted by `configRedaction.ts`. No secret is exposed to the browser; the browser sends identifiers, not keys.

---

## 8. Cross-component failure scenarios

These are the composite failure paths that no single component's test covers on its own. They are the highest-value scenarios for the opt-in suites (RT-007).

| # | Scenario | Components involved | Expected honest outcome |
|---|---|---|---|
| 1 | **Crash between remote create and persistence** | `sessions.ensureOpenCodeSession` (RT-001) + `storage.conversations` | Either the orphan is detected and a new pointer is not created against a dead id, or the create is made idempotent. Currently: orphan (unreproduced). |
| 2 | **Converged delete with a live-but-unreachable session** | `routes.conversations` DELETE (RT-011) + `sessions.terminate` (RT-002) | The delete does not silently lose the only handle. Currently: row destroyed, handle lost if removal failed. |
| 3 | **Live-but-frozen daemon wedges the UI** | `serverManager` (RT-004) + `eventPipeline` (RT-008) + `v2ThreadController` | An active health probe or a stuck-stream watchdog surfaces the wedge. Currently: silent stall until manual reconnect. |
| 4 | **Readiness timeout leaves the lease held, then a second manager starts** | `serverManager` (RT-003) + `ownership` | The second manager is refused by the named mutex (correct) or the lease is released on failure. Currently: same-manager reuse works; second-manager block is by design; failure-path release is not tested. |
| 5 | **Session whose actual directory has gone stale (folder moved since create)** | `proxyAuthorization` (RT-005) + `v2ThreadController` (R6) | **Pinned behavior (source-confirmed):** the proxy always resolves the directory from the conversation's *current* folder-table workspace (`proxyAuthorization.ts:129-130`); the request cannot redirect it. **Unverified consequence:** what actually happens when the session's *real* on-disk directory (its `location.directory`) no longer matches that current workspace — whether file access lands in the wrong workspace, the session operation is refused, or the event subscription breaks. No test establishes that outcome. The scenario is a live question, not a proven refusal: do **not** describe the proxy as "refusing the mismatched directory." |
| 6 | **Cancellation lands as execution begins (the three distinct paths)** | `v2ThreadController` (RT-006) + `client` (R7) | Three source-confirmed paths: **(a)** pre-admission cancel → `cancelAdmittedPrompt()` fires `void ... inboxCancel(...)` and settles immediately (settle-before-result-known, the only fire-and-forget path); **(b)** already-admitted queued prompt → `cancel()` awaits `inboxCancel()` before settling; **(c)** executing/streaming prompt → `cancel()` awaits `session.interrupt()` and refreshes if unconfirmed. **Unverified consequence:** the inbox-cancel-versus-execution-start race — a cancel that arrives as `admitted` but whose execution has already begun. A test must establish whether that cancel is honored or ignored; the fire-and-forget path (a) is a documented settle-before-known behavior, while (b) and (c) do **not** settle before the result is known. |
| 7 | **Startup stall beyond the advertised deadline** | `v2ThreadController.awaitReady` (RT-012) + `startupGate` | An end-to-end connection+hydration deadline is enforced and tested; documentation alone does not close this Tier 1 blocker. Currently: only the gate wait is bounded. |
| 8 | **Non-Windows ungraceful death orphans the child** | `serverManager` (RT-010) | The kill-on-close job chain reclaims the child. Currently: enforced on Windows only; a documented limitation elsewhere. |

---

## 9. Verified strengths

Prior findings F1–F3 from `docs/2026-09-17-lifecycle-hardening.md` are **verified as fixed in the current source**:

- **F1 (readiness-timeout orphaning the child):** FIXED. The `start()` catch (`serverManager.ts:403-431`) SIGKILLs the child on `OpenCodeReadinessTimeoutError` and the database-ownership failure modes before rethrowing, and guards state-clearing with `if (this.child === child)` so a newer restart is never clobbered. A slow-starting server cannot become an orphan.
- **F2 (exit-during-readiness clobber race):** FIXED. The `this.child === child` guard (`:406`) means `onExit` (child B) replacing `this.child` is not clobbered by the older attempt's catch. No duplicate-child tracking loss.
- **F3 (restart-budget reset on every attempt):** FIXED. `restartAttempts = 0` is reset **after** successful readiness (`:434`), not at the top of `start()`. Consecutive failed restarts accumulate toward `maxRestartAttempts` (3); a successful start resets the budget.

Additional source-confirmed strengths:

- **Single-flight startup:** `ensureBaseUrl()` shares one promise across concurrent/repeated callers (`:297-314`); no multiple servers or independent readiness loops.
- **Fail-closed database ownership:** unresolvable path, held mutex, foreign holder, or unanswerable Restart Manager query all refuse startup (`ownership.ts:238-329`); a foreign holder is never killed, only refused.
- **Interrupt-before-remove termination:** `terminateOpenCodeSession` never clears a pointer to a session it could not confirm is gone (`sessions.ts:448-504`), so the *termination* path alone does not orphan a live session.
- **Bidirectional allowlist:** the proxy allowlist is checked against the real client in both directions in tests (`opencode-proxy-allowlist.test.ts`, `v2ClientProxyRoutes.test.ts`), so a missing entry is caught, not silently forwarded.
- **No-fabricated-countdown invariant:** a durable `session.retry.scheduled` record replayed during hydration becomes transcript evidence only, never a live countdown (`v2RetryActivity.test.ts`).

---

## 10. Audit limitations and open questions

- **Snapshot is unpublished.** The audit snapshot `9cc7c29` is not on the public remote; its source is byte-identical to the public `fe10255`, so every citation is reproducible against `fe10255`, but the snapshot itself cannot be independently checked out from the public branch.
- **No live Actions results in this session.** CI evidence is derived from the workflow files and in-repo prose references to specific runs; no run result was live-fetched or log-verified here. The "successful workflow ≠ proof of unexecuted scenario" rule is applied throughout §6.
- **No local OpenCode binary.** Live-server claims (RT-004, RT-006, RT-008, the cross-version G4 path) are source-confirmed or gated-opt-in, not reproduced in this session.
- **Open questions for a future re-audit:** (a) Is a second-manager cross-process block on the held DB lease desired or accepted as a process-lifetime reservation (RT-003)? (b) Should the frontend/backend timeout divergence (RT-009) be aligned or documented? (c) Is a non-Windows platform ever a supported target (RT-010)? (d) What is the outcome of the **inbox-cancel-versus-execution-start race** (RT-006) — a cancel that arrives as `admitted` but whose execution has already begun: is it honored or ignored? (This is the specific unresolved question; the pre-admission fire-and-forget settle is a documented behavior, and the admitted/executing paths already await the result.)

---

## 11. Certification decision and closure criteria

**Decision: Hold.** The subsystem is not certified reliable. The Hold rests on the **Tier 1 mandatory blockers** (RT-001, RT-011, RT-008, RT-012, RT-007): two High source-confirmed orphan-handle defects (RT-001, RT-011), two Medium source-confirmed reliability gaps (no stuck-stream detector; no end-to-end startup deadline), and a **coverage gap** (RT-007) — crash-recovery, hard-kill, restart-exhaustion, and cross-version behavior are unproven in the standard gate, and a reliable-subsystem certification requires those behaviors to be exercised by the real-server and live-model suites. The **Tier 2** findings (RT-003, RT-004, RT-006, RT-009, RT-010) close through documented scope or accepted behavior and, on their own, do not hold the verdict — in particular **RT-006** (the pre-admission fire-and-forget cancel; the admitted/executing paths already await the result; the inbox-cancel-vs-execution-start race is open) is an accepted-behavior/documentation item, not a mandatory blocker. The Hold is justified on evidence, not on style.

Certification items fall into **two tiers**. The distinction is load-bearing and is stated once here so §2 and §11 cannot diverge:

- **Tier 1 — Mandatory blockers** (a necessary reliability guarantee; the verdict is Hold until closed by the stated evidence): RT-001, RT-011, RT-008, RT-012, RT-007.
- **Tier 2 — Close through documented scope or accepted behavior** (no user-visible reliability defect is demonstrated; closed by documentation, an explicit out-of-scope statement, or an optional hardening — not by a mandatory test): RT-003, RT-004, RT-006, RT-009, RT-010.

#### Tier 1 — Mandatory certification blockers → closure evidence

| Blocker | Finding | Minimum closure evidence |
|---|---|---|
| No orphaned remote session on creation | **RT-001** | A controlled test forcing `conversationService.update` to fail right after a successful remote create, asserting the orphan is detected/recorded or the create is made idempotent against a persisted pointer. |
| No lost session handle on delete | **RT-011** | A delete-path test where `terminateOpenCodeSession` returns `{ terminated: false, reason: "remote-removal-failed" }` and asserting the row is not silently destroyed (or the live session is recorded so the lost handle is not silent). |
| Stuck-stream detection | **RT-008** | An idle-timeout watchdog on the open stream that triggers the same reconnect/terminal path as a disconnect, plus a connected-but-silent test. |
| End-to-end startup deadline | **RT-012** | A controlled test stalls `ensureLoaded()` past the deadline and proves `awaitReady()` rejects or times out within a bounded end-to-end connection+hydration deadline. Documentation of an unbounded stall alone is insufficient. |
| Required real-server + live-model certification evidence | **RT-007** | The real-server and live-model test runs are **required** to close certification: a CI job (or a documented opt-in invocation) that sets `TBAI_OPENCODE_RUNTIME_TESTS=1` and runs the 8 gated suites with results attached to the gate, plus a separate `TBAI_E2E_LIVE=1` run for the 6 live specs. **Documenting the coverage gap as a limitation is not sufficient** — it only records the residual risk that crash-recovery, hard-kill, restart-exhaustion, and cross-version behavior remain unproven. A reliable-subsystem certification cannot stand on "this is untested"; the runs must exist and pass. |

#### Tier 2 — Closed by documented scope / accepted behavior (not mandatory blockers)

| Finding | Disposition | Minimum closure evidence |
|---|---|---|
| **RT-003** (lease failure-path retention; Low, non-blocking) | Accepted behavior / optional hardening | Document the manager-lifetime retention as the intended contract, noting the actual safety mechanism is the named-mutex refusal of a *second* manager (`ownership.ts:265-270`) and that the outer `ensureBaseUrl()` handler clears the cached `readyPromise` on every failed start (so no failed start is cached). A release-on-failure change covering both the pre-readiness synchronous port/spawn-error path and the readiness/ownership-verification catch, with controlled tests for both, is **optional** — required only if a later proof shows the retention masks a foreign-holder refusal. |
| **RT-004** (no active health check) | Out-of-scope statement acceptable | An active health/liveness probe after readiness, **or** an explicit out-of-scope statement with the user-visible stall behavior. |
| **RT-006** (pre-admission cancel is fire-and-forget; the admitted/executing paths await the result) | Accepted behavior / open race documented | Document the fire-and-forget pre-admission settle as the accepted contract, and either resolve the inbox-cancel-vs-execution-start race with a controlled test or record it as an open, unverified concern. The executing-path "does not settle before the interrupt result" is already source-confirmed; no settle-known requirement applies to it. |
| **RT-009** (20 s/30 s timeout-value mismatch) | Documented divergence | Align the two budgets **or** document the intentional divergence with the *measured* user-visible timing consequence. A guaranteed false failure at 20 s is not claimed. |
| **RT-010** (non-Windows ownership no-op) | Platform limitation | Document that the Windows kill-on-close job is the enforced mechanism; becomes a blocker only if a non-Windows platform becomes a supported target. |

### Acknowledged design limitations (documented, not blockers for the Windows x64 artifact)

| Limitation | Finding | Disposition |
|---|---|---|
| No OS-level filesystem/command sandbox; TBAi authorization is application-level | §7, RT-005 | Documented; the OpenCode child runs with TBAi's OS privileges. Not a defect; a boundary. |
| TBAi cannot revoke OpenCode's persistent "Always" permissions | §7 | Documented; OpenCode's data, not TBAi's to revoke. |
| Non-Windows process-ownership/leak no-op | **RT-010** | Documented platform limitation; the Windows kill-on-close job chain is the enforced mechanism. Becomes a blocker only if a non-Windows platform is a supported target (out of scope here). |
| Post-readiness foreign-DB race window | RT-003 / §8 #4 | Documented in `ownership.ts:19-21`; a foreign process opening after `verifyChild` is outside the enforceable boundary. |
| Workspace-mismatch cross-access consequence | **RT-005** | The confinement rule is source-confirmed; the cross-workspace consequence is unproven and not claimed. |

### What would move the verdict from Hold

A move to a conditional **Pass** requires closing all **Tier 1 — mandatory blockers** with the closure evidence in the table above: **RT-001**, **RT-011**, **RT-008**, **RT-012**, and **RT-007**. **RT-007** is the one coverage item that is *not* closable by documentation alone — the real-server (8 gated suites) and live-model (6 live specs) runs are **required**, and a documented "this is untested" limitation does not constitute certification. The **Tier 2** findings close through documented scope or accepted behavior and do **not** by themselves hold the verdict: **RT-003** is a Low, non-blocking documentation item (the retained lease's demonstrated effect is the intended mutex refusal of a *second* manager; a release-on-failure change is optional); **RT-004** and **RT-006** close by either an implementation/probe change **or** an explicit out-of-scope/accepted-behavior statement; **RT-009** and **RT-010** close by documentation. Note that **RT-006** is a Tier 2 accepted-behavior item (the pre-admission fire-and-forget settle is documented; only the inbox-cancel-vs-execution-start race is open), not a mandatory blocker. The seven cross-component scenarios in §8 are the recommended test targets for the opt-in suites.

---

## 12. Change boundary and audit-only constraint

This task is **documentation-only.** The only repository change produced by this audit is this report. No source code, test, configuration, other documentation, or user file was modified; no destructive tests were run; no live OpenCode database was touched; nothing was staged, committed, or pushed. The repository is clean except this untracked report. No finding was implemented; no acceptance was declared on the auditor's own authority.

---

## 13. Closure addendum - 2026-10-25 (RT-008, RT-012, RT-007; RT-013 and RT-014 opened)

§5 is the **audit-time snapshot as of 2026-10-23** and is deliberately not
rewritten: its `Status` column, its "8 deep real-server integration suites", and
its line citations are what was true at the snapshot commit `9cc7c29`. This
section records what has since changed, with the measurements the §11 closure
criteria asked for. Where this addendum and §5 disagree, §5 is history and this is
current.

### 13.1 The measurements §11 required

Cold start was measured on `windows-latest` (Bun 1.4.2, pinned CLI 2.1.2) by a
throwaway CI job: **713 ms, 514 ms, 527 ms** process-start to readiness. Against
the 20 s warm budget that is about 2.5 %, so the approved plan's conditional
"split the cold/warm budgets if the measurements justify it" did not trigger; one
deadline remains.

The heartbeat was read off the **installed pinned binary**, not inferred from a
neighbouring version: `@opencode/cli-windows-x64` 2.1.2, SHA512
`sha512-r2DUwYbPe++6y4vWRuHX7slVCMIHyLyC8YAgJO7YAKX7dMgfXe4RDlJK7eZ6KHNBdpIY62Nxd6DPzKiCOP8uMg==`
(the workflow `env` value), writes `: heartbeat\n\n` on `/api/event` every **15 s**.

All nine real-binary suites, timed on the same runner class, each in its own
process with `TBAI_OPENCODE_RUNTIME_TESTS=1`:

| Suite | ms | exit | Disposition |
|---|---:|---:|---|
| `opencode-session-idempotency-runtime` | 1024 | 0 | required |
| `opencode-runtime-auth` | 2914 | 0 | required |
| `opencode-database-compat` | 3504 | 0 | required |
| `opencode-stub-provider-spike` | 4392 | 0 | required |
| `opencode-ownership-runtime` | 6220 | 0 | required |
| `opencode-retry-restart` | 9733 | 0 | required |
| `opencode-retry-runtime` | 10303 | 0 | required |
| `opencode-context-meter-runtime` | 8786 | 1 | **excluded** - needs a real provider credential |
| `opencode-native-compaction-conformance` | 263149 | 1 | **excluded** - see RT-013 |

Required seven: **38.1 s**. All nine: **310.0 s**. §5's "8 gated suites" was wrong
in count (nine exist) and wrong in kind: a required job that includes either of the
last two rows is permanently red for reasons the diff cannot fix.

### 13.2 RT-012 - Closed

Criterion asked for "a controlled test that forces `ensureLoaded()` (connection or
hydration) to stall past the advertised deadline and proves `awaitReady()` rejects
or times out within the end-to-end budget." Delivered: `awaitReady()` now holds one
absolute deadline and spends it across both legs; a superseded attempt continues the
loop against the *remaining* budget rather than restarting it. Expiry rejects the
waiter only - `withDeadline()` in `sync/startupGate.ts` never settles the gate - so
the runtime can still become ready afterwards and the state machine keeps reporting
truth.

Evidence: `tests/unit/web/opencode/v2ThreadController.readyDeadline.test.ts` -
"stops waiting at its deadline while hydration is in flight, then still reports the
runtime ready" (hydration stalled 150 ms against a 25 ms budget; the waiter returns
inside the budget, the runtime subsequently reports ready) and "does not settle the
attempt's own load promise when a waiter times out".

**Follow-up, same day: a terminal failure now reports as a failure.** The deadline
above was correct, but the error a waiter received was not. At `2c444cc` an
attempt's load leg was settled only through its readiness gate: `retire()` rejected
it as superseded, `fail()` with the failure. A terminal `scheduleReconnect` calls
`failReady()` **before** `retireAttempt()`, so an attempt parked in `hydrate()` -
no longer awaiting the gate - never settled its load leg, and `awaitReady()` spent
its remaining budget and rejected as a **deadline timeout**, the opposite of its own
contract, "Only a real failure - a terminal one ... - is thrown". The distinction
could not be inferred from ordering: stream death retires first on purpose so its
load follows the replacement, while connect and hydration failures call `fail()`
before `scheduleReconnect` and must surface as that failure. `sync/attempt.ts` now
carries a `failure` promise settled only in `fail()`, raced in `startConnection`
beside `runAttempt` and `superseded`; `fail()` settles `retired` first so
`retire()` early-returns and a failure stays a failure.
Evidence: the same suite's "reports a terminal stream failure while hydration is
unresolved instead of following a replacement" (asserts the typed
`V2ControllerError`, `connectCount` 1, `load: error`, `connection: failed`, no
pending timer, empty `unhandledRejection` probe) and "follows the replacement a
recoverable stream failure schedules, and cancels its timer". The terminal case
failed in 4.31 ms with `Received value: undefined` before the fix.

### 13.3 RT-008 - Closed

Criterion asked for "an idle-timeout watchdog on the open stream that triggers the
same reconnect/terminal path as a disconnect, plus a connected-but-silent test",
distinct from the disconnected path. Delivered: `OPENCODE_V2_STREAM_IDLE_TIMEOUT_MS
= 30_000` (two missed heartbeats at the measured 15 s period, documented as required
to stay above `OPENCODE_V2_READY_TIMEOUT_MS`), armed by the official client's
`onActivity` callback, which fires on **every read chunk including keepalive-only
frames** - so the timer measures bytes, not delivered events, exactly as the PM
decision specified. On silence the attempt aborts its **connection only**: it does
not `fail()` or `retire()`, so the reader's existing error path enters
`scheduleReconnect`.

Evidence, both directions: `tests/unit/web/opencode/v2ThreadController.streamIdle.test.ts` -
"stays connected when the only traffic is keepalives" (heartbeat-only frames, connect
count stays 1) and "reconnects a genuinely silent stream without retiring the runtime
or cancelling in-flight work" (state becomes `reconnecting`, a second connection is
established, and on the same attempt `connectionSignal.aborted` is true while
`lifecycleSignal.aborted` is false - the seam that keeps an in-flight prompt alive,
because prompts run on the lifecycle signal and only history/operations on the
connection signal). The keepalive contract itself is pinned by
`tests/unit/web/opencode/v2Client.test.ts` - "reports keepalive-only traffic as
activity, so silence means bytes".

### 13.4 RT-007 - Closed as re-scoped; one residual disclosed

The PM decision of 2026-10-24 required the real-binary suites on every PR and said
the job must fail if a required suite is missing or skipped. Delivered:
`scripts/run-opencode-runtime-suites.ts` + `bun run test:opencode-runtime` + the
`opencode-runtime` job in `.github/workflows/tests.yml` (installs the pinned CLI with
the same composite action as the other jobs, no `needs:`). A suite counts as passing
only with file present, at least 1 pass, 0 fail and **0 skip** - the skip condition is
the point, because every runtime suite exits 0 while self-skipping when the binary or
the opt-in is absent. The job's measured cost is the 38.1 s above.

**Scope correction, stated rather than absorbed.** §11's criterion was "runs the 8
gated suites" plus a separate `TBAI_E2E_LIVE=1` live-model run. As written, neither
half can be a per-PR gate: nine suites exist, not eight, and two of them cannot pass
on a credential-free clean runner (13.1). The gate therefore requires the seven that
can, and *classifies* the other two - `EXCLUDED_SUITES` carries a reason per entry,
and an unclassified new suite fails the gate, so the count cannot silently drift
again. The live-model half of the criterion stays **dispatch-only** by the same
decision (`e2e-big-pickle`, `TBAI_E2E_LIVE=1`), which means RT-007's original wording
is satisfied for the real-server suites and deliberately not for live-model ones.
That is a residual risk the gate records, not a coverage claim. And the dispatched
spec itself was weaker than it looked: its success check matched the prompt's own
`pickle-ok` until 2026-10-25, so its green never established that an answer
rendered (§13.6). The check is fixed; the job remains dispatch-only.

Evidence: `tests/unit/tooling/opencode-runtime-gate.test.ts` (20 cases), which
imports the lists and the discovery function **from the gate script** so a drift in
the script cannot pass a test holding a stale copy.

### 13.5 RT-013 - Opened (new finding, outside §5's ID range)

**RT-013 - `opencode-native-compaction-conformance` does not pass against the pinned
2.1.2 binary.** Severity: Medium, evidence class **Reproduced** (clean
`windows-latest` runner, `rc=1`, 5 pass / 3 fail, 263 s). The suite's describe block
still says "real OpenCode 2.0.22", i.e. its assertions encode the older server's
compaction behaviour; against 2.1.2 a settled compaction produces no pre-compaction
slice and `/context` does not return only post-compaction messages. Two of the three
failing cases are captured by name from the retained log tail:

- "compaction state is durable: /context returns only post-compaction messages" -
  `Expected: true, Received: false` at `opencode-native-compaction-conformance.test.ts:369`;
- "TBAi's meter projects a REAL settled compaction as unknown, then recovers" -
  `expect(slice.length).toBeGreaterThan(0)` received `0` at `:398`.

The third name was lost to the runner's 25-line-per-suite tail. **This is a conformance
finding against the supported version, not flakiness, and it is not closed by the
exclusion**: the exclusion only stops it from turning every PR red. Closure = the
assertions updated and verified against 2.1.2, then the suite moved into
`REQUIRED_SUITES`. Note also that at 263 s it is roughly seven times the whole
required job, so admitting it is a CI-cost decision as well as a correctness one.

A related measurement gap, recorded and not fixed here: the same truncation means
`opencode-context-meter-runtime`'s third failing case name is uncaptured; two are
("admits a manual compaction and records it as a compaction message", "a settled
compaction is unknown, and a later response repopulates it"), and that suite's
failures are credential-shaped (it asks a real model to answer), which is why it is
excluded rather than repaired.

### 13.6 Effect on the §11 verdict

The five Tier 1 blockers were RT-001, RT-011, RT-008, RT-012 and RT-007. RT-001 and
RT-011 closed with their durable-journal and delete-marker work (ADRs of 2026-10-24)
and passed independent review; RT-008, RT-012 and RT-007 close with this addendum,
RT-007 in the re-scoped form above. **Moving the verdict from Hold is the
maintainer's decision**, not a self-declared consequence of this section.

**The live-model run was executed on 2026-10-25 and did not pass.** With the pinned
2.1.2 CLI/server and `opencode/big-pickle` (`TBAI_E2E_LIVE=1`, the same spec the
`e2e-big-pickle` job runs), the capability assertion and prompt admission both
succeeded, but the turn failed at the provider: OpenCode's own log
(`<XDG_DATA_HOME>/opencode/log/opencode.log`) records `AI.Error: Free usage limit
reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode
Go to keep going`. The transcript rendered no answer and, over a 180 s observation,
no failure either (RT-014). This is a **quota limit of the free tier**, not a
code regression: the same model answered a direct CLI prompt minutes earlier,
before the limit was reached.

**The run also exposed a defect in the spec itself, and fixed it.** The prompt asks
the model to write `pickle-ok`, so the spec's own success check matched the *user's
echoed prompt*. The earlier `e2e-big-pickle` green therefore could not distinguish
an answer from the echo: it would have passed with an empty transcript. The check
now strips the prompt from the transcript, samples only what follows it, and reads
the session's assistant content as separate evidence. The red this produces today
is a real red, and the green it produced before was not evidence of a rendered
answer.

### 13.7 RT-014 - Opened (new finding, outside §5's ID range)

**RT-014 - A failed Code turn is silent in the transcript.** Severity: Medium,
evidence class **Reproduced** (big-pickle live run, 2.1.2 CLI/server, 2026-10-25).
The prompt was admitted (`200`, 662 ms; a second run 819 ms) and the status chip
returned from `Working` to `Connected`, but the provider rejected the turn with the
free-tier quota error quoted in §13.6. The tab showed the user message and no
assistant content: after a 180 s wait the only growth sample was the user row's
own timestamp/actions (21 characters), and the session read returned **0 assistant
characters**. The accessibility snapshot shows **no error, toast, or status text**
anywhere in it; the status chip is back to `Connected`. The failure is in the
OpenCode log only.

This is distinct from RT-013 (a compaction conformance failure) and from the
provider limit itself: the provider refusing is external, but a turn that ends
without an answer must not look like a turn that succeeded. Closure = the session
error event is surfaced where the turn is rendered (a transcript/system message or
the status chip), with a test that a failed turn is visibly failed; then the
big-pickle live spec is re-run when quota is available.

**Not claimed by this finding.** Whether the UI should also offer a retry, and
which error classes deserve one, is unspecified; the missing *signal* is the
defect.
