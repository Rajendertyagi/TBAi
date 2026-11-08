# TBAi — Backend Lifecycle & Resource Ownership Audit

**Mode:** READ-ONLY · **Date:** 2026-10-16 · **Branch under audit:** `fix/mcp-lifecycle-and-history-e2e`
**HEAD:** `1b35278d8a72984ea001e3ed15dec3337d3cc9d8` · **Working tree:** clean (no commit or push performed)

This is an independent, read-only audit of the **current implementation** of Backend
Lifecycle & Resource Ownership. It does **not** restart the broad application audit,
add features, or begin implementation. All findings are traced to current source on
this branch. No production code, tests, configuration, dependencies, migrations, or
documentation were modified; no files were committed or pushed.

---

## 1. Scope and exact Git state

| Item | Value |
|---|---|
| Branch | `fix/mcp-lifecycle-and-history-e2e` |
| HEAD | `1b35278d8a72984ea001e3ed15dec3337d3cc9d8` |
| Working tree | **Clean** (`git status --short` → no output) |
| Recent history | `1b35278` docs(e2e) reconciliation; `fe71f48` fix(e2e) 5xx; `704cbdd`/`e09e397`/`d751978` AppShell/routing hardening; `c3eb686`… |

**Files inspected (source):** `src/index.ts`, `src/server.ts`, `src/services/server-listener.ts`,
`src/services/server-port.ts`, `src/services/http-metrics.ts`, `src/services/chat-runs.ts`,
`src/services/scheduler/scheduler.ts`, `src/services/scheduler/schedulerExecution.ts`,
`src/services/mcp/manager.ts`, `src/services/opencode/serverManager.ts`,
`src/services/opencode/sessions.ts`, `src/services/chat-streams/{boot,cleanup,historyReconciler,historyFinalizer,sqliteResumableStore}.ts`,
`src/lib/resumable.ts`, `src/lib/logger.ts`, `src/db/index.ts`, `src/config/{providers,opencode}.ts`,
`src/services/{credentials,workspace,log-settings,grants}.ts`, `src/routes/{index,server,logs,shared}.ts`,
`src/routes/chat/{index,execute-direct-stream,settlement}.ts`, `src-tauri/src/main.rs`.

**Files inspected (tests):** `tests/integration/core/shutdown-lifecycle.test.ts`,
`tests/unit/core/chat-runs.test.ts`, `tests/unit/scheduler/scheduler.test.ts`,
`tests/integration/opencode/serverManager.test.ts`,
`tests/integration/mcp/connection-lifecycle-race.test.ts`,
`tests/integration/chat/{boot,cleanup,historyReconciler,sqliteResumableStore}.test.ts`,
`tests/integration/core/engine-guards.test.ts`, `tests/unit/persistence/db.test.ts`,
`package.json` test scripts.

**Files inspected (docs):** `docs/2026-09-17-lifecycle-hardening.md`,
`docs/2026-10-05-pm-infrastructure-audit.md`, `docs/pm-audit-request.md`,
`docs/architectural-principles.md`, `docs/engineering-quality.md` (referenced),
`docs/decisions.md` (ADR: sidecar, resumable streams), `AGENTS.md`.

**Investigation limits:** Every material lifecycle claim was verified against the
**current** source on this branch. The MCP close-detection finding (§8) is one place where
current code has moved **beyond** what the two historical docs state, so `manager.ts` was
re-read directly rather than trusted from the docs. `bun test` was **not** run in this
session and no servers were spawned; runtime behavior is marked accordingly.

---

## 2. Executive verdict

**Partially standardized.** The shutdown spine, resource-ownership boundaries, and
ordered DB-close are genuinely well-engineered and carry strong *empirical* test coverage
(MCP connect/disconnect races, OpenCode child orphan/restart/shutdown, scheduler
settlement + gate, chat-run settlement + gate, boot recovery, DB pragmas + lock-wait).
The load-bearing invariants — *new work gated before disposal, dependent work settled
before dependency close, idempotent re-triggers, no timer outlives its owner* — are all
met and tested for the core paths.

The subsystem is **not yet certifiable** because of a small set of residual gaps, none of
which is a demonstrated crash or data-loss defect: a partial-startup leak path (M-1), the
desktop-quit path bypassing graceful shutdown (an open maintainer decision, §6), a
not-explicitly-awaited DB-write window around detached-run history finalization (M-3,
self-healing), and missing belt-and-suspenders (no global unhandled-rejection handler, L-1;
no repeated-SIGINT spine test, L-2). Rankings are deliberately conservative (§6); no finding
is Critical.

---

## 3. Actual lifecycle map

**Startup** (`src/index.ts` → `startServer`, `src/server.ts:55`):

1. `applyPersistedLogSettings()` (`server.ts:64`)
2. `await registry.loadFromDb(db)` (`:68`) → `credentialStore.initialize()` (`:69`)
3. `recoverOrphanedChatStreams(db)` (`:73`) — throws if schema missing (fail-loud)
4. `await Promise.all([mcpManager.init(), gcOrphanChatDirs()])` (`:81`) — MCP `init()`
   is idempotent and **fire-and-forget** `void this.connect(id)` per enabled+autoConnect server
5. `await initScheduler()` (`:83`) — recovery **awaits overdue one-time job executions**
6. `startChatStreamCleanup(db)` (`:87`), `startHistoryReconciliation(...)` (`:91`) — both idempotent, unref'd
7. `initListenerFetch(app.fetch)` (`:99`) → `bindBootPort(port)` (`:100`, self-heal scan of
   up to 100 ports, `server-listener.ts:110`) → `writePortFile(port)` (`:104`) →
   `ensureSignalHandlers()` (`:105`) → return listener

**Runtime ownership:** single HTTP listener (`server-listener.ts` `activeServer`),
process-singleton resources (`chatRuns`, `chatStreamStore`, `mcpManager`,
`openCodeServerManager`, scheduler module maps), one shared synchronous `bun:sqlite`
handle (`db`).

**Shutdown** (SIGINT/SIGTERM → `shutdownServer`, `src/server.ts:118`):
gate scheduler (`beginSchedulerShutdown`) → `server.stop(true)` (unawaited, force-close)
→ `await openCodeServerManager.shutdown()` → `await mcpManager.disconnectAll()`
→ `chatRuns.abortAll()` + `await chatRuns.awaitSettled()` → `await abortAllRuns()`
→ `await drainInflightRequests()` → `await stopPromise` → `stopChatStreamCleanup()`
→ `stopHistoryReconciliation()` → `db.close()` (last) → `process.exitCode = 0`
(event loop drains; **no** `process.exit()`).

**Restart:** `restartListener(port)` (`server-listener.ts:150`) rebinds *only the HTTP
listener* (DB open, scheduler timers and MCP connections survive); the Tauri shell owns
the only true process restart via `main.rs` crash recovery (≤3 restarts / 30s,
`main.rs:404`).

---

## 4. Resource ownership matrix

| Resource | Creator | Owner | Termination trigger | Normal completion | Cancellation/failure | Cleanup guarantee | Evidence | Verdict |
|---|---|---|---|---|---|---|---|---|
| HTTP listener | `Bun.serve` (`server-listener.ts:82`) | `activeServer` module state | `server.stop(true)` in spine (`server.ts:154`) + `await stopPromise` | closes all conns | force-close, bounded await | Guaranteed, best-effort per try/catch | `server-listener.ts:82,150`; `server.ts:154,199` | **VERIFIED** |
| Chat runs | `chatRuns.create` (route) | `records` Map | `abortAll()` + `awaitSettled(10s)` (`server.ts:172,180`) | terminal `settled` resolves | abort → `onAbort` single-winner settle | Bounded (10s); `timedOut>0` surfaced | `chat-runs.ts:213`; `chat-runs.test.ts` | **VERIFIED** |
| Chat run wall-clock timers | `create()` `setTimeout` | record `timeoutHandle` (unref'd) | `clearTimer` on settle/abort/sweep | cleared | unref ⇒ never keeps process alive | Guaranteed | `chat-runs.ts:160,213` | **VERIFIED** |
| Scheduler timers | `Bun.cron`/`setTimeout` in `timers` Map | module `timers` | `clearAllTimers` in `beginSchedulerShutdown` (`server.ts:144`) | unref'd handles | gate + clear, idempotent | Guaranteed | `scheduler.ts:518,522` | **VERIFIED** |
| Scheduler runs | fire paths → `executeJobRun` | `pendingRuns` Set + `runControllers` Map | `abortAllRuns(10s)` (`server.ts:187`) | tracked promise settles | abort-aware retry `sleep`, two-phase tracking | Bounded (10s); `{aborted,settled,timedOut}` | `scheduler.ts:548`; `scheduler.test.ts:1037+` | **VERIFIED** |
| MCP clients/transports | `connect()` | `mcpManager.connections` | `disconnectAll()` (`server.ts:166`) | `client.close()` | reconnect timers cleared; elicitation `{action:"cancel"}` | Guaranteed; disconnected entries **remain** in map (bounded by server count) | `manager.ts:585,601`; `connection-lifecycle-race.test.ts` | **VERIFIED** (+accepted leak §6) |
| OpenCode child | `spawn` in `start()` | `openCodeServerManager.child` | `shutdown()` SIGTERM→SIGKILL (`server.ts:160`) | exits; restart suppressed (`stopping`) | timeout path SIGKILLs to avoid orphan | Guaranteed; diagnostics tail | `serverManager.ts:436`; `serverManager.test.ts` "shutdown … suppresses restart" | **VERIFIED** |
| OpenCode sessions (server-side) | `session.create` | OpenCode child process | child death (no per-session TBAi cleanup on quit); explicit terminate on conversation DELETE | — | die with killed child | Per-session cleanup exists only on DELETE; on-quit behavior folds into the §6 open decision | `sessions.ts:266` used on DELETE; `engine-guards.test.ts:594+` | **SOURCE-CONFIRMED** |
| Chat-stream cleanup timer | `startChatStreamCleanup` | module `timer` (unref'd) | `stopChatStreamCleanup()` (`server.ts:210`) | idempotent | safe when not running | Guaranteed | `cleanup.ts:130` | **VERIFIED** |
| History reconciler timer | `startHistoryReconciliation` | module `timer` (unref'd, `inFlight`) | `stopHistoryReconciliation()` (`server.ts:219`) | idempotent | in-flight tick guard | Guaranteed, but DB-write window not explicitly awaited (§6) | `historyReconciler.ts:270` | **VERIFIED** (with §6 caveat) |
| SQLite handle | `db/index.ts` module load | module singleton | `db.close()` last (`server.ts:229`) | WAL, busy_timeout=5000 | best-effort try/catch | Guaranteed last-close | `db/index.ts:15`; `db.test.ts` | **VERIFIED** |
| Logger flush | `Logger` module load | singleton; `flushTimer` (unref'd) | `process.once("exit") → flushFileLines` (`logger.ts:1001`) | sync drain | counted loss, never blocks | Best-effort, bounded | `logger.ts:584,1001` | **VERIFIED** |
| Resumable store `waiters` | `createSqliteResumableStreamStore` | per-store `waiters` Set | `dispose()` (not called on process singleton) | poll timers unref'd | process death | Not a leak (bounded/in-flight) | `sqliteResumableStore.ts:1095` | **SOURCE-CONFIRMED** |

---

## 5. Verified strengths (do not regress)

- **Idempotent, gated, ordered shutdown spine** — one-way `shuttingDown` guard,
  scheduler gated *first* (no new fire/schedule), `db.close()` strictly last, each step
  individually try/catch'd so one failure cannot block another. (`server.ts:118-244`)
- **Settlement-before-close for the two DB-writing workloads** — chat runs settle via
  `awaitSettled` and scheduler runs via `abortAllRuns` (both bounded 10s, unref'd bound
  timers) before `db.close()`. Confirmed empirically by `shutdown-lifecycle.test.ts`
  (real server, `db.query` throws after close) and `scheduler.test.ts:1037+`
  (`abortAllRuns` `{aborted,settled,timedOut}`, setup-window hook).
- **Chat single-winner terminal transition + shutdown gate** — `settle()` wins-once out
  of `running`; `create()` after `abortAll` returns a terminal `cancelled` record (route
  can't mint new work). `chat-runs.test.ts` proves the abort-vs-completion race in both
  directions.
- **MCP generation-gated ownership** — `lifecycleGen` + `ownsAttempt`/`ownsConnection`
  make "did I get invalidated before my turn?" observable; a superseded/disconnected/
  disabled/deleted attempt closes *its own* client and never resurrects shared state.
  `connection-lifecycle-race.test.ts` is a real stdio-child + gated-SSE-probe
  integration (discriminating, not mocked).
- **OpenCode child orphan/restart hardening** — readiness-timeout SIGKILLs the child
  (no orphan), exit-during-readiness restarts exactly once (no clobber via
  `this.child === child` guard), restart budget resets only on success, `shutdown()`
  SIGTERM→SIGKILL and suppresses restart. `serverManager.test.ts` covers all four.
- **Boot recovery is honest and idempotent** — orphaned `streaming` rows become
  `interrupted` *or* preserve an already-settled verdict; bytes are never rewritten;
  multi-restart is a no-op. `boot.test.ts` proves byte-preservation and the "finished
  reply was not lost" distinction.
- **DB hardening** — WAL + `synchronous=NORMAL` + `busy_timeout=5000` (defensive,
  documented as non-shutdown). `db.test.ts` measures the ≥4s lock-wait bound and
  reader/writer overlap.
- **No timer keeps the process alive** — every lifecycle timer (chat wall clock,
  scheduler, cleanup, reconciler, logger flush, store poll) is `unref`'d; only MCP
  reconnect timers are ref'd and are cleared on disconnect.

---

## 6. Conformance gaps and risks

Rankings are impact × likelihood; severities are not inflated. **No Critical findings.**

**M-1 · Partial-startup failure can orphan MCP fire-and-forget children/timers.**
`mcpManager.init()` is inside `await Promise.all([mcpManager.init(), gcOrphanChatDirs()])`
(`server.ts:81`). `init()` issues `void this.connect(id)` (`manager.ts:148`) before
`gcOrphanChatDirs()` could reject. If that Promise rejects (or a later
`await initScheduler()` / `bindBootPort` throws), `startServer` rejects, `index.ts` sets
`process.exitCode = 1`, and **`shutdownServer` is never called** — so any MCP stdio child
already spawned and any pending reconnect timers have no shutdown path. On a normal exit
the OS reclaims the children, so this is not a hang, but it is an un-cleaned-up
partial-init state that no shutdown spine handles.
**Evidence:** `server.ts:81`, `manager.ts:148`, `index.ts:10-12`. **Confidence:**
source-traced (high); impact low (bounded, self-resolving on exit). **Fix shape (not
implemented):** on `startServer` failure, run a best-effort `mcpManager.disconnectAll()`
+ scheduler gate before setting `exitCode`.

**M-2 · HTTP bind is delayed by overdue one-time job execution.** `initScheduler()` →
`recover()` calls `await handleOverdueOnce(...)` for each overdue one-time job *before*
`initListenerFetch`/`bindBootPort` run (`server.ts:83` precedes `:99-100`).
`handleOverdueOnce` → `fireJob` → `executeJobRun` performs a full provider call bounded by
`job.timeoutSeconds` (default 600). A large overdue backlog (or a stalled provider)
therefore delays the listener — and thus the Tauri `/api/server/instance` handshake — for
the sum of those executions. This is a readiness-latency property, not a crash.
**Evidence:** `scheduler.ts:487-498` (`recover` overdue path), `server.ts:83,100`.
**Confidence:** source-traced (high); impact Medium only under backlog. **Fix shape:**
run `recover()`'s overdue execution concurrently with (or after) binding the listener, or
cap awaited overdue runs.

**M-3 · Post-settlement detached-history DB writes are not explicitly awaited before
`db.close()`.** For a *detached* completed run, `chatRuns` settles (`settled` resolves)
**before** `recordFinalMessage` and `finalizeDetachedRunHistory` complete their SQLite
writes (`execute-direct-stream.ts` onEnd: `settleFromUiOutcome` → `markCompleted` → then
`recordFinalMessage` + `await finalizeDetachedRunHistory`). The spine's `awaitSettled`
waits only on `settled`, so `db.close()` (`server.ts:229`) can in principle precede those
writes. In practice the intervening `abortAllRuns`/`drainInflight` awaits give ample time
and the writes are synchronous, and **the obligation self-heals** (row stays
`history_state='pending'`; next boot's reconciler immediate tick re-offers it —
`historyReconciler.ts` + `boot.test.ts`). It is a window, not a proven loss.
**Evidence:** `execute-direct-stream.ts` (onEnd settlement cluster), `historyFinalizer.ts`,
`server.ts:180,229`. **Confidence:** source-traced race (medium); impact Low
(self-healing). **Fix shape:** fold the detached finalization into the run's settlement
signal, or drain it explicitly in the spine before `db.close()`.

**L-1 · No global `unhandledRejection`/`uncaughtException` handler.** Only hooks present
are the two signal handlers (`server.ts:40,44`) and `logger`'s `process.once("exit")`
(`logger.ts:1001`). Fire-and-forget paths are locally contained (`trackRun`
`.catch(()=>{})`, `chat-runs`, MCP `allSettled`), so an unexpected unhandled rejection
would crash the process *without* a structured log line. For a local single-user tool
this is acceptable, but it is a missing safety net the standard's "asynchronous work
cannot silently outlive its owner" item would strengthen. **Evidence:** full `src/` grep
(only the two hooks). **Confidence:** VERIFIED absence.

**L-2 · No repeated-SIGINT / repeated-shutdown test at the spine level.**
`shutdownServer` is guarded (`if (shuttingDown) return`) and `shutdown-lifecycle.test.ts`
exercises a single trigger; the lifecycle-hardening doc itself notes "T3-L12
repeated-SIGINT unit test still MISSING." A second signal is a safe no-op by inspection,
but it is not asserted. **Evidence:** `server.ts:119`, `shutdown-lifecycle.test.ts`.
**Confidence:** VERIFIED absence of the test.

**L-3 · MCP disconnected connections persist for process lifetime.**
`disconnect()`/`disconnectAll()` mark status but only `deleteConfig` removes the
`connections` entry (`manager.ts:585,320`), so a disconnected server's object (with up to
50 events + tool/resource/prompt arrays) stays until config deletion. Bounded by
configured-server count; documented (PM audit §6.4). Not a shutdown hazard; an accepted
memory-lifetime choice. **Evidence:** `manager.ts:130,320`. **Confidence:** VERIFIED.

**Open decision (not an accepted limitation): desktop quit bypasses graceful shutdown.**
- **Desktop Quit is currently ungraceful.** `quit_owned` → `child.kill()`
  (`main.rs:247-256`) is a raw OS kill of the sidecar; it does **not** route through
  the backend's SIGINT/SIGTERM handlers, so `shutdownServer` does not run on tray
  "Quit" or `quit_app`. On Windows the OpenCode child is reaped on stdio closure; WAL
  guarantees no corruption (most-recent-commit loss only); interrupted run state is
  recovered at next boot. This is the **primary desktop termination path** and it
  bypasses the spine.
  **Impact:** in-flight run/session state is lost on desktop quit, but durable data is
  safe and self-recovers.
- **This is a decision the current effort must make, not an inherited acceptance.** The
  2026-09-17 hardening doc only recorded *whether the close path sends SIGTERM or closes
  stdin* ("the shutdown handles both"); it did **not** decide that **losing in-flight
  work on quit is within tolerance**. Under the stated durability objective, that
  question is open: the maintainer must either (a) accept the current in-flight-work loss
  on desktop quit as a documented, bounded trade-off, or (b) add a graceful-shutdown
  handshake on the desktop path (so `shutdownServer` runs) before certifying the
  subsystem. §11.1 carries the evidence needed to decide it.
- **OpenCode sessions are not individually terminated on shutdown** — they die with the
  killed child; per-session termination exists only on conversation DELETE
  (`conversations.ts:483`). Whether that is acceptable also folds into the quit decision
  above.

---

## 7. Existing test coverage

| Contract | Test | Assertions that prove it | Coverage quality |
|---|---|---|---|
| Real start→shutdown closes DB | `shutdown-lifecycle.test.ts` | real `startServer(0)` + one HTTP `200`, `shutdownServer` resolves, `db.query("SELECT 1")` **throws** after | **Real integration** (excluded from default suite via `package.json` `--path-ignore-patterns`; runs only via `test:shutdown`) |
| Chat settle/gate/abort races | `unit/core/chat-runs.test.ts` | single-winner settle; `create()` after `abortAll` → terminal cancelled; `awaitSettled` empty + partial-`timedOut`; abort-vs-complete both directions | Strong unit |
| Scheduler settlement + gate | `unit/scheduler/scheduler.test.ts:1037+` | `abortAllRuns` shape, gate blocks `fireJob/runJobNow/scheduleJob`, repeated idempotency, `runJobNow` setup-window (`setSetupDelayHook`), retry-sleep interruption | Strong unit (setup-window deterministic, not timing-based) |
| OpenCode child lifecycle | `integration/opencode/serverManager.test.ts` | timeout→SIGKILL no-orphan, exit-during-readiness restarts exactly once, bounded restart + reset, shutdown SIGTERM→SIGKILL + no-resurrect, bounded diag tail | Real readiness loop; **child is a fake** (`FakeChild`), so actual spawn/kill is not exercised |
| MCP connect/disconnect races | `integration/mcp/connection-lifecycle-race.test.ts` | real stdio child + gated SSE probe; disconnected stays disconnected, no reconnect armed, superseded attempt writes nothing, discovery can't outlive connection | **Real integration** (deterministic, gated) |
| MCP lifecycle/idempotency | `integration/mcp/mcp-v2.test.ts` | repeated-disconnect idempotent, `disconnectAll` over connected+error, bounded reconnect/no-resurrection (6s watch), elicitation settlement | Real |
| Boot orphan recovery | `integration/chat/boot.test.ts` | interrupted vs preserved-verdict, byte-preservation, idempotent, multi-restart, schema-missing throws | Strong (isolated temp DBs) |
| DB pragmas + lock-wait | `unit/persistence/db.test.ts` | busy_timeout>0, WAL, ≥4s lock-wait bound, reader/writer overlap | Behavioral |
| DELETE → OpenCode session termination | `integration/core/engine-guards.test.ts:594+` | engine-gated terminate, not-found/transport-failure never block DELETE | Service-seamed (no real OpenCode) |

**Gaps (contracts without a test):**

- **Partial-init failure cleanup** (M-1) — no test makes a subsystem throw mid-
  `startServer` and asserts MCP children/timers are (or are not) cleaned.
- **Detached-finalization DB-write window** (M-3) — no test proves `db.close()` cannot
  precede `finalizeDetachedRunHistory` writes; `chat-runs` tests stop at `settled`.
- **Repeated SIGINT at the spine** (L-2) — asserted by inspection only.
- **Desktop `child.kill()` safety** — not testable from the backend; the Rust half is
  unverified locally (no Rust toolchain in this environment). **UNVERIFIED.**
- **Timer/tick cannot fire after `db.close()`** — guaranteed by ordering + `unref` +
  explicit stops, but no empirical test observes a post-close tick. **UNVERIFIED** here.

**Not safely executed:** `bun test`, `test:shutdown`, and server spawns were not run —
they disturb a live app and close the shared DB singleton. All runtime claims above are
therefore **SOURCE-CONFIRMED**, not newly observed; the listed tests are evidence that the
contracts were exercised *in prior runs*, which were not re-run this session.

---

## 8. Documentation discrepancies (material only)

1. **STALE RECORD — MCP unexpected-close detection.** Two **historical, point-in-time**
   docs are stale against current source on this branch:
   - `docs/2026-09-17-lifecycle-hardening.md` — Phase 4 deferred note ("unexpected-
     transport-close → auto-reconnect is NOT implemented", ~line 400), the live-verification
     notes ("no live close-detection exists to observe", ~444-445, 644), and UNKNOWN #5
     (~660).
   - `docs/2026-10-05-pm-infrastructure-audit.md` — §6.2 ("CONFIRMED: there is
     **no live-disconnect detection** — no `onerror`/`onclose`/`.on(` handler … grep: 0
     matches", ~line 294) and §15.6 (~531).

   Both are false against current source: `manager.ts:388-401` registers `transport.onclose`
   that, guarded by `ownsConnection(id, conn, gen)` + status, sets `status="error"` and
   calls `scheduleReconnect(id)` on an *unexpected* close. This branch
   (`fix/mcp-lifecycle-and-history-e2e`) added live close-detection + reconnect **after**
   both docs were written.
   **Handling (two parts, kept distinct):**
   - **Do not rewrite the two historical docs.** Standing rule: point-in-time audit reports
     (`2026-09-17-lifecycle-hardening.md`, `2026-10-05-pm-infrastructure-audit.md`) are
     evidence *as found on their date* and are left as-written. Do **not** edit them to
     "fix" the record.
   - **The correct target for a current-state correction is `docs/decisions.md`.** The MCP
     close-detection capability belongs in the forward-looking record as a **new** decision
     entry ("MCP live close-detection + reconnect via `transport.onclose`"), superseding the
     Phase-4 "deferred" note. `docs/decisions.md` does **not** currently carry the stale
     claim (its MCP ADRs cover `@ai-sdk/mcp`, tool naming, etc.), so it is not itself stale
     — it is simply where the *new* correction belongs. Net effect: the two historical docs
     **understate** current capability (a strength), and a reader trusting them would look
     for a missing feature that now exists.
2. **ACCURATE (confirmed):** PM audit §1.2 / ADR "desktop sidecar IS the backend" —
   desktop Quit still uses `child.kill()` (`main.rs:250-251`); unchanged and still accurate.
3. **ACCURATE:** `docs/2026-09-17-lifecycle-hardening.md` "OBSERVED ANOMALY: process
   remained alive 3+ min after `[server] stopped`" — not reproduced in that doc's own
   controlled runs, and no current change addresses it; remains an open note, not a
   regression.
4. `docs/architectural-principles.md` and `AGENTS.md` lifecycle expectations are consistent
   with the implementation.

---

## 9. Acceptance criteria for certification

Declare the subsystem standardized only when **all** of the following hold and are
evidenced by a passing run (this session could not run them):

1. **Startup-failure unwind:** if any step in `startServer` rejects, a best-effort
   `mcpManager.disconnectAll()` (+ scheduler gate) runs before `process.exitCode` is set;
   a new test forces a subsystem throw and asserts no leaked MCP children/reconnect timers.
   *(closes M-1)*
2. **Readiness is not gated on job execution:** HTTP bind completes before/independent of
   awaited overdue-scheduler execution; a test with a slow/blackhole overdue job shows the
   listener (and `/api/server/instance`) becomes reachable without waiting for the run.
   *(closes M-2)*
3. **Post-settlement DB writes are awaited:** the detached-history finalization and any
   in-flight reconciler tick complete (or are explicitly drained) before `db.close()`; a
   test opens the `settled`-then-write window and asserts `db.close()` cannot precede it.
   *(closes M-3)*
4. **Idempotent repeated trigger:** a second SIGINT during/after shutdown is a no-op with
   no double-close; covered by a spine-level test. *(closes L-2)*
5. **Async safety net:** a `process.on("unhandledRejection")` handler logs a structured
   `lifecycle.unhandled_rejection` (or an explicit decision to rely on local containment is
   recorded in `docs/decisions.md`). *(addresses L-1)*
6. **Desktop-quit path is a settled decision** — the maintainer has explicitly chosen
   between (a) accepting + documenting the bounded in-flight-work loss on desktop quit
   (with the WAL/boot-recovery safety argued), or (b) requiring a graceful-shutdown
   handshake on the desktop path. Until that decision is recorded, certification is blocked
   on this item; it must not be read as already accepted.
7. **Full gate green:** `bun run typecheck` + `bun run build` exit 0, and `test`,
   `test:shutdown`, and the MCP/OpenCode/chat unit suites pass with real counts.

---

## 10. Recommended dependency-aware implementation order

Smallest coherent sequence (each is self-contained; no new dependencies; stays within
owning modules):

1. **M-1 startup-failure unwind** — `src/server.ts` + `src/services/mcp/manager.ts` (add a
   public `disconnectAll`-based teardown on `startServer` reject). *Boundary:* touches
   `server.ts` startup; depends only on existing `mcpManager`. Independent.
2. **L-2 repeated-SIGINT spine test** — pure test under `tests/integration/core/`; depends
   on nothing (locks in the existing guard before #3 changes the spine). *Do this before #3.*
3. **M-3 settlement→finalization write ordering** — `src/routes/chat/execute-direct-stream.ts`
   / `historyFinalizer.ts` + a spine drain. *Boundary:* chat execution cluster; must not
   change the single-winner `settled` semantics. Depends on #2's regression lock.
4. **M-2 readiness decoupling from overdue jobs** — `src/services/scheduler/scheduler.ts`
   (`recover`) + `src/server.ts` ordering. *Boundary:* scheduler recovery; depends on the
   `initScheduler` seam. Independent of #1–#3.
5. **L-1 unhandled-rejection handler** — `src/lib/logger.ts` or `src/index.ts`. *Boundary:*
   process-level; depends only on the logger. Last, because it is the safety net for all
   of the above.
6. **Doc sync** — add a **new** forward-looking entry to `docs/decisions.md` recording the
   MCP live close-detection + reconnect capability (superseding the Phase-4 "deferred"
   note). **Do not edit** the two historical point-in-time docs
   (`docs/2026-09-17-lifecycle-hardening.md`,
   `docs/2026-10-05-pm-infrastructure-audit.md`); their stale claims are left as-written
   per the don't-rewrite-history rule (§8). No code.

None of these require touching OpenCode, ICM, or the assistant-ui train.

---

## 11. Unresolved questions (need evidence or maintainer decision)

1. **Is losing in-flight work on desktop quit acceptable?** `quit_owned` → `child.kill()`
   (`main.rs:247-256`) hard-kills the sidecar and bypasses `shutdownServer`, so in-flight
   runs/sessions die (durable data self-recovers via WAL + boot recovery). The 2026-09-17
   record only notes *whether the close path sends SIGTERM or closes stdin* ("the shutdown
   handles both") — it does **not** decide that this loss is within tolerance. Under the
   durability objective this is an **open maintainer decision**, not an inherited
   acceptance: (a) accept + document the bounded loss, or (b) add a graceful-shutdown
   handshake on the desktop path so `shutdownServer` runs. Related sub-question: does Tauri
   `child.kill()` deliver SIGTERM (→ the backend *would* run `shutdownServer`) or a hard
   kill? Live Windows verification (no local toolchain) resolves both the sub-question and
   option (b)'s feasibility.
2. **Is the "process alive 3+ min after `stopped`" anomaly still reproducible on this
   branch?** No current change addresses it; needs a controlled soak to close or keep it open.
3. **Is a global `unhandledRejection` handler desired, or is local containment the
   documented choice?** Architectural decision (affects whether #5 is "add handler" vs
   "record decision").
4. **Should `initScheduler`'s overdue execution ever block readiness, or should it be
   strictly post-bind?** A product decision (M-2's fix depends on the intended answer).
5. **MCP disconnected-entry lifetime (L-3):** confirm it stays an accepted bounded
   behavior or is promoted to `disconnect()`-time removal.

---

*Report delivered. No files were created or modified in the working tree and nothing was
committed or pushed; the implementation phase was not begun.*
