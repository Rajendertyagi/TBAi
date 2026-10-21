# OpenCode Subsystem — Context and Handoff

**Last updated:** 2026-10-19
**Repository:** `D:\Temp\ai-chat-app` (TBAi)
**Branch:** `ci/tauri-e2e-verify`
**HEAD:** `b1c48a483b2455687d8de9735068d296ebc96d8d`

> Read this file before asking for project context. Update it after meaningful investigations, decisions, approved implementation stages, and test runs. Do not duplicate `AGENTS.md` — point to it.

---

## 1. Project purpose and architecture

TBAi is a small, provider-agnostic AI chat app (React 19 + Vite + TS + Tailwind v4 frontend, Hono + Bun backend, SQLite persistence). See `AGENTS.md` for the full architecture, ownership rules, and engineering standards.

The OpenCode subsystem is an **isolated feature** (`src/services/opencode/` backend, `web/src/features/opencode/` frontend) that wraps the managed `opencode serve` process and the official `@opencode/client` V2 client. It provides a "Code" mode (agent) alongside Direct Chat, with session lifecycle, tool execution, permissions, forms, and streaming. The isolation boundary is documented in `AGENTS.md` under "OpenCode isolation boundary."

---

## 2. Audit baseline

- **Branch:** `ci/tauri-e2e-verify`
- **HEAD:** `b1c48a483b2455687d8de9735068d296ebc96d8d`
- **Working tree:** Clean (as of 2026-10-19)
- **Verification:** `bun run verify` exit 0 (4309 pass / 43 skip / 0 fail, 319 files, 4352 tests, 333.04s); `bun run typecheck` exit 0; lint + format:check clean.
- **OpenCode CLI version:** 2.0.32 (supported range: 2.0.15–2.1.0)
- **Client:** `@opencode/client` (official V2 client)
- **GitHub Actions:** Run 39160063675 completed with success (all 3 jobs: verify, e2e, tauri).

### Audit history
- **Round 1 (2026-10-18):** Full deep audit of the OpenCode subsystem. Verdict: conditionally acceptable. 10 findings (1 High, 3 Medium, 6 Low).
- **Round 2 (2026-10-19):** Group 1 remediation design (A1 binary resolution, F1 bounded reconnection). Read-only. No implementation.
- **Round 3 (2026-10-19):** Finalized remediation design with Paseo/OpenChamber insights. Created this handoff file.
- **Round 4 (2026-10-19):** Simplified A1/F1 design. Resolved retry-reset semantics and Windows launcher handling.
- **Round 5 (2026-10-19):** Resolved final design questions. Updated with reference-app findings.
- **Round 6 (2026-10-19):** Finalized A1/F1 plan. Corrected acceptance-test counts, error classification, and backoff formula.

---

## 3. Audit findings

### Confirmed defects

| # | Area | Issue | Severity | Evidence |
|---|------|-------|----------|----------|
| A1 | Binary resolution | `resolveManagedBinary` only checks `Bun.which`. No fallback paths. App fails when binary isn't on PATH. | **High** | `runtime.ts:resolveManagedBinary` — only env var + `Bun.which`. User hit this error. |
| F1 | Synchronization | No max reconnect attempt limit. Permanently unreachable server spins at 10s intervals forever. | Medium | `v2ThreadController.ts:scheduleReconnect` — no max attempt check. |
| B1 | Session lifecycle | `invalidateBootstrap` is a no-op. Deleted conversation mid-bootstrap leaves stale session. | Medium | `sessionBootstrap.ts:invalidateBootstrap` — "Conservative by contract" comment, does nothing. |

### Unverified risks

| # | Area | Issue | Severity | Evidence |
|---|------|-------|----------|----------|
| A2 | Process lifecycle | `onExit` restart race during shutdown. | Low | `serverManager.ts:onExit` checks `this.stopping` but race window exists. |
| F2 | Synchronization | Event buffer capped at 512. Overflow drops assistant message events. | Medium | `v2ThreadController.ts:445` — `eventBuffer.length > 512` filter. |
| F3 | History loading | Convergence pass cap at 4. Incomplete history if not converged. | Low | `config.ts:OPENCODE_V2_HISTORY_CONVERGENCE_PASS_CAP = 4` |
| F4 | Event handling | Event deduplication uses 256-event window. Could fail with >256 events. | Low | `config.ts:OPENCODE_V2_RECENT_EVENT_ID_WINDOW = 256` |
| H5 | Shutdown | `onExit` restart race during shutdown. | Low | `serverManager.ts:onExit` |

### Intentional design decisions

| # | Area | Decision | Rationale |
|---|------|----------|-----------|
| E1 | Tool execution | Tool list is manually maintained (`v2Tools.ts`). | OpenCode has no tool catalogue endpoint. Drift guard catches stale names. |
| D3 | Workspace | No path traversal/symlink checks in TBAi. | Relies on OpenCode's own enforcement. |
| B5 | Session lifecycle | `assignSessionModelIfMissing` swallows errors. | Session returned without model is better than no session. |
| G2 | Frontend boundary | `Composer.tsx` and `StatusBar.tsx` import OpenCode feature components directly. | UI composition, not runtime dependency. |

---

## 4. Remediation design

### A1 — OpenCode binary resolution (simplified)

**Root cause:** `resolveManagedBinary` in `src/services/opencode/runtime.ts` only checks `Bun.which("opencode")`. No fallback paths. App fails when binary isn't on PATH.

**Resolution contract (minimal, portable):**

1. If `OPENCODE_BINARY` is explicitly configured, resolve and validate that command. If it is invalid or unsupported, fail clearly; do not silently fall back.
2. Otherwise, resolve `opencode` through the current process `PATH`, using Bun's built-in lookup (`Bun.which`). Avoid scanning hardcoded installation directories or detecting individual package managers.
3. Validate the resolved command with a bounded version probe (`--version`, 2s timeout) and the existing supported-version rules (2.0.15–2.1.0).
4. Use the same launch semantics for probing and starting the managed process.
5. Handle a resolved Windows `.cmd` launcher through a safe, tested Windows-specific launch mechanism (`cmd /c`). Do not search guessed npm package-internal executable paths.
6. If no valid command is found, return an actionable error explaining installation, PATH, and `OPENCODE_BINARY` options.

**Windows `.cmd` handling (verified):**
- `Bun.spawn(['cmd', '/c', pathWithSpaces])` correctly preserves argument boundaries (tested with paths containing spaces — exit 0, correct output).
- `cmd /c` with a quoted path works for both `spawn` and `spawnSync`.
- User-controlled input cannot become unintended shell syntax because the path is passed as a single array element (Bun handles quoting).
- **Verified behavior:** `cmd /c` with spaced paths works (tested 2026-10-19).
- **Documented behavior:** Bun.spawn passes array elements as separate argv entries.
- **Proposed (untested):** The actual `createChild` and `detectOpenCodeVersion` modifications using `cmd /c` wrapper. The mechanism is verified; the integration is not yet tested.

**Candidate ordering:** env var (exclusive) → PATH lookup → version probe → error. No fallback directory scanning.

**Security:** Only PATH and env var. No directory traversal or globbing. Validate file exists and is executable. Log selected path (non-secret).

**Error classification (existing, no new classes needed):**
- No executable resolved → `OpenCodeBinaryMissingError` (thrown by `resolveManagedBinary` when `Bun.which` returns null and no env var is set).
- Executable resolved but unsupported version → `UnsupportedOpenCodeVersionError` (thrown by `detectOpenCodeVersion` when version is outside range).
- Executable resolved but cannot be launched or probed → `OpenCodeBinaryMissingError` is NOT appropriate. The existing `detectOpenCodeVersion` throws a plain `Error` ("OpenCode binary did not report a valid version" or "OpenCode binary could not be started") when `Bun.spawnSync` fails or produces no parseable version. This is a startup/probe failure, not a missing binary. No new error class needed — the existing plain `Error` is sufficient and is caught by `toOpenCodeError` as "unknown" kind.

**Reuse version-probe results:** Probe once per candidate during resolution. Pass the already-probed version to `detectOpenCodeVersion` to avoid duplicate probes.

**Bounded startup-probe time:** Per-candidate timeout 2s. Total budget: 10s.

**Acceptance tests (6):**
1. env var set → uses env var (no PATH query).
2. env var set but invalid → throws (no fallback).
3. PATH has binary → uses PATH.
4. no PATH → throws `OpenCodeBinaryMissingError` with actionable message.
5. binary found but wrong version → throws `UnsupportedOpenCodeVersionError`.
6. `.cmd` wrapper → probe and spawn use `cmd /c` wrapper.

### F1 — Bounded frontend reconnection

**Root cause:** `scheduleReconnect` in `v2ThreadController.ts` has no max attempt limit. Permanently unreachable server spins at 10s intervals forever.

**Design:**
- **Retry limit:** 10 reconnect retries after the initial connection attempt fails. Justification: exponential backoff capped at 10s → ~55.75s cumulative waiting time. Long enough for transient issues, short enough to surface terminal error within ~1 minute. Matches `OPENCODE_INIT_TIMEOUT_MS` (15s) philosophy.
- **Terminal state:** When retries exhausted → dispatch `{ type: "connection_changed", connection: { type: "failed", attempt: reconnectAttempt } }` + `{ type: "load_failed", error: { kind: "connection", message: "..." } }`. Set `reconnectTimer = null`, set `connectionFailed = true`.
- **Manual retry:** The existing "Reconnect" button in `OpenCodeStatus.tsx` (wired via `onReconnect` prop to `reconnect` in `useOpenCodeRuntime`) already serves as the manual retry. It creates a new client + controller (full reconnect). No new `retryConnection()` method needed on the controller — the existing reconnect flow handles recovery from the failed state. The `connectionFailed` flag is cleared when a new controller is created.
- **Reset rules:** `reconnectAttempt = 0` on successful hydration, manual retry, dispose. NOT reset on generation change (retry budget is per-controller).
- **Duplicate timer prevention:** `scheduleReconnect` checks `reconnectTimer !== null`. `dispose()` clears timer. (No `retryConnection` method — reuse existing `reconnect` flow.)
- **Stale callback prevention:** `startConnection` checks `disposed` and `generation === currentGeneration`. Reconnect timer callback checks `disposed`.

**Backoff formula (verified from source):**
- `delay = min(OPENCODE_V2_MAX_RECONNECT_DELAY_MS, OPENCODE_V2_INITIAL_RECONNECT_DELAY_MS * 2 ** reconnectAttempt)`
- `OPENCODE_V2_INITIAL_RECONNECT_DELAY_MS = 250`
- `OPENCODE_V2_MAX_RECONNECT_DELAY_MS = 10_000`
- `reconnectAttempt` starts at 0, increments after each failure.

**Attempt-count semantics:**
- 1 initial connection attempt + 10 reconnect retries = 11 total connection attempts maximum.
- The initial attempt has no delay. Each of the 10 retries has a delay computed by the backoff formula.
- Delays: 250 + 500 + 1000 + 2000 + 4000 + 8000 + 10000 + 10000 + 10000 + 10000 = 55,750ms ≈ 55.75s cumulative *waiting* time.
- This is the time spent *waiting* between retries. Additional time is spent on each connection attempt (network round-trip, server response). Total time from first failure to terminal state = 55.75s + connection attempt durations.
- The 10th retry's delay is 10s (capped). After the 10th retry fails, no more retries. Terminal state is entered.
- Acceptance test must verify: 1 initial attempt + at most 10 reconnect retries + no 11th retry.

**Retry-reset semantics (resolved):**
- `generation` represents the current active event stream connection (set at line 740 after `client.connect()` succeeds, nulled at line 479 in `scheduleReconnect` and line 1180 in `dispose`).
- A new conversation creates a new controller (`createV2ThreadController`), so `reconnectAttempt` starts at 0. The retry budget is per-controller, not per-generation.
- `reconnectAttempt` is reset to 0 only on successful hydration (line 747) and manual retry. It is NOT reset on generation change alone (a failed reconnect should count as a retry).
- Stale generation callbacks cannot reset the counter because they are no-ops (the `generation === currentGeneration` check prevents them from reaching the reset code).
- Disposal clears the timer and sets `disposed = true`, preventing further resets.

**UI file scope:**
- `v2ThreadController.ts` — add `connectionFailed` flag, max attempt check in `scheduleReconnect`, terminal state dispatch.
- `v2Types.ts` — add `connection: { type: "failed", attempt: number }` to `V2ConnectionState`.
- `config.ts` — add `OPENCODE_V2_MAX_RECONNECT_ATTEMPTS = 10`.
- `OpenCodeStatus.tsx` — already has "Reconnect" button wired via `onReconnect`. May need label change from "Reconnect" to "Retry" on failed state. Minimal change.

**Acceptance tests:**
- Unit: exhaustion - 1 initial attempt + 10 reconnect retries -> terminal state, no 11th retry.
- Unit: recovery — failure then success → counter reset, connected state.
- Unit: manual retry — terminal state → reconnect (new controller) → attempts reconnection.
- Unit: disposal — dispose during reconnect → no further attempts.
- Unit: stale generation — old generation's reconnect doesn't fire.
- Unit: no duplicate timers — overlapping scheduleReconnect calls → one timer.
- Unit: counter reset on success and dispose.
- Unit: no reset on generation change.

---

## 5. Persistent project handoff

**File:** `docs/opencode-context.md` (this file).

**No existing suitable handoff file found.** The existing `docs/pm-opencode-frontend-audit.md` and `docs/pm-opencode-store-audit.md` are point-in-time audit reports, not living context documents.

---

## 6. Approval state

**Implementation not approved.** This document proposes designs and acceptance criteria. No code changes have been made. Awaiting explicit approval before implementation.

---

## 7. Change log

| Date | Action | Details |
|------|--------|---------|
| 2026-10-18 | Full deep audit | 10 findings (1 High, 3 Medium, 6 Low). Verdict: conditionally acceptable. |
| 2026-10-19 | Group 1 remediation design (Round 2) | A1 + F1 designs proposed. Read-only. |
| 2026-10-19 | Group 1 remediation design (Round 3) | Finalized designs with Paseo/OpenChamber insights. Created this handoff file. |
| 2026-10-19 | OpenCode context file created | `docs/opencode-context.md` — persistent handoff. |
| 2026-10-19 | Simplified A1/F1 design | Replaced over-engineered binary discovery with portable contract. Updated F1 with minimal scope. |
| 2026-10-19 | Round 4: Finalized design | Resolved retry-reset semantics and Windows launcher handling. Verified `cmd /c` with spaced paths. |
| 2026-10-19 | Round 5: Resolved final design questions | Retry-reset semantics resolved. Windows `cmd /c` verified with spaced paths. Decisions finalized. |
| 2026-10-19 | Round 6: Reference-app findings | Updated with Paseo/OpenChamber comparison. Selected minimal patterns, rejected over-engineering. |
| 2026-10-19 | Round 7: Finalized A1/F1 plan | Corrected acceptance-test counts, error classification, backoff formula. Verified `cmd /c` with spaced paths. |
| 2026-10-19 | Round 9: Final documentation consistency fix | Corrected A1 error classification (probe failure is not missing). Corrected F1 UI wording (reuse existing Reconnect button, no new retry API). Verified handoff file updated. |

---

## 8. Next action

Await explicit approval to implement Group 1 fixes (A1 + F1). Upon approval:
1. Implement A1 (binary resolution) in `src/services/opencode/runtime.ts` + `serverManager.ts`.
2. Implement F1 (bounded reconnection) in `web/src/features/opencode/v2ThreadController.ts` + `config.ts` + `v2Types.ts`. (No new `retryConnection()` method — reuse existing `reconnect` flow.)
3. Add unit tests for both.
4. Run `bun run verify` and `bun run typecheck`.
5. Commit and push to `ci/tauri-e2e-verify`.
6. Update this handoff file with results.