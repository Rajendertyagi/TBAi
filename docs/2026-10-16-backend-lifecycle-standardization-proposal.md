# Backend Lifecycle Standardization — Architecture Proposal (v2.2)

**Repository:** `Rajendertyagi/TBAi` (local: `D:\Temp\ai-chat-app`)
**Branch:** `fix/mcp-lifecycle-and-history-e2e` · **Original source snapshot:** `2131a8f`
**Date:** 2026-10-16
**Mode:** Planning-only revision. This update changes this proposal document only; no production source, tests, or runtime configuration were changed.

---

## 1. Source Snapshot and Versioned Evidence Inventory

### 1.1 Original Git snapshot reviewed for v2.1

| Item | Value |
|---|---|
| Branch | `fix/mcp-lifecycle-and-history-e2e` |
| Reviewed source snapshot | `2131a8f` (the snapshot cited by the supplied v2.1 report; not a claim about the current branch HEAD) |
| Working tree | Clean |
| Prior HEAD | `b183abe` (used by v1 of this proposal) |
| Intermediate commit | `c6624d6 fix(root): add react-router as root devDependency for tests/ type resolution` — test-only dependency change, no lifecycle impact |

**Changes since v1:** `c6624d6` (test-only devDependency) and `2131a8f` (this proposal + audit). No production lifecycle source changed. All v1 findings remain valid.

### 1.2 Runtime versions

| Component | Version | Source |
|---|---|---|
| Bun (required runtime for all lifecycle experiments and certification) | `1.4.3` only | Maintainer-confirmed runtime requirement |
| Bun type definitions | `^1.4.2` | `@types/bun` package range; not the runtime executable version |
| Tauri | `2` | `src-tauri/Cargo.toml` |
| tauri-plugin-shell | `2` (locked: 2.5.0) | `src-tauri/Cargo.toml` + crates.io |
| SQLite (Bun) | statically linked | `bun:sqlite` (Bun 1.4) |

**Runtime constraint:** Bun `1.4.3` is the sole runtime version permitted for lifecycle runtime experiments, test evidence, and certification claims. Do not use results from Bun `1.4.2` or another version as proof of Bun `1.4.3` behavior. Package type-definition ranges do not identify the runtime executable. Runtime behavior claims must be backed by Bun documentation/source or labeled runtime-verified; Node.js documentation is not authority for Bun runtime behavior.

### 1.3 Source files inspected (this revision)

**Production source (unchanged since v1):**
- `src/index.ts`, `src/server.ts`, `src/services/server-listener.ts`, `src/services/http-metrics.ts`
- `src/db/index.ts`
- `src/services/mcp/manager.ts`, `src/services/opencode/serverManager.ts`
- `src/services/chat-runs.ts`, `src/services/scheduler/scheduler.ts`
- `src/services/chat-streams/{boot,cleanup,historyReconciler,historyFinalizer,sqliteResumableStore}.ts`
- `src/routes/chat/execute-direct-stream.ts`
- `src-tauri/src/main.rs`

**Tests (unchanged since v1):**
- `tests/integration/core/shutdown-lifecycle.test.ts`
- `tests/unit/core/chat-runs.test.ts`, `tests/unit/scheduler/scheduler.test.ts`
- `tests/integration/opencode/serverManager.test.ts`
- `tests/integration/mcp/connection-lifecycle-race.test.ts`
- `tests/integration/chat/{boot,cleanup,historyReconciler,sqliteResumableStore}.test.ts`
- `tests/unit/persistence/db.test.ts`

**Docs:** `docs/2026-10-16-backend-lifecycle-audit.md`, `docs/2026-09-17-lifecycle-hardening.md`, `docs/2026-10-05-pm-infrastructure-audit.md`, `docs/architectural-principles.md`, `docs/engineering-quality.md`, `docs/decisions.md`

### 1.4 Classification labels used throughout

| Label | Meaning |
|---|---|
| **source-verified** | Read directly from current source on this branch |
| **doc-supported** | Confirmed by official documentation URL cited |
| **runtime-verified** | Executed and observed (none in this planning task) |
| **proposed** | Architectural recommendation, not yet implemented |
| **unresolved** | Needs maintainer decision or further evidence |

---

## 2. Online Documentation Review

### 2.1 Bun HTTP server lifecycle

**Source:** https://bun.sh/docs/runtime/http/server

| Guarantee | TBAi applicability | Limitation |
|---|---|---|
| `server.stop()` allows in-flight requests and WebSocket connections to complete | TBAi uses `server.stop(true)` (force-close), so this default is not relied upon | Connection-level only — does not track application-owned work |
| `server.stop(true)` immediately terminates all connections | TBAi's spine uses `stop(true)` intentionally (browser SSE readers must not block shutdown) | Force-close means in-flight response streams are severed, not drained |
| Returned promise resolves once every connection has closed | TBAi awaits `stopPromise` after chat/scheduler settlement | Promise resolves on connection close, NOT on business-operation completion |
| `server.pendingRequests` counter exists | TBAi uses its own `http_requests_inflight` gauge via `accountingMiddleware` | The gauge decrements when the handler returns the Response, NOT when the stream finishes |
| `server.timeout(req, 0)` disables idle timeout per-request | TBAi uses this for chat/resume/logs streaming routes | Correct as documented |

**Key finding (doc-supported):** The HTTP inflight counter (`http_requests_inflight`) is decremented when the handler returns the `Response` object, not when the response body stream finishes. A handler that returns a `Response` with a streaming body and then continues work in `onEnd` has already decremented the counter. This is why TBAi needs explicit `chatRuns.awaitSettled()` and `abortAllRuns()` — the HTTP counter is not a substitute for tracking response-stream work.

### 2.2 Bun SQLite lifecycle

**Source:** https://bun.sh/docs/runtime/sqlite

| Guarantee | TBAi applicability | Limitation |
|---|---|---|
| `db.close(false)` (default) does not throw on close error; prepared statements keep working until finalized/GC'd | **TBAi uses `db.close()` (no arg) — this is `close(false)`** | This is a "soft" close: outstanding `.prepare()` statements are NOT finalized |
| `db.close(true)` finalizes every outstanding `.prepare()` statement and throws on close error | TBAi does NOT use this | Statements from `.query()` are finalized immediately by either close mode — `close(true)` does NOT throw for `.query()` statements |
| WAL sidecar files (`-wal`, `-shm`) persist on macOS after close | TBAi targets Windows (Tauri desktop) | Not a cross-platform concern for TBAi's primary deployment |
| `Database` owns statements created with `.query()` and finalizes them immediately | TBAi uses `.query()` and `.run()` exclusively | No orphaned prepared statements in TBAi's usage |

**Key finding (doc-supported):** TBAi's `db.close()` is a soft close. It is safe only because all work is settled before the close (ordered shutdown spine). If any in-flight SQLite operation could reach the DB after `close(false)`, it would silently fail (statements keep working until finalized, but the connection is released). The M-3 fix (drain history reconciler before close) becomes more critical under this contract.

**Corrected understanding of `close(true)`:** `close(true)` finalizes outstanding `.prepare()` statements, releases the connection, and throws if SQLite reports a close error. It does NOT throw merely because a `.query()` statement exists (those are finalized immediately). `close(true)` is close/error-reporting hardening — not a substitute for draining active work, not a durability fix.

### 2.3 Bun child-process API

**Source:** https://bun.sh/docs/runtime/child-process

| Guarantee | TBAi applicability | Limitation |
|---|---|---|
| `proc.kill()` sends a signal (default SIGTERM) | OpenCode `shutdown()` uses `child.kill("SIGTERM")` then `child.kill("SIGKILL")` after timeout | Correct as documented |
| `proc.exited` resolves when the process exits | OpenCode `shutdown()` races `child.exited` against a timeout | Correct |
| `proc.unref()` detaches the child from the parent | OpenCode child is NOT unref'd — it is owned and tracked | Correct for TBAi's ownership model |

### 2.4 SQLite WAL and synchronous semantics

**Source:** https://www.sqlite.org/wal.html

| Guarantee | TBAi applicability | Limitation |
|---|---|---|
| WAL + `synchronous=NORMAL`: writers sync the WAL on every commit, but skip the per-commit fsync that FULL would do | TBAi uses exactly this configuration | **Durability distinction:** app-process crash = safe (WAL recovers); OS/power loss = most recent commits may be lost (only checkpoint fsyncs) |
| WAL file is deleted automatically when the last connection closes | TBAi closes the connection at shutdown | Correct |
| A crashed process leaves the WAL file on disk; next open recovers it | TBAi's boot recovery handles interrupted streams | The WAL-recovery path is SQLite's own, not TBAi's code |

**Key finding (doc-supported):** The prior proposal's claim that "WAL guarantees no corruption (most-recent-commit loss only)" is accurate for application-process crashes but must be split into two distinct guarantees:
1. **Application-process crash** (clean `db.close()` or abrupt exit): WAL recovers all committed transactions. Safe.
2. **OS/power loss**: `synchronous=NORMAL` means the last few transactions (since the last checkpoint fsync) may be lost. Corruption-safe but not fully durable.

### 2.5 SQLite PRAGMA reference

**Source:** https://www.sqlite.org/pragma.html

- `busy_timeout`: sets the busy handler; a second process touching the same file waits up to the timeout. TBAi's 5000ms is defensive (single-process + synchronous bun:sqlite cannot self-contend).
- `synchronous=NORMAL` in WAL mode: "Writers sync the WAL on every transaction commit if `synchronous` is FULL but omit this sync if NORMAL." Confirms the durability distinction in §2.4.

### 2.6 Bun process-level error semantics

TBAi runs exclusively on Bun. Node.js process semantics are not applicable. Bun 1.4's exact production behavior on `unhandledRejection` and `uncaughtException` is not documented in the release notes. **Unresolved:** requires runtime verification in isolated child processes (see §10.4, experiments R1–R4).

### 2.7 Tauri shell API (CommandChild)

**Source:** https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/process/struct.CommandChild.html

| Method | Behavior (2.5.0) | TBAi usage |
|---|---|---|
| `kill()` | "Sends a kill signal to the child and waits for it to exit." On Unix, Rust's `Child::kill()` maps to **SIGKILL** (not SIGTERM). With `process_group` enabled, Tauri uses `killpg(..., SIGKILL)`. On Windows, it uses `TerminateProcess` or job-object termination. | TBAi's `quit_owned()` calls `child.kill()` — **this is forced termination (SIGKILL on Unix, TerminateProcess on Windows), not graceful shutdown** |
| `pid()` | Returns the process pid | Not used in quit path |
| `write(buf)` | Writes to process stdin | Not used in quit path |

**Key finding (doc-supported):** `CommandChild.kill()` is **SIGKILL on Unix** and **TerminateProcess on Windows** — no signal handlers run. The backend's SIGINT/SIGTERM handlers cannot provide graceful shutdown when Tauri kills the backend. A graceful handshake would need a distinct application-level communication mechanism (Tauri IPC/event), not a POSIX signal. This confirms D-1 as an open decision for the Windows deployment.

### 2.8 Bun upstream issue #36223

**Source:** https://github.com/oven-sh/bun/issues/36223

| Fact | TBAi applicability |
|---|---|
| `server.stop()` never resolves after a server-side WebSocket close (in Bun 1.3.14) | **Not applicable** — TBAi has no WebSocket path. Bun.serve is used for HTTP + SSE only. |
| Fixed on main (pre-1.4.0) | The required certification runtime is Bun `1.4.3`, which is after the documented fix. No regression test needed. |

**Conclusion:** Documented as not applicable. No test required.

---

## 3. Updated Executive Assessment

### 3.1 Maturity verdict

**Partially standardized, with a clear path to certification.** The shutdown spine, resource-ownership boundaries, and ordered DB-close are genuinely well-engineered. The load-bearing invariants — *new work gated before disposal, dependent work settled before dependency close, idempotent re-triggers, no timer outlives its owner* — are met and tested for core paths.

The subsystem is **not yet certifiable** because of:

| ID | Gap | Severity | Self-healing? | Type |
|---|---|---|---|---|
| M-1 | Partial-startup failure orphans MCP children/timers | Low | Yes (OS reclaims) | Code fix |
| M-2 | Scheduler recovery delays HTTP readiness | Medium (under backlog) | No (design property) | Code fix + decision |
| M-3 | Post-settlement detached-history DB writes not awaited before `db.close()` | Low | Yes (next-boot reconciler) | Code fix |
| L-1 | No global `unhandledRejection`/`uncaughtException` handler | Low | N/A (safety net) | Decision |
| L-2 | No repeated-SIGINT spine test | None | N/A (guard exists) | Test |
| D-1 | Desktop quit bypasses graceful shutdown (`child.kill()`) | Medium | Partial (WAL + boot recovery) | **Maintainer decision** |
| D-2 | OpenCode sessions not individually terminated on shutdown | Low | Yes (die with child) | **Maintainer decision** |
| N-1 | `db.close()` is a soft close — outstanding statements not finalized | Low (mitigated by ordered spine) | Yes (self-heals on next boot) | Code improvement |
| N-2 | Startup rollback does not track in-flight MCP connect promises | Low | Yes (OS reclaims) | Code fix (extends M-1) |
| N-3 | Shutdown deadlines have no escalation policy for stuck operations | Medium | No (bounded but silent) | Code fix + decision |
| N-4 | History reconciler drain is not observable (no promise to await) | Low | Yes (self-heals) | Code fix (extends M-3) |
| N-5 | Repeated shutdown returns immediately, not the canonical completion promise | Low | N/A (contract question) | Code fix + test |
| C-1 | Shutdown timeout policy abandons DB-writing work before close | Medium | No (task still writing) | Code fix + decision |
| C-2 | Startup rollback incomplete: omits resources, doesn't await cleanup, can deadlock on MCP connects | Medium | Yes (OS reclaims) | Code fix |
| C-3 | Claimed-history crash recovery: stranded `claimed` rows after process death | Medium | No (not self-healing) | Decision + possible code fix |
| C-4 | SQLite close test incorrect: expects `close(true)` to throw for `.query()` statements | Low (test-only) | N/A | Test fix |
| C-5 | Tauri kill semantics misstated: SIGKILL on Unix, not SIGTERM | Medium (D-1 impact) | N/A | Doc fix |
| C-6 | Scheduler readiness: moving `initScheduler()` after bind doesn't separate essential recovery from slow execution | Medium | No (scheduler-dependent routes exposed) | Code fix |
| C-7 | Shutdown `exitCode = 0` masks cleanup failures | Low | N/A | Code fix |
| C-8 | Repeated shutdown: async wrapper creates distinct promises, not object identity | Low | N/A | Contract clarification |

### 3.2 What changed since v2

- **C-1:** Shutdown timeout policy corrected — must not abandon DB-writing work before close; needs escalation policy
- **C-2:** Startup rollback contract completed — all resources accounted for, cleanup awaited, MCP deadlock avoided
- **C-3:** Claimed-history crash recovery flagged as unresolved — needs decision or safe recovery design
- **C-4:** SQLite close test corrected — `close(true)` does not throw for `.query()` statements
- **C-5:** Tauri kill semantics corrected — SIGKILL on Unix, TerminateProcess on Windows
- **C-6:** Scheduler readiness corrected — separate essential recovery from slow overdue execution
- **C-7:** Shutdown `exitCode` must not mask cleanup failures
- **C-8:** Repeated shutdown — shared completion semantics, not object identity

---

## 4. Target Lifecycle States and Invariants

### 4.1 State model

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

### 4.2 Valid transitions

| From | To | Trigger | Guard |
|---|---|---|---|
| `BOOTING` | `RUNNING` | All startup steps succeeded | — |
| `BOOTING` | `ROLLBACK` | Any startup step rejects | — |
| `ROLLBACK` | `FAILED` | Best-effort rollback completes | — |
| `ROLLBACK` | `RUNNING` | Rollback incomplete, no retry supported | Terminal — no retry in same process |
| `RUNNING` | `SHUTTING_DOWN` | SIGINT/SIGTERM/manual trigger | `shuttingDown` guard (one-way) |
| `SHUTTING_DOWN` | `SHUTTING_DOWN` | Repeated trigger | Idempotent — returns canonical promise (shared completion semantics) |
| `SHUTTING_DOWN` | `STOPPED` | All resources disposed | — |
| `SHUTTING_DOWN` | `RUNNING` | — | **Invalid** — one-way gate |
| `STOPPED` | `RUNNING` | — | **Invalid** — no restart in same process |

### 4.3 Invariants

1. **Single ownership:** Every resource has exactly one owner. No resource has multiple owners or an ambiguous owner.
2. **Dependency-safe disposal:** A resource is disposed only after its dependent work has stopped using it.
3. **One-way shutdown:** `shuttingDown` is a one-way gate. No new work is accepted after it is set.
4. **Settlement before close:** No owned asynchronous work that can touch the database is in flight when `db.close()` runs. A timed-out operation must not be abandoned while it can still write — it must be explicitly stopped or the shutdown must fail.
5. **Idempotent re-triggers:** Repeated shutdown triggers are no-ops that observe the same completion (shared completion semantics, not object identity).
6. **No timer outlives its owner:** Every timer is unref'd or cleared when its owner is disposed.
7. **Bounded waits:** Every drain/settlement has a bounded timeout. A stuck operation is reported (`timedOut > 0`) and explicitly handled — never silently abandoned while it can still write.
8. **Observable outcomes:** Every lifecycle operation reports success/cancelled/timedOut/failed/forced.
9. **No masked failures:** `process.exitCode = 0` is set only after all required cleanup steps succeed. A cleanup failure results in a non-zero exit code and a failed-shutdown classification.

---

## 5. Complete Resource-Ownership and Asynchronous-Operation Matrix

### 5.1 Resource ownership

| Resource | Creator | Owner | Termination trigger | Cleanup guarantee | Status |
|---|---|---|---|---|---|
| HTTP listener | `Bun.serve` (`server-listener.ts:78`) | `activeServer` module state | `server.stop(true)` in spine + `await stopPromise` | Guaranteed, best-effort per try/catch | **source-verified** |
| SQLite handle | `db/index.ts:16` module load | module singleton | `db.close()` last in spine (`server.ts:233`) | Guaranteed last-close; soft close (`close(false)`) | **source-verified** |
| MCP clients | `connect()` (`manager.ts:171`) | `mcpManager.connections` | `disconnectAll()` (`server.ts:170`) | Guaranteed; disconnected entries remain | **source-verified** |
| MCP reconnect timers | `scheduleReconnect` (`manager.ts:720`) | `conn.reconnectTimer` | cleared in `disconnect()` | Guaranteed; bounded 5×5s | **source-verified** |
| MCP in-flight connect promises | `void this.connect(id)` (`manager.ts:171`) | **not tracked** (fire-and-forget) | **none** (orphaned on startup failure) | **GAP (N-2)** | **source-verified** |
| OpenCode child | `spawn` in `start()` | `openCodeServerManager.child` | `shutdown()` SIGTERM→SIGKILL (`server.ts:164`) | Guaranteed; diagnostics tail | **source-verified** |
| Chat runs | `chatRuns.create` (route) | `records` Map | `abortAll()` + `awaitSettled(10s)` | Bounded (10s); timedOut surfaced | **source-verified** |
| Scheduler timers | `Bun.cron` / `setTimeout` in `timers` Map | module `timers` | `clearAllTimers` in `beginSchedulerShutdown` | Guaranteed; unref'd | **source-verified** |
| Scheduler runs | fire paths → `executeJobRun` | `pendingRuns` Set + `runControllers` | `abortAllRuns(10s)` | Bounded (10s); shape surfaced | **source-verified** |
| Chat-stream cleanup timer | `startChatStreamCleanup` | module `timer` (unref'd) | `stopChatStreamCleanup()` (`server.ts:214`) | Guaranteed | **source-verified** |
| History reconciler timer | `startHistoryReconciliation` | module `timer` (unref'd, `inFlight`) | `stopHistoryReconciliation()` (`server.ts:223`) | Timer stopped; in-flight tick NOT awaited | **GAP (M-3/N-4)** |
| Detached history finalization | `execute-direct-stream.ts` onEnd | **not tracked** (runs after `settled` resolves) | **none** (orphaned on shutdown) | **GAP (M-3)** | **source-verified** |
| Logger flush | `Logger` module load | singleton; `flushTimer` (unref'd) | `process.once("exit")` → `flushFileLines` | Best-effort, bounded | **source-verified** |
| Resumable store waiters | `createSqliteResumableStreamStore` | per-store `waiters` Set | `dispose()` (not called on process singleton) | Not a leak (bounded/in-flight) | **ACCEPTED** |

### 5.2 Asynchronous-operation tracking gaps

| Operation | Tracked? | Owner | Gap |
|---|---|---|---|
| MCP `connect()` during `init()` | **No** — `void this.connect(id)` is fire-and-forget | `mcpManager` | In-flight connect promises not in `connections` map until they register. Startup rollback cannot track them. (N-2) |
| Detached history finalization | **No** — runs after `settled` resolves | `chatRuns` / route | `awaitSettled` resolves before `recordFinalMessage` + `finalizeDetachedRunHistory` complete. (M-3) |
| History reconciler in-flight tick | **Partially** — `inFlight` flag prevents overlap but no promise to await | `historyReconciler` | `stopHistoryReconciliation()` clears timer but cannot await the running tick. (N-4) |
| Scheduler overdue job execution | **Yes** — tracked via `trackRun` + `pendingRuns` | `scheduler` | Correctly tracked. (M-2 is about ordering, not tracking.) |
| Chat run settlement | **Yes** — `settled` promise + `settleResolvers` Map | `chatRuns` | Correctly tracked. |

---

## 6. Startup, Rollback, Readiness, Shutdown, and Persistence Contracts

### 6.1 Startup contract

**Current sequence (source-verified):**
```
1. applyPersistedLogSettings
2. registry.loadFromDb + credentialStore.initialize
3. recoverOrphanedChatStreams
4. Promise.all([mcpManager.init(), gcOrphanChatDirs])
5. initScheduler() → recover() → handleOverdueOnce (awaits provider calls)
6. startChatStreamCleanup + startHistoryReconciliation (unref'd, fire-and-forget)
7. initListenerFetch + bindBootPort + writePortFile
8. ensureSignalHandlers
```

**Proposed sequence (M-2 + C-6 fix):**
```
1. applyPersistedLogSettings
2. registry.loadFromDb + credentialStore.initialize
3. recoverOrphanedChatStreams
4. Promise.all([mcpManager.init(), gcOrphanChatDirs])
5. initListenerFetch + bindBootPort + writePortFile  ← HTTP binds FIRST
6. ensureSignalHandlers
7. initScheduler() → recover()  ← SPLIT into two sub-phases:
   7a. Essential: mark interrupted runs, prune old runs, rebuild timers (fast, must complete before serving scheduler-dependent routes)
   7b. Overdue execution: run overdue one-time jobs (slow, runs AFTER bind, concurrent with serving)
8. startChatStreamCleanup + startHistoryReconciliation
```

**Readiness contract (C-6 corrected):**
- **Listener available:** HTTP listener is bound; `/api/server/instance` handshake can complete.
- **Scheduler-dependent routes ready:** Essential scheduler recovery (7a) has completed. Timer rebuilding is done. No new scheduler work is accepted until 7a finishes.
- **Overdue execution:** Runs concurrently with serving (7b). Does NOT block listener availability or scheduler readiness.

**Key distinction (C-6):** `initScheduler()` must be split into:
- **7a — Essential recovery** (`markInterrupted`, `pruneOldRuns`, rebuild timers): must complete before scheduler-dependent routes are served. Fast (DB reads + timer registration).
- **7b — Overdue execution** (`handleOverdueOnce` per overdue job): runs after bind. Slow (provider calls bounded by `timeoutSeconds`). Concurrent with serving.

### 6.2 Partial-startup rollback contract

**Problem (source-verified):** If step 4 or 5 rejects in the current sequence, `startServer` rejects, `index.ts` sets `process.exitCode = 1`, and `shutdownServer` is never called. MCP children/timers already spawned have no shutdown path.

**Additional gap (N-2, source-verified):** `mcpManager.init()` issues `void this.connect(id)` — fire-and-forget. The `connections` map does NOT contain an entry until the connect attempt registers one. A connect attempt that is still in-flight when `init()` rejects is not tracked by any cleanup path.

**Complete rollback sequence (C-2 corrected):**

```
rollbackPartialStartup():
  1. STOP NEW INITIALIZATION
     - Set a "startingUp" flag so the signal handler defers signals
     - Reject any new scheduler fire/schedule (gate via beginSchedulerShutdown)

  2. INVALIDATE / CANCEL ACTIVE ATTEMPTS
     - For each in-flight MCP connect: invalidate the generation counter
       (so the attempt knows it was superseded) THEN initiate client.close()
     - Do NOT await the connect promise before invalidating — that can deadlock
       (the connect may be waiting for transport.close() to settle)
     - For each registered MCP connection: disconnect (status → disconnected, clear timer, close client)
     - For each registered scheduler run: abort its AbortController

  3. INITIATE CLEANUP FOR ACQUIRED RESOURCES WITHOUT CLOSING THE DATABASE
      - HTTP listener: if bound (getActiveServer() !== null), initiate server.stop(true) and retain its completion promise
      - OpenCode child: if spawned, initiate openCodeServerManager.shutdown()
      - Chat-stream cleanup timer: if started, stopChatStreamCleanup()
      - History reconciler timer: stop scheduling new ticks; retain/await its current tick
      - Scheduler timers: gate and clear them; abort registered runs
      - MCP: initiate disconnect for registered connections and attempt-specific cleanup for in-flight connects
      - Keep the database open while any operation that might write to it can still run

   4. AWAIT TRACKED OPERATIONS (bounded, with explicit escalation)
      - Await tracked in-flight MCP attempts after invalidation/cancellation has been initiated
      - Await registered MCP disconnects, OpenCode shutdown, scheduler aborts, chat settlement/finalization, reconciler tick, and listener-stop completion
      - If an operation times out, prove it can no longer perform database work; otherwise enter the terminal process-failure path. Do not close the database merely because the wait timed out.

   5. DISPOSE DEPENDENCIES LAST
      - Close the database handle only after all DB-capable work is settled or cannot execute further because the process is being terminated
      - Use db.close(true) if selected; record any close failure
      - Log rollback outcome (success / deadline-expired-but-safe / failed)
```

**Key correction (C-2):** The rollback must account for EVERY resource acquired by the failed attempt, including:
- The already-open database handle (`db/index.ts` opens at module load)
- The chat-stream cleanup timer (started in step 6)
- The history reconciler timer (started in step 6)
- Background scheduler work (started in step 5)
- The OpenCode child (if `ensureBaseUrl` was called during init)

**MCP deadlock avoidance (C-2):** Invalidate the generation counter before awaiting a connect promise. However, generation invalidation alone is not proof that an in-flight transport can be cancelled: the implementation must retain an attempt handle early enough to initiate attempt-specific cleanup before awaiting. If the installed MCP SDK cannot interrupt a pending `connect()`, rollback must wait for it to settle within a bound; if it remains capable of spawning or using resources after that bound, the process must take the terminal failure path rather than closing the database and claiming successful rollback. R7/R8 must establish these semantics before Phase 1 is approved.

**Signal during startup:** The signal handler checks a `startingUp` flag; if set, it defers the signal until startup completes or fails.

**Retry in same process:** Not supported. A failed startup is terminal (`FAILED` state). The Tauri shell's crash recovery (≤3 restarts / 30s, `main.rs:404`) handles process-level retry.

**Listener bound but not returned:** `bindBootPort` calls `setActive(server, port)` before returning. If a later step rejects, `getActiveServer()` returns the bound listener. The rollback's `server.stop(true)` correctly closes it.

### 6.3 Shutdown contract

**Current sequence (source-verified, correct):**
```
1. beginSchedulerShutdown() — gate + clear timers
2. server.stop(true) — force-close connections (stopPromise saved, not awaited)
3. openCodeServerManager.shutdown() — SIGTERM→SIGKILL
4. mcpManager.disconnectAll()
5. chatRuns.abortAll()
6. await chatRuns.awaitSettled(10s)
7. await abortAllRuns(10s)
8. await drainInflightRequests()
9. await stopPromise
10. stopChatStreamCleanup()
11. stopHistoryReconciliation()  ← does NOT await in-flight tick
12. db.close()  ← last
```

**Changes proposed:**
- **Step 11→11a:** Add `await drainHistoryReconciliation()` before `stopHistoryReconciliation()`. This awaits any in-flight reconciliation tick.
- **Step 6→6a:** Extend `chatRuns.awaitSettled()` to also await detached-history finalization promises (or track them separately).
- **Step 12:** Switch to `db.close(true)` — see §6.5.

**Shutdown deadline escalation (N-3 + C-1 corrected):**

The current bounded waits (10s for chat/scheduler/drain) report `timedOut` counts but do not escalate. **Corrected policy:**

After all bounded waits complete, for each DB-writing operation:
- If `settled > 0 && timedOut === 0`: operation completed safely.
- If `timedOut > 0`: the operation did NOT settle within the bound. **The operation must be explicitly stopped before `db.close()`:**
  - For chat runs: the `abort()` signal has been sent; the run's `onAbort` handler must have completed (or be proven unreachable). If the handler is stuck, the run is classified as `abandoned` — its DB writes are incomplete. `db.close()` must NOT proceed while an abandoned run can still write.
  - For scheduler runs: same — `abort()` sent, handler must complete. If stuck, the run is `abandoned`.
  - For the history reconciler: the in-flight tick must be cancelled (not just the timer stopped). If the tick is mid-write, the write must complete or be explicitly interrupted.

**If an abandoned operation cannot be safely stopped:** Classify shutdown as `failed`; do not call `db.close()` while that operation could still write. `process.exitCode = 1` alone is NOT a terminal path because it does not force the process to terminate. After bounded final diagnostics, explicitly terminate the process with a non-zero exit (for example, `process.exit(1)`) so no application task can later touch the database. The abrupt exit relies only on SQLite's documented crash-recovery guarantees; it must never be reported as graceful shutdown.

**Exit code policy (C-7 corrected):**
- `shutdown_complete`: all operations settled, `db.close(true)` succeeded → `process.exitCode = 0`
- `shutdown_deadline_expired`: one or more operations timed out but were explicitly stopped; `db.close(true)` succeeded → `process.exitCode = 0` (with `timedOut > 0` in the log)
- `shutdown_failed`: one or more operations could not be stopped; `db.close()` was unsafe → bounded final diagnostics followed by explicit non-zero process termination (not `process.exitCode` alone), with the failure reason in the log

### 6.4 HTTP server stop vs. application-work drain

**Bun contract (doc-supported):**
- `server.stop(true)` immediately terminates all connections. It is **not** graceful draining.
- The returned promise resolves when every connection has closed — NOT when business operations complete.
- The `http_requests_inflight` gauge decrements when the handler returns the `Response`, not when the stream finishes.

**TBAi's current design (source-verified):** Force-close is intentional — browser SSE readers must not block shutdown. The underlying owned operations (chat runs, scheduler runs) are independently aborted and settled. This is correct.

**Key finding:** `server.stop(true)` is not described as "graceful draining" — it is force-close. The grace comes from the independent abort+settle of owned work, not from `server.stop()`.

### 6.5 SQLite closure and durability

**Current configuration (source-verified):**
- `PRAGMA journal_mode=WAL` + `synchronous=NORMAL` + `busy_timeout=5000`
- `db.close()` — soft close (`close(false)`)

**Durability guarantees (doc-supported):**

| Scenario | Guarantee |
|---|---|
| Clean `db.close()` | All committed transactions are durable. Safe. |
| Abrupt process exit (crash, SIGKILL) | WAL recovers all committed transactions. Most-recent uncommitted work is lost. No corruption. |
| OS/power loss | `synchronous=NORMAL` means the last few transactions since the last checkpoint fsync may be lost. Corruption-safe but not fully durable. |

**`db.close(true)` contract (C-4 corrected):**
- `close(false)` (TBAi's current): does not throw on close error; `.prepare()` statements keep working until finalized/GC'd.
- `close(true)`: finalizes every outstanding `.prepare()` statement, releases the connection, throws if SQLite reports a close error. Does NOT throw for `.query()` statements (those are finalized immediately by either mode).
- `close(true)` is close/error-reporting hardening — not a substitute for draining active work, not a durability fix.

**Proposed:** Switch to `db.close(true)` at shutdown, after all work is settled. This ensures outstanding `.prepare()` statements are finalized and surfaces any close error.

**Corrected acceptance test for `close(true)` (C-4):**
1. **Negative case:** Create a `.prepare()` statement, do NOT finalize it, call `db.close(true)` → the statement is finalized. Using it after close throws `Database has closed`.
2. **Positive case:** All work settled (no outstanding `.prepare()` statements), call `db.close(true)` → does NOT throw.
3. **Separate:** SQLite-reported close error (if exercisable reliably) → `close(true)` throws.

### 6.6 History finalization and recovery contract

**The M-3 window (source-verified):**

In `execute-direct-stream.ts` onEnd:
1. `settleFromUiOutcome(outcome, finishReason)` → `settleRun(settlement)` → resolves `chatRuns.settled`
2. `recordFinalMessage(streamId, { message, parentId })` — durable capture
3. `await finalizeDetachedRunHistory(chatHistoryFinalizerDeps, { streamId, responseMessage, isAborted, parentId, log })` — writes to `messages` table

The spine's `await chatRuns.awaitSettled()` waits on `settled` (step 1), but steps 2-3 happen AFTER. `db.close()` can precede steps 2-3.

**Interruption points and recovery:**

| Interruption point | State | Recovery |
|---|---|---|
| Before history claim | Row is `pending` | Reconciler picks it up (next tick or boot) |
| After claim, before `messageExists` check | Row is `claimed` | **NOT self-healing** — reconciler only selects `pending` rows. |
| During message write | Row is `claimed`; write is atomic (single `upsertStored`) | Write either completes or doesn't. If process dies mid-write, the row stays `claimed`. |
| After message write, before `completeHistory` | Row is `claimed`; message exists but `history_state` not `done` | Not self-healing (same as above) |
| Mark `skipped` fails | Row is `claimed` | Not self-healing |
| Shutdown during reconciler tick | In-flight tick is not awaited | Tick may write after `db.close()` (soft close → silent failure) |
| Process death during finalization | Row is `claimed` or `pending` | If `pending`: self-heals via reconciler. If `claimed`: stranded. |

**Key finding:** The `claimed` state is a terminal trap for the reconciler — `listPendingCompletedHistory()` only selects `pending` rows. A row that dies in `claimed` is stranded.

**Crash recovery for claimed history (C-3 — unresolved, needs maintainer decision):**

The A+B combination (tracked finalization promises + reconciler drain) only covers in-process operations. A process crash after `claimHistory` but before `completeHistory` leaves a stranded `claimed` row.

**Options:**
- **(A) Accept as documented limitation:** The `claimed` row is stranded until manual intervention. The message was captured durably (`recordFinalMessage`), so the content is not lost — only the `history_state` transition is incomplete. The next boot's reconciler will NOT pick it up. **This is a known durability gap.**
- **(B) Safe recovery mechanism:** Allow `claimed` rows to be re-armed after a configurable timeout (e.g., 5 minutes). The re-arm must check whether the message was already written (via `messageExists`) before re-offering it to the finalizer. This preserves single-winner (the claim is still the guard) and idempotency (`upsertStored` is `ON CONFLICT(id) DO UPDATE`). **Requires a deduplication analysis proving it cannot duplicate.**

**Recommendation:** Option A (accept + document) unless the deduplication analysis for Option B can be completed before implementation. The current proposal does NOT recommend Option B without that analysis.

### 6.7 Desktop/process lifecycle contract

**Current behavior (source-verified + doc-supported):**
- `quit_owned()` → `child.kill()` (`main.rs:251`) — **SIGKILL on Unix, TerminateProcess on Windows** (C-5 corrected)
- No signal handlers run; `shutdownServer` does NOT run on desktop quit
- In-flight run/session state is lost; durable data self-recovers via WAL + boot recovery

**Options for maintainer decision (D-1):**

| Option | Description | Consequences |
|---|---|---|
| A: Accept forced termination | Document the bounded in-flight-work loss on desktop quit | WAL + boot recovery handle durability. In-flight runs are lost. Simplest. |
| B: Graceful handshake via Tauri IPC | Desktop sends a Tauri event/IPC message to the frontend; frontend calls a backend `/api/shutdown` endpoint; backend runs `shutdownServer`; desktop observes exit or timeout, then `child.kill()` | In-flight work settles gracefully. Requires Tauri IPC + frontend coordination + a timeout fallback. |
| C: Hybrid | Desktop sends IPC shutdown request with a short deadline (e.g., 2s); if backend exits cleanly, done; if not, `child.kill()` | Balance of grace and boundedness. |

**If B or C is selected, the contract includes:**
1. Desktop-to-backend signaling via Tauri IPC/event (NOT POSIX signals — `kill()` is SIGKILL/TerminateProcess)
2. Backend acknowledgement (clean exit observed by Tauri)
3. Deadline (configurable, e.g., 2-5s)
4. Fallback termination (`child.kill()` after deadline)
5. Behavior if backend is hung (fallback termination)
6. Behavior if backend already exited (no-op)

**Process-group semantics (doc-supported):** Tauri `CommandChild.kill()` with `process_group` enabled kills the whole process group (POSIX) or job object (Windows). **Unresolved:** whether TBAi enables process-group mode, and whether OpenCode descendants can survive forced backend termination. This needs verification of the Tauri spawn configuration in `main.rs`.

---

## 7. Finding-by-Finding Resolution Table

### 7.1 Previous findings (from v1 + audit)

| ID | Finding | Resolution | Phase |
|---|---|---|---|
| M-1 | Partial-startup failure orphans MCP children/timers | Add `rollbackPartialStartup()` in `index.ts` catch; track in-flight MCP connect promises (N-2) | 1 |
| M-2 | Scheduler recovery delays HTTP readiness | Split `initScheduler()` into essential recovery (7a) + overdue execution (7b) | 3 |
| M-3 | Post-settlement detached-history DB writes not awaited | Track detached finalization promises; `awaitSettled()` awaits them + drain reconciler tick | 2 |
| L-1 | No global `unhandledRejection` handler | Maintainer decision: add fatal handler with bounded cleanup, or record local-containment decision | 5 |
| L-2 | No repeated-SIGINT spine test | Add test that triggers `shutdownServer` twice; assert idempotent + shared completion | 2 |
| D-1 | Desktop quit bypasses graceful shutdown | **Maintainer decision required** (A/B/C in §6.7) | Blocking |
| D-2 | OpenCode sessions not terminated on shutdown | Folds into D-1 decision | Blocking (with D-1) |

### 7.2 New findings (from documentation review + deeper analysis)

| ID | Finding | Resolution | Phase |
|---|---|---|---|
| N-1 | `db.close()` is a soft close | Switch to `db.close(true)` after all work settled | 4 |
| N-2 | Startup rollback cannot track in-flight MCP connect promises | Add a tracked Set for in-flight connects on `mcpManager`; invalidate before awaiting | 1 |
| N-3 | Shutdown deadlines have no escalation policy | Escalation policy: stop abandoned operations or fail shutdown (C-1) | 4 |
| N-4 | History reconciler drain not observable | Expose in-flight promise; `await drainHistoryReconciliation()` before close | 2 |
| N-5 | Repeated shutdown returns immediately, not canonical completion | Shared completion semantics (all callers observe same completion) | 1b |
| C-1 | Shutdown timeout abandons DB-writing work before close | Explicit escalation: stop the operation or fail the shutdown | 4 |
| C-2 | Startup rollback incomplete | Complete sequence: stop → invalidate → cleanup → await → dispose | 1 |
| C-3 | Claimed-history crash recovery unresolved | Maintainer decision: accept as limitation or design safe recovery | Blocking |
| C-4 | SQLite close test incorrect | Test actual contract: `close(true)` finalizes `.prepare()`, does not throw for `.query()` | 4 |
| C-5 | Tauri kill semantics misstated | SIGKILL on Unix, TerminateProcess on Windows | 6 |
| C-6 | Scheduler readiness not solved | Split `initScheduler()` into essential recovery + overdue execution | 3 |
| C-7 | Shutdown `exitCode = 0` masks failures | Exit code policy: 0 only on success; 1 on failed shutdown | 4 |
| C-8 | Repeated shutdown: async wrapper creates distinct promises | Shared completion semantics, not object identity | 1b |

---

## 8. Updated Architecture Recommendation

### 8.1 Target model

The target lifecycle model preserves the existing module-owned architecture. No new framework. No generic lifecycle manager. The changes are:

1. **Startup rollback path** (M-1 + N-2 + C-2): A `rollbackPartialStartup()` function that accounts for every acquired resource, invalidates before awaiting, and disposes in dependency-safe order.
2. **Tracked asynchronous work** (M-3 + N-4): Every DB-writing operation is tracked by a promise that the shutdown spine awaits. No fire-and-forget DB writes.
3. **Readiness decoupling** (M-2 + C-6): Split `initScheduler()` into essential recovery (before serving) + overdue execution (after bind).
4. **Shutdown deadline escalation** (N-3 + C-1): Bounded waits with explicit escalation — stop abandoned operations or fail the shutdown.
5. **Canonical shutdown completion** (N-5 + C-8): Repeated triggers observe the same completion (shared semantics).
6. **SQLite close hardening** (N-1 + C-4): `db.close(true)` with corrected test contract.
7. **Process-level error policy** (L-1): Maintainer decision on fatal handler.
8. **Exit code policy** (C-7): `exitCode = 0` only on success; `1` on failed shutdown.

### 8.2 What is preserved

- The shutdown spine's ordering and idempotency (with additions, not replacements)
- The chat-run single-winner settlement semantics (extended to cover finalization)
- The scheduler's abort-aware retry loop
- The MCP generation-gated ownership model (extended to cover in-flight connects)
- The OpenCode child orphan/restart hardening
- The boot recovery honesty and idempotency
- The DB hardening (WAL + busy_timeout)
- The "no timer keeps the process alive" invariant
- The server binding to `0.0.0.0`
- The `bun:sqlite` synchronous model

---

## 9. Reordered Implementation Phases

### Phase 1: Startup-failure rollback + in-flight MCP tracking (M-1, N-2, C-2)

**Contract established:** A failed `startServer` runs a best-effort rollback of every resource acquired by that attempt, including in-flight MCP connect promises, before setting `exitCode`. The rollback invalidates before awaiting to avoid MCP deadlock.

**Source areas:**
- `src/index.ts` (catch block)
- `src/services/mcp/manager.ts` (track in-flight connects; extend `disconnectAll`; invalidate before awaiting)
- `src/services/scheduler/scheduler.ts` (use existing `beginSchedulerShutdown`)

**Design:**
- Add a `connectingPromises` Set to `McpManager` that tracks connect attempts from `void this.connect(id)` until they register in `connections` (or fail).
- `disconnectAll()` invalidates the generation counter for in-flight connects BEFORE awaiting their settlement (avoids deadlock), then iterates registered `connections`.
- Add `rollbackPartialStartup()` in `index.ts` catch following the complete sequence: stop new init → invalidate/cancel → initiate cleanup → await tracked ops (bounded) → dispose dependent resources.
- Rollback accounts for: HTTP listener, OpenCode child, cleanup timer, history reconciler timer, scheduler timers/runs, and the database handle.

**Why first:** Independent, low-risk. Closes the only gap where resources can be orphaned without any cleanup path. Establishes the rollback pattern.

**Acceptance criteria:** A test forces a subsystem throw mid-`startServer` (with an in-flight MCP connect) and asserts: (a) `mcpManager.connections` is empty, (b) no reconnect timers armed, (c) the in-flight connect promise settled, (d) `db` was closed, (e) the listener was stopped, (f) the cleanup/reconciler timers were stopped.

**Tests:**
- `tests/integration/core/startup-rollback.test.ts` — force `gcOrphanChatDirs` to reject with an in-flight MCP connect; assert all resources cleaned.

**Regression risks:** None. The rollback only runs on the failure path.

**Evidence:** Test passes; typecheck + build exit 0.

### Phase 1b: Canonical shutdown completion (N-5, C-8)

**Contract established:** Repeated shutdown triggers observe the same completion (shared completion semantics, not object identity).

**Source areas:**
- `src/server.ts` (store canonical promise; return it on repeated calls)

**Design:** `shutdownServer` stores the shutdown promise in a module-level variable on first call. Repeated calls return the same promise. Because an `async` function always returns a new wrapper promise, the requirement is **shared completion semantics** — all callers resolve when the same shutdown completes — not object identity.

**Why here:** N-5 is a one-line contract change, independent of the `awaitSettled` semantics. It lands before the riskier Phase 2 changes so a regression in Phase 2 does not block it.

**Acceptance criteria:** A second `shutdownServer` call resolves when the first shutdown completes; both callers observe the same outcome.

**Tests:**
- Extend `tests/integration/core/shutdown-lifecycle.test.ts` — repeated shutdown resolves together.

**Regression risks:** None. The guard already exists; this changes the return value from `undefined` to the canonical promise.

**Dependencies:** None.

**Evidence:** Test passes; typecheck + build exit 0.

### Phase 2: History finalization drain (L-2, M-3, N-4)

> **Phase 2 is blocked until R5 + R9 complete (§10.8).** If R5 proves `createUIMessageStream`'s `onEnd` is not guaranteed to fire, or R9 proves `append` failures are silent, the M-3 fix shape changes. Do not start Phase 2 until these experiments are run and their results recorded.

**Contract established:** Detached-history finalization is tracked and awaited before `db.close()`. History reconciler in-flight tick is drained before `db.close()`.

**Source areas:**
- `src/services/chat-runs.ts` (track detached finalization promises)
- `src/services/chat-streams/historyReconciler.ts` (expose in-flight promise)
- `tests/integration/core/shutdown-lifecycle.test.ts` (extend)

**Design:**
- `chatRuns` gains a `finalizationPromises` Set. `awaitSettled()` awaits both `settled` and all `finalizationPromises`.
- `historyReconciler` exposes `getInFlightPromise()`. The spine calls `await drainHistoryReconciliation()` before `stopHistoryReconciliation()`.

**Why second (after 1b):** M-3/N-4 close the DB-write window by changing `awaitSettled` semantics. This is the riskiest change in the proposal — it must land in its own, well-tested diff, separate from the trivial N-5 contract change.

**Acceptance criteria:** (a) A test opens the `settled`-then-write window and asserts `db.close()` cannot precede the finalization. (b) A test proves `stopHistoryReconciliation()` awaits an in-flight tick.

**Tests:**
- Extend `tests/integration/core/shutdown-lifecycle.test.ts` — detached finalization drain; reconciler tick drain.
- `tests/integration/chat/historyReconciler.test.ts` — in-flight tick is awaited.

**Regression risks:** Changing `awaitSettled` timing could affect chat-run settlement semantics. Must preserve single-winner `settle()`.

**Dependencies:** Phase 1 (rollback pattern), Phase 1b (canonical promise), R5 + R9 (AI SDK + assistant-ui experiments).

**Evidence:** Tests pass; typecheck + build exit 0.

### Phase 3: Readiness decoupling from overdue jobs (M-2, C-6)

**Contract established:** Essential scheduler recovery completes before scheduler-dependent routes are served. Overdue execution runs concurrently with serving.

**Source areas:**
- `src/services/scheduler/scheduler.ts` (`recover` overdue path)
- `src/server.ts` (ordering)

**Design:** Split `initScheduler()` into:
- **7a — Essential recovery:** `markInterrupted`, `pruneOldRuns`, rebuild timers. Must complete before scheduler-dependent routes are served.
- **7b — Overdue execution:** `handleOverdueOnce` per overdue job. Runs after bind, concurrent with serving.

**Why third:** Changes startup ordering (a readiness contract). Must be after Phase 1 (rollback pattern) and Phase 2 (spine test).

**Acceptance criteria:** (a) A test with a slow/blackhole overdue job shows the listener becomes reachable without waiting for the run. (b) A test proves scheduler-dependent routes are not served until essential recovery (7a) completes.

**Tests:**
- `tests/integration/core/readiness.test.ts` — blackhole overdue job; assert listener reachable before job completes AND scheduler-dependent routes not served until 7a done.

**Regression risks:** Changing startup ordering could affect the Tauri handshake timing.

**Dependencies:** Phase 1, Phase 1b, Phase 2.

**Evidence:** Test passes; typecheck + build exit 0.

### Phase 4: Shutdown deadline escalation + SQLite close hardening (N-1, N-3, C-1, C-4, C-7)

**Contract established:** (a) Shutdown escalation: timed-out DB-writing operations are explicitly stopped or the shutdown fails. (b) `db.close(true)` finalizes outstanding `.prepare()` statements. (c) Exit code policy: 0 only on success, 1 on failed shutdown.

**Source areas:**
- `src/server.ts` (escalation; `db.close(true)`; exit code policy)
- `src/services/chat-runs.ts` (report `timedOut` in escalation)

**Design:**
- After all bounded waits, for each DB-writing operation: if `timedOut > 0`, explicitly stop the operation (cancel the in-flight handler) before `db.close()`. If the operation cannot be stopped, fail the shutdown.
- Change `db.close()` to `db.close(true)`.
- Exit code: `0` only if all operations settled or were explicitly stopped AND `db.close(true)` succeeded; `1` otherwise.

**Why fourth:** These are observability/hardening improvements that depend on the spine changes from Phase 2.

**Acceptance criteria:** (a) A test with a stuck operation that CAN be stopped produces `shutdown_deadline_expired` and exit code 0. (b) A test with a stuck operation that CANNOT be stopped produces `shutdown_failed` and exit code 1. (c) `db.close(true)` finalizes an outstanding `.prepare()` statement (negative case). (d) `db.close(true)` does NOT throw when all work is settled (positive case). (e) `db.close(true)` does NOT throw for a `.query()` statement (corrected contract).

**Tests:**
- Extend `tests/integration/core/shutdown-lifecycle.test.ts` — stuck operation classification (stoppable vs non-stoppable).
- `tests/unit/persistence/db.test.ts` — `close(true)` behavior (all three cases above).

**Regression risks:** `db.close(true)` could throw if SQLite reports a close error. Must prove all work is settled first.

**Dependencies:** Phase 2.

**Evidence:** Tests pass; typecheck + build exit 0.

### Phase 5: Process-level error policy (L-1)

**Contract established:** A documented policy for `unhandledRejection`/`uncaughtException`.

**Source areas:**
- `src/index.ts` or `src/lib/logger.ts`

**Design:** Maintainer choice:
- (a) Add `process.on("unhandledRejection", ...)` as a fatal handler with bounded cleanup + exit.
- (b) Record in `docs/decisions.md` that local containment is the documented choice.

**Why last:** Safety net for all of the above.

**Acceptance criteria:** A test in an isolated child process (using Bun 1.4.3 only) triggers an unhandled rejection and asserts the handler logs it (or the decision is recorded).

**Tests:**
- `tests/integration/core/unhandled-rejection.test.ts` — child process; assert handler logs.

**Regression risks:** None. Additive.

**Dependencies:** None (logically last).

**Evidence:** Test passes; typecheck + build exit 0.

### Phase 6: Desktop lifecycle decision (D-1, D-2, C-5)

**Contract established:** The desktop quit path is a settled decision based on actual platform kill semantics (SIGKILL on Unix, TerminateProcess on Windows).

**Source areas:**
- `src-tauri/src/main.rs` (if graceful shutdown selected)
- Tauri IPC/event mechanism (if graceful shutdown selected)

**Why last:** This is a maintainer decision, not a code change in the backend. If option B/C is selected, it requires Tauri-side changes.

**Acceptance criteria:** The decision is recorded in `docs/decisions.md`. If graceful shutdown is selected, the handshake is implemented and tested.

**Dependencies:** All code phases complete.

---

## 10. Pre-Implementation Documentation and Runtime Verification Gates

This section maps each required documentation study or runtime verification to the specific implementation phase it gates. Not every study blocks every phase. Each entry lists the authoritative source, the exact API/version, the question being resolved, the evidence required, and the phase whose design depends on the answer.

### 10.1 Research method

**Documentation/source analysis** can establish:
- API contracts, type signatures, callback shapes
- Guaranteed vs best-effort behavior
- Version-specific semantics

**Documentation/source analysis cannot establish:**
- Actual runtime behavior in TBAi's specific configuration
- Timing guarantees under load
- Interaction between multiple subsystems

**Runtime verification** is required when:
- The proposal's safety argument depends on a timing or ordering guarantee
- A documentation claim could be version-specific or configuration-dependent
- A failure mode has never been empirically observed

Each study below is labeled **[doc]** (documentation/source sufficient)**, **[runtime]** (requires live verification)**, or **[doc+runtime]** (documentation establishes the contract; runtime confirms TBAi's usage)**.

---

### 10.2 AI SDK v7 — `createUIMessageStream` `onEnd` callback contract

**Phase gated:** Phase 2 (M-3 history finalization drain)

**Installed version:** `ai@7.0.137` (from `node_modules/ai/package.json`)

**Authoritative source:** `node_modules/ai/dist/index.d.ts` — `UIMessageStreamOnEndCallback<UI_MESSAGE>` type (line 2715)

**What the source establishes [doc]:**

The `onEnd` callback type is:
```typescript
type UIMessageStreamOnEndCallback<UI_MESSAGE> = (event: {
  messages: UI_MESSAGE[];
  isContinuation: boolean;
  isAborted: boolean;
  isCancelled?: true;
  outcome: UIMessageStreamOutcome;
  responseMessage: UI_MESSAGE;
  finishReason?: FinishReason;
}) => PromiseLike<void> | void;
```

Key facts:
1. The callback can be `async` (returns `PromiseLike<void>`) — TBAi's `onEnd` in `execute-direct-stream.ts` is `async`.
2. The callback receives `isAborted`, `isCancelled`, `outcome`, and `responseMessage` — TBAi uses all of these.
3. The callback is called when "all steps are finished and the response is complete" (line 3747: `@param onEnd - Callback that is called when all steps are finished and the response is complete.`).

**Critical distinction — `streamText` `onEnd` vs `createUIMessageStream` `onEnd` (C-6 correction):**

TBAi does NOT use `streamText`'s `onEnd` callback. TBAi uses `createUIMessageStream`'s `onEnd` callback (in `execute-direct-stream.ts`). These are **different callbacks** with different contracts:
- `streamText`'s `onEnd` is a parameter to `streamText()` — called when the underlying model stream finishes.
- `createUIMessageStream`'s `onEnd` is a parameter to `createUIMessageStream()` — called when the UI message stream finishes, which includes the response body lifecycle.

The M-3 fix depends on `createUIMessageStream`'s `onEnd` contract, NOT `streamText`'s. The runtime experiments (R5/R6) must use `createUIMessageStream`'s `onEnd`.

**What the source does NOT establish [runtime]:**
- Whether `createUIMessageStream`'s `onEnd` is guaranteed to be called in ALL termination paths (clean finish, abort, error, cancellation)
- Whether awaited work inside `onEnd` is guaranteed to complete before the response stream closes
- Whether `onEnd` can be delayed past the HTTP response completing

**Question being resolved:** Is `createUIMessageStream`'s `onEnd` guaranteed to fire, and is its awaited work guaranteed to complete before the stream lifecycle ends? If `onEnd` can be skipped or its work delayed, the M-3 fix (tracking finalization promises) may need to be reimplemented.

**Evidence required:**
1. Read AI SDK's `createUIMessageStream` source to trace all termination paths and confirm `onEnd` is called on each.
2. Deterministic test: a `createUIMessageStream` call with an `onEnd` that awaits a deferred promise — does the response stream close before or after the promise resolves?
3. Deterministic test: abort the stream mid-execution — does `onEnd` fire? Does its awaited work complete?

**If this disproves an assumption:** If `onEnd` is NOT guaranteed to fire, or its awaited work is NOT guaranteed to complete, the M-3 fix must be redesigned. The current proposal assumes `onEnd` fires and its `await finalizeDetachedRunHistory` completes. If that is wrong, the finalization must be moved into a different settlement signal (e.g., the `streamText` result promise, not the `onEnd` callback).

---

### 10.3 assistant-ui — `ThreadHistoryAdapter` contract

**Phase gated:** Phase 2 (M-3 history finalization drain)

**Installed version:** `@assistant-ui/core@0.3.26` (from `node_modules/.bun/@assistant-ui+core@0.3.26+c2ca662fcbb008fb/`); `@assistant-ui/ai-sdk@0.0.12` (the runtime package TBAi uses)

**Authoritative source:** `node_modules/.bun/@assistant-ui+core@0.3.26+c2ca662fcbb008fb/node_modules/@assistant-ui/core/dist/adapters/thread-history.d.ts`

**What the source establishes [doc]:**

The `ThreadHistoryAdapter` type:
```typescript
export type ThreadHistoryAdapter = {
  scopeId?: string | undefined;
  load(): Promise<ExportedMessageRepository & { ... }>;
  resume?(options: ChatModelRunOptions): AsyncGenerator<ChatModelRunResult, void, unknown>;
  append(item: ExportedMessageRepositoryItem): Promise<void>;
  update?(item: ExportedMessageRepositoryItem): Promise<void>;
  delete?(items: ExportedMessageRepositoryItem[]): Promise<void>;
  withFormat?<TMessage, TStorageFormat>(...): GenericThreadHistoryAdapter<TMessage>;
};
```

Key facts:
1. `append` returns `Promise<void>` — it is async and awaited.
2. `update` is optional — TBAi's adapter may or may not implement it.
3. The doc comment on `update` (line 70) says: "An update may arrive for an id whose earlier write failed; treat it as an upsert keyed on the message id rather than assuming the entry exists."
4. `delete` doc (line 74): "treat deleting a missing entry as success."

**What the source does NOT establish [runtime]:**
- When exactly `append` is called relative to the AI SDK's `onEnd` callback
- Whether `append` failures throw, reject, or are caught internally
- How TBAi's custom `ThreadHistoryAdapter` (in `web/src/adapters/threadHistoryAdapter.ts`) implements error propagation
- Whether `append` is called before or after the response stream closes

**Question being resolved:** When does the adapter's `append` write happen relative to the server-side `createUIMessageStream` `onEnd`? If `append` happens inside `onEnd` (or after it), and it can fail, the server-side reconciler's invariants depend on understanding that failure mode.

**Evidence required:**
1. Read TBAi's `web/src/adapters/threadHistoryAdapter.ts` to see how `append`/`update` are implemented and how failures surface.
2. Read `@assistant-ui/ai-sdk@0.0.12` source (the actual runtime package) to see when `append` is called relative to stream lifecycle — not just `LocalRuntime` behavior.
3. Deterministic test: an `append` that rejects — does the error propagate to the caller, or is it caught?

**If this disproves an assumption:** If `append` is called AFTER the response stream closes (fire-and-forget from the client's perspective), the reconciler's design is correct but the failure mode is different than assumed. If `append` failures are silently caught, the reconciler's existence is justified but its invariants must account for silent failures.

---

### 10.4 Bun 1.4 — process-level error semantics

**Phase gated:** Phase 5 (L-1 unhandled rejection handler)

**Required runtime:** Bun `1.4.3` only (the version being certified)

**Authoritative source:** Bun 1.4 release notes (https://bun.sh/blog/bun-v1.4); Bun process API docs (https://bun.sh/docs/runtime/process)

**What the source establishes [doc]:**
- Bun 1.4 is a ground-up Rust rewrite with its own process model.
- Bun 1.4 release notes do NOT document `unhandledRejection`/`uncaughtException` fatal semantics.
- Node.js documentation is not applicable — TBAi runs exclusively on Bun.

**What the source does NOT establish [runtime]:**
- Whether Bun 1.4 crashes by default on unhandled rejections (like Node's `throw` mode)
- Whether Bun 1.4 has an `uncaughtExceptionMonitor` equivalent
- Whether installing a handler changes the exit code or behavior

**Question being resolved:** What does Bun 1.4 actually do when an unhandled rejection or uncaught exception occurs? Does it crash (default), continue (Node's `warn` mode), or something else?

**Evidence required (isolated child-process experiments):**
1. Spawn a Bun child process (using Bun 1.4.3 only) that triggers an unhandled rejection — observe: does it crash? What exit code? Is there a stderr message?
2. Spawn a Bun child process that triggers an uncaught exception — observe the same.
3. Install `process.on("uncaughtException", ...)` in a Bun child — observe: does it override the default? What exit code results?
4. Install `process.on("unhandledRejection", ...)` in a Bun child — observe the same.

**Test isolation:** These experiments MUST run in an isolated child process (`Bun.spawn`), never in the main test runner. A genuine unhandled failure in the test runner would poison the suite.

**If this disproves an assumption:** If Bun 1.4 does NOT crash on unhandled rejections (i.e., it continues by default), the L-1 fix is more critical — a handler must be installed to make the process fatal. If Bun 1.4 DOES crash by default, the handler is optional (observability only).

---

### 10.5 MCP SDK — `Client.close()`, transport, and connection lifecycle

**Phase gated:** Phase 1 (M-1 + N-2 startup rollback + in-flight connect tracking)

**Installed version:** `@modelcontextprotocol/client@2.3.1` + `@modelcontextprotocol/core@2.3.1` (from `node_modules/.bun/@modelcontextprotocol+client@2.3.1/`)

**Authoritative source:** `node_modules/.bun/@modelcontextprotocol+client@2.3.1/node_modules/@modelcontextprotocol/client/dist/` — Client implementation; `@modelcontextprotocol/core` — transport types

**What the source establishes [doc]:**
- The MCP SDK is at v2.3.1 (not v1). The v2 API is the installed version.
- TBAi's `manager.ts` uses `transport.onclose`, `client.close()`, `cancelPendingElicitation`, and `scheduleReconnect`.

**What the source does NOT establish [runtime]:**
- Whether `Client.close()` is idempotent (TBAi assumes it is)
- Whether pending requests are rejected or resolved on close
- Whether `transport.onclose` is guaranteed to fire on all transport failure paths
- Whether an in-flight `connect()` can be cancelled by `close()`
- Whether the stdio child process is reaped when the transport closes

**Question being resolved:** What is the exact contract for `Client.close()`, pending-request settlement, `transport.onclose`, and connection-attempt cancellation? The N-2 fix (tracking in-flight connect promises) depends on understanding when a connect attempt can be cancelled vs when it must be awaited.

**Evidence required:**
1. Read the MCP SDK Client source to verify `close()` idempotency and pending-request behavior.
2. Read the `StdioClientTransport` source to verify child-process cleanup on close.
3. Deterministic test: start a `connect()`, call `close()` before it resolves — what happens? Does the connect promise reject? Is the child process killed?
4. Deterministic test: trigger an unexpected transport close — does `onclose` fire? Is it guaranteed?

**If this disproves an assumption:** If `Client.close()` does NOT cancel an in-flight `connect()`, the N-2 fix must track those promises explicitly and await them in rollback. If `close()` rejects pending requests (rather than resolving them), the rollback must handle rejections.

**MCP deadlock avoidance (C-2):** The rollback must invalidate the generation counter BEFORE awaiting in-flight connect promises. Awaiting before invalidating risks deadlock if the connect is waiting for the transport to close.

---

### 10.6 Tauri — desktop shutdown lifecycle

**Phase gated:** Phase 6 (D-1 desktop decision) — **mandatory only if the implementation changes desktop shutdown behavior**

**Installed version:** `tauri-plugin-shell@2` (locked: 2.5.0), `tauri@2` (from `src-tauri/Cargo.toml`)

**Authoritative source:** https://docs.rs/tauri-plugin-shell/latest/tauri_plugin_shell/process/struct.CommandChild.html — `kill()` method

**What the source establishes [doc]:**
- `CommandChild.kill()` (v2.5.0): "Sends a kill signal to the child and waits for it to exit." On Unix, Rust's `Child::kill()` maps to **SIGKILL**. With `process_group` enabled, Tauri uses `killpg(..., SIGKILL)`. On Windows, `TerminateProcess` or job-object termination.
- TBAi's `quit_owned()` calls `child.kill()` — **forced termination (SIGKILL on Unix, TerminateProcess on Windows), not graceful shutdown**.

**What the source does NOT establish [doc]:**
- Whether there is a graceful termination method distinct from `kill()`
- Whether TBAi enables process-group mode
- Whether OpenCode descendants can survive forced backend termination

**Question being resolved:** If D-1 selects graceful shutdown (option B/C), what is the exact mechanism? A graceful handshake needs a distinct application-level communication mechanism (Tauri IPC/event), not a POSIX signal.

**Evidence required (only if D-1 selects B/C):**
1. Read Tauri v2's IPC/event mechanism for desktop-to-backend signaling.
2. Verify whether TBAi enables process-group mode in the Tauri spawn configuration.
3. Verify whether OpenCode descendants survive forced backend termination.

**If this disproves an assumption:** If Tauri has no graceful termination API, option B/C is infeasible and D-1 must select option A (accept forced termination).

---

### 10.7 Hono — fetch handler and error lifecycle

**Phase gated:** None directly (supporting research)

**Installed version:** `hono@4.13.13` (from `node_modules/hono/package.json`)

**Authoritative source:** https://hono.dev/docs/api/hono — `app.fetch`, `app.onError`

**What the source establishes [doc]:**
- Hono's `app.fetch` is the entry point for `Bun.serve`.
- `app.onError` handles uncaught route errors and returns a 500 response.

**What the source does NOT establish [runtime]:**
- Whether `app.onError` runs before or after the response stream closes
- Whether middleware (like `accountingMiddleware`) can track response stream completion

**Question being resolved:** Does Hono's error handler or middleware lifecycle materially affect the drain contract?

**Evidence required:**
1. Read Hono's `app.fetch` source to trace when middleware runs relative to response streaming.
2. Confirm that `accountingMiddleware`'s `inflight--` happens when the handler returns, not when the stream closes (already established from Bun's docs).

**Why this is supporting, not blocking:** The drain contract is already determined by Bun's `server.stop()` semantics and TBAi's `http_requests_inflight` gauge. Hono's lifecycle is a secondary concern. This study is only needed if Phase 4 (drain escalation) reveals a gap in the HTTP-layer tracking.

---

### 10.8 Runtime verification test plan

The following experiments MUST be executed in an isolated child process (using Bun 1.4.3 only), never in the main test runner:

| # | Experiment | What it proves | Phase |
|---|---|---|---|
| R1 | Bun child: unhandled rejection | Does Bun 1.4 crash by default? What exit code? | 5 |
| R2 | Bun child: uncaught exception | Does Bun 1.4 crash by default? What exit code? | 5 |
| R3 | Bun child: `uncaughtException` handler installed | Does the handler override default? What exit code? | 5 |
| R4 | Bun child: `unhandledRejection` handler installed | Does the handler override default? What exit code? | 5 |
| R5 | `createUIMessageStream` with async `onEnd` that awaits a deferred promise | Does the response stream close before or after `onEnd` completes? | 2 |
| R6 | `createUIMessageStream` aborted mid-stream | Does `onEnd` fire? Does its awaited work complete? | 2 |
| R7 | MCP `connect()` + `close()` before connect resolves | Is the connect promise rejected? Is the child killed? | 1 |
| R8 | MCP unexpected transport close | Does `onclose` fire? Is it guaranteed? | 1 |
| R9 | `@assistant-ui/ai-sdk` `ThreadHistoryAdapter.append` that rejects | Does the error propagate? Is it caught? | 2 |

**Isolation method:** Each experiment spawns a `Bun.spawn` child process with a test script. The child's exit code and stdout/stderr are observed. The main test runner never triggers genuine unhandled failures.

**Critical sequencing rule:** Do NOT start Phase 2 until R5 + R9 are run and their results recorded.

---

### 10.9 Documentation study summary

| # | Technology | Phase | Type | Blocks phase? | Key question |
|---|---|---|---|---|---|
| 1 | AI SDK v7 (`createUIMessageStream` `onEnd`) | 2 | doc+runtime | **Yes** | Is `onEnd` guaranteed to fire and its awaited work to complete? |
| 2 | assistant-ui (`@assistant-ui/ai-sdk` + custom adapter) | 2 | doc+runtime | **Yes** | When does `append` happen relative to `onEnd`? How do failures surface? |
| 3 | Bun 1.4 process semantics | 5 | runtime | **Yes** | What does Bun 1.4 do on unhandled rejection/exception? |
| 4 | MCP SDK v2 | 1 | doc+runtime | **Yes** | What is `Client.close()` contract for in-flight connects? |
| 5 | Tauri | 6 | doc | Only if D-1 selects B/C | Is there a graceful termination API? |
| 6 | Hono | — | doc | No | Does Hono's lifecycle affect the drain contract? |

**Critical path:** Studies 1, 2, 3, and 4 are blockers for their respective phases. Study 5 is conditional. Study 6 is supporting.

**What can be established from documentation/source alone:**
- API contracts and type signatures (all studies)
- Guaranteed vs best-effort behavior (Bun server.stop, SQLite WAL, Tauri kill)
- Version-specific semantics (MCP v2 vs v1, Bun 1.4 vs 1.3)

**What requires runtime verification:**
- Whether `createUIMessageStream`'s `onEnd` is guaranteed to fire in all termination paths
- Whether Bun 1.4 crashes by default on unhandled rejections
- Whether MCP `Client.close()` cancels in-flight connects
- Whether assistant-ui `append` failures propagate or are caught

---

## 11. Maintainer Decisions Required Before Implementation

| ID | Decision | Options | Blocking? |
|---|---|---|---|
| D-1 | Desktop quit: accept forced termination or add graceful handshake? | (a) Accept + document, (b) Graceful handshake via Tauri IPC, (c) Hybrid (IPC + deadline + fallback) | **Yes** — certification blocked until decided |
| D-2 | OpenCode sessions on shutdown: accept die-with-child or add per-session termination? | (a) Accept, (b) Add termination | No — folds into D-1 |
| D-3 | Process-level error policy: fatal handler or local containment? | (a) Fatal handler with bounded cleanup, (b) Record local-containment decision | No — Phase 5 can proceed with either |
| D-4 | M-3 fix shape: (A) tracked finalization promise, (B) reconciler drain, (C) revised history-state transitions? | A + B combined (recommended for in-process drains; does not solve crash-after-claim) | Yes for Phase 2 certification until R5/R9 and C-3 are resolved |
| D-5 | `db.close(true)` vs `db.close(false)`? | (a) Switch to `close(true)`, (b) Keep `close(false)` | No — Phase 4 can proceed with either |
| D-6 | MCP disconnected-entry lifetime: accept or promote to removal? | (a) Accept, (b) Remove on disconnect | No — accepted limitation today |
| C-3 | Claimed-history crash recovery: accept as limitation or design safe recovery? | (a) Accept + document, (b) Design safe recovery with deduplication analysis | **Yes** — must be decided before Phase 2 certification |

---

## 12. Explicit Out-of-Scope Items and Compatibility Requirements

### 12.1 Out of scope

- No new architecture or lifecycle framework
- No changes to the assistant-ui dependency train (frozen)
- No changes to the OpenCode isolation boundary
- No changes to the MCP isolation boundary
- No changes to the persistence schema
- No changes to the Tauri shell (unless D-1 selects graceful shutdown)
- No changes to the frontend
- No changes to the provider-agnostic chat architecture
- No changes to the encryption architecture
- No rewriting of historical point-in-time docs
- No changes to `docs/decisions.md` as the architectural decision record (except adding new entries for decided items)

### 12.2 Compatibility requirements

- All current routes, providers, and UI surfaces must continue to work unchanged
- The Tauri `/api/server/instance` handshake, the port file protocol, and the assistant-ui runtime contract must remain unchanged
- Persistence schema: no changes
- Dependency train: no `@assistant-ui/*` changes, no new dependencies
- Chat streaming/resume semantics: unchanged
- MCP contracts: unchanged
- Scheduler missed-run semantics: unchanged
- SQLite schema: unchanged

---

## 13. Final Verdict

**HOLD — one more planning-only revision needed before implementation.**

**What is grounded:**
- All findings are source-verified against the current branch
- All external recommendations are documented with source URLs
- The phase plan is ordered by actual dependencies
- Each phase has observable acceptance criteria and test requirements
- The plan does not leave the subsystem internally inconsistent at any phase boundary

**What is unresolved and blocking:**
- **D-1** (desktop quit) — maintainer decision required
- **C-3** (claimed-history crash recovery) — maintainer decision required (accept as limitation or design safe recovery)
- **C-1** (shutdown escalation policy) — needs implementation, not just decision
- **R5 + R9** (AI SDK + assistant-ui experiments) — must be run before Phase 2

**What can proceed now (independent of blockers):**
- Phase 1 (startup-failure rollback + MCP tracking) — gated by MCP study (R7/R8)
- Phase 1b (canonical shutdown completion) — independent, no blockers

**What is blocked until R5 + R9 complete:**
- Phase 2 (history finalization drain)

**What is blocked until maintainer decides:**
- Phase 6 (desktop lifecycle) — blocked on D-1
- Phase 2 certification — blocked on C-3

**Recommended immediate next steps:**
1. Maintainer decides D-1, D-2, D-3, D-4, D-5, D-6, C-3 (one review pass)
2. Execute the four critical documentation/runtime studies (§10.9): AI SDK `createUIMessageStream` `onEnd` contract, assistant-ui `append` contract, Bun 1.4 process semantics, MCP `Client.close()` contract
3. Begin Phase 1 (M-1 + N-2 + C-2 startup-failure rollback) — gated by MCP study
4. Begin Phase 1b (N-5 + C-8 canonical shutdown completion) — independent, no blockers
5. Begin Phase 2 (L-2 + M-3 + N-4 + N-5 history drain) — gated by R5 + R9

---

*Proposal v2.2. Updated from the maintainer-provided v2.1 review artifact. Planning document only; no production code, tests, or runtime configuration were changed. Implementation remains on HOLD; no runtime experiments are represented as completed.*