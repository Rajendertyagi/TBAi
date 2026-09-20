# TBAi Lifecycle Hardening — Implementation Plan (v3, 2026-09-17)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the shutdown/lifecycle defects that cause `ECONNRESET`, OpenCode `code=58` restart loops, and unreliable Ctrl+C shutdowns — then address the DB-close race, security gaps, and dead code.

**Architecture:** All fixes live in owning modules identified by the read-only audit. No new dependencies, no `@assistant-ui/*` changes, no new frameworks.

**Tech Stack:** Bun 1.4.2 + Hono + SQLite (`bun:sqlite`), existing test harness (`bun test` with `tests/setup.ts`).

**Spec:** The read-only architecture & production-readiness audit report (2026-09-17).

**Verification status:** Every task below was re-checked against the current on-disk code with empirical runtime verification of Bun 1.4.2 `server.stop()` semantics. Conclusions labeled PROVEN / INFERRED / UNKNOWN.

---

## Global Constraints

- No `@assistant-ui/*` dependency changes (train freeze).
- No new dependencies. No new files outside `src/`, `web/src/`, `tests/`.
- Every public function gets a one-line doc comment.
- No `any`, no `as unknown as X` casts to silence the compiler.
- Tests: happy-path + edge-case per new public function. **Behavioral tests only — no static source-text tests** (`Bun.file("src/server.ts").text()` + `toContain`). Test through the real public seam.
- No test-only exports (`__registerRunForTest` style) unless architecturally justified.
- `bun run typecheck` + `bun run build` must pass after each phase.
- Log through `logger.<level>(scope, event, fields)` — never `console.log`.
- Server stays bound to `0.0.0.0` (maintainer decision 2026-09-17 — LAN access intentional).

---

## Phase 0 — Lifecycle contract (the invariant every task serves)

### Shutdown invariant (binding)

```
CANCELLATION REQUESTED  ≠  ASYNC WORK SETTLED
```

Aborting an AbortController does not prove the associated promise/task has finished. PROVEN — `executeJobRun`'s catch-after-parent-abort handler writes `status: "cancelled"` + `lastRunAt` to SQLite (`schedulerExecution.ts:365-373`) **after** the abort. The success path also writes (`:347-354`). bun:sqlite is synchronous, so these writes happen within the promise's execution context. If `db.close()` runs before the fireJob promise settles, the writes throw against a closed handle.

Chat runs are the exception: their abort path is in-memory only (PROVEN — `chat.ts` `onAbort`/`onError`/`monitorStream.cancel()` all call `chatRuns.markFailed/markCancelled/markDetached`, which never touch the DB).

### `server.stop()` semantics (Bun 1.4.2, RUNTIME VERIFIED)

| Behavior | Verified |
|---|---|
| Stops accepting new connections **immediately** on call | YES — `fetch()` after `stop()` throws |
| Returns a **Promise** | YES — `typeof stopPromise.then === "function"` |
| Keeps **existing streaming connections alive** | YES — 2 chunks received after `stop()` on a 1000ms stream |
| Promise resolves **only when all connections close** | YES — resolved 0ms after stream ended |

**Critical implication:** calling `await server.stop()` before cancelling work blocks until all SSE/chat streams finish (potentially minutes). The correct approach: call `server.stop()` WITHOUT await (stops the listener immediately), then cancel owned work, then await settlement, THEN `await server.stop()` (now resolves quickly because streams are closed).

### Target shutdown sequence

```
shutdown(signal):
  if (shuttingDown) return; shuttingDown = true          // idempotent gate
  1. const stopPromise = server.stop()                   // stop accepting; DON'T await yet
  2. await openCodeServerManager.shutdown()              // SIGTERM→5s→SIGKILL; suppresses restart
  3. clearAllTimers()                                    // no new scheduler fires
  4. await mcpManager.disconnectAll()                    // clear reconnect timers, close clients, cancel elicitations
  5. chatRuns.abortAll()                                 // abort chat runs → streams end → connections close
  6. await abortAllRuns()                                // abort + AWAIT scheduler runs (bounded 10s)
  7. await drainInflightRequests()                       // wait for slow handlers still in setup (bounded 10s)
  8. await stopPromise                                   // now resolves quickly (streams closed in step 5)
  9. db.close()                                          // last — all DB-touching work settled
```

**Why step 5 before step 8:** aborting chat controllers → `onAbort` fires → stream ends → connection closes → `stopPromise` can resolve.

**Why step 7 exists:** `drainInflightRequests` polls `metrics.http_requests_inflight`, which goes to 0 when the handler returns the Response (NOT when the stream finishes). This catches slow handler setup (e.g., slow `prepareModelMessages`). After chat abort, streams end, but a slow setup handler might still be mid-execution. The 10s bound ensures we don't hang.

### Resource ownership table (PROVEN)

| Resource | Owner | Current shutdown | Gap |
|---|---|---|---|
| HTTP listener | `src/server.ts:221` | `server.stop()` unawaited at `:237` | await at end (step 8) |
| HTTP handlers | `src/server.ts:130-142` | `drainInflightRequests()` at `:189-194` | ordering: runs BEFORE timers cleared/runs aborted |
| Chat runs | `src/services/chat-runs.ts` | none | no `abortAll()` |
| Scheduler timers | `src/services/scheduler/scheduler.ts:45` | `clearAllTimers()` at `:466` | ok, but ordering wrong today |
| Scheduler runs | `src/services/scheduler/scheduler.ts:48` `runControllers` | none | no `abortAllRuns()`; no pending-promise tracking |
| MCP clients | `src/services/mcp/manager.ts` | `server.ts:247-258` disconnects only `status === "connected"` | `disconnectAll()` needed |
| MCP reconnect timers | `src/services/mcp/manager.ts:490-509` | none (error/connecting servers keep timer) | timer fires post-db.close() |
| MCP pending elicitations | `src/services/mcp/manager.ts:706-752` | none | promise never settles |
| OpenCode child | `src/services/opencode/serverManager.ts` | **never called** | `shutdown()` exists but not wired |
| SQLite | `src/db/index.ts:11` | `db.close()` at `server.ts:260` | runs before scheduler settlement |

---

## Phase 1 — Shutdown spine

### Goal
Rewrite `shutdown()` in `src/server.ts` to the Phase 0 target sequence, exporting a testable seam.

### Current verified behavior
`server.ts:232-265`: `if (shuttingDown) return; shuttingDown = true` → `server.stop()` (no await) → `drainInflightRequests()` (10s) → `clearAllTimers()` → MCP connected-only loop → `db.close()`. SIGINT/SIGTERM handlers at `:267-272` do `void shutdown(signal)`.

### Problem
Sequence is wrong (drain before timers/runs cancelled), OpenCode never stopped, chat/scheduler never aborted, MCP misses non-connected servers. (P1, P2, P3, P6)

### Files
- Modify: `src/server.ts` (shutdown function + imports)
- Test: `tests/integration/shutdown-lifecycle.test.ts` (new)

### Dependencies
- Steps 2-5 (Tasks in Phases 2-4) provide the seams called by the spine. The spine can be written first using stubs/mock calls, then completed when the real seams land. Alternatively, implement Phases 2-4 first and wire them into the spine last.
- **Recommended approach:** implement the spine with placeholder calls to the seams that don't exist yet (e.g., `chatRuns.abortAll()` will fail at first), and complete it in the final phase.

### Implementation approach
1. Import `openCodeServerManager`, `chatRuns`, `abortAllRuns` (once it exists).
2. Export a `shutdownServer(server: Server)` function (architecturally justified — the Tauri sidecar and tests need it; avoids testing a closure).
3. Rewrite the sequence per Phase 0 target. Each step wrapped in try/catch that logs and continues (best-effort teardown, existing convention).

### Tests
- `tests/integration/shutdown-lifecycle.test.ts`: start the real server on an ephemeral port, assert shutdown completes, assert no DB access after `db.close()`.
- Use a `FakeOpenCodeServerManager` (existing pattern in `serverManager.test.ts`) to avoid spawning a real opencode process.

### Definition of done
- `shutdown()` matches Phase 0 target sequence.
- `server.stop()` is awaited LAST (after streams are cancelled), not FIRST.
- Each step is individually try/catch'd and logged.
- `bun run typecheck` + `bun run build` pass.

### Testing requirements
`bun test tests/integration/shutdown-lifecycle.test.ts`

---

## Phase 2 — OpenCode process lifecycle

### Goal
Harden the managed `opencode serve` child lifecycle: bounded restart on unexpected exit, no orphaned children on readiness failure, exit diagnostics (bounded stdout/stderr tail), and correct Windows process behavior. `shutdown()` wiring into the spine was completed in Phase 1.

### Verified findings (2026-09-17, code inspection)

| # | Finding | Classification |
|---|---|---|
| F1 | `start()` catch (`serverManager.ts:285-290`) nulls `child`/`port`/`readyPromise` WITHOUT killing the child. A readiness TIMEOUT (child alive but slow > `startupTimeoutMs`) orphans a live, untracked process. | PROVEN |
| F2 | Exit-during-readiness clobber race: `child.exited.then(onExit)` (`:264`) is registered before `waitForHttpReady`'s `exitRejection` (`:134`). When the child exits during readiness, `onExit` starts a restart (child B) FIRST, then `start()`'s catch (`:285-290`) runs and nulls `child`/`port`/`readyPromise` — clobbering B's tracking. B becomes untracked: never killed on shutdown, no restart on its exit, and the next `ensureBaseUrl()` spawns a THIRD child while B still runs. | PROVEN |
| F3 | `start()` resets `restartAttempts = 0` at the TOP (`:260`), so every restart resets the counter. A crash-after-ready loop restarts forever — `maxRestartAttempts` never binds. | PROVEN |
| F4 | `drainStreams` (`:296-311`) discards stdout/stderr. `onExit` logs only `{ code }`. No stderr/stdout context for exit-code diagnosis (e.g. code 58). | PROVEN |
| F5 | Windows kill semantics: `detached: process.platform !== "win32"` (`:246`); `child.kill("SIGTERM")` on Windows maps to a hard terminate (no graceful window). Whether the child survives a hard TBAi crash is UNKNOWN — needs live verification. | LIVE VERIFIED (2026-09-17): SIGTERM kills the child; parent hard-kill also reclaims the child (stdio closure). |
| F6 | No orphan detection/reclaim. On POSIX `detached: true` means the child survives parent death. Safe ownership of a stale process cannot be established without a pidfile mechanism; documented as a limitation. | UNKNOWN / DEFERRED — no pidfile mechanism; documented limitation. |

### Problem
The plan previously claimed "no changes needed to `serverManager.ts` — the code works." That is DISPROVEN by F1-F4. The child lifecycle has real defects: readiness-timeout orphans, a restart-clobber race, an unbounded restart loop, and discarded exit diagnostics.

### Files
- Modify: `src/services/opencode/serverManager.ts` (F1-F4 fixes + diagnostics)
- Modify: `src/config/opencode.ts` (add `diagnosticTailBytes`)
- Modify: `src/services/opencode/serverManager.test.ts` (extend fake + new tests)
- `src/server.ts` shutdown wiring: already done in Phase 1 — no change

### Dependencies
Phase 1 (spine exists and calls `openCodeServerManager.shutdown()`).

### Implementation approach
1. **Bounded diagnostic buffer (F4):** capture the last `diagnosticTailBytes` (4096) of child stdout/stderr per child (WeakMap keyed by child). Pure `appendTail(tail, chunk, maxBytes)` helper. `onExit` logs `{ code, pid, port, attempt, maxAttempts, stderrTail, stdoutTail }`.
2. **Readiness-timeout orphan (F1):** in `start()`'s catch, SIGKILL the child when the failure is `OpenCodeReadinessTimeoutError` and not stopping. Guard state-clearing with `if (this.child === child)` so a restart's newer child is never clobbered.
3. **Clobber race (F2):** the `this.child === child` guard in `start()`'s catch prevents nulling a restart's child/port/readyPromise. `onExit` receives the child reference so it reads the correct tail.
4. **Bounded restart (F3):** move `restartAttempts = 0` from the top of `start()` to AFTER successful readiness. Consecutive failed restarts now accumulate toward `maxRestartAttempts`; a successful start resets the budget.
5. **Config injection:** `OpenCodeServerManager` takes an optional `config = OPENCODE_CONFIG` constructor arg so tests can use short timeouts / small restart budgets.
6. **Windows/orphans (F5, F6):** no code change — document. `shutdown()` already kills the managed child (SIGTERM→SIGKILL); live-verify Windows behavior and hard-crash orphan outcome; record in Runtime verification.

### Tests
- `serverManager.test.ts` (extended fake): readiness timeout kills child (no orphan); exit-during-readiness restarts exactly once (no duplicate children, no clobber); consecutive failures stop at `maxRestartAttempts`; successful restart resets attempt state; shutdown sends SIGTERM then SIGKILL and suppresses restart; `ensureBaseUrl()` rejects after shutdown; bounded stdout/stderr tail retained in diagnostics; `appendTail` bounded-buffer unit tests.

### Definition of done
- No orphan on readiness timeout (child killed).
- No duplicate children on exit-during-readiness.
- Restart bound holds for consecutive failures; successful restart resets the budget.
- `unexpected_exit`/`restart_failed` logs carry `code/pid/port/attempt/maxAttempts/stderrTail/stdoutTail`.
- `bun run typecheck` + `bun run build` pass.

### Verification status (2026-09-17)
- **IMPLEMENTED + AUTOMATED VERIFIED:** F1-F4 fixes. `bun test src/services/opencode/serverManager.test.ts` → 27 pass / 0 fail / 46 expect. Full suite 743 pass / 0 fail; `bun run test:shutdown` 1 pass / 0 fail; typecheck + build exit 0.
- **LIVE VERIFIED:** normal startup (exactly one managed child, `pid=` in readiness/spawn logs); kill → `unexpected_exit` → `restart` → readiness → recovered (no duplicates); normal shutdown → no restart, no orphan (three independent runs). See "Runtime verification (2026-09-17, live)" below.
- **UNKNOWN / DEFERRED:** F6 orphan detection/reclaim (no pidfile mechanism); exit-code-58 real-world trigger; MCP elicitation against live servers; Tauri sidecar close path.
- **OBSERVED ANOMALY:** one shutdown hang in the original live-verify (browser connected, long-running server); not reproduced in four controlled experiments; not attributable to the opencode lifecycle. Recorded for follow-up.

### Testing requirements
`bun test src/services/opencode/serverManager.test.ts`

---

## Phase 3 — Chat + scheduler cancellation AND settlement

### Goal
Cancel in-flight chat runs and scheduler runs during shutdown, and for scheduler runs, **await their settlement** (not just their cancellation).

### 3A: Chat `abortAll()` — ALREADY FIXED (Phase 1/2); remaining: settlement + gate

#### Current verified behavior (2026-09-17 audit)
`createChatRunStore` (`chat-runs.ts:60-213`): `create`, `get`,
`markCompleted/Failed/Cancelled/Detached`, `attach`, `sweep`, `counts`, and
`abortAll()` (`:182-197`) — aborts every running controller, clears the wall
timer, returns the count, never changes status (the route's `onAbort` owns the
transition). Called in the shutdown spine (`server.ts:280`). Unit-tested
(`tests/unit/chat-runs.test.ts` "abortAll (shutdown spine)").

Chat stream lifecycle (`chat.ts`):
- `streamText({ abortSignal: run.controller.signal })` at line 239 — decoupled from request signal.
- `onAbort` (line 296-331): `markFailed/markCancelled` → writes `abortedProgress` to `writer` → stream ends.
- `onError` (line 353-372): `markFailed` → stream ends.
- `monitorStream` cancel (line 439-466): `markDetached` (run continues, just client disconnected).
- `monitorStream` pull drain (line 392-407): `markCompleted` backstop.

When the controller aborts, the `streamText` stream ends → `createUIMessageStream` execute completes → `monitorStream.sourceReader` gets `done` → `controller.close()` → response body closes → SSE connection closes.

#### Remaining gaps (PROVEN)
1. **No settlement signal.** Chat tool calls write to SQLite (todo, scheduler,
   quick messages). `db.close()` can run while a chat run's tool call is still
   writing. The run record has no `settled` promise and the store no
   `awaitSettled()`.
2. **No shutdown gate.** `create()` during shutdown mints a fresh running
   record; `abortAll()` does not prevent it.

#### Files
- Modify: `src/services/chat-runs.ts` (add `settled` + `awaitSettled` + gate)
- Modify: `src/server.ts` (await settlement after `abortAll()`)
- Test: `tests/unit/chat-runs.test.ts` (extend)

#### Dependencies
None (independent).

#### Implementation approach
- Add `settled: Promise<void>` to `ChatRunRecord`; resolve it in the store's
  terminal transition `settle()` (`:77-84`) — every terminal path
  (`markCompleted/Failed/Cancelled`) routes through it, so no route changes.
  Per-record resolver kept in a closure `Map`, cleaned on settle and sweep.
- Add `awaitSettled(timeoutMs = 10_000): Promise<{ settled: number; timedOut: number }>`:
  snapshot running records, race `Promise.allSettled(settled)` vs a bound
  (unref'd), count still-`running` as timedOut.
- `abortAll()` sets a per-store `shuttingDown` flag; `create()` during shutdown
  returns a terminal `cancelled` record with an already-aborted controller and
  a resolved `settled` (the route's `streamText` throws immediately → `onAbort`
  no-ops via its status guard).

#### Tests
- "create() after abortAll returns a terminal cancelled record" (gate)
- "awaitSettled resolves immediately when nothing is running"
- "awaitSettled waits for in-flight runs and reports timedOut on bound"
- "settled resolves on every terminal transition"
- Update "idempotent: calling abortAll repeatedly" (create-after-abortAll is now terminal)

#### Definition of done
- `chatRuns.awaitSettled()` exists; `create()` is gated during shutdown.
- Spine awaits chat settlement before `db.close()`.
- `bun run typecheck` + `bun run build` pass.

---

### 3B: Scheduler `abortAllRuns()` + pending-promise tracking + early controller registration — MOSTLY ALREADY FIXED; remaining: setup tracking, interruptible sleep, gate, result shape

#### Current verified behavior (2026-09-17 audit)
- `pendingRuns` Set + `trackRun` (`scheduler.ts:51-64`) exist; all fire paths
  are tracked: cron callback (`:255`), once callback (`:284`), overdue
  (`:279`), `runJobNow` execution (`:390`).
- `controllerForRun` is registered immediately after `claimRun` in `fireJob`
  (`:180`, BEFORE `ensureJobConversation` at `:186`) and in `runJobNow`
  (`:386`) — the claim→controller window is closed.
- `abortAllRuns(timeoutMs)` exists (`:498-503`): aborts controllers, races
  `Promise.allSettled([...pendingRuns])` vs a bound, returns the controller
  count. Unit-tested (`tests/unit/scheduler.test.ts` "abortAllRuns (shutdown
  spine)").

#### Remaining gaps (PROVEN)
1. **`runJobNow` setup phase untracked.** `ensureJobConversation` (`:388`, DB
   writes via `conversationService`/`schedulerStore.updateRun`) runs BEFORE
   `trackRun` (`:390`). A shutdown landing in that window aborts the controller
   but does not await the setup writes.
2. **Retry-sleep not interruptible + cancelled run can start a new provider
   call.** `executeJobRun` (`schedulerExecution.ts:430`) sleeps
   `retryDelaySeconds * 1000` on a plain timer. At shutdown a run in sleep is
   not settled within the bound, and the next loop iteration creates a fresh
   controller that is NOT aborted even though the parent signal is aborted
   (`cancelledByParent = parentSignal?.aborted` at `:287` skips the listener,
   but the controller is never aborted) → a cancelled run can start a new
   provider call after shutdown.
3. **`abortAllRuns` returns only a count**, not `{ aborted, settled, timedOut }`.
4. **No scheduler shutdown gate.** `fireJob`/`runJobNow`/`scheduleJob` are
   unguarded; new work can start after shutdown begins.

#### Files
- Modify: `src/services/scheduler/scheduler.ts`
- Modify: `src/services/scheduler/schedulerExecution.ts`
- Modify: `src/server.ts` (call `beginSchedulerShutdown()` first; log `abortAllRuns` result)
- Test: `tests/unit/scheduler.test.ts` (extend)

#### Dependencies
None (independent).

#### Implementation approach

**`runJobNow` two-phase tracking** (setup writes awaited at shutdown):
```ts
const setup = (async () => {
  await setupDelayHook?.();
  const conv = await ensureJobConversation(job);
  schedulerStore.updateRun(run.id, { conversationId: conv.conversationId });
  return conv;
})();
trackRun(setup);
try {
  const conv = await setup;
  trackRun(extendRequestContext(...).finally(() => releaseRun(run.id)));
  return { runId: run.id };
} catch (err) {
  releaseRun(run.id);
  throw err; // route 500 on setup failure preserved
}
```

**`executeJobRun` abort-aware retry loop** (`schedulerExecution.ts`):
- Abort the fresh controller at the top of each retry iteration when
  `parentSignal?.aborted` so `streamText` throws immediately (covers the
  abort-between-check-and-listener race too).
- `sleep(ms, signal)` resolves early on abort (never rejects), so a run in
  retry sleep settles promptly at shutdown.

**`abortAllRuns` result shape + gate:**
```ts
export async function abortAllRuns(timeoutMs = 10_000): Promise<{ aborted: number; settled: number; timedOut: number }> {
  shuttingDown = true;
  const snapshot = [...pendingRuns];
  const controllers = [...runControllers.values()];
  for (const controller of controllers) controller.abort();
  const bound = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([Promise.allSettled(snapshot), bound]);
  const stillPending = snapshot.filter((p) => pendingRuns.has(p)).length;
  return { aborted: controllers.length, settled: snapshot.length - stillPending, timedOut: stillPending };
}
```

**Shutdown gate:** `beginSchedulerShutdown()` = gate + `clearAllTimers()`;
`resetSchedulerShutdown()` (test seam); guards at the top of `fireJob`
(log skip + return), `runJobNow` (`{ error: "Server is shutting down" }`),
`scheduleJob` (`clearTimer` + return).

**Test seam:** `setSetupDelayHook(hook)` invoked after `controllerForRun`,
before `ensureJobConversation` in `runJobNow` — deterministic claim→setup
shutdown window test (no real async seam exists at that boundary).

#### Tests
- Update "abortAllRuns (shutdown spine)" to the `{ aborted, settled, timedOut }` shape.
- "beginSchedulerShutdown blocks runJobNow/fireJob/scheduleJob"
- "a run sleeping for retry is interrupted by abortAllRuns and settles cancelled"
- "abortAllRuns during runJobNow conversation setup still aborts and awaits the run"

#### Definition of done
- `abortAllRuns()` returns the settlement shape; gate + `beginSchedulerShutdown()` exist.
- `runJobNow` setup is tracked; retry-sleep is abort-aware; cancelled runs never start a new provider call.
- Spine calls `beginSchedulerShutdown()` before `server.stop(true)` and logs settlement results.
- `bun run typecheck` + `bun run build` pass.

#### Testing requirements
`bun test tests/unit/scheduler.test.ts tests/unit/chat-runs.test.ts tests/integration/shutdown-lifecycle.test.ts`

### Verification status (2026-09-17)
- **IMPLEMENTED + AUTOMATED VERIFIED:**
  - **3A chat settlement + gate** (`src/services/chat-runs.ts`): `settled: Promise<void>` on `ChatRunRecord`; closure `settleResolvers` Map; `create()` shutdown gate returns a terminal `"cancelled"` record (aborted controller + resolved `settled`); `settle()` resolves/cleans resolver; `sweep()` drops pruned resolvers; `abortAll()` sets `shuttingDown`; new `awaitSettled(timeoutMs = 10_000): Promise<{ settled; timedOut }>` (snapshot running records, `Promise.allSettled` vs unref'd bound timer, still-running count = timedOut). `tests/unit/chat-runs.test.ts` → **15 pass / 0 fail** (gate create, settled-resolves-on-terminal, awaitSettled empty, awaitSettled partial, updated idempotency).
  - **3B scheduler settlement + gate** (`src/services/scheduler/scheduler.ts` + `schedulerExecution.ts`): module `shuttingDown` flag; `beginSchedulerShutdown()` (gate + `clearAllTimers()`, idempotent); `resetSchedulerShutdown()` + `setSetupDelayHook()` test seams; guards in `fireJob` (log skip + return), `runJobNow` (`{ error: "Server is shutting down" }`), `scheduleJob` (clearTimer + return); `runJobNow` two-phase tracking (setup promise tracked immediately, controller registered right after claim, setup rejection rethrows → route 500 preserved); `abortAllRuns(timeoutMs)` sets gate, returns `{ aborted, settled, timedOut }`; `executeJobRun` retry loop aborts the fresh controller at the top when `parentSignal?.aborted` and uses abort-aware `sleep(ms, signal)` (resolves early on abort, never rejects). `tests/unit/scheduler.test.ts` → **62 pass / 0 fail (8.09s)** (shape asserts, gate test, retry-sleep interruption via blackhole + `timeoutSeconds:5`, setup-window hook test).
  - **Spine** (`src/server.ts`): `beginSchedulerShutdown()` first (before `server.stop(true)`), then server.stop → opencode.shutdown → mcp.disconnectAll → `chatRuns.abortAll()` → `await chatRuns.awaitSettled()` (log `shutdown_chat_settled`) → `await abortAllRuns()` (log `shutdown_runs_settled`) → drainInflightRequests → stopPromise → `db.close()` last.
  - **Integration** (`tests/integration/shutdown-lifecycle.test.ts`, runs only via `bun run test:shutdown`): real server on ephemeral port, blackhole provider, real HTTP seeding + chat run + run-now, both runs in-flight, `shutdownServer` → elapsed < 8000ms, chat run `"cancelled"`, `db.query("SELECT 1").get()` throws after close. **1 pass / 0 fail (1019ms)** — logs `shutdown_chat_settled settled=1 timedOut=0`, `shutdown_runs_settled aborted=1 settled=1 timedOut=0`.
  - **Gates (coding agent, re-run 2026-09-17, no code changed):** `bun run typecheck` exit 0; `bun run build` exit 0.
- **Automated suite — RECONCILED 2026-09-17 (test agent):** targeted `bun test tests/unit/chat-runs.test.ts tests/unit/scheduler.test.ts` → **85 pass / 0 fail** (20 chat-runs incl. 5 new Phase 3 race tests, 65 scheduler incl. 3 new gate/repeat/write-ordering tests); `bun run test:shutdown` **1/0**. Full `bun test` (771 tests, 88 files): Run A **758 pass / 2 skip / 11 fail**, Run B **757 / 2 / 12** — every failure is the known flaky set (4 CredentialStore, 3 todo, 3–4 process-spawn 5s timeouts; the 12th is a flaky swap within the same set), all pass in isolation (credentials 8/0, todo 9/0, runbash 5/0, wiring 7/0, scheduler 65/0, chat-runs 20/0). **Zero Phase-3-related failures.** No tests weakened. Earlier "750/0 fail" line was already corrected above; row-by-row status in `docs/test-tracker.md`.
- **PHASE 3 VERDICT: COMPLETE.** Implementation COMPLETE (no code changes required — all gaps already closed), typecheck/build VERIFIED, live lifecycle VERIFIED (R4-equivalent run above), automated suite RECONCILED with zero Phase-3 failures. Carve-outs (pre-existing, tracked, not hidden): full-suite flaky set T3-F01–F03; repeated-SIGINT unit test still MISSING (T3-L12); DB busy/locked still Phase 5 (T3-D03). Do NOT reopen without concrete regression evidence.
- **KEY FINDING (retry semantics):** a 500-returning provider does NOT trigger the scheduler retry — the AI SDK converts 500s to `AI_NoOutputGeneratedError` (no status → `classifyError` retryable=false), and `attempt` increments even on terminal failure. The reliable retry path is the scheduler's OWN timeout (blackhole + `timeoutSeconds:5` → controller abort → `retryable=true`). Reliable "in retry sleep" signal: `run.status === "running" && run.attempt >= 1`. Adding `maxRetries: 0` to the scheduler's `streamText` was tried then REVERTED (changes retry semantics, not cancellation — out of scope).
- **FLAKY (pre-existing, unrelated):** `tests/unit/tools.test.ts` "computer tools > lists processes with pid + name" failed once under full-suite load (`runProcesses()` returned empty); passes in isolation (15/0) and on full-suite re-run. Not caused by Phase 3.
- **LIVE VERIFIED (2026-09-17, coding agent):** physical Ctrl+C on an isolated real server (:3999, throwaway DATA_DIR, live :3000 untouched) with a chat run + scheduler run genuinely in-flight on a blackhole provider. Observed order: `shutdown_initiated signal=SIGINT` → chat `ai.error category=cancelled` → `shutdown_chat_settled settled=1 timedOut=0` → scheduler `outcome=cancelled` → `shutdown_runs_settled aborted=1 settled=1 timedOut=0` → `stopped`, clean process exit, port dead, no DB activity after close. DB-safety: the cancelled run's `updateRun`/`update` writes run inside the tracked promise before settlement is reported (bun:sqlite is synchronous), so `db.close()` cannot precede them; a still-hung task would surface as `timedOut > 0`, never as silent success. Footnote: the throwaway DATA_DIR was found removed post-run (cause untraced; repo `data/chat.db` untouched — last write predates the run), so no post-hoc row read; settlement stands on the counters + ordering above.

---

## Phase 4 — MCP lifecycle

### Goal
Disconnect ALL MCP servers (not just connected), cancel pending elicitations, and clear reconnect timers during shutdown.

### Audit findings (2026-09-17, re-verified against on-disk code + SDK probes)

Classification of the original plan's Phase 4 claims:

| Plan claim | Classification | Evidence |
|---|---|---|
| P3: non-connected servers with reconnect timers survive shutdown → crash against closed DB | ALREADY FIXED (verified) | `disconnectAll()` iterates `this.connections.keys()` — every state that can hold a timer/client (connecting/connected/error) has a map entry; `Promise.allSettled` over `disconnect(id)`; spine step 4 awaits it BEFORE `db.close()`. `connect()` is the only creator of map entries, timers, and clients. |
| P4: pending elicitation promises never settle on disconnect → SDK handler hangs | ALREADY FIXED (verified) | `cancelPendingElicitation(id)` at the top of `disconnect()` resolves the stored promise with `{ action: "cancel" }` (SDK `ElicitResultSchema` validates that shape — probe-confirmed). Idempotent: second call finds the slot already cleared. |
| Close-handler race: a close event during `client.close()` can schedule a reconnect after disconnect | DISPROVEN (dead code removed) | `registerCloseHandler` listened on `transport.on("close", …)`. **No SDK transport has `.on()`** (StdioClientTransport, StreamableHTTPClientTransport, SSEClientTransport, InMemoryTransport all expose an `onclose` property instead — runtime-verified `typeof t.on === "undefined"` on all four). The handler was therefore never registered and never fired; the "race" cannot occur. `disconnect()` setting `status="disconnected"` BEFORE `client.close()` remains the correct guard. Dead method REMOVED. |
| NEW finding: connect()-replacement leaks the prior connection's elicitation | PROVEN → FIXED | `connect()`'s prior-teardown closed `prior.client` without cancelling its pending elicitation: the SDK transport-close abort REJECTED the old request-handler promise with `SdkError(ConnectionClosed)` instead of the `{ action: "cancel" }` contract. Now `cancelPendingElicitation(id)` runs before `prior.client.close()` (manager.ts prior-teardown block). |
| Reconnect timers accumulate / fire after shutdown | DISPROVEN (no fix needed) | One timer per connection object; each failed attempt OVERWRITES `conn.reconnectTimer` (never a second concurrent timer); `disconnect()`/`connect()`-prior clear it; `scheduleReconnect` caps at `MAX_RECONNECT_ATTEMPTS=5` then leaves no timer; the timer callback guards on `!c || !c.config.enabled || c.status === "connected"`. Behavioral test proves a cleared timer cannot resurrect a connection 6s later. |
| SDK `client.close()` semantics | PROVEN (probe) | `Client.close()` → `transport.close()`; idempotent on both `Client` (double close resolves, no throw) and `InMemoryTransport` (`if (this._closed) return`). Close-during-connect: in-flight `connect()` rejects with `CONNECTION_CLOSED`; safe. |
| Shutdown-path DB safety | DOCUMENTED | After `disconnectAll()`, no MCP callback can write to SQLite: `handleSampling` uses `generateText` + `credentialStore` (no DB writes); `cancelPendingElicitation`/`resolveElicitation` are in-memory only; the SDK `_onclose` path (rejects in-flight requests) touches no TBAi DB. The only DB-touching MCP paths are config CRUD (`loadConfigs`/`insertConfig`/…), which run via routes BEFORE shutdown. |

**Deferred (documented, not a regression):** unexpected-transport-close → auto-reconnect is NOT implemented in TBAi. Reconnect happens only after a `connect()` FAILURE (bounded 5×5s). The removed close handler was the (dead) mechanism that would have provided this; re-implementing it would require the SDK's `onclose` property (which `Client.connect()` itself wraps — attaching a side handler is SDK-internal territory). Status: UNKNOWN how the SDK intends external close observation; DEFERRED pending a live-server probe.

### Implementation (2026-09-17)

Changes to `src/services/mcp/manager.ts` (two edits, one removal):
1. `connect()` prior-teardown now calls `this.cancelPendingElicitation(id)` before `prior.client.close()` — the elicitation of a replaced connection settles as `{ action: "cancel" }` instead of being SDK-rejected.
2. `registerCloseHandler` (dead — `transport.on` does not exist on any SDK transport) REMOVED, plus its call site in `connect()`.
3. `disconnect()` comment corrected: the status-before-close ordering is the single-source-of-truth guard, not a close-handler guard (no close handler exists).

`disconnect()`, `disconnectAll()`, `cancelPendingElicitation()` already implemented and verified — unchanged.

### Connection state machine (as implemented)

```
              connect()
     (none) ──────────────► connecting
                            │ success            │ failure
                            ▼                     ▼
                         connected ──────► error ──(≤5×5s timer)──► connecting
                            │ disconnect()     │
                            ▼                  ▼
                         disconnected ◄───────┘ (timer exhausted)
```
- `connecting → connected`: `client.connect()` success resets `reconnectAttempts=0`.
- `connected → disconnected`: only explicit `disconnect()`/`disconnectAll()` (status set BEFORE `client.close()`).
- `error → disconnected`: `disconnect()` clears the pending timer + counter.
- `disconnected` is stable: repeated `disconnect()` is safe (SDK close idempotent), timers cleared, no state resurrects without an explicit `connect()`/`setEnabled(true)`/reconnect-timer fire.
- One owner: `McpManager.connections` map (keyed by server id); the transport/client are created and destroyed only inside `connect()`/`disconnect()`.

### Tests (automated, 2026-09-17)
`tests/integration/mcp-v2.test.ts` new `describe("MCP lifecycle (Phase 4)")` — 6 behavioral cases: repeated-disconnect idempotency; disconnectAll over connected+error states; bounded-reconnect/no-resurrection after disconnect (6s watch window); pending-elicitation settlement on connect-replacement (the new fix); answer→disconnect double-settlement race; shutdown → no timer resurrection. Plus the pre-existing "disconnectAll (shutdown spine)" block (2 cases) and "canonical manager lifecycle over STDIO" (7 cases).

### Definition of done
- `disconnectAll()` covers all connection states; called in spine step 4 (already). ✔
- Pending elicitations cancel with `{ action: "cancel" }` on disconnect AND on connect-replacement. ✔
- No close-handler race (dead mechanism removed; status-before-close is the guard). ✔
- Reconnect timers cleared at disconnect/shutdown; bounded; cannot resurrect. ✔
- `bun run typecheck` + `bun run build` pass. ✔

### Testing requirements
`bun test tests/integration/mcp-v2.test.ts tests/integration/shutdown-lifecycle.test.ts`

### Verification status (2026-09-17)
- **IMPLEMENTED + AUTOMATED VERIFIED:** two manager.ts edits + dead-code removal; `tests/integration/mcp-v2.test.ts` → **21 pass / 0 fail** (15 pre-existing + 6 new Phase 4). `bun run typecheck` exit 0; `bun run build` exit 0. `bun run test:shutdown` 1 pass / 0 fail. Full `bun test` (777 tests, 88 files): **764 pass / 2 skip / 11 fail** — the 11 are the pre-existing flaky set (credentials in-process contamination, todo shared rows, terminal-runbash/wiring 5s timeouts, Playwright loader noise), zero MCP-related failures.
- **LIVE VERIFIED (2026-09-17):** see live section below — normal connect (no duplicate timers), explicit disconnect (no reconnect after 6s), pending-elicitation cancel on disconnect. Unexpected-close auto-reconnect NOT live-verified (feature deferred; no live close-detection exists to observe).
- **Remaining UNKNOWNs:** SDK `onclose` external-observation contract for unexpected-close reconnect (deferred); live elicitation against a non-fixture server (fixture covers the contract; live server not exercised).
- **PHASE 4 VERDICT: COMPLETE** (deferred item documented, not blocking).
- **Re-verification (2026-09-18, coding agent):** all Phase 4 claims re-checked against disk — disconnect/timer/elicitation seams match manager.ts:462-533; dead close-handler absent; 9 Phase-4 `it`s present in mcp-v2.test.ts:396-596; spine step 4 awaits `disconnectAll()` before `db.close()` (server.ts:277-281). Gates re-run: typecheck exit 0, full build exit 0, no code changed. Fresh live pass with stdio fixture attached: `shutdown_initiated signal=SIGINT` → `mcp.operation op=disconnect outcome=ok` → chat/scheduler settled 0/0 → `stopped`, port dead, no orphan child. Fresh suite confirmation pending test-agent Phase 4 report (prior R7 numbers stand until then).

---

## Phase 5 — SQLite lifecycle (independent hardening)

### Goal
Set a busy timeout on SQLite so concurrent access waits instead of throwing `SQLITE_BUSY` immediately.

### Current verified behavior
`db/index.ts:14`: `PRAGMA journal_mode=WAL`. No busy timeout set. Default is 0 (no wait). RUNTIME VERIFIED — `PRAGMA busy_timeout` returns `{ timeout: 0 }` on Bun 1.4.2.

### Problem
Concurrent SQLite access (scheduler catch-after-abort writes racing with `db.close()`) throws `SQLITE_BUSY` immediately instead of waiting. (P8)

### Files
- Modify: `src/db/index.ts:14` (add busy_timeout)
- Test: `tests/unit/db.test.ts` (new)

### Dependencies
None (independent hardening, not shutdown-critical given Phase 3 settlement).

### Implementation approach
After line 14 (`PRAGMA journal_mode=WAL`):
```ts
sqlite.run("PRAGMA busy_timeout=5000");
```

### Tests
- "sets WAL journal mode"
- "sets a busy timeout greater than 0"

### Definition of done
- `busy_timeout` is set and verified.
- `bun run typecheck` + `bun run build` pass.

### Verification status (2026-09-18, coding agent)
- **Audit:** single module-owned `Database` connection (`src/db/index.ts:11`); WAL set, `busy_timeout` PROVEN absent (default 0). Single-process + synchronous bun:sqlite → no in-process contention possible; shutdown races already solved by Phase 3 settlement. Usefulness: LIMITED/defensive (second process touching the file waits instead of instant SQLITE_BUSY). NOT a shutdown fix — recorded as such.
- **IMPLEMENTED:** `SQLITE_BUSY_TIMEOUT_MS = 5000` named const + `PRAGMA busy_timeout=5000` after the WAL pragma (db/index.ts:21-22). WAL untouched, no new abstraction, sync model untouched.
- **Gates:** `bun run typecheck` exit 0; full `bun run build` exit 0.
- **Live:** isolated server boots and serves normally with the pragma active (pragma errors would fail startup); conversation create/read verified. NOTE: `busy_timeout` is per-connection, so a post-hoc external pragma read proves nothing by design — behavioral contention proof belongs to `tests/unit/db.test.ts`.
- **Automated suite — RECONCILED 2026-09-18 (test agent):** `tests/unit/db.test.ts` (NEW, 6 cases: open+read/write, pragma > 0, WAL, lock-wait bound ≥4s, concurrent WAL reader, hermetic guard) → **6/0**. Full `bun test` 799/91: **786 pass / 2 skip / 11 fail** — all 11 in the known flaky set (isolation 29/0 across the 4 files). Zero Phase-5 failures. No tests weakened.
- **PHASE 5 VERDICT: COMPLETE.**

---

## Phase 6 — Remaining correctness cleanup

### Goal
Terminate OpenCode sessions on conversation DELETE (correctness issue, not shutdown).

### Current verified behavior
`conversations.ts:164-181` DELETE: deletes messages + conversation. Never calls `terminateOpenCodeSession()`.

`terminateOpenCodeSession(conversationId)` (`sessions.ts:266`): idempotent, calls `conversationService.get`, session.interrupt then session.remove, clears pointer. Returns `{ terminated: boolean }`. Calls `ensureBaseUrl()` which may SPAWN the OpenCode server if not running (safe — catches `OpenCodeBinaryMissingError`). Must be called BEFORE deleting the conversation row (terminate reads the conversation).

### Problem
DELETE orphans server-side OpenCode session pointer. (P10)

### Files
- Modify: `src/routes/conversations.ts:164-181`
- Test: `tests/integration/engine-guards.test.ts` (extend)

### Dependencies
None (independent).

### Implementation approach
Import `terminateOpenCodeSession` from `../services/opencode/sessions`. In the DELETE handler, after capturing `conv` and BEFORE the deletes:
```ts
if (conv?.engine === "opencode") {
  try {
    await terminateOpenCodeSession(id);
  } catch (err) {
    logger.warn("opencode", "conversation_delete_terminate_failed", {
      conversationId: id, ...normalizeError(err),
    });
  }
}
```

### Tests
- "opencode conversation delete terminates session before deleting row"
- "non-opencode conversation delete does not call terminate"

### Definition of done
- OpenCode sessions are terminated on DELETE.
- `bun run typecheck` + `bun run build` pass.

### Verification status (2026-09-18, coding agent)
- **Audit:** DELETE (conversations.ts:164-181) orphaned the server-side session — PROVEN. `terminateOpenCodeSession` (sessions.ts:266) is idempotent, reads the conversation row (must run BEFORE deletes), interrupt-then-remove, clears pointer, never throws for absent session; transport failures → warn + `{terminated:false}`. Engine comes from the authoritative record (`conv.engine`, default `"direct"`). Active generation: interrupt cancels it first, then remove. Failure semantics: cleanup can never fail the DELETE (route warns and continues).
- **IMPLEMENTED:** engine-gated `terminateOpenCodeSession(id)` after row capture, before the deletes (conversations.ts), warn-and-continue on unexpected throw. Direct conversations untouched by construction.
- **Gates:** `bun run typecheck` exit 0; full `bun run build` exit 0.
- **LIVE VERIFIED (2026-09-18):** isolated server, real managed OpenCode server (binary on PATH). Owned opencode conversation → session created (`ses_f4ec86d7…`) → DELETE → `session.interrupt` 204 → `session.remove` (V2-missing → V1-fallback 200) → `opencode.session_terminate` → DELETE 200 → conversation 404 after. Direct conversation DELETE → 200 with zero terminate/session traffic (engine gate proven). No orphan sessions touched.
- **Automated suite — RECONCILED 2026-09-18 (test agent):** engine-guards.test.ts +5 DELETE cases ("DELETE /api/conversations/:id — OpenCode session termination": direct/opencode/no-session/not-found/transport-failure, service-seamed) → combined `bun test engine-guards + db` **17/0**; full suite (above) zero Phase-6 failures. Incidental fix by test agent: toolkit.test.ts stale `OPENCODE_TOOL_NAMES` expected list (6 renderers missing) — test-staleness, source verified registering them (toolkit.ts:113-122); now 8/0. No tests weakened.
- **PHASE 6 VERDICT: COMPLETE.** Termination ordering, engine boundary, and error semantics proven live (above) and automated.

---

## Phase 7 — Dead code cleanup

### Goal
Remove confirmed-dead code and unused exports.

### Verified dead (PROVEN)
- `src/services/opencode/index.ts` barrel (never imported)
- `isOpenCodeReadyMarker` (`serverManager.ts:25-27`, only referenced by barrel + its own test)
- `OPENCODE_CONFIG.readyMarker` (only used by `isOpenCodeReadyMarker`)
- `OPENCODE_ROUTE_BASE` (`web/src/config/opencode.ts:3`, never imported)
- `"expired"` JobStatus (`schedulerTypes.ts:18`, never set)
- `INTERRUPTED_FROM` (`schedulerTypes.ts:81`, never used)
- `events.ts`, `permissions.ts`, `workspace.ts`, `types.ts` placeholders in `src/services/opencode/` (comment-only, never imported)

### NOT dead (verified, do NOT remove)
- `@opencode-ai/sdk` — frontend imports it (`eventScope.ts:1`), web declares it, frozen adapter depends on it
- `src/services/opencode/session.test.ts` — covers a distinct error path not in `sessions.test.ts`
- Root `package.json:33` `@opencode-ai/sdk` declaration is redundant but low-value to remove alone

### Files
- Delete: `src/services/opencode/index.ts`, `src/services/opencode/events.ts`, `src/services/opencode/permissions.ts`, `src/services/opencode/workspace.ts`, `src/services/opencode/types.ts`
- Modify: `src/services/opencode/serverManager.ts` (remove `isOpenCodeReadyMarker`)
- Modify: `src/config/opencode.ts` (remove `readyMarker` from config)
- Modify: `src/services/scheduler/schedulerTypes.ts` (remove `"expired"` status + `INTERRUPTED_FROM`)
- Modify: `web/src/config/opencode.ts` (remove `OPENCODE_ROUTE_BASE`)

### Tests
Full `bun test` green. `v2-only.test.ts` unaffected.

### Verification status (2026-09-18, coding agent)
- **IMPLEMENTED:** all removals executed — 5 files deleted (opencode barrel + events/permissions/workspace/types placeholders); `isOpenCodeReadyMarker` + `readyMarker` (value + type) removed; `"expired"` removed from backend union + `TERMINAL_JOB_STATUSES` (+ web `SchedulerJobStatus` mirror follow-through, one line); `INTERRUPTED_FROM` removed; `OPENCODE_ROUTE_BASE` removed. Reference audit before deletion: zero live importers of the barrel/placeholders; `readyMarker` used only by the removed function; `"expired"` never written/read (remaining matches are comments/prose/approval-domain); `ROUTE_BASE` defined-never-imported. Web approval `resolution: "expired"` is a different domain — untouched.
- **Gates:** typecheck currently red ONLY on `serverManager.test.ts` importing the removed function (expected — test-agent follow-through dispatched); backend build green. Full typecheck + build re-run after test cleanup.
- **Automated suite — RECONCILED 2026-09-18 (test agent):** marker import + describe removed from serverManager.test.ts (nothing else touched); zero remaining test references to any removed symbol (grep-audited; approval `resolution:"expired"` correctly untouched). `bun run typecheck` exit 0. Full `bun test` 797/91: **783 pass / 2 skip / 12 fail** — 11 known flaky (isolation 29/0) + 1 named timing flake (`MCP reconnect-cap`, passes in isolation, mcp-v2 file 25/0). Zero NEW failures, no weakening. Coding agent independently re-ran: typecheck exit 0, backend + web build exit 0.
- **PHASE 7 VERDICT: COMPLETE.** All lifecycle phases 0–7 are now closed.

---

## Removed / deferred tasks

| Item | Decision | Rationale |
|---|---|---|
| Stream tracking in inflight counter (old Task 6) | **REMOVED** | `body.getReader()` consumes the body (single-reader). Safe passthrough unnecessary: chat streams don't write to DB; `server.stop()` is graceful; DB-close race fixed by Phase 3 settlement. |
| Frontend store error handling (old Task 9) | **MOVED to future-hardening** | Real gap but not lifecycle-related. |
| `@opencode-ai/sdk` removal (old Task 10) | **DROPPED** | Not dead — frontend + frozen adapter depend on it. |
| `session.test.ts` deletion (old Task 10) | **DROPPED** | Covers a distinct error path. |
| Loopback binding | **DROPPED** | Maintainer decision: server stays `0.0.0.0`. |

---

## Final execution order

```
Phase 5  busy_timeout (independent, do anytime)
Phase 3A chat abortAll (independent)
Phase 3B scheduler abortAllRuns + tracking (independent)
Phase 2  OpenCode process lifecycle hardening (depends on Phase 1 existing)
Phase 4  MCP disconnectAll + elicitation cancel (independent)
Phase 1  shutdown spine (wires all seams together)
Phase 6  conversation DELETE terminate (independent)
Phase 7  dead code cleanup (last — touches many files)
```

Phases 2-5 are independent of each other; Phase 1 wires them together and should be last of the core work. Phase 6 is independent. Phase 7 is always last.

---

## Things that should NOT be changed

- `@assistant-ui/*` versions (train freeze)
- Provider-agnostic chat architecture
- Server-owned run design (disconnect ≠ kill)
- OpenCode isolation boundary
- `bun:sqlite` synchronous model
- Encryption architecture
- `docs/decisions.md` as the architectural decision record
- Server binding stays `0.0.0.0`
- `@opencode-ai/sdk` (frontend + frozen adapter depend on it)
- `src/services/opencode/session.test.ts` (distinct error path)

---

## Runtime verification (2026-09-17, live)

Phase 2 live verification was completed against a real server (`bun run src/index.ts`) with a real managed `opencode serve` child. All gates green before live work: `bun run typecheck` exit 0, `bun run build` exit 0, `bun run test` 743 pass / 0 fail (745 tests, 77 files), `bun run test:shutdown` 1 pass / 0 fail.

### LIVE VERIFIED — normal startup
- Trigger: `POST /api/conversations` `{"engine":"opencode"}` then `POST /api/opencode/session`.
- Log: `readiness.start port=63013 pid=19320 reused=false` → `readiness.ready elapsedMs=1768 attempts=8 port=63013` → `opencode.spawn port=63013 pid=19320` → `opencode.session_create conversationId=...`.
- Exactly ONE managed child (`opencode serve --port 63013`) under the bun server. New `pid=` fields prove the new code is running.

### LIVE VERIFIED — kill/restart
- Killed ONLY the managed child (`Stop-Process -Force`, exit code 255 = TerminateProcess on a running child).
- Log: `opencode.unexpected_exit code=255 pid=19320 port=63013 attempt=1 maxAttempts=3 stderrTail= stdoutTail=Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\nopencode server listening on http://127.0.0.1:63013` → `opencode.restart attempt=1 maxAttempts=3 port=63013` → `readiness.start port=58886 pid=10304 reused=false` → `readiness.ready elapsedMs=1510 attempts=7 port=58886` → `opencode.spawn port=58886 pid=10304`.
- New child 10304 under the same bun server; no duplicates; exactly one managed child at all times.

### LIVE VERIFIED — MCP normal connect / explicit disconnect (Phase 4, 2026-09-17)
- Trigger: `bun run src/index.ts` with the TBAi MCP GUI; registered the fixture/echo MCP server (`bun run tests/fixtures/everything-server.ts stdio`) over the real manager, not just the test harness.
- **Normal connect:** `mcp.operation op=connect outcome=ok` with `tools=3 resources=1 prompts=1`; single connection, no duplicate reconnect timers observed (the reconnect timer only exists on the error path — a successful connect resets `reconnectAttempts` to 0 and stores no timer).
- **Explicit disconnect:** `POST /api/mcp/servers/:id/disconnect` → `mcp.operation op=disconnect outcome=ok` → status `disconnected`. Watched 12s (2× the 5s reconnect delay): NO `reconnect` log line, no status resurrection — the explicit disconnect cleared the timer/reconnect state.
- **Pending elicitation → disconnect:** the fixture's `ask_user` tool produced a pending elicitation (`Elicitation requested` log, `GET /api/mcp/elicit/pending` returned it). `disconnect` while pending → the pending slot cleared (`getPendingElicitation` → undefined, `elicit/pending` → null) and the tool-level promise settled (no hang). The `{ action: "cancel" }` contract verified at the SDK type level and fixture level.
- Note: this live pass exercised the stdio fixture server through the real manager + routes. The unexpected-close → reconnect path was NOT live-observed because TBAi has no live close-detection mechanism to observe (deferred, see UNKNOWN #5).

### LIVE VERIFIED — normal shutdown (no restart, no orphan)
- Ctrl+C (`C-c` key token) → `shutdown_initiated signal=SIGINT` → `mcp.operation op=disconnect outcome=ok` → `[server] stopped`.
- NO `opencode.restart` / `opencode.unexpected_exit` after shutdown — the managed child is NOT restarted.
- Managed child process gone after shutdown; no orphan. Verified in three independent runs (opencode-only, restart-then-shutdown, and the original live-verify).

### LIVE VERIFIED — Windows kill semantics (F5)
- `child.kill("SIGTERM")` in `shutdown()` terminates the child on Windows (child gone after shutdown; no 5s SIGKILL wait observed in logs).
- Hard-crash orphan outcome: when the parent bun process is killed (Stop-Process), the managed child also exits (observed informally during leftover-server cleanup: child 18312 already gone after parent 2280 killed). Consistent with stdio-closure reclaim; not a pidfile-based guarantee.

### UNKNOWN — still open
1. **Exit code 58 source** — UNKNOWN. Live kills produce code 255 (TerminateProcess), not 58. Exit-during-readiness (58) is covered by unit tests with a fake child; the real-world trigger is not yet observed.
2. **F6 orphan detection/reclaim** — UNKNOWN/DEFERRED. No pidfile mechanism; safe ownership of a stale process cannot be established. Documented limitation.
3. **MCP sampling/elicitation against real (non-fixture) servers** — UNKNOWN. Elicitation cancel fix verified against the SDK type contract + fixture server, not a third-party live server.
4. **Tauri sidecar close path** — UNKNOWN whether it sends SIGTERM or closes stdin. The shutdown handles both.
5. **MCP unexpected-close auto-reconnect** — UNKNOWN/DEFERRED (Phase 4). The dead `registerCloseHandler` mechanism removed in Phase 4 was the (never-functional) path for this; the SDK's `onclose` external-observation contract is not established. Reconnect today happens only after `connect()` failure (bounded 5×5s). Not a regression — no close-detection existed in practice before either.

### OBSERVED ANOMALY (not a Phase 2 defect)
- In the original live-verify (browser connected to port 3000, server running ~12 min, opencode child restarted once, in-flight chat stream cancelled at shutdown), the bun process remained alive 3+ minutes after `[server] stopped` (port released, child gone, no restart).
- NOT reproduced in four controlled experiments (no-opencode control, opencode-only, restart-then-shutdown, in-flight-chat-only) — all exited cleanly.
- Not attributable to the opencode lifecycle (opencode-only and restart-then-shutdown both exited). Likely a pre-existing, flaky server issue (browser SSE connection / accumulated long-running state). Recorded for follow-up; out of Phase 2 scope.
