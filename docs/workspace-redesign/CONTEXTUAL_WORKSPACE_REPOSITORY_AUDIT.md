# TBAi — Contextual Workspace Repository Audit

**Status:** Read-only evidence record supporting `CONTEXTUAL_WORKSPACE_ARCHITECTURE.md`. It does not authorize implementation.

**Branch / HEAD inspected:** `ui-foundation-upgrade` @ `39ec6fe7603872d56483d66b79c20e4292fc6e62`. Local HEAD equals `git ls-remote origin refs/heads/ui-foundation-upgrade`, re-checked at task start. Working tree contained only two pre-existing untracked paths: `docs/CONTEXTUAL_WORKSPACE_DOCS_AND_AUDIT_PLAN.md` and `docs/workspace-redesign/prototype/screenshots/`. Neither was modified.

**Date:** 2026-11-27

**Evidence classes:** **S** source-verified (read directly) · **L** library-verified (installed declarations or official docs) · **T** test-covered (test source read, **not executed**) · **B** browser-verified as a spec (pass status **agent-reported**) · **A** agent-reported documentation claim · **U** unverified / open.

**Critical caveat:** no test was executed and no browser run was performed in this audit. Every "passed" number below is agent-reported from documentation; no hosted CI evidence exists for this branch (`WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:24,190`).

---

## 1. Current shell, navigation and tab structure

- `AppShell` is the persistent composition root. It mounts `ActivityBar` and `Sidebar` outside Dockview (`web/src/app/layout/AppShell.tsx:143-144`), a global `TabStrip` in the title-bar row (`:147-160`, strip at `:154`), and one persistent `DockviewWorkspace` (`:171-183`). Route pages render as a separate layered surface (`:188-190`). The root `AssistantRuntimeProvider` was removed; every assistant-ui consumer is host-isolated (`:47-50`). **[S]**
- `Sidebar` is the project/folder and conversation navigator. It is mounted with no props (`:144`), loads folders at mount (`web/src/components/Sidebar.tsx:91-100`), groups chats by folder/simple sections (`:102-127,294-355`), and uses `useConversationsList` with no assistant-ui dependency (DOM guard `tests/dom/sidebar/Sidebar.test.tsx:28-69`). **[S][T]**
- Clicking a conversation row calls `requestSharedOpen(remoteId, kind)` then navigates (`Sidebar.tsx:67-80`; `SidebarThreadRow.tsx:213-224`). It never calls a Dockview API and has no target-region parameter. The panel appears indirectly through `chatTabs` + `sharedTabs` → `DockviewWorkspace.useCanonicalOpenTabKeys` (`DockviewWorkspace.tsx:348-362`) → `controller.setOpenTabKeys` (`:295-307`) → `reconcilePanels`/`addPanelForTabKey` (`dockviewController.ts:264-278,251-262`). **[S]**
  - **Conflict:** the E2E helper comment says clicking a sidebar row "navigates but does not open a panel" (`tests/e2e/workspace/dockview-workspace.spec.ts:51-56`), which contradicts current source. Treated as stale test-comment drift; source wins. **[S]**
- `chatTabs` owns canonical keys `chat:<ref>` / `agent:<ref>`, shared membership, local active selection, and the single draft `chat:new` (`web/src/features/chat/state/chatTabs.ts:8,20-45,92-114,188-485`). `groupId` is a dead `"main"` constant: declared at `:45`, initialized at `:186`, read nowhere in source/tests/scripts. **[S]**
- Route/focus synchronization has two disjoint URL writers: selection (`useWorkspaceFocusSync.ts:57-100`) and validation (`useConversationTab.ts:66-203`), documented in `routeFocus.ts:63-80`. Per-group active tabs are deliberately Dockview-owned and never mirrored into `localActiveKey` (`useWorkspaceFocusSync.ts:11-14`). **[S]**

### 1.1 Global `TabStrip` responsibilities that must be preserved

Mounted once at `AppShell.tsx:154`. All items below are source-verified at `web/src/components/TabStrip.tsx` unless noted.

| Responsibility | Evidence |
|---|---|
| Server-authoritative shared reorder with draft-offset index translation | `:218-229`; store semantics `tests/unit/web/chat/chatTabs.reorder.test.ts:59-72` **[T]** |
| Batch close modes (`others` / `right` / `all`) | `:248-266` |
| Detached / membership-failure recovery UI and actions | `:174-179,283-286,299-322` |
| Copy Link | `:268-271,333-335` |
| Middle-click close, `Enter` activation, roving `tabIndex` | `:133-147` |
| Keyboard drag with a deliberately non-conflicting key map | `:81-91`; `web/src/config/tabStrip.ts:21-50`; E2E `tests/e2e/components/tab-strip-reorder.spec.ts:245-271` **[B]** |
| Active-tab scroll-into-view | `:120-127` |
| Single "+" new-draft entry and Tauri drag region | `:345-356` |
| One flat, globally ordered view of all shared conversations | `:212-216` |
| Per-tab title from the server thread row and steady-state gone probe | `:42-74,35-41,62-64` |

Dockview's native tabs have **no app wiring** for any of these: `COMPONENTS` registers only two content components (`DockviewWorkspace.tsx:58-61`), `addPanelForTabKey` passes no `title` (`dockviewController.ts:251-262`), and the theme only sets `tabGroupIndicator: "none"` (`dockviewTheme.ts:23-27`). Whether Dockview's built-in tab UI can absorb these behaviors is **[U]**. This is the central conversation-tab ownership conflict (architecture D1).

### 1.2 Both tab systems render today

`TabStrip` at `AppShell.tsx:154` and Dockview's library-rendered group tabs inside `DockviewWorkspace.tsx:341`. Both derive from the same canonical set (`TabStrip.tsx:207-216`; `DockviewWorkspace.tsx:348-362`). The E2E suite distinguishes them explicitly: `dockviewTab()` matches the dnd-kit strip (`tests/e2e/workspace/dockview-workspace.spec.ts:106-109`) while `realDockviewTab()` matches `.dv-tab[data-tab-panel-id="chat:<id>"]` (`:111-121`). With two groups, the global strip and a non-focused group's native tab can disagree about "active" — a source-level inference, browser behavior **[U]**.

---

## 2. Dockview foundation (current implementation)

- Exactly one `DockviewReact` in `web/src`: `DockviewWorkspace.tsx:341`, rendered with `theme={tbaiTheme}`, `components={COMPONENTS}`, `onReady={onReady}`; vendor CSS imported at `:34`. **[S]**
- Registered components: `tbai-direct → DirectPanel`, `tbai-opencode → OpenCodePanel` (`DockviewWorkspace.tsx:58-61`; ids at `dockviewParams.ts:23-24`). No File Tree, File Viewer, Editor, Terminal, or embedded Browser panel exists. **[S]**
- `PanelParams` is a closed identity-only contract `{ tabKey, contentType }` (`dockviewParams.ts:17-20`). `parsePanelParams` requires an exact sorted key set, JSON round-trip equality, string types, the `direct|opencode` enum, and `contentTypeForTabKey(tabKey) === contentType` (`:26,52-98`). Both panels validate before rendering and show an invalid-params placeholder (`DirectPanel.tsx:19,22-24,92-101`; `OpenCodePanel.tsx:21,24-34`). **[S][T]** (`tests/unit/web/workspace/dockview-params.test.ts:17-86`)
- `panelRegistry` claims by canonical tab key and refuses a second host (`web/src/features/workspace/panelRegistry.ts:24-41`); the claim is acquired in an effect for StrictMode safety (`components/usePanelMountClaim.ts:18-27`); duplicate panels render "already open in another panel" (`DirectPanel.tsx:74-87`, `OpenCodePanel.tsx:81-87`). **[S][T]**
- `dockviewController` owns all events: add/move/close/reconcile/persist (`dockviewController.ts:66-87,163-375`). `addPanelForTabKey` passes `id/component/params/renderer:"always"` (`:251-262`). Move uses two signals (`onDidMovePanel` + settled `onDidMutateLayout(kind:'move')`, `:317-338`); close is applied only after mutation settles and genuine absence is confirmed (`:280-302`). Persistence filters `PERSIST_REASONS` (`:108-115`), honors a restore guard (`:347-352`), and debounces 250 ms (`:159,368-375`). **[S][T]** (`tests/unit/web/workspace/dockview-controller.test.ts:224-482`)
- `layoutPersistence` stores a versioned device-local envelope under `tbai:dockview-layout` (`state/layoutPersistence.ts:17-26`), rejects lossy values (`:66-132`), validates shape (`:134-144`), migrates v0 (`:146-158`), prunes stale refs and active group (`:160-221`), and deliberately drops floating/popout/edge groups (`:191-193`). Pruning happens on load, not save. **[S][T]** (`tests/unit/web/workspace/layout-persistence.test.ts:63-289`)
- `workspaceActivation` is a one-way latch keyed by canonical tab key with generation counters and alias mapping (`state/workspaceActivation.ts:36-158`); OpenCode has its own one-way activation latch (`web/src/features/opencode/OpenCodeChatHost.tsx:52-76`). **[S][T]**
- `renderer:"always"` is set per panel (`dockviewController.ts:40,260`). `usePanelVisibility` exposes a boolean and never pauses execution/streaming/subscriptions (`components/usePanelVisibility.ts:1-21`). There is no `DockviewApi.onDidVisibilityChange`; visibility is per panel via `panel.api.onDidVisibilityChange` (contract guard `tests/unit/web/workspace/dockview-workspace.contract.test.ts:51-53`). **[S][T][L]**
- Draft materialization: stable panel id `chat:new` (`draftAlias.ts:11-14`), alias state machine (`:34-62`), wiring in `DockviewWorkspace.tsx:153-164,215-230,309-319`, and `DraftChatHost` wires `onThreadIdChange → resolveDraftId` (`DraftChatHost.tsx:39-50`). **[S][T]**

### 2.1 Official Dockview 8.9.1 APIs relevant to the target

All **[L]** unless noted. Installed: `dockview-react@8.9.1`, `dockview-core@8.9.1` (`web/package.json:41`; `bun.lock:570`; `node_modules/.bun/dockview-core@8.9.1/...`).

- Groups render a tab bar; each panel in a group is a tab — `https://dockview.dev/docs/core/overview`.
- `api.addGroup({ direction, referencePanel, referenceGroup })`, `api.addPanel({ position: { referencePanel | referenceGroup, direction, index }, inactive, initialWidth, initialHeight })` — `https://dockview.dev/docs/core/groups/add`, `https://dockview.dev/docs/core/panels/add`; declarations `dockview/options.d.ts:733-798`.
- `api.getGroup(id)`, `api.getPanel(id)`, `api.groups`, `api.panels`, `api.serializeGroup`, `api.addGroupFromJSON`, `api.addPanelFromJSON`, `api.addPanelToTabGroup` — `https://dockview.dev/docs/api/dockview/overview`; `api/component.api.d.ts:562,584,597,605,613,765`.
- **`api.removeGroup()` removes the group and every panel in it** — `https://dockview.dev/docs/core/groups/add`. Region collapse must not use it.
- `api.onDidMovePanel` fires once settled with the panel back in `api.panels`; `onDidAddPanel`/`onDidRemovePanel` fire during moves — `https://dockview.dev/docs/core/events`.
- **`group.api.onDidActivePanelChange` is group-scoped; `api.onDidActivePanelChange` is global** — same URL. Required for independent region selection.
- `renderer:"always"` keeps DOM mounted and hidden via `visibility:hidden`; panel instance destroyed only on removal — `https://dockview.dev/docs/core/panels/rendering`.
- `fromJSON(data, { reuseExistingPanels })` and `toJSON()` — `https://dockview.dev/docs/core/state/load`, `.../save`.
- Baseline accessibility: ARIA tablist/tab/tabpanel/region roles, roving tabindex, screen-reader announcements; broader keyboard navigation is opt-in via `keyboardNavigation` — `https://dockview.dev/docs/advanced/accessibility`, `.../focus-navigation`; declarations `dockview/options.d.ts:507-552`.

---

## 3. Runtime isolation and hidden-panel guarantees

- Root provider removed; per-host providers with `AuiProvider extends={null}` (`AppShell.tsx:47-50`; `DirectChatHost.tsx:35-48`; `OpenCodeChatHost.tsx:240-270`). Source guards assert no root provider and no OpenCode internals in generic workspace code (`tests/unit/web/workspace/provider-boundaries.test.ts:65-121`; `tests/dom/opencode/OpenCodePanel.integration.test.tsx:575-610`). **[S][T]**
- DOM tests mount Direct + OpenCode hosts together with distinct runtime ids, `data-mode` chat vs agent, no cross-feature chips, and activity keyed only to the OpenCode id (`tests/dom/opencode/OpenCodePanel.integration.test.tsx:613-646`). **[T]**
- Hidden-panel execution: the E2E spec holds a real stream, hides the panel, asserts the completion marker is absent before `complete()`, present in persisted messages **while hidden**, and present in the rendered transcript after return (`tests/e2e/workspace/dockview-workspace.spec.ts:406-453`). **[B]** Pass status agent-reported (`WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:188,644`).
- **Gap:** no OpenCode hidden-stream proof; live concurrent mixed-engine sends remain in the opt-in `*-live.spec.ts` suite and are agent-reported only (`WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:236,590`). **[A][U]**

---

## 4. Files, browser and security boundaries

- `resolveConversationWorkspace` is the single server-side resolver (`src/services/workspace.ts:399-522`): no `conversationId` → legacy global root (`:402-412`); unknown conversation → `conversation_missing` (`:414-417`); simple mode → `workspace/chats/<id>` (`:452-458,488-515`); project mode → canonicalized registered folder path, with `folder_unavailable` on a vanished directory and the row preserved (`:459-480`). **[S][T]** (`tests/unit/workspace/workspace.test.ts:38-95`; `workspace-phase9.test.ts:185-238`)
- `inspectTarget` / `resolveSafe` confine paths and reject traversal and symlink escape (`src/services/tools.ts:109-176`); `runBash` confines only the starting directory and is **not sandboxed** (`:342-359`, header `:5-14`). **[S][T]** (`tests/unit/tools/tools.test.ts:49-132`; `tests/integration/tools/outside-grants.test.ts:36-187`)
- `/api/tools/*` is a manual/test surface bound to the global `WORKSPACE_DIR` (`src/routes/tools.ts:41-43,65-120`); `/api/folders/browse` takes an arbitrary `?path=`, returns directories only, no containment (`src/routes/folders.ts:112-135`); `GET /api/workspace` returns only `{name, path}` (`src/routes/workspace.ts:5-15`). **None is a project file-explorer authority.** **[S][A]**
- `src/services/browser.ts` drives the `agent-browser` CLI/daemon (`AGENT_BROWSER_BIN` at `:6-7`, spawn at `:159-184`); `web/src/tools/browser/ui.tsx:20-26` is render-only and explicitly defers screenshot image rendering. No iframe/webview/embedded browser component exists in `web/src`; Tauri CSP has no `frame-src` (`technical-audit.md:47-51`). **[S][A]**
- No caller authorization exists: `src/routes/index.ts:58-107` composes only CORS and correlation middleware; `conversationId` is an unauthenticated capability and containment is not authorization (`WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:347`). **[S][A]**
- No project-scoped file API or its tests exist; such tests are only planned (`WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:409,549`). **[U]**

---

## 5. Test inventory — what each layer does and does not prove

Static counts at this HEAD: `tests/unit/web/workspace/` 11 files / 99 `it(`; `tests/dom/workspace/` 11 files / 48 `it(`; `tests/e2e/workspace/` 1 file / 9 cases. The roadmap records 10/95 and 47 at `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:196-197` — stale relative to the tree. **[S]**

| Layer | Representative files | Proves | Does **not** prove |
|---|---|---|---|
| Unit controller | `dockview-controller.test.ts:225-482` | Event sequencing, move≠close, definitive close, restore guard, reconciliation, focus/replace | Real Dockview rendering, DnD, DOM retention, persistence to storage |
| Unit persistence | `layout-persistence.test.ts:63-289` | Envelope validation, migration, pruning, corrupt/lossy rejection, deliberate floating-group drop | Real reload, real `toJSON`/`fromJSON`, browser restore |
| Unit params/registry | `dockview-params.test.ts:17-86`; `panel-registry.test.ts:13-50` | Closed param contract, claim/release/diff | Browser-side validation on restore; real duplicate-host prevention (DOM does) |
| Source-text guards | `provider-boundaries.test.ts:65-121`; `dockview-workspace.contract.test.ts:28-64`; `dockview-theme.test.ts:24-55`; `workspace-page-copy.test.ts:16-28` | Invariants about source text | Any rendered behavior |
| DOM split/group | `dockview-split-group-contract.test.tsx:129-186` | Two-group restore, canonical identity, identity independent of group placement | Pointer-driven Dockview split (E2E-only, per `:4-5`) |
| DOM runtime | `direct-host-parity.test.tsx:230-331`; `direct-tool-ui-registration.test.tsx:226-303`; `draft-alias-runtime.test.tsx:164-203`; `OpenCodePanel.integration.test.tsx:613-646` | Per-host providers, distinct runtimes, duplicate refusal, tool/data-UI registries, mixed mounting | Real HTTP/tool execution, real OpenCode server |
| DOM focus/activation | `focus-sync.test.tsx:75-138`; `startup-activation.test.tsx:198-248`; `workspace-activation.test.tsx:67-132` | URL/focus convergence, dormant activation, disposal semantics | Real Dockview events, real OpenCode startup |
| E2E workspace | `dockview-workspace.spec.ts:183-563` | Real panels, drag/move, split into two groups, composer preservation, hidden-stream continuation, reload/corrupt fallback, deep link, route persistence | OpenCode panels/streams, pixel resize, floating groups, Tauri shell; pass status agent-reported |
| chatTabs unit | `tests/unit/web/chat/chatTabs*.test.ts` | Canonical keys, close results, navigation, reorder, detached/membership races, draft resolution | Real HTTP CAS, real Dockview panels |
| Path containment | `tools.test.ts:49-132`; `editPreview.test.ts:155-159`; `edit-preview.spec.ts:89-104` | Traversal/symlink rejection on tool endpoints | Any project-scoped file API (none exists) |

No test was executed in this audit. All pass counts are agent-reported (`WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:187-188,644`).

---

## 6. Current-vs-target gap matrix

Severity: **Blocker** = target cannot be met without resolving; **Major** = significant rework or risk; **Minor** = polish.

| ID | Gap | Severity | Impact | Evidence |
|---|---|---|---|---|
| G1 | Two conversation-tab systems (global `TabStrip` + Dockview native tabs); no single owner | **Blocker** | Conflicting active state; target requires per-region tabs | `AppShell.tsx:154`; `DockviewWorkspace.tsx:341`; audit §1.1–§1.2 |
| G2 | Nine unique `TabStrip` behaviors have no Dockview wiring | **Blocker** | Retiring the strip loses shared reorder, batch close, detached recovery, copy link, keyboard drag | audit §1.1 |
| G3 | No named main/right region identity; `groupId` is dead | **Blocker** | Cannot open a conversation into a specific region or persist region placement | `chatTabs.ts:9,45,186`; `dockviewController.ts:35-41,251-262` |
| G4 | No contextual tab row or per-conversation contextual state owner | **Blocker** | `Chat|File Viewer|Browser|Files` and per-conversation memory do not exist | `DirectPanel.tsx:56-87`; `OpenCodePanel.tsx:71-88`; `dockviewParams.ts:17-20` |
| G5 | `PanelParams` is closed identity-only | **Major** | Contextual state must not be smuggled into layout params | `dockviewParams.ts:26,86-98`; `layoutPersistence.ts:134-144` |
| G6 | No conversation-scoped file list/read API | **Blocker** | Files and File Viewer cannot be implemented safely | `src/routes/tools.ts:41-43,65-120`; `src/routes/folders.ts:112-135`; `src/routes/workspace.ts:5-15` |
| G7 | No embedded browser; headless tool is not a panel; CSP blocks frames | **Blocker** | Browser tab feasibility unresolved | `src/services/browser.ts:6-7,159-184`; `web/src/tools/browser/ui.tsx:20-26`; `technical-audit.md:47-51` |
| G8 | No file tree/viewer/editor/terminal production component | **Major** | All contextual content except Chat must be built | `web/src/features/workspace/components/`; `technical-audit.md:25-51` |
| G9 | Global `api.onDidActivePanelChange` only; no group-scoped selection wiring | **Major** | Region selections cannot be independent | `dockviewController.ts:86,363-366`; `useWorkspaceFocusSync.ts:81-95` |
| G10 | Region collapse could wrongly use `api.removeGroup()` | **Major** | Would delete conversations' panels; hide ≠ close | library `https://dockview.dev/docs/core/groups/add` |
| G11 | No narrow-window / keyboard / a11y / performance acceptance for two regions | **Major** | CW-16 unmet | `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:261-269` |
| G12 | No multi-window region behavior decision | **Minor** | Device-local layout vs shared membership interaction undefined | `AppShell.tsx:121-132`; `state-management.md:66-82` |
| G13 | Test inventory counts stale in roadmap | **Minor** | Evidence accuracy | `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:196-197` vs actual 11/99, 11/48 |

**Feasibility note:** none of G1–G12 disproves the proposed architecture. G1–G5 and G9–G10 are app-level ownership/placement work on top of an already-capable Dockview foundation; G6–G8 are new capability work with explicit owner decisions. See `CONTEXTUAL_WORKSPACE_ARCHITECTURE.md` §10.

---

## 7. Conflicts and stale statements in older documentation

All are statements in the cited docs **[S]**; their truth is assessed against the current authority (`WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md`, `DOCKVIEW_INTEGRATION_PLAN.md`, this document).

1. `README.md:53` says "One Direct runtime provider in AppShell bound to one active thread" — contradicted by `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:140` and `provider-boundaries.test.ts:66-70`. The README is explicitly a historical handoff (`README.md:3,5`).
2. `README.md:58-59,66-68` recommends building a generic panel foundation first and calls two-live-Direct isolation an open spike; the Dockview ADR records both as decided (`docs/decisions.md:9050-9060`) and the roadmap lists them implemented (`:181`).
3. Prototype interaction counts conflict: `README.md:10` says 16/16 PASS; `interaction-model.md:85` says 15/15 PASS. Neither re-verified. **[U]**
4. "Primary Chat" is live in `product-architecture.md:15,23,31,34,43-52,85,98` and `interaction-model.md:5-8,60-65,73-77`; current vocabulary removes it (`WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:298,308`). Do not rewrite historical evidence; replace the vocabulary only when those docs are touched (`:104`).
5. `interaction-model.md:46` proposes a panel tree in localStorage via `useDesktopLayout`; current layout is a versioned Dockview record (`WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:159,327-330`).
6. `technical-audit.md:44,85,94-99` describes second-runtime isolation and global operation slots as unresolved; `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:181` and `docs/decisions.md:9059` record them resolved/preserved.
7. Point-in-time HEADs differ across docs: `DOCKVIEW_INTEGRATION_PLAN.md:5` (`a7fb5b3`), `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:6` (`65e97c4`), `WORKSPACE_ARCHITECTURE_PLAN.md:7` (`b02ca47`), `DOCKVIEW_EVALUATION_PLAN.md:5` (`a2f453d`), `MULTI_PROJECT_SIDEBYSIDE_AUDIT.md:3` (`da556a9`), `technical-audit.md:3` (`244b412`), current HEAD `39ec6fe`. Re-verify rather than inherit.
8. Agent-reported counts differ by date: `README.md:9` (4999/1037/828), `DOCKVIEW_INTEGRATION_PLAN.md:5` (DOM 891), `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:187` (6169/88/0, DOM 897), `OPENCODE_SESSION_LOSS_INVESTIGATION.md:9` (6160/88/0, DOM 891). All agent-reported; no CI.
9. Stale cross-reference: `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:290,592` points to a non-existent §13 of the session report.
10. `right-hand-workspace-audit.md` and `right-hand-workspace-demo.html` are at `docs/` root, not `docs/workspace-redesign/`; both are historical (`README.md:44,78`).
11. `docs/ui-redesign/requirements.md:19,31,38-39,45,129` records owner-confirmed side-by-side and focused-pane decisions that are **not implemented**; they are inputs to architecture D4, not current behavior. **[A]**

---

## 8. Audit limitations

- No test, build, or browser run was executed; all pass claims are agent-reported.
- No source, test, dependency, lockfile, configuration, or screenshot was changed.
- The owner-directed plan file `docs/CONTEXTUAL_WORKSPACE_DOCS_AND_AUDIT_PLAN.md` is included in this documentation commit as the source brief; the screenshots directory remains untracked and untouched.
- Library capability statements come from installed declarations and official docs; runtime behavior of unused placement APIs in this app is **[U]**.
