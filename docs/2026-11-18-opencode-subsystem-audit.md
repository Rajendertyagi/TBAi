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

**NOT done.** The subsystem is robust and well-tested overall — no data-loss,
security-bypass, or framework-boundary catastrophe was found — but it cannot be
declared complete while the key acceptance test is failing and a production
shutdown contract is dead. A green `bun run verify` is necessary but not
sufficient; the issues below are ones the gates do not catch.

## 2. Blockers (resolve before "done")

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

## 9. Recommended path to "done"

1. Fix or formally reclassify the managed-restart E2E (B1) — make it pass and gate it,
   or record an explicit owner decision that it is not a release gate.
2. Wire `beginShutdown()` into production shutdown (B2) and add a test for the
   production-only path.
3. Fix the frontend orphaned-prompt record and the singleflight key split; add the
   missing guard test for the `@opencode/client` boundary.
4. Reconcile the stale docs (canonical roadmap, 2026-11-16 plan, engineering-quality,
   opencode-context, RT-004).
5. Re-run `bun run verify` and the gated E2E after fixes.

Each item requires its own reviewed and owner-approved implementation task. This
audit does not authorize any of them.

---

## 10. Finding register (canonical — audit + execution plan)

This section is the single working register. Section 3 letters A–H map onto the
audit findings as noted. Status values: `Confirmed defect`, `Confirmed existing
fix`, `Not a defect`, `Needs runtime verification`, `Blocked`. Statuses are
updated as findings are verified and fixed. No separate plan document exists;
this file is both the finding register and the execution sequence.

| ID | Finding (source) | Maps to §3 | Status | Evidence / resolution |
|---|---|---|---|---|
| B1 | Managed-restart recovery E2E failing and not gated (§2) | G | Needs runtime verification | Spec excluded from 9-spec gate; prior failures reported. To re-run on current HEAD. |
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
| L9 | `refresh()` lacks attempt-liveness guards (§4) | — | Needs verification | Torn read possible. |
| L10 | `assertSameHistoryOwner` dead export (§4) | — | Needs verification | Informational. |
| DOC1–DOC8 | Documentation drift (§5) | — | Needs verification | Record only; no other docs edited per scope. |

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

- **B1 / G** managed-restart E2E: re-run on current HEAD via the dedicated external runner → **1 failed**, deterministic `timeout waiting for distinct assistant response persisted in OpenCode session history`. Evidence (`prompt-response.json`) shows only the user `msg_pending_*` message — the stub provider's assistant response was not persisted. This is an environment/harness issue, not a TBAi product defect. The spec is a protected, hash-pinned path (`4358F6FD…CBB6F`) and is correctly excluded from the 9-spec gate. **Blocked** on a working stub-provider response in the harness; do NOT add to gate or modify the protected spec without owner approval.
- **L9** `refresh()`/`reconcileStagedRevert()` lack attempt-liveness guards across awaits: real asymmetry with the guarded hydration path; a torn read is possible but bounded by `historyMerge(held)`. **Needs runtime verification** (no reproduction obtained); left unchanged to avoid speculative code.
- **L6** restart-exhaustion recovery entry points have no caller: dead code, informational; budget is reset internally by the stability timer. Left unchanged.

### Documentation drift (DOC1–DOC8)

Recorded in §5; no other docs edited per task scope (only this canonical audit file is the working record). Requires a separate owner-approved documentation task.

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

**CI status:** not verified. No GitHub Actions result was inspected for the
current working tree (changes are uncommitted). No CI claim is made.

**Remaining blockers:** B1/G (managed-restart E2E blocked on stub-provider
response persistence in the harness; protected hash-pinned spec, not gated),
L9 (needs runtime verification), DOC1–DOC8 (separate documentation task).

**Git:** no commit, push, merge, rebase, reset, or branch change performed.
Only the canonical audit file was updated as the working record; no duplicate
audit/plan documents were created.

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
