# TBAi OpenCode — Recovery & Session Continuity Improvement Plan

## Executive summary (plain language)

TBAi already has a solid foundation: official `@opencode/client` usage in key paths, strong ownership/history boundaries, durable session binding/orphan handling, and substantial reconnect/retry machinery on both backend and frontend. The main gaps are in the three focus areas:

- **Adopted server recovery**: `recovery.ts` correctly revalidates adopted targets and falls back to a TBAi-managed server on confirmed loss, but there is no path to rediscover/re-adopt the original local service after it returns. The system can abandon the original service/session context unnecessarily.
- **Frontend reconnection and reconciliation**: `eventPipeline.ts`, `attempt.ts`, `v2History.ts`, `v2Events.ts`, `v2ThreadController.ts` provide strong primitives (buffering/coalescing, idle watchdog, backoff/budget, history paging), but the end-to-end contract (resubscribe → rehydrate history/inbox/permissions/forms → reconcile without duplication) needs to be made explicit and verified. Some areas (e.g. overflow handling, auxiliary reconciliation) are well-designed but complex.
- **Prompt submission reliability**: The scheduler (`scheduledExecution.ts`) already does careful reconciliation on ambiguous dispatch (inbox/message lookup, classification of definitive vs ambiguous failures, no auto-retry on uncertain outcomes). The frontend has `promptsInFlight.ts` and admission tracking, but the plan needs to ensure parity and that "unknown delivery" is never auto-resubmitted.

The goal is to close these gaps with the smallest practical changes, reuse official SDK APIs where safe, remove unnecessary custom code where possible, and preserve all existing safety/ownership invariants.

## Current state vs desired state

| Area | Current state | Desired state |
|---|---|---|
| **Adopted server recovery** | Revalidates adopted target via bounded probes; on confirmed loss clears target and starts managed fallback via `openCodeServerManager.ensureBaseUrl()`. No rediscovery/re-adopt of original service after return. | On adopted loss, attempt bounded passive rediscovery/revalidation of the original compatible local service (using registration/explicit config hints) before falling back to managed. Prefer same service/session/ownership; only fallback as last resort. Never stop/control non-owned services. |
| **Frontend reconnection & reconciliation** | Event pipeline with backoff/foreground cap/budget, attempt lifecycle with idle watchdog, history paging with cursor safety, buffer/coalescing with overflow handling. Auxiliary (inbox/permissions/forms) loaded separately. | Explicit recovery sequence: detect disconnect/silent stream → resubscribe → rehydrate authoritative history/inbox/permissions/forms → reconcile with deduplication → restore actionable UI without reload/duplication. Clear connection states and honest handling of partial failures. |
| **Prompt submission reliability** | Scheduler reconciles ambiguous dispatch via inbox/message lookup, classifies definitive vs ambiguous, avoids duplicate side effects, cancels appropriately for shared sessions. Frontend has admission tracking. | All prompt sends use idempotent IDs and reconciliation-before-retry. Unknown delivery is treated as ambiguous (never auto-resubmitted). Parity between frontend and scheduler behavior. Clear "sent/checking/unknown/failed" states. |

## Prioritized implementation plan

### P0 — Reliability gaps (highest impact, smallest safe changes)

| Task | Purpose | Affected files | Existing functionality to reuse | Expected result | Risks | Focused verification |
|---|---|---|---|---|---|---|
| **P0.1 Adopted rediscovery/re-adopt** | Close the gap where original local service returns after fallback. | `src/services/opencode/recovery.ts`, `adoption.ts`, `registration.ts`, `runtimeTarget.ts`, `connectionState.ts`, `startup.ts` | Existing probe logic, attempt guards, ownership checks, `Service.discover` (evaluate as passive hint only), registration parsing/validation. | On adopted loss, do bounded passive rediscovery/revalidation of original service before permanent fallback. Preserve session ownership/history boundary. If rediscovered and compatible, re-adopt without starting managed server. | Rebinding to wrong service, credential/origin mistakes, duplicate managed starts. Must not call `Service.ensure/stop`. | Unit/integration: adopted restart same port/registration, changed registration, rediscovery timeout → fallback, no foreign process control. Verify no duplicate sessions/servers. |
| **P0.2 End-to-end reconnect + reconciliation contract** | Make recovery sequence explicit and enforce deduplication. | `web/src/features/opencode/sync/eventPipeline.ts`, `sync/attempt.ts`, `v2ThreadController.ts`, `v2Events.ts`, `v2History.ts`, `v2Permissions.ts`, `v2Forms.ts`, `v2Client.ts` | Existing pipeline/attempt/history/auxiliary loading, event identity/dedup, buffer/coalescing. | Define and enforce sequence: resubscribe → reload/reconcile authoritative state (history + inbox + permissions + forms) → dedupe by IDs → restore actionable UI. Handle overflow as non-recoverable without false "ready" state. | Duplicate/missing messages, stale UI marked ready, event ordering issues. | Integration/e2e: dropped stream, silent stream, missed events, pending permission/form/inbox across reconnect. Assert no duplicates, correct reconciliation. |
| **P0.3 Ambiguous prompt submission safety** | Enforce parity with scheduler's proven pattern. | `web/src/features/opencode/sync/promptsInFlight.ts`, `v2ThreadController.ts`, `src/services/opencode/scheduledExecution.ts`, `sessions.ts` | Scheduler's `reconcilePromptSubmission`, inbox/message lookup, classification logic, `promptsInFlight` admission tracking. | All prompt sends use idempotent IDs and reconciliation-before-retry. Unknown delivery never auto-resubmitted; surface "checking/sent/unknown" honestly. Align frontend with scheduler behavior. | Double-send side effects, lost user intent. | Unit/integration: transport drop after prompt, timeout after server receipt, retry UI behavior, scheduler/manual parity. Verify no duplicate delivery. |
| **P0.4 TBAI restart/session restore completeness** | Ensure full restoration after app restart. | `src/services/opencode/sessions.ts`, `serviceAccess.ts`, `historyBoundary.ts`, `routes/opencode.ts`, `web/src/features/opencode/sessionBootstrap.ts`, `v2ThreadController.ts` | Existing binding persistence, reuse logic, ownership checks, history boundary enforcement. | On restart, reuse persisted conversation→session binding, resolve authorized service, rehydrate history/inbox/permissions/forms/status. Only create new session if missing/invalid with explicit justification. | Stale binding misuse, accidental new session creation, missing pending state. | Integration: app restart with server running, pending permission/form/inbox, interrupted generation. Verify same session reused, state restored or honestly reported. |
| **P0.5 Managed crash recovery verification/fixes** | Harden existing supervision without changing ownership. | `src/services/opencode/serverManager.ts`, `connectionState.ts`, `runtimeTarget.ts`, `startup.ts` | Existing restart budget/counters, ownership/DB lease checks, shutdown coordination. | Deterministic single-child restart, target republish, capability/readiness revalidation, session rehydration triggers. Explicit recovery when budget exhausted. | Duplicate processes, restart storms, stale target publication. | Integration: child crash, repeated crashes hitting budget, crash during startup/shutdown. Verify no duplicates, correct state publication. |

### P1 — Official API reuse and simplification

| Task | Purpose | Affected files | Existing functionality to reuse | Expected result | Risks | Focused verification |
|---|---|---|---|---|---|---|
| **P1.1 Evaluate `Service.discover` as passive hint** | Reduce custom parsing where safe. | `registration.ts`, `adoption.ts`, `startup.ts`, `runtime.ts` | Official `Service.discover()` from `@opencode/client/service` (2.2.6). Keep existing validation. | Use `Service.discover` as passive input only if it improves correctness/maintenance. Keep TBAi validation/policy as authority (loopback/origin/credential/ownership/capability). Never trust as authority. | Trusting unvalidated data, credential/origin leakage. | Unit tests: discovery precedence, invalid/missing/foreign records, explicit config override. No behavior regression. |
| **P1.2 Explicitly reject/contain `Service.ensure/stop`** | Prevent unsafe lifecycle control. | `serverManager.ts`, `adoption.ts`, `recovery.ts`, docs/architecture notes | Existing ownership model and refusal patterns. | Codify internal contract: no `ensure/stop` on non-owned/adopted services. Any managed-only reuse requires proof and wrappers. Document in code/comments. | Accidental termination/replacement of foreign server. | Code review/tests asserting no non-owned lifecycle control paths. |
| **P1.3 Consolidate discovery on official APIs** | Reduce duplication. | `capabilities.ts`, `commands.ts`, `sessionModel.ts`, `routes/opencode.ts`, web config/runtime consumers | Official `model.list/default`, `provider.list/get`, `agent.list/get`, `command.list`. | One capability snapshot flow backed by official APIs with explicit caching/refresh rules. Keep TBAi selection policy. | Empty-catalog regressions, selection resets. | Unit/integration: startup empty catalog window, refresh, disappeared model/provider, default selection. |
| **P1.4 Config API alignment assessment** | Decide path forward. | `configDocument.ts`, `configWritePolicy.ts`, `routes/opencode.ts`, `OpenCodeConfigPage.tsx` | Official `config.get`, `experimental.config.update`. Existing policy/redaction. | Documented decision (keep document adapter/hybrid/move) based on verified behavior and policy. If writes remain disabled, simplify UI/paths. | Breaking config viewing/editing or leaking secrets. | Unit/integration for redaction, malformed config, refused writes, adopted vs managed behavior. |

### P2 — Refactoring and optimization (behavior-preserving, incremental)

| Task | Purpose | Affected files | Existing functionality to reuse | Expected result | Risks | Focused verification |
|---|---|---|---|---|---|---|
| **P2.1 Decompose `serverManager.ts`** | Reduce complexity without changing behavior. | `serverManager.ts`, possibly new internal modules under `services/opencode/` | Existing lifecycle logic, ownership checks, restart supervision. | Split by responsibility (spawn/listening/readiness/ownership/capabilities/restart/shutdown) with explicit interfaces. | Lifecycle regressions. | Existing + new startup/crash/shutdown/ownership tests. Characterization tests first. |
| **P2.2 Decompose session lifecycle/recovery** | Improve maintainability. | `sessions.ts`, `recovery.ts`, `orphanReconciler.ts`, `conversationDeletion.ts` | Existing RT-001 intent/orphan handling, binding logic. | Clear submodules (bind/ensure, intent-persist-reconcile, terminate, activity/reconcile). | RT-001 regressions, orphan leaks. | Unit/integration for create ambiguity, stale/missing session, delete/terminate races. |
| **P2.3 Frontend OpenCode sync decomposition** | Reduce controller complexity. | `v2ThreadController.ts`, `v2Events.ts`, `v2History.ts`, `v2Permissions.ts`, `v2Forms.ts`, `sync/*` | Existing pipeline/attempt/history/reducers. | Separate pure reducers/normalizers, transport/reconnect, admission/reconciliation, UI controller. | Event ordering/replay regressions, UI desync. | Reducer/pipeline/controller characterization tests, reconnect/replay scenarios. |
| **P2.4 Canonical service identity/target model** | Reduce translation points. | `historyBoundary.ts`, `serviceProfile.ts`, `runtimeTarget.ts`, `serviceAccess.ts`, `connectionState.ts` | Existing ownership model and canonicalization. | One canonical internal model with explicit adapters for persistence/UI/logging. Maintain compatibility with persisted keys. | Cross-service access bugs. | Unit tests for canonicalization, compatibility, refusal cases. |

### P3 — UX improvements

| Task | Purpose | Affected files | Existing functionality to reuse | Expected result | Risks | Focused verification |
|---|---|---|---|---|---|---|
| **P3.1 Honest connection/recovery status** | Clearer UX. | `web/src/features/opencode/*status*`, `v2ThreadController.ts`, `sync/eventPipeline.ts`, routes/status | Existing connection states and pipeline status. | Clear states: connected, reconnecting, rehydrating, recovered, needs action, failed (with reason class). | Misleading status if tied to wrong signal. | UI/unit tests for state transitions. |
| **P3.2 Actionable recovery controls** | Safe manual recovery. | OpenCode UI components, controller actions, routes | Existing retry/reconnect logic. | Safe manual actions: retry reconnect, refresh models/providers, re-open/rebind session (when safe), copy diagnostics. Never duplicates prompts/sessions. | Unsafe manual actions causing duplicates. | UI/integration tests for retry buttons and guarded states. |
| **P3.3 Draft and in-progress work preservation** | Prevent data loss. | composer/runtime integration, prompt admission state | Existing draft handling and admission tracking. | Draft preserved across reconnect/restart/model errors; clear "not sent/checking/sent/failed" states. | Stale draft restoration bugs. | UI tests for draft persistence across reconnect/error/reload. |

## Exact files affected

### Backend (src/)
- `src/services/opencode/recovery.ts` (P0.1)
- `src/services/opencode/adoption.ts` (P0.1, P1.1, P1.2)
- `src/services/opencode/registration.ts` (P0.1, P1.1)
- `src/services/opencode/runtimeTarget.ts` (P0.1, P0.5, P2.4)
- `src/services/opencode/connectionState.ts` (P0.1, P0.5, P2.4)
- `src/services/opencode/startup.ts` (P0.1, P0.5, P1.1)
- `src/services/opencode/serverManager.ts` (P0.5, P1.2, P2.1)
- `src/services/opencode/sessions.ts` (P0.3, P0.4, P2.2)
- `src/services/opencode/scheduledExecution.ts` (P0.3)
- `src/services/opencode/serviceAccess.ts` (P0.4, P2.4)
- `src/services/opencode/historyBoundary.ts` (P0.4, P2.4)
- `src/services/opencode/capabilities.ts` (P1.3)
- `src/services/opencode/commands.ts` (P1.3)
- `src/services/opencode/sessionModel.ts` (P1.3)
- `src/services/opencode/configDocument.ts` (P1.4)
- `src/services/opencode/configWritePolicy.ts` (P1.4)
- `src/services/opencode/orphanReconciler.ts` (P2.2)
- `src/services/opencode/conversationDeletion.ts` (P2.2)
- `src/services/opencode/serviceProfile.ts` (P2.4)
- `src/routes/opencode.ts` (P0.4, P1.3, P1.4)

### Frontend (web/src/)
- `web/src/features/opencode/sync/eventPipeline.ts` (P0.2, P3.1)
- `web/src/features/opencode/sync/attempt.ts` (P0.2)
- `web/src/features/opencode/sync/promptsInFlight.ts` (P0.3)
- `web/src/features/opencode/v2ThreadController.ts` (P0.2, P0.3, P0.4, P2.3, P3.1)
- `web/src/features/opencode/v2Events.ts` (P0.2, P2.3)
- `web/src/features/opencode/v2History.ts` (P0.2, P2.3)
- `web/src/features/opencode/v2Client.ts` (P0.2)
- `web/src/features/opencode/v2Permissions.ts` (P0.2, P2.3)
- `web/src/features/opencode/v2Forms.ts` (P0.2, P2.3)
- `web/src/features/opencode/sessionBootstrap.ts` (P0.4)
- `web/src/features/opencode/openCodeConfig.ts`, `OpenCodeConfigPage.tsx` (P1.4)
- OpenCode UI components for status/recovery/draft (P3.1, P3.2, P3.3)

## Opportunities to remove custom code

| Area | Opportunity | Notes |
|---|---|---|
| **Registration/discovery** | Evaluate replacing parts of custom registration parsing with `Service.discover()` as passive hint | Keep all validation/policy; only use if equivalent and safer. Do not use `Service.ensure/stop`. |
| **Capability/command/model discovery** | Consolidate on official APIs (`model/provider/agent/command`) | Remove redundant polling/translation where possible; keep TBAi selection policy and caching. |
| **Config** | Assess moving reads/writes to official config APIs if safe | Current document-based approach has policy constraints; only change if upstream guarantees allow and safety preserved. |
| **Lifecycle orchestration** | Simplify where official SDK patterns fit | Keep TBAi ownership/DB lease/supervision; avoid duplicating what official APIs provide. |
| **Frontend projection** | Reduce custom state machines where upstream contracts sufficient | Focus on behavior-preserving decomposition, not wholesale replacement. |

## Dependencies and risks

### Dependencies
- **SDK**: `@opencode/client` pinned to 2.2.6 (must remain). Official APIs available: session/message/event/permission/form/model/agent/command/config, `experimental.session.wait`, `Service.discover/ensure/stop/headers`.
- **Existing infrastructure**: ownership/DB lease, history boundary, proxy allowlist/authorization, transport/origin binding, RT-001 intent/orphan handling.
- **Tests**: existing unit/integration tests for opencode/scheduler provide safety net.

### Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Breaking adopted server recovery | Medium | High | P0.1 behind careful guards, attempt-based supersession, never call `ensure/stop` on non-owned services, test with restart scenarios. |
| Reconnect/reconciliation regressions | Medium | High | P0.2 with characterization tests, preserve buffer/coalescing logic, explicit deduplication, overflow handling remains safe. |
| Duplicate prompt submission | Medium | High | P0.3 enforce reconciliation-before-retry, idempotent IDs, parity with scheduler's proven pattern. |
| Session restore issues | Medium | High | P0.4 verify binding ownership, history boundary checks, only create when necessary. |
| Managed restart regressions | Medium | High | P0.5 preserve ownership/DB lease invariants, single-child enforcement, budget/exhaustion handling. |
| API misuse (ensure/stop) | Low | High | P1.2 codify contract, code review/tests, explicit non-use. |
| Refactor complexity | Medium | Medium | P2 behavior-preserving, incremental, characterization tests first, no large-file splits just for size. |

## Clear acceptance criteria

### P0 acceptance criteria
- [ ] **P0.1**: Adopted server restart recovers to same session/service when contract permits via rediscovery; falls back to managed only when rediscovery fails. No duplicate servers/sessions. No ownership violations.
- [ ] **P0.2**: Reconnect recovers session without reload; no duplicated events/messages/prompts; pending permissions/forms/inbox consistent after reconnect. Overflow handled honestly (no false "ready").
- [ ] **P0.3**: Same logical prompt never delivered twice automatically. Unknown delivery treated as ambiguous with reconciliation; user sees honest state.
- [ ] **P0.4**: TBAI restart reuses same session and reconciles history/inbox/permissions/forms/status. No silent orphan/new session creation.
- [ ] **P0.5**: Managed crash recovers automatically when possible; no duplicate servers; explicit recovery when budget exhausted. Target republished correctly.

### P1 acceptance criteria
- [ ] **P1.1**: `Service.discover` used only as passive hint if adopted, with full validation/policy. No behavior regression.
- [ ] **P1.2**: No `Service.ensure/stop` called on non-owned/adopted services. Contract documented and enforced.
- [ ] **P1.3**: Discovery consolidated on official APIs with stable user selection behavior.
- [ ] **P1.4**: Config path decision documented with unchanged safety guarantees.

### P2 acceptance criteria
- [ ] **P2.1**: `serverManager.ts` decomposed with same behavior, clearer boundaries.
- [ ] **P2.2**: Session/recovery internals decomposed with preserved RT-001 semantics.
- [ ] **P2.3**: Frontend sync decomposed with same UX/behavior, improved testability.
- [ ] **P2.4**: Canonical service identity model with fewer translation points, unchanged security/ownership.

### P3 acceptance criteria
- [ ] **P3.1**: Clear connection/recovery states distinguish retrying/recovered/needs action/failed.
- [ ] **P3.2**: Manual recovery actions safe (no duplicates), match failure class.
- [ ] **P3.3**: Drafts preserved across recoverable failures with clear send states.

### Overall acceptance criteria
- [ ] All three focus areas addressed with smallest practical changes
- [ ] No weakening of ownership, security, or local-only constraints
- [ ] No `Service.ensure/stop` on non-owned services
- [ ] No OpenCode DB schema changes
- [ ] No plaintext credentials exposed
- [ ] Official SDK APIs reused where safe
- [ ] Unnecessary custom code removed where identified
- [ ] Focused verification passes for affected areas (tests/builds already green per context)

## Implementation sequence

1. **P0.1 + P0.2 design spike** (characterization tests, no behavior change yet): define authoritative recovery contract and adopted-loss decision tree.
2. **P0.3 prompt ambiguity hardening**: verify/enforce idempotent prompt IDs and reconciliation-before-retry in frontend path; align with scheduler.
3. **P0.1 adopted rediscovery/re-adopt fix**: implement bounded passive rediscovery/revalidation before permanent fallback where supported.
4. **P0.4 restart/session restore completeness**: ensure TBAI restart reuses same session and reconciles history/inbox/permissions/forms/status.
5. **P0.5 managed crash recovery verification/fixes**: close proven gaps in restart supervision/target republish/rehydration triggers.
6. **P1.1–P1.3 official API reuse/simplification**: guarded `Service.discover` evaluation, discovery/capability consolidation, explicit non-use of `ensure/stop` on non-owned services.
7. **P2 refactors** (behavior-preserving, incremental): decompose `serverManager`, session/recovery internals, frontend sync/controller, canonicalize service identity model.
8. **P3 UX**: status/recovery actions/draft preservation once recovery semantics are stable.

**Sequence rule:** no refactor before P0 behavior is characterized; no API replacement without equivalence proof.

## Status / changelog

- **2026-11-10**: Initial plan created from read-only audit of current implementation and latest audit reports (`docs/2026-11-10-opencode-native-integration-recovery-audit.md`, `docs/OpenCode-Native ArchitectureAudit.md`). Focused on adopted server recovery, frontend reconnection/reconciliation, and prompt submission reliability.
