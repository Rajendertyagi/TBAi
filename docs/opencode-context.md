# OpenCode Subsystem — Context and Handoff

**Last updated:** 2026-11-15  
**Repository:** `D:\Temp\ai-chat-app` (TBAi)  
**Branch:** `develop`
**Baseline:** `4fec0072696cc3a01891f62fdfc1c16330058ce5` (managed-only runtime simplification, pushed to `origin/develop`)
**Follow-up:** reliability hardening / correctness fixes in progress on this baseline (uncommitted at time of writing)

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

## 9. Change log

| Date | Action | Details |
|------|--------|---------|
| 2026-11-15 | Managed-only runtime simplification (`4fec007`) | Removed external discovery/adoption/attachment/revalidation/rediscovery from active runtime selection; kept managed registration publish/owned cleanup; legacy external-bound conversations fail closed; rewrote/retired adoption-era tests and updated runtime/config/status/import/orphan/session access paths. |
| 2026-11-15 | Follow-up hardening (uncommitted, no verified push) | Fixed external-owned unavailable HTTP status mapping to 503, added route-level fail-closed regression tests, propagated history-boundary errors through session activity/terminate, restored managed-only runtime-target SSE and request-context resilience coverage in reduced integration suites, performed 2.2.6 compatibility audit, and updated docs. `bun run verify` exit 0; dedicated OpenCode e2e exit 0; full e2e exit 1 with one flaky history spec (passed in isolation) and one consistent pre-existing/unrelated frontend failure (`core/phase-ua-a.spec.ts` (d)); `bun run security` blocked by broken semgrep environment. No follow-up commit/push. |
