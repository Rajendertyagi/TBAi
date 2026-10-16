# Backend Lifecycle Standardization — Architecture Proposal

**Repository:** `Rajendertyagi/TBAi` (local: `D:\Temp\ai-chat-app`)
**Branch:** `fix/mcp-lifecycle-and-history-e2e` · **HEAD:** `b183abe`
**Date:** 2026-10-16
**Mode:** Planning-only. No source, tests, config, or docs were modified.

---

## 1. Executive Assessment of Lifecycle Maturity and Remaining Uncertainty

### 1.1 Source snapshot reviewed

| Item | Value |
|---|---|
| Branch | `fix/mcp-lifecycle-and-history-e2e` |
| HEAD | `b183abe` (confirmed via `git log`) |
| Working tree | Clean |
| Audit report | `docs/2026-10-16-backend-lifecycle-audit.md` (present, dated 2026-10-16) |
| Historical docs | `docs/2026-09-17-lifecycle-hardening.md`, `docs/2026-10-05-pm-infrastructure-audit.md` |

The branch and audit report match the task specification exactly. No discrepancy to flag.

### 1.2 Maturity verdict

**Partially standardized.** The shutdown spine, resource-ownership boundaries, and ordered DB-close are genuinely well-engineered and carry strong empirical test coverage. The load-bearing invariants — *new work gated before disposal, dependent work settled before dependency close, idempotent re-triggers, no timer outlives its owner* — are all met and tested for the core paths.

The subsystem is **not yet certifiable** because of a small set of residual gaps, none of which is a demonstrated crash or data-loss defect:

| ID | Gap | Severity | Self-healing? |
|---|---|---|---|
| M-1 | Partial-startup failure orphans MCP fire-and-forget children/timers | Low | Yes (OS reclaims on exit) |
| M-2 | Scheduler recovery delays HTTP readiness | Medium (under backlog) | No (design property) |
| M-3 | Post-settlement detached-history DB writes not awaited before `db.close()` | Low | Yes (next-boot reconciler) |
| L-1 | No global `unhandledRejection`/`uncaughtException` handler | Low | N/A (safety net) |
| L-2 | No repeated-SIGINT spine test | None | N/A (guard exists) |
| D-1 | Desktop quit bypasses graceful shutdown (`child.kill()`) | Medium | Partial (WAL + boot recovery) |
| D-2 | OpenCode sessions not individually terminated on shutdown | Low | Yes (die with child) |

### 1.3 Evidence classification

**Independently verified facts** (read from current source on this branch):
- Shutdown spine ordering, idempotency gate, per-step try/catch — `src/server.ts:118-244`
- `startServer` has no rollback path — `src/index.ts:9-12` (catch only sets `exitCode`)
- MCP `init()` is fire-and-forget `void this.connect(id)` — `src/services/mcp/manager.ts:171`
- `initScheduler()` → `recover()` → `handleOverdueOnce` awaits overdue execution — `src/services/scheduler/scheduler.ts:467`
- `stopHistoryReconciliation()` clears timer but does NOT await in-flight tick — `src/services/chat-streams/historyReconciler.ts:271-277`
- Desktop quit: `child.kill()` in `src-tauri/src/main.rs:251` — raw OS kill, bypasses `shutdownServer`
- No global `unhandledRejection`/`uncaughtException` handler in `src/`
- MCP disconnected entries persist in `connections` Map — `src/services/mcp/manager.ts:650-687`

**Findings supported by current source but not runtime-verified:**
- The M-3 race window (settled → write ordering) — source-traced, not empirically reproduced
- The M-2 readiness delay — source-traced, not measured under load
- Desktop quit behavior — Rust half not verified locally (no Rust toolchain)

**Assumptions and unresolved questions:**
- Whether Tauri `child.kill()` delivers SIGTERM (→ backend *would* run `shutdownServer`) or a hard kill — needs live Windows verification
- Whether the "process alive 3+ min after stopped" anomaly (noted in `docs/2026-09-17-lifecycle-hardening.md`) is still reproducible
- Whether losing in-flight work on desktop quit is within tolerance — **open maintainer decision**

**Historical documentation that is stale or contradicted by current source:**
- `docs/2026-09-17-lifecycle-hardening.md` and `docs/2026-10-05-pm-infrastructure-audit.md` both state MCP has "no live-disconnect detection." This is **false** against current source: `manager.ts:388-401` registers `transport.onclose` that sets `status="error"` and calls `scheduleReconnect` on unexpected close. This branch added live close-detection + reconnect **after** both docs were written. The two historical docs are point-in-time records and must not be rewritten; the correction belongs in `docs/decisions.md` as a new forward-looking entry.

---

## 2. Target Lifecycle Contract

### 2.1 Resource ownership

Every server, database, connection, timer, background worker, child process, and in-flight operation has a **single named owner** and a **defined lifecycle**. The owner is the module that creates the resource and is responsible for its disposal. No resource has multiple owners or an ambiguous owner.

**Ownership boundaries:**
- `src/services/server-listener.ts` owns the HTTP listener
- `src/db/index.ts` owns the SQLite handle
- `src/services/mcp/manager.ts` owns MCP connections/transports/timers
- `src/services/opencode/serverManager.ts` owns the OpenCode child process
- `src/services/chat-runs.ts` owns chat run records
- `src/services/scheduler/scheduler.ts` owns scheduler timers and run tracking
- `src/services/chat-streams/cleanup.ts` owns the cleanup timer
- `src/services/chat-streams/historyReconciler.ts` owns the reconciler timer
- `src/lib/logger.ts` owns the logger flush timer
- `src/server.ts` owns the shutdown spine (orchestrates, does not own individual resources)

### 2.2 Startup

Dependencies initialize in a **deliberate order**. Startup has explicit phases, readiness criteria, and failure semantics.

**Phases:**
1. **Pre-serve** (must complete before HTTP bind): log settings, provider/credential load, stream recovery, MCP init, scheduler recovery, background timer starts
2. **Serve** (HTTP listener binds): `initListenerFetch` → `bindBootPort` → `writePortFile` → `ensureSignalHandlers`
3. **Post-serve** (can run after readiness): none currently (all background timers start in phase 1 but are unref'd)

**Readiness criteria:** The HTTP listener is bound and accepting connections. The Tauri `/api/server/instance` handshake can complete.

**Failure semantics:** If any step in phase 1 or 2 rejects, `startServer` rejects. A **best-effort rollback** runs for every resource already acquired by that attempt (see §2.3). The process exits with `exitCode=1`.

### 2.3 Partial-startup rollback

If startup fails after acquiring resources, all resources acquired by that attempt are accounted for and released safely.

**Rollback behavior:**
- If MCP `init()` spawned any children/timers → run `mcpManager.disconnectAll()` + `beginSchedulerShutdown()`
- If scheduler timers were armed → `clearAllTimers()`
- If the HTTP listener bound → `server.stop(true)`
- If no resources were acquired → no-op
- Rollback is best-effort: each step is try/catch'd, failures are logged, and the process still exits with `exitCode=1`

**Asynchronous operations started during initialization:** Fire-and-forget MCP `connect()` calls are tracked by the `mcpManager.connections` map. Rollback iterates this map and disconnects each entry. No asynchronous operation can outlive a failed startup.

### 2.4 Shutdown

Shutdown is **idempotent**, prevents new work, cancels or settles owned work, drains required asynchronous operations, and disposes resources in dependency-safe order.

**Valid transitions:**
```
RUNNING → SHUTTING_DOWN → (terminal)
```
- `SHUTTING_DOWN` is a one-way gate. Repeated triggers are no-ops.
- No new work is accepted after `SHUTTING_DOWN` is set.

**Shutdown ordering (dependency-safe):**
1. Gate the scheduler (no new fire/schedule, clear timers)
2. Stop accepting new HTTP connections (`server.stop(true)`, don't await yet)
3. Shut down the OpenCode child (SIGTERM → SIGKILL)
4. Disconnect all MCP servers (clear timers, close clients, cancel elicitations)
5. Abort all chat runs
6. Await chat run settlement (bounded 10s)
7. Abort + await scheduler run settlement (bounded 10s)
8. Drain in-flight HTTP requests (bounded 10s)
9. Await the HTTP listener stop promise
10. Stop background timers (cleanup, reconciler)
11. Close the SQLite database (strictly last)
12. Set `process.exitCode = 0` (no `process.exit()`; event loop drains)

**Invariant:** `db.close()` is the last resource disposal step. No owned asynchronous work that can touch the database is still in flight when it runs.

### 2.5 Concurrency

Concurrent startup, shutdown, signals, cancellation, and completion cannot produce contradictory states or dispose dependencies while owned work still needs them.

**Mechanisms:**
- `shuttingDown` flag in `server.ts` — one-way gate, checked at the top of `shutdownServer`
- `shuttingDown` flag in `scheduler.ts` — gates `fireJob`/`runJobNow`/`scheduleJob`
- `shuttingDown` flag in `chat-runs.ts` — `create()` after `abortAll()` returns a terminal `cancelled` record
- `lifecycleGen` in `mcp/manager.ts` — generation counter makes "was I invalidated?" observable
- Single-winner `settle()` in `chat-runs.ts` — only the first terminal transition wins
- `pendingRuns` Set in `scheduler.ts` — tracked promises for settlement

### 2.6 Persistence integrity

Database writes and reconciliation operations are accounted for before database closure. Durability and recovery semantics are explicit.

**Guarantees:**
- WAL mode + `synchronous=NORMAL` + `busy_timeout=5000` (defensive, documented as non-shutdown)
- All DB-writing work (chat runs, scheduler runs, history finalization) is settled before `db.close()`
- The history reconciler's in-flight tick is either completed or explicitly drained before `db.close()`
- Boot recovery is honest and idempotent: orphaned `streaming` rows become `interrupted` or preserve an already-settled verdict; bytes are never rewritten

### 2.7 Background recovery

**Blocking readiness:**
- `recoverOrphanedChatStreams` — must complete before serving (fail-loud on schema missing)
- `registry.loadFromDb` + `credentialStore.initialize` — must complete before scheduler recovery can execute

**Non-blocking (run after readiness, unref'd):**
- `startChatStreamCleanup` — hourly reclamation of expired stream rows
- `startHistoryReconciliation` — periodic history finalization (boot tick + interval)
- MCP `init()` — fire-and-forget connect per enabled+autoConnect server
- Scheduler `recover()` — overdue one-time job execution (currently blocks readiness; M-2 proposes decoupling)

**Failure effect on service availability:** Background recovery failures are logged and do not affect HTTP availability. The reconciler never throws (returns null on error). The cleanup timer is best-effort.

### 2.8 Failure reporting

Cleanup failures are observable, do not silently disappear, and do not prevent other safe cleanup steps.

**Mechanism:** Each step in the shutdown spine is individually try/catch'd. Failures are logged via `logger.warn(scope, event, fields)` with structured error fields. The process exits regardless (`process.exitCode = 0` after all steps attempt).

### 2.9 Desktop/process lifecycle

The contract between the Tauri shell and its backend child:

- **Graceful quit:** The desktop quit path should route through the backend's SIGINT/SIGTERM handlers so `shutdownServer` runs. This requires a graceful-shutdown handshake (see D-1).
- **Forced termination:** If the backend process is hard-killed (crash, power loss), the OS reclaims child processes. WAL guarantees no corruption (most-recent-commit loss only). Interrupted run state is recovered at next boot.
- **Recovery after abrupt exit:** Boot recovery (`recoverOrphanedChatStreams`, `recover`) handles interrupted streams and jobs. The history reconciler's boot tick re-offers any unpersisted completed-run history.

### 2.10 Testing and evidence

The contracts are enforceable through deterministic unit, integration, and end-to-end tests. A test must exercise the relevant behavior, not merely assert that a helper was called.

**Principle:** Tests use the real public seam (e.g., `startServer(0)` + real HTTP request + `shutdownServer`), not mocks of internal helpers. Failure-injection tests force a subsystem to throw and assert the observable consequence.

---

## 3. Resource-Ownership and Dependency Matrix

### 3.1 Startup ownership (who creates, who owns, who terminates)

| Resource | Creator | Owner | Termination trigger | Cleanup guarantee | Status |
|---|---|---|---|---|---|
| HTTP listener | `Bun.serve` (`server-listener.ts:78`) | `activeServer` module state | `server.stop(true)` in spine + `await stopPromise` | Guaranteed, best-effort per try/catch | **VERIFIED** |
| SQLite handle | `db/index.ts:16` module load | module singleton | `db.close()` last in spine (`server.ts:233`) | Guaranteed last-close | **VERIFIED** |
| MCP clients | `connect()` (`manager.ts:171`) | `mcpManager.connections` | `disconnectAll()` (`server.ts:170`) | Guaranteed; disconnected entries remain | **VERIFIED** |
| MCP reconnect timers | `scheduleReconnect` (`manager.ts:720`) | `conn.reconnectTimer` | cleared in `disconnect()` | Guaranteed; bounded 5×5s | **VERIFIED** |
| OpenCode child | `spawn` in `start()` | `openCodeServerManager.child` | `shutdown()` SIGTERM→SIGKILL (`server.ts:164`) | Guaranteed; diagnostics tail | **VERIFIED** |
| Chat runs | `chatRuns.create` (route) | `records` Map | `abortAll()` + `awaitSettled(10s)` | Bounded (10s); timedOut surfaced | **VERIFIED** |
| Scheduler timers | `Bun.cron` / `setTimeout` in `timers` Map | module `timers` | `clearAllTimers` in `beginSchedulerShutdown` | Guaranteed; unref'd | **VERIFIED** |
| Scheduler runs | fire paths → `executeJobRun` | `pendingRuns` Set + `runControllers` | `abortAllRuns(10s)` | Bounded (10s); shape surfaced | **VERIFIED** |
| Chat-stream cleanup timer | `startChatStreamCleanup` | module `timer` (unref'd) | `stopChatStreamCleanup()` (`server.ts:214`) | Guaranteed | **VERIFIED** |
| History reconciler timer | `startHistoryReconciliation` | module `timer` (unref'd, `inFlight`) | `stopHistoryReconciliation()` (`server.ts:223`) | Timer stopped; in-flight tick NOT awaited | **GAP (M-3)** |
| Logger flush | `Logger` module load | singleton; `flushTimer` (unref'd) | `process.once("exit")` → `flushFileLines` | Best-effort, bounded | **VERIFIED** |
| Resumable store waiters | `createSqliteResumableStreamStore` | per-store `waiters` Set | `dispose()` (not called on process singleton) | Not a leak (bounded/in-flight) | **ACCEPTED** |

### 3.2 Startup sequence & readiness

| Phase | Step | Blocks readiness? | Failure semantics |
|---|---|---|---|
| 1 | `applyPersistedLogSettings()` | Yes (sync) | Throws → `startServer` rejects → `exitCode=1` |
| 2 | `registry.loadFromDb` + `credentialStore.initialize` | Yes | Throws → `exitCode=1` |
| 3 | `recoverOrphanedChatStreams` | Yes | Throws → `exitCode=1` (fail-loud) |
| 4 | `Promise.all([mcpManager.init(), gcOrphanChatDirs])` | Yes (awaited) | MCP init is fire-and-forget; gcOrphan can reject → `exitCode=1` |
| 5 | `initScheduler()` → `recover()` → `handleOverdueOnce` | **Yes (awaited)** | Overdue job execution delays HTTP bind | **GAP (M-2)** |
| 6 | `startChatStreamCleanup` + `startHistoryReconciliation` | No (unref'd, fire-and-forget) | Idempotent; failures logged |
| 7 | `initListenerFetch` + `bindBootPort` + `writePortFile` | Yes | Throws → `exitCode=1` |
| 8 | `ensureSignalHandlers` | Yes | Idempotent |

**M-1:** If step 4 or 5 rejects, no rollback path runs — MCP children/timers already spawned have no shutdown spine. **M-2:** Step 5 awaits overdue job execution (up to 600s each) before the HTTP listener binds.

### 3.3 Shutdown sequence (current — verified)

| Order | Step | Awaited? | DB-safe? |
|---|---|---|---|
| 1 | `beginSchedulerShutdown()` — gate + clear timers | sync | Yes |
| 2 | `server.stop(true)` — force-close connections | No (`stopPromise` saved) | Yes |
| 3 | `openCodeServerManager.shutdown()` | Yes | Yes |
| 4 | `mcpManager.disconnectAll()` | Yes | Yes |
| 5 | `chatRuns.abortAll()` | sync | Yes |
| 6 | `await chatRuns.awaitSettled(10s)` | Yes | Yes |
| 7 | `await abortAllRuns(10s)` | Yes | Yes |
| 8 | `await drainInflightRequests()` | Yes | Yes |
| 9 | `await stopPromise` | Yes | Yes |
| 10 | `stopChatStreamCleanup()` | sync | Yes |
| 11 | `stopHistoryReconciliation()` | sync | **In-flight tick NOT awaited** |
| 12 | `db.close()` | sync | Last — all work settled |

### 3.4 Key gaps requiring architectural decisions

| ID | Gap | Impact | Type |
|---|---|---|---|
| M-1 | Partial-startup failure orphans MCP fire-and-forget children/timers | Low (self-resolving on exit) | Code fix |
| M-2 | Scheduler recovery delays HTTP readiness | Medium (under backlog) | Code fix + decision |
| M-3 | Post-settlement detached-history DB writes not awaited before `db.close()` | Low (self-healing) | Code fix |
| L-1 | No global `unhandledRejection`/`uncaughtException` handler | Low (local containment) | Decision |
| L-2 | No repeated-SIGINT spine test | None (guard exists) | Test |
| L-3 | MCP disconnected connections persist for process lifetime | None (bounded) | Accepted |
| D-1 | Desktop quit bypasses graceful shutdown (`child.kill`) | Medium (in-flight work loss) | **Maintainer decision** |
| D-2 | OpenCode sessions not individually terminated on shutdown | Low (die with child) | **Maintainer decision** |

---

## 4. Current Architecture Versus Target Contract

### 4.1 Conformity summary

| Contract area | Status | Evidence |
|---|---|---|
| Resource ownership | **Met** | Every resource has a named owner (§2.1) |
| Startup ordering | **Met** | Deliberate phase ordering in `startServer` |
| Partial-startup rollback | **NOT MET** | `index.ts:9-12` catch only sets `exitCode`; no rollback (M-1) |
| Shutdown idempotency | **Met** | `shuttingDown` guard in `server.ts:141` |
| Shutdown ordering | **Met** | Dependency-safe order, DB last |
| Settlement before close | **Partially met** | Chat runs + scheduler runs settled; history reconciler in-flight tick NOT awaited (M-3) |
| Concurrency safety | **Met** | Gates, generation counters, single-winner settle |
| Persistence integrity | **Met** | WAL + ordered settlement + boot recovery |
| Background recovery | **Partially met** | Boot tick + interval; but scheduler recovery blocks readiness (M-2) |
| Failure reporting | **Met** | Per-step try/catch + structured logging |
| Desktop lifecycle | **NOT MET** | `child.kill()` bypasses `shutdownServer` (D-1) |
| Global async safety net | **NOT MET** | No `unhandledRejection` handler (L-1) |
| Repeated-shutdown test | **NOT MET** | Guard exists but untested (L-2) |

### 4.2 Detailed gap analysis

**M-1 · Partial-startup failure can orphan MCP fire-and-forget children/timers.**

`mcpManager.init()` is inside `await Promise.all([mcpManager.init(), gcOrphanChatDirs()])` (`server.ts:90`). `init()` issues `void this.connect(id)` (`manager.ts:171`) before `gcOrphanChatDirs()` could reject. If that Promise rejects (or a later `await initScheduler()` / `bindBootPort` throws), `startServer` rejects, `index.ts` sets `process.exitCode = 1`, and **`shutdownServer` is never called** — so any MCP stdio child already spawned and any pending reconnect timers have no shutdown path. On a normal exit the OS reclaims the children, so this is not a hang, but it is an un-cleaned-up partial-init state that no shutdown spine handles.

**Fix shape:** On `startServer` failure, run a best-effort `mcpManager.disconnectAll()` + `beginSchedulerShutdown()` before setting `exitCode`.

**M-2 · HTTP bind is delayed by overdue one-time job execution.**

`initScheduler()` → `recover()` calls `await handleOverdueOnce(...)` for each overdue one-time job *before* `initListenerFetch`/`bindBootPort` run (`server.ts:91` precedes `:111-112`). `handleOverdueOnce` → `fireJob` → `executeJobRun` performs a full provider call bounded by `job.timeoutSeconds` (default 600). A large overdue backlog (or a stalled provider) therefore delays the listener — and thus the Tauri `/api/server/instance` handshake — for the sum of those executions.

**Fix shape:** Run `recover()`'s overdue execution concurrently with (or after) binding the listener, or cap awaited overdue runs.

**M-3 · Post-settlement detached-history DB writes are not explicitly awaited before `db.close()`.**

For a *detached* completed run, `chatRuns` settles (`settled` resolves) **before** `recordFinalMessage` and `finalizeDetachedRunHistory` complete their SQLite writes (`execute-direct-stream.ts` onEnd: `settleFromUiOutcome` → `markCompleted` → then `recordFinalMessage` + `await finalizeDetachedRunHistory`). The spine's `awaitSettled` waits only on `settled`, so `db.close()` (`server.ts:233`) can in principle precede those writes. In practice the intervening `abortAllRuns`/`drainInflight` awaits give ample time and the writes are synchronous, and **the obligation self-heals** (row stays `history_state='pending'`; next boot's reconciler immediate tick re-offers it). It is a window, not a proven loss.

**Fix shape:** Fold the detached finalization into the run's settlement signal, or drain it explicitly in the spine before `db.close()`.

**L-1 · No global `unhandledRejection`/`uncaughtException` handler.**

Only hooks present are the two signal handlers (`server.ts:40,44`) and `logger`'s `process.once("exit")` (`logger.ts:1001`). Fire-and-forget paths are locally contained (`trackRun` `.catch(()=>{})`, `chat-runs`, MCP `allSettled`), so an unexpected unhandled rejection would crash the process *without* a structured log line. For a local single-user tool this is acceptable, but it is a missing safety net.

**L-2 · No repeated-SIGINT / repeated-shutdown test at the spine level.**

`shutdownServer` is guarded (`if (shuttingDown) return`) and `shutdown-lifecycle.test.ts` exercises a single trigger; a second signal is a safe no-op by inspection, but it is not asserted.

**D-1 · Desktop quit bypasses graceful shutdown.**

`quit_owned` → `child.kill()` (`main.rs:247-256`) is a raw OS kill of the sidecar; it does **not** route through the backend's SIGINT/SIGTERM handlers, so `shutdownServer` does not run on tray "Quit" or `quit_app`. On Windows the OpenCode child is reaped on stdio closure; WAL guarantees no corruption (most-recent-commit loss only); interrupted run state is recovered at next boot. This is the **primary desktop termination path** and it bypasses the spine.

**This is an open maintainer decision**, not an inherited acceptance. The maintainer must either:
- (a) accept the current in-flight-work loss on desktop quit as a documented, bounded trade-off, or
- (b) add a graceful-shutdown handshake on the desktop path (so `shutdownServer` runs) before certifying the subsystem.

**D-2 · OpenCode sessions are not individually terminated on shutdown.**

They die with the killed child; per-session termination exists only on conversation DELETE (`conversations.ts:483`). Whether that is acceptable also folds into the D-1 quit decision above.

---

## 5. Recommended Target Architecture

### 5.1 Lifecycle states and valid transitions

```
                    ┌─────────────┐
                    │   BOOTING   │  (startServer running)
                    └──────┬──────┘
                           │ success
                           ▼
                    ┌─────────────┐
          ┌────────│   RUNNING   │◄────────┐
          │        └──────┬──────┘         │
          │               │ signal/        │
          │               │ shutdown      │
          │               ▼                │
          │        ┌─────────────┐         │
          │        │ SHUTTING_DOWN│         │
          │        └──────┬──────┘         │
          │               │ all settled   │
          │               ▼                │
          │        ┌─────────────┐         │
          │        │   STOPPED   │         │
          │        └─────────────┘         │
          │                               │
          │  BOOTING ──failure──► ROLLBACK │
          │                    │           │
          │                    ▼           │
          │               ┌────────┐       │
          └───────────────│ FAILED │───────┘
                          └────────┘
```

**Valid transitions:**
- `BOOTING → RUNNING` (all startup steps succeeded)
- `BOOTING → ROLLBACK → FAILED` (any step failed; rollback best-effort)
- `RUNNING → SHUTTING_DOWN` (signal or manual trigger)
- `SHUTTING_DOWN → STOPPED` (all resources disposed)
- `SHUTTING_DOWN → SHUTTING_DOWN` (repeated trigger = no-op)

**Invalid transitions (prevented by gates):**
- `RUNNING → SHUTTING_DOWN` after `SHUTTING_DOWN` already set (idempotent guard)
- `SHUTTING_DOWN → RUNNING` (one-way)
- New work creation during `SHUTTING_DOWN` (scheduler gate, chat-run gate)

### 5.2 Ownership boundaries and dependencies

No change from current architecture. The ownership matrix in §3 is already correct. The recommendation preserves the existing boundaries.

### 5.3 Startup ordering and readiness semantics

**Current (verified):**
```
1. applyPersistedLogSettings
2. registry.loadFromDb + credentialStore.initialize
3. recoverOrphanedChatStreams
4. Promise.all([mcpManager.init(), gcOrphanChatDirs])
5. initScheduler()  ← awaits overdue job execution
6. startChatStreamCleanup + startHistoryReconciliation
7. initListenerFetch + bindBootPort + writePortFile
8. ensureSignalHandlers
```

**Proposed (M-2 fix):**
```
1. applyPersistedLogSettings
2. registry.loadFromDb + credentialStore.initialize
3. recoverOrphanedChatStreams
4. Promise.all([mcpManager.init(), gcOrphanChatDirs])
5. initListenerFetch + bindBootPort + writePortFile  ← HTTP binds FIRST
6. ensureSignalHandlers
7. initScheduler()  ← overdue execution runs AFTER bind (concurrent or deferred)
8. startChatStreamCleanup + startHistoryReconciliation
```

**Readiness contract:** The HTTP listener is bound and the Tauri handshake can complete **before** overdue scheduler jobs execute. Overdue jobs run concurrently with serving or after the listener is bound.

### 5.4 Failure and rollback behavior

**Current:** `index.ts:9-12` catch only sets `exitCode=1`. No rollback.

**Proposed:**
```typescript
// index.ts (conceptual — not implementation)
startServer(PORT).catch((err) => {
  logger.error("server", "startup_failed", { ...normalizeError(err) });
  // Best-effort rollback of any resources acquired by the failed attempt
  rollbackPartialStartup();
  process.exitCode = 1;
});

function rollbackPartialStartup(): void {
  try { mcpManager.disconnectAll(); } catch { /* logged */ }
  try { beginSchedulerShutdown(); } catch { /* logged */ }
  const server = getActiveServer();
  if (server) try { server.stop(true); } catch { /* logged */ }
}
```

### 5.5 Shutdown ordering, cancellation, draining, and disposal

No change from current architecture. The shutdown spine in `server.ts:118-244` is already correct. The only addition is M-3: drain the history reconciler's in-flight tick before `db.close()`.

### 5.6 How timers, connections, child processes, and asynchronous operations are tracked

No new tracking mechanism. The current design already tracks:
- Timers: module-level `timers` Map (scheduler), module-level `timer` (cleanup, reconciler), per-record `timeoutHandle` (chat runs), per-connection `reconnectTimer` (MCP)
- Connections: `mcpManager.connections` Map
- Child processes: `openCodeServerManager.child`
- Asynchronous operations: `chatRuns.records` Map, `scheduler.pendingRuns` Set + `runControllers` Map

### 5.7 Persistence guarantees and recovery behavior

No change from current architecture. WAL + ordered settlement + boot recovery is already correct. The M-3 fix adds explicit draining of the history reconciler's in-flight tick.

### 5.8 Observability and failure reporting

No change from current architecture. Per-step try/catch + structured logging is already correct. The L-1 fix adds a global `unhandledRejection` handler as a safety net.

### 5.9 Compatibility requirements

- **Existing application behavior:** All current routes, providers, and UI surfaces must continue to work unchanged.
- **External contracts:** The Tauri `/api/server/instance` handshake, the port file protocol, and the assistant-ui runtime contract must remain unchanged.
- **Persistence schema:** No schema changes. The M-1/M-2/M-3 fixes are behavioral only.
- **Dependency train:** No `@assistant-ui/*` changes. No new dependencies.

---

## 6. Ordered Implementation Phases

### Phase 1: Startup-failure rollback (M-1)

**Architectural outcome:** A failed `startServer` runs a best-effort rollback of every resource acquired by that attempt before setting `exitCode`.

**Current source areas affected:**
- `src/index.ts` (catch block)
- `src/server.ts` (extract a `rollbackPartialStartup` helper or inline in catch)
- `src/services/mcp/manager.ts` (use existing `disconnectAll`)
- `src/services/scheduler/scheduler.ts` (use existing `beginSchedulerShutdown`)

**Proposed design:** Add a `rollbackPartialStartup()` function that calls `mcpManager.disconnectAll()` + `beginSchedulerShutdown()` + `server.stop(true)` if a listener is active. Call it from the `index.ts` catch block before setting `exitCode`.

**Why this phase first:** It is independent, low-risk, and closes the only gap where resources can be orphaned without any cleanup path. It also establishes the rollback pattern that later phases can extend.

**Acceptance criteria:** A test forces a subsystem throw mid-`startServer` and asserts no leaked MCP children/reconnect timers.

**Required tests:**
- `tests/integration/core/startup-rollback.test.ts` — force `gcOrphanChatDirs` to reject, assert `mcpManager.connections` is empty and no reconnect timers are armed after the catch runs.

**Regression risks:** None. The rollback only runs on the failure path, which currently has no cleanup.

**Dependencies:** None.

**Evidence needed:** Test passes; `bun run typecheck` + `bun run build` exit 0.

---

### Phase 2: Repeated-SIGINT spine test (L-2)

**Architectural outcome:** The existing `shuttingDown` guard is locked in by a test before any later phase changes the spine.

**Current source areas affected:**
- `tests/integration/core/shutdown-lifecycle.test.ts` (extend)

**Proposed design:** Add a test that sends two SIGINT signals (or calls `shutdownServer` twice) and asserts the second is a no-op with no double-close.

**Why this phase second:** It is a pure test, depends on nothing, and locks in the existing guard before Phase 3 changes the spine.

**Acceptance criteria:** A test triggers `shutdownServer` twice and asserts the second call is a no-op.

**Required tests:**
- Extend `tests/integration/core/shutdown-lifecycle.test.ts` with a "repeated shutdown is a no-op" case.

**Regression risks:** None. Test-only.

**Dependencies:** None.

**Evidence needed:** Test passes.

---

### Phase 3: Settlement-finalization write ordering (M-3)

**Architectural outcome:** The detached-history finalization and any in-flight reconciler tick complete (or are explicitly drained) before `db.close()`.

**Current source areas affected:**
- `src/routes/chat/execute-direct-stream.ts` (settlement cluster)
- `src/services/chat-streams/historyReconciler.ts` (in-flight tick tracking)
- `src/server.ts` (spine drain before `db.close()`)

**Proposed design:** Two options (maintainer choice):
- **(A)** Fold the detached finalization into the run's settlement signal: make `settled` resolve only after `recordFinalMessage` + `finalizeDetachedRunHistory` complete.
- **(B)** Drain explicitly in the spine: add a `await drainHistoryReconciliation()` call before `db.close()` that awaits any in-flight tick.

**Why this phase third:** It depends on Phase 2's regression lock (the spine test must pass before the spine changes). It is a narrow, well-understood window.

**Acceptance criteria:** A test opens the `settled`-then-write window and asserts `db.close()` cannot precede the finalization writes.

**Required tests:**
- `tests/integration/chat/historyReconciler.test.ts` — assert that `stopHistoryReconciliation()` awaits an in-flight tick.
- A spine-level test that forces a detached run to settle during shutdown and asserts the history write completes before `db.close()`.

**Regression risks:** Changing the `settled` resolution timing could affect the chat-run settlement semantics. Must preserve single-winner `settle()` behavior.

**Dependencies:** Phase 2 (regression lock).

**Evidence needed:** Tests pass; typecheck + build exit 0.

---

### Phase 4: Readiness decoupling from overdue jobs (M-2)

**Architectural outcome:** HTTP bind completes before/independent of awaited overdue-scheduler execution.

**Current source areas affected:**
- `src/services/scheduler/scheduler.ts` (`recover` overdue path)
- `src/server.ts` (ordering)

**Proposed design:** Move `initScheduler()` after `bindBootPort` in `startServer`. The overdue execution then runs concurrently with serving. Alternatively, run `recover()`'s overdue execution in a fire-and-forget promise after the listener binds.

**Why this phase fourth:** It changes startup ordering, which is a readiness contract. It should be done after the rollback pattern (Phase 1) and the spine test (Phase 2) are in place.

**Acceptance criteria:** A test with a slow/blackhole overdue job shows the listener (and `/api/server/instance`) becomes reachable without waiting for the run.

**Required tests:**
- `tests/integration/core/readiness.test.ts` — register a blackhole overdue job, call `startServer`, assert the HTTP listener is reachable before the job completes.

**Regression risks:** Changing startup ordering could affect the Tauri handshake timing. Must ensure the scheduler is still initialized before the first request that might depend on it.

**Dependencies:** Phase 1 (rollback pattern), Phase 2 (spine test).

**Evidence needed:** Test passes; typecheck + build exit 0.

---

### Phase 5: Unhandled-rejection handler (L-1)

**Architectural outcome:** A `process.on("unhandledRejection")` handler logs a structured `lifecycle.unhandled_rejection` (or an explicit decision to rely on local containment is recorded in `docs/decisions.md`).

**Current source areas affected:**
- `src/lib/logger.ts` or `src/index.ts`

**Proposed design:** Add a `process.on("unhandledRejection", (reason) => { logger.error("lifecycle", "unhandled_rejection", { ...normalizeError(reason) }); })` handler. Alternatively, record in `docs/decisions.md` that local containment is the documented choice.

**Why this phase last:** It is the safety net for all of the above. It should be added after the other phases are in place.

**Acceptance criteria:** A test triggers an unhandled rejection and asserts a structured log line is emitted (or the decision is recorded).

**Required tests:**
- `tests/integration/core/unhandled-rejection.test.ts` — emit an unhandled rejection, assert the handler logs it.

**Regression risks:** None. The handler is additive.

**Dependencies:** None (but logically last).

**Evidence needed:** Test passes; typecheck + build exit 0.

---

### Phase 6: Documentation sync

**Architectural outcome:** Add a **new** forward-looking entry to `docs/decisions.md` recording the MCP live close-detection + reconnect capability (superseding the Phase-4 "deferred" note). **Do not edit** the two historical point-in-time docs.

**Why this phase last:** Documentation should reflect the final state.

**Acceptance criteria:** `docs/decisions.md` carries the new entry; the two historical docs are unchanged.

**Dependencies:** All code phases complete.

---

## 7. Test and Independent-Verification Strategy

### 7.1 Test principles

- Tests use the **real public seam** (`startServer(0)` + real HTTP request + `shutdownServer`), not mocks of internal helpers.
- **Failure-injection tests** force a subsystem to throw and assert the observable consequence.
- Tests assert the **invariant, not the layout**: match the dependency, not the formatter's line wrapping.
- A test must **exercise the relevant behavior**, not merely assert that a helper was called.

### 7.2 Test coverage matrix

| Contract | Test | Type | Phase |
|---|---|---|---|
| Startup-failure rollback | `tests/integration/core/startup-rollback.test.ts` | Integration (real server) | 1 |
| Repeated shutdown no-op | Extend `tests/integration/core/shutdown-lifecycle.test.ts` | Integration (real server) | 2 |
| Settlement-finalization ordering | `tests/integration/chat/historyReconciler.test.ts` + spine test | Integration | 3 |
| Readiness decoupling | `tests/integration/core/readiness.test.ts` | Integration (real server) | 4 |
| Unhandled-rejection handler | `tests/integration/core/unhandled-rejection.test.ts` | Integration | 5 |
| Existing shutdown spine | `tests/integration/core/shutdown-lifecycle.test.ts` | Integration (real server) | Preserve |
| Chat settle/gate/abort races | `tests/unit/core/chat-runs.test.ts` | Unit | Preserve |
| Scheduler settlement + gate | `tests/unit/scheduler/scheduler.test.ts` | Unit | Preserve |
| OpenCode child lifecycle | `tests/integration/opencode/serverManager.test.ts` | Integration (fake child) | Preserve |
| MCP connect/disconnect races | `tests/integration/mcp/connection-lifecycle-race.test.ts` | Integration (real stdio) | Preserve |
| Boot orphan recovery | `tests/integration/chat/boot.test.ts` | Integration (temp DB) | Preserve |
| DB pragmas + lock-wait | `tests/unit/persistence/db.test.ts` | Unit | Preserve |

### 7.3 Independent verification

Per the Definition of Done in `AGENTS.md`:
1. `bun run typecheck` (backend + web) exit 0
2. `bun run build` exit 0
3. Test suite numbers recorded (suite + case counts, actual numbers)
4. `bun run test:shutdown` passes (the shutdown spine integration test)

### 7.4 Test commands

```bash
bun run typecheck
bun run build
bun test tests/unit tests/integration
bun run test:shutdown
```

---

## 8. Maintainer Decisions Required Before Implementation

| ID | Decision | Options | Blocking? |
|---|---|---|---|
| D-1 | Is losing in-flight work on desktop quit acceptable? | (a) Accept + document the bounded loss, or (b) Add a graceful-shutdown handshake on the desktop path | **Yes** — certification is blocked until this is decided |
| D-2 | Should `initScheduler`'s overdue execution ever block readiness? | (a) Strictly post-bind (recommended), or (b) Allow blocking under explicit config | No — Phase 4 can proceed with (a) as default |
| D-3 | Is a global `unhandledRejection` handler desired, or is local containment the documented choice? | (a) Add handler, or (b) Record decision in `docs/decisions.md` | No — Phase 5 can proceed with either |
| D-4 | M-3 fix shape: (A) fold finalization into settlement signal, or (B) drain explicitly in spine? | (A) or (B) | No — Phase 3 can proceed with either |
| D-5 | MCP disconnected-entry lifetime (L-3): confirm it stays an accepted bounded behavior or is promoted to `disconnect()`-time removal? | (a) Accept, or (b) Remove on disconnect | No — accepted limitation today |

---

## 9. Explicit Out-of-Scope Items and Existing Behavior to Preserve

### 9.1 Out of scope

- **No new architecture or lifecycle framework.** The existing module-owned lifecycle is sound. No generic lifecycle manager.
- **No changes to the assistant-ui dependency train.** Frozen per `AGENTS.md`.
- **No changes to the OpenCode isolation boundary.** The `src/services/opencode/` module owns the managed child; the rest of the backend never imports the client.
- **No changes to the MCP isolation boundary.** The `src/services/mcp/manager.ts` owns all MCP connections.
- **No changes to the persistence schema.** No new tables, columns, or migrations.
- **No changes to the Tauri shell.** The desktop quit path (D-1) is a maintainer decision, not a code change in this plan.
- **No changes to the frontend.** All gaps are backend lifecycle.
- **No changes to the provider-agnostic chat architecture.**
- **No changes to the server-owned run design** (disconnect != kill).
- **No changes to the encryption architecture.**
- **No changes to `docs/decisions.md` as the architectural decision record** (except adding the new MCP close-detection entry in Phase 6).
- **No rewriting of historical point-in-time docs** (`docs/2026-09-17-lifecycle-hardening.md`, `docs/2026-10-05-pm-infrastructure-audit.md`).

### 9.2 Existing behavior to preserve

- The shutdown spine's ordering and idempotency (except M-3 drain addition)
- The chat-run single-winner settlement semantics
- The scheduler's abort-aware retry loop
- The MCP generation-gated ownership model
- The OpenCode child orphan/restart hardening
- The boot recovery honesty and idempotency
- The DB hardening (WAL + busy_timeout)
- The "no timer keeps the process alive" invariant
- The server binding to `0.0.0.0` (maintainer decision 2026-09-17)
- The `bun:sqlite` synchronous model

---

## 10. Recommendation: Is the Plan Sufficiently Grounded to Begin Implementation?

**Yes, with one blocker.**

The plan is grounded in:
- A comprehensive, independently verified audit (`docs/2026-10-16-backend-lifecycle-audit.md`)
- Direct source verification of every material finding on the current branch
- A clear target lifecycle contract (§2)
- A phased implementation order with dependencies and acceptance criteria (§6)

**The one blocker:** D-1 (desktop quit bypasses graceful shutdown) is an open maintainer decision. Until the maintainer explicitly chooses between (a) accepting the bounded in-flight-work loss or (b) adding a graceful-shutdown handshake, certification is blocked on that item. However, **Phases 1-5 can proceed independently** — they do not depend on D-1.

**Recommended immediate next steps:**
1. Maintainer decides D-1, D-2, D-3, D-4, D-5 (can be done in one review pass)
2. Begin Phase 1 (M-1 startup-failure rollback) — independent, low-risk, no blockers
3. Begin Phase 2 (L-2 repeated-SIGINT test) — independent, test-only

The plan does not leave the overall lifecycle architecture inconsistent at any phase boundary. Each phase is self-contained and can be reviewed and verified independently.

---

*Proposal delivered. No files were created or modified in the working tree and nothing was committed or pushed; the implementation phase was not begun.*
