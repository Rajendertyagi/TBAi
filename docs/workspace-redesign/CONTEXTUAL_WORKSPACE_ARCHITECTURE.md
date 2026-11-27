# TBAi — Contextual Workspace Architecture

**Status:** Owner-directed **target architecture specification**. It is documentation only and does **not** authorize implementation. The owner must approve the architecture and the unresolved decisions in §12 before any code change.

**Audited branch / HEAD:** `ui-foundation-upgrade` @ `39ec6fe7603872d56483d66b79c20e4292fc6e62` (local HEAD equals `git ls-remote origin refs/heads/ui-foundation-upgrade`, re-checked at the start of this task).

**Date:** 2026-11-27

**Authority:** This document is the current owner-directed target for the workspace UI. `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md` remains the authoritative product direction and phase roadmap; `DOCKVIEW_INTEGRATION_PLAN.md` remains the authoritative record of the *implemented* Dockview foundation. Where this document proposes a change to those documents' current behavior, it says so explicitly and marks the decision as pending (§12). Historical/superseded documents are not promoted by this document.

---

## 1. Evidence classes used here

| Class | Meaning |
|---|---|
| **Source-verified** | Read directly from production source at the audited HEAD; file:line cited. |
| **Library-verified** | Read from the installed package's type declarations or the official Dockview documentation (URL cited). |
| **Test-covered** | A test source asserts the behavior; the test was **read, not executed** in this task. |
| **Browser-verified** | A real-browser Playwright spec exists; its pass status is **agent-reported**, not re-run here. |
| **Agent-reported** | A document records a result claimed by an agent; not independently re-executed. No hosted CI evidence exists for this branch. |
| **Unverified / owner decision** | No source or test evidence; explicitly open. |

No test result in this document is claimed to have passed recently. The last agent-reported gate results are recorded in `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md` §6.2 with that limitation stated.

---

## 2. Target layout and terminology

```text
┌────────────────────┬──────────────────────────────────────┬──────────────────────────────────────┐
│ FIXED CHAT THREADS │ MAIN WORKSPACE                       │ RIGHT WORKSPACE                      │
│                    │                                      │                                      │
│ Projects/Folders   │ [Project A / Chat 1] [Chat 2]         │ [Project B / Chat 3]                 │
│ Project chats      │                                      │                                      │
│ Other chats        │ Chat | File Viewer | Browser | Files │ Chat | File Viewer | Browser | Files │
│ OpenCode sessions  │                                      │                                      │
│                    │ Content for selected conversation    │ Content for selected conversation    │
│                    │                                      │                                      │
└────────────────────┴──────────────────────────────────────┴──────────────────────────────────────┘
```

The diagram is conceptual. The right workspace may be collapsed or resized; when absent, the main workspace uses the available width. Neither region is tied to a runtime or a project: both must support Direct Chat and OpenCode conversations, and each binds to the conversation selected in its own region.

**Vocabulary** (continues `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md` §9.1; "Primary Chat" is not a live concept):

- **Chat Threads** — the fixed left-side navigator for all conversations (Direct and OpenCode).
- **Main Workspace / Right Workspace** — two spatial regions inside the one Dockview instance.
- **Conversation tab** — a Dockview group tab representing one open conversation in that region (level 1).
- **Contextual tab** — one of `Chat | File Viewer | Browser | Files` inside a conversation panel (level 2).
- **Content type** — what a panel renders (`direct`, `opencode`, and future types).
- **Runtime** — the independent execution system (Direct assistant-ui runtime or OpenCode V2 controller).
- **Layout** — Dockview-owned spatial geometry and group structure.

---

## 3. Two levels of navigation

### 3.1 Level 1 — conversation tabs, per region

Each region has its own conversation tab strip. These tabs represent the conversations **open in that region**, not a second copy of the whole Chat Threads list. Chat Threads remains the fixed navigator and the source for finding conversations. A conversation keeps the same canonical identity and the same runtime host when moved between regions.

**Source basis:** Dockview groups render a tab bar at the top and each panel in a group appears as a tab (library-verified: `https://dockview.dev/docs/core/overview`). The current production layout already persists a branch root with two leaf groups and distinct canonical panels (`web/src/features/workspace/state/layoutPersistence.ts:160-220`; DOM test `tests/dom/workspace/dockview-split-group-contract.test.tsx:129-186`), and a real pointer split into two groups is covered by `tests/e2e/workspace/dockview-workspace.spec.ts:258-335` (spec exists; pass status agent-reported).

### 3.2 Level 2 — contextual tabs, per conversation

Every conversation panel exposes the same four tabs, in **exactly this order**, in both regions:

1. **Chat** — the conversation transcript and composer, using the existing Direct or OpenCode runtime.
2. **File Viewer** — displays the file selected in Files. First version is read-only unless a separate editor decision is approved (§12).
3. **Browser** — an in-workspace browser/preview surface. The existing headless `agent-browser` tool is **not** this UI (§7.4).
4. **Files** — the file/folder tree for the selected conversation's server-resolved workspace. "Files" is the visible label; it means the file tree.

A tab may show a useful empty or disabled state when its context is unavailable, but the row and its order must not change between regions or between conversations.

**Source basis:** no contextual row exists today. `DirectPanel` and `OpenCodePanel` render their hosts directly (`web/src/features/workspace/components/DirectPanel.tsx:56-87`, `OpenCodePanel.tsx:71-88`); only two content components are registered (`DockviewWorkspace.tsx:58-61`). This is a **target**, not current behavior.

---

## 4. Region behavior and symmetry

- Chat Threads stays anchored on the far left, outside Dockview (`web/src/app/layout/AppShell.tsx:143-144` mounts `ActivityBar` and `Sidebar`; the Dockview layer is at `:171-183`).
- Selecting a conversation from Chat Threads opens or focuses it in the current/last-focused region. A distinct action (owner decision D4, §12) opens it in the other region.
- Dragging a conversation tab to the other group moves it there without creating a new conversation or runtime. Dockview's `onDidMovePanel` fires once the move has settled and the panel is back in `api.panels` (library-verified: `https://dockview.dev/docs/core/events`); the current controller already treats a move as a relocation, never a close (`web/src/features/workspace/dockviewController.ts:317-338,280-302`).
- Each region can contain multiple conversation tabs. The selected conversation in one region is independent of the selected conversation in the other. **This requires group-scoped selection events**: `group.api.onDidActivePanelChange` is scoped to one group, while `api.onDidActivePanelChange` is global (library-verified: `https://dockview.dev/docs/core/events`). Current code subscribes only to the global event (`web/src/features/workspace/dockviewController.ts:86,363-366`; `web/src/features/workspace/state/useWorkspaceFocusSync.ts:81-95`).
- Selecting a contextual tab changes the view for that conversation only. Switching conversations in one region must not change the other region's project, file, browser, or selected contextual tab.
- Each conversation remembers its own selected contextual tab and relevant view state (§8).
- Selecting a file in Files opens it in File Viewer without replacing the conversation tab or losing chat state.
- Closing/collapsing a region is distinct from closing a conversation. **Dockview's `api.removeGroup()` removes the group and every panel in it** (library-verified: `https://dockview.dev/docs/core/groups/add`), so it must **not** be used to hide a region. Region collapse must be a hide/geometry operation that keeps panels mounted (owner decision D5, §12).
- A conversation has at most one live runtime host. The existing `panelRegistry` claims by canonical tab key and refuses a second host (`web/src/features/workspace/panelRegistry.ts:24-41`; `DirectPanel.tsx:74-87`), so accidental mirroring into two regions is already prevented by design.

---

## 5. Context binding and project isolation

- Contextual views bind to the conversation selected in **their own region**.
- The file root is resolved **server-side** from that conversation: `resolveConversationWorkspace` (`src/services/workspace.ts:399-522`) derives it from persisted `workspace_mode` + `workspace_folder_id`, never from a request-supplied path. Simple mode → `workspace/chats/<conversationId>`; project mode → the registered folder's canonicalized path; a vanished folder raises `folder_unavailable` and the row is preserved (`:459-480`).
- Every path must additionally be confined with `inspectTarget` / `resolveSafe` (`src/services/tools.ts:109-176`), which reject traversal and symlink escape. **Containment is not caller authorization**: TBAi has no login or auth middleware, and a `conversationId` is an unauthenticated capability (`WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:347`; `src/routes/index.ts:58-107` has only CORS and correlation middleware).
- A file identity should use stable project/folder identity plus a safe relative path. No arbitrary absolute path may be persisted in Dockview params or client state as authority. `PanelParams` is a closed identity-only contract (`web/src/features/workspace/dockviewParams.ts:17-20,86-98`) and must not be widened for contextual state.
- Direct Chat and OpenCode remain separate runtime systems. Workspace navigation must not merge them (`AGENTS.md` "Direct/OpenCode split is a runtime boundary"; `docs/decisions.md` 2026-11-23 ADR at `:9050-9060`).

**Explicitly unsuitable as a file-explorer authority** (source-verified): `/api/tools/*` uses the global `WORKSPACE_DIR` and is a manual/test surface (`src/routes/tools.ts:41-43,65-120`); `/api/folders/browse` takes an arbitrary `?path=`, returns directories only, and has no containment or conversation binding (`src/routes/folders.ts:112-135`); `GET /api/workspace` returns only `{name, path}` (`src/routes/workspace.ts:5-15`). A future file API must pair `resolveConversationWorkspace` with `resolveSafe` and record the threat-model trade-off.

---

## 6. Runtime preservation when contextual tabs change

The Chat view must remain alive while another contextual tab is selected. Switching to Files, File Viewer, or Browser must not dispose the runtime, interrupt a stream, clear the composer, or lose scroll state.

**Feasibility (source-verified + library-verified):** Dockview's `renderer: "always"` keeps the panel's DOM tree mounted and hidden via `visibility: hidden` rather than removing it; the panel instance is only destroyed when the panel is removed from Dockview (library-verified: `https://dockview.dev/docs/core/panels/rendering`). The production controller already sets `renderer: "always"` on every chat panel (`web/src/features/workspace/dockviewController.ts:40,260`), and `usePanelVisibility` deliberately never pauses execution, streaming, or subscriptions (`web/src/features/workspace/components/usePanelVisibility.ts:1-21`). A contextual row that hides Chat with CSS inside the panel is therefore consistent with the existing guarantee.

**Required invariant:** the host component must be rendered in all four sub-tab states. The existing `owned ? <Host/> : placeholder` branches (`DirectPanel.tsx:74-87`, `OpenCodePanel.tsx:81-87`) and OpenCode's one-way activation latch (`web/src/features/opencode/OpenCodeChatHost.tsx:52-76`) must remain intact. **Unverified:** CSS-hiding a sub-tab preserves virtualizer scroll position and composer focus — no current source or test addresses this; it is a required acceptance test (CW-09).

---

## 7. Component and ownership map

| Concern | Owner | Current state (source-verified) | Target |
|---|---|---|---|
| Fixed conversation navigator | `Sidebar` (`web/src/components/Sidebar.tsx`) | Outside Dockview; adds shared membership and navigates (`:67-80`); no target-region parameter | Chat Threads stays fixed; gains an "open in other region" action (D4) |
| Conversation identity / membership | `chatTabs` + SQLite `sharedTabs` (`web/src/features/chat/state/chatTabs.ts:20-45,188-485`) | Canonical `chat:`/`agent:` keys; `groupId` is a dead `"main"` constant (`:9,45,186`) | Unchanged as identity authority; **not** a region or layout tree |
| Spatial layout | One `DockviewReact` (`web/src/features/workspace/components/DockviewWorkspace.tsx:341`) | Two registered components; `renderer:"always"`; controller owns events | Same single instance; two named regions as groups |
| Region identity | **None today** | Dockview group ids are generated; no named main/right mapping | Stable region alias in device-local layout state (D2) |
| Conversation tabs | Dockview group tab strips + global `TabStrip` | Both render simultaneously (`AppShell.tsx:154` and `DockviewWorkspace.tsx:341`); global strip has 9 unique behaviors (audit §5.1) | One unambiguous owner; global strip retired or repurposed only after its behaviors are preserved (D1) |
| Contextual tab row | **None today** | Panels render hosts directly | Per-conversation shell inside `DirectPanel`/`OpenCodePanel`; host never unmounted |
| Contextual-tab selection state | **None today** | `PanelParams` is closed identity-only | Single feature-owned store/module keyed by canonical tab key (D3) |
| Direct runtime | Per-host assistant-ui provider (`DirectChatHost.tsx:35-48`) | Root provider removed; host-isolated | Unchanged |
| OpenCode runtime | OpenCode V2 controller (`web/src/features/opencode/`) | Isolated boundary; one-way activation latch | Unchanged |
| File root resolution | `resolveConversationWorkspace` + `resolveSafe` | Server-side, per conversation | Reused; new conversation-scoped read API required (D6) |
| Browser surface | `src/services/browser.ts` headless CLI + render-only tool cards | No embedded browser UI; Tauri CSP has no `frame-src` | Feasibility + ADR before any panel (D7) |
| Layout persistence | `layoutPersistence.ts` | Versioned device-local envelope; identity + geometry only | Add region alias only; never contextual state or paths |

---

## 8. State ownership and persistence boundaries

- `chatTabs` and SQLite `sharedTabs` remain the canonical conversation identity and open-membership system. They must not become a second message store or a layout tree (`docs/state-management.md:110-120,145-157`).
- Dockview's serialized layout remains identity + geometry only. Do not add transcripts, composer drafts, runtime instances, credentials, arbitrary paths, or browser session objects to `PanelParams` (`web/src/features/workspace/dockviewParams.ts:17-20,86-98`; `layoutPersistence.ts:134-144`).
- Direct conversation/message state stays with assistant-ui; OpenCode state stays with the OpenCode V2 controller (`docs/state-management.md:110-136`).
- Contextual-tab selection needs **one** documented owner. It must be keyed by canonical tab key, must not leak between conversations or regions, and must not create a parallel conversation/tab store. Candidate placements (owner decision D3): a feature-owned Zustand UI store under `web/src/features/workspace/state/` with a device-local persisted key, or a plain module with the same keying. Either way, corrupt reads fall back field-by-field and never throw (`docs/state-management.md:79-82,199-210`).
- Continue device-local persistence conventions unless the owner approves a different scope (`docs/state-management.md:66-82`).
- Region identity must be persisted as part of the layout's identity/geometry, not in `PanelParams` (D2).

---

## 9. Existing vs target vs recommendation vs decision

| Item | Classification |
|---|---|
| One Dockview instance, two groups with different conversations, move ≠ close, hidden panels keep running | **Existing** (source-verified + test-covered; pass status agent-reported) |
| Global `TabStrip` plus Dockview native tabs both present | **Existing** (source-verified) |
| Per-region conversation tabs with independent selection | **Target**; feasible via group-scoped Dockview events |
| Contextual `Chat | File Viewer | Browser | Files` row in both regions | **Target**; no production code exists |
| Per-conversation contextual-tab memory | **Target**; owner decision D3 |
| Region alias and "open in other region" | **Target**; owner decisions D2/D4 |
| Conversation-scoped read-only file API | **Recommendation**; requires D6 and a threat-model note |
| Embedded Browser panel | **Unresolved feasibility**; requires D7 and an ADR |
| Writable editor | **Deferred**; requires a separate ADR and dependency decision |
| Retiring the global `TabStrip` | **Recommendation with owner decision D1**; its nine unique behaviors must be preserved first |

---

## 10. Feasibility verdict

**The recommended one-Dockview / two-region / two-level-tab model is technically feasible with the current architecture and the official Dockview 8.9.1 APIs**, subject to the owner decisions in §12 and the gaps in `CONTEXTUAL_WORKSPACE_REPOSITORY_AUDIT.md`.

Evidence:

1. Two groups with different conversations already exist in one instance and are persisted/restored (`layoutPersistence.ts:160-220`; `tests/dom/workspace/dockview-split-group-contract.test.tsx:129-186`; E2E spec `tests/e2e/workspace/dockview-workspace.spec.ts:258-335,341-404`).
2. Dockview groups render native tab bars; `addGroup`, `addPanel({ position: { referenceGroup } })`, `inactive`, and `initialWidth` support explicit region placement (library-verified: `https://dockview.dev/docs/core/groups/add`, `https://dockview.dev/docs/core/panels/add`; installed declarations `node_modules/.bun/dockview-core@8.9.1/.../dockview/options.d.ts:733-798`).
3. Group-scoped active-panel events exist for independent region selection (library-verified: `https://dockview.dev/docs/core/events`).
4. `renderer: "always"` keeps the chat host mounted while hidden (library-verified: `https://dockview.dev/docs/core/panels/rendering`; production `dockviewController.ts:40,260`).
5. One host per canonical key is already enforced (`panelRegistry.ts:24-41`), preventing accidental duplication.
6. No second layout engine, splitter, DnD system, chat runtime, or message store is required. Installed dependencies already cover tabs (`radix-ui` 1.8.1), virtualized trees (`@tanstack/react-virtual` 3.14.21), DnD (`@dnd-kit/*` 0.5.1), and UI state (`zustand` 5.1.0); no new package is needed for the shell itself.

**Not proven by this audit:** real pointer-driven behavior of the new placement APIs in this app, CSS-hiding scroll/composer preservation, embedded-browser feasibility, and any test pass result. These are acceptance-test obligations in `CONTEXTUAL_WORKSPACE_IMPLEMENTATION_PLAN.md`.

---

## 11. Recovery and edge cases the target must handle

- **Cold restart:** preferences hydrate before layout restore (`DockviewWorkspace.tsx:188-208`); saved layout is validated and pruned against canonical keys (`layoutPersistence.ts:186-221`); deep link refocuses (`useWorkspaceFocusSync.ts:97-100`).
- **Corrupt layout:** `loadLayout` returns `null` and the controller builds a safe default (`layoutPersistence.ts:247-267`; `dockviewController.ts:175-195`); E2E fallback case at `tests/e2e/workspace/dockview-workspace.spec.ts:491-563`.
- **Stale/deleted conversations:** pruning removes panel refs and grid views (`layoutPersistence.ts:160-175`); boot tab reconciliation is removal-only (`web/src/features/chat/state/tabReconciliation.ts:20-81`).
- **Unavailable project folder:** `folder_unavailable` is raised and the folder row is preserved (`src/services/workspace.ts:459-480`); contextual views must show a clear state, not a stale root.
- **Hidden panels:** keep executing; never pause streams or subscriptions (`usePanelVisibility.ts:1-21`).
- **Concurrent Direct/OpenCode:** runtimes stay isolated; mixed live sends remain in the opt-in live suite and are agent-reported only.
- **Narrow windows:** region minimum sizes, collapse behavior, and overflow need explicit acceptance criteria (CW-16); no production narrow-window test exists today.
- **Multiple windows:** shared membership is SQLite-authoritative and remote changes mark the active ref detached without navigating (`AppShell.tsx:121-132`); layout is device-local. Multi-window region behavior is an owner decision (D10).

---

## 12. Unresolved owner decisions

These are isolated, not silently invented. Each must be recorded in `docs/decisions.md` before the corresponding implementation phase.

| ID | Decision | Options | Recommendation | Why it is open |
|---|---|---|---|---|
| D1 | Conversation-tab ownership | (a) Retire global `TabStrip`, migrate its 9 unique behaviors into Dockview tab context menus/group controls and Chat Threads row actions; (b) keep a slim global strip as an all-conversation navigator alongside per-region tabs | (a), but only after every unique behavior is preserved and tested | Both strips render today; Dockview native tabs have no app wiring for shared reorder, batch close, detached recovery, copy link, or keyboard drag (audit §5.1) |
| D2 | Region identity | Stable alias persisted in layout state vs a separate device-local group→region map | Alias in layout identity/geometry, pruned with groups | No named main/right group exists; Dockview group ids are generated |
| D3 | Contextual-tab state owner | Feature-owned Zustand store vs plain module; device-local persistence vs session-only | Feature-owned store/module keyed by canonical tab key, device-local, corrupt-safe | `PanelParams` is a closed identity-only contract; no owner exists today |
| D4 | "Open in other region" interaction | Chat Threads context-menu action vs focused-pane rule (requirements #15) vs both | Context-menu action plus focused-pane rule: clicking affects the active region; already-open conversation is focused where it lives | Sidebar callback has no target parameter (`Sidebar.tsx:67-80`); owner requirements #4/#15 are recorded but not implemented |
| D5 | Region collapse semantics | Hide/geometry-only (panels stay mounted) vs close panels | Hide/geometry-only; never `api.removeGroup()` | `removeGroup` deletes all panels; hide ≠ close is a load-bearing invariant |
| D6 | File API contract and threat model | New conversation-scoped read/list endpoint with `resolveSafe` containment | Approve the endpoint and explicitly accept that `conversationId` is an unauthenticated capability | No project-scoped file API exists; `/api/tools/*` and `/browse` are unsuitable |
| D7 | Browser tab scope | Embedded interactive panel vs read-only preview vs defer | Defer until feasibility + security ADR | No embedded browser UI; headless tool is not a panel; Tauri CSP has no `frame-src` |
| D8 | File Viewer scope | Read-only first vs writable editor | Read-only first; editor needs its own ADR and dependency decision | No editor library installed; `technical-audit.md:38` |
| D9 | Responsive behavior | Minimum sizes + collapse vs horizontal scroll vs single-region fallback | Minimum sizes + collapse, documented | No production narrow-window acceptance test |
| D10 | Multi-window region behavior | Device-local layout per window vs shared region state | Device-local layout; shared membership unchanged | Shared membership is SQLite-authoritative; layout is localStorage |
| D11 | Contextual state lifetime | Persist across restarts vs session-only | Persist device-locally per conversation | Affects D3 storage design and corrupt-read policy |

---

## 13. Acceptance criteria

The full testable criteria `CW-01` … `CW-16` and their traceability to future tests are in `CONTEXTUAL_WORKSPACE_IMPLEMENTATION_PLAN.md` §6. This document's §4–§8 are the behavioral source for those criteria.
