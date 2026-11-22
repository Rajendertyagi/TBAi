# TBAi — Dockview Production Integration Plan

**Status:** implementation plan — approved in principle by owner, subject to plan audit and acceptance verification. No implementation is authorized by this document beyond the foundation work already present in the working tree.
**Date:** 2026-11-23
**Branch / HEAD inspected:** `ui-foundation-upgrade` @ `072a7bf2054ebda93c41b159255b98e2c6d46e94` (local HEAD; remote not re-verified in this task).
**Decision source:** owner approval of Dockview as workspace layout engine; evidence in `DOCKVIEW_EVALUATION_PLAN.md` and `DOCKVIEW_POC_RESULT.md`.

## 0. Working-tree state (must be resolved before implementation)

The following uncommitted work exists and must be preserved. No reset, clean, stash, or overwrite is permitted.

| Item | Origin | Disposition in this plan |
|---|---|---|
| `bun.lock`, `web/package.json` (dockview-react devDependency) | POC | Promote to production dependency in Phase 1. |
| `web/src/app/router.tsx`, `web/src/config/routes.ts` (dev lab route) | POC | Remove in Phase 3 after tests transferred. |
| `web/src/features/workspace/DockviewLab.tsx`, `DockviewOpenCodeHost.tsx`, `web/vite.poc.config.ts` | POC | Remove in Phase 3 after tests transferred. |
| `docs/workspace-redesign/DOCKVIEW_POC_RESULT.md` | POC | Keep as evidence; update in Phase 5. |
| `docs/workspace-redesign/prototype/screenshots/` | Pre-existing untracked | Preserve; never commit. |
| `docs/workspace-redesign/DOCKVIEW_EVALUATION_PLAN.md`, `WORKSPACE_ARCHITECTURE_PLAN.md` | Earlier uncommitted corrections | Preserve; update in Phase 5. |
| `web/src/features/chat/state/conversationActivity.ts`, `thread-running-dot.tsx`, `thread-last-message-time.tsx` | Foundation subagent | Keep; verify in Phase 1. |
| `web/src/features/opencode/OpenCodeChatHost.tsx`, `OpenCodeView.tsx` | Foundation subagent | Keep; fix route dependency in Phase 1b. |

**Commit sequencing:** commit POC evidence and foundation work as separate commits before production integration. Never mix them with the integration commit.

**Current-state snapshot (verified against source, not older docs):** `OpenCodeView.tsx` is **already** a thin route adapter in the working tree, and `OpenCodeChatHost.tsx` already exists with the extracted lifecycle. The activity store exists but has **no publishers yet**. The remaining OpenCode route coupling is in child components (Phase 1b), not the host. Line references in older docs may describe the pre-extraction state — trust this snapshot and the source.

---

## 1. Guiding architecture

```
Chat Threads (persistent navigation)   Dockview (spatial layout owner)
  useConversationsList (HTTP)            panels · groups · tabs · splits
  chatTabs (canonical identity)          resize · DnD · serialization
  activity projection (status/health)
        |                                       |
        +---------- canonical tabKey -----------+
                   chat:<ref> / agent:<ref>
                        |
              TBAi CONTENT HOSTS (Dockview panel components)
              DirectChatHost / OpenCodeChatHost / future types
                        |
   AuiProvider extends={null} + AssistantRuntimeProvider (per host)
```

**Mandatory boundaries:**

1. Dockview owns spatial layout only. No second recursive layout tree, geometry engine, splitter system, or workspace DnD alongside it.
2. `chatTabs` remains the sole canonical conversation identity and shared-membership system. Dockview panel ids derive from canonical tab keys; panel params carry only serializable identity (`tabKey`, `contentType`).
3. Direct and OpenCode remain separate execution systems. Never merge runtimes; never import OpenCode internals into generic Dockview infrastructure.
4. The activity projection owns Sidebar execution status and transport health. `lastMessageAt` stays HTTP-owned.
5. TBAi owns layout versioning, migration, and device-local persistence policy.
6. Never store runtime instances, React components, message history, credentials, or absolute paths in Dockview layout state.

---

## 2. Phase 0 — Protect and verify existing work

- Confirm branch/HEAD and remote; `git status --short` (done above).
- Review the four subagent files against the plan; typecheck them independently (`cd web && bunx tsc --noEmit`).
- Commit POC evidence (`DOCKVIEW_POC_RESULT.md`, lab files, dev route) as one evidence commit.
- Commit foundation work (activity projection, OpenCode host extraction) as one foundation commit.
- Do not proceed until both commits are clean and gates pass.

---

## 3. Phase 1 — Foundation completion

### 1a. Dependency promotion (blocking)
- Move `dockview-react` from `devDependencies` to `dependencies` in `web/package.json`; update `bun.lock` via a **clean** `bun install` (not an incremental add).
- Record both the expected version (`^8.9.1`) and the **resolved** version from the lockfile in the implementation report; do not claim `8.9.1` without reading the lockfile.
- Verify against `AGENTS.md` dependency/context integrity rules: single effective `react`/`react-dom` instance, single assistant-ui context instance in the active path, no undeclared transitive imports, and **no** Vite dedupe/alias/override workaround.
- Add a short dependency note to the ADR (Phase 5) recording the resolved version and the integrity checks performed.

### 1b. De-route OpenCode children (blocking prerequisite for Phase 2)
Verified route coupling in `web/src/features/opencode/` (grep `useParams`/`useNavigate`):
- `OpenCodeSessionRow.tsx:4,76` — `useParams().agentId`
- `OpenCodeAgentChip.tsx:3,23` — `useParams().agentId`
- `OpenCodeModelChip.tsx:4,25` — `useParams().agentId`
- `OpenCodeThinkingChip.tsx:3,22` — `useParams().agentId`
- `OpenCodeShieldChip.tsx:4,124` — `useParams().agentId`
- `OpenCodeView.tsx:4,15-16` — route adapter (allowed to keep params)
- `OpenCodeImportDialog.tsx:4,51` — `useNavigate` (review; keep only if router-context-safe and not dependent on the current agent route)

Inside a Dockview panel outside `/code/:agentId`, `useParams()` returns the active route's params — wrong or undefined identity. `OpenCodeChatHost` currently renders `OpenCodeSessionRow` with no conversation prop (`OpenCodeChatHost.tsx:306`), and chips are composed by `OpenCodeChipsAndRing.tsx`.

Required work:
- **Name the contract explicitly:** add `conversationId` to `OpenCodeRuntimeContextValue` (`opencodeRuntimeContext.ts:17-45` currently includes `sessionId`, `reconcileAutoApprove`, `directory`, `providerID`/`modelID`/`variant`, `compact`, `setDesiredSelection`, `reconcileStagedRevert` — but no `conversationId`). Have `OpenCodeSessionRow` and the four chips read it from `useOpenCodeRuntimeContext()`. Chips are rendered through `OpenCodeChipsAndRing` inside the shared `Composer` (`Composer.tsx:44,589-591`), so the context path is what keeps shared `ChatWindow`/`Composer` props engine-neutral — do not prop-drill OpenCode identity through shared components.
- Keep `OpenCodeView` as the **only** route adapter reading params.
- Review `OpenCodeImportDialog` navigation; inject a callback if it depends on the current agent route.
- Acceptance: `OpenCodeChatHost` renders session row + all chips with correct conversation identity both on `/code/:agentId` and in a non-route Dockview test harness. Add this as a permanent test (Phase 4).

### 1c. Activity projection — publishers are blocking (not shape verification)
Current state: `conversationActivity.ts` exists with the correct shape (`{ execution, health, updatedAt, engine }`, keyed by canonical conversation id, no message text/timestamps/credentials), `ThreadRunningDot` reads the projection via `useConversationExecution` (`thread-running-dot.tsx:1,14`), and `ThreadLastMessageTime` is HTTP-only. **But there are no publishers** — grep finds no `useConversationActivityStore.publish(...)` call outside the store file. With no publisher the projection stays at its default, so Sidebar running/stopping indicators would never activate — a visible regression. Do not mark 1c complete on shape alone.

Required work:
- Add Direct publisher: `running` from `thread.isRunning`; terminal `completed`/`failed`/`cancelled` from authoritative runtime status only.
- Add OpenCode publisher: `running` from `projection.hasActiveSessionWork`; `health: "degraded"` from `projection.health.degraded`; `pendingLifecycle.cancellationPending` → `execution: "stopping"` (never terminal until confirmed); terminal states from authoritative evidence only.
- Rule: no publisher entry → `unknown` / static fallback, **never** fabricated `idle`. Never publish `idle` on hide or unmount — backend execution continues detached (`src/services/chat-runs.ts:189-193`).
- Add tests for all transitions: running, stopping, completed, failed, cancelled, degraded health, and no-publisher fallback.
- Cleanup: `ThreadLastMessageTime` still accepts an unused `remoteId` prop (`thread-last-message-time.tsx:12-18`), passed by `SidebarThreadRow.tsx:229-230` (grep for any other callers). Remove it from the prop type and all callers in the phase touching this component, or document why it is retained.

### 1d. OpenCode host verification
- Verify `OpenCodeChatHost` preserves full lifecycle: bootstrap, config/model/agent, timeout/retry, recovery-epoch reconnect, auto-policy, first-prompt handoff, isolation boundary, ChatWindow agent extras, permissions/forms/terminal/diff, DevToolsGate.
- Verify `OpenCodeView` is a thin route adapter with validation and redirect only.

---

## 4. Phase 2 — Dockview workspace core

### 4a. Panel components
- `DirectPanel` wraps `DirectChatHost`; `OpenCodePanel` wraps `OpenCodeChatHost`.
- `renderer: "always"` for all chat panels.
- Panel id = canonical `chat:<ref>` / `agent:<ref>`; params = `{ tabKey, contentType }` only. Dockview types `Parameters` as `{ [key: string]: any }` (`panel/types.d.ts:6-8`), so serializability is **not** type-enforced — enforce it at the TBAi boundary (typed params + runtime validation). Non-serializable params break `toJSON()`/restore.
- One host per conversation id; reconciler prevents duplicate mounts.
- **Direct host config/data-UI parity (blocking):** `DirectChatHost.tsx:9,33` currently uses `AuiConfig({})` and mounts no data UIs, while the root AppShell provider registers `Tools({ toolkit: appToolkit })`, `Suggestions([...])`, and mounts `TbaiProgressDataUI` / `TbaiCompactDataUI` (`AppShell.tsx:55-63,159-170,229-231`). Production Direct panels (and the draft-aware host from §5a) must have the same tool renderers, suggestions, progress stages, and compaction divider. Define one shared Direct config/data-UI contract used by every Direct host; decide explicitly whether data UIs mount per host provider or in one safe location. Do not ship a Direct panel with `AuiConfig({})`. Add a test that a Direct panel renders tool UI and progress/compact data UIs.
- **Direct panel composition parity (blocking):** the routed Direct view renders `ChatHeader` + `ChatWindow` (`ChatView.tsx:20-27`), but `DirectChatHost` renders only `ChatWindow` (`DirectChatHost.tsx:39-45`). `ChatHeader` provides rename/archive/delete/copy-id/open-in-code/new-chat actions and depends on assistant-ui hooks (`ChatHeader.tsx:4,64,120-130,154-244`). Specify that each Direct panel includes `ChatHeader` (or a named equivalent) **inside the same per-host assistant-ui provider** as `ChatWindow`, with defined behavior for draft vs bound conversations. Add a Phase 4 assertion that Direct panels expose the required conversation header/actions targeting the correct conversation.

### 4b. Workspace controller (`DockviewWorkspace`)
- Hosts `DockviewReact` with registered components; proper flex sizing (`min-h-0`, `min-w-0`, actual height).
- `onReady`: register panels from canonical open conversations; restore saved layout.
- `onDidMovePanel`: relocation tracking only — never treat as close, never remove shared membership. Payload is `MovePanelEvent { panel, from, to }` (`dockviewComponent.d.ts:129-137`).
- `onDidAddPanel`/`onDidRemovePanel`: **never infer a conversation close from these alone.** Official docs (https://dockview.dev/docs/core/events) state add/remove fire during moves (remove then add); the installed 8.9.1 bundle instead suppresses component-level add/remove forwarding while `_moving` is set in `movingLock` (`main.cjs.js` ~19000-19008, ~19600-19605). These two sources disagree — therefore: use `onDidMovePanel` for relocations, treat add/remove as structural signals only with idempotent reconciliation against canonical `chatTabs`, and add a **version-pinned regression test** against the resolved 8.9.1 behavior. Do not rely on either interpretation without that test.
- **Definitive panel-close detection (blocking).** Never apply close semantics from `onDidRemovePanel` alone. Required procedure for every suspected close:
  1. Identify relocations via `onDidMovePanel` and the settled layout mutation events (`onDidMutateLayout` with `kind: 'move'`); a move is never a close.
  2. For a suspected close, wait until the structural mutation has settled (do not act on the intermediate add/remove pair emitted during a move).
  3. Confirm the panel is **genuinely absent** from Dockview's current registry using `api.getPanel(id)` and `api.panels` (`component.api.d.ts:562,625`).
  4. Only then apply the intended close behavior and reconcile with canonical `chatTabs`.
  This protects conversations from being closed, or their runtimes disposed, merely because a panel was relocated. Add regression coverage for move-then-check and genuine-close paths.
- `onDidLayoutChange`: persist layout. Payload is `{ reasons: ReadonlySet<'geometry'|'structure'|'activePanel'|'panelTitle'|'panelParameters'> }` (`types.d.ts:42-47`) — persist only relevant reasons, debounce/coalesce, and ignore writes while applying `fromJSON`. Use `onDidLayoutFromJSON` (`component.api.d.ts:416`) to clear the restore guard. Mutation boundary events `onWillMutateLayout`/`onDidMutateLayout` (with `kind` incl. `move`/`load`) are available if a transaction-aware guard is needed.
- Visibility: there is **no** `DockviewApi.onDidVisibilityChange`. Use `panel.api.onDidVisibilityChange` (`panelApi.d.ts:20,80-82`) or `IContentRenderer.onShow/onHide` (`dockview/types.d.ts:34-36`) to pause only optional visual work; never pause execution, streaming, or subscriptions. Hidden `renderer: "always"` panels keep browser-driven work running unless explicitly paused.

### 4c. Layout persistence
- Versioned localStorage record wrapping `toJSON()`; `migrate` + validation.
- Reconcile saved panel refs against `chatTabs`; drop stale/deleted conversations; safe default layout.
- Persist split sizes, group structure, panel placement, active selections — identity/spatial only.
- In-session restore uses `fromJSON(data, { reuseExistingPanels: true })` to preserve live instances; cold restore creates fresh runtimes. `reuseExistingPanels` is optional (`component.api.d.ts:625-627`) and reuses **compatible** existing panel instances — it is not a guarantee. Use it only with stable panel ids/components and serializable params; do not assume reuse. Guard against layout writes during restore and reconcile restored panel refs against `chatTabs` afterward.

---

## 5. Phase 3 — Application integration

### 5a. AppShell / root-runtime migration (CRITICAL — design must be settled before code)

**Why this is critical:** today `AppShell` owns three coupled responsibilities that cannot simply be deleted:
- The root `AssistantRuntimeProvider` + `runtime = useAppChatRuntime(threadListAdapter, runtimeThreadId, handleThreadIdChange)` (`AppShell.tsx:112-128,229`). The Sidebar and routed `ChatView` read this ambient runtime.
- **Draft materialization**: `handleThreadIdChange` calls `state.resolveDraftId(id, engine)` for the draft tab, or `state.presentChat(id)` otherwise (`AppShell.tsx:115-126`). This is the "one draft materializes exactly once" path.
- Route binding: `runtimeThreadId` derives from the active chat tab (`AppShell.tsx:112-113`); `<Outlet />` renders the routed `ChatView`/`OpenCodeView` (`AppShell.tsx:271`); `TabUrlSync` owns URL sync (`AppShell.tsx:298`).

`DirectChatHost` deliberately uses `noopThreadIdChange` (`DirectChatHost.tsx:12,40`) — it cannot materialize a draft. So removing the root provider without a replacement breaks first-send draft materialization, `/chat/:id` deep links, URL sync, and leaves no AuiProvider for route-driven chat surfaces.

**Required design decisions (settle and document each before implementation):**
1. **Draft materialization owner.** Decide where `resolveDraftId` runs after the root runtime is removed. Recommended: a dedicated draft-aware Direct host variant that wires the runtime's thread-id-change callback to `resolveDraftId` (mirroring `handleThreadIdChange`), mounted only for the `chat:new` panel. Never let a generic `DirectChatHost` materialize a draft.
2. **Route → panel mapping.** Define how `/chat/:threadId`, `/chat/new`, and `/code/:agentId` map to Dockview panel focus/open. Recommended: a single route-effect controller that, on route change, focuses the matching panel if open, otherwise opens it via the canonical tab key; `useConversationTab` validation stays in the route adapter.
3. **URL/focus ownership.** Name one controller that owns URL ↔ focused-panel convergence. Recommended: `chatTabs.localActiveKey` remains the URL-authoritative window-level selection; the controller sets it from Dockview's active-panel change and reads it to drive focus. Per-group active tabs remain Dockview-owned and are **not** written to `localActiveKey`.
4. **Sidebar activity source.** Confirm the activity projection (Phase 1c) fully replaces ambient runtime reads before the root provider is removed; otherwise Sidebar status regresses.
5. **Staged migration.** Keep the existing route behavior working until Dockview owns it: first render `DockviewWorkspace` alongside the current surface, migrate draft/route/focus ownership with tests, then remove the root provider and `WorkspaceSurface` only after all Phase 4 integration tests pass. Do not remove the provider in the same change that introduces Dockview.
6. **Router / shell end state (define before code).** Today `/chat/:threadId?` renders `ChatView` inside `ChatShell` under AppShell's root provider (`router.tsx:47-60`; `ChatView.tsx:20-27`), `/code/:agentId?` renders `CodeShell` → `OpenCodeView` (`router.tsx:167-173`), settings/scheduler/etc. render under `ChatShell`, and `TabUrlSync` navigates on `localActiveKey` changes (`TabUrlSync.tsx:19-28`). Specify the end state per route so an implementer cannot mount both a route view and a Dockview panel for the same conversation:

   | Route | End-state component | Mounts a chat host? | Behavior |
   |---|---|---|---|
   | `/chat/new` | Dockview draft panel | Yes — draft-aware Direct host (decision 1) | Materializes once on first send |
   | `/chat/:id` | Dockview Direct panel | Yes — one `DirectChatHost` per conversation | Focus/open via route-effect controller |
   | `/code/:id` | Dockview OpenCode panel | Yes — one `OpenCodeChatHost` per conversation | Focus/open via route-effect controller |
   | Settings / scheduler / other pages | Their existing page components | No | Render as today; Dockview workspace not the active surface |

   Decide how `ChatShell`, `CodeShell`, `ChatView`, and `OpenCodeView` evolve: recommended — route views become thin focus/open triggers (no `ChatWindow` of their own), and `OpenCodeView` already delegates to `OpenCodeChatHost` (`OpenCodeView.tsx:43-47`). **Duplicate-mount guard:** a conversation id must resolve to exactly one host; the route-effect controller and Dockview panel registry must share the canonical tab key so a route view never creates a second runtime for an already-open panel. Phase 4 deep-link tests must trace this exact flow.
7. **Workspace mount persistence across non-chat routes (blocking).** Today settings/scheduler render as `Outlet` children under `ChatShell` (`router.tsx:47-160`), and `AppShell` always mounts `<Outlet />` (`AppShell.tsx:271`) with the root provider at `:229`, so the Direct runtime survives route changes. Once the root provider is removed and runtimes become per-host (§4a/§5a), the Dockview workspace and its stable host layer **must remain mounted across non-chat routes** — only visibility/surface switching changes. Specify the mount point: a persistent AppShell-level layer outside route-swapped content, with route pages rendered as an alternate surface. Never unmount Dockview (or its hosts) on settings/scheduler navigation, or active streams, sessions, composers, and scroll state are destroyed. Add an E2E case: chat → settings/scheduler → chat, assert active stream/composer/scroll/runtime instance preserved.
8. **Complete assistant-ui provider consumer audit (blocking).** Before the root `AssistantRuntimeProvider` is removed, produce a repository-wide inventory of every assistant-ui context consumer. Search `web/src` (and any other source tree) for: `useAui`, `useAuiState`, `useAssistantRuntime`, `useThreadListItem*` (all variants), `AuiProvider`, and `AssistantRuntimeProvider`. Include **indirect imports, dynamic `import()` calls, and conditionally mounted components** — a consumer that only renders on a specific path is exactly the one that would fail silently. Classify every relevant consumer:

   | Classification | Meaning |
   |---|---|
   | Ambient-dependent | Currently relies on AppShell's root provider |
   | Host-isolated | Already has its own provider (e.g. OpenCode's `OpenCodeIsolationBoundary` / per-host `AuiProvider extends={null}`) |
   | Optional/fallback | Can operate without the ambient provider |

   **Gate:** the root provider must **not** be removed until every ambient-dependent consumer has a valid replacement provider or an explicitly verified fallback. Record the inventory and classification in the implementation report; add a test that fails if an ambient-dependent consumer is left without a provider after removal.

**Acceptance:** first-send draft materializes exactly once; `/chat/:id` and `/code/:id` deep links open/focus the correct panel; URL and focused conversation converge; no duplicate runtime for one conversation; Sidebar status still works with no ambient provider; no route view and Dockview panel render the same conversation simultaneously; Dockview hosts survive navigation to non-chat routes and back; every ambient-dependent assistant-ui consumer has a replacement provider or verified fallback before root-provider removal.

### 5b. Navigation and state-ownership contract
- **Authorities:** `chatTabs` = canonical conversation identity + shared membership + window-level URL selection (`localActiveKey`). Dockview = spatial layout + per-group active tab. One controller owns focus synchronization between them. No second global tab strip controls workspace tabs; `TabStrip` stays as Chat Threads navigation.
- **Event flow contract (define and test each):**
  | Event | Action | Must NOT |
  |---|---|---|
  | TabStrip / Chat Threads select | Focus panel if open, else open via canonical tab key; set `localActiveKey` + URL | Create a second runtime for the same conversation |
  | Dockview active-panel change (`onDidActivePanelChange`, payload `{ panel, origin }` with `origin: 'user' / 'api'` — `dockviewComponent.d.ts:209-212`) | Set `localActiveKey` + URL for the focused conversation; use `origin` to avoid URL/focus feedback loops | Change active selection in unrelated groups |
  | Route change (`/chat/:id`, `/code/:id`) | Focus/open matching panel via route-effect controller | Bypass `useConversationTab` validation |
  | Panel close (genuine remove) | Apply the definitive close procedure in §4b (settle mutation → confirm absent via `api.getPanel(id)`/`api.panels`), then apply conversation-close + shared-membership semantics | Treat a move as a close; remove shared membership on move; act on `onDidRemovePanel` alone |
  | Conversation closed elsewhere | Reconcile: remove stale panel, drop invalid layout ref | Invent a new conversation identity |
- Per-group selection independent; switching tabs in one group does not change unrelated groups.
- Closing a panel follows existing conversation-close and shared-membership semantics.

### 5c. Remove obsolete
- Remove `workspacePanels.ts`, `WorkspaceSurface.tsx`, and all POC artifacts after tests transferred: `DockviewLab.tsx`, `DockviewOpenCodeHost.tsx`, `web/vite.poc.config.ts`, and the dev lab route/config entries in `router.tsx` / `routes.ts`.
- Also remove AppShell's old panel wiring once Dockview provides the equivalent affordance: the `WorkspaceSurface` / `useWorkspacePanels` imports (`AppShell.tsx:52-53`), `panelCandidate` / `openChatInPanel` logic (`:137-152`), the "Open another chat in a panel" button (`:246-257`), and the `<WorkspaceSurface activeTabKey={active?.key} />` mount (`:274`). Do not leave dead UI/state behind.
- **TabUrlSync:** today it navigates on `localActiveKey` changes (`TabUrlSync.tsx:19-28`, mounted at `AppShell.tsx:298`). When the new URL↔focus convergence controller lands (§5a.3), either retire `TabUrlSync` or redefine its single responsibility; prove no duplicate/racy navigation remains. List it explicitly in the obsolete/evolved component set.
- Keep dnd-kit where it serves other features (folder management, etc.).

---

## 6. Phase 4 — Permanent tests

All tests under `tests/`. Critical scenarios must be Playwright E2E against real hosts.

### Runtime and identity
1. Two real Direct chats independent; concurrent sends distinct replies in correct conversations.
2. Real Direct host survives Dockview move without remount; composer text and scroll survive.
3. Active Direct response continues while panel hidden.
4. Real OpenCode host works inside Dockview; Direct+OpenCode concurrent without interference.
5. OpenCode permissions, forms, terminal, diff, recovery work.
6. Same conversation cannot mount in two panels; closing one panel does not interrupt another.

### Layout behavior
7. Open/close/reorder/move/group/split/resize panels; multiple conversations selected independently across groups.
8. Moving a panel does not trigger close semantics; switching tabs does not destroy inactive runtimes.
9. Save/restore across reload; in-session restore preserves live instances; corrupt/outdated layout falls back safely; deleted conversations leave no broken panels.

### Application integration
10. Chat Threads opens/focuses correct panel; URL and focused conversation synchronized.
11. Sidebar activity shows running/stopping/completed/failed/cancelled; transport degradation never shows running; last-message timestamps HTTP-owned.
12. Draft creation/materialization exactly once; theme, keyboard, accessibility, responsive layout work.

### Route-independence and migration regressions (added from audit)
13. `OpenCodeChatHost` renders `OpenCodeSessionRow` + all four chips (`Agent`/`Model`/`Thinking`/`Shield`) with the correct conversation identity **outside** `/code/:agentId` (non-route Dockview harness).
14. `/chat/new` first send materializes the draft exactly once and focuses the correct panel after the AppShell refactor.
15. Deep links `/chat/:id` and `/code/:id` open/focus the correct Dockview panel.
16. TabStrip selection and Dockview active-panel selection converge on the same URL and focused conversation; no competing global tab strip.
17. Activity projection transitions (running/stopping/completed/failed/cancelled, degraded health, no-publisher fallback) with no ambient provider.

---

## 7. Phase 5 — Documentation and gates

### Documentation
- Add dated ADR in `docs/decisions.md` approving Dockview; record alternatives (custom layout, FlexLayout, dnd-kit+custom) and why rejected.
- Update `WORKSPACE_ARCHITECTURE_PLAN.md` to replace custom layout tree/splitter/stable-host with Dockview; preserve identity/runtime/activity/draft/security decisions.
- Update `docs/architecture.md`, `docs/state-management.md`, interaction docs; mark obsolete proposals superseded.
- Update `DOCKVIEW_POC_RESULT.md` with which findings became permanent tests and which limitations remain.

### Gates (exact commands from `docs/engineering-quality.md`)
- `bun run verify`, `bun run typecheck`, `bun run build`, `bun run test:locations`, `bun run test:dom`, `bun run test:e2e`, `bun run security`, `bun run test:quarantine`.
- Clean install; dependency tree inspection; exact exit codes and test counts recorded.
- No weakening of tests, TypeScript, lint, or gates.

### Completion
- Review full diff; confirm unrelated work preserved; confirm no POC files/screenshots committed; confirm legacy code removed only where unused.
- Commit only intended changes after end-to-end verification; no force-push.
- If a critical test cannot complete, report exact blocker and leave work reviewable — do not claim completion or push unverified integration.

---

## 8. Risks and unresolved items

- **AppShell root-runtime removal (CRITICAL)** — Phase 5a design must be settled before code: draft materialization, route→panel mapping, URL/focus ownership, Sidebar activity source, staged migration, and the complete assistant-ui provider consumer audit (§5a.8). Removing the root provider prematurely breaks draft/route/URL behavior and leaves ambient-dependent consumers without a provider.
- **OpenCode child route coupling (CRITICAL)** — five children read `useParams().agentId` (`OpenCodeSessionRow`, `OpenCodeAgentChip`, `OpenCodeModelChip`, `OpenCodeThinkingChip`, `OpenCodeShieldChip`); Phase 1b prerequisite. `OpenCodeImportDialog` uses `useNavigate` — review.
- **Activity projection has no publishers** — Phase 1c blocking; without publishers Sidebar status regresses.
- **Hidden-stream E2E** — POC could not drive a real send due to browser-tool focus limitation; must be covered by Playwright.
- **Composer text preservation** — instance preservation proven; direct assertion still required.
- **Dockview add/remove on move** — official docs say add/remove fire during moves (remove then add); installed 8.9.1 bundle suppresses component-level add/remove during `movingLock`. These disagree. Use `onDidMovePanel` for relocations, treat add/remove as structural signals with idempotent reconciliation, and add a **version-pinned regression test** against resolved 8.9.1 behavior before relying on either interpretation. Apply the definitive close procedure in §4b: settle mutation → confirm absence via `api.getPanel(id)`/`api.panels` → only then close and reconcile with `chatTabs`.
- **Renderer `always` hidden work** — hidden panels keep DOM and browser-driven work alive; pause only optional visual work via `panel.api.onDidVisibilityChange` / `onShow`/`onHide`, never execution. Measure many-panel memory.
- **Memory with many panels** — measure; no LRU without evidence.
- **Enterprise features** — none used; stay on MIT core.

---

## 9. Definition of done

1. Plan audited by `opencode/iceman-free` and corrections applied (audit verdict: **REJECTED** for implementation readiness — two critical gaps; corrections in §5a, §1b, §1c, §4, §6 applied to reach ACCEPTED WITH CORRECTIONS).
2. All phases implemented with acceptance tests passing.
3. All gates exit 0 with exact numbers recorded.
4. Full diff reviewed; unrelated work preserved; no POC artifacts committed.
5. Commit and push only after verification; report branch, SHA, files, version, ownership, tests, limitations, and confirmation Direct/OpenCode remain separate.

---

## 10. Audit record (2026-11-23)

Independent read-only audit by `opencode/iceman-free` verified the plan against actual source and the working tree. Verdict: **REJECTED** for implementation readiness (direction sound; two blocking gaps). Corrections applied:

| Finding | Severity | Correction applied |
|---|---|---|
| AppShell root-runtime removal underspecified (draft/route/URL) | Critical | §5a rewritten with explicit design decisions + staged migration |
| OpenCode route coupling broader than SessionRow | Critical | §1b expanded to all five chips + SessionRow + ImportDialog review |
| Activity projection has no publishers | Major | §1c made blocking with publisher + transition tests |
| Dockview focus/URL ownership underspecified | Major | §5b state-ownership contract + event-flow table |
| Dependency promotion under-specified | Major | §1a clean install + resolved version + context integrity |
| Missing route-independence/draft/deep-link tests | Major | §6 tests 13-17 added |
| Stale working-tree/file claims | Minor | §0 current-state snapshot added |
| Unused `remoteId` prop | Minor | §1c cleanup note added |
| Version policy wording | Nit | §1a resolved-version recording added |

### Round 2 (2026-11-23) — `opencode/iceman-free`
Verdict: **ACCEPTED WITH CORRECTIONS** — no Critical findings; the two prior Critical gaps confirmed addressed. Two Major and three Minor gaps found and corrected:

| Finding | Severity | Correction applied |
|---|---|---|
| Direct host `AuiConfig({})` lacks tools/suggestions/data UIs | Major | §4a — shared Direct config/data-UI parity contract + test |
| Router/shell end state + duplicate-mount prevention underspecified | Major | §5a decision 6 — per-route composition table + duplicate-mount guard |
| AppShell old open-in-panel wiring omitted from cleanup | Minor | §5c — explicit removal of button/logic/imports/mount |
| `OpenCodeRuntimeContext` contract change implied, not explicit | Minor | §1b — name `conversationId` addition + context path for chips |
| Dockview add/remove-on-move stated too firmly | Minor | §4b + §8 — reworded to "may fire, verify, handle idempotently" |

### Round 3 (2026-11-23) — `opencode/iceman-free`
Verdict: **ACCEPTED WITH CORRECTIONS** — no Critical findings; all prior corrections confirmed applied. Two Major, two Minor, one Nit found and corrected:

| Finding | Severity | Correction applied |
|---|---|---|
| Dockview workspace mount persistence across non-chat routes unspecified | Major | §5a decision 7 — persistent AppShell-level mount + E2E chat→settings→chat case |
| Direct panel composition omits ChatHeader/conversation actions | Major | §4a — ChatHeader inside per-host provider + Phase 4 assertion |
| TabUrlSync evolution/removal not explicit | Minor | §5c — retire or redefine, prove no duplicate navigation |
| `remoteId` cleanup omits concrete caller | Minor | §1c — name `SidebarThreadRow.tsx:229-230` |
| OpenCodeRuntimeContextValue field summary incomplete | Nit | §1b — full field list |

Auditor's closing note: "With those corrections, I see no remaining blocking gap in the plan."

### Round 4 (2026-11-23) — `opencode/iceman-free`
Verdict: **ACCEPTED WITH CORRECTIONS** — no Critical or Major gaps; two Minor and one Nit, all wording/completeness only:

| Finding | Severity | Correction applied |
|---|---|---|
| §1c "no consumer outside store file" wording conflicts with ThreadRunningDot reading the projection | Minor | Reworded to "no `publish(...)` call outside store file; projection stays at default" |
| §5c POC cleanup list less explicit than §0 | Minor | Named all POC artifacts explicitly |
| §1c detached-execution citation path imprecise | Nit | Full path `src/services/chat-runs.ts:189-193` |

Auditor's closing note: "No Critical or Major gaps remain... they do not change the plan's architecture or readiness direction."

### Deep Dockview API study (2026-11-23) — `opencode/iceman-free`
Read-only study of the installed `dockview-react@8.9.1` / `dockview@8.9.1` / `dockview-core@8.9.1` type declarations and official docs (https://dockview.dev/docs/core/{panels/add,events,state/save,state/load,panels/rendering}). Verdict: **Sound with required corrections before implementation.** Core API choices confirmed correct. Corrections applied:

| Area | Correction applied |
|---|---|
| Serializable params | §4a — `Parameters` typed `any`; enforce serializability at TBAi boundary |
| Add/remove-on-move | §4b + §8 — docs say add/remove fire on move; 8.9.1 bundle suppresses during `movingLock`; use `onDidMovePanel`, reconcile idempotently, version-pinned test |
| Layout-change reasons | §4b — `LayoutChangeEvent.reasons` set; filter, debounce, guard writes during restore; `onDidLayoutFromJSON` clears guard |
| Visibility API | §4b — no `DockviewApi.onDidVisibilityChange`; use `panel.api.onDidVisibilityChange` / `onShow`/`onHide` |
| `fromJSON` semantics | §4c — `reuseExistingPanels` is optional compatible-instance reuse, not a guarantee; stable ids/params required |
| Focus sync | §5b — `onDidActivePanelChange` carries `origin: 'user' / 'api'`; use to avoid feedback loops |
| Renderer `always` cost | §8 — hidden panels keep browser work alive; pause only visual work; measure memory |

### Owner findings (2026-11-23) — two targeted corrections before implementation
Owner verdict: Dockview architecture approved; these are targeted plan corrections, not a redesign. Once added and independently checked, the plan is ready for implementation approval.

| Owner finding | Correction applied |
|---|---|
| Panel-close detection must be definitive — never treat `onDidRemovePanel` alone as a close; use `onDidMovePanel` + settled mutation events; confirm genuine absence via `api.getPanel(id)`/`api.panels` before close | §4b — explicit 4-step close procedure; §5b event-flow row references it; §8 risk updated |
| Complete assistant-ui provider consumer audit before root-provider removal — inventory `useAui`, `useAuiState`, `useAssistantRuntime`, `useThreadListItem*`, `AuiProvider`, `AssistantRuntimeProvider`, including indirect/dynamic/conditional consumers; classify Ambient-dependent / Host-isolated / Optional-fallback; do not remove root provider until every ambient-dependent consumer has a replacement or verified fallback | §5a decision 8 — blocking audit with classification table and gate; §8 risk updated |

No implementation was performed during planning beyond the foundation work already present in the working tree.
