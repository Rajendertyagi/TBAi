# TBAi — OpenCode-Native Integration, Automatic Recovery and Architecture Optimization (Read-only audit & plan)

**Audit type:** READ-ONLY. No source, tests, manifests, lockfiles, config, DB, branches, or dependencies were modified. No tests/builds were run. SDK 2.2.6 alignment treated as existing work and unchanged.

## 1. Actual repository state (confirmed)

| Item | Confirmed state |
|---|---|
| Repository | `D:\Temp\ai-chat-app` (git repo) |
| Branch | `develop` |
| HEAD | `c8a29270be1238f499b0e839b1c63a75d59602bb` (`fix(opencode): harden ownership checks, session ids, and error handling`) |
| Recent commits | `c8a2927`, `f3460d8`, `9ccdaf3`, `31b207f`, `fa0d635` |
| Modified (uncommitted) | `bun.lock`, `package.json`, `src/services/opencode/scheduledExecution.ts`, `tests/unit/scheduler/opencode-scheduler.test.ts`, `web/package.json` |
| Untracked (untouched) | `docs/2026-11-08-codeg-settings-reference-study.md`, `docs/2026-11-08-settings-audit.md`, `start-tbai.ps1` |
| SDK versions (confirmed) | Root `@opencode/client`: `2.2.6`; web `@opencode/client`: `2.2.6`; installed `node_modules/@opencode/client`: `2.2.6`; lock resolves `@opencode/protocol@2.2.6`, `@opencode/schema@2.2.6`, `effect@4.1.0` |
| Known alignment (existing work) | `client.session.wait` migrated to `client.experimental.session.wait` in `src/services/opencode/scheduledExecution.ts`; scheduler test mocks updated in `tests/unit/scheduler/opencode-scheduler.test.ts`; focused compatibility/typecheck previously reported passing in prior session context; full-suite/build verification not completed in this audit session |

**No reset/clean/discard performed.**

---

## A. Executive summary (plain language)

### What already works (confirmed in source)
- **Official SDK is in use in key places:** backend and frontend create official clients (`src/services/opencode/client.ts` uses `OpenCode.make`; `web/src/features/opencode/v2Client.ts` uses `OpenCode.make` and official types). Scheduler uses official session/inbox/message APIs and now `client.experimental.session.wait` for 2.2.6 (`src/services/opencode/scheduledExecution.ts`).
- **Session continuity foundations exist:** TBAi mints/correlates session IDs, persists conversation↔session bindings, resolves service/history ownership, and has intent/orphan/reconciliation logic to avoid losing track of created sessions (`src/services/opencode/sessions.ts`, `historyBoundary.ts`, `serviceAccess.ts`, `orphanReconciler.ts`, `conversationDeletion.ts`).
- **Managed server supervision exists:** `src/services/opencode/serverManager.ts` spawns `opencode serve`, waits for listening/readiness, tracks child exit, has restart budget/counters and explicit recovery/reset paths (`restartAttempts`, `maxRestartAttempts`, `resetRestartBudget`, `recoverManagedServer`, unexpected-exit/restart handling observed in source).
- **Frontend reconnect/recovery machinery exists:** `web/src/features/opencode/sync/eventPipeline.ts` implements buffered event consumption, coalescing, reconnect scheduling with backoff/foreground cap, retry budget/exhaustion, and buffer-overflow reporting; `sync/attempt.ts` owns per-attempt readiness/signals/idle watchdog/retirement/failure semantics; `v2ThreadController.ts` and `v2History.ts` coordinate connection, history loading, and reconciliation-oriented flow (large but structured around attempts/pipeline/history).
- **Safety boundaries are strong:** origin-bound/gated transports, redirect refusal, proxy allowlist + authorization + server-resolved directory scope, config redaction/write policy, DB ownership checks, and refusal to treat non-owned services as controllable (`http.ts`, `connectionState.ts`, `routes/opencode.ts`, `proxyRoutes.ts`, `proxyAuthorization.ts`, `configRedaction.ts`, `configWritePolicy.ts`, `ownership.ts`).

### What is missing or risky (confirmed/inferred)
- **Adopted/external local server recovery is incomplete for “server comes back later”:** `src/services/opencode/recovery.ts` revalidates adopted targets; on confirmed loss it clears the adopted target and starts/installs a TBAi-managed fallback (`startManaged` → `openCodeServerManager.ensureBaseUrl()`), but it does **not** show a path to rediscover/re-adopt the original local service after it returns. This can preserve availability but risks abandoning the original service/session ownership context until another adoption/startup path runs (needs end-to-end verification).
- **Official service lifecycle APIs are not reused:** installed SDK 2.2.6 exposes `Service.discover/ensure/stop/headers` (`node_modules/@opencode/client/dist/promise/service.js`, `service.d.ts`). TBAi uses custom registration/adoption/startup/manager logic instead. `ensure/stop` are lifecycle-controlling and unsafe for non-owned services; `discover` is passive but still must be evaluated carefully against TBAI’s ownership/credential/origin policies.
- **Recovery is distributed across many modules:** backend target recovery, managed restart, session persistence/orphans, scheduler prompt reconciliation, and frontend event/history/attempt recovery each solve parts of the problem. The main gap is proving they form one complete, non-duplicating recovery lifecycle for all required scenarios.
- **Complexity/duplication remains high:** `serverManager.ts` (~61k), `sessions.ts` (~64k), `v2ThreadController.ts` (~85k), `v2Events.ts` (~57k) concentrate multiple responsibilities. Some is necessary; some is likely simplifiable behind official APIs and clearer internal contracts.

### What is unnecessarily custom
- Custom registration file reading/validation and parts of discovery/adoption orchestration where passive official discovery could be a guarded input (not authority).
- Custom capability/catalog polling and some model/command/config mediation where official SDK calls already exist.
- Large bespoke frontend sync/projection state handling that may exceed what assistant-ui + official event/history contracts require (needs careful, behavior-preserving decomposition).

### What should change (direction)
- **Keep OpenCode authoritative** for sessions/messages/history/events/providers/models/tools/permissions.
- **Reuse official SDK/service APIs first** (`OpenCode.make`, session/message/event/permission/form/model/agent/command/config APIs; evaluate `Service.discover` as passive hint; avoid `Service.ensure/stop` for non-owned services).
- **Make recovery explicit and end-to-end:** detect failure class → preserve session identity → rediscover/reconnect appropriate local service → resubscribe → rehydrate/reconcile history/inbox/permissions/forms → resume or fail honestly without duplicate prompts/sessions.
- **Simplify by separating policy from mechanics:** keep TBAI ownership/security/durability policy; reduce duplicated lifecycle/state translation and split oversized modules only where it improves reliability/maintainability.

---

## B. Current behavior map (actual lifecycle traced from source)

### 1) Backend startup / target selection
- **Registration/config hints:** `src/services/opencode/registration.ts` resolves/reads/validates registration records (or explicit server config) as discovery hints; fail-closed on malformed/non-loopback/missing credential/unsupported cases.
- **Adoption attempt:** `src/services/opencode/adoption.ts` (`attemptOpenCodeAdoption`) begins attempt, reads registration/explicit config, probes candidate via origin-bound transport, checks version/capabilities (`compatibility.ts`), and installs adopted target only if still active/current.
- **Managed fallback/start:** `src/services/opencode/runtimeTarget.ts` (`resolveOpenCodeRuntimeTarget`) returns installed target if present; if unresolved and no explicit server config blocking fallback, starts managed server via `openCodeServerManager.ensureBaseUrl()` and captures/publishes managed target/transport.
- **Startup orchestration:** `src/services/opencode/startup.ts` (present; not fully quoted here) coordinates adoption-first behavior per module intent; `runtimeTarget.ts` comments indicate startup attempts adoption first so requests see installed adopted target when eligible.
- **Connection authority:** `src/services/opencode/connectionState.ts` owns target/attempt/shutdown epoch/latch and request-context capture so base URL and credential come from one snapshot.

### 2) Managed server lifecycle (TBAI-owned)
- **Spawn/readiness:** `src/services/opencode/serverManager.ts` builds `opencode serve` args, resolves binary, acquires DB lease/ownership checks (`ownership.ts`), spawns child, waits for listening announcement and HTTP readiness, probes capabilities/version as configured, installs managed target.
- **Supervision/restart:** manager tracks child records, exit handling (`onExit`), restart attempts/budget (`restartAttempts`, `maxRestartAttempts`, `resetRestartBudget`, `recoverManagedServer`), and bounded stop/wait behavior. Unexpected exits can trigger restart logic (confirmed by symbols/flow fragments); exact end-to-end behavior under all races requires runtime/test verification.
- **Shutdown:** coordinated through connection state/shutdown latch and child stop providers; must not stop non-owned/adopted services.

### 3) Adopted/existing server revalidation and fallback
- **Revalidation:** `src/services/opencode/recovery.ts` (`revalidateAdoptedTarget`) probes installed adopted target via captured transport; any response is treated as alive (including 401/500), transport failures are bounded-confirmed.
- **Confirmed loss behavior:** clears adopted target and starts managed fallback (`openCodeServerManager.ensureBaseUrl()`), then installs managed target if attempt still active. Concurrent revalidations share one in-flight promise.
- **Gap:** no rediscovery/re-adoption loop back to original local service after fallback is installed (confirmed by absence in `recovery.ts`; broader startup/revalidation paths may differ but not evidenced here).

### 4) Session lifecycle and restoration
- **Ensure/create/reuse:** `src/services/opencode/sessions.ts` resolves conversation workspace/service access, enforces engine/session/history ownership, mints caller-supplied session IDs (`generateOpenCodeSessionId`), creates/reuses sessions via official client, persists bindings, and handles stale/mismatch/imported-session cases.
- **Durability/recovery:** intent/journal/orphan recording and reconciliation paths exist (`sessions.ts`, `orphanReconciler.ts`, storage services) to handle persistence ambiguity and cleanup safely (RT-001 intent).
- **Termination:** `terminateOpenCodeSession` interrupts/removes remote session best-effort, keeps pointer on failed removal to avoid orphaning live remote session, clears binding only when remote removal confirmed gone (per code/comments).
- **Activity/history boundary:** `getOpenCodeSessionActivity` verifies conversation/session pair before querying `session.active`; `serviceAccess.ts`/`historyBoundary.ts` refuse cross-service history access and prevent managed startup for remote-bound conversations when unresolved.

### 5) HTTP boundary / browser access
- **TBAI routes:** `src/routes/opencode.ts` exposes session ensure/reconcile/terminate/activity, config read/write-policy-gated operations, commands, status, capabilities, import/importable, and a catch-all proxy.
- **Proxy:** allowlist-matched routes only (`proxyRoutes.ts`), authorization resolves session/directory scope from TBAI DB (`proxyAuthorization.ts`), strips caller-chosen scope/credentials, injects server-resolved directory and target transport credential, refuses redirects, forwards SSE/REST with diagnostics and body observation (no payload logging).
- **Browser client:** `web/src/features/opencode/v2Client.ts` wraps official `OpenCode.make` against TBAI proxy, scopes operations to session, manages generation/event reader/history reader/operations, and treats `server.connected` as stream start.

### 6) Frontend event/history/reconnect lifecycle
- **Attempt model:** `web/src/features/opencode/sync/attempt.ts` creates per-attempt readiness gate, connection/lifecycle signals, idle watchdog (aborts connection on silence to trigger reconnect path), hydration flags, retirement/failure semantics, and load promise ownership.
- **Event pipeline:** `web/src/features/opencode/sync/eventPipeline.ts` consumes stream, assigns local ordinals, buffers/coalesces events during history load, schedules reconnect with bounded exponential backoff and foreground cap, tracks retry budget/exhaustion, reports buffer overflow, and cancels pending reconnects.
- **History loading:** `web/src/features/opencode/v2History.ts` pages `message.list` via generation-bound reader with cursor cycle detection and abort support; projects messages/parts/errors/timing into normalized state.
- **Controller/orchestration:** `web/src/features/opencode/v2ThreadController.ts` (partially inspected) coordinates desired selection, load/connect, prompt admission/submission, auxiliary hydration (permissions/forms/inbox), history merge/replay decisions, and recovery actions; integrates with `v2Events.ts`, `v2Permissions.ts`, `v2Forms.ts`, `sessionBootstrap.ts`, etc.
- **Event reduction:** `web/src/features/opencode/v2Events.ts` (partially inspected) defines event identity/dedup windows, replay-only/public event sets, pending reconciliation helpers, and reducers mapping official events to thread state.

### 7) Scheduler/OpenCode execution
- **Execution adapter:** `src/services/opencode/scheduledExecution.ts` resolves conversation/service access, ensures session per strategy, submits prompt with stable ID, reconciles ambiguous prompt submission via inbox/message lookup, waits via `client.experimental.session.wait`, checks post-wait inbox/message outcomes, classifies turn outcomes, and avoids unsafe interruption semantics for shared existing conversations.
- **Durability:** scheduler store/run records persist prompt/session/outcome metadata; retries must not duplicate ambiguous submissions (design intent stated in code).

---

## C. Official API reuse map (SDK 2.2.6, verified against installed package)

| TBAI area / function | Current custom behavior | Official API (2.2.6) | Reuse classification | Notes / suitability |
|---|---|---|---|---|
| Client construction & typed calls | `OpenCode.make` wrappers, transport injection, response observation | `OpenCode.make`, generated namespaces (`session`, `message`, `event`, `permission`, `provider`, `model`, `agent`, `command`, `config`, etc.) | **REUSE OFFICIAL API (already)** / keep thin adapter | Correct boundary; keep TBAI transport/auth/origin policy around it. |
| Session CRUD/lifecycle ops | Create/get/list/remove/interrupt/active/prompt/command/compact/revert/inbox/forms used via client | `client.session.*`, `client.session.inbox.*`, `client.session.form.*`, `client.session.revert.*` | **REUSE OFFICIAL API (already)** | Continue preferring official methods over raw HTTP/proxy-only logic internally. |
| History/messages | `client.message.list` paging/reconciliation | `client.message.list` | **REUSE OFFICIAL API (already)** | TBAI reconciliation/merge remains custom but should consume official history as authority. |
| Event subscription | `client.event.subscribe` wrapped in v2 client/generation | `client.event.subscribe` (AsyncIterable, `signal`, `onActivity`) | **REUSE OFFICIAL API (already)** | Keep TBAI buffering/reconnect/reconciliation logic; do not replace with custom SSE parser. |
| Permissions/forms | List/reply flows via official client | `client.permission.*`, `client.session.form.*`, `client.form.list` | **REUSE OFFICIAL API (already)** | UI/state projection custom; API usage should remain official. |
| Model/provider/agent/command discovery | `capabilities.ts`, `commands.ts`, `sessionModel.ts`, routes | `client.model.list/default`, `client.provider.list/get`, `client.agent.list/get`, `client.command.list`, `client.skill.list` | **REUSE OFFICIAL API / SIMPLIFY** | Reduce custom polling/translation; keep capability snapshot and TBAI selection policy. |
| Config read | Config document/proxy/status flows | `client.config.get`, `client.config.shells` | **NEEDS VERIFICATION / SIMPLIFY** | TBAI currently uses server-reported document paths/redaction/write-policy constraints; compare official config APIs vs file-document behavior per mode before replacement. |
| Config write | Targeted permission edits via document rewrite, often refused by policy | `client.experimental.config.update` | **KEEP ADAPTER / NEEDS VERIFICATION** | Policy/ownership/safety constraints dominate; official API may not satisfy TBAI’s structural-preservation and managed/adopted write rules. |
| Experimental session wait/log/stats/import/export/skill/instructions | Scheduler wait migrated; others unused in active app code | `client.experimental.session.wait/log/stats/import/export/skill/instructions.*` | **REUSE OFFICIAL API where needed** | `wait` correctly reused; adopt others only with verified product need. |
| Passive local service discovery | Custom registration file read/validation (`registration.ts`) | `Service.discover()` (`@opencode/client/service`) | **KEEP SMALL ADAPTER / NEEDS VERIFICATION** | `discover` is passive and may reduce file-parsing duplication, but TBAI must still enforce loopback/origin/credential/ownership/capability policy and cannot trust discovery as authority. |
| Service ensure/start/reuse/replace | Managed startup/supervision (`serverManager.ts`, `startup.ts`) | `Service.ensure()` | **KEEP CUSTOM (managed mode) / DO NOT REPLACE BLINDLY** | `ensure` can start/reuse/replace services; unsafe for non-owned/adopted targets and may conflict with TBAI DB ownership, readiness, and lifecycle invariants. Possible limited internal reuse only if proven equivalent and ownership-safe. |
| Service stop/terminate | Managed child stop/shutdown logic; adopted services never stopped | `Service.stop()` | **KEEP CUSTOM / DO NOT USE on non-owned** | `stop` terminates registered process; TBAI must never stop foreign/adopted servers. Managed shutdown already has ownership-aware controls. |
| Service auth headers helper | `getOpenCodeAuthHeaders`/transport credential handling | `Service.headers()` | **NEEDS VERIFICATION** | May simplify header construction, but TBAI’s origin-bound transport and “credential never separated from origin” invariant must remain explicit. |
| Service fallback path helper | Custom path resolution logic in places | `Service.fallback()` | **NEEDS VERIFICATION** | Potentially useful for diagnostics/default-path hints only; not an authority. |

**Key conclusion:** Reuse official **data/session/event APIs broadly** (already mostly done). Reuse official **service lifecycle helpers selectively**: `discover` possibly as guarded input; `ensure/stop` only where TBAI proves ownership and equivalent safety semantics (likely managed-only, if at all).

---

## D. Reference application findings (evidence-based, sampled)

> Commit SHAs (local clones): OpenChamber `0056bf6a9ca4aa229817af5bf37533f602a16cc3` (`D:\Temp\openchamber`), Paseo `0e400225196a1fbbddcc174bc87eb56abbf019cf` (`D:\Temp\paseo`), CodeG `39fe4cc0950e9fab65aa1a04ed85db8614ce3d53` (`D:\Temp\codeg`). `D:\Coding\OpenChamber|Paseo|Codeg` were not git repos. VS Code source not locally inspected.

| Reference | Commit / source | Problem solved | Observed pattern (sampled) | Why it applies to TBAI | Recommendation |
|---|---|---|---|---|---|
| OpenChamber | `0056bf6a` — `packages/ui/src/lib/opencode/client.ts` (inspected header/early sections), `packages/ui/src/sync/event-pipeline.ts` (inspected header/early sections), requested refs also include `provider-tracker.ts`, `session-message-loader.ts`, `sync/DOCUMENTATION.md` (not fully read here) | Robust SDK usage, transport/error normalization, stream/event handling, history reconciliation | Client wrapper centralizes official SDK calls, runtime-aware transport, error normalization, projection; event pipeline translates/coalesces/batches wire events and separates transport concerns from reducer validity decisions (per inspected headers/comments) | TBAI already has similar boundaries (`client.ts`, `v2Client.ts`, `eventPipeline.ts`, `v2History.ts`) but larger/more fragmented; validates “thin official-client wrapper + explicit sync pipeline + reconciliation” approach | **Adopt pattern (simplify):** keep official SDK central, formalize error/transport classification and pipeline/reducer responsibilities; do not copy OpenChamber-specific runtime/provider architecture blindly |
| OpenChamber | same commit — `packages/docs/content/docs/opencode-server.mdx`, `troubleshooting/opencode-connection.mdx` (paths confirmed) | User-facing connection clarity | Explicit server connection/troubleshooting documentation and workflows | TBAI needs clear local managed/adopted/external-local states and recovery actions | **Adopt concept:** improve status/recovery UX and diagnostics taxonomy (P3), without coupling |
| Paseo | `0e400225` — `packages/app/e2e/browser/background-reconnect.spec.ts` (inspected), `docs/opencode-global-event-baseline.md`, `packages/server/src/server/agent/providers/opencode-agent.recovery.test.ts`, `opencode-agent.error-handling.real.e2e.test.ts` (paths confirmed, not fully read) | Recovery after daemon/server restart while tab hidden; session/error recovery validation | E2E test hides tab, restarts host daemon, expects websocket reconnect while hidden and remains online on refocus (`background-reconnect.spec.ts`) | Directly relevant to TBAI requirement: hidden tab/background restart recovery without reload and without unnecessary repeated reconnect storms | **Adopt pattern:** add/align acceptance tests and runtime behavior for hidden-tab restart/reconnect and foreground resume; verify TBAI’s visibility/online backoff and rehydration semantics |
| Paseo | same commit — `packages/app/src/screens/settings/daemon-reconnect.ts`, session/import/model-switch/rewind specs (paths confirmed) | Reconnect UX and session continuity scenarios | Dedicated reconnect handling and scenario-specific tests for import/model switch/rewind/error cases (inferred from file names/locations; details not fully inspected) | Useful scenario catalog for TBAI recovery matrix and regression tests | **Adopt selectively:** scenario coverage ideas; reject any multi-host/daemon topology assumptions not needed for local-only TBAI |
| CodeG | `39fe4cc0` — `src/hooks/use-connection-lifecycle.ts` (inspected header/early sections), `src/lib/transport/web-event-stream.ts`, `src/lib/transport/web-connection-store.ts`, `src/components/chat/connection-status.tsx`, `src/lib/opencode-connect.ts` (paths confirmed) | Connection lifecycle, reattach, avoid unnecessary session/agent creation, status UX | Lifecycle hook centralizes connect/disconnect decisions, viewer/owner semantics, transient unmount handling, and busy-work-aware teardown (inspected early logic/comments) | TBAI has similar concerns in frontend runtime/controller and session reuse; reinforces “do not tear down/recreate on transient UI changes; preserve live work/session identity” | **Adopt concept:** explicit lifecycle state machine/guards and user-visible connection states; reject CodeG remote workspace/transport architecture |
| CodeG | same commit — `src-tauri/src/acp/opencode_*.rs`, `src/components/settings/opencode-*.tsx` (sampled paths) | OpenCode config/connect/permissions integration boundaries | Typed domain modules for connect/config/permissions/plugins/credentials (sampled) | Supports TBAI’s need for clear config/credential/permission boundaries and redaction | **Adopt concept:** domain separation and explicit policy boundaries; not implementation reuse |
| VS Code | **Not code-inspected locally** (no clone/source reviewed) | Startup/window restoration, background task lifecycle, status/retry UX, state ownership/disposal | General patterns only (not verified in source here): restore state on restart, clear status/progress ownership, command-driven retry, dispose/reconnect lifecycles | Relevant as reliability/UX principles for TBAI’s local app lifecycle and recovery feedback | **Adopt concept only, with caution:** no code-level claims; validate against TBAI needs before implementation |

---

## E. Failure/recovery matrix

| Scenario | Existing TBAI behavior (confirmed/inferred) | Official OpenCode support (SDK 2.2.6 / installed types) | Reference pattern | Current gap | Recommended behavior |
|---|---|---|---|---|---|
| Event stream disconnected | **Confirmed:** frontend `eventPipeline` schedules reconnect with backoff/budget, retires attempts, reports failures; `attempt` aborts/settles on failure (`sync/eventPipeline.ts`, `sync/attempt.ts`). | `event.subscribe` AsyncIterable ends/errors; caller controls reconnect/resubscribe. | OpenChamber event pipeline separation; Paseo hidden-tab reconnect tests; CodeG lifecycle/status patterns. | End-to-end guarantee (resubscribe + history/inbox/permission/form reconciliation without duplication) needs scenario verification. | Detect disconnect, show reconnecting, resubscribe, rehydrate authoritative session/history/inbox/permissions/forms, dedupe by IDs/identity, no reload. |
| SSE stream silent | **Confirmed:** `attempt.ts` arms idle watchdog on stream activity and aborts connection on silence to trigger reconnect path (not terminal failure). | `event.subscribe` supports `onActivity` (keepalive chunks) in installed client types. | OpenChamber stream activity monitoring (requested ref; concept aligned). | Threshold correctness and interaction with hidden tabs/background throttling need verification. | Treat missing activity (not just missing events) as stale; reconnect and reconcile; avoid false positives during legitimate quiet periods. |
| Existing server restarted | **Confirmed (adopted):** `recovery.ts` probes adopted target; on confirmed loss clears target and starts managed fallback. **Gap:** no rediscovery/re-adopt of original service after return. **Managed:** `serverManager.ts` supervises/restarts owned child (confirmed by restart logic symbols). | `server.info`, session/message/event APIs available after reconnect; `Service.discover` passive; `Service.ensure/stop` lifecycle-controlling. | Paseo background reconnect/restart scenarios. | Original external local service may be abandoned after fallback; session continuity across service switch/return unproven. | Prefer rediscover/reconnect to same compatible local service and same session; only fallback when recovery impossible; never stop non-owned server; make service switch explicit and safe. |
| Existing server port/registration changes | **Confirmed:** registration read/validation and adoption probe exist (`registration.ts`, `adoption.ts`); explicit config path supported in adoption logic. **Unverified:** automatic rediscovery when port/registration changes after loss. | `Service.discover` reads registered service info (passive); server info/capabilities via API. | OpenChamber connection troubleshooting emphasis (concept). | No evidenced continuous rediscovery loop for changed registration/port in adopted recovery path. | On loss, periodically/triggered passive rediscovery (bounded/backoff), validate origin/credential/capability/history owner, then reattach; fail clearly if unsupported. |
| Managed server crashes | **Confirmed:** `serverManager.ts` tracks exits and restart attempts/budget/reset/recovery paths. | N/A (TBAI owns process); OpenCode APIs usable after restart. | Standard supervised-process restart. | Full restart correctness (session rebind, state publication, no duplicate children) needs verification. | Auto-restart owned child with bounded backoff/budget, republish target, revalidate capabilities, rehydrate active sessions/UI state. |
| TBAI restarts, server remains running | **Confirmed:** session IDs/bindings persisted in TBAI DB; startup/adoption/runtime target resolution can attach to existing/adopted/managed contexts; service/history ownership enforced. | `session.get/list`, `message.list`, `event.subscribe`, `session.inbox.list`, `permission/form` APIs. | CodeG reattach-to-existing-session concept; Paseo session attachment tests (paths). | End-to-end restoration of pending permissions/forms/inbox/interrupted generation state unverified. | Reuse persisted conversation→session binding, resolve authorized service, rehydrate history and pending interactive/inbox state, resubscribe; create new session only if missing/invalid. |
| Browser tab becomes hidden | **Confirmed:** reconnect delay policy in `eventPipeline.ts` uses visibility/online conditions (`readReconnectConditions`, foreground cap vs hidden/offline cap). | N/A (client behavior). | Paseo hidden-tab reconnect test. | Actual timer throttling/behavior and unnecessary reconnect suppression/duplication need runtime verification. | Reduce probe aggressiveness while hidden; keep state consistent; avoid reconnect storms; rely on activity/watchdog and foreground resume. |
| Browser returns to foreground | **Inferred/partial:** visibility-aware delay logic exists; controller/runtime hooks not fully traced here. | N/A. | Paseo refocus after hidden reconnect. | Explicit foreground-triggered health check/reconcile path not fully confirmed. | On visibility/focus regain, verify stream/session health, reconnect if stale, and reconcile history/pending state promptly. |
| Session ID no longer exists | **Confirmed:** session mismatch/stale/import-missing handling exists (`sessions.ts`, `routes/opencode.ts`, `errors.ts`); history boundary/service access checks enforced. | `session.get`/related calls return not-found errors (SDK typed/tagged errors). | N/A specific. | Automatic recreation policy must avoid silent orphan/duplicate and preserve user intent/history expectations. | Surface actionable state; only create/rebind when safe and explicitly justified; never duplicate transcript; preserve draft and offer continue/new-session choice as appropriate. |
| History read fails temporarily | **Confirmed:** history loader throws on abort/cursor issues; pipeline/controller have failure/retry paths (partially inspected). | `message.list` available; transient transport/server errors possible. | OpenChamber history reconciliation emphasis. | Retry classification and UI state (“reconnecting” vs “history unavailable”) need verification. | Retry transient reads with backoff, keep last known good transcript, reconcile when successful; do not mark recovered without authoritative history. |
| Model catalogue temporarily empty | **Confirmed:** `capabilities.ts` includes bounded “catalogue loading” window/polling behavior (inspected header/early logic). | `model.list`, `provider.list`, `model.default`. | N/A specific. | Interaction with selected model/variant and prompt readiness needs verification. | Treat early empty as loading within bounded window; refresh; preserve explicit user selection; fallback to server default only when appropriate. |
| Selected model disappears | **Confirmed/inferred:** model resolution/default helpers exist (`sessionModel.ts`, `capabilities.ts`); full invalidation flow not fully traced. | `model.list/default`, session/model selection APIs. | Paseo/CodeG model/provider integration scenarios (paths). | Automatic reselection may silently override user intent; behavior unverified. | Revalidate selection on refresh/reconnect; if unavailable, keep conversation/history, explain clearly, suggest available/default options, do not infinite-retry sends. |
| Provider returns 429/5xx | **Partially confirmed:** error normalization/classification utilities exist (`errors.ts`, frontend `clientErrors.ts`); scheduler/execution classify outcomes; generic retry policy across chat prompts not fully traced. | Provider/runtime errors surface via OpenCode responses/events/session execution states. | OpenChamber provider tracking/error normalization (requested ref). | Distinction between transient retryable vs permanent/actionable vs prompt-ambiguous not fully evidenced end-to-end. | Classify by error/status/event semantics; bounded retry for transient cases; no duplicate ambiguous prompt; actionable UI for auth/config/permanent failures. |
| Provider credentials fail | **Inferred:** provider/config surfaces exist; specific recovery UX/flow not fully traced. | Provider/config APIs expose state; auth failures surfaced by runtime. | CodeG connect/config UX patterns. | May lack clear recovery action/state refresh path. | Stop automatic retries, mark actionable auth/config error, preserve draft/session, offer refresh/reconfigure/retry action. |
| Prompt submission response is lost | **Confirmed (scheduler):** `scheduledExecution.ts` reconciles prompt submission via inbox/message lookup and avoids duplicate side effects. **Frontend:** prompt admission/in-flight tracking exists (`v2ThreadController.ts` references `sync/promptsInFlight.ts`), details not fully inspected. | `session.prompt`, `session.inbox.list`, `message.list` enable reconciliation. | OpenChamber ambiguous transport handling (requested ref). | Frontend ambiguous-submit behavior must be verified to never auto-resend same prompt. | Treat unknown delivery as ambiguous: reconcile by prompt/message/inbox IDs; never auto-resubmit same logical prompt; surface “checking/sent/unknown” honestly. |
| Permission/form state is missed during reconnect | **Confirmed/partial:** frontend tracks permissions/forms/inbox and hydrates auxiliary state (`v2Client.ts` ops, `v2Permissions.ts`, `v2Forms.ts`, `v2Events.ts` pending reconciliation helpers); controller performs auxiliary reads (inferred). | `permission.list/reply`, `session.form.list/reply/cancel`, `session.inbox.list`. | OpenChamber/Paseo reconciliation-oriented sync patterns. | Completeness after reconnect/replay/history merge unverified. | On reconnect/recovery, re-fetch authoritative pending permissions/forms/inbox and reconcile with event buffer/history; never drop or duplicate actionable requests. |

**Legend:** *Confirmed* = directly evidenced in inspected source; *Inferred/partial* = indicated by module names/symbols/partial reads but not fully traced; *Unverified* = requires runtime/test evidence.

---

## F. File-level recommendations

| File/component | Current responsibility | Official API available | Duplicate/custom responsibility | Recommendation | Reason |
|---|---|---|---|---|---|
| `src/services/opencode/client.ts` | Official client creation, transport wrapping, response-status observation | `OpenCode.make` | Minimal wrapper (appropriate) | **KEEP** | Correct SDK boundary; needed for TBAI transport/diagnostics. |
| `src/services/opencode/http.ts` | Origin-bound/gated transport, redirect refusal, credential scoping | SDK custom `fetch` hook only | Security policy (TBAI-specific) | **KEEP** | Essential invariant: credential bound to origin, no redirect follow. |
| `src/services/opencode/connectionState.ts` | Target/attempt/shutdown epoch/latch, request context capture | None | TBAI connection authority/state machine | **KEEP / SIMPLIFY** | Load-bearing safety core; simplify interfaces/docs, not semantics. |
| `src/services/opencode/registration.ts` | Read/validate local registration/explicit config hints | `Service.discover`, `Service.fallback` (partial) | Custom file parsing/validation/discovery hint logic | **SIMPLIFY / NEEDS VERIFICATION** | May reuse `Service.discover` as passive input, but keep strict validation, loopback/origin/credential checks, and non-authoritative treatment. |
| `src/services/opencode/adoption.ts` | Probe/validate/capability-assess/install adopted target | `Service.discover` (passive only), `server.info`, capability routes via client | Adoption policy/orchestration | **KEEP / SIMPLIFY** | Necessary for safe attach to existing local server; do not use `ensure/stop`. |
| `src/services/opencode/startup.ts` | Startup sequencing (adopt vs managed) | Partial (`Service.discover/ensure` semantics differ) | TBAI startup policy | **KEEP / SIMPLIFY** | Must encode local-only ownership policy and fallback rules. |
| `src/services/opencode/recovery.ts` | Adopted target revalidation and fallback to managed on confirmed loss | `server.info`/probe via client; `Service.discover` potentially useful | Recovery decision policy | **REFACTOR** | **P0 gap:** no evidenced rediscovery/re-adopt of original local service after return; recovery should prefer reuse before fallback. |
| `src/services/opencode/serverManager.ts` | Managed `opencode serve` spawn, listening/readiness, DB ownership, supervision/restart, shutdown | `Service.ensure/stop` (lifecycle-controlling) | Large custom managed lifecycle/orchestration | **REFACTOR / KEEP (policy)** | Keep TBAI-owned process/DB ownership guarantees; evaluate limited official helper reuse only if proven safe; split responsibilities for maintainability. |
| `src/services/opencode/ownership.ts` | DB path resolution and holder/lease checks | `opencode debug paths db` (authority) + OS APIs | Ownership enforcement | **KEEP** | Critical invariant; fail-closed. |
| `src/services/opencode/runtimeTarget.ts` | Resolve server-wide target/transport/status | None | TBAI target selection | **KEEP / SIMPLIFY** | Correct credential/origin binding point; clarify managed/adopted/unresolved transitions. |
| `src/services/opencode/serviceAccess.ts` | Conversation-scoped service access and history-owner enforcement | None | TBAI authorization/boundary | **KEEP** | Prevents cross-service history misuse. |
| `src/services/opencode/historyBoundary.ts` | Local/remote history owner model and compatibility checks | None | TBAI ownership vocabulary/canonicalization | **KEEP / SIMPLIFY** | Essential; reduce translation complexity if possible without changing persisted semantics. |
| `src/services/opencode/sessions.ts` | Ensure/create/reuse/reconcile/terminate/activity, RT-001 intent/orphan handling | `session.*`, `message.list` | Durable recovery/persistence/binding logic | **KEEP / REFACTOR** | Necessary TBAI-specific durability; split by concern (binding, create/retry, reconcile, terminate, activity). |
| `src/services/opencode/sessionModel.ts` | Model/default resolution and selection helpers | `model.list`, `model.default` | Selection policy glue | **SIMPLIFY / REUSE OFFICIAL API** | Keep user-intent/persistence policy; reduce custom derivation. |
| `src/services/opencode/capabilities.ts` | Agent/model/command/default capability discovery and loading behavior | `agent.list`, `model.list`, `model.default`, `command.list` | Polling/loading-window/cache behavior | **SIMPLIFY / REUSE OFFICIAL API** | Use official APIs as source; keep bounded UX/loading behavior only if needed. |
| `src/services/opencode/compatibility.ts` | Version/capability probing and assessment | `server.info` + route probes via client/transport | Compatibility policy | **KEEP / SIMPLIFY** | Capability-driven safety is valuable; keep evidence-based and minimal. |
| `src/services/opencode/commands.ts` | Command feed retrieval | `command.list` | Thin wrapper | **SIMPLIFY** | Keep only if it adds scoping/caching/error mapping value. |
| `src/services/opencode/configDocument.ts` | Read/write config document with structural preservation | `config.get`, `experimental.config.update` | File/document-level editing semantics | **NEEDS VERIFICATION** | Compare against official config APIs and upstream guarantees before replacement; preserve safety/refusal behavior. |
| `src/services/opencode/configRedaction.ts` | Redact config for UI/API | None | Security boundary | **KEEP** | Required. |
| `src/services/opencode/configWritePolicy.ts` | Write allow/refuse policy by runtime/mode | None | Policy boundary | **KEEP** | Required fail-closed behavior. |
| `src/services/opencode/proxyRoutes.ts` | Proxy allowlist | None | Security boundary | **KEEP** | Essential attack-surface control. |
| `src/services/opencode/proxyAuthorization.ts` | Session/directory scope authorization for proxy | None | Security/ownership boundary | **KEEP** | Prevents caller-chosen scope abuse. |
| `src/services/opencode/import.ts` | Import/list external sessions | `session.list/get`, possibly experimental import/export APIs | TBAI import workflow | **NEEDS VERIFICATION** | Validate against official APIs and ownership/history constraints. |
| `src/services/opencode/orphanReconciler.ts` | Reconcile orphan/risk-bearing session intents | None | Durability/recovery | **KEEP** | RT-001 support; verify completeness and observability. |
| `src/services/opencode/conversationDeletion.ts` | Coordinate OpenCode termination with TBAI deletion | `session.interrupt/remove` | App-level coordination | **KEEP** | Correct ownership of app deletion semantics. |
| `src/services/opencode/scheduledExecution.ts` | Scheduled turn submission/reconciliation/outcome classification | `session.prompt`, `session.inbox.*`, `message.list`, `experimental.session.wait` | Scheduler-specific execution semantics | **KEEP / SIMPLIFY** | Good official API reuse; keep ambiguity-safe reconciliation; simplify only with proof. |
| `src/routes/opencode.ts` | HTTP boundary: session/config/commands/status/capabilities/import/proxy | Official server APIs via SDK/proxy | Authz/redaction/policy/scoping/diagnostics | **KEEP / SIMPLIFY** | Necessary boundary; reduce handler complexity and duplicate mapping where possible. |
| `web/src/features/opencode/v2Client.ts` | Browser official client wrapper, scoped generation/ops/history/events | `OpenCode.make`, `event.subscribe`, session/message/permission/form APIs | Thin adapter (appropriate) | **KEEP** | Good isolation and scoping. |
| `web/src/features/opencode/sync/attempt.ts` | Per-attempt readiness/signals/idle watchdog/retirement | SDK `onActivity`/abort signals used | Attempt lifecycle state machine | **KEEP** | Important correctness primitive; well-scoped. |
| `web/src/features/opencode/sync/eventPipeline.ts` | Stream consume, buffer/coalesce, reconnect/backoff/budget | `event.subscribe` stream behavior | Sync transport/retry logic | **KEEP / SIMPLIFY** | Strong foundation; verify integration with history/auxiliary reconciliation and foreground resume. |
| `web/src/features/opencode/v2History.ts` | Paged history load and projection | `message.list` | Projection/normalization | **KEEP / SIMPLIFY** | Official history authority preserved; keep projection thin and tested. |
| `web/src/features/opencode/v2Events.ts` | Event identity/dedup/reduction to thread state | Event types/stream from SDK | Large custom reducer/projection | **REFACTOR** | Split pure reducers/identity rules from controller concerns; verify against official event semantics. |
| `web/src/features/opencode/v2ThreadController.ts` | Connection/load/prompt/recovery/permissions/forms/inbox orchestration | Session/message/event/permission/form APIs | Large custom orchestration/state machine | **REFACTOR** | Primary frontend complexity hotspot; decompose by responsibility with characterization tests. |
| `web/src/features/opencode/v2Permissions.ts`, `v2Forms.ts`, `V2FormCard.tsx`, `OpenCodePermissions.tsx`, `OpenCodeQuestions.tsx` | Permission/form/question UX and reconciliation | `permission.*`, `session.form.*` | TBAI UI/interaction logic | **KEEP / SIMPLIFY** | Keep forms/questions distinct from approvals; ensure reconnect reconciliation completeness. |
| `web/src/features/opencode/config.ts` | Timeouts/backoff/buffer constants | None | TBAI tuning/policy | **KEEP** | Centralized tuning is good; validate values against real failure scenarios. |
| `src/services/opencode/service.ts` (SDK package, not TBAI file) | Official local service discover/ensure/stop/headers | N/A | N/A | **REUSE OFFICIAL API (candidate, guarded)** | Consider only as passive/owned-use helper under TBAI invariants; not a drop-in replacement for current architecture. |

---

## G. Proposed target architecture

### Component diagram (local-first, OpenCode-native)

```text
+--------------------------------------------------------------------------------------+
| TBAI UI (web)                                                                        |
| - Chat shell/composer (shared)                                                       |
| - OpenCode feature: runtime controller, event/history sync, permissions/forms UI     |
| - Connection/recovery status + manual retry actions                                  |
+------------------------------------------+-------------------------------------------+
                                           | same-origin TBAI API/proxy (scoped, no secrets)
                                           v
+--------------------------------------------------------------------------------------+
| TBAI Backend                                                                         |
| Routes/boundary: /api/opencode/*, scheduler, conversations, workspace                |
| - allowlist + authz + scope resolution + redaction + policy                          |
+-------------------------------+-------------------------------+----------------------+
                                |                               |
                                v                               v
+-------------------------------+-------------------+   +-------+----------------------+
| OpenCode Integration (thin, policy-first)         |   | TBAI App Core (authoritative)|
| 1. Target Resolver                                |   | - SQLite app DB              |
|    - managed/adopted/unresolved                   |   | - conversations/workspaces   |
|    - passive discovery hints (guarded)            |   | - scheduler jobs/runs        |
| 2. Official Client Gateway                        |   | - settings/credentials       |
|    - @opencode/client 2.2.6 only                  |   +------------------------------+
| 3. Ownership & Boundary Guard                     |
|    - history owner/service access/proxy scope      |
| 4. Recovery Coordinator                           |
|    - rediscover/reconnect/rebind/reconcile        |
|    - RT-001 intent/orphan/prompt ambiguity        |
| 5. Capability Snapshot                            |
|    - models/agents/commands/optional features     |
+-------------------------------+-------------------+
                                | official HTTP/SSE (origin-bound transport)
                                v
+--------------------------------------------------------------------------------------+
| Local OpenCode Server (authoritative runtime)                                        |
| - sessions/messages/history/events                                                   |
| - providers/models/agents/tools/permissions/forms                                    |
| - execution state/inbox                                                              |
| Mode A: existing compatible local server (not owned by TBAI)                         |
| Mode B: TBAI-managed local server (owned by TBAI)                                    |
+--------------------------------------------------------------------------------------+
```

### Ownership boundaries
- **OpenCode owns:** AI execution, session/message/history/event truth, provider/model/agent catalogs, permissions/forms, runtime execution state.
- **TBAI owns:** UI/UX, app settings, conversation metadata/workspace/folder mapping, scheduler definitions/runs, security/policy decisions, and minimal durability adapters (session binding recovery, ambiguous prompt reconciliation).
- **TBAI must not own:** shadow transcript/runtime state that diverges from OpenCode, or lifecycle control of non-owned OpenCode processes.

### Connection lifecycle (target behavior)
1. **Startup:** load TBAI conversation/app state → resolve local target (existing compatible local service via guarded discovery/explicit config, else managed start if allowed) → validate origin/credential/capability/ownership.
2. **Session restore:** for existing conversation, reuse persisted OpenCode session ID and service/history owner; verify binding; fetch authoritative session/history/inbox/permissions/forms.
3. **Subscribe:** open `event.subscribe` with scoped directory/session context; mark connected on `server.connected`; arm activity watchdog.
4. **Operate:** send prompts/commands via official APIs; project events/history into UI; persist only TBAI-owned metadata.
5. **Detect failure:** classify disconnect/silent stream/server loss/process exit/provider/model errors/prompt ambiguity.
6. **Recover:** bounded backoff + rediscovery/reconnect (prefer same service/session) → resubscribe → rehydrate/reconcile history/inbox/permissions/forms/model state → resume or present actionable failure.
7. **Shutdown:** stop only TBAI-managed child; preserve bindings/state for restart; never terminate foreign servers.

---

## H. Prioritized improvement plan

### P0 — Reliability gaps (session continuity / reconnect / duplicate work)

| Task | Files affected | Current defect or complexity | Expected result | Dependencies | Risks | Required regression tests | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| P0.1 Adopted-service loss recovery must prefer rediscovery/re-adopt of original local service | `src/services/opencode/recovery.ts`, `adoption.ts`, `registration.ts`, `runtimeTarget.ts`, `connectionState.ts`, `startup.ts` | Confirmed loss clears adopted target and falls back to managed start; no evidenced path to rediscover/re-adopt original service after it returns | On adopted loss, attempt bounded passive rediscovery/revalidation of compatible original/local service before or alongside fallback policy; preserve session ownership/history boundary; avoid unnecessary permanent switch | Verified `Service.discover` behavior (2.2.6), registration semantics, history owner compatibility rules | Rebinding to wrong service, credential/origin mistakes, duplicate managed starts | Unit/integration: adopted restart + same registration/port, changed registration/port (if supported), rediscovery timeout then fallback, no foreign process control | Existing local server restart recovers to same session/service when contract permits; no duplicate sessions/servers; no ownership violations |
| P0.2 End-to-end reconnect + authoritative reconciliation contract | `web/src/features/opencode/sync/eventPipeline.ts`, `sync/attempt.ts`, `v2ThreadController.ts`, `v2Events.ts`, `v2History.ts`, `v2Permissions.ts`, `v2Forms.ts`, `v2Client.ts` | Strong primitives exist but full lifecycle (resubscribe + history + inbox + permissions + forms + prompt state) not proven as one contract | Single defined recovery sequence after disconnect/silent stream/reconnect: resubscribe, reload/reconcile authoritative state, dedupe, restore actionable UI | Event/history identity rules, official API semantics | Duplicate/missing messages or pending actions, stale UI marked ready | Unit tests for reducers/pipeline/attempt; integration/e2e for dropped stream, missed events, pending permission/form/inbox across reconnect | Reconnect recovers session without reload; no duplicated events/messages/prompts; pending interactions consistent |
| P0.3 Ambiguous prompt submission safety across frontend and scheduler | `web/src/features/opencode/sync/promptsInFlight.ts` (verify), `v2ThreadController.ts`, `src/services/opencode/scheduledExecution.ts`, `sessions.ts` | Scheduler reconciles ambiguity; frontend path not fully verified in this audit | All prompt sends use idempotent IDs and reconciliation-before-retry; unknown delivery never auto-resubmitted | Official prompt/inbox/message semantics, stable ID strategy | Double-send side effects or lost user intent | Unit/integration: transport drop after prompt, timeout after server receipt, retry UI behavior, scheduler/manual parity | Same logical prompt never delivered twice automatically; user sees honest state and safe manual action |
| P0.4 TBAI restart/session restore completeness | `src/services/opencode/sessions.ts`, `serviceAccess.ts`, `historyBoundary.ts`, `routes/opencode.ts`, `web/src/features/opencode/sessionBootstrap.ts`, `v2ThreadController.ts` | Bindings and reuse logic exist; pending interactive/inbox/interrupted-state restoration completeness unverified | Restart restores same conversation/session context and reconciles pending permissions/forms/inbox/history/status | Persisted binding correctness, service availability | Stale binding misuse, accidental new session creation | Integration: app restart with server running, pending permission/form, queued inbox item, interrupted generation | Same session reused; no silent orphan/new session; pending state restored or honestly reported |
| P0.5 Managed crash recovery correctness audit/fixes (evidence-driven) | `src/services/opencode/serverManager.ts`, `connectionState.ts`, `runtimeTarget.ts`, `startup.ts` | Restart supervision exists but complex; correctness under races/exhaustion/recovery not fully verified here | Deterministic single-child restart, target republish, capability/readiness revalidation, session rehydration triggers | Ownership/DB lease invariants, shutdown coordination | Duplicate processes, restart storms, stale target publication | Unit/integration: child crash, repeated crash budget exhaustion + explicit recovery, crash during startup/shutdown | Managed server recovers automatically when possible; no duplicate servers; explicit recovery when budget exhausted |

### P1 — Official API reuse and simplification

| Task | Files affected | Current defect or complexity | Expected result | Dependencies | Risks | Required regression tests | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| P1.1 Evaluate and (if safe) adopt `Service.discover` as passive hint only | `registration.ts`, `adoption.ts`, `startup.ts`, `runtime.ts` | Custom registration discovery/parsing may duplicate passive discovery | Use official passive discovery where it improves correctness/maintenance, but keep TBAI validation/policy as authority | Verified `Service.discover` semantics in 2.2.6, local-only constraints | Trusting unvalidated discovery data, credential/origin leakage | Unit tests for discovery precedence, invalid/missing/foreign records, explicit config override | No behavior regression; reduced custom parsing only where proven equivalent and safer |
| P1.2 Explicitly reject/contain `Service.ensure`/`Service.stop` misuse | `serverManager.ts`, `adoption.ts`, `recovery.ts`, docs/architecture notes | Lifecycle APIs exist and may tempt unsafe simplification | Clear internal contract: no `ensure/stop` on non-owned services; any managed-only reuse requires proof and wrappers | Ownership model clarity | Accidental termination/replacement of foreign server | Code review/tests asserting no non-owned lifecycle control paths | Foreign local servers never stopped/replaced by TBAI |
| P1.3 Consolidate model/provider/agent/command discovery on official APIs | `capabilities.ts`, `commands.ts`, `sessionModel.ts`, `routes/opencode.ts`, web config/runtime consumers | Multiple discovery/normalization paths and loading heuristics | One capability snapshot flow backed by official `model/provider/agent/command` APIs with explicit caching/refresh rules | UI loading/error states | Empty-catalog regressions, selection resets | Unit/integration: startup empty catalog window, refresh, disappeared model/provider, default selection | Accurate catalogs, stable user selection behavior, fewer custom code paths |
| P1.4 Config API alignment assessment (read/write) | `configDocument.ts`, `configWritePolicy.ts`, `routes/opencode.ts`, `OpenCodeConfigPage.tsx` | Mixed document/proxy approach; writes mostly refused | Documented decision: keep document adapter, move reads/writes to official config APIs, or hybrid—based on verified upstream behavior and TBAI policy | Official config/get/update semantics, managed/adopted constraints | Breaking config editing/viewing or leaking secrets | Unit/integration for redaction, malformed config, refused writes, adopted vs managed behavior | Simpler config path with unchanged safety guarantees |

### P2 — Refactoring and optimization

| Task | Files affected | Current defect or complexity | Expected result | Dependencies | Risks | Required regression tests | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| P2.1 Decompose `serverManager.ts` by responsibility (behavior-preserving) | `serverManager.ts`, possibly new internal modules under `services/opencode/` | 61k+ mixed concerns (spawn, listen, readiness, ownership, capabilities, restart, shutdown) | Smaller modules with explicit interfaces and unchanged invariants | P0.5 evidence, characterization tests | Lifecycle regressions | Existing + new startup/crash/shutdown/ownership tests | Same behavior, lower complexity, clearer ownership boundaries |
| P2.2 Decompose session lifecycle/recovery internals | `sessions.ts`, `recovery.ts`, `orphanReconciler.ts`, `conversationDeletion.ts` | Large stateful flows mixing binding, persistence, reconciliation, termination | Clear submodules (bind/ensure, intent-persist-reconcile, terminate, activity/reconcile) | P0.1/P0.4 decisions | RT-001 regressions, orphan leaks | Unit/integration for create ambiguity, stale/missing session, delete/terminate races | Preserved durability semantics with easier reasoning/testing |
| P2.3 Frontend OpenCode sync decomposition | `v2ThreadController.ts`, `v2Events.ts`, `v2History.ts`, `v2Permissions.ts`, `v2Forms.ts`, `sync/*` | Very large controller/reducer surface; hard to audit recovery completeness | Separated pure reducers/normalizers, transport/reconnect, admission/reconciliation, and UI controller | P0.2/P0.3 | Event ordering/replay regressions, UI desync | Reducer/pipeline/controller characterization tests, reconnect/replay scenarios | Same UX/behavior, improved maintainability and testability |
| P2.4 Canonical service identity/target model cleanup | `historyBoundary.ts`, `serviceProfile.ts`, `runtimeTarget.ts`, `serviceAccess.ts`, `connectionState.ts` | Multiple representations/translations of owner/target/profile | One canonical internal model with explicit adapters for persistence/UI/logging | Persisted key compatibility | Cross-service access bugs | Unit tests for canonicalization, compatibility, refusal cases | Fewer translation points, unchanged security/ownership decisions |

### P3 — UX improvements

| Task | Files affected | Current defect or complexity | Expected result | Dependencies | Risks | Required regression tests | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| P3.1 Honest connection/recovery status model | `web/src/features/opencode/*status*`, `v2ThreadController.ts`, `sync/eventPipeline.ts`, routes/status | Users may not distinguish connecting/reconnecting/recovering/degraded/action-required | Clear states: connected, reconnecting, rehydrating, recovered, needs action, failed (with reason class) | P0.2 state semantics | Misleading status if tied to wrong signal | UI/unit tests for state transitions; manual scenario checks | User can tell whether TBAI is retrying, recovered, or needs action |
| P3.2 Actionable recovery controls | OpenCode UI components, controller actions, routes | Automatic recovery may fail without clear next step | Safe manual actions: retry reconnect, refresh models/providers, re-open/rebind session (when safe), copy diagnostics | P0/P1 error classification | Unsafe manual actions causing duplicates | UI/integration tests for retry buttons and disabled/guarded states | Manual retry never duplicates prompts/sessions; actions match failure class |
| P3.3 Draft and in-progress work preservation UX | composer/runtime integration, prompt admission state | Recovery/errors can risk losing user input or confidence | Draft preserved across reconnect/restart/model errors; clear “not sent / checking / sent / failed” states | P0.3, frontend composer integration points | Stale draft restoration bugs | UI tests for draft persistence across reconnect/error/reload | No unsent draft loss during recoverable failures |

---

## I. Recommended implementation sequence (smallest safe sequence)

1. **P0.1 + P0.2 design spike in code-level tests/specs (no behavior change yet):** define authoritative recovery contract (detect → rediscover/reconnect → resubscribe → rehydrate/reconcile → resume/fail honestly) and adopted-loss decision tree; add characterization tests for current behavior.
2. **P0.3 prompt ambiguity hardening:** verify/enforce idempotent prompt IDs and reconciliation-before-retry in frontend path; align with scheduler’s proven pattern.
3. **P0.1 adopted rediscovery/re-adopt fix:** implement bounded passive rediscovery/revalidation before permanent fallback where supported; preserve history owner/session identity; keep managed fallback as last resort.
4. **P0.4 restart/session restore completeness:** ensure TBAI restart reuses same session and reconciles history/inbox/permissions/forms/status.
5. **P0.5 managed crash recovery verification/fixes:** close any proven gaps in restart supervision/target republish/rehydration triggers without changing ownership invariants.
6. **P1.1–P1.3 official API reuse/simplification:** guarded `Service.discover` evaluation, discovery/capability consolidation, explicit non-use of `ensure/stop` on non-owned services.
7. **P2 refactors (behavior-preserving, incremental):** decompose `serverManager`, session/recovery internals, frontend sync/controller, then canonicalize service identity model.
8. **P3 UX:** status/recovery actions/draft preservation once recovery semantics are stable.

**Sequence rule:** no refactor before P0 behavior is characterized; no API replacement without equivalence proof; no lifecycle-control API use on non-owned services.

---

## J. Open questions (only those not answerable from inspected source/installed SDK alone)

1. **Official `Service.discover/ensure/stop` runtime semantics vs TBAI invariants (2.2.6):** can `Service.discover` be safely used as a passive hint under TBAI’s origin/credential/ownership validation without side effects? Can `ensure` be constrained to TBAI-owned managed mode without replacing/controlling foreign services or violating DB ownership assumptions? (Installed JS shows lifecycle behavior; equivalence to TBAI’s safety model is unproven.)
2. **Adopted local server restart contract:** for independently started local servers, when does OpenCode publish/update registration/port information, and which start modes are discoverable without explicit config? This determines how much of “rediscover after port/registration change” is feasible automatically.
3. **Interrupted generation resumability:** what exact execution/prompt states does OpenCode 2.2.6 persist and expose after server/app restart or stream loss (running tool call, partial assistant output, queued inbox, pending permission/form), and which can be resumed vs only reconciled/displayed?
4. **Config authority path:** for managed and adopted modes, is `client.config.get`/`experimental.config.update` sufficient and safe for TBAI’s needs, or must TBAI continue document-level reads/writes for structural preservation and policy enforcement?
5. **Cross-client/shared local service behavior:** when TBAI and another local OpenCode client attach to the same compatible server/DB context, what concurrency guarantees exist for session writes/events/permissions/forms? (Must be verified upstream; TBAI must not assume safety.)
6. **Foreground/hidden-tab behavior under real runtimes:** do current watchdog/backoff settings avoid reconnect storms while still recovering promptly on visibility regain in browser and Tauri/webview environments?

---

## Acceptance criteria mapping (future implementation evidence plan)

| Criterion | Existing tests/evidence (known/likely) | Missing tests/evidence | Suitable verification approach (authorized later) |
|---|---|---|---|
| 1. Connect to already-running supported local OpenCode server | Adoption/registration/runtime target unit tests likely exist under `tests/unit/opencode/*` (not fully enumerated) | Real local server attach matrix (managed absent/present, explicit config, registration present) | Integration test with local `opencode serve`; verify no TBAI-managed spawn when adopted |
| 2. Reuse existing OpenCode session | `sessions`/history-boundary/service-access tests exist (partially known) | End-to-end UI/runtime reuse after reload/navigation/restart | Integration/e2e: persisted conversation reopened binds same session ID/history |
| 3. Create new session only when necessary | Session ensure/create logic and tests likely present | Negative cases (stale/missing/imported/mismatch) across recovery paths | Unit + integration with forced missing/stale session scenarios |
| 4. TBAI-managed OpenCode crashes and auto-restarts | `serverManager` restart logic present; tests not fully inspected | Crash/restart/rebind/rehydrate end-to-end proof | Integration: kill managed child, observe supervised restart, target republish, session continuity |
| 5. Independently started local server restarts and TBAI rediscovers/reconnects where contract permits | `recovery.ts` revalidation/fallback exists; **gap identified** | Rediscovery/re-adopt after return, port/registration change cases | Integration with externally started server restart; verify same service/session reuse or explicit fallback |
| 6. TBAI restarts while OpenCode running and restores same conversation | Persistence/binding code exists | Full restore including pending permissions/forms/inbox | Integration/e2e: restart TBAI process/app, reopen conversation, verify state reconciliation |
| 7. Event stream drops and reconnects without reload | `eventPipeline`/`attempt` reconnect primitives exist | UI-level no-reload recovery proof | Browser/e2e with forced stream close/silent stream; assert reconnect status and continued updates |
| 8. History reconciled after missed events | `v2History`, buffer/replay logic exists | Deterministic missed-event/replay correctness | Integration/e2e: drop connection during generation, reconnect, compare authoritative `message.list` |
| 9. Hidden tabs avoid reconnect storms; recover on active | Visibility-aware backoff in pipeline; Paseo pattern reference | Runtime verification in browser/Tauri, foreground resume behavior | E2e based on Paseo `background-reconnect.spec.ts` pattern adapted to TBAI |
| 10. Temporarily unavailable provider recovers without losing conversation/draft | Error classification/retry primitives partially present | Provider 429/5xx recovery flow and draft preservation proof | Integration with mocked/provider-fault injection; UI draft assertions |
| 11. Invalid model/provider config actionable, no infinite retry | Model resolution/capability logic exists | Explicit classification and terminal UX behavior | Unit/integration: missing model, invalid credentials, unsupported variant |
| 12. Ambiguous prompt submission never auto-delivered twice | Scheduler reconciliation confirmed; frontend in-flight tracking present | Frontend/manual prompt ambiguity tests | Unit/integration: drop response after server receipt; verify reconcile-only behavior |
| 13. Permissions/forms/pending inbox consistent after reconnect | Permission/form/inbox APIs and UI modules exist | Reconnect reconciliation completeness tests | Integration/e2e: trigger pending permission/form/inbox, force reconnect, verify actionable state |
| 14. One session remains one session across recovery paths | Session binding/reuse/durability logic exists | Cross-path matrix (managed restart, adopted restart, app restart, reconnect) | Scenario matrix integration suite with session ID assertions and no-duplicate checks |
| 15. No dependency on OpenChamber/Paseo/VS Code/CodeG | Architecture/docs intent; no runtime dependency evidenced | Explicit guard test/doc check if desired | Static checks/review: no imports/runtime requirements; manual run without reference apps installed |

---

## Final assessment
TBAi is **close in foundations but not yet proven as a complete, mature recovery system**. The official SDK is already the right base in most runtime/data paths, and the codebase contains substantial reconnect, supervision, and durability primitives. The highest-value work is to **close recovery lifecycle gaps (especially adopted-server rediscovery/re-adopt and end-to-end reconciliation/proof), enforce ambiguity-safe prompt behavior everywhere, and simplify around a single explicit target/recovery contract**—without weakening ownership, security, or local-only constraints. Stop here pending explicit approval for implementation.
