# TBAi — Dockview Startup Optimization Plan (lazy OpenCode activation)

**Status:** FINAL PLAN — architecture ACCEPTED by final audit; all clarifications recorded. Ready for implementation approval. Implementation NOT yet authorized.
**Date:** 2026-11-24
**Branch / commit inspected:** `ui-foundation-upgrade` @ `da556a9`.
**Evidence:** browser-side instrumentation of the running app (wrapped `fetch` + `EventSource`) plus read-only source review. All figures below are from recorded runs; where a figure varies between runs, that is stated.

## 1. Problem (measured, not guessed)

The app eagerly starts every shared conversation panel when the workspace loads. `visibleTabs()` returns all shared tabs, `DockviewWorkspace` turns them into panels, and `renderer: "always"` keeps their contents mounted. With 4 Direct + 4 OpenCode conversations open, all 8 runtimes start together.

Measured on one run (headless Chromium, port 3015):
- DOM content loaded 379ms; workspace shell visible 2764ms.
- 4 Direct panels + 4 OpenCode panels; 7 virtual scrollers.
- 195 total requests / 156 API requests.

Full API breakdown (sums to 156):
```
52  GET  /api/conversations/:id
19  GET  /api/opencode/capabilities
14  GET  /api/folders
13  GET  /api/chat/stream-status
12  GET  /api/opencode/status
10  GET  /api/conversations
 4  GET  /api/mcp/elicit/pending
 4  POST /api/opencode/session
 4  GET  /api/opencode/api/event
 4  GET  /api/opencode/api/info
 3  GET  /api/conversations/:id/messages/window
 2  each: scheduler/summary, preferences, providers, opencode/commands,
         folders/:id, logs/client(POST)
 1  each: server, preferences/stream, workspace, opencode/runtime/events,
         opencode/api/session/:id
```

**Terminology correction:** 4 `POST /api/opencode/session` are 4 **session-bootstrap operations**, not necessarily 4 newly created upstream sessions. The backend `ensureOpenCodeSession()` reuses an existing session when possible and only creates a new upstream session when required.

Counts vary between runs because the dev DB's shared membership changed as E2E tests ran (e.g. a later run had 1 OpenCode panel → 3 capabilities, 3 status, 1–2 session bootstraps). This is why the fix must be measured by request count **per activated panel**, not by an absolute total.

## 2. Root causes (source-confirmed)

### 2.1 Capabilities — request deduplication defect
`capabilitiesStore.ts` has a shared Zustand store, in-flight registry, and subscriber tracking. The defect is in the acquire path:
- `handleTargetIdentityChange()` sets `needsRefreshForTarget = true`, invalidates the in-flight request, starts a new one for the current target.
- Each `useOpenCodeCapabilities` consumer calls `acquireCapabilities()` on mount. The current consumer set is 5 per OpenCode panel (`OpenCodeChatHost.tsx:69`, `OpenCodeChipShared.tsx:27` shared by agent/model/thinking chips, `OpenCodeContextRing.tsx:28`), so 4 panels give an **expected ~20 acquisitions** (not 24 — that figure was an over-estimate).
- At startup `hasSuccessfulLoad=false` → `mustRefresh=true` → `ensureForActiveSubscribers(true)` → `startFetch(force=true)`.
- `startFetch(force=true)` refuses to join an in-flight request while `needsRefreshForTarget` is true (`capabilitiesStore.ts:269-281`), so each acquisition supersedes the previous → burst of requests to the same target.

Instrumentation confirmed the initiator stack is always `capabilitiesStore.startFetch → apiFetch`, and a single target event (`targetRevision:1, mode:managed`) produced one additional forced refresh — **not** four target changes. Session creation does not change runtime target identity.

**Fix:** concurrent consumers join an existing in-flight request when it already targets the required runtime identity and recovery epoch. **Safeguard:** a request belonging to an old or unknown target must still be superseded when the target changes — do not weaken that protection to reduce counts.

### 2.2 Status — duplicated app-wide read
`useOpenCodeRuntimeStatus` fetches `/api/opencode/status` on mount and on trigger changes (recovery epoch, connection type, target identity) — **no timer**. It is mounted by `OpenCodeStatus` in every OpenCode panel plus `OpenCodeConfigPage`. The endpoint reports the OpenCode service's status, not per-conversation status, so each panel repeats an app-wide read.

**Fix:** one shared app-level status resource; panels subscribe to its result. The shared resource contract must preserve the current hook's semantics:
- **Owner:** a single app-level module owns the one `GET /api/opencode/status` fetch and publishes the result to `useRuntimeTargetStore` (the existing store already holds target identity/status publication — `runtimeStatus.ts:123-220`).
- **Refetch triggers:** recovery epoch change, runtime-target identity change, and the connection-type/refresh signal currently passed as `refreshKey` (`OpenCodeStatus.tsx:38` passes `extras?.state.connection.type ?? "absent"`). Do not drop the connection-type trigger — a newly-connected runtime proves the lazily-started service installed a target, making the mount-time read stale.
- **Trigger coalescing — explicit shared connection-state trigger:** `refreshKey` is currently per-consumer connection state (`useOpenCodeRuntimeStatus.ts:36,98`). Individual runtime connection states must not independently cause repeated app-wide reads. Define the shared trigger concretely: the resource tracks whether **any active OpenCode consumer is connected**, and treats the transition **from no connected consumers to at least one connected consumer** as one app-wide event (one refresh). Runtime-target changes and backend recovery remain **independent** refresh triggers. Do not key the refresh on each runtime's local connection string.
- **Error state location:** `useRuntimeTargetStore` holds `status` and target identity but has **no error field** (`runtimeStatus.ts:114,123-124`). Add a typed `error` field to the shared store; keep previous status on a failed read (the current hook deliberately retains the last known mode).
- **Disabled consumers:** a consumer that is disabled must not trigger a fetch; the resource tracks active subscribers like `capabilitiesStore` does.
- **Consumer shape:** `useOpenCodeRuntimeStatus` becomes a thin selector over the shared resource (status + error), with no per-instance fetch. `OpenCodeConfigPage` and every `OpenCodeStatus` use it.

### 2.3 Lazy activation — missing OpenCode integration
The activation store added in `da556a9` activates only Direct conversations:
```
if (parsed?.kind === "chat" && parsed.ref !== NEW_DRAFT_TAB_ID) {
  activateHistoryConversation(parsed.ref);
}
```
OpenCode panels use `agent:<id>` and are excluded. Also, `OpenCodeChatHost` calls its capabilities and configuration hooks **before** returning its loading skeleton — adding a placeholder inside the component will not make it lazy; the expensive hooks and bootstrap effects must move behind the activation boundary.

### 2.4 Conversation reads — per-component duplication
`probeConversation()` is not a shared response cache. The OpenCode host, runtime, session row, and composer components independently request conversation info (52 requests / 7 ids).

**Fix:** fetch conversation configuration once and distribute through the **existing OpenCode runtime context**; preserve refresh after backend recovery and confirmed user changes. No new global cache framework.

"Session identity" here means **conversation identity/config**, NOT the OpenCode `sessionId`. The shared context must carry the **complete configuration required by all consumers**, not a partial subset:
- engine and workspace identity (`conversationId` already in `OpenCodeRuntimeContext`, plus `workspaceMode`, `workspaceFolderId`),
- OpenCode `opencodeAgent`, `opencodeModel`, `opencodeVariant`,
- **`opencodeAutoApprove`** — required by `AgentRuntime` to hydrate the permission policy (`OpenCodeChatHost.tsx:245-246`) and read independently by `OpenCodeShieldChip.tsx:132`. Omitting it would break the Auto shield.

Expose these as one typed config object on the existing runtime context. Keep the OpenCode `sessionId` (the managed session handle) as a separate field; do not conflate the two. **Move all config reads onto this shared value:** the host, `AgentRuntime`, the three composer chips, `OpenCodeShieldChip`, and `OpenCodeSessionRow` must all consume the single fetched config rather than each calling `probeConversation`/`useOpenCodeConversationConfig`. Preserve successful chip updates and backend-recovery refreshes.

### 2.5 Folders — no in-flight sharing, no loaded-data reuse
14 folder requests. `foldersStore.loadFolders()` always starts a new request (`foldersLoadEpoch++` then `apiJson`, `foldersStore.ts:79-89`) and does not join an existing load; each `OpenCodeSessionRow` calls it independently. The `foldersLoaded` flag is set but never used to skip a fetch.

**Fix requires BOTH:**
- **In-flight sharing:** concurrent callers join one in-flight load.
- **Loaded-data freshness/invalidation:** normal consumers reuse valid already-loaded data (so activating panel B after panel A's load completed does not re-fetch). Folder mutations and explicit refreshes invalidate the loaded data and force a reload. Without this, single-flight alone only solves simultaneous requests, not sequential activation.

### 2.6 Stream-status — traced in Phase 1 (necessary checks, some duplication)
Phase 1 read-only investigation (headless Chromium, wrapped `fetch`) traced the initiators. A run with 2 Direct + 1 OpenCode panels produced **5** requests (the earlier "13" was a run with more panels — count scales with open Direct panels). All 5 come from one initiator: `reconcileRecovery` in `web/src/runtime.ts`, fired from three effects — thread load (`:308`), backend-online re-check (`:329`), and the `isRunning` true→false transition (`:374`).

These are **necessary per-conversation recovery checks**, not app-wide duplication — but there is real duplication: the same conversation id is checked twice (e.g. `__LOCALID_fpZ514u` at 529ms and 720ms; `y87i8j82…` at 696ms and 721ms) because the thread-load effect and the running-transition effect both fire. This is a **Direct chat** concern; lazy OpenCode activation does not remove it.

**Scope note:** this plan primarily optimizes **OpenCode startup**. Direct panels still mount eagerly and still issue these checks. Do not claim the whole startup problem is solved by this plan. Phase 1's tracing requirement is satisfied; the before/after workspace-visible-time measurement remains a Phase 6 deliverable.

**Measurement distinction — TabStrip tab-label lookups:** `TabStrip.useTabTitle()` (`web/src/components/TabStrip.tsx:42-71`) calls `threadListAdapter.fetch(ref)` for **every visible tab, including inactive OpenCode tabs**, to render the label (and to detect a conversation deleted elsewhere). This is a **tab-label lookup**, not an OpenCode runtime/config read. Keep it **separate** in the performance tests: the requirement that dormant panels issue no runtime/config requests must not be invalidated by these legitimate label fetches. Count them in their own category, not under conversation-config or probe duplication.

## 3. Architecture boundaries (mandatory)

| Area | Required behavior |
|---|---|
| Dockview | All panels and layout remain available |
| OpenCode | Runtime starts on first activation |
| Hidden OpenCode panel | Already-started runtime remains alive |
| Session | One bootstrap per activated conversation |
| Event stream | One stream per started conversation |
| Capabilities | Shared, target-aware request deduplication |
| Status | One shared application-level resource |
| Conversation config | One read distributed to panel components |
| Folders | Shared in-flight folder-list loading |
| Direct chat | Existing runtime and history guarantees preserved |

Do **not** switch Dockview to `renderer: "onlyWhenVisible"` — it would dispose hidden runtimes and break the hidden-stream and Settings-navigation E2E guarantees. The current contract sets `renderer: "always"` at `web/src/features/workspace/dockviewController.ts:260` (asserted in `tests/unit/web/workspace/dockview-controller.test.ts`); the E2E guarantees are in `tests/e2e/workspace/dockview-workspace.spec.ts:199-253`.

## 4. Implementation phases

### Phase 1 — Measure remaining initiators (read-only, before code) — COMPLETE
- ~~Trace the 13 stream-status requests to their initiators; classify necessary vs duplicate.~~ **Done** — see §2.6: all from `reconcileRecovery` in `runtime.ts`; necessary per-conversation checks with some same-id duplication.
- Confirm the ~20 capabilities acquisitions and 12 status fetches scale with activated panel count (observed: counts scale with panel count).
- Record baseline per-panel request counts and workspace-visible timing for before/after comparison (baselines recorded in §1 and Phase 6).

### Phase 2 — Shared app-wide reads
- Capabilities: join in-flight request for same epoch/target; keep target-change supersede.
- Status: single app-level owner publishing to `useRuntimeTargetStore`; panels subscribe; coalesce consumers reporting the same app-wide transition; add a typed `error` field to the store.
- Folders: shared in-flight load **plus** loaded-data freshness/invalidation in `foldersStore` (reuse valid data; mutations/explicit refresh invalidate).

### Phase 3 — Lazy OpenCode activation

**3a. Activation contract (idempotent, keyed by canonical tab key).** Activation is a transition that makes a panel the active workspace panel. It must fire for **both** `chat:` (excluding `NEW_DRAFT_TAB_ID` — never activate the new-draft tab) and `agent:` conversations (the current code at `DockviewWorkspace.tsx:197-199` only activates `chat:` and excludes `NEW_DRAFT_TAB_ID`). Cover every origin:
- initial activation after layout restoration (`onReady` / controller `start()` reconciliation),
- deep-link route convergence (`useConversationTab` → focus controller),
- programmatic focus from Chat Threads and route navigation (`controller.focusOrOpen` → `setActivePanelById`, origin `'api'`),
- user tab clicks (`onDidActivePanelChange`, origin `'user'`).

Implement ONE idempotent activation helper called by all these paths (rather than relying on `onActivePanelChange` alone, which can miss restore/deep-link/API focus depending on Dockview event timing). The helper keys on the canonical tab key and is start-once: repeated activation of an already-active conversation is a no-op. State explicitly which path calls it and prove each with a test.

**3b. Component boundary (React Rules of Hooks).** "Move hooks behind a gate" cannot be done with a conditional hook inside `OpenCodeChatHost` — that violates the Rules of Hooks, and a placeholder rendered in the same component would still run its hooks/effects. Require a component split:
- `OpenCodeChatHost` becomes a thin gate: it reads activation state and renders either a lightweight placeholder (no OpenCode capabilities/config/bootstrap/runtime hooks) or the activated subtree.
- The activated subtree (e.g. `ActivatedOpenCodeChatHost`, containing the current capabilities/config/model hooks at `OpenCodeChatHost.tsx:69-78`, the bootstrap effect at `:99-143`, and `AgentRuntime` at `:206+`) mounts only after first activation.
- Once mounted, the activated subtree stays mounted when the panel is hidden — no dispose, no re-bootstrap on revisit.
- Add an assertion that an inactive panel issues **no** session-bootstrap, capabilities, config, or folder requests before activation.

**3c. Separate workspace-activation contract (do not overload Direct history recovery).** The existing `activateHistoryConversation` mechanism is for **Direct history recovery** and must not silently become the lifetime manager for OpenCode runtime activation. Introduce a distinct, clearly scoped workspace-activation contract (its own store/keys) for "has this OpenCode panel's runtime been started", keyed by canonical tab key. Lifecycle:
- **First activation** starts the OpenCode runtime (session bootstrap + event stream + activity publisher).
- **Hiding or moving** the panel does not stop it — the started runtime stays alive.
- **Repeated activation** of an already-started panel is a no-op (no second bootstrap).
- **Confirmed close** disposes that panel's activation state (distinct from a suspected close during a Dockview relocation — reuse the existing `confirmedRelocations`/`closedByUser` distinction in `dockviewController.ts`).
- **Cleanup must cover every panel-removal path, not just the `onPanelClose` callback.** `confirmSuspectedCloses()` deliberately skips `onPanelClose` when a panel is removed by canonical reconciliation (`dockviewController.ts:296`: `if (!this.openTabKeys.includes(id)) continue;`) — that protects externally-initiated membership changes from being treated as user closes. The activation store must therefore clear state on **genuine panel disposal** (e.g. a disposal hook on the activated subtree / panel), including canonical reconciliation removals, and must **not** rely exclusively on `onPanelClose`. **Moving or relocating a panel must never clear activation state.**
- **Reopening** the conversation starts dormant (placeholder) until it is activated again.

### Phase 4 — Conversation config distribution
- Fetch config once in the activated host; distribute via the existing OpenCode runtime context as one typed config object (see §2.4 — engine/workspace identity, agent/model/variant, and `opencodeAutoApprove`, kept distinct from the OpenCode `sessionId`).
- Move **all** config reads onto that shared value: host, `AgentRuntime`, three composer chips, `OpenCodeShieldChip`, `OpenCodeSessionRow`. No per-component `probeConversation`/`useOpenCodeConversationConfig` calls.
- Preserve successful chip updates and backend-recovery refreshes.

### Phase 5 — Tests
1. Open multiple OpenCode conversations → only the activated one bootstraps a session/stream; others show placeholders.
2. **Inactive OpenCode panel emits no session-bootstrap, capabilities, config, or folder requests before activation** (proves hooks are behind the boundary, not just visually hidden).
3. **First activation on each origin:** initial layout restore, deep link (`/code/:id`), and programmatic focus (Chat Threads / route) each start the runtime exactly once.
4. Switch between conversations → each bootstraps once on first activation, not again on revisit.
5. Hide an active conversation → stream and execution continue; no dispose.
6. Return → no duplicate session, no re-bootstrap, state intact.
7. A response continues while its panel is hidden (existing guarantee).
8. Switching back does not restart the session.
9. Changing the runtime target during a capabilities request cannot publish stale data.
10. **Shared status refetches on recovery epoch change and runtime-target identity change** (and preserves the connection-type trigger).
11. **Conversation config is fetched once per activated conversation and refreshes on backend recovery and confirmed user change.**
12. **SessionRow receives conversation identity/config from the shared context with no extra conversation probe.**
13. Capabilities/status/folder request counts stay low with N panels open (regression guards).
14. **Close-and-reopen:** confirmed close disposes the panel's activation state; reopening starts dormant (placeholder) and only starts the runtime on re-activation. Include an **externally removed panel** (canonical reconciliation removal that skips `onPanelClose`) followed by reopening the same conversation — activation state must be cleared on disposal and the reopened panel must start dormant. Moving/relocating a panel must not clear activation state.
15. **Shared status coalescing:** multiple consumers changing connection state cause one shared refresh on the no-connected → at-least-one-connected transition, not one per consumer; runtime-target changes and backend recovery still trigger independent refreshes; the shared store exposes the typed error field and failed reads preserve the last known status.
16. **Folder freshness:** activating a second panel after folders are loaded does not re-fetch; a folder mutation or explicit refresh invalidates and reloads.
17. **Complete config:** `opencodeAutoApprove` reaches `AgentRuntime` and `OpenCodeShieldChip` from the shared config; chip updates and recovery refresh still work; no component issues its own conversation probe.
18. Existing hidden-stream and Settings-navigation E2E tests still pass.

### Phase 6 — Verify
- Targeted E2E in headless Chromium, full history/Dockview specs, unit tests, typecheck/lint/build.
- **Before/after workspace-visible-time measurement** (not just API request counts): record `domcontentloaded` and `dockview-workspace` visible timing with the same panel set before and after the change. Phase 1 baseline examples: 266ms / 1649ms with 2 Direct + 1 OpenCode panels; 379ms / 2764ms with 4 Direct + 4 OpenCode panels.
- Final plan review / independent audit before commit.

## 5. Risks
- Lazy activation must not break session recovery, event delivery, or workspace persistence.
- Capabilities dedup must not publish stale data on target change.
- Status sharing must preserve recovery/target refresh.
- Conversation config distribution must refresh after backend recovery and user changes.
- Stream-status duplication is a Direct-chat concern and remains out of scope for this OpenCode-focused plan (§2.6); do not claim the whole startup problem is solved.

## 6. Definition of done
1. Independent plan audit ACCEPTED before implementation.
2. All phases implemented with tests passing.
3. Per-panel request counts measurably reduced; before/after recorded.
4. All gates exit 0 with exact numbers.
5. Full diff reviewed; committed only after verification.

## 7. Audit record
- **Audit 1 (2026-11-24, independent read-only auditor):** verdict **CORRECTIONS NEEDED**. All source claims confirmed accurate (activation excludes `agent:`; hooks run before skeleton; `startFetch` refuses to join while `needsRefreshForTarget`; status has no timer; `loadFolders` has no in-flight join; `probeConversation` is not a cache; session bootstrap reuses existing sessions; `renderer:"always"` contract). Five must-fix items were raised: (1) activation mechanism for restore/deep-link/programmatic focus; (2) component split for hook gating; (3) shared status owner contract; (4) explicit tests for the new cases; (5) clarify "session identity" as conversation identity fields.
- **Corrections applied:** §2.2 (status contract), §2.4 (identity fields), §2.1 (consumer count), §3 (renderer citation), Phase 3 (3a activation contract + 3b component boundary), Phase 4 (config wording), Phase 5 (tests 2, 3, 10, 11, 12 added).
- **Audit 2 (2026-11-24, same independent read-only auditor):** verdict **ACCEPTED** — ready for implementation approval. All 5 must-fix items resolved; no Major or Minor findings remain. One non-blocking nit raised (make the `NEW_DRAFT_TAB_ID` exclusion explicit in §3a) — applied. Boundaries, no-`onlyWhenVisible`, no-new-global-cache, Phase-1-before-code, and the 156-request breakdown all re-verified consistent.
- **Audit 3 (2026-11-24, owner-supplied independent review):** verdict **CORRECTIONS NEEDED** — 4 gaps found. All 4 verified against source by this agent: (1) `opencodeAutoApprove` missing from shared config (`OpenCodeChatHost.tsx:245-246`, `OpenCodeShieldChip.tsx:132`); (2) activation close/reopen lifecycle undefined and Direct-history vs OpenCode-runtime distinction at risk; (3) folder single-flight insufficient for sequential activation (`foldersStore.ts:79-89`, `foldersLoaded` unused); (4) shared status needs trigger coalescing and an error field (`useOpenCodeRuntimeStatus.ts:36,42,92,98`, `runtimeStatus.ts:114,123-124`). Also required: keep Phase 1 stream-status tracing, add before/after workspace-visible-time measurement, state Direct eager-mount out of scope. The audit's "file ends mid-word (`breakd`)" claim was **not reproduced** — the repo file ends cleanly at line 172; the truncation was in the pasted copy.
- **Audit 3 corrections applied:** §2.6 (Phase 1 stream-status findings + scope note), §2.2 (status coalescing + error field), §2.4 (complete config incl. `opencodeAutoApprove` + all consumers), §2.5 (folder freshness/invalidation), Phase 2, Phase 3 §3c (separate workspace-activation contract + close/reopen lifecycle), Phase 4, Phase 5 (tests 14-17), Phase 6 (before/after timing), status header.
- **Final audit (2026-11-24, owner-supplied):** verdict **ARCHITECTURE ACCEPTED** — plan ready for implementation approval subject to two clarifications plus one measurement distinction. All three verified against source by this agent: (1) `confirmSuspectedCloses()` skips `onPanelClose` for canonical reconciliation removals (`dockviewController.ts:296`); (2) shared connection-state trigger needed for status coalescing; (3) `TabStrip.useTabTitle()` fetches metadata for visible tabs incl. inactive OpenCode tabs (`TabStrip.tsx:42-71`) — a tab-label lookup, not a runtime/config read.
- **Final clarifications applied:** §3c (cleanup on genuine disposal incl. canonical reconciliation removals, not just `onPanelClose`; relocation never clears), §2.2 (explicit shared connection-state trigger: no-connected → at-least-one-connected; target/recovery independent), §2.6 (TabStrip measurement distinction), Phase 5 tests 14-15. Architecture and design decisions unchanged. Implementation still NOT authorized.
