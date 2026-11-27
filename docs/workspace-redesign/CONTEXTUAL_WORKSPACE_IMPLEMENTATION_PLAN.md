# TBAi — Contextual Workspace Implementation Plan

**Status:** Implementation-ready plan, **not implementation authorization**. No phase may start until the owner approves this plan, the architecture in `CONTEXTUAL_WORKSPACE_ARCHITECTURE.md`, and the decisions in §1–§2. Each phase ends with a review gate; no commit or push before end-to-end verification passes.

**Audited branch / HEAD:** `ui-foundation-upgrade` @ `39ec6fe7603872d56483d66b79c20e4292fc6e62` (re-checked at task start; local equals remote).

**Date:** 2026-11-27

**Evidence rule:** test names below are future obligations, not existing passing tests. No result in this plan is claimed as passed. Existing test inventory and its limits are in `CONTEXTUAL_WORKSPACE_REPOSITORY_AUDIT.md` §5.

---

## 1. Prerequisites

1. Owner approval of `CONTEXTUAL_WORKSPACE_ARCHITECTURE.md` and this plan.
2. Owner decisions D1–D11 recorded in `docs/decisions.md` before the phase that depends on them (§2).
3. The existing Dockview foundation remains intact: one `DockviewReact`, `renderer:"always"`, canonical panel ids, closed identity-only `PanelParams`, `panelRegistry` single-host claim, move≠close, device-local versioned layout persistence. No phase may weaken these.
4. All quality gates green at the base commit before any change (`bun run verify`, `bun run test:e2e --project=chromium-headless dockview-workspace.spec.ts`). Record exact exit codes and counts; agent-reported results are not sufficient.
5. The untracked `docs/workspace-redesign/prototype/screenshots/` and the untracked audit plan file are preserved; never committed or overwritten.

---

## 2. Architecture decisions to freeze before code

| ID | Decision required | Blocks phase | Source of the open question |
|---|---|---|---|
| D1 | Conversation-tab ownership: retire global `TabStrip` vs keep a slim navigator; where its nine unique behaviors live | P1 | `CONTEXTUAL_WORKSPACE_REPOSITORY_AUDIT.md` §1.1–§1.2 |
| D2 | Region identity representation and persistence | P2 | `chatTabs.ts:9,45,186` (dead `groupId`); generated Dockview group ids |
| D3 | Contextual-tab state owner and persistence scope | P3 | `dockviewParams.ts:17-20,86-98` (closed contract); `state-management.md:66-82,199-210` |
| D4 | "Open in other region" interaction and focused-pane rule | P2 | `Sidebar.tsx:67-80`; `docs/ui-redesign/requirements.md:19,39` |
| D5 | Region collapse semantics (hide/geometry only, never `api.removeGroup()`) | P2 | library `https://dockview.dev/docs/core/groups/add` |
| D6 | Conversation-scoped file list/read API and threat-model acceptance | P4 | `src/routes/tools.ts:41-43,65-120`; `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:347` |
| D7 | Browser tab scope and feasibility (embedded vs preview vs defer) | P6 | `src/services/browser.ts:6-7,159-184`; `technical-audit.md:47-51` |
| D8 | File Viewer read-only first; editor deferred to its own ADR | P5 | `technical-audit.md:38` |
| D9 | Narrow-window behavior (minimum sizes + collapse) | P7 | `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:261-269` |
| D10 | Multi-window region behavior (device-local layout; shared membership unchanged) | P7 | `AppShell.tsx:121-132`; `state-management.md:66-82` |
| D11 | Contextual state lifetime (device-local persisted vs session-only) | P3 | affects D3 storage design |

**Frozen invariants (not re-litigated per phase):** one Dockview instance; Dockview owns spatial layout only; `chatTabs` + SQLite own identity/membership; Direct and OpenCode runtimes stay separate; no second layout engine, splitter, DnD system, chat runtime, message store, or conversation-tab store; no new dependency without a recorded ADR; no arbitrary absolute path or runtime object in layout state; containment is not caller authorization.

---

## 3. Phase sequence overview

| Phase | Concern | Depends on |
|---|---|---|
| P1 | Conversation-tab ownership (resolve the duplicate strip) | D1 |
| P2 | Region identity, placement and collapse | D2, D4, D5 |
| P3 | Contextual-tab shell and runtime preservation | D3, D11 |
| P4 | Files tree and conversation-scoped read API | D6 |
| P5 | Read-only File Viewer | D8, P4 |
| P6 | Browser feasibility and surface | D7 |
| P7 | Persistence, responsive, accessibility, performance | D9, D10, all above |

Each phase: goal → in/out of scope → likely modules → tests → acceptance → risks → rollback.

---

## 4. Phases

### P1 — Conversation-tab ownership

**Goal:** one unambiguous owner for conversation tabs; per-region tabs come from Dockview groups; Chat Threads remains the fixed navigator; no duplicate global/per-group navigation that creates conflicting state (CW-01, CW-03, CW-12).

**In scope:** decide and implement D1; migrate the nine unique `TabStrip` behaviors into Dockview tab context menus/group controls and Chat Threads row actions if the strip is retired; wire group-scoped active-panel events; keep `localActiveKey` as the single window-level URL authority.

**Out of scope:** region placement (P2), contextual row (P3), any new content type.

**Likely modules:** `web/src/app/layout/AppShell.tsx`, `web/src/components/TabStrip.tsx`, `web/src/features/workspace/dockviewController.ts`, `web/src/features/workspace/state/useWorkspaceFocusSync.ts`, `web/src/features/workspace/components/DockviewWorkspace.tsx`, `web/src/config/tabStrip.ts`, `web/src/features/sidebar/`.

**Tests:**
- DOM: group-scoped active-panel change updates only that group's selection; global strip no longer renders conversation tabs (if retired).
- E2E: two groups with different conversations; selecting a tab in one does not change the other; all nine preserved behaviors have a case (shared reorder, batch close, detached recovery, copy link, middle-click close, keyboard drag, scroll-into-view, new draft, flat navigator).
- Source guard: no second conversation-tab store; `chatTabs` remains identity/membership authority.

**Acceptance:** CW-01, CW-03, CW-12. No behavior from audit §1.1 is lost. `bun run verify` and the Dockview E2E spec green with recorded counts.

**Risks:** losing a unique strip behavior; URL/focus feedback loops; two strips disagreeing during a move. **Mitigation:** migrate one behavior at a time with a failing test first; use `origin: 'user' | 'api'` from Dockview events to suppress echoes.

**Rollback:** restore `TabStrip` mount and the previous focus wiring; no schema or persistence change in this phase.

---

### P2 — Region identity, placement and collapse

**Goal:** main and right regions are stable, independently addressable Dockview groups; a conversation can be opened into a chosen region; moving between regions preserves identity and runtime; collapsing a region never deletes conversations (CW-02, CW-10, CW-11).

**In scope:** D2 region alias in layout identity/geometry; D4 "open in other region" action and focused-pane rule; D5 hide/geometry-only collapse; placement via `addGroup` / `addPanel({ position: { referenceGroup }, inactive, initialWidth })`; group-scoped selection.

**Out of scope:** contextual row (P3), file/browser content (P4–P6).

**Likely modules:** `web/src/features/workspace/dockviewController.ts` (extend `DockviewControllerApi`/`AddPanelOptionsLike` with placement), `DockviewWorkspace.tsx` (placement-aware handle beyond `focusOrOpen`), `state/layoutPersistence.ts` (region alias, pruned with groups), `web/src/components/Sidebar.tsx` + `SidebarThreadRow.tsx` (target parameter), `web/src/features/chat/state/chatTabs.ts` (no new group semantics).

**Tests:**
- Unit: region alias survives save/load and is pruned with its group; placement options passed to `addPanel`; `inactive` used when opening into the other region.
- DOM: two regions with different conversations; same conversation cannot be claimed twice; collapse keeps panels mounted.
- E2E: open into main vs right; drag a conversation tab between groups and assert unchanged `data-thread-id`, composer text, and shared membership; collapse right region and assert no conversation/history deletion; restore after reload.

**Acceptance:** CW-02, CW-10, CW-11. `api.removeGroup()` is never used for collapse (source guard).

**Risks:** Dockview group ids are generated and can collide across windows; `removeGroup` misuse; a second host for one conversation. **Mitigation:** stable alias with `groupIdGenerator` consideration (library option, no new dependency); source guard against `removeGroup`; rely on `panelRegistry` claim.

**Rollback:** remove placement options and alias; fall back to current id-only reconciliation; layout version unchanged or migrated back.

---

### P3 — Contextual-tab shell and runtime preservation

**Goal:** every conversation panel shows `Chat | File Viewer | Browser | Files` in that exact order in both regions; each conversation remembers its own selection; switching away from Chat never unmounts the runtime, interrupts a stream, clears the composer, or loses scroll (CW-04, CW-05, CW-06, CW-09, CW-13).

**In scope:** D3 state owner keyed by canonical tab key; D11 lifetime; a small per-conversation shell inside `DirectPanel`/`OpenCodePanel`; CSS-hide (not unmount) for non-Chat views; empty/disabled states for unavailable contexts.

**Out of scope:** real Files/File Viewer/Browser content (P4–P6); the shell renders placeholders until those phases land.

**Likely modules:** `web/src/features/workspace/components/DirectPanel.tsx`, `OpenCodePanel.tsx`, new `web/src/features/workspace/components/ContextualTabs.tsx` (or equivalent), `web/src/features/workspace/state/` (single owner), `web/src/features/workspace/dockviewParams.ts` (**unchanged** — do not widen params).

**Tests:**
- DOM: four tabs in exact order in both panel types; selection keyed by canonical tab key and independent across conversations/regions; host component instance identity unchanged across all four sub-tab states; corrupt persisted selection falls back safely.
- E2E: held stream continues while a non-Chat sub-tab is selected; composer text and virtualizer scroll position preserved after switching away and back; Direct and OpenCode panels side by side with distinct runtimes.
- Source guard: no contextual state in `PanelParams`; no conditional unmount of the host.

**Acceptance:** CW-04, CW-05, CW-06, CW-09, CW-13. Prove the guard can fail: temporarily unmount the host on sub-tab change and watch the E2E case fail, then revert.

**Risks:** CSS-hiding breaks virtualizer measurement or composer focus; contextual state leaks between conversations; a second tab store appears. **Mitigation:** keep the host mounted in all states; key strictly by canonical tab key; one documented owner; no new store framework.

**Rollback:** remove the shell and its state owner; panels render hosts directly as today; no layout schema change.

---

### P4 — Files tree and conversation-scoped read API

**Goal:** Files shows a read-only tree of the selected conversation's server-resolved workspace, with containment and a clear unavailable state (CW-07, CW-08 partially).

**In scope:** D6; a new conversation-scoped list/read endpoint pairing `resolveConversationWorkspace` with `inspectTarget`/`resolveSafe`; a tree UI using installed `@tanstack/react-virtual` and Radix collapsible; stable file identity (folder id + safe relative path, never an absolute path as authority); explicit threat-model note that `conversationId` is an unauthenticated capability.

**Out of scope:** editing, writing, deleting, terminal, browser; no new dependency.

**Likely modules:** new `src/routes/` module under the owning concern, `src/services/` using `resolveConversationWorkspace` + `resolveSafe`, `src/lib/validation.ts` (Zod input), `web/src/features/workspace/` (tree UI), `web/src/config/tools.ts` (copy if needed).

**Tests:**
- Integration: containment (traversal, symlink escape), missing folder, missing conversation, permission errors, size/encoding limits; assert no absolute path is returned as authority.
- DOM: tree loading/empty/error/unavailable states; selecting a file emits a stable identity.
- E2E: open a conversation with a registered project → Files lists its root → select a file → File Viewer opens it without replacing the conversation tab (with P5 placeholder until P5 lands).

**Acceptance:** CW-07; security tests fail on escape attempts; no `/api/tools/*` or `/browse` reuse.

**Risks:** path traversal/symlink escape; stale project folder; unauthenticated capability exposure. **Mitigation:** reuse existing helpers; fail closed; record the trade-off in `docs/decisions.md`; do not call containment "authorization".

**Rollback:** remove the route and tree UI; no existing endpoint or schema is modified.

---

### P5 — Read-only File Viewer

**Goal:** selecting a file opens it read-only in the File Viewer sub-tab without replacing the conversation or losing chat state (CW-08).

**In scope:** D8 read-only first; render supported text/markdown/code using installed `@assistant-ui/react-markdown`, `remark-gfm`, `react-shiki`, `parse-diff`; clear unsupported-format and large-file states; preview-tab reuse policy if approved.

**Out of scope:** writable editor (separate ADR + dependency decision), image/PDF rendering (no installed capability), binary files.

**Likely modules:** `web/src/features/workspace/` viewer component, the P4 read endpoint, `web/src/config/tools.ts` copy.

**Tests:** DOM for supported/unsupported/large states; E2E for select → view → switch sub-tab → return with chat state intact; source guard that no write endpoint is called.

**Acceptance:** CW-08; no write path exists; project context matches the Files tree.

**Risks:** large files, encoding, binary safety. **Mitigation:** bounded reads and explicit unsupported states.

**Rollback:** remove the viewer component; Files still lists files.

---

### P6 — Browser feasibility and surface

**Goal:** determine and document what the Browser tab can technically be, then implement only an approved scope (CW-15).

**In scope:** D7 feasibility study; distinguish embedded interactive browser from the headless `agent-browser` tool; evaluate CSP/webview constraints; produce an ADR before any implementation. If approved, implement the smallest safe surface with navigation, isolation, and teardown tests.

**Out of scope:** assuming the headless tool satisfies the panel; installing a browser/webview library without an ADR.

**Likely modules:** feasibility report + ADR in `docs/decisions.md`; only after approval, a new feature module under `web/src/features/workspace/`.

**Tests:** feasibility report is the gate; if implemented, E2E for navigation, isolation, and teardown; source guard that the headless tool is not misrepresented as the panel.

**Acceptance:** CW-15. No implementation without an approved ADR.

**Risks:** high — webview/CSP/security; unauthenticated local surface. **Mitigation:** stop if the security model is unclear.

**Rollback:** no implementation to roll back until the ADR is approved.

---

### P7 — Persistence, responsive, accessibility and performance

**Goal:** layout and contextual-view state restore safely; narrow windows, keyboard, screen readers, minimum sizes, and many-panel performance have documented behavior (CW-14, CW-16).

**In scope:** D9, D10; region alias + contextual selection persistence with corrupt-safe reads; stale/deleted conversation and unavailable-folder recovery; minimum region sizes and collapse; Dockview's baseline ARIA plus opt-in `keyboardNavigation`; focus restoration; performance measurement or explicit "unmeasured" record.

**Out of scope:** floating/popout groups (on-hold owner decision); Tauri zoom (owner machine); new dependencies.

**Likely modules:** `state/layoutPersistence.ts`, the D3 state owner, `web/src/features/workspace/components/`, `web/src/config/` for size tokens, E2E/DOM tests.

**Tests:** cold restart with saved two-region layout; corrupt layout fallback; deleted conversation and vanished folder states; narrow-viewport E2E; keyboard flow reaching every panel and contextual tab; screen-reader role assertions; performance measurement with recorded numbers or explicit unmeasured note.

**Acceptance:** CW-14, CW-16. Full gate green; exact counts recorded.

**Risks:** visual regressions, corrupt persisted state, unmeasured performance. **Mitigation:** token-based styling; field-by-field corrupt fallback; measure before claiming.

**Rollback:** revert persistence additions; fall back to current layout envelope; no schema change.

---

## 5. Traceability — target behavior to future test

| ID | Required behavior | Future test (phase) |
|---|---|---|
| CW-01 | Chat Threads fixed left navigator, independent of Dockview groups | DOM shell guard + E2E route/navigation case (P1) |
| CW-02 | Main and right regions show different conversations simultaneously | DOM two-region case + E2E two-group case (P2) |
| CW-03 | Per-region conversation tabs; selection independent | DOM group-scoped active-panel case + E2E two-region selection case (P1/P2) |
| CW-04 | `Chat | File Viewer | Browser | Files` in exact order | DOM exact-order case in both panel types (P3) |
| CW-05 | Same contextual navigation in both regions | DOM symmetry case (P3) |
| CW-06 | Per-conversation contextual tab and view state remembered | DOM keyed-state case + corrupt-read case (P3/P7) |
| CW-07 | Files/Viewer use current conversation's server-resolved root | Integration containment cases + E2E project binding (P4) |
| CW-08 | File selection opens Viewer without replacing conversation | E2E select → view → chat-state intact (P5) |
| CW-09 | Switching away from Chat preserves runtime, stream, composer, scroll | E2E held-stream + composer/scroll case (P3) |
| CW-10 | Moving between groups preserves identity, runtime, state | E2E drag between groups with unchanged `data-thread-id` (P2) |
| CW-11 | Region collapse distinct from conversation close; no history deletion | E2E collapse + membership/history assertions (P2) |
| CW-12 | One conversation-tab owner; no duplicate navigation | Source guard + DOM no-second-strip case (P1) |
| CW-13 | Direct and OpenCode isolated and side by side | DOM mixed-host case + E2E distinct identities (P3) |
| CW-14 | Safe restore; stale/deleted conversations and unavailable folders fail safely | Unit persistence + E2E corrupt/deleted/folder cases (P7) |
| CW-15 | Browser documented as distinct embedded-panel requirement | Feasibility report + ADR gate; E2E only if implemented (P6) |
| CW-16 | Keyboard, focus, screen reader, minimum size, narrow window, performance | DOM a11y + E2E narrow-viewport + recorded measurements (P7) |

---

## 6. Cross-cutting constraints for every phase

- No second layout engine, splitter tree, DnD system, chat runtime, message store, or conversation-tab store.
- No merged Direct/OpenCode runtime; no OpenCode internals in generic workspace code.
- No dependency install, upgrade, downgrade, or removal without a recorded ADR. Installed packages already cover tabs (`radix-ui` 1.8.1), virtualized trees (`@tanstack/react-virtual` 3.14.21), DnD (`@dnd-kit/*` 0.5.1), UI state (`zustand` 5.1.0), and layout (`dockview-react` 8.9.1).
- All tests under `tests/` (`bun run test:locations` is a hard gate); every new public function gets a happy-path and an edge-case test; prove each guard can fail by mutating the defect and reverting.
- No `any`, no `as unknown as`, no weakened assertions; `bun run lint` uses `--error-on-warnings`.
- Source-text guards assert invariants, not formatting, and must be able to fail.
- Report exact commands, exit codes, and counts; compilation or a passing count is not completion.
- No commit or push until end-to-end verification passes and the owner authorizes it.

---

## 7. Definition of done for the overall program

1. Owner approval of the architecture, this plan, and decisions D1–D11 recorded in `docs/decisions.md`.
2. Each phase reviewed at its gate with real test numbers and a clean full diff.
3. `bun run typecheck` and `bun run build` exit 0 independently re-run; `bun run verify` exit 0; Dockview E2E green; exact counts recorded.
4. All CW-01 … CW-16 criteria have a passing behavioral test or an explicitly approved deferral (CW-15 may be deferred by ADR).
5. No production source, dependency, schema, or configuration change outside the approved phases; no unrelated user work touched; no commit or push before final authorization.
