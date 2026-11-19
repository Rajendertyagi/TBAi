# OpenCode Subsystem — Context and Handoff

**Last updated:** 2026-11-19\
**Repository:** `D:\Temp\ai-chat-app` (TBAi)  
**Branch:** `review/managed-opencode-hardening-2026-11-15`  
**Current branch tip:** `15bf5f84526566c9ebd29c525f8f7819fc3c8e24` (pushed; in sync with origin). The `80813d8` HEAD and "uncommitted" notes in §§8–10 below are point-in-time records of the 2026-11-15 verification passes, not current state.\
**Base:** `develop` / `origin/develop` `4fec0072696cc3a01891f62fdfc1c16330058ce5`  
**`main` / `origin/main`:** `7407d49ccdd4bd4c3c70d72eeef472593c81e8b6` (untouched)\
**Current status:** see `docs/2026-11-18-opencode-subsystem-audit.md` (canonical finding register and final verification).

> Read this file before asking for project context. Update it after meaningful investigations, decisions, approved implementation stages, and test runs. Do not duplicate `AGENTS.md` — point to it.

---

## 1. Purpose and boundaries

TBAi is a small, provider-agnostic AI chat app. See `AGENTS.md` for architecture, ownership, and engineering standards.

The OpenCode subsystem is an **isolated feature**:
- Backend: `src/services/opencode/` owns the managed `opencode serve` process, session lifecycle, import, config/capability access, proxy/authz, and runtime state. The rest of the backend never imports the OpenCode client.
- Frontend: `web/src/features/opencode/` owns the native V2 client, event reduction, history, permissions/forms, cancellation, and external-store controller. Shared chat UI composes through engine-neutral props; OpenCode-only capability stays behind the feature boundary.
- Tool UI: `web/src/tools/opencode/` is the frontend OpenCode tool-UI owner.

OpenCode uses the official `@opencode/client` V2 client (pinned `2.2.6` in this repo). Direct Chat, AI SDK, MCP, and the independent app scheduler remain separate.

---

## 2. Compatibility baseline (2.2.6)

- **CLI:** `opencode v2.2.6` (`D:\Coding\OpenCode\opencode.exe` in this environment).
- **Client package:** `@opencode/client` `2.2.6` (installed; exports include `./service` with `discover/ensure/stop` helpers and generated API/types).
- **Real server contract checks (2026-11-15):** `opencode serve --port 0 --hostname 127.0.0.1` announced a dynamic loopback URL; `GET /doc` returned HTTP 200 (OpenAPI/spec payload captured to `D:\Coding\OpenCode\user\tmp\opencode\oc-2.2.6-doc.json` during audit); unauthenticated `GET /api/info` returned `401 UnauthorizedError` (`Authentication required`), consistent with authenticated readiness probing.
- **Official references:** https://opencode.ai/docs/api, https://opencode.ai/docs/build/client/, https://opencode.ai/docs/migrate-v1, https://opencode.ai/docs/cli/commands/, https://opencode.ai/docs/cli/web, https://opencode.ai/docs/troubleshooting, https://github.com/anomalyco/opencode/releases (v2.2.6).

### Service helper decision (`@opencode/client/service`)

The pinned client exposes `Service.discover/ensure/stop` and probe/decision logic that can reuse/wait/replace registered services. **TBAi does not use these helpers for runtime ownership** because they can discover/attach to a previously registered or independently running service, which violates the managed-only design (TBAi must own exactly one managed runtime and must not adopt external servers). TBAi retains its custom managed process owner (`serverManager`/`connectionState`/`startup`/`runtimeTarget`) and uses owned registration publication/cleanup only for the managed child it controls.

---

## 3. Managed-only runtime

TBAi owns **exactly one managed `opencode serve` runtime**.

- **No external runtime selection:** TBAi does not discover, adopt, attach to, revalidate, or rediscover independently running external OpenCode servers for runtime selection.
- **Obsolete external env vars:** `OPENCODE_URL`, `OPENCODE_HOST`, and `OPENCODE_PORT` are ignored for TBAi runtime selection. When present, startup logs a warning and continues with managed startup; they must not silently redirect runtime selection. Managed child startup must remain bound to the intended loopback/password contract regardless of inherited parent env.
- **Managed registration:** TBAi may publish and clean up its own managed registration/ownership records as needed for the managed runtime it owns. Registration is not used to adopt external services; cleanup must be ownership-safe (never delete another process's registration).
- **Startup/lifecycle:** `src/services/opencode/startup.ts` starts the managed runtime once per process (skips in automated test runs/shutdown/already-installed cases). `src/services/opencode/serverManager.ts` owns managed process start, readiness, cleanup, restart/shutdown behavior, and Windows process ownership/cleanup constraints. `src/services/opencode/connectionState.ts` owns the managed target, request context/transport, shutdown latch, and runtime-target change notifications.
- **Runtime target/status:** Server-wide/runtime surfaces resolve to the installed managed target or start the managed child on demand (`src/services/opencode/runtimeTarget.ts`). Status/events expose managed/unresolved runtime identity without credentials.
- **Readiness/port:** managed startup uses kernel-assigned loopback port strategy as supported by the pinned CLI (`--port 0 --hostname 127.0.0.1`), reads the child's announced listening URL, and confirms readiness through authenticated API behavior; no guessed/race-prone port allocation.

---

## 4. Legacy external-bound conversations (compatibility)

Conversations historically bound to an external/remote OpenCode service remain externally owned and **fail closed** in the managed-only runtime.

- TBAi never reassigns them to local/managed, never rewrites session IDs, never points old external session IDs at the managed DB, and never probes external services.
- History/service access for a remote-bound conversation is refused with:  
  `The original external OpenCode service for this conversation is unavailable. TBAi now supports its managed OpenCode runtime only.`  
  (`OpenCodeHistoryBoundaryError`, refusal `external_unavailable`).
- **HTTP mapping:** route-level unavailable/unresolved history-boundary refusals map to **503 Service Unavailable**; genuine cross-service conflicts and malformed/unreadable ownership records retain conflict/error behavior as appropriate. Route-level regression tests cover external-owned session routes (`/session`, `/session/reconcile-directory`, `/session/terminate`, `/session/activity`) to ensure 503 + message, no managed start, no external/managed probe, and no ownership mutation.
- Ownership migration/canonicalization and existing records/history must be preserved. Persisted historical owner keys/mappings (including legacy `adopted:`/remote/custom profile semantics where required) are not rewritten by managed-only simplification. Orphan reconciliation must not probe or remove legacy external-owned sessions through the managed server.

---

## 5. Key modules

- `src/config/opencode.ts` — OpenCode config/constants.
- `src/services/opencode/serverManager.ts` — managed process lifecycle, readiness, cleanup, registration publish/owned cleanup integration.
- `src/services/opencode/connectionState.ts` — managed target/request context/transport, shutdown, runtime-target events.
- `src/services/opencode/startup.ts` — managed-only startup and compatibility no-op revalidation APIs (used by server shutdown paths).
- `src/services/opencode/runtimeTarget.ts` — server-wide managed runtime resolution/status.
- `src/services/opencode/serviceAccess.ts` — conversation history/service access resolution; legacy external-bound fail closed.
- `src/services/opencode/historyBoundary.ts` — history ownership model and boundary errors.
- `src/services/opencode/import.ts` — import from the active managed runtime target only.
- `src/services/opencode/sessions.ts` — session ensure/terminate/reconcile/activity behavior; history-boundary failures propagate for fail-closed route mapping.
- `src/services/opencode/orphanReconciler.ts` — managed-only orphan reconciliation; skips legacy external-owned rows.
- `src/services/opencode/registration.ts` — managed registration read/write/owned cleanup helpers.
- `src/services/opencode/configWritePolicy.ts` — config write refusal policy (managed root not TBAi-owned).
- `src/routes/opencode.ts` — HTTP boundary for runtime status/events, config, proxy, import, capabilities/commands, session operations.
- `web/src/features/opencode/*` — frontend runtime/config/status/capabilities UI and V2 controller/store integration.

---

## 6. Required preserved capabilities

Managed-only simplification must preserve required OpenCode features and safety guarantees, including: session lifecycle and import from the active managed server, history/sync/streaming/events, models/agents/commands, permissions/approvals/questions/forms, terminal/execution, diffs/workspace, config behavior, context/compaction, scheduled OpenCode execution, orphan reconciliation/safe deletion, V2 client/proxy/authz/workspace security, and managed status/reconnect/recovery/failure notifications. Direct Chat, AI SDK, MCP, and the independent app scheduler remain untouched.

---

## 7. Event streaming and recovery

OpenCode event subscriptions are live-only (missed events are not replayed; source failures end the current subscription). TBAi treats the event stream as a notification mechanism, not the source of truth.

- **Backend proxy/runtime target:** `/api/opencode/*` proxy requests resolve the current managed runtime target per request and forward through the captured, origin-bound transport. `/api/opencode/runtime/events` publishes current target identity on connect and on managed target install/replace/clear/shutdown changes (with heartbeat and cleanup on enqueue/abort/cancel failures).
- **Frontend V2 controller:** `web/src/features/opencode/v2Client.ts` subscribes to the upstream event stream per generation; `sync/eventPipeline.ts` consumes the stream, buffers assistant events during hydration, detects stream failure/idle issues, and schedules bounded reconnects. On reconnect/rehydration, `v2ThreadController.ts` re-reads authoritative session/history/auxiliary state (inbox, permissions, forms), reconciles staged revert recovery, and reprojects/commits history so the transcript converges without treating the stream as replay. Auxiliary state is periodically resynced as a dropped-event safety net.
- **Target change/restart:** managed restarts publish a new runtime target revision/id; frontend runtime-status/capabilities consumers refetch on target lifecycle notifications. Active V2 sessions recover through stream failure/reconnect and authoritative rehydration because proxy calls resolve to the current managed target; no proactive controller reset on target-change SSE was added in this pass.

---

## 8. Verification notes (2026-11-15, follow-up hardening, uncommitted)

- **Baseline pushed:** `4fec0072696cc3a01891f62fdfc1c16330058ce5` on `origin/develop` (managed-only refactor; prior verify/runtime/g3 evidence recorded in commit/session history). Working tree remains **uncommitted** (no follow-up commit/push).
- **Follow-up fixes applied in working tree:**
  - Corrected legacy external-owned history-boundary HTTP mapping to **503** for unavailable/unresolved refusals; renamed internal refusal `adopted_unavailable` → `external_unavailable` (internal contract, call sites/tests updated).
  - Propagated `OpenCodeHistoryBoundaryError` through session activity/terminate paths so routes fail closed instead of degrading to best-effort/unknown for external-unavailable conversations.
  - Added route-level regression tests: `tests/integration/opencode/external-owned-route-status.test.ts` (503 + exact unavailable message, no managed start, no fetch/probe, no ownership/session mutation for `/session`, `/session/reconcile-directory`, `/session/terminate`, `/session/activity`).
  - Restored managed-only resilience coverage in reduced suites: `tests/integration/opencode/runtime-target-events.test.ts` (SSE enqueue/heartbeat-failure cleanup, listener/timer cleanup, idempotent abort/cancel) and `tests/integration/opencode/request-context.test.ts` (shutdown after capture/before send, shutdown while pending, revision/epoch semantics, frozen captured context/credential, repeated/reentrant/idempotent shutdown and refusal behavior). Adoption/attempt-specific cases intentionally removed (APIs/internals no longer exist).
  - Dead/compat cleanup (evidence-based): removed unused `OpenCodeRevalidationOptions` from `src/services/opencode/startup.ts`; kept `stopOpenCodeRevalidation` (used by `src/server.ts` shutdown paths) and compatibility fields/options where callers/types still expect them. Legacy persisted-data compatibility paths preserved.
- **2.2.6 compatibility audit:** CLI `opencode v2.2.6`; installed `@opencode/client` `2.2.6` API surface matches TBAi usage (`event.subscribe`, `server.info`, `session.get/switchAgent/switchModel/prompt/compact/interrupt/inbox.* /revert.* /form.*`, `permission.list/reply`, `message.list`, `config.get`, `agent.list`, `model.list/default`, `command.list`, `project.list`, `session.list/get` as used). Real server checks: dynamic loopback `opencode serve --port 0 --hostname 127.0.0.1`, unauthenticated `/api/info` returned 401. `@opencode/client/service` `discover/ensure/stop` remain unused for runtime ownership (managed-only constraint). The previously captured `/doc` file at `D:\Coding\OpenCode\user\tmp\opencode\oc-2.2.6-doc.json` is HTML in the current environment and was not used as an OpenAPI source in this pass.
- **Targeted verification (exit 0):** `bunx tsc --noEmit -p tsconfig.json`; `cd web && bunx tsc --noEmit`; `bunx tsc --noEmit -p tests/tsconfig.backend.json`; `bun run lint`; `bun run format:check`; `bun test tests/integration/opencode/runtime-target-events.test.ts tests/integration/opencode/request-context.test.ts` (14 pass, 0 fail, 93 expect()); `bun test tests/unit/opencode/serviceAccess.test.ts tests/unit/opencode/sessions.test.ts tests/integration/opencode/service-continuity-reconnection.test.ts tests/integration/opencode/external-owned-route-status.test.ts` (72 pass, 0 fail); `bun test tests/unit/opencode/sessionActivity.test.ts` (11 pass, 0 fail); `bun test tests/unit/opencode/managed-lifecycle.test.ts` (8 pass, 0 fail); `bun test tests/unit/opencode/serviceAccess.test.ts tests/unit/opencode/startup.test.ts tests/integration/opencode/startup-orchestration.test.ts` (20 pass, 0 fail); `bun run test:e2e opencode/opencode-v2-code-route.spec.ts` (1 passed, 3.8s).
- **Mandatory gate `bun run verify`: exit 0.** typecheck, lint, format:check, test:locations, build, unit+integration **5911 pass / 79 skip / 0 fail / 30324 expect()** across 459 files, shutdown-lifecycle **1 pass**, startup-rollback **2 pass**, lifecycle-integration **3 pass**, dom **798 pass / 0 fail / 4509 expect()** across 82 files, quarantine check OK.
- **Full Playwright E2E (`bun run test:e2e`): exit 1 (not green).** After installing project Playwright browsers (`bunx playwright install --force chromium`), full run reported `spec files ok: 43, failed: 2` (`core/phase-ua-a.spec.ts`, `history/p2-live-runtime.spec.ts`). Classification/repro:
  - `history/p2-live-runtime.spec.ts` test J (`overlapping load-earlier requests stay duplicate-free and keep the tip`) failed in the full run but **passed in isolation** on rerun (4/4, exit 0) — treated as flaky/environmental, not attributable to this follow-up (no history/virtualizer/frontend changes in this diff).
  - `core/phase-ua-a.spec.ts` `(d) a bogus /code/<nope> id closes the tab, lands on draft, engine=opencode preserved` **failed consistently** in isolation (3/4 pass, (d) fails: `aria-pressed` expected `"true"` received `"false"` at `tests/e2e/core/phase-ua-a.spec.ts:320:30`; rerun reproduced). Backend correctly returns 404 for the nonexistent conversation; failure is in frontend draft-engine preservation behavior (`useConversationTab`/welcome engine flow) and is **not caused by this follow-up** (no `web/src` changes). Fixing it would require frontend changes outside this scope.
- **Security (`bun run security`): exit 1, blocked by environment.** `semgrep` in this environment is broken (`ModuleNotFoundError: No module named 'boltons'` initially; subsequent user-site dependency repair attempts left semgrep with missing/incompatible dependencies, e.g. `opentelemetry.exporter`). `verify:full` not completed.
- **Not completed / limitations:** full normal E2E not green, security gate not runnable in this environment, comprehensive security/fault-injection matrix and controlled performance measurements not collected. Some reduced-suite adoption/attempt-specific cases remain untestable without removed internal APIs. No controlled performance measurements collected; do not claim memory/CPU/startup improvements. No follow-up commit/push performed because mandatory/critical gates are not all green.

---

## 8. Managed runtime isolation and recovery verification (2026-11-15, this pass, uncommitted)

### Phase 1 — Previous drill forensics (read-only, no changes/deletions/terminations)

| Item | Classification | Evidence |
|---|---|---|
| Previous drill PIDs `7180` (TBAI), `12544` (OpenCode child), `15608` (OpenCode child) | **Not proven touched now / PID reuse observed** | `7180` and `12544` not alive. `15608` is alive as `powershell` started `11/15/2026 6:14:07 PM` (PID reuse), not the recorded OpenCode child. No process termination performed. |
| Registration `D:\Coding\OpenCode\user\.local\state\opencode\service.json` | **Proven touched during previous drill; now stale/misleading** | Exists (119 bytes, LastWrite `11/15/2026 3:53:40 PM`), non-secret fields: `pid=15608`, `version=2.2.6`, `url=http://127.0.0.1:55931`. Password not read/logged. PID now belongs to unrelated `powershell` process (reuse). File not edited/deleted. |
| Installed OpenCode binary | **Proven** | `D:\Coding\OpenCode\opencode.exe` reports `opencode v2.2.6`. |
| Effective paths with recorded historical env (`XDG_DATA_HOME=D:\Coding\OpenCode\data`, `XDG_CONFIG_HOME=D:\Coding\OpenCode\.config`, `XDG_STATE_HOME=D:\Coding\OpenCode\user\.local\state`, `OPENCODE_CONFIG_DIR=D:\Coding\OpenCode\.config\opencode`, `OPENCODE_CONFIG=D:\Coding\OpenChamber\.chamber-data\run\instances\14308\opencode.managed.json`, `USERPROFILE=C:\Users\RTPC`, unset `OPENCODE_DB/WORKSPACE_DIR/HOME/XDG_CONFIG_DIR`) | **Proven for recorded env only** | `opencode debug paths db` → `D:\Coding\OpenCode\data\opencode\opencode.db`; `state` → `D:\Coding\OpenCode\user\.local\state\opencode`; `config` → `D:\Coding\OpenCode\.config\opencode`; `data` → `D:\Coding\OpenCode\data\opencode`. |
| Normal OpenCode DB `D:\Coding\OpenCode\data\opencode\opencode.db` (+`-wal`, `-shm`) | **Not proven touched by previous drill** | Metadata only (no SQLite open/query/migration/WAL edit): `opencode.db` 1,047,023,616 bytes LastWrite `11/15/2026 6:00:31 PM`; `-wal` 12,973,912 bytes LastWrite `11/15/2026 6:14:36 PM`; `-shm` 32,768 bytes LastWrite `11/15/2026 4:45:28 PM`. Timestamps are recent/post-drill but exact historical process env cannot be reconstructed (current env differs, e.g. `OPENCODE_CONFIG=D:\Coding\OpenChamber\.chamber-data\run\instances\4564\opencode.managed.json` now); attribution to previous drill is **unproven**. |
| Previous workspace artifact `D:\Temp\ai-chat-app\workspace\chats\w2b60960iezphcighffz3jp8` | **Proven exists; not modified/deleted** | Directory exists, LastWrite/Created `11/15/2026 3:53:15 PM`. |

### Phase 2 — Runtime drill isolation corrections (smallest necessary, no production behavior changes)

- `tests/harness/opencodeRuntimeHarness.ts`: expanded `RuntimeIsolation` and `createRuntimeIsolation` to include `xdgStateHome`, `xdgCacheHome`, `tbaiDataDir`, `workspaceDir`, `opencodeDbPath`, `tempDir`, `userHomeDir`, `appDataDir`, `localAppDataDir`; added `writeIsolatedOpenCodeConfig`, `AMBIENT_OPENCODE_ENV_VARS`, `PRESERVED_PROCESS_ENV_KEYS`, `assertRuntimeIsolationPaths`, `buildIsolatedDrillEnv`; expanded `isolatedChildEnv` to pin `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `OPENCODE_DB`, `HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP`.
- `tests/integration/opencode/opencode-ownership-runtime.test.ts`: replaced custom isolation/env with harness-backed isolation (`createRuntimeIsolation` + `writeIsolatedOpenCodeConfig` + `assertRuntimeIsolationPaths` + `buildIsolatedDrillEnv`), ensuring explicit `OPENCODE_CONFIG`, `WORKSPACE_DIR`, `OPENCODE_DB`, `XDG_STATE_HOME/CACHE`, `HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP`, project-config disable flags, and sanitized env (ambient OpenCode routing/auth/storage vars cleared unless explicitly overridden) for spawned shell/sidecar/foreign OpenCode processes. No production behavior changes.

### Phase 3 — Controlled real-server recovery drill (API evidence)

- **Unique temp root:** `D:\Coding\OpenCode\user\tmp\opencode\tbai-managed-drill-20261115-183612-18192` (all effective drill paths asserted inside root before startup; see `evidence/phase3/isolation.json`, `tbai-env.json`).
- **Versions:** OpenCode CLI `opencode v2.2.6` (`D:\Coding\OpenCode\opencode.exe`); `@opencode/client` `2.2.6` (package.json).
- **Deterministic stub provider:** local loopback stub (`http://127.0.0.1:51667/v1`, model `tiny`) with explicit OpenCode config in temp root; prompt response contained unique marker `DRILL-MARKER-1794747977862-eejbra`. No paid/external model, no real credentials.
- **TBAI parent:** PID `18700` (`bun.exe src/index.ts`, PPID `17620`), port `43834`, isolated `DATA_DIR/WORKSPACE_DIR/XDG_*/OPENCODE_*`/home/appdata/temp inside root.
- **Managed child (before):** PID `11184` (`opencode.exe serve --port 0 --hostname 127.0.0.1`, PPID `18700`), registration `D:\...\xdg-state\opencode\service.json` pid `11184`, version `2.2.6`, url `http://127.0.0.1:53663` (password not disclosed). Runtime status initially `unresolved` (targetRevision 0) then managed on demand.
- **Conversation/session:** TBAI conversation `w0pctqqchb5cs40d77j7omrd` (engine `opencode`), OpenCode session `ses_e20af2744ffeD4APCX0LWDB8Yc`, directory `...\workspace\chats\w0pctqqchb5cs40d77j7omrd`, `reusedExistingSession:false` on first ensure.
- **Prompt:** `POST /api/opencode/session/{sessionID}/prompt` via TBAI proxy with `x-opencode-session` header and `{ "text": "Reply with exactly: OK <marker>" }` returned 200; marker observed in OpenCode messages.
- **Before transcript capture:** TBAI history `GET /api/conversations/{id}/messages` → 200, `{"messages":[]}` (0 messages). OpenCode session `GET /api/opencode/session/{sessionID}` → 200, session `ses_e20af2744ffeD4APCX0LWDB8Yc`, outcome `succeeded`, title contains marker. OpenCode messages `GET /api/opencode/session/{sessionID}/message` → 200, 1 page with `data` containing 3 messages (IDs `msg_1df50df43001hLgCU6F1Gu0v9j` idle/succeeded, `msg_1df50df1900154HSnjMy5ynnli` assistant with text `OK DRILL-MARKER-1794747977862-eejbra`, `msg_1df50def30017xGiH4ZKtp5eFy` user) and cursor present; no additional pages fetched by drill script (pagination follow-up not automated beyond first page) — raw page/cursor captured in evidence.
- **Failure injection:** verified managed child PID `11184` (PPID `18700`, exe/cmdline recorded) alive, then killed only that PID (`SIGKILL`/process kill). Child confirmed dead; TBAI parent kept alive.
- **Restart:** runtime status became `managed` with `targetRevision=3`, `targetId=2`, same `backendInstanceId`. Registration updated to PID `19436` (`opencode.exe serve --port 0 --hostname 127.0.0.1`, PPID `18700`, url `http://127.0.0.1:53707`, version `2.2.6`). New PID/target identity/revision confirmed different from before.
- **After transcript capture:** session ensure returned same session `ses_e20af2744ffeD4APCX0LWDB8Yc` with `reusedExistingSession:true`. TBAI history still 0 messages. OpenCode session and message page identical to before: same 3 message IDs/order/normalized content (corrected comparison: `equal:true`, IDs `[msg_1df50df43001hLgCU6F1Gu0v9j, msg_1df50df1900154HSnjMy5ynnli, msg_1df50def30017xGiH4ZKtp5eFy]` before/after). Evidence: `evidence/phase3/transcript-before.json`, `transcript-after.json`, `transcript-comparison-corrected.json`, `session-ensure-after.json`, `phase3-result.json`.
- **UI rehydration:** **not proven in this pass.** Existing `bun run test:e2e opencode/opencode-v2-code-route.spec.ts` passed (1 passed) but does not exercise runtime-target change/restart rehydration; no Playwright run was executed against the drill instance to prove Code UI rehydrates/displays the same transcript after managed child restart.

### Phase 4 — Shutdown paths (separate isolated runs)

- **4A Graceful TBAI shutdown:** root `D:\Coding\OpenCode\user\tmp\opencode\tbai-managed-drill-phase4a-20261115-184320-5304`. TBAI PID `11340`, managed child PID `20588` (PPID `11340`, registration v2.2.6). `POST /api/server/shutdown` returned 404 (no such endpoint); drill fell back to `SIGTERM` (process signal handled by TBAI shutdown handlers). TBAI exited (`signal SIGTERM`), managed child exited (`childDead:true`). Registration file remained present with old PID/URL after shutdown (`regExists:true`) — **registration removal on graceful shutdown not proven** in this run (and shutdown was via SIGTERM fallback, not a dedicated shutdown API). Evidence: `evidence/phase4a/phase4a-before.json`, `phase4a-shutdown-response.json`, `phase4a-after.json`.
- **4B Abrupt TBAI parent termination:** root `D:\Coding\OpenCode\user\tmp\opencode\tbai-managed-drill-phase4b-20261115-184351-8768`. TBAI PID `15652`, managed child PID `4336` (PPID `15652`, registration v2.2.6). TBAI force-terminated (`taskkill /F`); TBAI dead and managed child dead (`childDead:true`). Registration remained present. **Windows Job Object membership not explicitly proven** by external inspection in this drill (no job-handle query evidence collected); child termination after parent hard-kill is consistent with job-object cleanup but not independently verified here. Evidence: `evidence/phase4b/phase4b-before.json`, `phase4b-after.json`.

### Phase 5 — Tests and docs (this pass)

- **Targeted/type/lint/format (exit 0):** `bunx tsc --noEmit -p tsconfig.json`, `bunx tsc --noEmit -p tests/tsconfig.backend.json`, `bun run lint`, `bun run format:check`.
- **Runtime/ownership:** `TBAI_OPENCODE_RUNTIME_TESTS=1 OPENCODE_BINARY=D:\Coding\OpenCode\opencode.exe bun run test:opencode-runtime` — **exit 0**, 9/9 required suites passed (`audit-b7-opencode` 3 pass, `compatibility-disposable-mutation` 6, `opencode-database-compat` 2, `opencode-ownership-runtime` 3, `opencode-retry-restart` 3, `opencode-retry-runtime` 3, `opencode-runtime-auth` 14, `opencode-session-idempotency-runtime` 5, `opencode-stub-provider-spike` 8; 0 fail/0 skip). `bun test tests/integration/opencode/opencode-ownership-runtime.test.ts` (with runtime env) — **3 pass, 0 fail**. `bun test tests/unit/opencode/managed-lifecycle.test.ts` — **13 pass, 0 fail**.
- **Targeted OpenCode/startup:** `bun test tests/integration/opencode/startup-orchestration.test.ts` — **4 pass, 0 fail**.
- **E2E:** `bun run test:e2e opencode/opencode-v2-code-route.spec.ts` — **1 passed** (chromium-headless). Does not prove restart/rehydration UI scenario.
- **Relevant startup/shutdown/lifecycle integration:** `bun test tests/integration/core/startup-rollback.test.ts tests/integration/core/shutdown-lifecycle.test.ts tests/integration/core/lifecycle-integration.test.ts tests/integration/core/shutdown-escalation.test.ts tests/integration/core/signal-shutdown.test.ts tests/integration/core/stdin-shutdown.test.ts` — **14 pass, 5 fail** (all in `shutdown-escalation.test.ts` 2 fails: deadline-hit expectations false; 1 fail: `Database has closed` in scheduler create; `shutdown-lifecycle.test.ts` 1 fail: `Cannot use a closed database` during `startServer`; `startup-rollback.test.ts` 1 fail: `Database has closed` in MCP insert). These failures are in core lifecycle suites not modified by this pass; causation by this pass's harness/test-only changes is unlikely but **not ruled out** without baseline comparison — reported as failures, not claimed passed.
- **`bun run verify`:** started redirected to `verify-output.txt` (repo root, untracked) but did not complete in this pass (no final summary/exit code observed; tail shows MCP reconnect noise around 13:22:49 and no verify process running at end of pass). **Result: incomplete/unconfirmed** — not claimed passed.
- **Not run:** full Playwright suite, `bun run security`/`verify:full` (Semgrep environment issue previously reported), UI rehydration Playwright against drill restart scenario.

### Limitations / verdict inputs

- Phase 3 proves API-level transcript persistence/recovery across managed child restart (same conversation/session/message IDs/order/content) but **does not prove Code UI rehydration** after runtime target change.
- OpenCode message pagination was captured as first page with cursor; drill did not automatically follow cursors (3 messages total observed; cursors recorded).
- Phase 4A used SIGTERM fallback (no `/api/server/shutdown` endpoint); registration cleanup on graceful shutdown not demonstrated. Phase 4B did not include explicit Windows Job Object membership proof.
- Drill artifacts remain in temp roots under `D:\Coding\OpenCode\user\tmp\opencode\` (not deleted by this pass except failed-attempt cleanup within runs); previous drill artifacts untouched.

---

## 9. Change log

| Date | Action | Details |
|------|--------|---------|
| 2026-11-15 | Managed-only runtime simplification (`4fec007`) | Removed external discovery/adoption/attachment/revalidation/rediscovery from active runtime selection; kept managed registration publish/owned cleanup; legacy external-bound conversations fail closed; rewrote/retired adoption-era tests and updated runtime/config/status/import/orphan/session access paths. |
| 2026-11-15 | Follow-up hardening (uncommitted, no verified push) | Fixed external-owned unavailable HTTP status mapping to 503, added route-level fail-closed regression tests, propagated history-boundary errors through session activity/terminate, restored managed-only runtime-target SSE and request-context resilience coverage in reduced integration suites, performed 2.2.6 compatibility audit, and updated docs. `bun run verify` exit 0; dedicated OpenCode e2e exit 0; full e2e exit 1 with one flaky history spec (passed in isolation) and one consistent pre-existing/unrelated frontend failure (`core/phase-ua-a.spec.ts` (d)); `bun run security` blocked by broken semgrep environment. No follow-up commit/push. |
| 2026-11-15 | Managed runtime isolation/recovery verification (uncommitted, this pass) | Phase 1 forensics completed (previous drill attribution largely unproven; registration stale/PID-reused; normal DB timestamps recent but unattributed). Phase 2: hardened runtime isolation helpers/tests (`tests/harness/opencodeRuntimeHarness.ts`, `tests/integration/opencode/opencode-ownership-runtime.test.ts`) for drill-owned paths/env/assertions without production behavior changes. Phase 3: isolated real-server drill with deterministic stub provider proved managed child restart (PID/target revision change) restores same conversation/session and identical OpenCode transcript (3 message IDs/order/content) via API; UI rehydration after restart not proven. Phase 4: graceful shutdown via SIGTERM fallback left registration file; abrupt parent kill terminated managed child (job-object membership not explicitly proven). Tests: `test:opencode-runtime` 9/9 suites pass, targeted ownership/runtime/lifecycle/startup/e2e-code-route passes recorded, core lifecycle suite run had 5 failures (causation unproven), `bun run verify` in progress at doc update. |
## 10. Final acceptance closure pass (2026-11-15, local, uncommitted)

- **Branch/HEAD:** `review/managed-opencode-hardening-2026-11-15` @ `80813d85baa70b1bdd20f8899953bb82b4f874c8` (base `develop`/`origin/develop` `4fec0072696cc3a01891f62fdfc1c16330058ce5`, `main`/`origin/main` untouched). Worktree remains uncommitted; `verify-output.txt` preserved.
- **OpenCode:** CLI/SDK pinned to **2.2.6** (`D:\Coding\OpenCode\opencode.exe`, `@opencode/client` 2.2.6). No upgrade performed.

### Task 1 — Transcript evidence validation/correction (BLOCKING FINDING)
- **Latest evidence inspected:** `D:\Coding\OpenCode\user\tmp\opencode\tbai-ui-restart-20261115155852-11140\evidence\ui-restart\` (`transcript-before.json`, `transcript-after.json`, `transcript-comparison.json`, `summary.json`, `ui-before-restart.txt`, `ui-after-restart.txt`, `ui-after-reload.txt`, `session-after.json`, runtime/registration/identity/kill files, `tbai.stdout.log`, `runner.log`).
- **Raw 2.2.6 API response (via TBAI proxy, `x-tbai-session` header, `v2History.ts` paging contract: first page `?order=desc&limit=100`, follow `cursor.next`, reject repeats, dedupe by ID, chronological):** **2 pages consumed per capture**. Page 1: `data` contains **1 message**, `cursor.next` present. Page 2: `data` empty, `cursor.previous=null`, `cursor.next=null`. **All cursors consumed; comparison covers the entire transcript returned by the API.**
- **Persisted transcript contents (before and after, identical):** 1 message total, ID `msg_pending_mwi0rzin_lyql3frt`, `type:"user"`, `time.created:1794758342077`, `text:"Reply with exactly: OK UI-RESTART-MARKER-20261115155852-11140"`, `files:[]`, `agents:[]`. **No assistant message/role/ID returned.** The unique marker string appears in the **user prompt text** (prompt includes `OK <marker>`), not in a separate assistant response record.
- **OpenCode 2.2.6 DB evidence (isolated root, read-only):** `xdg-data/opencode/opencode.db` tables include `session_v2`, `session_message`, `session_part`, `session_inbox`. For session `ses_e20110eb0ffeojX7rlEnmeGCEP`: **0 rows** in `session_message`, `session_part`, `session_inbox`, and no `session_v2` row found. The API-returned `msg_pending_*` record is consistent with a pending/non-persisted message surface rather than a completed persisted assistant/user transcript pair in DB tables.
- **UI evidence:** `ui-before-restart.txt` shows the prompt and copy controls (marker substring present because prompt contains it). `ui-after-restart.txt` shows prompt and working/thinking state indicators. `ui-after-reload.txt` shows prompt, "done / Session restored / Previous session restored" and connected state; no separate assistant response text `OK <marker>` distinct from the prompt is visible in captured innerText. The previous test assertion `getByText('OK ${marker}', {exact:false})` matched the **prompt substring** and therefore did **not** prove the assistant's expected response was displayed/restored as a distinct message.
- **Conclusion:** The persisted OpenCode transcript (as returned by the 2.2.6 message-list API and as stored in inspected DB tables) is **not proven complete with the expected assistant response**. It contains the original user prompt (with marker in prompt text) but **no assistant response message**. Before/after API transcripts are identical in IDs/order/normalized content for what the API returns (1 user message), but this does not satisfy "persisted transcript proven complete, including the expected assistant response".
- **Test correction (this pass, no production persistence changes):** `tests/e2e/opencode/opencode-managed-restart-recovery.spec.ts` updated to capture prompt response body, record per-message roles/types/IDs and marker location analysis (user prompt vs assistant response), and persist analysis in transcript/comparison/summary evidence. UI restart/reload recovery assertions for prompt visibility, connected state, session reuse, and no-duplicate prompt remain; marker-in-UI assertion remains but is now understood as prompt-substring evidence unless a distinct assistant message is present. **New corrected evidence run not yet executed in this pass**.

### Task 1 (prior run) — Code UI recovery after managed child restart/reload (UI recovery observed; transcript completeness NOT proven)
- **Test:** `tests/e2e/opencode/opencode-managed-restart-recovery.spec.ts` run via isolated external server runner `D:\Coding\OpenCode\user\tmp\opencode\run-restart-recovery-e2e.ts` with `TBAI_E2E_BASE_URL` + `TBAI_E2E_EXTERNAL_SERVER=1`.
- **Isolated root:** `D:\Coding\OpenCode\user\tmp\opencode\tbai-ui-restart-20261115155852-11140` (deterministic local stub provider `http://127.0.0.1:51985/v1`, model `tiny`, fixed response `OK UI-RESTART-MARKER-20261115155852-11140`; actual managed OpenCode 2.2.6).
- **Result:** **1 passed (14.6s), exit 0** (prior test version). Evidence: `evidence/ui-restart/`.
- **Conversation/session:** conversation `vtqdgfqec0sqeeodtu76iaki`, OpenCode session `ses_e20110eb0ffeojX7rlEnmeGCEP` reused after restart/reload.
- **Managed child identity/restart:** before PID `23928` (PPID `22928`) verified and terminated only that verified process; after PID `23840`. Runtime target: before `managed rev1/id1`, after `managed rev3/id2`, same `backendInstanceId` `1e4b649f-7c71-4034-a717-953af54c6380`.
- **Transcript comparison (API-returned):** before/after 2 pages, 1 message, IDs equal `["msg_pending_mwi0rzin_lyql3frt"]`, normalized content/order equal. **But message is user-only/pending and contains no assistant response; see validation above.**

### Task 2 — Lifecycle test evaluation (corrected with `--isolate`)
- **Required command:** `bun test --isolate tests/integration/core/startup-rollback.test.ts tests/integration/core/shutdown-lifecycle.test.ts tests/integration/core/lifecycle-integration.test.ts tests/integration/core/shutdown-escalation.test.ts tests/integration/core/signal-shutdown.test.ts tests/integration/core/stdin-shutdown.test.ts`
- **Result:** **19 pass, 0 fail, 97 expect() calls, 6 files, exit 0** (57.62s). Log: `D:\Coding\OpenCode\user\tmp\opencode\lifecycle-isolate-20261115.txt` (clean rerun exit 0: `D:\Coding\OpenCode\user\tmp\opencode\lifecycle-isolate-check.txt`).
- **Classification:** Prior combined plain-`bun test` failures (**14 pass / 5 fail**: `shutdown-escalation` deadlineHit/DB-closed, `shutdown-lifecycle` closed DB during start, `startup-rollback` DB closed) are **test-invocation isolation issues** (shared global/module registry/singleton DB state across files without `--isolate`), not reproduced under the required isolated invocation. No product code or test assertions weakened.

### Task 3 — Graceful registration cleanup (PARTIAL / prior failure mode not reproduced)
- **Protocol traced:** `src/index.ts` stdin reader -> `handleProcessShutdown`/`shutdownServer` (`src/server.ts`) -> `OpenCodeServerManager.shutdown()` -> `stopAllChildrenForShutdown()` -> `removeOwnedRegistration()` -> `removeOpenCodeRegistrationIfOwned()` (`src/services/opencode/registration.ts`). Canonical desktop shutdown is stdin `{"type":"shutdown"}\n`.
- **Code change (observability, minimal):** `src/services/opencode/serverManager.ts` `removeOwnedRegistration()` now returns `Promise<boolean>` and logs `opencode.registration_removed` or `opencode.registration_remove_refused` with non-secret path/pid; test overrides updated for signature (`tests/integration/opencode/serverManager.test.ts`, `tests/unit/opencode/managed-lifecycle.test.ts`).
- **Stdin graceful-shutdown reproduction:** root `D:\Coding\OpenCode\user\tmp\opencode\tbai-graceful-repro-20261115-212335-7348` (`evidence/graceful-repro/`). TBAI PID `15612`, managed child PID `23368` (PPID `15612`, registration pid 23368, url `http://127.0.0.1:60742`, v2.2.6, password redacted). Sent `{"type":"shutdown"}\n`: **TBAI exited, child dead, registration removed (`regExists:false`)**.
- **Prior leftover-registration issue:** not reproduced under correct stdin protocol in this pass. Root cause of earlier SIGTERM-fallback/leftover case remains **unproven**; no regression test added for that exact failure mode. No registration deleted manually.

### Task 4 — Abrupt parent termination / Job Object evidence (PARTIAL)
- **Fresh isolated proof:** root `D:\Coding\OpenCode\user\tmp\opencode\tbai-abrupt-proof-20261115160138-18664` (`evidence/abrupt/before.json`, `after.json`, `kill.json`). TBAI PID `16232` (`bun.exe src/index.ts`, PPID `18664`), managed child PID `22676` (`opencode.exe serve --port 0 --hostname 127.0.0.1`, PPID `16232`, url `http://127.0.0.1:60742`, v2.2.6). `backend_job_installed:true` in TBAI stdout log.
- **Source-level contract evidence:** `src/services/process-ownership.ts` uses `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (0x2000), `AssignProcessToJobObject`/`IsProcessInJob`, backend job installed before child spawn; `src/services/opencode/serverManager.ts` creates managed process job, checks `isInJob` before resume, retains handle, terminates/closes on cleanup.
- **Runtime result:** TBAI parent force-terminated (`taskkill /F /PID 16232`, PID verified before kill). **TBAI dead, managed child dead, no managed child remains (`childStillAlive:false`).** Registration remained present after abrupt kill (`regExists:true`) — expected (no graceful cleanup).
- **Limitation:** **No external Windows Job Object handle/membership inspection performed.** Runtime kill-on-close consistent with observed child exit but not independently proven beyond source-level contract and observed outcome.

### Task 5 — Verification runs (in progress / captured)
| Command | Result | Exit |
|---|---:|---:|
| Prior Code UI restart/rehydration Playwright (`run-restart-recovery-e2e.ts`, pre-correction test) | 1 passed (14.6s); transcript completeness not proven (see Task 1) | 0 |
| Existing `bun run test:e2e opencode/opencode-v2-code-route.spec.ts` | 1 passed (5.4s) | 0 |
| `TBAI_OPENCODE_RUNTIME_TESTS=1 OPENCODE_BINARY=D:\Coding\OpenCode\opencode.exe bun run test:opencode-runtime` | 9/9 suites passed, 47 tests, 0 fail | 0 |
| Lifecycle 6-file command with `--isolate` (required) | **19 pass, 0 fail, 97 expect, 6 files** | 0 |
| `bun test tests/integration/core/startup-orchestration.test.ts tests/unit/opencode/managed-lifecycle.test.ts` | 13 pass, 0 fail (47 expect) | 0 |
| `bun run verify` (rerun4, `D:\Coding\OpenCode\user\tmp\opencode\verify-final-rerun4.log`) | **Incomplete/stalled**: passed typecheck, lint, format:check, test:locations, build; unit/integration phase did not complete (log last written 21:40:48, tail stuck at MCP reconnect spam from `mcp-manager` area since 16:10:48 log timestamps). **No final exit code/totals.** | unknown |
| `bun run verify` (new, `D:\Coding\OpenCode\user\tmp\opencode\verify-final-20261115-221655.log`) | **Completed, exit 1.** typecheck/lint/format:check/test:locations/build passed; `bun run test` **5915 pass, 79 skip, 1 fail, 30348 expect() calls, 5995 tests across 459 files** (353.64s). Single failure: `tests/integration/opencode/opencode-harness-isolation.test.ts` "runtime isolation: config is pinned, catalogue is not starved > leaves the cache directory alone while isolating data directory" (`expect(env.XDG_CACHE_HOME).toBeUndefined()` received isolated cache path) — caused by this pass's `isolatedChildEnv` harness change; **fixed in `tests/harness/opencodeRuntimeHarness.ts`** (reverted `isolatedChildEnv` to preserve cache isolation contract; drill isolation remains in `buildIsolatedDrillEnv`). Post-fix targeted checks: `bun test tests/integration/opencode/opencode-harness-isolation.test.ts` **19 pass/0 fail** (exit 0), `bun run typecheck/lint/format:check` exit 0. Verify not re-run after fix. | 1 |
| `verify-output.txt` (repo root, pre-existing) | Preserved, not overwritten | n/a |

**Stalled verify diagnosis (rerun4):** last completed test file header in log: `tests\unit\mcp\mcp-manager.test.ts`; tail shows repeated reconnect attempts for `p4-cap` (`definitely-not-a-real-command-xyz`) up to attempt 5 then no further progress logged for hours. No leftover bun/node processes from that attempt found at diagnosis time (only current dev server PIDs 8008/4624, verified). Independent reproduction: `bun test tests/unit/mcp/mcp-manager.test.ts` completed **4 pass, 0 fail, 18 expect, exit 0** twice; hang not reproduced independently. Cause of rerun4 stall **not definitively reproduced**; new full verify run launched to obtain real exit/totals.

`verify:full`/Semgrep not run (known environment limitation).

### Changed files (this pass, uncommitted)
- `src/services/opencode/serverManager.ts` — `removeOwnedRegistration()` returns boolean and logs owned-registration removal/refusal (observability, minimal).
- `tests/e2e/opencode/opencode-managed-restart-recovery.spec.ts` — new focused Code UI managed-restart/reload recovery acceptance test; corrected in this pass to capture prompt response and analyze transcript roles/IDs/marker location (no production persistence changes).
- `tests/integration/opencode/serverManager.test.ts` — test double override updated for `removeOwnedRegistration(): Promise<boolean>`.
- `tests/unit/opencode/managed-lifecycle.test.ts` — test double override updated for `removeOwnedRegistration(): Promise<boolean>`.
- `tests/harness/opencodeRuntimeHarness.ts` — preserved/extended prior-pass runtime isolation helpers (drill paths/env/assertions, `buildIsolatedDrillEnv`); `isolatedChildEnv` reverted in this pass to preserve existing cache-isolation contract after verify failure.
- `tests/integration/opencode/opencode-ownership-runtime.test.ts` — preserved prior-pass isolation/test changes (reviewed).
- `docs/opencode-context.md` — updated with corrected transcript/lifecycle/verification findings.

### Remaining blockers / exact failures
- **Task 1 transcript completeness:** persisted 2.2.6 message-list transcript contains only user prompt (`msg_pending_mwi0rzin_lyql3frt`, type user); **no assistant response message** present in API response or inspected OpenCode DB tables. Cannot claim "persisted transcript proven complete, including the expected assistant response". Corrected e2e evidence capture not yet rerun.
- **`bun run verify` not green:** `verify-final-20261115-221655.log` completed with **exit 1** (5915 pass/79 skip/1 fail, 30348 expect, 459 files). The only failure was `tests/integration/opencode/opencode-harness-isolation.test.ts` "leaves the cache directory alone while isolating data directory", caused by this pass's `isolatedChildEnv` harness regression; fixed in `tests/harness/opencodeRuntimeHarness.ts` and confirmed by targeted rerun (19 pass/0 fail) plus typecheck/lint/format:check green. Full `bun run verify` was **not re-run after the fix**.
- **Task 3 prior failure mode unproven:** graceful stdin shutdown removed owned registration in isolated repro, but earlier leftover-registration case (SIGTERM fallback context) not reproduced; root cause unknown.
- **Task 4 external job-handle proof absent:** source-level job contract and observed child termination after parent kill recorded, but no external Windows Job Object membership/handle inspection evidence.

