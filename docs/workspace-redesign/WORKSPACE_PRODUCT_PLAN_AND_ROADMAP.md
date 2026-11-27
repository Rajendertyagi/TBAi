# TBAi — Workspace Product Plan and Roadmap

**Status:** Authoritative product direction and implementation roadmap. Research and documentation only — this document does not authorize implementation of any phase.
**Date:** 2026-11-26
**Repository:** `Rajendertyagi/TBAi`, branch `ui-foundation-upgrade`
**Verified HEAD:** `65e97c4e6382a7a1ec4d3ae0f7c253f1d575bebd` (local HEAD equals `git ls-remote origin refs/heads/ui-foundation-upgrade`)
**Working tree at verification:** clean except the pre-existing untracked `docs/workspace-redesign/prototype/screenshots/` directory, which is preserved and must never be committed. (This document and the README edit were created after that verification; see §17.)

> **What this document answers:** What should we build next on top of the existing Dockview foundation, in what order, and how will we know each part is genuinely finished?

---

## 1. Scope and evidence rules

This document consolidates the current product direction and the future roadmap. It does not copy every line of the older technical audits; those remain as supporting evidence. It does not re-run the completed Dockview integration or startup-optimization work.

Evidence is classified using `docs/PROJECT_MANAGER_PROTOCOL.md` §7:

| Class | Meaning in this document |
|---|---|
| **Independently verified through GitHub** | Remote branch and HEAD checked with `git ls-remote`; commit history inspected locally against the fetched remote ref. |
| **Verified against current source** | Claim read directly from production files at `65e97c4`; file:line cited. |
| **Agent-reported** | Test counts and gate results reported by an agent in this workspace; not independently re-run here and not confirmed by hosted CI. |
| **Actual CI evidence** | None. GitHub returned no status checks or workflow runs for the tip commit. |
| **Historical / POC evidence** | Prototype and pre-Dockview audits; useful for reasoning, not proof of current behavior. |
| **Untested / unresolved** | Explicitly marked; never presented as done. |

No test result in this document is claimed to have passed recently. The last agent-reported gate results are recorded in §6 with that limitation stated.

---

## 2. Verified repository state

- Remote: `origin https://github.com/Rajendertyagi/TBAi.git` (fetch and push).
- Branch: `ui-foundation-upgrade`.
- Local HEAD and remote HEAD: both `65e97c4e6382a7a1ec4d3ae0f7c253f1d575bebd`.
- Working tree: clean except the protected untracked screenshots directory.
- No reset, clean, stash, overwrite, database, WAL, backup, or session operation was performed.

**Workspace-related commits after Dockview integration completed** (newest first, from `git log`):

| Commit | Relevance |
|---|---|
| `a7fb5b3` | Persist Dockview split layouts; defer restore until hydration. |
| `ee95c5a` | Restore Direct Chat custom tool UIs via runtime provider config. |
| `7461d20` | Dockview startup optimization + multi-project side-by-side audit. |
| `da556a9` | Activation-based history recovery for persistent panels. |
| `3cb9d1d`, `0d3533b` | Panel focus re-assertion and deep-link visibility fixes. |
| `0a71174` | Map Dockview theme onto TBAi theme tokens. |
| `b847e58` | Reconcile panels when canonical open keys change. |
| `3b6ffaf`, `b3ca60c`, `3ee0329` | Dockview E2E spec and setup fixes. |
| `f8dcc8d` | Reconciliation removal is not a user close. |
| `959343c`, `b0a501d`, `b6be0ba` | Retire obsolete workspace code; migrate AppShell/routing; implement Dockview core. |

The later OpenCode session-lifecycle commits (`650b1ef` … `65e97c4`) are a **separate workstream** documented in `OPENCODE_SESSION_LOSS_INVESTIGATION.md`; they do not change the workspace layout architecture.

---

## 3. Mandatory rules this plan obeys

From `AGENTS.md`, `docs/architectural-principles.md`, `docs/architecture.md`, `docs/state-management.md`, `docs/engineering-quality.md`, `docs/decisions.md`, and `docs/PROJECT_MANAGER_PROTOCOL.md`:

1. **Dockview owns spatial layout only** — groups, tabs within groups, splits, resizing, drag-and-drop, active selection, serialization/restoration. No second layout engine, recursive splitter framework, or parallel workspace DnD (ADR 2026-11-23).
2. **TBAi owns** canonical conversation identity and shared membership, routing/URL focus convergence, layout versioning/migration, device-local persistence policy, project context and security, workspace orchestration, and panel activation policy.
3. **Direct Chat and OpenCode remain separate runtimes.** Neither is tied to a fixed screen position. No merged runtime, no universal chat manager, no engine capability framework (architecture.md §Frontend boundary).
4. **State ownership is fixed** (state-management.md): SQLite is authoritative for application data; assistant-ui owns conversation/message state; OpenCode V2 controller owns Code-mode state; Zustand holds shared UI state only; localStorage holds device-local preferences. No second tab store, no second message/conversation store.
5. **Layout state is identity + geometry only.** Never store runtime instances, React components, message content, composer drafts, credentials, or absolute filesystem paths in Dockview layout state.
6. **Library-first and minimum custom code.** Check existing libraries before adding code or dependencies; record meaningful dependency decisions in `docs/decisions.md`. The assistant-ui dependency train is frozen.
7. **File ownership is mandatory.** One owner per file, decided by subject, not convenience. `features/<feature>/` owns feature UI/state; `components/` is genuinely shared UI; `lib/`/`config/` are shared utilities/config.
8. **Definition of done** (AGENTS.md): planner disk-review accepted; `bun run typecheck` and `bun run build` exit 0 independently re-run; test suite numbers recorded; UI flows walked step by step; no commit/push before end-to-end verification.
9. **Evidence before assertions.** Agent-reported results are not CI results; a test's existence is not proof it passed; a source-text guard is not a behavioral test.
10. **Owner approval gates.** New dependencies, architectural boundary changes, persistent data-contract changes, and new UI surfaces require explicit approval before implementation.

---

## 4. Workspace documentation classification

| Document | Classification | Role in this roadmap |
|---|---|---|
| `docs/workspace-redesign/DOCKVIEW_INTEGRATION_PLAN.md` | **Current architecture authority** + completed implementation record | Authoritative implementation specification and verification record for Dockview. |
| `docs/decisions.md` — ADR 2026-11-23 | **Current architecture authority** | Dockview as sole layout engine; preserved invariants. |
| `docs/decisions.md` — ADR 2026-11-22 | Supporting decision | `features/workspace/` ownership area. |
| `docs/decisions.md` — ADR 2026-11-26 | **Separate workstream** | Shared OpenCode DB, no automatic session deletion. Do not mix into workspace layout roadmap. |
| `DOCKVIEW_POC_RESULT.md` | Completed implementation record | POC-1 decisive runtime-preservation result; POC findings promoted to permanent tests. |
| `DOCKVIEW_STARTUP_OPTIMIZATION_PLAN.md` | Completed implementation record | Lazy OpenCode activation, shared app-wide reads, measured A/B results. |
| `DOCKVIEW_EVALUATION_PLAN.md` | Historical / superseded proposal | Evaluation input that led to Dockview adoption. |
| `WORKSPACE_ARCHITECTURE_PLAN.md` | **Historical / superseded proposal** | Custom recursive layout tree and stable-host proposal was **not implemented**; Dockview replaced it. Its own banner says so. Do not use as production architecture. |
| `MULTI_PROJECT_SIDEBYSIDE_AUDIT.md` | Supporting technical audit | Confirms per-conversation project binding already supports side-by-side different-project chats. |
| `PROVIDER_AUDIT.md` | Supporting technical audit | Justified removal of the root `AssistantRuntimeProvider`; permanent boundary guard exists. |
| `technical-audit.md` | Supporting technical audit | Source-verified capability/gap audit (file APIs partial, editor missing, browser risky). |
| `multi-chat-architecture-audit.md` | Supporting technical audit | Five multi-runtime fixes, now implemented. |
| `product-architecture.md` | Product/design reference | Concept model; still uses superseded "Primary Chat" vocabulary. |
| `interaction-model.md` | Product/design reference | Prototype-level panel/tab interaction spec; still uses "Primary Chat". |
| `README.md` (workspace-redesign) | **Historical handoff — corrected by this task** | Its stale authority pointer and live "Primary Chat" language were corrected as part of this documentation task; see §14. |
| `2026-11-22-foundation-architecture-audit.md` | Historical / superseded proposal | Self-withdraws "Primary Chat" and the generic layout-tree proposal. |
| `right-hand-workspace-audit.md`, `right-hand-workspace-demo.html` | Historical / superseded proposal | Old single-right-panel research; explicitly historical. |
| `OPENCODE_SESSION_LOSS_INVESTIGATION.md` | **Separate workstream** (also completed record) | Session lifecycle, not workspace layout. |
| `prototype/index.html`, `prototype/screenshots/` | Prototype / design reference | Visual exploration only; screenshots are untracked and must be preserved. |

### Documentation corrections

1. **Completed by this task:** `docs/workspace-redesign/README.md` now points to this roadmap and `DOCKVIEW_INTEGRATION_PLAN.md` as authorities, marks the old plan superseded, and removes "Primary Chat" as a live concept.
2. `WORKSPACE_ARCHITECTURE_PLAN.md` already carries a **SUPERSEDED (2026-11-23)** banner; keep it and do not treat its §5.2/§5.5 recursive layout tree as production architecture.
3. "Primary Chat" still appears as a live concept in `product-architecture.md`, `interaction-model.md`, `multi-chat-architecture-audit.md`, and `technical-audit.md`. Current direction explicitly removes it. Replace with the vocabulary in §9.1 when those docs are touched; do not rewrite historical evidence.
4. A mandatory three-column coding layout, a dedicated "Code Workspace", and a fixed runtime position are explicitly rejected and must not be reintroduced.

---

## 5. What the workspace is today (verified against source)

### 5.1 The actual production workspace

`web/src/features/workspace/WorkspacePage.tsx` is **not** the workspace. It is a read-only settings page at `/workspace` that POSTs `/api/tools/sysinfo` and displays machine information (`WorkspacePage.tsx:20-24,29-45,47-93`).

The production workspace is `DockviewWorkspace.tsx`, mounted **once** by `AppShell.tsx:37-45,166-183`. It stays mounted across navigation; only visibility changes (`absolute inset-0` + `invisible pointer-events-none`, never `hidden`, which would collapse Dockview to zero size — `routeFocus.ts:107-120`).

### 5.2 Content types actually renderable

Exactly **two** component ids are registered (`dockviewParams.ts:23-24`; `DockviewWorkspace.tsx:58-61,341`):

| Component id | Content type | Component |
|---|---|---|
| `tbai-direct` | `direct` | `DirectPanel` |
| `tbai-opencode` | `opencode` | `OpenCodePanel` |

There is **no** production File Tree, File Viewer, Editor, Terminal, Browser, or other generic panel. Those appear only in design documents and the standalone prototype.

Panel params are identity-only (`dockviewParams.ts:16-20,86-99`): `{ tabKey: string; contentType: "direct" | "opencode" }`. `parsePanelParams` rejects extra keys, non-JSON-serializable values, non-canonical tab keys, and a `contentType` that disagrees with `contentTypeForTabKey(tabKey)`. No message text, drafts, credentials, paths, or runtime instances are stored in layout state.

### 5.3 Conversation identity and shared membership

- Tab keys: `chat:<ref>` and `agent:<ref>` (`chatTabs.ts:8,92-108`); draft key `chat:new`.
- `Tab = { key, kind: "chat" | "agent", ref, detached? }` (`chatTabs.ts:20-27`).
- Shared membership is SQLite-authoritative (`sharedTabs: SharedTabRef[]` in preferences); there is deliberately **no global active pointer** — each window owns `localActiveKey` and its own draft (`chatTabs.ts:16-18,34-45,110-146`).
- Dockview panel **id is the canonical tab key** (`dockviewController.ts:251-262`). `panelRegistry` claims by tab key, so two panels cannot own one conversation (`panelRegistry.ts:1-10,25-44`).
- `groupId` is a dead constant `"main"` with no consumer (`chatTabs.ts:9,180`) — not a multi-group or multi-project mechanism.

### 5.4 Runtime ownership and preservation

Each panel host owns its own assistant-ui runtime and provider; the root provider was removed (`AppShell.tsx:47-50`; `ChatShell.tsx:7-11`; `PROVIDER_AUDIT.md`).

- `DirectChatHost` and `DraftChatHost` each call `useAppChatRuntime` with their own `AssistantRuntimeProvider` (`DirectChatHost.tsx:42-65`; `DraftChatHost.tsx:36-76`).
- `OpenCodeChatHost` mounts its own provider inside `OpenCodeIsolationBoundary` (`OpenCodeChatHost.tsx:240-270,359-405`).
- `renderer: "always"` is set at the single `addPanel` call (`dockviewController.ts:36-41,251-262`), so hidden panels keep DOM, streams, and subscriptions. `usePanelVisibility` never pauses execution (`usePanelVisibility.ts:1-9,14-22`).
- A move is confirmed by `onDidMovePanel` plus settled `onDidMutateLayout(kind:'move')` and is never treated as a close (`dockviewController.ts:10-13,141-145,317-338`). Genuine removal unmounts the host and disposes activation state (`workspaceActivation.ts:142-157`).

### 5.5 Draft materialization

The single draft panel id is `chat:new` (`draftAlias.ts:14`). `DraftChatHost` wires `onThreadIdChange` to `resolveDraftId(...)`; row creation is owned by `threadListAdapter.initialize()` → `materializeDraft()` (`remoteThreadListAdapter.tsx:224-236`; `materializeDraft.ts:88-130,156-219`). `DraftAlias` keeps the immutable panel id `chat:new` mapped to the materialized `chat:<id>` so the live runtime survives first send (`draftAlias.ts:34-62`; `DockviewWorkspace.tsx:149-159`). A fresh draft after materialization is the only `replacePanel` transition (`DockviewWorkspace.tsx:309-319`).

### 5.6 Route and focus synchronization

`useWorkspaceFocusSync` is the single convergence controller (`useWorkspaceFocusSync.ts:49-102`): local selection → `focusOrOpen` + URL; user-origin Dockview focus → store + URL; programmatic `'api'` focus is an echo and never re-enters. `useConversationTab` is the validation URL writer (engine mismatch, gone, draft fallback) and marks corrections so focus sync does not fight it (`useConversationTab.ts:60-165`). Deep links refocus after restore (`DockviewWorkspace.tsx:198-208`; `onHandleReady={refocus}` at `AppShell.tsx:181`).

### 5.7 Activation and layout persistence

`workspaceActivation.ts` tracks "has this panel's runtime started" per canonical tab key; activation is idempotent and triggered only by intentional focus (`DockviewWorkspace.tsx:249-258,274-285`). OpenCode panels are a one-way latch: dormant placeholder until activated, then full host for the panel's life (`OpenCodeChatHost.tsx:35-51,52-76,78-87`).

`layoutPersistence.ts` stores `{ version: 1, savedAt, layout }` — panel ids/params, grid structure, active group. It validates strictly, prunes stale refs, migrates v0, and returns `null` when nothing survives (`layoutPersistence.ts:17-26,73-144,146-158,195-221`). **Floating/popout/edge groups are intentionally dropped in V1** (`:186-193`) — a real behavior loss on reload.

### 5.8 Backend file operations — what actually exists

- `POST /api/tools/{read,write,edit,edit-preview,bash,list,search,stat,delete,processes,kill,sysinfo}` is a **manual/test surface** for server-executed native tools (`routes/tools.ts:41-43,65-120`). Every runner uses the **global** `WORKSPACE_DIR`, not a conversation root (`routes/tools.ts:67-107`). `runBash` confines only its starting directory; the command body is unsandboxed PowerShell with server privileges (`services/tools.ts:5-13,72-81`).
- The model-facing path resolves the conversation root per request via `resolveConversationWorkspace(threadId)` (`routes/chat/assemble-run.ts:119-135`).
- `GET /api/workspace` is a single read-only info endpoint returning `{ name, path }` of the global root (`routes/workspace.ts:5-15`) — **not** a file explorer.
- `/api/folders/browse` is a directory picker for folder registration (arbitrary local directories, directories only, no confinement) (`routes/folders.ts:21-28,112-135`). Folder registration/links/groups live under `/api/folders`.
- `resolveConversationWorkspace` maps `simple` → `workspace/chats/<conversationId>` and `project` → the registered folder's server-resolved path, with a hard `folder_unavailable` error if it vanished (`services/workspace.ts:390-522`). No client-supplied path chooses the root.

**Do not treat `/api/tools/*` or `/api/workspace` as a project-scoped file explorer API.**

### 5.9 Multi-project behavior

Project identity is bound per conversation at creation (`materializeDraft.ts:88-130,156-170`); each panel's tool calls resolve that conversation's own root (`assemble-run.ts:121`). Two already-bound conversations from different registered projects can therefore be open side by side and operate in their own directories. What does **not** exist: a per-panel project switcher, two simultaneous unsent drafts bound to different projects (there is one `chat:new`), per-project layout state, or a global active project beyond the single welcome scope (`welcomeScope.ts:11-51`).

---

## 6. What is implemented and verified

### 6.1 Implemented foundation (source-verified)

Persistent chat threads and chat workspace; Dockview-owned layout; generic panel structure with two content types; tabs and panel groups; split/resize; drag-and-drop; layout persistence/restoration with corrupt recovery; move-versus-close distinction; deep links and route/focus synchronization; theme integration; multiple Direct and OpenCode conversations; mixed arrangements; runtime isolation; draft creation; hidden-panel execution; lazy OpenCode activation; multi-project side-by-side for bound conversations. OpenCode session lifecycle is a **separate workstream** documented in `OPENCODE_SESSION_LOSS_INVESTIGATION.md` and is not part of this workspace foundation.

### 6.2 Test evidence (agent-reported, not CI-confirmed)

| Layer | Evidence |
|---|---|
| `bun run verify` | Agent-reported exit 0 — **6169 pass / 88 skip / 0 fail** (unit+integration, 6257 tests across 486 files); DOM **897 pass / 0 fail**; typecheck, lint, format:check, test:locations, build green. Re-run after P0-2. |
| E2E | Agent-reported `dockview-workspace.spec.ts` **9 passed / 0 failed** (re-run after P0-2, including the strengthened hidden-panel case); `phase-ua-d.spec.ts` 4 passed / 0 failed (earlier run, not re-run in P0-2). |
| Live runtime smoke | Agent-reported: real server started on an isolated `DATA_DIR`; `/healthz`, `/readyz`, `/`, `/api/workspace`, `/api/preferences`, `/api/conversations`, `/api/providers`, `/api/server/instance` all returned 200; a create → seed message → read-back → list → delete → list-empty conversation lifecycle succeeded over HTTP. |
| Hosted CI | **None.** GitHub returned no status checks or workflow runs for the tip commit. |

### 6.3 Workspace test inventory (static inspection, not pass claims)

| Layer | Files | Static cases |
|---|---|---|
| UNIT `tests/unit/web/workspace/` | 10 | 95 `it(` lines (layout-persistence expands to 28 runtime cases → ~109 runtime) |
| DOM `tests/dom/workspace/` | 11 | 47 (includes 5 P0-2 cases: 3 computed-theme, 2 split/group contract) |
| DOM `tests/dom/opencode/` relevant | 5 files | 29 |
| INTEGRATION `tests/integration/workspace/` | 2 | 11 (folder REST + conversation workspace fields — **not** Dockview) |
| E2E `tests/e2e/workspace/` | 1 | **9** (case 6 strengthened in P0-2) |

No skipped, todo, fixme, only, or quarantined cases were found in these files.

**Skeptical notes:** `tests/integration/workspace/` is about project folders, not Dockview. Several `tests/dom/opencode/` files are source-text guards that render nothing. `provider-boundaries.test.ts`, `dockview-theme.test.ts`, and `dockview-workspace.contract.test.ts` remain source-text guards; `dockview-theme.test.ts` is now complemented by `dockview-theme-computed.test.tsx`, which asserts computed style for six representative `--dv-*` variables (of the 31 defined in the block) against two different token sets. E2E case 6 now asserts appended transcript text (rendered, and persisted while the panel is still hidden), not just run completion. A real pointer-driven Dockview split is still E2E-only: the new DOM test covers the persistence half of the split/group contract (two-group restore, canonical identity, identity independent of group placement), not Dockview's drag-and-drop itself.

---

## 7. Capability matrix

Legend: **IV** implemented & verified (source + tests) · **IG** implemented with known gaps · **IU** implemented but insufficiently verified · **P** prototype/documentation only · **PL** planned, not implemented · **M** missing · **D** deferred intentionally · **O** requires owner decision.

### A. Workspace foundation

| Capability | Status | Notes |
|---|---|---|
| Persistent Chat Threads + Chat workspace | IV | SQLite conversations + shared membership; workspace mounted once. |
| Dockview owns layout | IV | ADR 2026-11-23; single `DockviewReact`. |
| Generic panel structure | IV | Two registered content types; identity-only params. |
| Tabs and panel groups | IV | Dockview groups; E2E split asserts 2 groups. |
| Split and resize | IU | Real pointer-driven split still E2E-only (cases 4/5/9); P0-2 adds a DOM test of the two-group persistence contract, not DnD or pixel resize. |
| Drag-and-drop | IU | Real DnD in E2E cases 2/3/4. |
| Layout persistence/restoration | IV | Versioned envelope, strict validation, stale-ref pruning. |
| Panel close vs move | IV | Unit controller + E2E cases 2/4. |
| Corrupt layout recovery | IV | Unit + E2E case 9. |
| Deep links / route-focus sync | IV | Unit + DOM + E2E case 8. |
| Window/application navigation | IV | chat → settings → chat keeps workspace mounted (DOM + E2E 7). |
| Theme integration | IV | P0-2 computed-style test resolves the real CSS block against two token sets; source-text guard retained. |
| Floating/popout groups | M / O | Explicitly dropped on restore (`layoutPersistence.ts:186-193`); owner decision on hold. |

### B. Chat capabilities

| Capability | Status | Notes |
|---|---|---|
| Multiple Direct conversations | IV | Distinct runtimes; E2E case 1. |
| Multiple OpenCode conversations | IV | Distinct contexts; DOM isolation tests. |
| Mixed Direct + OpenCode arrangements | IU | POC passed; live concurrent mixed sends remain in opt-in live suite. |
| Runtime isolation | IV | Per-host providers; `AuiProvider extends={null}`; boundary guards. |
| Conversation identity | IV | Canonical tab keys; panel registry claims by key. |
| Draft creation | IV | Single `chat:new`; alias preserves runtime across first send. |
| Hidden-panel execution | IV | P0-2 E2E case 6 asserts a post-hide completion marker in persisted messages while the panel is hidden, then in the rendered transcript. |
| Lazy OpenCode activation | IV | Dormant latch; DOM activation tests. |
| Multi-project side-by-side | IU | Source-verified per-conversation project binding; E2E asserts distinct identities, not file operations in two different project roots. |
| Session recovery boundaries | IV | Separate workstream; no automatic remote session deletion. |

### C. Non-chat content

| Capability | Status | Notes |
|---|---|---|
| File Tree | P / PL | Prototype and design docs only; no production panel. |
| File Viewer / preview | P / PL | Prototype only; no production panel. |
| Image/PDF/document preview | M | No dependency or backend capability verified for this roadmap. |
| Writable editor | D / O | `technical-audit.md`: missing real editor; needs ADR and dependency decision. |
| Terminal | P / M | Backend `runBash` tool exists; no persistent terminal panel. |
| Browser | P / M | Headless browser tool is not an interactive browser panel; Tauri CSP blocks frames. |
| Future panel extensions | PL | Generic content-type contract exists but only two types registered. |

### D. UX and quality

| Capability | Status | Notes |
|---|---|---|
| Responsive behavior | IU | Prototype scenarios; no production narrow-window acceptance test. |
| Keyboard navigation | M | No workspace keyboard spec or test found. |
| Accessibility | IU | Some a11y labels in tool UI; no workspace-level a11y acceptance. |
| Panel focus/navigation | IV | Focus sync unit + DOM tests. |
| Empty/error states | IU | Invalid params render error placeholder; no full empty-state spec. |
| Loading states | IU | Startup error status tested; general panel loading not specified. |
| Panel memory usage | M | No measurement; `renderer:"always"` keeps hidden panels live by design. |
| Large workspace performance | M | No measurement. |
| Window resizing / Tauri zoom | O | Tauri zoom cannot be reproduced on this workstation; owner machine test pending. |
| Theme consistency | IV | P0-2 computed-style test proves the mapping follows changed tokens. |

**Implemented foundation ≠ complete end-user feature.** The layout substrate is real and verified; the non-chat content types and several UX qualities are not.

---

## 8. What remains incomplete or missing

Items 4–6 were open findings when this roadmap was written and were **resolved in P0-1**. They are retained below with their resolutions for traceability; they are no longer open.

1. **No non-chat content panels.** The registry has exactly two content types.
2. **No secure project-scoped file browsing API.** `/api/tools/*` is a manual surface on the global root; `/api/workspace` is info; `/api/folders/browse` is an unconfined directory picker for registration.
3. **Floating/popout groups are dropped on restore** — a real behavior loss, not a planned feature.
4. **RESOLVED in P0-1 — manual `/api/tools/*` endpoints are not conversation-scoped.** The Workspace settings copy no longer claims every file tool is confined to one folder; it distinguishes the global manual-tool folder from per-conversation workspaces and states that shell commands are not sandboxed.
5. **RESOLVED in P0-1 — inconsistent tab-key validation.** `parseTabKey` now rejects empty refs, so it agrees with `contentTypeForTabKey` and `focusOrOpen`; `chat:` and `agent:` cannot open a phantom panel. Covered by `tests/unit/web/chat/chatTabs-parse.test.ts`.
6. **RESOLVED in P0-1 — empty panel id registration.** `registerPanelCanonicalKey` ignores an empty id and its call site is guarded, so an empty Dockview panel id cannot alias a real conversation. Covered by unit and DOM regressions.
7. **One global draft scope and one draft tab** — two unsent drafts in different projects cannot coexist.
8. **No keyboard/accessibility/responsive acceptance criteria** for the workspace.
9. **No memory/performance measurement** for many open panels or hidden-panel resource use.
10. **Tauri zoom** unverified on the owner's machine; **floating panels** on hold by owner decision.
11. **Documentation drift**: "Primary Chat" vocabulary remains in several design docs (the workspace README was corrected by this task), and a cross-reference in `DOCKVIEW_INTEGRATION_PLAN.md` points to a non-existent §13 of the session report.

---

## 9. Final product behavior

### 9.1 Plain-language vocabulary

Use these terms consistently; do not reintroduce "Primary Chat":

- **Chat Threads** — the conversation navigation list.
- **Chat workspace** — the area where conversation and other content panels appear.
- **Panel** — a generic spatial container.
- **Tab** — a specific piece of content inside a panel.
- **Content type** — what a panel renders (`direct`, `opencode`, and future types).
- **Runtime** — the independent execution system for chat content (Direct or OpenCode).
- **Layout** — the spatial arrangement managed by Dockview.

There is no privileged main position, no mandatory three-column coding layout, and no dedicated Code Workspace.

### 9.2 User-visible flows

Each flow is stated as **user action → UI response → state change → persistence → recovery**.

1. **Find and open a conversation from Chat Threads.** Click a thread → its panel is focused or opened, URL becomes `/chat/:id` or `/code/:id` → `localActiveKey` changes, shared membership unchanged → no layout write for focus alone → after restart the panel is restored from saved layout and refocused by deep link.
2. **Work with Direct and OpenCode in the same workspace.** Open one of each → two panels with distinct runtimes → each host owns its provider; no shared active pointer → panel ids and params saved → after restart both hosts remount with their own runtimes.
3. **Arrange conversations side by side.** Drag a tab to an edge → Dockview creates a new group → layout geometry changes → debounced layout save → after reload the two-group layout is restored.
4. **Put different conversations in different panels or tabs.** Add a tab to a group → Dockview group state changes → panel params remain identity-only → saved → restored with the same identities.
5. **Move panels/tabs without losing identity or runtime.** Drag a tab across groups → host component instance is preserved (`renderer:"always"`) → no tab-store or membership change → layout save records new placement → after reload identity and history are intact.
6. **Split and resize.** Drag an edge → Dockview grid changes → layout save → restored.
7. **Restore after restart.** Relaunch → preferences hydrate first → saved layout validated and applied with `reuseExistingPanels` → stale refs pruned → deep-link focus applied → corrupt layout falls back to a safe default.
8. **Add project/file tools when implemented.** Choose a content type from a panel menu → a new panel with that content type is added → its context is resolved server-side from the conversation's project → layout saves identity only → after restart the panel rebinds to the same conversation/project.
9. **Keep project and conversation contexts isolated.** Open two conversations from different projects → each panel's tool calls resolve its own conversation root → no global active project for existing conversations → layout is device-wide but context is per conversation → after restart each panel re-resolves its own root.
10. **Extend with future content types.** Register a new content type in the existing registry → no second layout engine, tab system, or runtime framework → layout params stay identity-only → saved/restored like any other panel.

### 9.3 Technical contract

- Panel id = canonical tab key; params = `{ tabKey, contentType }`, strictly validated.
- Dockview owns geometry; TBAi owns identity, routing, activation, persistence policy, and security.
- Each runtime-bearing panel owns its provider; hidden panels keep executing by design.
- Layout state contains no message text, drafts, credentials, paths, or runtime objects.
- Project context is resolved server-side per conversation; no client-supplied root.

---

## 10. Architecture that must remain stable

1. **Dockview is the sole layout engine.** No recursive layout tree, splitter framework, or parallel workspace DnD.
2. **One canonical conversation identity** (`chatTabs` + SQLite). No second tab store or message store.
3. **Direct and OpenCode runtimes stay separate.** No merged runtime, universal chat manager, or engine capability framework.
4. **One router** (`createHashRouter` in `web/src/app/router.tsx`); route views stay thin triggers.
5. **One provider per runtime-bearing panel**; no root `AssistantRuntimeProvider`.
6. **State tiers unchanged** (state-management.md): SQLite → server truth; assistant-ui → conversation/message state; OpenCode V2 → Code-mode state; Zustand → shared UI; localStorage → device preferences.
7. **File ownership unchanged**: `features/workspace/` owns workspace UI/state; `features/<feature>/` owns feature concerns; `components/` is genuinely shared; `lib/`/`config/` are shared utilities/config.
8. **No new dependency without a recorded decision.** Editor, terminal, and browser libraries each need an ADR before adoption.
9. **Security**: server resolves all project roots; path containment and symlink safety enforced; no arbitrary client-supplied absolute paths; shell execution is not a sandbox.
10. **OpenCode session lifecycle**: shared DB, no automatic remote deletion (separate workstream ADR).
11. **Threat model — no caller authorization exists.** TBAi has no login, no master password, and no authentication middleware (`AGENTS.md`; `src/routes/index.ts` composes middleware with no auth gate). A `conversationId` is an unauthenticated capability, **not** an authorization decision. Path containment (`resolveSafe`) restricts *where* a request may read, not *who* may read it. Any client that can reach the HTTP server can invoke a project-scoped endpoint with any conversation id it knows. This is consistent with the app's local-first, single-user, loopback-only stance, but it must be stated explicitly: the proposed file tree, viewer, editor, terminal and browser panels widen the reachable surface beyond the global-root `/api/tools/*` manual endpoints this document criticizes. Every such phase must record this trade-off and must not use the word "authorization" to mean mere path containment.

---

## 11. Implementation roadmap

Priorities: **P0** = correctness and honesty of the existing foundation (small, evidence-backed); **P1** = high-value user capabilities with low architectural risk; **P2** = optional or security-sensitive capabilities requiring owner decisions. No calendar dates or completion percentages are asserted.

### Phase P0-1 — Foundation correctness and documentation honesty

1. **Goal / user result:** The workspace behaves consistently at its edges; docs tell the truth about authority and vocabulary.
2. **Why:** Source-visible gaps (floating-group loss, tab-key validator mismatch, empty panel-id registration, overstated file-tool copy) and stale docs.
3. **Reuse:** Existing `layoutPersistence`, `dockviewParams`, `chatTabs`, `workspaceActivation`, `WorkspacePage`.
4. **Out of scope:** New content types, new dependencies, layout redesign.
5. **Decisions required:** None. The existing on-hold floating-panel decision is preserved: P0-1 keeps the current behavior (floating/popout groups are dropped on restore) and adds a test documenting it. Changing that behavior is a separate owner decision (§12) and belongs in P1-4, not here.
6. **Modules likely affected:** `layoutPersistence.ts`, `dockviewParams.ts`, `chatTabs.ts`, `DockviewWorkspace.tsx`, `WorkspacePage.tsx`.
7. **Backend/frontend:** Frontend-only plus copy correction; no backend contract change.
8. **Tests:** Unit for tab-key validator parity; layout test asserting the current floating-group drop behavior; DOM for empty-panel-id registration.
9. **Acceptance:** `chat:` is rejected by both validators; no empty-string canonical key is registered; Workspace settings copy matches the real tool scoping; README points to `DOCKVIEW_INTEGRATION_PLAN.md`.
10. **Risks/rollback:** Low; each change is isolated and reversible.
11. **Dependencies:** None.
12. **Definition of done:** Typecheck/build/lint/format green; affected unit/DOM tests pass; full gate re-run; UI copy reviewed.

### Phase P0-2 — Verification integrity for the existing foundation

1. **Goal:** Claims about the foundation are backed by behavioral tests, not only source-text guards.
2. **Why:** Split/resize is E2E-only; theme mapping is a CSS-text guard; hidden-panel E2E asserts completion but not transcript content.
3. **Reuse:** Existing E2E harness, DOM harness, `ControlledProvider`.
4. **Out of scope:** New features.
5. **Decisions required:** None.
6. **Modules:** Tests only (`tests/unit/web/workspace/`, `tests/dom/workspace/`, `tests/e2e/workspace/`).
7. **Backend/frontend:** Test-only.
8. **Tests:** DOM split/group contract; computed-style theme test where feasible; E2E hidden-panel transcript assertion.
9. **Acceptance:** Each named capability has at least one behavioral test that would fail if the behavior regressed.
10. **Risks:** Test-only changes; no product risk.
11. **Dependencies:** P0-1 (stable contracts).
12. **DoD:** Full gate green; test counts recorded; no test weakened.

### Phase P1-1 — Content-type contract guardrails (no new abstraction)

1. **Goal:** Prove and document that the existing registry contract is sufficient for a third content type before any new panel is built.
2. **Why:** The registry already supports a new type by adding one union member in `dockviewParams.ts:17` and one `COMPONENTS` entry in `DockviewWorkspace.tsx:58-61`. Building a generic host framework now would violate `AGENTS.md` ("prove duplication before consolidating"; "a shared helper needs a second real caller").
3. **Reuse:** `dockviewParams.ts`, `panelRegistry.ts`, `dockviewController.ts`, `DockviewWorkspace.tsx` — unchanged in production.
4. **Out of scope:** Any new generic host component, abstraction layer, or specific new panel; editor/terminal/browser.
5. **Decisions required:** Content identity and context contract for non-chat panels (owner review) — recorded, not implemented here.
6. **Modules:** Tests and documentation only. No production module changes.
7. **Backend:** None. **Frontend:** None.
8. **Tests:** Unit proving `parsePanelParams` rejects a mismatched `contentType` and extra keys; DOM proving the existing `COMPONENTS` map is the only registration point; a documented spike showing a third type needs exactly one union member + one map entry.
9. **Acceptance:** The contract is proven sufficient with zero new production abstractions; the exact two-line extension is documented; no second layout engine/tab system/runtime framework is introduced.
10. **Risks:** Speculative abstraction — explicitly out of scope; if the spike shows the contract is insufficient, record the finding and revise this phase before implementing P1-2.
11. **Dependencies:** P0-1, P0-2.
12. **DoD:** Spike result recorded; full gate green; no production code added.

### Phase P1-2 — Project-aware read-only File Tree (first non-chat panel)

1. **Goal:** User can browse a conversation's project files in a Dockview panel, read-only.
2. **Why:** Highest-value, lowest-risk non-chat capability; unblocks viewer.
3. **Reuse:** `resolveConversationWorkspace`, `inspectTarget`/`resolveSafe`, folder registry, and the existing Dockview registration path proven in P1-1 (one union member + one `COMPONENTS` entry).
4. **Out of scope:** Editing, writing, deleting, terminal, browser.
5. **Decisions required:** Confirm File Tree as the first non-chat panel; confirm read-only scope.
6. **Modules:** New backend route under `src/routes/` (e.g. `/api/project-files`), service using `resolveConversationWorkspace` + `resolveSafe`; new frontend feature area for the panel.
7. **Backend:** Resolve root server-side from `conversationId`; list/navigate with containment and symlink safety; no arbitrary absolute paths. **Frontend:** Tree UI, loading/error/permission states, panel registration.
8. **Tests:** Integration for containment, symlink escape, missing folder, permission errors; DOM for tree states; E2E for open → browse → panel persistence.
9. **Acceptance:** A user opens a conversation with a registered project, sees its file tree, navigates directories, and after restart the panel rebinds to the same conversation; no path outside the authorized root is listable.
10. **Risks:** Path traversal/symlink escape — mitigate with existing `resolveSafe`; rollback by removing the route and panel registration. **Threat model (§10.11):** no caller authorization exists; `conversationId` is an unauthenticated capability. This phase widens the reachable surface beyond `/api/tools/*`; record that trade-off explicitly and do not describe containment as authorization.
11. **Dependencies:** P1-1.
12. **DoD:** Security tests fail on escape attempts; full gate green; UI flow walked step by step.

### Phase P1-3 — Read-only File Viewer / preview

1. **Goal:** Selecting a file opens it in a separate read-only panel.
2. **Why:** Natural companion to File Tree; read-only keeps risk low.
3. **Reuse:** File Tree selection, same project-file service, Dockview generic host.
4. **Out of scope:** Editing/saving; unsupported binary formats; new preview libraries without an ADR.
5. **Decisions required:** Which formats are in scope after verifying current dependencies/backend capabilities.
6. **Modules:** Backend read endpoint with containment + size/encoding limits; frontend viewer component(s).
7. **Backend:** Serve file bytes/text with authorization and limits. **Frontend:** Text/markdown/image/PDF rendering only where the installed stack supports it; large-file and unsupported-format states.
8. **Tests:** Integration for authorization, size limits, encoding; DOM for viewer states; E2E for select → view → refresh → restart.
9. **Acceptance:** Supported files render read-only; unsupported formats show a clear state; no write path exists; project context matches the file tree.
10. **Risks:** Large files, encoding, binary safety — bounded reads and explicit unsupported states. **Threat model (§10.11):** same unauthenticated-capability exposure as P1-2; read-only does not mean access-controlled.
11. **Dependencies:** P1-2.
12. **DoD:** Full gate green; format list recorded in docs; UI flow walked.

### Phase P1-4 — UX, responsive, accessibility and performance polish

1. **Goal:** Workspace is usable on narrow windows, by keyboard, and with many panels.
2. **Why:** These qualities are currently untested or missing.
3. **Reuse:** Dockview built-in keyboard/DnD, `useDesktopLayout`, theme tokens.
4. **Out of scope:** Floating panels (owner decision), new Dockview capabilities.
5. **Decisions required:** Narrow-screen behavior; floating panels; Tauri zoom verification result.
6. **Modules:** Workspace components, CSS tokens, E2E/DOM tests.
7. **Backend:** None. **Frontend:** Minimum panel sizes, overflow, focus restoration, a11y labels, hidden-panel resource policy.
8. **Tests:** DOM keyboard/focus; E2E responsive viewports; performance measurement where feasible.
9. **Acceptance:** Named viewport sizes have documented behavior; keyboard flow reaches every panel; no hidden panel is silently disposed; measurements recorded or explicitly marked unmeasured.
10. **Risks:** Visual regressions — mitigate with E2E screenshots and token-based styling.
11. **Dependencies:** P0-1, P0-2.
12. **DoD:** Full gate green; owner decisions recorded; UI flow walked.

### Phase P2-1 — Writable editor (conditional)

1. **Goal:** Edit project files in a panel with safe save/conflict behavior.
2. **Why:** Desired capability, but currently missing and dependency-sensitive.
3. **Reuse:** File viewer read path and project authorization from P1-2/P1-3.
4. **Out of scope:** Adding an editor dependency in this roadmap; full IDE features.
5. **Decisions required:** Editor library ADR; dirty-state/conflict policy; save authorization.
6. **Modules:** New editor host under `features/workspace/` or a dedicated feature; backend write endpoint with containment.
7. **Backend:** Authorized write with conflict detection. **Frontend:** Dirty state, unsaved-change confirmation, recovery after interruption.
8. **Tests:** Integration for write authorization/conflict; DOM for dirty/confirmation; E2E for edit → save → reload.
9. **Acceptance:** No write outside authorized root; unsaved changes never silently lost; conflicts surfaced.
10. **Risks:** Data loss and unauthorized writes — highest-risk phase; rollback by disabling the panel. **Threat model (§10.11):** no caller authorization; a write endpoint keyed by `conversationId` is reachable by any local client. Owner must accept this before implementation.
11. **Dependencies:** P1-3 + editor ADR.
12. **DoD:** ADR approved; full gate green; UI flow walked.

### Phase P2-2 — Terminal panel (conditional)

1. **Goal:** A persistent terminal panel scoped to a conversation's project.
2. **Why:** Backend `runBash` exists but is not a terminal panel; shell execution is not sandboxed.
3. **Reuse:** Existing tool execution and permission UI where appropriate.
4. **Out of scope:** Treating `runBash` as equivalent to an interactive terminal.
5. **Decisions required:** Process lifecycle, authorization, and whether unsandboxed shell is acceptable in a panel.
6. **Modules:** Backend process service; frontend terminal host.
7. **Backend:** Owned process lifecycle, cwd confined to conversation root, explicit authorization. **Frontend:** Terminal UI, interrupt/close behavior.
8. **Tests:** Integration for cwd confinement and process teardown; DOM/E2E for panel lifecycle.
9. **Acceptance:** No process outlives its panel; cwd is the conversation root; user-visible warning that shell is not sandboxed.
10. **Risks:** Privilege and lifecycle — stop if authorization is unclear. **Threat model (§10.11):** no caller authorization; an unsandboxed shell keyed by `conversationId` is a materially wider surface than the existing tool. Owner must accept this before implementation.
11. **Dependencies:** P1-1, P1-2.
12. **DoD:** Security review; full gate green; UI flow walked.

### Phase P2-3 — Interactive browser panel (conditional)

1. **Goal:** An embedded interactive browser panel.
2. **Why:** Design docs mention it; no production capability exists.
3. **Reuse:** None proven — headless browser tool is not an embedded browser; Tauri CSP blocks frames.
4. **Out of scope:** Assuming the headless browser tool satisfies this.
5. **Decisions required:** Scope, CSP/webview strategy, security model.
6. **Modules:** TBD after feasibility study.
7. **Backend/frontend:** TBD.
8. **Tests:** TBD after feasibility; must include navigation, isolation, and teardown.
9. **Acceptance:** A documented, approved security model exists before implementation.
10. **Risks:** High — webview/CSP/security; do not start without owner approval. **Threat model (§10.11):** no caller authorization; an embedded browser would inherit the app's unauthenticated local surface.
11. **Dependencies:** Owner decision + feasibility study.
12. **DoD:** Feasibility report + ADR; no implementation in this roadmap.

### Phase P2-4 — Project-specific layout presets (conditional)

1. **Goal:** Optional per-project layout presets on top of the device-wide layout.
2. **Why:** Current layout is device-wide; project context is per conversation.
3. **Reuse:** `layoutPersistence` versioning/migration; per-conversation project binding.
4. **Out of scope:** Per-project Dockview instances (would violate the ADR).
5. **Decisions required:** Whether a demonstrated user requirement justifies presets.
6. **Modules:** `layoutPersistence.ts`, preferences store, settings UI.
7. **Backend:** None. **Frontend:** Preset selection and migration.
8. **Tests:** Unit for version migration; E2E for preset switching.
9. **Acceptance:** No second Dockview; project isolation preserved; rollback to device-wide layout possible.
10. **Risks:** Complexity without proven need — defer unless requested.
11. **Dependencies:** P1-4.
12. **DoD:** Owner requirement recorded; full gate green.

### Milestone summary

| Milestone | User gain |
|---|---|
| P0-1 + P0-2 | Honest docs, consistent panel identity rules, verified foundation claims. |
| P1-1 | Proof that the existing contract needs no new abstraction before the first real panel. |
| P1-2 | Browse a conversation's project files in a panel. |
| P1-3 | Open supported files read-only in a panel. |
| P1-4 | Usable narrow-window, keyboard-accessible, measured workspace. |
| P2-1 | Safe writable editing (after ADR). |
| P2-2 | Scoped terminal panel (after security decision). |
| P2-3 | Interactive browser (after feasibility + security decision). |
| P2-4 | Optional project layout presets (after demonstrated need). |

---

## 12. Owner decisions

| Question | Options | Recommendation | Reason | Cost of postponing | Blocks implementation? |
|---|---|---|---|---|---|
| Floating panels? | Enable Dockview floating/popout; keep dropped; support in persistence | Keep on hold; record as explicit decision | Currently dropped on restore; enabling needs persistence and security review | Users who pop out panels lose arrangement on reload | P1-4 only — P0-1 preserves current behavior and tests it |
| Narrow-screen workspace? | Collapse to single panel; horizontal scroll; minimum sizes + overlay | Minimum sizes + overlay, documented | Preserves Dockview model; no second layout | Inconsistent small-window UX | P1-4 |
| Device-wide vs project-specific layouts? | Device-wide only; per-project presets | Device-wide now; presets later if requested | Current model works; no demonstrated need | Users cannot save per-project arrangements | P2-4 only |
| First non-chat panel? | File Tree; Viewer; Terminal; Browser | File Tree, then read-only Viewer | Lowest risk; reuses existing containment | No non-chat capability ships | P1-2 |
| Viewer vs editor sequencing? | Viewer first; editor first | Viewer first; editor conditional on ADR | Editor needs dependency + conflict policy | Editing delayed | P2-1 |
| Interactive browser scope? | None; headless tool only; embedded panel | None until feasibility + security ADR | CSP/webview risk; headless tool is not a panel | Browser capability delayed | P2-3 |
| Terminal panel scope? | None; tool-only; persistent scoped panel | Tool-only until lifecycle/security decision | `runBash` is unsandboxed | Terminal delayed | P2-2 |
| Future panel extensibility? | Per-feature bespoke panels; one generic content contract | One generic content contract | Avoids second panel framework | Each new panel becomes bespoke | P1-1 |
| Tauri zoom? | Accept current; fix in packaged build | Verify on owner machine, then decide | Cannot be reproduced on this workstation | Packaged zoom behavior remains unconfirmed | P1-4 |
| Per-panel project switcher / multiple drafts? | Keep single global scope; add per-panel scope | Keep single scope until demonstrated need | One draft tab and one welcome scope today | Cannot compose two unsent drafts from different projects | Not blocking |

Recommendations are not approvals. Each decision must be recorded in `docs/decisions.md` before the corresponding phase starts.

---

## 13. Verification strategy

Use the repository's established gates (`docs/engineering-quality.md`): `bun run verify` (typecheck, lint, format:check, test:locations, build, unit+integration, lifecycle suites, DOM, quarantine), plus `bun run test:e2e` and `bun run security` where applicable.

| Phase | Required tests |
|---|---|
| P0-1 | Unit: tab-key validator parity, empty-panel-id guard. Layout: chosen floating-group behavior. DOM: settings copy. |
| P0-2 | DOM: split/group contract, computed theme tokens. E2E: hidden-panel transcript assertion. |
| P1-1 | Unit: `parsePanelParams` rejection cases. DOM: `COMPONENTS` map is the sole registration point. Spike: two-line third-type extension documented. |
| P1-2 | Integration: containment, symlink escape, missing folder, permission errors. DOM: tree states. E2E: open → browse → restart. |
| P1-3 | Integration: authorization, size/encoding limits. DOM: viewer states. E2E: select → view → refresh → restart. |
| P1-4 | DOM: keyboard/focus. E2E: responsive viewports. Performance measurement where feasible. |
| P2-1 | Integration: write authorization/conflict. DOM: dirty/confirmation. E2E: edit → save → reload. |
| P2-2 | Integration: cwd confinement, process teardown. DOM/E2E: panel lifecycle. |
| P2-3 | Feasibility report + ADR before tests are defined. |
| P2-4 | Unit: version migration. E2E: preset switching. |

**UI acceptance format:** every UI test must state what the user clicks, what appears, what state changes, what is saved, and what happens after restart. Examples:

- *File Tree:* click a Chat Thread with a registered project → a File Tree panel appears → the panel records `{tabKey, contentType:"file-tree"}` → layout saves identity only → after restart the panel rebinds to the same conversation and lists the same root.
- *Viewer:* click a file in the tree → a read-only viewer panel opens → no write endpoint is called → layout saves identity only → after restart the same file is reopened read-only.

Do not claim a future test exists or passes. Do not treat a source-text guard as a behavioral test. Do not treat agent-reported counts as CI evidence.

---

## 14. Documentation organization

Create this document as the single authoritative product/roadmap source. Update `docs/workspace-redesign/README.md` only as needed to:

- Point to `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md` as the authoritative product direction and roadmap.
- Point to `DOCKVIEW_INTEGRATION_PLAN.md` as the authoritative implementation specification and verification record.
- Link completed evidence: `DOCKVIEW_POC_RESULT.md`, `DOCKVIEW_STARTUP_OPTIMIZATION_PLAN.md`, `MULTI_PROJECT_SIDEBYSIDE_AUDIT.md`, `PROVIDER_AUDIT.md`.
- Link supporting audits: `technical-audit.md`, `multi-chat-architecture-audit.md`, `product-architecture.md`, `interaction-model.md`.
- Mark `WORKSPACE_ARCHITECTURE_PLAN.md`, `DOCKVIEW_EVALUATION_PLAN.md`, `2026-11-22-foundation-architecture-audit.md`, `right-hand-workspace-audit.md`, and `right-hand-workspace-demo.html` as historical/superseded.
- Mark `OPENCODE_SESSION_LOSS_INVESTIGATION.md` as a separate workstream.
- Use current vocabulary (Chat Threads, Chat workspace, Panel, Tab, Content type, Runtime, Layout); remove "Primary Chat" as a live concept.
- Preserve the prototype and its untracked screenshots; do not rewrite historical evidence.

Do not modify source code, tests, package manifests, or application configuration in this documentation task.

---

## 15. Unverified findings and open questions

- Hosted CI status for the tip commit: **none returned**; all gate results are agent-reported.
- Live-credential E2E suite: agent-reported 8 pass / 7 fail / 3 skip against OpenCode 2.4.0; failures are stale spec expectations and a stub-provider harness issue, not verified product defects.
- Tauri zoom: cannot be reproduced on this workstation; owner machine test pending.
- Floating panels: on hold by owner decision; currently dropped on restore.
- Large-workspace memory/performance: unmeasured.
- Mixed Direct + OpenCode concurrent live sends: POC passed for mounting; live sends remain in the opt-in suite.
- Several DOM-located OpenCode tests are source-text guards that render nothing; their names overstate behavioral coverage.
- `DOCKVIEW_INTEGRATION_PLAN.md` cross-references `OPENCODE_SESSION_LOSS_INVESTIGATION.md` §13, but that document ends at §12 — a stale cross-reference to correct when those docs are next touched.

---

## 16. Final answer to the owner

The Dockview foundation is implemented and verified to the extent the repository's gates and E2E suite can show. Build next, in order:

1. **P0** — close the small source-visible correctness gaps and make the docs honest.
2. **P1** — prove the existing content-type contract needs no new abstraction, then add a project-scoped read-only File Tree, then a read-only Viewer, then UX/responsive/accessibility polish.
3. **P2** — only after owner decisions: editor, terminal, interactive browser, and optional project layout presets.

Each phase is finished only when its named tests exist and pass, its acceptance criteria are met with real output, the full gate is green, and the user-visible flow has been walked step by step. No phase is complete because its code compiles.

---

## 17. Independent review record

This document was reviewed by a fresh-context subagent against current source, existing tests, accepted ADRs, product decisions, and the owner's 15-point brief. The review was read-only; no source, test, database, or configuration file was changed by it.

**Verdict:** no Critical issues. All nine source claims the reviewer was asked to challenge were verified accurate at `65e97c4` (two content types; `WorkspacePage.tsx` is a settings page; `renderer:"always"`; floating groups dropped on restore; `/api/tools` on the global root; `/api/workspace` info-only; one draft tab; dead `groupId`; per-conversation project binding). Commit hashes, agent-reported test counts, and the three relevant ADRs were checked and found consistent.

**Important findings and resolutions:**

| Finding | Resolution applied |
|---|---|
| Document described the workspace README as still stale after this task had corrected it | §4 classification, §4 corrections, §8 item 11 and §14 now state the correction is complete. |
| Floating-panel decision contradicted itself on whether it blocks P0-1 | P0-1 now preserves current behavior and tests it; §12 marks the decision as blocking P1-4 only. |
| P1-1 proposed a generic host abstraction before a second real caller | P1-1 is now tests/documentation only; the first real panel extends the existing union + `COMPONENTS` map. |
| File/editor/terminal/browser phases used "authorization" without a threat model | §10.11 states that no caller authorization exists; each affected phase now records the unauthenticated-capability trade-off. |

**Minor findings and resolutions:** DOM workspace test count corrected 39 → 42; working-tree note qualified as "at verification time"; multi-project side-by-side downgraded IV → IU (source-verified, not behavior-verified); session recovery boundaries removed from the source-verified foundation list and kept as a separate workstream.

**Unmet brief item at review time:** the document did not record that an independent review had occurred. This section is that record. No unresolved disagreement remains from the review.

---

## 18. P0-2 completion record

P0-2 (§11, §13) is complete. It was test-only: no production source, schema, config, or dependency changed.

**What was added**

| File | Evidence added |
|---|---|
| `tests/dom/workspace/dockview-theme-computed.test.tsx` | Injects the real `.dockview-theme-tbai` block from `globals.css` into happy-dom and asserts `getComputedStyle` resolves six representative `--dv-*` variables (of 31) from two different token sets. Complements the source-text guard, which is retained. |
| `tests/dom/workspace/dockview-split-group-contract.test.tsx` | DOM-renders a restored two-group layout; asserts two distinct groups, canonical panel ids, identity-only params, and identity independent of group placement. Covers the persistence half of the split contract; real DnD remains E2E-only. |
| `tests/e2e/helpers/controlledProvider.ts` | Optional `completionText` emitted only on `complete()`, so a marker can arrive after a panel is hidden. Backward-compatible. |
| `tests/e2e/workspace/dockview-workspace.spec.ts` | Hidden-panel case asserts the marker is absent before `complete()`, present in persisted messages **while A is still hidden**, and present in the rendered transcript after returning — not just run completion. |

**Guards proven to fail (mutation checks, all reverted):** hardcoding a theme color in `globals.css` failed 3 computed-style assertions; dropping the second group leaf in `pruneNode` failed both split/group assertions; suppressing the completion frame failed the hidden-panel E2E assertion. Production files were restored byte-identically.

**Verification:** `bun run verify` exit 0 — 6169 pass / 88 skip / 0 fail; DOM 897 pass / 0 fail. `bun run test:e2e --project=chromium-headless dockview-workspace.spec.ts` exit 0 — 9 passed / 0 failed. `git diff --check` exit 0. A live server smoke test (isolated `DATA_DIR`) returned 200 for all core endpoints and completed a create → seed → read-back → list → delete conversation lifecycle. All results are agent-reported; hosted CI remains absent (§1).

**Capability matrix changes:** Theme integration and Theme consistency IU → IV; Hidden-panel execution IU → IV. Split and resize stays IU — the real pointer-driven split is still E2E-only and resize is unmeasured.
