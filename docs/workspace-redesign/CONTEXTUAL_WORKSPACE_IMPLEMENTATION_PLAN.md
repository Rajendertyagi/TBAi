# TBAi — Recursive Workspace Implementation Plan

**Status:** Implementation-ready plan, **not implementation authorization**. No phase may start until the owner approves this plan, `CONTEXTUAL_WORKSPACE_ARCHITECTURE.md`, and the decisions in §2. Each phase ends with a review gate; no commit or push before end-to-end verification passes.

**Audited branch / HEAD:** `ui-foundation-upgrade` @ `4c0cda723263a075458cb7a44025af40c059debd` (re-checked at task start; local equals remote).

**Date:** 2026-11-28

**Evidence rule:** test names below are future obligations, not existing passing tests. No result is claimed as passed. Current test inventory and its limits are in `CONTEXTUAL_WORKSPACE_REPOSITORY_AUDIT.md` §7. Test strategy: `CONTEXTUAL_WORKSPACE_TEST_STRATEGY.md`.

---

## 1. Prerequisites

1. Owner approval of the architecture, this plan, the test strategy, and decisions D1–D11 recorded in `docs/decisions.md` before the phase that depends on them.
2. The existing Dockview foundation stays intact: one `DockviewReact`, `renderer:"always"`, canonical chat ids, chat-host claim, move≠close, versioned device-local layout persistence. No phase weakens these.
3. All quality gates green at the base commit before any change (`bun run verify`, `bun run test:e2e --project=chromium-headless dockview-workspace.spec.ts`), with exact exit codes and counts recorded.
4. The prototype `docs/workspace-redesign/prototype/index.html` and its screenshots are preserved untouched; never committed or overwritten.
5. No dependency install/upgrade/removal without a recorded ADR. Installed packages already cover tabs, virtualized trees, DnD, UI state and layout.

---

## 2. Decisions to freeze before code

| ID | Decision | Options | Recommended | Blocks |
|---|---|---|---|---|
| D1 | Global `TabStrip` ownership | Retire after migrating nine behaviors; keep slim navigator | Retire after migration | P4 |
| D2 | Per-panel state owner | Feature-owned store keyed by panel id; plain module; session-only | Feature-owned, device-local, corrupt-safe | P3 |
| D3 | Reuse vs create | Reuse by identity; always-new; modifier override | Reuse by identity, modifier forces new | P3 |
| D4 | Automatic placement | Beside source; below; type-specific | Beside source, fallback below | P3 |
| D5 | Non-chat URL behavior | No URL change; panel route | No URL change | P3 |
| D6 | File API + threat model | New scoped endpoint with `resolveSafe` | Approve with explicit unauthenticated-capability note | P5 |
| D7 | Browser scope | Embedded; read-only preview; defer | Defer until ADR | P6 |
| D8 | Terminal scope | Persistent shell; read-only output; defer | Defer or read-only first | P7 |
| D9 | Narrow-window behavior | Minimum sizes + collapse; scroll; single-pane | Minimum sizes + collapse | P8 |
| D10 | Multi-window behavior | Device-local layout; shared region state | Device-local; shared membership unchanged | P8 |
| D11 | File Viewer editability | Read-only; writable editor | Read-only; editor needs ADR | P5 |

**Frozen invariants:** one Dockview instance; Dockview owns spatial layout only; `chatTabs` + SQLite own conversation identity/membership; Direct/OpenCode isolation; no second layout engine, splitter, DnD system, chat runtime, message store, or generic panel framework; no new dependency without an ADR; layout state carries identity + geometry only; containment is not caller authorization.

---

## 3. Phase sequence

| Phase | Concern | Depends on |
|---|---|---|
| **P0** | **Prove recursive workspace foundation on installed Dockview 8.9.1** | none |
| P1 | Discriminated panel identity, registry split, placement API | P0 |
| P2 | Persistence and restoration of deep layouts | P1 |
| P3 | One opening service, manual + automatic, reuse policy | P1, P2 |
| P4 | Navigation resolution (TabStrip / Dockview tabs / Chat Threads) | D1, P3 |
| P5 | File Tree + conversation-scoped read API + read-only Viewer | D6, D11, P3 |
| P6 | Browser feasibility + ADR + approved surface | D7 |
| P7 | Terminal feasibility + ADR + approved surface | D8 |
| P8 | State persistence, responsive, a11y, performance | D2, D9, D10, all above |

---

## 4. Phases

### P0 — Prove recursive workspace foundation

**Goal:** prove, with the actual installed Dockview 8.9.1 package, that one instance can be split repeatedly to arbitrary depth, that deep layouts persist and restore, and that moves never trigger close semantics. **No new content types.**

**In scope:** a test-only harness using `DockviewReact` with a simple registered component; `addPanel`/`addGroup` with `position: { referenceGroup, direction }`; split right, split a child down, split a descendant right (three levels); drag a sash; save `toJSON()`, reload, `fromJSON()`; move a panel between groups; focus navigation; minimum sizes.

**Out of scope:** chat runtimes, file/browser/terminal panels, production UI, new dependencies.

**Likely modules:** tests only under `tests/` (unit/DOM/E2E as appropriate); no production source change in this phase.

**Tests (future obligations):**
- Split one pane right → 2 groups; split the child down → 3 groups; split a descendant right → 4 groups; assert group ids and panel ids at each level.
- Save the deep layout, reload, restore; assert every panel id, size, active tab and group structure.
- Move a panel between groups; assert no `onPanelClose` and no runtime disposal.
- Focus navigation across nested groups; minimum pane sizes; keyboard/ARIA baseline.

**Acceptance:** a specific **three-or-more-level** case passes with real output. The current two-group E2E case is explicitly **not** sufficient.

**Risks:** unused placement APIs may behave differently in this app; deep layouts may hit practical min-size limits. **Mitigation:** run the real package, record exact behavior, stop if a documented assumption fails.

**Rollback:** no production change to roll back; tests only.

---

### P1 — Discriminated panel identity, registry split, placement API

**Goal:** the production foundation accepts non-chat panel identities and placement without weakening chat identity.

**In scope:** replace closed `PanelParams` (`dockviewParams.ts:17-20,86-99`) with a discriminated union:
- `{ kind: "chat", tabKey: "chat:<id>"|"agent:<id>", contentType: "direct"|"opencode" }`
- `{ kind: "tool", panelId: "<type>:<uuid>", contentType: "file-tree"|"file-viewer"|"browser"|"terminal"|future }`

Keep `parseTabKey` and `desiredPanelKeys` as the chat-identity guard; do not force `params.tabKey === id` for tool panels. Add a separate tool-panel instance registry; keep `panelRegistry` claim-by-tab-key for chat hosts. Add a placement module mapping "split right/down on pane X" to `api.addPanel({ position: { referenceGroup, direction } })` / `api.addGroup(...)`.

**Out of scope:** new content components, opening service, file API.

**Likely modules:** `dockviewParams.ts`, `panelRegistry.ts`, `dockviewController.ts`, `DockviewWorkspace.tsx`, new `state/panelIdentity.ts` and `state/panelPlacement.ts`.

**Tests:** unit for both identity branches and rejection of malformed/mixed params; unit for placement options; DOM for a tool panel beside a chat panel; source guard that `chatTabs.ts` and the chat claim Set are unchanged.

**Acceptance:** DP-03, DP-07, DP-13. All existing chat assertions remain behaviorally identical.

**Risks:** widening identity by accident; reconciliation removing tool panels. **Mitigation:** parallel classifier, not modification of `parseTabKey`; prove guards can fail.

**Rollback:** revert the classifier, registry and placement module; no schema change.

---

### P2 — Persistence and restoration of deep layouts

**Goal:** versioned, backward-compatible persistence of arbitrary-depth layouts with both identity kinds.

**In scope:** widen `layoutPersistence.ts:134-144,186-221` to accept both identity kinds; build allowed set from chat keys plus tool panel ids; keep versioned envelope, corrupt fallback, floating/popout/edge drop; add a migration from v1 chat-only records; persist per-panel state (viewer path/scroll, browser URL/history, terminal session) in a separate feature-owned module keyed by panel id.

**Out of scope:** new content types.

**Tests:** unit for v1→v2 migration; deep nested save/load; stale/deleted conversation pruning; unavailable folder state; corrupt fallback; per-panel state round-trip.

**Acceptance:** DP-12, DP-14. No secrets, message text, absolute paths or runtime objects in layout params.

**Risks:** persistence contract changes break workflows; corrupt reads. **Mitigation:** versioned migration, field-by-field fallback, exact test counts.

**Rollback:** revert to v1 envelope; no data loss because migration is additive.

---

### P3 — One opening service, manual + automatic, reuse policy

**Goal:** manual creation and click-driven opening use one `openContent(request)` service with deterministic reuse.

**In scope:** service with `{ contentType, context, placement, reuse, source }`; identity-key duplicate detection; modifier override; visible feedback; click seams on markdown anchors (`ChatWindow.tsx:923-925`) and file-path text (`filesystem/ui.tsx:827-934`, `result-fields.tsx:202-228`); `+` menu with add-tab / split-right / split-down and content types.

**Out of scope:** real File Viewer/Browser/Terminal content (P5–P7); can use placeholders.

**Tests:** unit for reuse/create decisions; DOM for click handlers calling the service; E2E for manual split right/down from any pane and duplicate reuse; source guard that no second opening path exists.

**Acceptance:** DP-04, DP-05, DP-06, DP-08, DP-09, DP-10.

**Risks:** duplicate panels; opening into invisible location. **Mitigation:** identity-key reuse, highlight target pane, never open hidden.

**Rollback:** remove service and click handlers; no persistence change.

---

### P4 — Navigation resolution

**Goal:** one unambiguous conversation-tab owner; Chat Threads remains the sole navigator.

**In scope:** D1; migrate the nine `TabStrip` behaviors into Dockview tab context menus/header actions and Chat Threads row actions; retire the global strip; group-scoped active-panel events; focused chat pane drives URL and keyboard commands.

**Tests:** DOM for all nine migrated behaviors; E2E for two chats with independent focus; source guard that no second conversation-tab store exists.

**Acceptance:** DP-01, DP-02, DP-11, DP-13.

**Risks:** losing a strip behavior; URL/focus feedback loops. **Mitigation:** migrate one behavior at a time with a failing test; use Dockview `origin` to suppress echoes.

**Rollback:** restore `TabStrip` mount and previous focus wiring.

---

### P5 — File Tree, scoped read API, read-only Viewer

**Goal:** Files and File Viewer panels with server-resolved roots and containment.

**In scope:** D6, D11; new conversation-scoped list/read endpoint pairing `resolveConversationWorkspace` with `resolveSafe`/`inspectTarget`; Zod validation; tree UI with installed `@tanstack/react-virtual` and Radix collapsible; read-only viewer with installed markdown/shiki/diff renderers; file identity = conversation + safe relative path.

**Tests:** integration for traversal, symlink escape, missing folder/conversation, bounded reads; DOM for tree/viewer states; E2E for click file → viewer opens beside chat with chat still live.

**Acceptance:** DP-07, DP-08, DP-15. Security tests fail on escape attempts.

**Risks:** path traversal; unauthenticated capability. **Mitigation:** reuse existing helpers; fail closed; record threat model.

**Rollback:** remove route and components; no existing endpoint modified.

---

### P6 — Browser feasibility and approved surface

**Goal:** determine what Browser can be, record an ADR, implement only an approved scope.

**In scope:** D7 feasibility report; CSP/framing/origin isolation/credentials/teardown; if approved, smallest safe surface with navigation, isolation and teardown tests.

**Acceptance:** DP-09, DP-15. No implementation without an approved ADR.

**Risks:** high — webview/CSP/security. **Mitigation:** stop if security model unclear.

---

### P7 — Terminal feasibility and approved surface

**Goal:** determine whether a Terminal panel is acceptable, record an ADR, implement only an approved scope.

**In scope:** D8 feasibility; document unsandboxed shell, mandatory approval, no persistent process owner; if approved, define a backend process/session owner bound to the pane.

**Acceptance:** DP-05, DP-15, DP-16. Stop if authorization unclear.

**Risks:** privilege and lifecycle. **Mitigation:** explicit warning, bounded process lifetime, no auto-approve.

---

### P8 — State, responsive, accessibility, performance

**Goal:** all panel types restore safely; narrow windows, keyboard, screen readers, minimum sizes and many-panel performance have documented behavior.

**In scope:** D2, D9, D10; per-panel state persistence; cold restart with deep layout; stale/deleted/unavailable states; minimum sizes and collapse; Dockview free ARIA baseline and programmatic focus; performance measurement or explicit unmeasured record.

**Tests:** cold restart with 3+ level layout; corrupt layout; deleted conversation; vanished folder; narrow viewport; keyboard flow; screen-reader roles; performance with many panels.

**Acceptance:** DP-12, DP-14, DP-16. Full gate green; exact counts recorded.

**Risks:** visual regressions, corrupt state, unmeasured performance. **Mitigation:** token styling, field-by-field fallback, measure before claiming.

---

## 5. Traceability — target behavior to future test

| ID | Required behavior | Future test (phase) |
|---|---|---|
| DP-01 | Chat Threads fixed left navigator | DOM shell guard + E2E navigation (P4) |
| DP-02 | Multiple panes with different content visible | DOM multi-pane + E2E (P0/P4) |
| DP-03 | Pane vs content terminology; discriminated identity | Unit identity cases (P1) |
| DP-04 | Any pane can split right/down; child can split again | **E2E 3+ level case (P0)** |
| DP-05 | Per-panel state preserved on focus change | DOM state isolation + E2E focus-return (P2/P8) |
| DP-06 | Opening/focusing never removes another pane | E2E multi-pane focus + unit reconcile (P1/P3) |
| DP-07 | File context server-resolved per conversation | Integration containment + source guard (P5) |
| DP-08 | Click file opens/focuses File Viewer beside source | E2E click-file (P3/P5) |
| DP-09 | Click URL opens/focuses Browser | E2E click-URL + ADR gate (P3/P6) |
| DP-10 | Reuse by identity; modifier forces new | Unit + E2E duplicate cases (P3) |
| DP-11 | One conversation-tab owner | Source guard + DOM (P4) |
| DP-12 | Deep layout saves/restores with identities, sizes, active tabs | Unit + E2E deep restart (P0/P2) |
| DP-13 | Direct/OpenCode isolated; no second engine/runtime | Source guards + DOM mixed-host (P1/P4) |
| DP-14 | Stale/deleted/unavailable fail safely | Unit + E2E (P2/P8) |
| DP-15 | File/Browser/Terminal security enforced | Integration security + ADR gates (P5/P6/P7) |
| DP-16 | Keyboard, focus, a11y, min sizes, narrow window, performance | DOM a11y + E2E narrow + measurements (P8) |
| DP-17 | Move panel between panes without close semantics | E2E move + unit (P0/P1) |
| DP-18 | Empty-pane lifecycle after last tab closes | DOM/E2E empty-pane case (P1/P8) |

---

## 6. Cross-cutting constraints

- No second layout engine, splitter tree, DnD system, chat runtime, message store, or generic panel framework.
- No merged Direct/OpenCode runtime; no OpenCode internals in generic workspace code.
- No dependency install/upgrade/removal without an ADR.
- All tests under `tests/`; happy-path + edge-case per public function; prove each guard can fail by mutation and reverting.
- No `any`, no weakened assertions; source-text guards assert invariants and can fail.
- Report exact commands, exit codes and counts; compilation or a passing count is not completion.
- No commit or push until end-to-end verification passes and the owner authorizes it.

---

## 7. Definition of done

1. Owner approval of architecture, plan, test strategy, and decisions D1–D11 recorded in `docs/decisions.md`.
2. P0 proves arbitrary-depth splits with a real three-or-more-level test before any content type is added.
3. Each phase reviewed at its gate with real test numbers and a clean full diff.
4. `bun run typecheck` and `bun run build` exit 0 independently re-run; `bun run verify` exit 0; Dockview E2E green; exact counts recorded.
5. All DP-01 … DP-18 criteria have a passing behavioral test or an explicitly approved deferral.
6. No production source, dependency, schema or configuration change outside approved phases; prototype untouched; no commit or push before final authorization.
