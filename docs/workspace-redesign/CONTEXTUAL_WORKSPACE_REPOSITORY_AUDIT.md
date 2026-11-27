# TBAi — Recursive Workspace Repository Audit

**Status:** Read-only evidence record supporting `CONTEXTUAL_WORKSPACE_ARCHITECTURE.md`. Documentation only; no implementation authorized.

**Branch / HEAD inspected:** `ui-foundation-upgrade` @ `4c0cda723263a075458cb7a44025af40c059debd`. Local HEAD equals `git ls-remote origin refs/heads/ui-foundation-upgrade`, re-checked at task start. Working tree had pre-existing uncommitted documentation edits and untracked paths; none was modified by this audit.

**Date:** 2026-11-28

**Evidence classes:** **S** source-verified · **L** library-verified (installed declarations / official docs) · **P** prototype-verified (read `prototype/index.html` implementation) · **T** test-covered (test source read, **not executed**) · **A** agent-reported · **U** unverified / open.

**Critical caveat:** no test, build, or browser run was executed in this audit. All pass claims are agent-reported; no hosted CI evidence exists.

---

## 1. Prototype analysis — `prototype/index.html`

The prototype is a standalone visual exploration. It was **not** edited, renamed or deleted. Its implementation was read, not just its screenshots.

### 1.1 What it already demonstrates [P]

| Concept | Evidence |
|---|---|
| Recursive layout containers | `split(dir, children)` at `:333` creates `{kind:'split', dir, children, sizes}`; `panel(tab)` at `:332` creates `{kind:'panel', tabs, active, size}` |
| Recursive rendering | `renderNode(node)` at `:440-452` renders a panel or recursively renders split children with sashes |
| Split replaces a panel | `splitPanel(id, dir)` at `:479-483` calls `replaceNode(layout, id, split(dir,[p,copy]))` |
| Tree helpers | `findPanel`, `findSplit`, `countPanels`, `removeNode`, `normalize`, `replaceNode`, `appendPanel` at `:349-355` |
| Sash resize with minimum | `bindResize()` at `:515-525` — pointer capture, clamped to `minW` derived from 200px |
| Tab drag between containers | `bindTabDrag()` / `moveTab()` at `:526-545` |
| Save / restore | `saveLayout()` / `restoreLayout()` at `:546-547` using `tbai:workspace-prototype-layout` |
| One chrome for every chat position | `panelChromeHTML()` at `:430`; comment at `:427-429` |
| Content registry | `CONTENT` at `:311-318` — direct, opencode, files, viewer, editor, browser; `CHAT_TYPES` at `:319` |

### 1.2 What is missing or misleading [P]

1. **Primary Chat is a permanent special position** — `<section class="primary" id="primary">` at `:275`, `primaryTabs`/`primaryActive` at `:326-328`, explicit comment "Primary Chat is a permanent POSITION" at `:305`. This contradicts the target's "no reserved Main/Right".
2. **`splitPanel` duplicates existing content** — `:481` creates `copy = panel(makeTab(t.type, t.title+' (copy)', t.identity+'-copy'))`. The target requires an empty/new panel, not a copy of the active tab.
3. **Adding panels is not targeted at the selected pane** — `addPanel(type)` calls `appendPanel()` (`:478`), which appends to the root split (`:355`), not to the selected pane. `addTabTo(container, type)` targets a container, but `addPanel` does not.
4. **No automatic opening from file or URL clicks** — content renderers are static HTML strings (`:393-415`); file tree rows and browser URL have no click handlers; no `data-file`/`data-url` handling.
5. **No project-context inheritance** — `makeTab(type, title, identity)` at `:322` carries only an identity string; content hardcodes "ai-chat-app" (`:396`) and `src/lib/session.ts` (`:402`).
6. **`normalize()` collapses single-child splits** (`:353`); empty-pane lifecycle is undefined.
7. **Persistence is an unversioned flat blob** (`:546-547`) with no validation or migration.
8. **Registry includes `editor`** (`:316`) but not Terminal; the target set is Chat, Agent, File Tree, File Viewer, Browser, Terminal.
9. **`openConversation` replaces `primaryTabs` entirely** (`:506-509`) rather than opening into a selected pane.
10. **No keyboard pane navigation, focus model, accessible splitter roles, or responsive drawer behavior.**

**Conclusion:** the prototype proves recursive splitting is visually coherent and understandable. It is **not** an architecture to copy — it is an application-owned recursive layout engine, which the repository previously rejected.

---

## 2. Current shell, navigation and tab structure [S]

- `AppShell` mounts `ActivityBar` and `Sidebar` outside Dockview (`web/src/app/layout/AppShell.tsx:143-144`), a global `TabStrip` (`:154`), and one persistent `DockviewWorkspace` (`:171-183`). Root `AssistantRuntimeProvider` removed (`:47-50`).
- `Sidebar` is the project/folder and conversation navigator; clicking a row calls `requestSharedOpen` then navigates (`web/src/components/Sidebar.tsx:67-80`), with no target-pane parameter.
- `chatTabs` owns canonical keys `chat:<ref>`/`agent:<ref>`, shared membership, local active selection, draft `chat:new` (`web/src/features/chat/state/chatTabs.ts:8,20-45,92-114,188-485`); `groupId` is a dead `"main"` constant (`:9,45,186`).
- Global `TabStrip` has nine unique behaviors with no Dockview wiring: shared reorder with draft offset (`TabStrip.tsx:218-229`), batch close (`:248-266`), detached recovery (`:174-179,283-286,299-322`), Copy Link (`:268-271`), middle-click/Enter/roving tabindex (`:133-147`), keyboard drag (`:81-91`), scroll-into-view (`:120-127`), new-draft button (`:345-356`), flat global ordering (`:212-216`).
- Both tab systems render today: `TabStrip` at `AppShell.tsx:154` and Dockview group tabs in `DockviewWorkspace.tsx:341`. E2E distinguishes them (`tests/e2e/workspace/dockview-workspace.spec.ts:106-121`).

---

## 3. Dockview foundation [S]

- Exactly one `DockviewReact`: `DockviewWorkspace.tsx:341`, props `theme`, `components`, `onReady`; CSS at `:34`.
- `COMPONENTS` registers only `tbai-direct → DirectPanel` and `tbai-opencode → OpenCodePanel` (`:58-61`).
- `PanelParams` is closed: `{ tabKey: string; contentType: "direct"|"opencode" }` (`dockviewParams.ts:17-20`); `parsePanelParams` requires exact key set, JSON safety, enum, and `contentTypeForTabKey(tabKey) === contentType` (`:86-99`).
- `panelRegistry` claims by canonical tab key (`panelRegistry.ts:24-41`); `desiredPanelKeys` filters through `parseTabKey` (`:50-60`); `diffPanelKeys` computes add/remove (`:63-73`).
- `dockviewController` owns events (`:66-87,163-375`); `addPanelForTabKey` passes `id/component/params/renderer:"always"` with **no position** (`:251-262`); `focusOrOpen` guards on `parseTabKey` (`:232-237`); reconciliation diffs canonical keys (`:264-278`); close confirmation requires settled mutation and genuine absence (`:280-302`).
- `layoutPersistence` stores a versioned envelope under `tbai:dockview-layout` (`:17-26`), validates shape via `parsePanelParams` (`:134-144`), prunes against `desiredPanelKeys` (`:186-221`), drops floating/popout/edge groups (`:186-194`).
- `workspaceActivation` is a one-way latch keyed by canonical tab key (`:36-158`); OpenCode has its own latch (`OpenCodeChatHost.tsx:52-76`).
- `renderer:"always"` set per panel (`dockviewController.ts:40,260`); `usePanelVisibility` never pauses work (`components/usePanelVisibility.ts:1-21`).

---

## 4. Recursive layout capability [L]

- Grid is a recursive tree: `SerializedGridObject<T> = { type:'leaf'|'branch'; data: T | SerializedGridObject<T>[]; size?; visible? }` (`dockview-core/dist/cjs/gridview/gridview.d.ts:56-61`); `GridNode<T> = GridLeafNode<T> | GridBranchNode<T>` (`:38-54`); locations are `number[]` paths (`:14-15`).
- `SerializedDockview.grid.root` is that tree with group state at leaves (`dockview-core/dist/cjs/dockview/dockviewComponent.d.ts:102-108`).
- Directional placement: `AddPanelPositionOptions` / `AddGroupOptions` with `referenceGroup`, `direction: 'left'|'right'|'above'|'below'|'within'` (`dockview-core/dist/cjs/dockview/options.d.ts:733-807`); `Direction` at `gridview/baseComponentGridview.d.ts:13`.
- `DockviewApi.addPanel` (`component.api.d.ts:570`), `addGroup` (`:584`), `toJSON` (`:631`), `fromJSON` (`:625`).
- **No documented depth limit** — search for `maxDepth|depth limit|recursi` across installed declarations returned no matches.
- Nested instances are free (`https://dockview.dev/docs/core/nested`; licence table "Nested layouts ✓") but fragment DnD scope (`DockviewApi.id`, `component.api.d.ts:336-338`), persistence (parent `toJSON` has no nested-layout field — `dockview/types.d.ts:39-55`), focus and lifecycle. Option A (one instance) is strictly better here.
- Official docs: `https://dockview.dev/docs/core/overview`, `.../panels/add`, `.../groups/add`, `.../state/save`, `.../state/load`, `.../nested`.

---

## 5. Runtime isolation and state [S][T]

- Two Chat panels with different conversations coexist with separate runtimes: each `DirectChatHost` calls `useAppChatRuntime(threadListAdapter, threadId, noopThreadIdChange)` (`DirectChatHost.tsx:43`) with its own provider (`:46,48`); OpenCode hosts are independent (`OpenCodeChatHost.tsx:149-193,330-403`).
- Same conversation in two panels is refused by `panelRegistry` claim-by-tab-key (`panelRegistry.ts:24-41`; `DirectPanel.tsx:74-87`).
- Chat state is per-host/per-thread: composer draft (`composerDraft.ts:11-15`), stream pointer (`resumable-stream.ts:3-8`), activation generation (`workspaceActivation.ts:36-88`), OpenCode latch (`OpenCodeChatHost.tsx:59-63`).
- `renderer:"always"` retains hidden DOM; full reload loses DOM-held state — only identity/spatial layout, composer draft and stream pointer are durable (`layoutPersistence.ts:1-12`; `composerDraft.ts:11-15`).
- Technical audit records real isolation spikes: two Direct runtimes independent, Direct+OpenCode side by side, and shared module-level state risks (`technical-audit.md:75-106`).

---

## 6. Automatic-open seams and security [S]

- **URLs:** Direct-chat markdown anchor override (`ChatWindow.tsx:923-925`, currently `target="_blank"`) and default anchor (`markdown-text.tsx:168-179`); neither has `onClick`. Web-search results are non-clickable (`web-search.tsx:77-90`).
- **File paths:** plain text in tool cards (`filesystem/ui.tsx:827-934`), directory rows (`filesystem/ui.tsx:750-783` → `result-fields.tsx:202-228`), search hits (`filesystem/ui.tsx:799-823`), diff filenames (`code-diff.tsx:107`), inline code (`markdown-text.tsx:261-272`). `result-fields.tsx:52-63` rejects linkifying arbitrary strings.
- **File root:** `resolveConversationWorkspace` (`src/services/workspace.ts:399-522`) resolves from persisted fields; `inspectTarget`/`resolveSafe` (`src/services/tools.ts:109-177`) confine paths. Unsuitable endpoints: `/api/tools/*` global root (`routes/tools.ts:41-43,65-120`), `/api/folders/browse` arbitrary path/directories only (`routes/folders.ts:112-135`), `/api/workspace` metadata only (`routes/workspace.ts:5-15`).
- **Browser:** headless `agent-browser` CLI (`src/services/browser.ts:6-7,159-184`), render-only UI (`web/src/tools/browser/ui.tsx:20-26`); no embedded browser; Tauri CSP has no `frame-src` (`src-tauri/tauri.conf.json:33-35`).
- **Terminal:** `runBash` unsandboxed with server privileges (`src/services/tools.ts:5-13,342-359`); no persistent process registry (`process-ownership.ts:1-28` is Windows job ownership).
- **Threat model:** no caller authorization; `conversationId` is an unauthenticated capability; containment is not authorization (`WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:347`).

---

## 7. Test inventory [T]

| Layer | Representative files | Proves | Does **not** prove |
|---|---|---|---|
| Unit controller | `dockview-controller.test.ts:224-482` | Event sequencing, move≠close, restore guard, reconciliation | Real rendering, placement, arbitrary depth |
| Unit persistence | `layout-persistence.test.ts:63-289` | Envelope validation, pruning, corrupt/lossy rejection | Deep nested restore, non-chat panels |
| Unit params/registry | `dockview-params.test.ts:17-86`; `panel-registry.test.ts:13-50` | Closed param contract, claim/release/diff | Non-chat identities |
| DOM split/group | `dockview-split-group-contract.test.tsx:129-186` | Two-group restore, identity independent of placement | Pointer-driven split, depth > 2 |
| DOM runtime | `direct-host-parity.test.tsx:230-331`; `OpenCodePanel.integration.test.tsx:575-646` | Per-host providers, distinct runtimes, duplicate refusal | Real HTTP/tool execution |
| E2E workspace | `dockview-workspace.spec.ts:183-563` | Real panels, drag/move, one split into two groups, composer preservation, hidden stream, reload/corrupt fallback | **Arbitrary-depth splits**, non-chat panels, OpenCode streams |
| chatTabs unit | `tests/unit/web/chat/chatTabs*.test.ts` | Canonical keys, close results, navigation, reorder | Real HTTP CAS, real Dockview panels |
| Path containment | `tools.test.ts:49-132`; `editPreview.test.ts:155-159`; `edit-preview.spec.ts:89-104` | Traversal/symlink rejection on tool endpoints | Any project-scoped file API |

**Critical gap:** the current two-group E2E case (`dockview-workspace.spec.ts:258-335`) proves one split, not arbitrary depth. No test splits a child, then a descendant.

---

## 8. Current-vs-target gap matrix

Severity: **Blocker** / **Major** / **Minor**.

| ID | Gap | Severity | Evidence |
|---|---|---|---|
| G1 | No pane terminology; "panel" means container and content | **Major** | §3 terminology; prototype `:332-333` |
| G2 | No placement API in controller | **Blocker** | `dockviewController.ts:35-41,251-262` |
| G3 | Closed `PanelParams` rejects non-chat identities | **Blocker** | `dockviewParams.ts:17-20,86-99` |
| G4 | Reconciliation prunes non-chat ids | **Blocker** | `layoutPersistence.ts:186-221`; `panelRegistry.ts:50-60` |
| G5 | No single opening service for manual + automatic | **Blocker** | §6; `focusOrOpen` only |
| G6 | No click handlers for files/URLs | **Blocker** | §6 seams |
| G7 | No per-panel state owner for tool panels | **Major** | §5 |
| G8 | No conversation-scoped file API | **Blocker** | §6 |
| G9 | No embedded browser; CSP blocks frames | **Blocker** | §6 |
| G10 | No persistent terminal process owner | **Major** | §6 |
| G11 | Two conversation-tab systems | **Major** | §2 |
| G12 | No arbitrary-depth acceptance test | **Blocker** | §7 |
| G13 | Prototype's Primary Chat / duplicate split / untargeted add | **Major** | §1.2 |
| G14 | Narrow-window / keyboard / a11y / performance criteria | **Major** | architecture §10 |

**Feasibility note:** none of G1–G12 disproves the model. Dockview Option A supports arbitrary depth (§4); the gaps are TBAi-side extensions.

---

## 9. Conflicts and stale statements

1. `README.md:53` says "One Direct runtime provider in AppShell" — contradicted by `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md:140` and `provider-boundaries.test.ts:66-70`. README is a historical handoff (`:3,5`).
2. `product-architecture.md:15,23,34` and `interaction-model.md:6,8` treat **Primary Chat** as permanent — superseded by this audit's §1.2 and the architecture.
3. `interaction-model.md:22` says split **duplicates the active tab** — superseded; target creates an empty/new panel.
4. `interaction-model.md:61` says two permanent regions remain on narrow screens — superseded; no permanent regions.
5. `technical-audit.md:41-45` describes multiple Direct panels as risky with one root provider — now implemented via per-host providers (`DirectChatHost.tsx:35-48`); preserve as historical record, link to current architecture.
6. `docs/CONTEXTUAL_WORKSPACE_DOCS_AND_AUDIT_PLAN.md:18-53` describes the fixed Main/Right + two-level contextual-tab model — superseded; update status banner.
7. Point-in-time HEADs differ across docs; re-verify rather than inherit.
8. Agent-reported counts differ by date; no CI evidence.

---

## 10. Audit limitations

- No test, build, or browser run was executed; all pass claims are agent-reported.
- No source, test, dependency, lockfile, configuration, or prototype file was changed.
- Library capability statements come from installed declarations and official docs; runtime behavior of unused placement APIs in this app is **U**.
