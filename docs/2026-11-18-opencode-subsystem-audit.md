# OpenCode Subsystem — Independent Audit Report (2026-11-18)

> **Status:** Read-only audit. No source, test, config, schema, manifest, lockfile, or
> branch changes were made to produce this report. This document is the only file added.
> **Branch:** `review/managed-opencode-hardening-2026-11-15`
> **HEAD audited:** `8b27424b1f6bba4cd15276a5c55cb613a6419128` (pushed; tracking origin at the same SHA)
> **Method:** six parallel read-only deep-dive audits (process lifecycle, session
> ownership, recovery/scheduler, client/proxy/config, frontend runtime, docs/coverage)
> plus a fresh `bun run verify`. Findings are cited by file:line; re-verify against the
> tree before relying on any line.

## 1. Verdict

**Audit verdict (2026-11-18 snapshot): NOT done.** That snapshot predates the
closure work recorded in §§11–14. As of 2026-11-19, the blockers it names are
resolved: B1 (managed-restart E2E) was root-caused to the external runner's
blocking `spawnSync` and fixed with an in-repo async runner (§14.1), and B2
(production shutdown) was fixed with a regression test (§11). All findings in
the canonical register (§10) are now `Fixed`, `Not a defect`, or documented
scope decisions. The dedicated managed-restart acceptance test passes 8/8 locally
and in CI (Actions run `44521502042` on commit `d4e7103` → success, all active
jobs green). No blockers remain.

## 2. Blockers (resolve before "done") — historical snapshot

> **2026-11-19 status:** both blockers below are resolved. B1 was root-caused to
> the external runner's blocking `spawnSync` and fixed with an in-repo async
> runner, a deterministic test, a regression guard, and a CI gate (§14.1). B2 was
> fixed with a production `beginShutdown()` call and regression test (§11). The
> text below is preserved as the original audit finding.

### B1 — Dedicated managed-restart recovery E2E is failing and not gated

`tests/e2e/opencode/opencode-managed-restart-recovery.spec.ts` is absent from the
9-spec gated E2E list in `.github/workflows/tests.yml:452-463`. Per the durable
recovery plan §17, it fails at all three states tested (navigation assertion at
`2ef39c5`/`0a37700`, transcript timeout in the working tree) and is classified
flaky. Acceptance criterion §14.1 — "both restart scenarios continue an
interrupted turn" — is therefore **not verified by a passing end-to-end test**.
This is the single strongest reason not to declare done.

### B2 — Production shutdown never calls `beginShutdown()`

`src/server.ts:393` and `:559` call `openCodeServerManager.shutdown()` directly.
That method (`serverManager.ts:1466-1477`) sets `this.stopping` but never writes
connection state. `beginShutdown()` (`connectionState.ts:496-534`) — the only
writer of `shutdownStarted`/`shutdownEpoch` and the only caller of the registered
`ManagedChildStopProvider` — is called **only in tests**. Consequences:

- `readShutdownState().shutdownStarted` is permanently `false` in production, so
  the guards in `startup.ts:102/116/120`, `runtimeTarget.ts:75/103`,
  `serviceAccess.ts:57`, `recovery.ts:85`, and `serverManager.shutdownBegun():778`
  are dead.
- `shutdownEpoch` never increments, so transport epoch revocation
  (`connectionState.ts:417-425`) never fires.
- After `shutdown()`, `readConnectionState().target` still reports `mode:"managed"`
  with the dead child's base URL.

Tests validate the `beginShutdown()` contract but never the production-only
`manager.shutdown()`-alone path for target clearing. Practical impact is limited
because the process exits immediately after shutdown, but it is a real
test/production mismatch and a large dead contract.

## 3. Real defects (medium)

- **Frontend orphaned prompt record.** `web/src/features/opencode/v2ThreadController.ts:2357-2373`:
  `sendMessage()` creates an admission record, then calls `applySelection()` with
  no try/catch. If `switchModel`/`switchAgent` (`:2321-2331`) rejects or generation
  is unavailable, the record is left in phase `"submitting"` with no protections;
  `promptsInFlight.ts:336-342` `canEvict()` returns false for that shape, so TTL/cap
  sweeps never remove it. Result: permanent `submissionPending=true` /
  `primaryStatus="submitting"` and a leaked capacity slot. The test harness stubs
  the switch functions as never-throwing
  (`tests/helpers/web/opencode/v2ThreadControllerHarness.ts:395-396`), so no test
  covers it.
- **Singleflight keyed by permission shape.** `src/services/opencode/sessions.ts:807-821`:
  the in-flight key is `${conversationId}:custom_perms` when `options.permissions`
  is present, else `conversationId`. The comment at `:804-806` claims one ensure per
  conversation, which is false across shapes. The route calls with no options
  (`routes/opencode.ts:166`); `scheduledExecution.ts:177-186` calls with permission
  presets. A job firing while a user opens the same conversation with a null pointer
  can create two sessions; last writer wins, one is orphaned (recoverable via the
  intent journal). `sessions-concurrency.test.ts:115-122` only exercises same-shape
  calls.
- **Frontend isolation boundary violation.** `web/src/features/permissions/state/stalePermissionsStore.ts:3`
  value-imports `isPermissionNotFoundError` from `@opencode/client` (called at
  `:42`). `AGENTS.md` and `docs/architecture.md:254-258` state `features/opencode/`
  is the only frontend runtime consumer, with one type-only exception in
  `tools/opencode/adapt.ts`. This contradicts `docs/decisions.md:3514` ("exactly
  one frontend value import"). Introduced 2026-10-22 in `b742ac4`; no guard test.
  It is a pure helper, so no duplicate-context risk — but an undocumented exception
  to a stated rule.
- **Windows native handle leak and spawn-failure cleanup.** `process-ownership.ts:566`
  calls `DeleteProcThreadAttributeList` unconditionally then again in the `ok === 0`
  branch — a double free on `CreateProcessW` failure; on that path only `nulHandle`
  is closed, leaking four pipe handles. `serverManager.ts:715-716` stores process and
  thread handles via `as any` that `cleanupManagedJob()` (`:1375-1395`) never closes;
  each managed child leaks two native handles for the process lifetime. Windows-only,
  spawn-failure-only, entirely untested.
- **Registration-clear race on restart.** `serverManager.ts:803-830`, specifically
  `:827 this.publishedRegistration = null` in `finally`, is called fire-and-forget
  from `onExit` (`:1188-1190`). If a restart publishes a new registration before the
  old removal's async I/O completes, the old `finally` wipes the new in-memory
  reference. Minimal fix: clear only if `this.publishedRegistration === owned`.

## 4. Low / informational

- `scanHistory` truncation flag can be false when the page budget is exhausted with
  fewer than `maxMessages` collected (`recovery.ts:347-375`). Benign — unscanned
  history is strictly older, so it cannot contain a newer input.
- Production `readSessionSignal` uses `OPENCODE_RECOVERY_CONFIG.perCallTimeoutMs`
  directly (`recovery.ts:118`) instead of the `timeoutMs()` seam (`:229-231`).
  Production behavior is correct; no test relies on the override.
- `compactionStatus` is captured (`recovery.ts:300`, `recoveryClassifier.ts:31`) but
  never read by `classifyRecovery` — dead data, deliberate design.
- Adopt-path model repair drops the stored variant (`sessions.ts:880-886` →
  `assignSessionModelIfMissing` at `:352-382` passes only `{id, providerID}`).
- Redaction denylist: a secret-named key holding an object is recursed into rather
  than masked (`configRedaction.ts:285-287`); no real published config shape hits it.
- Restart-exhaustion recovery entry points (`resetRestartBudget`/`recoverManagedServer`,
  `serverManager.ts:513-521`) have no caller in routes/services/UI; the error message
  promises a recovery that does not exist.
- Untested edge branches: `__proto__` own-property guard (`configRedaction.ts:274-281`),
  SSE tolerant `\r\n\n` boundary (`sse-diagnostic-observer.ts:53`), secret-object
  recursion, `OpenCodeAuthScopeError` path (unreachable by type), bounded-record
  eviction at 8 responses (`client.ts:24,47`).
- Stale comments claiming overflow fails readiness (`v2ThreadController.ts:550-568,
  581-586, 1611-1615`; `eventPipeline.ts:296-307, 686-688`) — behavior is correct and
  tested, but the causal comments are wrong.
- `refresh()`/`reconcileStagedRevert()` lack attempt-liveness guards across awaits
  (`v2ThreadController.ts:1857-1876, 1936-1965`); a torn read is possible but the
  `history_loaded` merge limits impact.
- `assertSameHistoryOwner` (`historyBoundary.ts:332-346`) is a dead export; the
  affinity guarantee rests on the single remote-owner check in `serviceAccess.ts:59-66`.

## 5. Documentation drift

- The canonical roadmap (`2026-11-10-opencode-recovery-improvement-plan.md`) is
  **silent on the implemented restart-recovery service** — it still lists
  `REL-IMPL-SESSION-RESTORE-*` / `REL-IMPL-MANAGED-CRASH-*` as NOT STARTED with
  "no proven gap; live crash verification unavailable." A reader would wrongly
  conclude no restart-recovery work exists. The task IDs are formally distinct, so
  this is a traceability/linkage defect, not a false status.
- Same file: stale "GitHub publication pending" line (`:710`); seven references to
  a deleted `tests/unit/opencode/recovery.test.ts` (`:194,200,202,208,362,364,365`);
  stale baseline (`:14-23`).
- `2026-11-16-opencode-durable-recovery-plan.md:3-6,761-768` freezes the commit chain
  at `9502943`; four later commits (`3b32598`, `15c3ca0`, `3dfa9bf`, `8b27424`) are
  not reflected, and §17 verification numbers no longer describe the final code.
- `docs/engineering-quality.md:180` and `.github/workflows/tests.yml:275` say "seven
  required suites"; the script defines ten (`scripts/run-opencode-runtime-suites.ts:67-78`).
- `docs/engineering-quality.md:76-84,148-149` says 50 E2E specs (43 non-live + 7
  live); actual count is 53 (46 + 7).
- `docs/opencode-context.md:6,101,121,183-187` has stale HEAD `80813d8` and
  "uncommitted"/"verify in progress" notes.
- `docs/opencode-runtime-audit-final.md` RT-004 (`:321,331,441`) still Open — the
  owner's 2026-11-18 "no health supervisor" decision has not been recorded as the
  explicit out-of-scope statement.
- `2026-11-01-opencode-session-import-plan.md:4` and `.revised.md:5` say "awaiting
  authorization" though import code was added in the same commit (`d560b26`).
- Historical plans (2026-10-20/23/29/31, 2026-11-01) carry 2.0/2.1/2.2 version pins
  with no inline 2.2.6 supersession banner; globally declared superseded only in
  the canonical roadmap §14.24:690.

## 6. Verified with no defect

- **Both recovery fixes from this session are correct and complete.** Commit `15c3ca0`
  isolates per-candidate failures (`recovery.ts:736-748`); commit `3dfa9bf` scopes
  pass-stop to `!started || !targetStillValid(change)` (`:742`), so a candidate-level
  `AbortError` cannot starve later candidates. No remaining starvation path.
- Cancellation/shutdown, target replacement, grace re-evaluation, the conservative
  classifier, and unattended tool safety all hold. Destructive scheduler tools are
  `refusalTool` that always throw; MCP tools are absent (V1); no `autoApprove` anywhere.
- No health-supervisor-like code (no health timer, TCP/HTTP liveness-probe loop,
  `startGate`, or owner-recovery UI). `probeOpenCodeInfo`/`waitForHttpReady` are
  one-time bounded startup gates; `stabilityTimer` is a restart-budget reset.
- 2.2.6 pin consistent: `@opencode/client` exactly 2.2.6 in root and web manifests,
  `minimumVersion: "2.2.6"`, CI `OPENCODE_VERSION=2.2.6` with verified SHA512.
- Backend client boundary holds: `@opencode/client` imported only inside
  `src/services/opencode/`; no other backend module talks to the managed process.
- Config write refusal: all three write routes go through
  `assertOpenCodeConfigWriteAllowed({mode:"managed"})`; no `config.update`, no
  `jsonc-parser.modify`/`applyEdits`, no JSONC write-back; integration tests confirm
  409 + byte-identical file.
- Proxy allowlist, auth stripping, redirect refusal (`redirect:"manual"`, 3xx refused
  without reading `Location`), workspace authorization, and SSE byte transparency
  all fail-closed and tested.
- Capabilities single source of truth with target-identity invalidation, stale-response
  protection, last-success retention, and a default-model descriptor that omits
  `settings`/apiKey. No duplicate authoritative fetch.
- Ownership/affinity fail-closed; session-ID integrity; deletion snapshot guards;
  stale-session handling; imported-session refusal; model assignment — all tested.
- Frontend generation/attempt ownership, no duplicate prompts/subscriptions, bounded
  reconnect churn, authoritative prompt reconciliation, auxiliary hydration
  degradation, and cleanup of timers/listeners — all verified and tested.
- Gate table and CI `verify` job sequence match `package.json`; the 9-spec E2E list
  matches the doc; runtime-suite registry is complete (10 required + 2 excluded) and
  drift-guarded by `tests/unit/tooling/opencode-runtime-gate.test.ts`.

## 7. `REL-IMPL-SESSION-RESTORE-*` assessment

**Genuinely only a live-verification gap. No static evidence of a session-restore
defect exists.** Two independent audits confirm the 2026-11-10 investigation's
conclusion: `ensureOpenCodeSession` reuses verified live sessions, recreates only on
proven 404 for non-imported rows, refuses missing imported sessions, and reconciles
directory + owner + model on adopt. `SessionRestart.resumeSuspendedSessions` has zero
references in `src/` — upstream OpenCode 2.2.6 owns recovery of claimed sessions, so
TBAi correctly does not duplicate it. The owner's 2026-11-18 decision to keep this
investigation-only until a projected user message with no assistant response and no
durable execution claim is reproduced is consistent with the code. The two real
defects found (singleflight key split, adopt variant) are not session-restore defects
and do not justify opening this task.

## 8. Verification actually run

`bun run verify` — **exit 0**, all gates green:

| Gate | Result |
|---|---|
| typecheck | exit 0 |
| lint | exit 0 (1261 files, no fixes) |
| format:check | exit 0 (1261 files, no fixes) |
| test:locations | OK |
| build | exit 0 |
| `bun run test` | 5981 pass, 0 fail (6069 tests, 462 files) |
| test:shutdown | 1 pass, 0 fail |
| test:startup-rollback | 2 pass, 0 fail |
| test:lifecycle-integration | 3 pass, 0 fail |
| test:dom | 813 pass, 0 fail (84 files) |
| test:quarantine | OK — no stale entries |

## 9. Recommended path to "done" (historical — all items now closed)

This was the audit's 2026-11-18 remediation plan. Every item is now resolved in
§§11–14:

1. **B1** — fixed (external runner `spawnSync` → async `spawn`), gated in CI (§14.1).
2. **B2** — `beginShutdown()` wired into production shutdown with a regression test (§11).
3. **M1/M2/M3** — orphaned-prompt record, singleflight key split, and client-boundary
   guard all fixed with tests (§11).
4. **DOC1–DOC8** — reconciled in place (§14.3).
5. **Verification** — `bun run verify` exit 0 and the dedicated managed-restart E2E
   8/8 passing (§14.4).

---

## 10. Finding register (canonical — audit + execution plan)

This section is the single working register. Section 3 letters A–H map onto the
audit findings as noted. Status values: `Confirmed defect`, `Confirmed existing
fix`, `Not a defect`, `Needs runtime verification`, `Blocked`. Statuses are
updated as findings are verified and fixed. No separate plan document exists;
this file is both the finding register and the execution sequence.

| ID | Finding (source) | Maps to §3 | Status | Evidence / resolution |
|---|---|---|---|---|
| B1 | Managed-restart recovery E2E failing and not gated (§2) | G | **Fixed** — three scenarios now covered | (a) Completed-transcript persistence: root cause was the external runner's blocking `spawnSync`; fixed with in-repo async runner (§14.1). (b) Orderly-shutdown interrupted-turn continuation and (c) abrupt managed-child crash recovery: new E2E specs + runner control protocol; revealed a genuine production defect — re-posting an already-projected user id reconciles but creates no inbox work in OpenCode 2.2.6, so the wake goes idle without an assistant. Fixed by using a fresh recovery synthetic for projected+shutdown-interruption cases (§15). All three scenarios pass 3/3 and are gated in CI. |
| B2 | Production shutdown never calls `beginShutdown()` (§2) | A | Confirmed defect (static) | `beginShutdown()` has no production caller; `serverManager.shutdown()`→`clearBindingForShutdown()` never calls `clearManagedTarget()`. Fix + regression test pending. |
| M1 | Frontend orphaned prompt record on selection failure (§3) | B | Needs verification | `v2ThreadController.ts:2357-2373` no try/catch around `applySelection()`. |
| M2 | Singleflight keyed by permission shape (§3) | C | Needs verification | `sessions.ts:807-821`; caller reachability to be traced. |
| M3 | Frontend `@opencode/client` boundary violation (§3) | D | Needs verification | `stalePermissionsStore.ts:3` value import. |
| M4 | Windows native handle leak / spawn-failure cleanup (§3) | E | Needs verification | `process-ownership.ts:566-569`, `serverManager.ts:715-716`. |
| M5 | Registration-clear race on restart (§3) | F | Needs verification | `serverManager.ts:827` unconditional clear in `finally`. |
| H | Recovery candidate isolation (§3-H) | H | Confirmed existing fix | Commits `15c3ca0`/`3dfa9bf`; re-verify focused tests. |
| L1 | `scanHistory` truncation flag accuracy (§4) | — | Needs verification | Benign; verify then classify. |
| L2 | `readSessionSignal` ignores timeout seam (§4) | — | Needs verification | Production correct; seam inconsistency. |
| L3 | `compactionStatus` captured but unread (§4) | — | Needs verification | Dead data, deliberate. |
| L4 | Adopt-path model repair drops variant (§4) | — | Needs verification | `sessions.ts:880-886`. |
| L5 | Redaction denylist secret-object recursion (§4) | — | Needs verification | No real config shape hits it. |
| L6 | Restart-exhaustion recovery entry has no caller (§4) | — | Needs verification | Error message promises nonexistent recovery. |
| L7 | Untested edge branches (§4) | — | Needs verification | `__proto__`, SSE `\r\n\n`, etc. |
| L8 | Stale comments claiming overflow fails readiness (§4) | — | Needs verification | Behavior correct; comments wrong. |
| L9 | `refresh()` lacks attempt-liveness guards (§4) | — | **Fixed** — deterministic regression test | Race reproduced (stale gen-1 session title committed after takeover). Fixed by capturing `currentAttempt`/generation once and checking `isLive(live)` after each await in both `refresh()` and `reconcileStagedRevert()`. Guard proven to fail when reverted. `tests/unit/web/opencode/v2ThreadController.liveness.test.ts` 1 pass, 0 fail. See §14. |
| L10 | `assertSameHistoryOwner` dead export (§4) | — | Needs verification | Informational. |
| DOC1–DOC8 | Documentation drift (§5) | — | **Fixed** — all eight corrected | Each finding verified against actual code/tests/scripts/manifests/GitHub state, then corrected in place with history preserved. Exact files and changes in §14. |

### Execution order

1. **Shared lifecycle first:** B2/A (shutdown), then M5/F (registration race), M4/E (handles).
2. **Frontend state:** M1/B (prompt record), M3/D (boundary).
3. **Session:** M2/C (singleflight), L4 (variant).
4. **Re-verify:** H (recovery), B1/G (E2E), L1–L10, DOC1–DOC8.
5. **Full verification:** focused tests → `bun run verify` → gated E2E → runtime suites.

---

## 11. Verification results and remediation (2026-11-19)

All findings were independently re-verified against HEAD `8b27424` by tracing
callers, state transitions, and tests. Statuses below supersede §10.

### Confirmed defects — fixed with regression tests

| ID | Root cause | Minimal fix | Regression test | Status |
|---|---|---|---|---|
| B2 / A | `runShutdown()` called `manager.shutdown()` directly; `beginShutdown()` had no production caller, so `shutdownStarted` stayed false, epoch never advanced, target stayed `managed` with a dead URL. | `src/server.ts`: call `await beginShutdown()` in `runShutdown()` before `manager.shutdown()` (child stops are idempotent). | `tests/integration/core/shutdown-lifecycle.test.ts`: installs a managed target, shuts down via the production entry point, asserts latch/epoch/target cleared and repeated shutdown safe. | **Fixed** — `bun run test:shutdown` 1 pass, 0 fail |
| M5 / F | `removeOwnedRegistration()` nulled `publishedRegistration` unconditionally in `finally`, so an old removal could clear a newer registration published during its async I/O. | `serverManager.ts:827`: `if (this.publishedRegistration === owned) this.publishedRegistration = null;` | `tests/unit/opencode/registrationClearRace.test.ts`: deferred-promise interleaving; asserts new pid survives and shutdown can still clean up. | **Fixed** — 1 pass, 0 fail |
| M3 / D | `stalePermissionsStore.ts` value-imported `isPermissionNotFoundError` from `@opencode/client`, pulling the client runtime into the Direct Chat module graph (shared store used by normal-chat approval). | Inlined the one-line `_tag === "PermissionNotFoundError"` predicate locally; removed the value import. | `tests/unit/web/core/permissionPolicy.test.ts`: new boundary guard scanning `web/src` for value imports outside `features/opencode`. | **Fixed** — 17 pass, 0 fail |
| M1 / B | `sendMessage()` created a prompt record then awaited `applySelection()` with no try/catch; a rejected model/agent switch left a non-terminal, non-evictable `"submitting"` record. | `v2ThreadController.ts`: try/catch around `applySelection()` that calls `prompts.settleVerdict(messageId, "definitive-failure")` and rethrows. | `tests/unit/web/opencode/v2ThreadController.capacity.test.ts`: injects a rejecting `switchModel`, asserts record terminal + sweep-evictable + later send works. Harness gained optional `switchModel`/`switchAgent` handlers. | **Fixed** — 3 pass, 0 fail |
| M2 / C | Singleflight key split by permission shape (`conversationId` vs `conversationId:custom_perms`), so a user open and a scheduler job could both create a session; last-writer-wins orphan (not journal-recoverable). | `sessions.ts`: per-conversation key + `mergeSessionPermissions()` (most-restrictive-wins) merged into shared mutable options read at create time. | `tests/unit/opencode/sessions-concurrency.test.ts`: deterministic barrier; different-shape concurrent calls → 1 create, shared id, READ_ONLY restrictions honored. Guard proven by reverting the key (2 creates). | **Fixed** — 2 pass, 0 fail |
| L4 | Adopt-path model repair (`assignSessionModelIfMissing`) dropped the stored thinking-level variant that the create path preserves. | Pass `conversation.opencodeVariant` through and include `variant` in `switchModel`. | `tests/unit/opencode/sessionModelWiring.test.ts`: asserts variant on adopt repair. | **Fixed** — 12 pass, 0 fail |
| M4 / E | Windows native handles: double `DeleteProcThreadAttributeList` on `CreateProcessW` failure; pipes/job leaked on failure branches; proc/thread/read-end handles never closed. | `process-ownership.ts`: single `try/finally` + `createHandleGuard` (exactly-once close, release on transfer); `SuspendedSpawnResult` exposes read handles; `serverManager.ts` stores handles in a typed map and closes them in all cleanup paths (removed `as any`). | `tests/unit/opencode/spawnHandleCleanup.test.ts`: 4 deterministic guard tests (exactly-once, idempotent, release semantics). | **Fixed** — 4 pass, 0 fail |
| L8 | Stale comments claimed buffer overflow fails attempt readiness; implementation correctly leaves that decision to the reconciliation path. | Corrected 4 comment sites in `v2ThreadController.ts` and `eventPipeline.ts`. | Behavior already covered by `eventBufferOverflow.test.ts`; comments only. | **Fixed** — comments corrected |

### Not a defect (verified, no change)

- **L1** `scanHistory` truncated flag: benign edge; classifier guard unaffected (unscanned history is strictly older).
- **L2** `readSessionSignal` timeout seam: production value identical; no test relies on the override.
- **L3** `compactionStatus` unread: deliberate (compaction is a boundary only).
- **L5** secret-object recursion: no real published config shape hits it; schema-based masking covers secret subtrees.
- **L7** `OpenCodeAuthScopeError` unreachable by type; other edge branches are low-priority test gaps, not defects.
- **L10** `assertSameHistoryOwner` dead export: informational; real affinity guard is `serviceAccess.ts:59-66`.
- **H** recovery candidate isolation: commits `15c3ca0`/`3dfa9bf` correct and complete; no starvation path.

### Needs runtime verification / blocked

- **B1 / G** managed-restart E2E: **Fixed** — see §14.1. Root cause was the external runner's `spawnSync` blocking the Bun event loop that hosts the in-process stub provider, so the stub could never answer OpenCode's model request. Replaced with an in-repo async-spawn runner (`scripts/run-managed-restart-e2e.ts`); test made deterministic (wait for settled transcript); 8/8 repeated runs pass; regression test proves the guard; gated in the Windows `e2e` CI job.
- **L9** `refresh()`/`reconcileStagedRevert()` lack attempt-liveness guards across awaits: **Fixed** — see §14. Race reproduced deterministically (stale gen-1 session title committed after takeover), fixed with captured-generation + `isLive(live)` checks after each await, guard proven to fail when reverted. Regression test added.
- **L6** restart-exhaustion recovery entry points have no caller: dead code, informational; budget is reset internally by the stability timer. Left unchanged.

### Documentation drift (DOC1–DOC8)

All eight corrected in place with history preserved — see §14 for the exact files and changes. No duplicate audit or plan document was created.

### Verification commands and results

- `bun run typecheck` → exit 0
- Focused tests (`bun test --isolate <7 files>`) → 40 pass, 0 fail
- `bun run test:shutdown` → 1 pass, 0 fail
- Full `bun run verify` → **exit 0**, all gates green (see §12).
- Gated E2E → not run (the managed-restart spec is not in the gate; see B1).

## 12. Final verification (2026-11-19)

`bun run verify` — **exit 0**:

| Gate | Result |
|---|---|
| typecheck | exit 0 |
| lint | exit 0 (1263 files, no fixes) |
| format:check | exit 0 (1263 files, no fixes) |
| test:locations | OK |
| build | exit 0 |
| `bun run test` | 5990 pass, 0 fail (6078 tests, 464 files) |
| test:shutdown | 1 pass, 0 fail |
| test:startup-rollback | 2 pass, 0 fail |
| test:lifecycle-integration | 3 pass, 0 fail |
| test:dom | 813 pass, 0 fail (84 files) |
| test:quarantine | OK — no stale entries |

Focused regression tests (`bun test --isolate <7 files>`) → 40 pass, 0 fail.

**CI status (verified 2026-11-19):** the B1 fix was committed as `d4e7103` and
pushed to `review/managed-opencode-hardening-2026-11-15`. GitHub Actions run
`44521502042` (`workflow_dispatch`, head `d4e7103757f55ac654d492cf3ee0d33c5d4fcd2e`)
→ **conclusion `success`**. All five active jobs passed (`e2e`, `verify`,
`opencode-g3`, `opencode-runtime`, `tauri`); `e2e-full` and `e2e-big-pickle`
were skipped by the default-false dispatch inputs. The `e2e` job's
"E2E (managed-restart recovery, B1)" step ran `bun run test:e2e:managed-restart`
against the pinned 2.2.6 CLI (integrity-verified, on PATH) and reported
`1 passed (11.8s)`, `playwright exit 0`, `stub requests 2`; the
`managed-restart-evidence` artifact (3,994,898 bytes) was uploaded. The
regression test also passed in the `verify` job. See §14.4.

**Remaining blockers:** none. B1/G is fixed, gated, and CI-verified (§14.1);
L9 and DOC1–DOC8 are closed. All local and CI gates pass.

**Git:** no commit, push, merge, rebase, reset, or branch change performed.
The canonical audit file is the working record; no duplicate audit/plan
documents were created.

## 13. Independent audit round 2 (iceman-free) and fixes

An independent subagent (`opencode/iceman-free`) audited the round-1 fixes
read-only. It verified B2, M5, M3, M1, M2 (keying/merge), M4 (structure), L4,
and L8 as correct, and found three items:

| ID | Finding | Severity | Fix | Regression test |
|---|---|---|---|---|
| F1 | Late-joining restrictive permissions could be dropped: `params.permissions` was snapshotted once before async model resolution, so a merge after the snapshot but before `session.create` was lost. | Major (security-relevant) | `sessions.ts`: refresh `params.permissions` from shared options at create-dispatch time in `attempt()`. | `sessions-concurrency.test.ts`: barrier at `model.default` (after snapshot, before create); late joiner merges READ_ONLY; asserts create carries restrictions. Guard proven by reverting (permissions undefined). |
| F2 | M4 test only covered `createHandleGuard`, not the spawn integration. | Minor (test gap) | Added a 5th guard test simulating the CreateProcessW-failure path (all 5 handles closed once, no double-close). The guard is the mechanism every spawn failure branch uses. | `spawnHandleCleanup.test.ts` (5 tests). |
| F3 | Boundary guard missed dynamic `import()` and value re-exports. | Nit (test gap) | Extended regex to catch `import("@opencode/client")` and `export ... from "@opencode/client"`. | `permissionPolicy.test.ts` (17 tests). |

Round-2 verification: typecheck/lint/format exit 0; focused tests 42 pass, 0 fail.

### Round-2 independent audit verdict: CLEAN

The second `opencode/iceman-free` audit verified F1/F2/F3 as correct and
re-audited the full scoped OpenCode subsystem. Verdict: **CLEAN — no real
defects confirmed.** All 7 focused files / 42 tests pass. Residual items are
non-defect coverage/portability notes (F2 guard-contract vs. kernel-injected
end-to-end; Windows-specific native paths). Suitable as the final gate for push
from a code-correctness perspective.

### Final pre-push verification (2026-11-19)

`bun run verify` → **exit 0**: typecheck/lint/format/test:locations/build all
green; `bun run test` 5992 pass, 0 fail (6080 tests, 464 files); shutdown 1
pass, startup-rollback 2 pass, lifecycle-integration 3 pass, DOM 813 pass,
quarantine OK. Focused tests 42 pass, 0 fail. `git diff --check` exit 0.

Pushed after both independent audits came clean.

---

## 14. Remaining-findings closure pass (2026-11-19)

This section records the closure work for B1, L9, and DOC1–DOC8. Starting state:
branch `review/managed-opencode-hardening-2026-11-15`, HEAD/remote tip
`15bf5f84526566c9ebd29c525f8f7819fc3c8e24`, 0/0 divergence. Three unrelated
working-tree entries (`docs/ui-foundation/self-audit-and-plan.md`,
`docs/ui-foundation/canonical-ui-coherence-plan.md`, `verify-output.txt`) were
preserved untouched. No commit/push/merge/rebase/reset/branch change was made.

### 14.1 B1 — managed-restart recovery E2E

**UI flake fixed.** `tests/e2e/opencode/opencode-managed-restart-recovery.spec.ts`
filled the composer and clicked "Send message" without waiting for the button to
be enabled. In several runs the button was disabled (session not yet ready), the
text was dropped, and no prompt POST was issued — one of three distinct failure
modes observed (navigation assertion, transcript timeout, prompt-response
timeout). Smallest justified change: wait for the composer to be visible, the
Send button to be enabled, and the composer to hold the prompt before clicking.
No acceptance assertion, timeout budget, or transcript-persistence check was
weakened. The documented SHA-256 pin in
`docs/2026-11-16-opencode-durable-recovery-plan.md:756` was updated from
`4358F6FD…CBB6F` to `48DA59A4…04FFF1` (UI fix) and finally to
`5ED8ACE1…532FC` (settled-transcript fix), each with an explanatory note.

**Root cause — confirmed, and NOT in OpenCode or TBAi product code.** The
failure was in the **external test runner**
(`D:\Coding\OpenCode\user\tmp\opencode\run-restart-recovery-e2e.ts`). That runner
hosts the stub model provider as an in-process `Bun.serve` instance, but drove
Playwright with **`spawnSync`** (line 136). `spawnSync` blocks the runner's Bun
event loop for the entire test, so the stub could never accept or answer
OpenCode's model request. This explains every observed symptom exactly:

- OpenCode admitted the prompt (`msg_pending_*`), published
  `session.inbox.enqueued` → `session.execution.started` →
  `session.instructions.updated` → `session.inbox.delivered`, and reached
  `llm.stream.before` (captured via the `TBAI_OPENCODE_DIAG_LOG` stage hook in the
  2.2.6 diagnostic build) — then stalled with **no `llm.stream.start`** for the
  full 120 s test timeout.
- The stub received **0** requests during the test. An instrumented stub that
  logs at the top of its `fetch` handler showed the `POST /v1/chat/completions`
  arriving only at cleanup — the moment `spawnSync` returned and the event loop
  was free again. A TCP monitor confirmed no connection to the stub port during
  the run.
- The working minimal control (OpenCode + stub driven directly, no `spawnSync`)
  always produced `stub requests 2–3` and a persisted assistant message. Every
  suspected differentiator was tested in isolation and did **not** reproduce the
  failure: binary pin 2.2.6, `plugin: []`, `msg_pending_*` id, directory header,
  project-disable env vars, model switch, SSE consumer, exact body, headers,
  `OPENCODE_CONFIG` file, and the Windows job-object spawn. The one difference
  that mattered was the blocking child spawn in the same process as the stub.

**Correction.** Added a durable in-repo runner
`scripts/run-managed-restart-e2e.ts` (`bun run test:e2e:managed-restart`) that:
starts the stub in-process, generates an isolated config/temp/evidence root,
launches TBAi against the pinned 2.2.6 binary, and drives Playwright with an
**async `spawn`** (`runChildAsync`) so the event loop stays free. It fails closed
if Playwright passes but the stub received no model request. The external runner
was likewise switched to async spawn for local reproduction.

**Test determinism.** The spec also had a real race: it snapshotted the
"before" transcript as soon as streamed text appeared, before the assistant
message settled (`finish`/`completed`/`tokens`) and before the `idle` marker was
published. The "after" snapshot was settled, so `comparison.equal` failed
intermittently (observed 1 in 4 runs). `waitForDistinctAssistantResponse` now
requires the settled state (`assistantResponseSettled` + `idlePresent`) — this
**strengthens** the assertion (the response must be fully persisted before
restart) and removes the race. No acceptance assertion, timeout budget, or
transcript-persistence check was weakened; the SHA-256 pin was updated to
`5ED8ACE1…532FC` with rationale.

**Regression test.** `tests/unit/tooling/managed-restart-runner.test.ts` starts
a real in-process stub and calls it through `runChildAsync`; it fails when the
helper is reverted to blocking `spawnSync` (proven by temporary revert) and
passes with the async fix.

**Repeated E2E results.** `bun run test:e2e:managed-restart` (pinned 2.2.6):
**8/8 runs passed** (`1 passed`, exit 0, `stub requests 2` each). Both restart
scenarios in the recovery plan are exercised by the spec: the assistant response
is persisted before restart, the managed child is killed and restarted, and the
settled transcript is identical after restart with the conversation still usable.

**CI.** Added a required step to the Windows `e2e` job in
`.github/workflows/tests.yml` that runs `bun run test:e2e:managed-restart` using
the pinned CLI installed by `install-opencode` (on PATH, integrity-verified),
with evidence uploaded via `actions/upload-artifact`. The job fails if the test
fails or the stub is never called.

### 14.2 L9 — frontend attempt-liveness race

**Reproduced deterministically.** `tests/unit/web/opencode/v2ThreadController.liveness.test.ts`
starts `refresh()` under generation 1, pauses it at `sessionGet`, fails gen-1's
event stream to trigger a takeover to generation 2, then resolves gen-1's read
with a distinguishable session title. Before the fix the stale title
`STALE-GEN1` was committed onto the live attempt (`Expected: not "STALE-GEN1"`).

**Fixed.** `web/src/features/opencode/v2ThreadController.ts`: `refresh()` and
`reconcileStagedRevert()` now capture `currentAttempt` and the generation once
at entry, use that captured generation for all operations, and check
`isLive(live)` after each await before dispatching/committing — matching the
guarded `hydrate()` path. This is the smallest consistent liveness guard; no
redundant checks were added elsewhere. The guard was proven to fail by removing
the `isLive` check in `refresh()` (test failed with `Expected: not "STALE-GEN1"`)
and restoring it (test passed). Final: 1 pass, 0 fail.

### 14.3 DOC1–DOC8 — documentation corrections

Each finding was verified against actual code/tests/scripts/manifests/GitHub
state before editing; historical meaning was preserved with current-status notes
rather than rewritten.

- **DOC1** `docs/2026-11-10-opencode-recovery-improvement-plan.md`: replaced stale
  "GitHub publication pending" with the actual pushed commit chain and pointer to
  the canonical audit; added a reading note that §14 reconciliation entries retain
  historical paths (e.g. the deleted `tests/unit/opencode/recovery.test.ts`).
- **DOC2** `docs/2026-11-16-opencode-durable-recovery-plan.md`: distinguished the
  original implementation commit chain (`2ef39c5`…`9502943`) from subsequent
  hardening (`3b32598`…`15bf5f8`); updated the B1 spec SHA-256 pin with rationale.
- **DOC3** `docs/engineering-quality.md`: 50 → 53 E2E specs (46 non-live + 7 live),
  bare-`bun test` total 422 → 425; "seven required suites" → ten (with the 38 s
  figure marked historical).
- **DOC4** `.github/workflows/tests.yml`: "required seven" → "required suites (ten
  at this revision)".
- **DOC5** `docs/opencode-context.md`: current branch tip `15bf5f8`, `80813d8`/
  "uncommitted" notes marked as point-in-time history, pointer to canonical audit.
- **DOC6** `docs/opencode-runtime-audit-final.md`: RT-004 recorded as **closed by
  explicit owner scope decision** (no health supervisor / liveness probe will be
  introduced; accepted behavior is silent stall until manual reconnect), both in
  the header note and the finding register row. No health-monitoring code added.
- **DOC7** `docs/2026-11-01-opencode-session-import-plan.md` and `.revised.md`:
  "awaiting authorization/confirmation" marked as original status; implementation
  confirmed landed in `d560b26` (`src/services/opencode/import.ts`, route, DB
  schema) with pointer to `docs/opencode-session-import.md`.
- **DOC8** historical plans (`2026-10-20`, `2026-10-23`, `2026-10-29` hybrid,
  `2026-10-31` unified-scheduler, both `2026-11-01` import plans): added a small,
  consistent 2.2.6 supersession banner; older 2.0/2.1/2.2.0 claims left intact and
  labeled historical. No mass rewrite of archival technical content.

### 14.4 Verification commands and results (2026-11-19)

| Command | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun test --isolate tests/unit/web/opencode/v2ThreadController.liveness.test.ts` | 1 pass, 0 fail |
| `bun run test:opencode-runtime` | exit 0 — 10/10 required suites passed (54 pass, 0 fail, 0 skip total) |
| `bun run verify` (full chain) | **exit 0** — all gates green |
| — typecheck / lint / format:check / test:locations / build | all exit 0 |
| — `bun run test` (within verify) | 5994 pass, 0 fail |
| — `test:shutdown` | 1 pass, 0 fail |
| — `test:startup-rollback` | 2 pass, 0 fail |
| — `test:lifecycle-integration` | 3 pass, 0 fail |
| — `test:dom` | 813 pass, 0 fail |
| — `test:quarantine` | OK — no stale entries |
| `git diff --check` | exit 0 |
| `bun test --isolate tests/unit/tooling/managed-restart-runner.test.ts` | 1 pass, 0 fail (fails when reverted to blocking spawn) |
| `bun run test:e2e:managed-restart` (pinned 2.2.6) | exit 0 — 1 passed, stub requests 2; **8/8 repeated runs passed** |

The full `bun run verify` chain was re-run after all changes and completed with
exit 0. No gate was weakened or skipped.

**GitHub CI (verified):** commit `d4e7103` pushed; Actions run `44521502042`
(head `d4e7103`, `workflow_dispatch`) → **success**. All five active jobs passed;
`e2e-full`/`e2e-big-pickle` skipped by default-false inputs. The dedicated
managed-restart step passed (`1 passed`, `stub requests 2`) on the pinned 2.2.6
CLI; evidence artifact uploaded; regression test passed in `verify`.

### 14.5 Final remaining-risk assessment

- **B1/G — fixed.** Root cause was the external runner's blocking `spawnSync`,
  not OpenCode or TBAi product code. In-repo async runner + deterministic test +
  regression guard + CI gate; 8/8 repeated E2E runs pass. No acceptance criteria
  weakened, no skip/quarantine.
- **CI — verified.** Actions run `44521502042` on commit `d4e7103` → success;
  all five active jobs passed including the dedicated managed-restart E2E
  (`stub requests 2`) and the regression test. No remaining blockers.
- L9 and DOC1–DOC8 are closed. All other findings from §10/§11 remain as recorded
  (fixed or not-a-defect). All local and CI quality gates pass.

---

## 15. Interrupted-turn recovery scenarios (2026-11-19)

The completed-transcript B1 test (§14.1) proved a finished turn survives a
managed-child restart. It did NOT prove an unfinished turn is continued. This
section records closing that gap with two real E2E scenarios through the ONE
shared backend recovery service (`src/services/opencode/recovery.ts`).

### 15.1 Genuine production defect found and fixed

**Symptom.** With a genuinely unfinished turn (user projected, `time.busy` set,
no assistant, no idle marker), the recovery service classified the state as
`resubmit-user` and re-posted the original user id via `session.prompt`. OpenCode
2.2.6 returned HTTP 200 (`outcome=recovered`) but produced NO assistant response:
the stub received no new model request, and the session gained an `idle` marker
with `outcome=succeeded` — an empty drain marked the turn complete.

**Root cause (verified by a standalone experiment against the pinned 2.2.6
binary).** Re-posting an ALREADY-PROJECTED user id reconciles to the existing
message (`inbox.ts:184-189` `promotedFromMessage`) but creates NO new inbox item.
`execution.wake` starts a drain, `nextPromotable` finds nothing, and the drain
settles as `Execution.Succeeded` — no model call. A PENDING user id still works
because its inbox row is delivered on wake. The plan's §5/§8 claim that same-id
re-post "works whether pending or projected" is incorrect for 2.2.6.

**Fix (smallest, shared path).** The classifier keeps the `resubmit-user` action
(plan semantics) but marks already-projected users with `projected: true`
(`recoveryClassifier.ts`). For a projected user with a shutdown-interruption
signal (`busy` present, `idle` absent — the demonstrated unfinished-turn state),
`performAction` (`recovery.ts`) now posts a FRESH recovery synthetic
(`session.synthetic`, new stable id, `notice: opencode-restart`, `steer`,
`resume: true`) instead of re-posting the user id. The synthetic creates a
promotable steer item that continues the turn in the same session without
duplicating the user message. Pending users are still re-posted by id. The
user → completed-compaction → no-assistant window (§6.A.9) is unchanged.

**Regression tests.** `tests/unit/opencode/recoveryClassifier.test.ts` asserts
the `projected` marker; `tests/integration/opencode/recoveryService.test.ts`
asserts a projected+shutdown-interruption user produces a `synthetic` call and
NO `prompt` call, while a pending user produces `prompt` and NO `synthetic`.
Both pass (28/28 classifier, 34/34 recovery service).

### 15.2 Scenario A — orderly shutdown interruption

`tests/e2e/opencode/opencode-recovery-shutdown.spec.ts` + runner scenario
`orderly-shutdown`. The stub holds the first main-turn request (title requests
are excluded), so the turn is genuinely unfinished. The spec drives the REAL
production shutdown entry point through the runner's file-based control
protocol (runner writes `{"type":"shutdown"}` to TBAi stdin), then relaunches
TBAi with the same durable data. It asserts: original conversation/session ids
preserved, original user message present exactly once, no assistant/idle before
interruption, a distinct assistant response persisted in the ORIGINAL session
after recovery, and the conversation usable after restart. **3/3 runs passed**
(`1 passed`, `stub requests 3` each).

### 15.3 Scenario B — abrupt managed-child crash

`tests/e2e/opencode/opencode-recovery-crash.spec.ts` + runner scenario
`abrupt-crash`. After a real execution-start boundary with an unfinished turn,
the spec verifies the managed child's PID/creation identity and kills ONLY that
child. The real manager restarts it, a new managed target is published, and the
shared recovery service continues the turn. It asserts: original session reused,
no duplicate logical user message, provider receives a recovery request, a
distinct assistant response persisted in the original session, final transcript
correct, and no stale registration/duplicate child. **3/3 runs passed**
(`1 passed`, `stub requests 3` each).

### 15.4 Infrastructure and CI

- `scripts/run-managed-restart-e2e.ts` extended with scenario selection
  (`TBAI_RECOVERY_SCENARIO`), a `holdFirstRequest` stub option, and a non-blocking
  control-file protocol for shutdown/start. The async-spawn B1 fix is preserved.
- `tests/harness/opencodeStubProvider.ts` gained `holdFirstRequest`/`release()`
  (deferred barrier; title/summary requests excluded so the MAIN turn is held).
- Windows `e2e` CI job now runs all three scenarios explicitly with the pinned
  integrity-verified 2.2.6 CLI; evidence uploaded per scenario.
- Full local verification: `bun run verify` exit 0 (5996 pass / 0 fail),
  `bun run test:opencode-runtime` 10/10, `git diff --check` exit 0.

**Independent read-only review (§12).** A focused review challenged both scenarios
and found five items; all were addressed before completion:
1. The runner now asserts a stub request carrying the recovery-synthetic prompt
   (`"The server restarted while you were working"`) and raises the interruption
   floor to 3 requests — proving the SHARED recovery service (not an OpenCode
   internal auto-resume) drove continuation. Both scenarios log
   `recovery synthetic reached stub at request 3`.
2. Replaced `require()` in the ESM test helper with proper `node:fs`/`node:path`
   imports so `session-poll.json` evidence is actually written (verified present).
3. The crash scenario now verifies the NEW child's creation identity (not just a
   different live PID), preventing PID-reuse false positives.
4. Both specs assert exactly one distinct assistant response (no duplicate).
5. Pagination shape (`body.cursor.next`) was confirmed against a real response.

**Remaining limitations:**
- The fix is scoped to projected users with a shutdown-interruption signal (the
  demonstrated unfinished-turn state). Other projected-user states (e.g. no busy
  signal) retain the plan's re-post behavior; no defect was demonstrated there.
- The `cancel-and-resubmit-user` path (pending synthetic + projected user) still
  re-posts the projected user by id; the same 2.2.6 no-inbox-work behavior could
  apply there. Not exercised by the two required scenarios; recorded for a
  future focused test rather than changed speculatively.
- CI execution of the new commit is pending push and inspection.
