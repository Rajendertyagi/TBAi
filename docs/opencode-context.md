# OpenCode Subsystem — Context and Handoff

**Last updated:** 2026-11-15  
**Repository:** `D:\Temp\ai-chat-app` (TBAi)  
**Branch:** `develop` (working tree contains uncommitted managed-only runtime simplification)

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

## 2. Managed-only runtime (current)

TBAi owns **exactly one managed `opencode serve` runtime**.

- **No external runtime selection:** TBAi does not discover, adopt, attach to, revalidate, or rediscover independently running external OpenCode servers for runtime selection.
- **Obsolete external env vars:** `OPENCODE_URL`, `OPENCODE_HOST`, and `OPENCODE_PORT` are ignored for TBAi runtime selection. When present, startup logs a warning and continues with managed startup; they must not silently redirect runtime selection.
- **Managed registration:** TBAi may publish and clean up its own managed registration/ownership records as needed for the managed runtime it owns. Registration is not used to adopt external services.
- **Startup/lifecycle:** `src/services/opencode/startup.ts` starts the managed runtime once per process (skips in automated test runs/shutdown/already-installed cases). `src/services/opencode/serverManager.ts` owns managed process start, readiness, cleanup, restart/shutdown behavior, and Windows process ownership/cleanup constraints. `src/services/opencode/connectionState.ts` owns the managed target, request context/transport, shutdown latch, and runtime-target change notifications.
- **Runtime target/status:** Server-wide/runtime surfaces resolve to the installed managed target or start the managed child on demand (`src/services/opencode/runtimeTarget.ts`). Status/events expose managed/unresolved runtime identity without credentials.

---

## 3. Legacy external-bound conversations (compatibility)

Conversations historically bound to an external/remote OpenCode service remain externally owned and **fail closed** in the managed-only runtime.

- TBAi never reassigns them to local/managed, never rewrites session IDs, never points old external session IDs at the managed DB, and never probes external services.
- History/service access for a remote-bound conversation is refused with:  
  `The original external OpenCode service for this conversation is unavailable. TBAi now supports its managed OpenCode runtime only.`  
  (`OpenCodeHistoryBoundaryError`, refusal `adopted_unavailable` in current implementation; route mapping treats unresolved history-boundary refusals as `503` where applicable).
- Ownership migration/canonicalization and existing records/history must be preserved. Orphan reconciliation must not probe or remove legacy external-owned sessions through the managed server.

---

## 4. Key modules

- `src/config/opencode.ts` — OpenCode config/constants.
- `src/services/opencode/serverManager.ts` — managed process lifecycle, readiness, cleanup, registration publish/owned cleanup integration.
- `src/services/opencode/connectionState.ts` — managed target/request context/transport, shutdown, runtime-target events.
- `src/services/opencode/startup.ts` — managed-only startup and compatibility no-op revalidation APIs.
- `src/services/opencode/runtimeTarget.ts` — server-wide managed runtime resolution/status.
- `src/services/opencode/serviceAccess.ts` — conversation history/service access resolution; legacy external-bound fail closed.
- `src/services/opencode/historyBoundary.ts` — history ownership model and boundary errors.
- `src/services/opencode/import.ts` — import from the active managed runtime target only.
- `src/services/opencode/sessions.ts` — session ensure/terminate/reconcile behavior.
- `src/services/opencode/orphanReconciler.ts` — managed-only orphan reconciliation; skips legacy external-owned rows.
- `src/services/opencode/registration.ts` — managed registration read/write/owned cleanup helpers.
- `src/services/opencode/configWritePolicy.ts` — config write refusal policy (managed root not TBAi-owned).
- `src/routes/opencode.ts` — HTTP boundary for runtime status/events, config, proxy, import, capabilities/commands, session operations.
- `web/src/features/opencode/*` — frontend runtime/config/status/capabilities UI and V2 controller/store integration.

---

## 5. Required preserved capabilities

Managed-only simplification must preserve required OpenCode features and safety guarantees, including: session lifecycle and import from the active managed server, history/sync/streaming/events, models/agents/commands, permissions/approvals/questions/forms, terminal/execution, diffs/workspace, config behavior, context/compaction, scheduled OpenCode execution, orphan reconciliation/safe deletion, V2 client/proxy/authz/workspace security, and managed status/reconnect/recovery/failure notifications. Direct Chat, AI SDK, MCP, and the independent app scheduler remain untouched.

---

## 6. Verification notes (2026-11-15, in-progress)

- Baseline: `2c88db1a1f2d326aea036e6bf3a7cddc6fe8a3d2` (`develop`).
- Backend/frontend managed-only refactor applied in working tree; adoption/recovery modules and adoption-era tests removed or rewritten.
- `bunx tsc --noEmit -p tsconfig.json` — pass.
- `cd web && bunx tsc --noEmit` — pass.
- `bunx tsc --noEmit -p tests/tsconfig.backend.json` — pass after test rewrites.
- Targeted OpenCode unit/integration tests (service access, startup, runtime target, history boundary, config write policy, import, orphan reconciler, registration, HTTP transport, compatibility, sessions, import preservation, transport contract, service continuity) — pass in targeted run (see session transcript for exact counts).
- Full `bun run verify` and required additional gates: pending/in progress at time of writing; record exact results before completion.

---

## 7. Change log

| Date | Action | Details |
|------|--------|---------|
| 2026-11-15 | Managed-only runtime simplification | Removed external discovery/adoption/attachment/revalidation/rediscovery from active runtime selection; kept managed registration publish/owned cleanup; legacy external-bound conversations fail closed with specified unavailable message; rewrote/retired adoption-era tests and updated runtime/config/status/import/orphan/session access paths. |
