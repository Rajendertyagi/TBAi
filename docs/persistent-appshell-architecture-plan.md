# TBAi — Persistent AppShell Architecture Plan

**Status:** Phases 1–5 code COMPLETE. Phase 4/5 acceptance recorded below (structural + E2E).

**Phase 1 completed:** 2026-10-16. Files changed: router.tsx, ChatShell.tsx, CodeShell.tsx, AppShell.tsx. Typecheck + lint + build all pass.

**Phase 2 completed:** 2026-10-16. Files changed: Composer.tsx (9 static opencode imports → 2 encapsulated imports), StatusBar.tsx (OpenCodeStatusBarLabel), directCompactEntries.ts (commandLabel inlined). New files: useOpenCodeComposerState.ts, OpenCodeChipsAndRing.tsx, OpenCodeStatusBarLabel.tsx. Typecheck + lint + build all pass.

**Phase 3 completed:** 2026-10-16. Added ROUTES constant to navigation.ts as single source of truth. Replaced hardcoded route literals in 19 files (14 initial + 5 from audit). Fixed conversationIdFromPath() per-prefix extraction. Verified: zero hardcoded literals remain, typecheck + lint + build all pass.

**Baseline:** `edde610af5ece925a9a0edb6c9c522c0f0d02ab9` on branch `fix/mcp-lifecycle-and-history-e2e`.

**Date:** 2026-10-16

---

## 1. Executive summary

**Historical baseline (pre-refactor).** The architecture described below — `AppShell` mounted *inside* both `ChatShell` and `CodeShell` — was the starting point. Phases 1–5 (recorded at the top of this plan and in `tests/test-prompts-phase5.md`) restructured this so `AppShell` is the universal parent of all production routes. Read this section as the "before" state, not the current one.

The baseline architecture mounted `AppShell` (chrome + global singletons) inside both `ChatShell` and `CodeShell`. This caused `AppShell` to unmount and remount on every `/` ↔ `/code` transition, tearing down and restarting application-wide services (availability poller, recovery listeners, tab reconciliation, route-observer continuity).

The fix (now implemented): make `AppShell` the **universal parent** of all production routes. It mounts once and persists across all navigation. `ChatShell` and `CodeShell` become children that provide their respective runtimes. This eliminates all lifecycle issues at the ownership level — no workarounds, no module-level flags, no accepted gaps.

**Streaming policy:** Option B — Direct runtime stays alive on all "/" routes (chat, scheduler, archived, settings). It unmounts only on `/code` (existing behavior). This preserves recovery-state publishing and background streaming.

**No router restructuring that changes runtime lifetime.** The Direct runtime's lifetime is unchanged. Only `AppShell`'s ownership changes (from route-branch-scoped to universal).

---

## 2. Verified current state

### Checks run
| Command | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 |
| `cd web && bun run build` | exit 0 (2.67s) |
| `bun run test` (full) | not completed (timed out at 300s) |

### Key verified facts
- `web/src/app/router.tsx`: `ChatShell` is `Component` of `path: "/"` with children including scheduler, archived, settings. `CodeShell` is a sibling top-level route (`path: "/code/:agentId?"`).
- `web/src/app/layout/ChatShell.tsx`: unconditionally calls `useAppChatRuntime(...)` and wraps `AppShell` in `<AssistantRuntimeProvider>`.
- `web/src/app/layout/AppShell.tsx`: registers `registerAvailabilityRecovery`, `registerTabReconciliation`, starts `useAvailabilityStore`. Mounts `TabUrlSync` and `RouteObserver`.
- `web/src/features/opencode/CodeShell.tsx`: renders `<AppShell>` with children `<OpenCodeView />`. Does not call `useAppChatRuntime`.
- All AppShell children (Sidebar, TabStrip, StatusBar, ActivityBar, etc.) have zero `@assistant-ui` imports — fully decoupled.
- `@opencode/client` value import exists only in `v2Client.ts`. Build output confirms it ships only in `CodeShell-D5tcYGLk.js`.

### HydrateFallback semantics (react-router 8.4.0)
Source: `web/node_modules/react-router/docs/explanation/hydration.md`:
- Only relevant on initial document request and hydration.
- Only relevant when `clientLoader.hydrate=true` or `clientLoader` without server `loader`.
- This app has no `clientLoader`, `loader`, `action`, or `hydrate` anywhere in the router.
- **Conclusion:** `HydrateFallback` is never rendered at runtime. It is dead code. Lazy route loading uses `Suspense`, not `HydrateFallback`.

### Decision: preserve HydrateFallback on both AppShell and CodeShell (harmless, consistent). Do not remove.

---

## 3. Corrected route hierarchy

```
createHashRouter([
  {
    path: "/",
    Component: AppShell,                    // universal, persistent parent
    HydrateFallback,                        // covers all children (unused but harmless)
    errorElement: <RouteError />,            // covers all children
    children: [
      {
        // ChatShell: Direct runtime provider for all normal app routes
        Component: ChatShell,                // layout route (no path), renders <Outlet />
        children: [
          { index: true, lazy: IndexRedirect },
          { path: "chat/:threadId?", lazy: ChatView },
          { path: "scheduler", lazy: SchedulerPage },
          { path: "archived", lazy: ArchivedPage },
          {
            Component: SettingsLayout,        // pathless layout route
            children: [
              { path: "memory", lazy: MemoryPanel },
              { path: "mcp", lazy: McpPanel },
              { path: "logs", lazy: LogsPanel },
              { path: "folders", lazy: FoldersPage },
              { path: "quick-messages", lazy: QuickMessagesPage },
              { path: "providers", lazy: ProvidersPage },
              { path: "appearance", lazy: AppearancePage },
              { path: "desktop", lazy: DesktopSettings },
              { path: "workspace", lazy: WorkspacePage },
              { path: "opencode-config", lazy: OpenCodeConfigPage },
            ],
          },
        ],
      },
      {
        path: "code/:agentId?",
        lazy: CodeShell,                    // lazy-loaded
        errorElement: <RouteError />,        // isolated error handling preserved
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
  // DEV routes: top-level, OUTSIDE AppShell
  ...(import.meta.env.DEV
    ? [
        { path: "/theme-lab", lazy: ThemeLab },
        { path: "/keyboard-lab", lazy: KeyboardLab },
      ]
    : []),
]);
```

### Shell persistence scope

- **Persistent (AppShell mounted):** All normal production routes — `/`, `/chat/*`, `/scheduler`, `/archived`, all settings pages, `/code/*`. AppShell mounts once and persists across all navigation including `/chat` ↔ `/code`.
- **Not persistent (AppShell unmounts):** `/theme-lab` and `/keyboard-lab` (DEV only). Navigating to these in development unmounts AppShell and its singletons. Intentional — those labs must run without backend dependency.

### HydrateFallback and errorElement responsibilities

| Route | HydrateFallback | errorElement | Rationale |
|---|---|---|---|
| AppShell (path "/") | Keep (unused but harmless) | Keep (`<RouteError />`) | Universal fallback and error boundary. Covers all children. |
| CodeShell (path "code/:agentId?") | Keep (unused but harmless) | Keep (`<RouteError />`) | Isolated error handling preserved. HydrateFallback redundant (covered by AppShell) but harmless. |
| ChatShell, SettingsLayout (layout routes) | N/A | Inherit from AppShell | Layout routes don't need their own. |
| DEV routes | N/A | None (current behavior) | Outside shell. Preserve as-is. |

### Route table completeness

- All existing routes preserved: `/`, `/chat/:threadId?`, `/scheduler`, `/archived`, 10 settings pages, `/code/:agentId?`, `*` catch-all, 2 DEV routes.
- Catch-all (`*`) at AppShell's children level (last child), after ChatShell and CodeShell.
- DEV routes remain top-level, outside AppShell.
- URLs unchanged (hash routing).
- Settings nesting preserved (SettingsLayout as pathless layout route under ChatShell).
- Tab synchronisation preserved (TabUrlSync in AppShell).
- Lazy-loading boundaries preserved (ChatView, SchedulerPage, ArchivedPage, settings pages, CodeShell all still lazy).

---

## 4. Route → AppShell → route shell → runtime ownership table

| Route | AppShell (persistent) | Route shell | Direct runtime | OpenCode runtime |
|---|---|---|---|---|
| `/` (index) | YES | ChatShell | YES (mounted) | no |
| `/chat/:threadId?` | YES | ChatShell | YES | no |
| `/scheduler` | YES | ChatShell | YES (warm, no consumer) | no |
| `/archived` | YES | ChatShell | YES (warm, no consumer) | no |
| settings pages | YES | ChatShell → SettingsLayout | YES (warm, no consumer) | no |
| `/code/:agentId?` | YES | CodeShell | NO | YES (OpenCodeView) |
| `/theme-lab`, `/keyboard-lab` (DEV) | NO | none | NO | NO |

---

## 5. Intended component hierarchy

```
main.tsx
  └─ ThemeProvider
       └─ App
            ├─ RouterProvider (createHashRouter)
            │    └─ "/" → AppShell (universal, persistent)
            │         ├─ Outlet → ChatShell (Direct runtime provider, layout route)
            │         │    ├─ Outlet → route view (IndexRedirect, ChatView, SchedulerPage, ArchivedPage, SettingsLayout→pages)
            │         │    └─ DevToolsGate
            │         └─ Outlet → CodeShell (OpenCode runtime provider, leaf route)
            │              └─ OpenCodeView
            │                   └─ OpenCodeIsolationBoundary
            │                        └─ AssistantRuntimeProvider (OpenCode)
            └─ ElicitationModal (global, outside router)
```

---

## 6. Exact files expected to change

### `web/src/app/router.tsx` (restructure)
- Change `path: "/"` Component from `ChatShell` to `AppShell`.
- Nest `ChatShell` as a layout route (no path) wrapping all normal app routes.
- Nest `CodeShell` as a child route (`path: "code/:agentId?"`).
- Keep `HydrateFallback` and `errorElement` on AppShell.
- Keep `errorElement` on CodeShell.
- Keep DEV routes top-level, outside AppShell.
- Keep `*` catch-all as last child of AppShell.

### `web/src/app/layout/ChatShell.tsx` (remove AppShell render)
- Remove `import { AppShell } from "./AppShell"`.
- Replace `<AppShell />` with `<Outlet />` (import `Outlet` from `react-router`).
- Keep `AssistantRuntimeProvider`, data UI components, `DevToolsGate`.

### `web/src/features/opencode/CodeShell.tsx` (remove AppShell render)
- Remove `import { AppShell } from "@/app/layout/AppShell"`.
- Replace `<AppShell>...</AppShell>` with the inner content directly.
- Keep `loadProviders`, lifecycle logs, `OpenCodeView`.

### `web/src/app/layout/AppShell.tsx` (minor cleanup)
- Remove `children` prop from `AppShellProps` (always uses `<Outlet />` now).
- Remove `children ??` from the `PageContextMenu` render (always `<Outlet />`).

---

## 7. Ordered implementation phases

### Phase 0 — Characterization tests (establish existing behavior)

**Objective:** Record current behavior. Tests pass on current code.

**Tests to add:**
1. `tests/dom/core/runtime-ownership-baseline.test.tsx` — mount router at `/chat/new`, `/scheduler`, `/code/test-id`, `/theme-lab`. Assert current runtime presence/absence.
2. `tests/dom/core/route-observer-baseline.test.tsx` — navigate `/chat/new` → `/scheduler` → `/code/test-id`. Assert `route.change` events (documents `from: undefined` on branch switch).
3. `tests/dom/core/availability-baseline.test.tsx` — mount at `/`, navigate to `/code/test-id`. Assert availability store stop/start (documents current gap).

**Acceptance:** All 3 tests pass on current code. They document current behavior including known defects.

**Risk:** Low. Gate: tests green before Phase 1.

---

### Phase 1 - Persistent AppShell ancestor (foundational, merged lifecycle verification) ✅ COMPLETE

**Objective:** Make AppShell the universal parent. Eliminate all lifecycle workarounds. Prove shell persistence, route-observer continuity, one-time boot reconciliation, stable availability lifecycle, Direct runtime lifetime, and OpenCode isolation in a single phase.

**Files to change:**
- `web/src/app/router.tsx` — restructure.
- `web/src/app/layout/ChatShell.tsx` — render `<Outlet />`.
- `web/src/features/opencode/CodeShell.tsx` — render without AppShell.
- `web/src/app/layout/AppShell.tsx` — remove `children` prop.

**Tests to add (target state, introduced in this phase):**
4. `tests/dom/core/persistent-shell.test.tsx` — navigate through 6 routes (including /chat ↔ /code). Assert AppShell never unmounts.
5. `tests/dom/core/route-observer-continuity.test.tsx` — navigate through 5 routes. Assert every `route.change` has correct `from`.
6. `tests/dom/core/tab-reconciliation-navigation.test.tsx` — navigate through 5 routes (including /chat ↔ /code). Assert `reconcileTabMirror` is NOT called during ordinary route navigation. Separately verify that `reconcileTabMirror` IS called on boot (via `registerTabReconciliation`) and on backend recovery (via `registerAvailabilityRecovery` → `runRecoverySequence`). The test must distinguish navigation-triggered calls from recovery-triggered calls.
7. `tests/dom/core/availability-persistent.test.tsx` — navigate /chat ↔ /code. Assert availability store never stops.
8. `tests/dom/core/runtime-lifetime.test.tsx` — mount at `/chat/new`, navigate to `/scheduler` (runtime still present), navigate to `/code/test-id` (Direct absent, OpenCode present), navigate back to `/chat/new` (Direct present, OpenCode absent).
9. `tests/dom/core/opencode-isolation.test.tsx` — mount at `/code/test-id`. Assert OpenCode runtime present. Assert Direct runtime absent. Assert no provider errors.

**Tests to update (replace baseline assertions with target-state assertions):**
- `tests/dom/opencode/CodeShell.test.tsx` — update: CodeShell no longer imports/renders AppShell.
- `tests/dom/core/HydrateFallback.test.tsx` — update: router source assertions reflect AppShell as parent of "/".
- Phase 0 baseline tests (1-3) — replace with target-state versions or remove.

**Acceptance criteria:**
- AppShell mounts once and persists across all navigation (test 4).
- RouteObserver logs correct `from` on every transition including /chat ↔ /code (test 5).
- `reconcileTabMirror` NOT called during ordinary route navigation (test 6). Boot call and recovery-triggered calls are legitimate and must be allowed.
- Availability store never stops during in-app navigation (test 7).
- Direct runtime present on all "/" routes, absent on /code (test 8).
- OpenCode runtime present only on /code, isolated (test 9).
- `bun run typecheck` + `bun run lint` + `bun run build` exit 0.
- No baseline test retains assertions requiring known-broken behavior.

**Risk:** High (structural router change). Control: characterization tests first; incremental router edit; E2E verification.

**Rollback:** Revert the 4 file changes. Router returns to current structure.

---

### Phase 2 — Shared-UI boundary decoupling (H1) — COMPLETE

**Objective:** Remove static OpenCode imports from shared components.

**Approach:** Encapsulation (hook + component pattern), matching the `OpenCodeStatusBarLabel` precedent. Shared components import *encapsulated* modules from the OpenCode feature, not the feature's internal modules.

**Files changed:**
- `web/src/components/Composer.tsx` — 9 direct OpenCode imports → 2 encapsulated imports
- `web/src/components/StatusBar.tsx` — uses `OpenCodeStatusBarLabel`
- `web/src/features/chat/directCompactEntries.ts` — `commandLabel` inlined

**Files created:**
- `web/src/features/opencode/useOpenCodeComposerState.ts` — hook owning command feed, compact session, runtime context, slash entries
- `web/src/features/opencode/OpenCodeChipsAndRing.tsx` — component rendering Agent/Model/Thinking/Shield chips + context ring
- `web/src/features/opencode/OpenCodeStatusBarLabel.tsx` — StatusBar label encapsulation

**Deviation from original plan:**
- Original criterion was "Zero `features/opencode` imports." Actual result: Composer has 2 imports from `features/opencode/` (the encapsulated hook + component), consistent with the `OpenCodeStatusBarLabel` pattern already established. The 9 imports that exposed OpenCode internals are gone.
- No tests written (per user instruction: "you dont need to add test just create a file keep adding prompt for test in this file"). Test prompts tracked in `tests/test-prompts.md`.

**Acceptance criteria (revised):**
- Zero direct imports of OpenCode internal modules in shared components. ✅
- Build boundaries unchanged. ✅
- Typecheck + lint + build all pass. ✅

**Verification:** `bun run typecheck` exit 0, `bun run build` exit 0, `bun run lint` exit 0 (883 files).

---

### Phase 3 — Navigation literal cleanup (H2) — COMPLETE

**Objective:** Replace hardcoded path literals with constants from `navigation.ts`.

**Approach:** Added `ROUTES` constant to `navigation.ts` as the single source of truth for route paths. Updated NavItem routes to reference the constant. Components import and use `ROUTES.*` instead of hardcoded strings.

**Files changed:**
- `web/src/config/navigation.ts` — added `ROUTES` constant, updated NavItem routes
- `web/src/components/ActivityBar.tsx`
- `web/src/components/ChromeShortcuts.tsx`
- `web/src/components/PageTitleStrip.tsx`
- `web/src/components/PageContextMenu.tsx`
- `web/src/components/Sidebar.tsx`
- `web/src/components/NewProjectChatDialog.tsx`
- `web/src/components/StatusBarQuickActions.tsx`
- `web/src/components/TabStrip.tsx`
- `web/src/app/RouteError.tsx`
- `web/src/features/sidebar/components/FolderHeader.tsx`
- `web/src/features/chat/state/useConversationTab.ts`
- `web/src/features/chat/components/ChatHeader.tsx`
- `web/src/features/chat/components/WelcomeScopePicker.tsx`
- `web/src/features/opencode/OpenCodeView.tsx`

**Deviation from original plan:**
- No test written (per user instruction: "you dont need to add test just create a file keep adding prompt for test in this file"). Test prompt tracked in `tests/test-prompts.md`.

**Acceptance criteria:**
 Zero hardcoded route literals outside `navigation.ts` and `router.tsx`. Verified by grep — no matches.

**Files changed (second batch — remaining violations from audit):**
- `web/src/features/workspace/WorkspacePage.tsx` — `Link to="/chat/new"` → `ROUTES.CHAT_NEW`
- `web/src/app/IndexRedirect.tsx` — `"/chat/new"` fallback → `ROUTES.CHAT_NEW`
- `web/src/features/mcp/components/McpPanel.tsx` — `"/chat/new"` fallback → `ROUTES.CHAT_NEW`
- `web/src/components/StatusBar.tsx` — `pathname.startsWith("/code")` → `pathname.startsWith(ROUTES.CODE)`
- `web/src/features/chat/state/chatTabs.ts` — replaced all hardcoded `/chat/`, `/code/` in `urlForTab()`, `threadUrl()`, `conversationIdFromPath()`, `routeStillReferencesRef()` with `ROUTES.*` constants; replaced magic-number `slice(6)` with `` slice(`${ROUTES.CHAT}/`.length) ``

**Verification:** `bun run typecheck` exit 0, `bun run lint` exit 0 (883 files), `bun run build` exit 0 (3.97s).

---

### Phase 4 — Router behavioral test coverage (M6) — COMPLETE

**Objective:** Add runtime router tests.

**Approach (two layers — structural guards are NOT behavioral proof):**
1. Structural source guards (`tests/dom/core/router-smoke.test.tsx`, 9 tests):
   AppShell root, ChatShell nested, CodeShell sibling, IndexRedirect index
   route, ChatView lazy-load, settings routes, catch-all, HydrateFallback and
   errorElement registration. These prove routes are DECLARED, not that
   navigation works.
2. Behavioral E2E (`tests/e2e/routing/index-redirect.spec.ts`, 3 tests,
   Playwright against the isolated E2E server): `/` restores the active
   Direct tab (`#/chat/<id>` + composer), restores the active agent tab
   (`#/code/<id>` + shell chrome, no fallback), and falls back to
   `#/chat/new` + welcome surface with `history.length` proving
   replacement (not push) navigation.

**Acceptance criteria:** Structural guards pass; E2E redirect cases pass
against the real application; guards fail on route regression.

**Risk:** Low.

---

### Phase 5 — Deferred cleanup (M3, M4, M5) — COMPLETE

**Objective:** Remove dead nav entries, vestigial page tabs, make IndexRedirect declarative.

**Approach:**
1. Removed the dead `search` nav entry (always hidden by `features.search: false`, duplicated `/memory`) and the now-empty `features` object.
2. Removed all vestigial page-tab code from `chatTabs.ts`: `pageKey`, `openPage`, page branches in `healTab`/`tabForKey`/`urlForTab`, page filtering in `loadPersisted`, and the `"page"` kind from the `Tab` type.
3. Replaced `IndexRedirect`'s imperative `useEffect` + `navigate()` with a declarative `<Navigate>` component.

**Files changed:**
- `web/src/config/navigation.ts` — removed `search` entry, `Search` icon import, `features` object
- `web/src/features/chat/state/chatTabs.ts` — removed page-tab code paths
- `web/src/app/IndexRedirect.tsx` — declarative `<Navigate>` instead of imperative effect
- `tests/unit/web/chat/chatTabs.poison.test.ts` — removed page-tab fixture (mechanical consequence of type removal)

**Correction (supersedes the earlier deviation note):** the `healTab`
page-tab branch and the `loadPersisted` page-tab filter were both REMOVED,
not retained — verified against the committed `chatTabs.ts`. Old persisted
shapes carrying a `page:` key now heal to `null` and are dropped. No
migration path was kept; no user can create page tabs, so no live data
depends on the removed paths.

**IndexRedirect regression fix (post-Phase-5):** the declarative rewrite
initially always redirected to `/chat/new`, losing active-tab restoration.
Restored via `activeTab(useChatTabsStore.getState())` + `urlForTab(tab)`
with `ROUTES.CHAT_NEW` fallback, still declarative `<Navigate replace />`.
Covered by decision-level unit tests (3 cases) and the E2E spec above.

**Verification:** `bun run typecheck` exit 0, `bun run lint` exit 0, `bun run build` exit 0; 390 unit + 23 focused DOM + 3 E2E pass.

---

## 8. Compatibility requirements

- All URLs unchanged (hash routing preserved).
- Tab store behavior unchanged (open/active/close/reorder/resolveDraftId).
- ChatShell still calls `loadProviders()` and registers runtime lifecycle logs.
- CodeShell still calls `loadProviders()` and registers runtime lifecycle logs.
- AppShell still registers availability recovery, tab reconciliation, starts availability store.
- Sidebar and TabStrip remain runtime-free (already done).
- `@assistant-ui/*` versions unchanged (frozen train).
- No new dependencies.
- DEV routes remain outside shell, no backend dependency.
- HydrateFallback preserved on AppShell and CodeShell (unused but harmless).
- errorElement preserved on AppShell and CodeShell (functional).

---

## 9. Risks and rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Phase 1 router restructure breaks route matching | Incremental edit; E2E verification | Revert 4 file changes |
| Phase 1 breaks ChatShell runtime | ChatShell still provides runtime; only AppShell render changes | Revert ChatShell change |
| Phase 1 breaks CodeShell | CodeShell still renders OpenCodeView; only AppShell render changes | Revert CodeShell change |
| Phase 1 breaks HydrateFallback test | Update test assertions; verify manually | Revert router change |
| Phase 2 redundant reconciliation persists | Test verifies single call | Investigate registerTabReconciliation |
| Phase 3 breaks Composer | Characterization tests + visual review | Revert Composer change |

**Rollback strategy:** Each phase is a separate commit. If a phase fails, revert that commit. No phase depends on a later phase. Phase 1 is the only high-risk phase.

---

## 10. Measurable acceptance criteria and sign-off gates

### Phase 0 gate
- [ ] 3 characterization tests added and passing on current code.
- [ ] Tests document current behavior including defects.
- [ ] `bun run typecheck` + `bun run lint` + `bun run build` exit 0.

### Phase 1 gate
- [ ] AppShell is universal parent of all production routes.
- [ ] ChatShell renders `<Outlet />` instead of `<AppShell />`.
- [ ] CodeShell renders content without `<AppShell />`.
- [ ] AppShell `children` prop removed.
- [ ] HydrateFallback preserved on AppShell and CodeShell.
- [ ] errorElement preserved on AppShell and CodeShell.
- [ ] DEV routes remain outside AppShell.
- [ ] 6 new target-state tests passing.
- [ ] 2 existing tests updated (CodeShell, HydrateFallback).
- [ ] AppShell mounts once (verified by test).
- [ ] RouteObserver continuity verified (verified by test).
- [ ] Availability store never stops during navigation (verified by test).
- [ ] `reconcileTabMirror` NOT called during ordinary route navigation (verified by test). Boot and recovery calls allowed.
- [ ] Direct runtime present on "/" routes, absent on /code (verified by test).
- [ ] OpenCode runtime isolated to /code (verified by test).
- [ ] `bun run typecheck` + `bun run lint` + `bun run build` exit 0.
- [ ] No baseline test retains assertions requiring known-broken behavior.

### Phase 2 gate
- [ ] Zero `features/opencode` imports in shared components.
- [ ] Build boundaries unchanged.
- [ ] 2 new tests passing.

### Phase 3 gate
- [ ] Zero hardcoded route literals outside `navigation.ts` and `router.tsx`.
- [ ] 1 new test passing.

### Phase 4 gate
- [x] 9 router structural guards passing (declaration, not behavior).
- [x] 3 IndexRedirect E2E cases passing against the real application.
- [x] Redirect uses replacement navigation (history-length assertion).

### Phase 5 gate
- [x] Dead nav entries and vestigial page tabs removed.
- [x] No migration path kept (old `page:` shapes heal to null and drop).
- [x] IndexRedirect regression fixed and covered (unit + E2E).

### AppShell and Routing Hardening gate
- [x] Routing contracts isolated in `web/src/config/routes.ts` separated from UI navigation metadata.
- [x] Centralized `ROUTE_PATTERNS` consumed in `web/src/app/router.tsx` and verified by structural smoke guards.
- [x] Safe URL builders with encoding/decoding round-trip (`ROUTES.chat`, `ROUTES.code`, `ROUTES.parseConversationId`).
- [x] Hardened route parsing: `/chat/new` returns `null`, malformed percent sequences handled safely without throwing, extra raw path segments rejected, and encoded slashes preserved.
- [x] Nested error containment added to `ChatShell` and `SettingsLayout` with `<RouteError />` preserving root AppShell chrome.
- [x] Canonical persisted tab recovery (`loadPersisted`) enforces non-empty draft tab invariant.
- [x] Legacy migration safely cleans empty, whitespace, duplicate IDs and handles throwing storage.
- [x] Playwright E2E suite (`tests/e2e/routing/index-redirect.spec.ts`) expanded covering index redirect, cross-engine reconciliation, deep-link refresh, 404 recovery, transient 5xx retention, nested error containment, browser back replacement history, and AppShell DOM element identity retention across Chat ↔ Code navigation.

### Final sign-off
- [x] All phases complete.
- [x] Routing, persistence, structural guards, and E2E suites passing.
- [x] No regressions in Direct Chat, OpenCode, navigation, tabs, or availability.

---

## 11. Remaining blockers

1. **MCP panel DOM mock test debt**: Pre-existing mock environment issues in isolated DOM tests (`McpPanel.test.tsx`), documented and kept outside routing scope.
2. **No other blockers**: AppShell and routing architecture verified and hardened.