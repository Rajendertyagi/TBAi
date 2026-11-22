# TBAi Foundation Architecture Audit — `ui-foundation-upgrade`

**Date:** 2026-11-22
**Repository:** `Rajendertyagi/TBAi`
**Branch:** `ui-foundation-upgrade`
**Audited code commit:** `55b8ed5edcf3c79035c653a70a78f21b49bea888` (`fix(chat): correct multi-chat operation and draft-pick lifecycle`, parent `d3d81a6`, 13 files)
**Report commit:** `259f4b41162b4a5e77384e1638b28b1bda2c5bfa` (`docs: add independent TBAi foundation architecture audit`, parent `55b8ed5`, one file — this report)
**Mode:** independent, read-only audit. Seven parallel `opencode/iceman-free` auditors inspected actual source; the project manager independently verified the remote commits via `git ls-remote` and GitHub API, the git state, installed dependency versions, and central source claims. No implementation, no production-code changes, no dependency changes.

**Revision note:** this is the corrected version after independent review of the first report. Section H records which earlier recommendations remain valid and which were wrong or overstated. The most important corrections are: there is no "Primary Chat" concept in the product requirements; the DOM test proves only sibling reordering under one parent (not cross-container moves or runtime-state preservation); and multiple Direct runtimes already work and were previously tested — they must not be rebuilt.

## Evidence categories

| Category | Meaning |
|---|---|
| **Independently verified source behavior** | `file:line` claims read directly from the working tree by auditors or the PM. |
| **Agent-reported test results** | Test counts or spike outcomes stated in docs, not re-run in this audit. |
| **Actual CI results** | An observed workflow/check result. **None available** — no check runs, commit statuses, or Actions runs for this branch. |
| **Untested / unknown** | Plausible but not proven by inspected source or tests. |

---

## 0. Product requirements (corrected)

The intended product, as stated by the owner:

- **Chat Threads** is persistent conversation navigation. **Chat** is a persistent workspace area. These are the two permanent areas.
- **There is no "Primary Chat" concept** — not a conversation, not a runtime, not a privileged position. The term appears in older design documents and in current code comments, but it is not a product requirement and must not be reintroduced.
- **Chat can display Direct or OpenCode content.** Both are equally valid conversation types; their execution systems remain isolated.
- **Other workspace content** (files, terminal, browser, viewer, additional chats, etc.) is flexible: addable, rearrangeable, and not tied to a fixed template. Layout examples are demonstrations, not fixed layouts.
- Conversation identity and runtime ownership must not depend on screen position.

Where this report uses "active surface" or "the routed chat area", it means the currently displayed content, not a privileged Primary Chat.

---

## A. Current architecture

**Backend (one Bun/Hono process).** `src/routes/index.ts` composes per-concern modules; dependency direction is `routes → services → db` with four documented value-level `routes → db` exceptions (`index.ts:6`, `providers.ts:2`, `memories.ts:3`, `scheduler.ts:6`). Direct streaming uses AI SDK v7 with a process-local run registry (`src/services/chat-runs.ts`) plus a durable SQLite resumable store (`src/lib/resumable.ts`, `src/services/chat-streams/*`). OpenCode is isolated in `src/services/opencode/` behind an allowlisted proxy (`proxyRoutes.ts:1-205`, `proxyAuthorization.ts:96-159`). MCP is server-executed behind `mcpManager`. Credentials are AES-256-GCM encrypted under a per-install DEK.

**Frontend (one presentation layer, two isolated runtimes).** `AppShell.tsx:112-128` derives `runtimeThreadId` from the active chat tab and creates one Direct runtime via `useAppChatRuntime`, provided to the whole shell at `AppShell.tsx:229`. `ChatShell` is a branch shell only; `CodeShell` mounts OpenCode at `/code/:agentId?`. `ChatWindow` is engine-neutral via `mode="chat" | "agent"`. OpenCode uses `AuiProvider extends={null}` (`OpenCodeIsolationBoundary.tsx:10-15`); panel Direct hosts use the same pattern (`DirectChatHost.tsx:25-46`).

**Identity.** Conversation `ref` + `kind` is canonical (`chatTabs.ts:20-27,92-108`), mapped to `chat:<id>` / `agent:<id>` and `/chat/:id` / `/code/:id`. Shared membership is SQLite-authoritative via preferences snapshot; local active key, draft, detached refs are per-window Zustand. Reconciliation is removal-only on confirmed 404 (`tabReconciliation.ts:20-81`).

**Workspace panels.** `workspacePanels.ts:15-61` stores `{id, tabKey, order}` only. `WorkspaceSurface.tsx:14-47` renders stable keyed hosts, filters the active tab, and mounts `DirectChatHost` for bound Direct chats. No persistence, no move/close/resize/split UI, no non-chat content.

**Verified installed versions:** `@assistant-ui/react@0.15.32`, `@assistant-ui/ai-sdk@0.0.16`, `ai@7.0.145`, `assistant-stream@0.3.55`, `@opencode/client@2.2.6`.

---

## B. Updated foundation assessment

| Area | Class | Severity | Confidence | Change from first report |
|---|---|---:|---|---|
| Conversation identity / tab keys / routes | **KEEP** | Low | High | unchanged |
| Shared membership vs local presentation split | **KEEP** | Low | High | unchanged |
| Direct/OpenCode execution isolation | **KEEP** | Low | High | unchanged |
| Direct runtime factory + panel host (`DirectChatHost`) | **KEEP** | Low | High | unchanged — do not rebuild |
| OpenCode session-scoped runtime + dispose/reconnect | **KEEP** | Low | High | unchanged — do not rebuild |
| Sibling reorder preserves DOM node (same parent, keyed) | **KEEP** (narrow) | Low | High | narrowed: was overstated as general "stable host invariant" |
| Per-thread operation scoping, query-keyed cache, per-owner history visit | **KEEP** | Low | High | unchanged |
| Backend streaming durability + cleanup | **KEEP** | Low | High | unchanged |
| Credential/approval/proxy/path-confinement security | **KEEP** | Low | High | unchanged |
| Router owns pages only | **KEEP** | Low | High | unchanged |
| Multiple Direct runtimes in one page | **KEEP** (with caveats) | Medium | Medium | changed: was REDESIGN; existing implementation + prior spike, no permanent E2E |
| AppShell responsibility concentration | **IMPROVE** | Medium | High | unchanged, but extraction is now shown to be non-trivial |
| Global one-shot provider overrides | **IMPROVE** | Medium | High | unchanged |
| Module-level singleton inventory/reset discipline | **IMPROVE** | Medium | Medium | unchanged |
| `runBash` unsandboxed boundary | **IMPROVE** (make unmissable) | High if misunderstood | High | unchanged |
| Workspace panel model (Direct-only, no persistence) | **IMPROVE** | Medium | High | changed: was REDESIGN; the store is a sound minimal base, not a failed design |
| Active-surface special-casing in panel eligibility | **IMPROVE** | Medium | High | reframed: no "Primary Chat" concept |
| OpenCode panel hosting | **DEFER** | Medium | High | changed: was REDESIGN; no owner requirement to place OpenCode outside Chat yet |
| Cross-container move / split / resize / non-chat content | **DEFER** | Medium | High | unchanged as future capability |
| Multi-draft support | **DEFER** (v1 assumption) | High if changed | High | unchanged |
| Real multi-surface E2E coverage | **IMPROVE** | Medium | High | changed: was REDESIGN; add coverage, do not redesign runtime |
| Capacity policy for many open panels | **DEFER** | Low | Low | changed: removed as a "risk"; no evidence of a problem |

---

## C. Findings

### Verified facts and real risks

1. **AppShell concentrates more than chrome — but extraction is not a simple move.** Full responsibility trace (`AppShell.tsx:87-305`):
   - Draft one-shot pick lifecycle subscription (`useDraftPickLifecycle()`, `:91`).
   - Chrome layout state and CSS variable publication (`:93-97,179-186`).
   - Tab state reads and active conversation selection via `visibleTabs` (`:99-111`).
   - `runtimeThreadId` derivation from the active chat tab, excluding drafts (`:112-113`).
   - **Draft materialization binding**: `handleThreadIdChange` calls `resolveDraftId(id, peekMaterializedEngine(id) ?? getWelcomeEngineSnapshot().engine)` when the active tab is `chat:new`, otherwise `presentChat(id)` (`:115-126`). Engine selection and draft→conversation binding live here.
   - Direct runtime creation (`:128`) and the single `AssistantRuntimeProvider` wrapping the shell (`:229`).
   - Panel candidate selection and open-in-panel policy (`:137-152,246-257`).
   - Provider loading (`:154-157`), `AuiConfig` (`:159-170`).
   - Availability poller + recovery + tab reconciliation registration (`:194-203`), preferences start/sync (`:205-212`), remote shared-membership detached marking (`:217-226`).
   - UI composition: ActivityBar, Sidebar, TabStrip, Outlet, WorkspaceSurface, StatusBar, overlays, shortcuts, URL sync, route observer (`:228-303`).
   - **Sidebar behavior**: the Sidebar reads the canonical thread-list state from the shell runtime; this is why the root runtime is shell-owned (comment at `:75-79` of the earlier read; `Sidebar` is rendered at `:235`).
   - Consequence: moving runtime ownership out of AppShell means also relocating draft materialization binding, engine selection, route binding, and the sidebar's canonical thread-list source. This is a design decision, not a refactor. **Severity Medium, Confidence High.**

2. **Global one-shot overrides can cross concurrent Direct surfaces.** `providersStore.ts:30-32,89-96` holds `selectedProviderId/ModelId/ReasoningLevel` globally; `runtime.ts:337,379-423` consumes and reverts them. Two concurrent Direct sends can race on consumption/revert. **Severity Medium, Confidence High.**

3. **`runBash` is not sandboxed.** `src/services/tools.ts:1-40,342-360` confines only the starting directory; the command body runs with server privileges. Future terminal/workspace features must not be treated as sandboxed. **Severity High if misunderstood, Confidence High.** Documented boundary fact, not a missing feature.

4. **Boundary debt.** Four value-level `routes → db` imports and route-local idempotency maps (`src/routes/conversations.ts:44-78,135-241`). **Severity Medium, Confidence High.**

5. **Active-surface special-casing, not a "Primary Chat" concept.** `WorkspaceSurface.tsx:16-23` filters the active tab out of panels; `AppShell.tsx:138-147` only offers a *different* bound chat for a panel; `workspacePanels.ts:38-46` rejects drafts and agent tabs. The reason is concrete: two live runtimes for the same `threadId` would conflict, and draft materialization must run through the shell's `resolveDraftId`. This is a current constraint to design around, not evidence of a privileged product concept. **Severity Medium, Confidence High.**

### Multiple Direct runtimes — accurate classification

- **Existing implementation:** `DirectChatHost.tsx:25-46` creates an isolated Direct runtime per panel using `AuiProvider extends={null}` and the shared `useAppChatRuntime` factory. `WorkspaceSurface.tsx:14-47` mounts these as keyed siblings. This is working production code; **do not rebuild it.**
- **Previously tested behavior (agent-reported, spike removed):** `docs/workspace-redesign/technical-audit.md:123-142` records an Option B lab with real runtimes, real backend, and a stub model. Mixed Direct + OpenCode in one page passed. Two Direct panels with the shared singleton adapter failed (Run 1); with a fresh adapter per runtime, user messages stayed in the correct panels and the apparent assistant "cross-write" was proven to be a probe measurement artifact (`:144-160`), not a product defect.
- **Permanent regression coverage:** only `tests/dom/workspace/workspace-surface-stability.test.tsx` — which mocks `DirectChatHost` with a marker div and asserts DOM node identity. There is **no permanent test with two real Direct runtimes** and no E2E for multi-panel sends.
- **Genuinely unresolved:** (a) production `DirectChatHost` uses the shared `threadListAdapter` singleton, which the removed spike's Run 1 implicated — the spike's Run 2 used fresh adapters, so the production combination has not been re-verified; (b) global one-shot overrides; (c) no permanent multi-surface E2E. These are verification gaps, not proven defects. **Severity Medium, Confidence Medium.**

### Stable keys and CSS order — corrected claim

`tests/dom/workspace/workspace-surface-stability.test.tsx:101-133` proves exactly one thing: with all panels rendered as **siblings under one parent**, changing `order` via `movePanel` keeps the same host DOM node. The host is **mocked** as `<div data-testid="host">` (`:17-21`), so no runtime state is involved.

React preserves component state only when an element keeps the same type and key **at the same position in the same parent**. Moving an element to a **different parent** unmounts it from the old parent and mounts a new instance in the new parent; state is lost. CSS `order` changes visual order only — it does not change DOM or reconciliation order. Therefore:

- **Proven:** sibling reordering under one parent preserves the host node.
- **Not proven:** moving content between different workspace containers, preserving runtime state across such a move, or any cross-container "no remount" guarantee.

The first report's phrase "stable host invariant ... moves never remount" was too broad and is withdrawn.

### Missing future capabilities (not defects)

- OpenCode cannot currently be placed outside its Chat surface: `WorkspaceSurface.tsx:31-33` excludes agent tabs; `router.tsx:163-173` has a single Code route. No owner requirement for this exists yet.
- Panel model cannot express generic content: `workspacePanels.ts:15-19` has no content type, size, split tree, or persistence.
- No resize/split/move UI: `movePanel`/`closePanel` exist in the store but no component calls them (`AppShell.tsx:149-152` only opens).
- Multi-draft blocked by singleton `chat:new` and single `draftClientRequestId` (`materializeDraft.ts:45-55`).
- No real multi-surface E2E: CI E2E scope (`.github/workflows/tests.yml:450-464`) has no workspace-panel scenario.

### Documentation drift

- `docs/state-management.md:74,147` describes `tbai:openTabs` persistence; no such key exists in `web/src` — actual mirror is `preferences.snapshot.sharedTabs`.
- `docs/workspace-redesign/README.md:8` claims "current uncommitted diff touches 6 production files"; git is clean at the audited SHA.
- `docs/architecture.md:80-118,212-266` omits `features/workspace/`.
- Workspace-redesign audits name `lastGoodThreads` / `lastMountedConversationId`; code uses `threadListCache` (`remoteThreadListAdapter.tsx:104-116`) and `lastMountedByOwner` WeakMap (`useDirectHistoryWindow.ts:427-458`).
- `loadProviders()` is called in both `AppShell.tsx:154-157` and `ChatShell.tsx:20-23` (harmless duplication).
- Older design docs use "Primary Chat" as a term; the product requirement has no such concept. Terminology should be reconciled, but this is doc drift, not a code defect.

---

## D. Revised target architecture

Only architectural necessities are listed. Optional optimizations (LRU eviction, a generic runtime framework, a complex layout tree) are explicitly **not** recommended without evidence of need.

1. **Reuse `chatTabs` as the single conversation/tab identity and membership system.** `workspacePanels` already stores `tabKey` references into it (`workspacePanels.ts:2,15-19`). Any workspace model must keep that indirection: panels reference tab keys; they never own conversation identity, message state, or membership. Do not create a second tab system, second conversation store, or second router.

2. **Extend the panel model minimally, only when a requirement demands it.** The current `{id, tabKey, order}` is a sound base for the one capability it supports. When a real requirement arrives (e.g. a second content type in a panel), add the smallest field needed — a content-type discriminator on the panel/tab reference — rather than a general layout tree. Split/resize/nested containers are **DEFER** until requested.

3. **Treat runtime ownership as a design decision, not a foregone extraction.** AppShell currently owns the Direct runtime because it also owns draft materialization binding, engine selection, route binding, and the sidebar's canonical thread list (section C.1). If the requirement becomes "runtime ownership must not depend on which surface is active," design the move as a unit: content host + draft binding + sidebar source. Until then, the existing `DirectChatHost` pattern is the correct way to add another Direct surface and must be retained.

4. **Keep Direct and OpenCode execution isolated.** Do not merge runtimes, add a universal runtime abstraction, or leak OpenCode-only capability into Direct. `AuiProvider extends={null}` is the established isolation mechanism.

5. **Scope the one-shot overrides** to the draft/surface that owns them. This is the one shared-state item with a concrete race risk between concurrent Direct sends.

6. **Security for future workspace tools.** Files/terminal/browser features must go through `resolveSafe` + grants; terminal must be labeled unsandboxed; OpenCode exposure via explicit allowlist entries; MCP treated as server-privileged.

7. **Persistence, only if requested.** Layout persistence is device-local UI state following the `useDesktopLayout` `persist` precedent; content identity refs stay in the existing `sharedTabs`. Never persist message state or secrets.

---

## E. Migration implications

**Retain (no rewrite):** identity model, `chatTabs`, adapters, both runtimes and their isolation boundaries, `DirectChatHost`, operation scoping, resumable/history/recovery machinery, backend route composition, security controls, existing tests.

**Improve:** scope one-shot overrides; add permanent multi-surface integration/E2E coverage; reconcile documentation drift; make the unsandboxed shell boundary explicit in future UX; extend the panel model only when a concrete content type requires it.

**Design decision, not automatic restructuring:** moving runtime ownership out of AppShell. It requires relocating draft materialization binding, engine selection, route binding, and the sidebar's canonical thread-list source as one coherent change. Do not attempt it as a standalone refactor.

**Defer:** OpenCode outside Chat, cross-container moves, split/resize, non-chat content, multi-draft, capacity/LRU policy — none has an owner requirement or evidence of need.

---

## F. Verification gaps (corrected commit history)

| Category | Status |
|---|---|
| **Audited code commit** | `55b8ed5` — `fix(chat): correct multi-chat operation and draft-pick lifecycle`, parent `d3d81a6`, **13 files**. Verified via `git ls-remote` and GitHub API. |
| **Report commit** | `259f4b4` — `docs: add independent TBAi foundation architecture audit`, parent `55b8ed5`, **one file** (this report). Verified via `git show --stat` and `git ls-remote`. These are two distinct commits; the 13-file code change is **not** part of the audit commit. |
| **Independently verified source behavior** | All cited `file:line` claims were read directly by auditors or the PM. |
| **Installed dependency versions** | Verified from `node_modules` by the runtime auditor. |
| **Agent-reported test results** | Counts in `docs/decisions.md:9060` and `README.md:9` (unit 4999 / integration 1037 / DOM 828) are **claims**, not re-run in this audit. |
| **Agent-reported spike results** | Option B two-runtime outcomes in `technical-audit.md:123-160` are documented but the lab was removed; no permanent test reproduces them. |
| **Actual CI results** | **None.** No check runs, commit statuses, or Actions runs for this branch. |
| **Untested behavior** | Live browser/Tauri E2E; two real Direct runtimes with the production shared adapter; cross-container moves; memory under many panels; OpenCode remount/reuse; backend endpoint semantics under failure; redaction completeness; load/concurrency stress. |
| **Local-only limitation** | Only `docs/workspace-redesign/prototype/screenshots/` (untracked, non-code). All code is on the remote at the audited SHA. |

---

## G. Corrected implementation sequence

1. **Owner decisions first (blocking):** Is single-draft a durable product assumption? Is layout persistence device-local only? Is there any requirement to place OpenCode or non-chat content outside Chat? Is runtime ownership required to be independent of the active surface? The first report's question about "Primary Chat" is withdrawn — that concept does not exist in the product requirements.

2. **Add permanent multi-surface coverage** for the existing `DirectChatHost` pattern — two real Direct runtimes with distinct reply markers, using the production shared adapter, plus a DirectChatHost isolation-contract test. This verifies what already works; it does not rebuild it.

3. **Scope one-shot overrides** per draft/surface to close the concrete race risk.

4. **Extend the panel model only against a real requirement** — start with a content-type discriminator if a second content type is actually needed. Do not build a layout tree, split/resize, or LRU policy speculatively.

5. **If and only if runtime ownership must become position-independent**, design the move as a unit: content host + draft materialization binding + engine selection + route binding + sidebar canonical source. Treat as an architectural change requiring approval.

6. **Add non-chat content types incrementally** only if requested — file tree + read-only viewer first (lowest risk, per `product-architecture.md:113`), then browser/editor after security review.

7. **Reconcile documentation** (state-management `tbai:openTabs`, architecture.md workspace section, README status, stale audit names, "Primary Chat" terminology) in the same commits as the changes they describe.

---

## H. Corrections to the first report (self-critique)

**Recommendations that remain valid:**
- Keep Direct/OpenCode execution isolated; do not merge runtimes or add a universal runtime abstraction.
- Reuse `chatTabs` identity and membership; no second tab/conversation system.
- Scope one-shot provider overrides — the race risk is real.
- Keep `resolveSafe`/grant checks, OpenCode proxy allowlist, MCP server-executed boundary, and the unsandboxed-shell disclosure.
- Add real multi-surface E2E coverage.
- Reconcile documentation drift.

**Recommendations that were wrong or overstated:**
1. **"Primary Chat" framing.** The first report treated "Primary Chat" as a product concept and asked the owner to decide whether it is a position or a runtime. Wrong: the product has no Primary Chat concept. Corrected in section 0 and throughout.
2. **"Stable host invariant ... moves never remount."** Overstated. The DOM test proves only sibling reordering under one parent with a mocked host. Cross-container moves are not proven and React would remount. Corrected in section C.
3. **"Multi-live Direct runtime independence: REDESIGN."** Wrong. Two Direct runtimes are already implemented (`DirectChatHost`) and were previously tested with real runtimes (spike, now removed). The "cross-write" was a measurement artifact. The correct classification is KEEP with verification gaps; do not rebuild. Corrected in section C and B.
4. **"AppShell must stop being the canonical Direct runtime owner — the central change."** Overstated as a standalone refactor. AppShell also owns draft materialization, engine selection, route binding, and the sidebar's canonical thread list. Extraction is a design decision, not a simple move. Corrected in section C.1 and E.
5. **"Build an OpenCodeChatHost by extracting useOpenCodeRuntime."** Premature. The full OpenCode lifecycle includes route→tab binding (`useConversationTab`), config/model resolution, session bootstrap with in-flight dedupe, session id + event directory set together for scoped event subscription, recovery-epoch reconnect, controller load/dispose, first-prompt handoff, permissions, forms, terminal, and diff. The runtime core is reusable, but the view is not a thin wrapper. With no owner requirement for OpenCode outside Chat, this is DEFER. Corrected in section B and G.
6. **"Generic panel/content model with layout tree" and "no capacity policy" as a Medium risk.** Speculative. The current store is a sound minimal base; LRU and complex layout infrastructure have no evidence of necessity. Corrected to minimal extension and DEFER in sections D and B.
7. **Evidence section.** The first report's "Remote commit ... parent `d3d81a6`, all 13 files match local" described the audited code commit `55b8ed5`, but did not distinguish it from the report commit. Corrected in section F: `259f4b4` (this report, one file, parent `55b8ed5`) is distinct from `55b8ed5` (13 files, parent `d3d81a6`).

**Bottom line after correction:** the foundations are sound for the current product. The real work is verification (permanent multi-surface tests), one scoped state fix (one-shot overrides), and documentation reconciliation. Runtime extraction, OpenCode panelization, and generic layout infrastructure are design decisions or deferred capabilities — not defects to fix now.
