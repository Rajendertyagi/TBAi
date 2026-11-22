# TBAi Workspace Architecture Plan

**Status:** authoritative plan — implementation-ready, subject to owner review and approval. No implementation is authorized by this document.
**Date:** 2026-11-22
**Branch / HEAD inspected:** `ui-foundation-upgrade` @ `bce859f2b2fb66c7f34d98ba1795c1779aaaaff4` (verified equal to `origin/ui-foundation-upgrade` via `git ls-remote` before work began).
**Audited code commit:** `55b8ed5` (`fix(chat): correct multi-chat operation and draft-pick lifecycle`, parent `d3d81a6`, 13 files). Its fixes to operation scoping, history ownership, and the query-keyed cache are treated as **already present** and are not reported as current defects.

## Evidence conventions

Every important claim is tagged:

- **[VERIFIED]** — read directly from source or a permanent test at the inspected HEAD, with `file:line`.
- **[EXPERIMENT]** — result of a completed, temporary investigation in `technical-audit.md` §2b.1–2b.5; the harness was removed, so this is documented evidence, not permanent regression coverage.
- **[REPORTED]** — stated in a document or by an agent, not independently re-run here.
- **[DECISION]** — a recommendation of this plan, with rationale and alternatives.
- **[UNRESOLVED]** — cannot be settled from repository evidence; needs owner input.

Do not repeat the completed multi-runtime experiments (§2b.1–2b.5). Preserve their findings and distinguish them from permanent tests.

---

## 1. Executive summary and product requirements

### 1.1 Binding product requirements

1. **Chat Threads** is the persistent conversation navigation area.
2. **Chat** is a persistent workspace area that can display Direct or OpenCode conversations.
3. **There is no "Primary Chat" concept.** It is not a conversation, runtime, or privileged position. The term appears in older documents and code comments; it is not a requirement and must not be used as an architectural concept. Where this plan says "active chat surface" or "the routed Chat area", it means the currently displayed content, not a privileged slot.
4. Direct and OpenCode are equally valid content types; their execution systems remain separate.
5. Conversations and runtimes must not be permanently tied to a screen position.
6. The user can add, close, move, rearrange, split, and resize workspace panels; panels can contain multiple content tabs.
7. Direct and OpenCode content can coexist in different panels and in mixed arrangements.
8. Workspace layouts must be savable and restorable.
9. Other content (file trees, file viewers, editors, terminal, browser) must fit the model without a fixed layout.
10. Layout examples in existing documents are illustrations, not mandatory templates.

### 1.2 Executive conclusion

The foundations are sound and must be preserved: conversation identity (`chatTabs`), two isolated runtimes, per-thread operation scoping, durable streaming, and security boundaries. **[VERIFIED]** The current workspace panel implementation is a correct, minimal first slice — stable keyed Direct hosts under one parent — not a failed design. **[VERIFIED]**

The real gaps are: (a) the panel model cannot yet express generic content, split, resize, tabs-per-panel, or persistence; (b) one-shot provider overrides are global and can race across concurrent Direct sends; (c) there is no permanent test with two real Direct runtimes, though prior experiments showed they work; (d) AppShell owns the root Direct runtime together with draft materialization and engine selection, so runtime relocation is a coordinated design change, not a simple refactor.

**Recommended direction:** extend the existing model incrementally; do not rebuild runtimes, do not add a layout framework, do not create a second tab system. Resolve runtime ownership as a deliberate, bounded change only when a requirement demands position-independent ownership.

---

## 2. Current implementation and ownership map

### 2.1 Application shell and routing

- `AppShell.tsx:87-305` is the universal parent, mounted once. It owns chrome composition, global singletons, and the root Direct runtime. **[VERIFIED]**
- `router.tsx:37-43` makes `AppShell` the parent; `ChatShell` and `CodeShell` are children. The router owns pages only; no message/thread/tool state in `app/`. **[VERIFIED]** (Note: the router comment at `router.tsx:24-27` says "ChatShell provides the Direct runtime", but the runtime is actually created in `AppShell.tsx:128`; `ChatShell` only renders `<Outlet />`. The comment is stale wording, not a behavior defect.)
- `AppShell` responsibilities, traced in full: draft-pick lifecycle subscription (`:91`); chrome state + `syncChromeVars` (`:93-97,179-186`); active tab selection via `visibleTabs` (`:99-111`); `runtimeThreadId` derivation excluding drafts (`:112-113`); draft materialization binding via `handleThreadIdChange` → `resolveDraftId(id, peekMaterializedEngine(id) ?? getWelcomeEngineSnapshot().engine)` or `presentChat(id)` (`:115-126`); runtime creation (`:128`); panel candidate selection and open-in-panel (`:137-152,246-257`); provider loading (`:154-157`); `AuiConfig` (`:159-170`); availability/recovery/tab reconciliation registration (`:194-203`); preferences start/sync (`:205-212`); remote shared-membership detached marking (`:217-226`); UI composition (`:228-303`). **[VERIFIED]**

### 2.2 Sidebar ownership — correction to earlier audits

Earlier audits claimed the Sidebar reads the canonical thread-list state from the shell runtime. **This is incorrect.** The Sidebar uses `useConversationsList` (`features/sidebar/hooks/useConversationsList.ts:1-55`), an HTTP hook over `apiFetch`, plus `useChatTabsStore` and `useThreadListQuerySync` (which writes module-level adapter search/sort globals). It has no `useAui`/`useAuiState`/`ThreadListPrimitive` dependency. **[VERIFIED]** This materially reduces the coupling between the Sidebar and the AppShell runtime; runtime relocation does not require rewiring the Sidebar's data source.

### 2.3 Conversation identity and membership

- `chatTabs.ts:20-27` defines `Tab { key, kind: "chat" | "agent", ref, detached? }`; keys are `chat:<ref>` / `agent:<ref>` (`:92-108`). `groupId` exists (`:45`) but has no split behavior. **[VERIFIED]**
- Shared membership is SQLite-authoritative via the preferences snapshot; local active key, draft, detached refs, membership failures, and suppressed delayed adds are per-window Zustand (`:34-45`). Reconciliation is removal-only on confirmed 404 (`tabReconciliation.ts:20-81`). **[VERIFIED]**
- Draft is a singleton (`chat:new`, `hasLocalDraft`) with a single `draftClientRequestId` (`materializeDraft.ts:45-55`). One-draft v1 assumption retained. **[VERIFIED]**

### 2.4 Direct runtime and panel host

- `useAppChatRuntime` (`runtime.ts:569-580`) wraps `useRemoteThreadListRuntime` with a stable module-level `runtimeHook`. **[VERIFIED]**
- `DirectChatHost.tsx:25-46` creates an isolated top-level Direct runtime per host using `AuiProvider extends={null}` and the shared `threadListAdapter`; lifetime is the component's mount. **[VERIFIED]**
- `WorkspaceSurface.tsx:14-47` renders panels as keyed siblings under one parent, filters the active tab, and mounts `DirectChatHost` for bound Direct chats. **[VERIFIED]**
- `workspacePanels.ts:15-61` stores `{id, tabKey, order}` with `openPanel`/`closePanel`/`movePanel`; no persistence, no content type, no size/split. **[VERIFIED]**

### 2.5 OpenCode lifecycle

- `OpenCodeView.tsx:40-201` binds route → tab via `useConversationTab(agentId, "agent")`, resolves config/model, bootstraps the session, and only mounts `AgentRuntime` once `sessionId` and `eventDirectory` exist. **[VERIFIED]**
- `sessionBootstrap.ts:51-141` dedupes in-flight bootstraps per conversation id; the backend is authoritative for reuse. **[VERIFIED]**
- `useOpenCodeRuntime.ts:13-88` creates a scoped client, controller, and external-store runtime; loads on session+directory; disposes on cleanup; reconnect rebuilds via `clientEpoch`. Recovery-epoch reconnect is gated to avoid mount-time churn (`OpenCodeView.tsx:239-249`). **[VERIFIED]**
- Isolation boundary: `OpenCodeIsolationBoundary.tsx:10-15` uses `AuiProvider extends={null}`. **[VERIFIED]**
- First-prompt handoff, permissions, forms, terminal, and diff are OpenCode-only capabilities inside this surface. **[VERIFIED]**

### 2.6 Persistence and security

- Device-local preferences use Zustand `persist` with `partialize`/`migrate` (`desktopLayout.ts:129-224`, `tbai:desktopLayout`, only `sidebarWidth` local). Portable preferences use SQLite via `/api/preferences`. **[VERIFIED]**
- Backend security: `resolveSafe`/`inspectTarget` confine path arguments (`src/services/tools.ts:116-175`); `runBash` confines only the starting directory and **is not sandboxed** (`:1-40,342-360`); OpenCode proxy uses an allowlist + session→workspace authorization (`proxyRoutes.ts:1-205`, `proxyAuthorization.ts:96-159`); MCP is server-executed. **[VERIFIED]**

### 2.7 Tests and prior experiments

- Permanent tests: `tests/dom/workspace/workspace-surface-stability.test.tsx` (mocked host, sibling reorder, close isolation, active-tab filter); `tests/unit/web/workspace/workspace-panels.test.ts`; `tests/dom/opencode/first-prompt-handoff-lifecycle.test.tsx`; `tests/unit/web/lib/send-operation.test.ts`. **[VERIFIED]**
- Completed experiments (harnesses removed): §2b.1 two real Direct runtimes with stub transports (3 tests, 29 assertions passed; `extends={null}` must wrap the component that calls `useRemoteThreadListRuntime`); §2b.2 shared-state audit; §2b.3 real backend with two concurrent conversations (1 test, 7 assertions passed); §2b.4 Option B two real runtimes in one page (mixed Direct+OpenCode passed; two-Direct "cross-write" later proven a probe artifact); §2b.5 root-cause investigation (backend clean, no cross-route mechanism). **[EXPERIMENT]**
- No permanent test currently exercises two real Direct runtimes with distinct reply markers, and no E2E covers workspace panels. **[VERIFIED]**

---

## 3. Verified foundations to KEEP

1. Conversation identity and tab model (`chatTabs.ts`) — single source of truth for `kind`+`ref`; panels reference it, never own it. **[VERIFIED]**
2. Shared membership vs local presentation split, with removal-only reconciliation. **[VERIFIED]**
3. Direct/OpenCode execution isolation and the `AuiProvider extends={null}` boundary. **[VERIFIED]**
4. `DirectChatHost` as the working per-panel Direct runtime host. **[VERIFIED]** Do not rebuild it.
5. OpenCode session-scoped client/controller/runtime with explicit dispose and generation-based reconnect. **[VERIFIED]**
6. Per-thread operation scoping, query-keyed thread-list cache, per-owner history visit tracking — all corrected in `55b8ed5` and earlier. **[VERIFIED]** Do not report as defects.
7. Durable resumable streams, run registry, cleanup, and shutdown drain. **[VERIFIED]**
8. Security boundaries: credential encryption, approval secret fail-closed, path confinement, OpenCode proxy allowlist, MCP server-executed. **[VERIFIED]**
9. Router owns pages only; no second router or state framework. **[VERIFIED]**
10. Existing persistence patterns (`useDesktopLayout` persist, preferences snapshot). **[VERIFIED]**

---

## 4. Necessary improvements and confirmed technical gaps

1. **Global one-shot overrides.** `providersStore.ts:30-32,89-96` holds `selectedProviderId/ModelId/ReasoningLevel` globally; `runtime.ts:337,379-423` consumes and reverts them. Concurrent Direct sends can race. **[VERIFIED]** This is the one shared-state item with a concrete race risk.
2. **Panel model too narrow.** `workspacePanels.ts:15-19` cannot express content type, multiple tabs per panel, size, split, or persistence. **[VERIFIED]** This is a missing capability, not a defect in what it currently does.
3. **No permanent multi-runtime regression coverage.** Prior experiments proved feasibility but their harnesses were removed. **[VERIFIED]**
4. **AppShell concentration.** Runtime ownership is coupled to draft materialization, engine selection, and active-tab binding (§2.1). **[VERIFIED]** Relocation is a coordinated change.
5. **Documentation drift.** `docs/state-management.md:74,147` describes `tbai:openTabs` (absent in code); `docs/architecture.md:80-118,212-266` omits `features/workspace/`; `README.md:8` has a stale worktree claim; older audits name `lastGoodThreads`/`lastMountedConversationId` (now `threadListCache`/`lastMountedByOwner`); "Primary Chat" terminology persists. **[VERIFIED]**
6. **`runBash` unsandboxed** — a boundary fact that future terminal/UX work must make explicit, not a bug. **[VERIFIED]**

Explicitly **not** gaps: backend concurrency (§2b.3 proved it), cross-write (§2b.5 proved measurement artifact), operation scoping / history ownership / query cache (fixed in `55b8ed5`), and the shared `threadListAdapter` (the real defect was the cache, now query-keyed; a fresh adapter per panel adds no isolation). **[VERIFIED / EXPERIMENT]**

---

## 5. Proposed target architecture

### 5.1 Layering diagram

```
Chat Threads (persistent navigation)   Chat (persistent workspace area)
  useConversationsList (HTTP)            active chat surface (routed)
  useChatTabsStore (identity/membership) + optional panels
        |                                       |
        +---------- chatTabs tabKey ------------+   (panels reference tab keys;
                   kind + ref                        no duplicate identity)
                        |
        +---------------+----------------+
        |                                |
  Direct content host              OpenCode content host
  (AuiProvider extends=null,        (OpenCodeIsolationBoundary,
   useAppChatRuntime,                 session bootstrap, scoped client,
   shared threadListAdapter)          controller, dispose/reconnect)
        |                                |
   AI SDK / providers              OpenCode V2 session
```

### 5.2 Layout and panel structure **[DECISION]**

Adopt a minimal recursive layout model owned by `features/workspace/state/`:

```
LayoutNode = { id, kind: "panel" | "row" | "column", children | tabs, sizes? }
PanelTab   = { tabKey?: string, contentType: "direct" | "opencode" | "file" | ..., identity, context? }
```

- A panel holds ordered tabs; a row/column holds child nodes with fractional sizes. This supports split, resize, tabs, and rearrangement with one model.
- Reuse the existing dnd-kit stack for tab reordering and the Sidebar pointer-capture resize handle pattern; no new dependency for v1. **[VERIFIED: installed libs in `technical-audit.md:54-56`]**
- **Alternative rejected:** FlexLayout (`decisions.md:4620-4679`) — tab identity would need re-derivation, mutable model/stale-closure traps, popup context loss, and DOM-test impossibility. Its evaluation stands; no migration authorized.
- **Alternative rejected:** a generic layout framework or enterprise layout infra — no evidence of need.

### 5.3 How Chat and panels render content **[DECISION]**

- The routed Chat area renders the active tab's content through a content host selected by `kind`/content type. Direct uses `DirectChatHost`; OpenCode uses an extracted `OpenCodeChatHost` (§5.4).
- Panels render their active tab through the same host components. A panel is a container, not a feature; no "Direct panel" or "OpenCode panel" classes.
- Panels reference `chatTabs` tab keys for chat content. Non-chat content (files/terminal/browser) uses its own identity fields in `PanelTab` and is **not** forced into `chatTabs`. **[DECISION]** This reuses `chatTabs` for conversation identity without making it responsible for files or terminals.

### 5.4 Runtime ownership **[DECISION]**

- **Keep** `DirectChatHost` and the root AppShell runtime as-is for the current model. Two Direct runtimes are already implemented and were proven by §2b.1/§2b.4; do not rebuild them.
- **Position-independent ownership, when required:** extract a content host that owns its runtime by content identity, not by which surface is active. This is a coordinated change: it must move draft materialization binding, engine selection, and route binding together with the runtime (§2.1). The Sidebar does **not** need rewiring (§2.2).
- **OpenCode host:** extract the session bootstrap + `useOpenCodeRuntime` chain from `OpenCodeView` into a reusable host only when a requirement places OpenCode outside Chat. The view is not a thin wrapper — it includes route binding, config/model resolution, timeout/retry, recovery, first-prompt handoff, permissions, forms, terminal, and diff. Until then, DEFER.
- **No runtime merger, no universal runtime abstraction.**

### 5.5 Moving content between containers — React remount reality **[DECISION]**

This is the most important technical correction. React preserves component state only when an element keeps the same type and key **at the same position in the same parent**. Moving an element to a different parent unmounts it from the old parent and mounts a new instance in the new parent; local component state is lost. CSS `order` changes visual order only, not DOM/reconciliation order. The existing DOM test (`workspace-surface-stability.test.tsx:101-133`) proves only sibling reordering under one parent with a **mocked** host — it does not prove cross-container moves or runtime-state preservation. **[VERIFIED]**

Options and trade-offs:

| Option | Preserves | Cost | Verdict |
|---|---|---|---|
| Accept remount on cross-container move; identity via `tabKey`, state via SQLite/runtime adapters | Conversation identity and durable history; not transient UI state | Runtime re-created; scroll/undo/local UI state lost | **Recommended** — honest and simple; conversation state is already durable |
| React portals to keep one logical parent | Component state across visual moves | Complex portal management, focus/ARIA/context hazards | Reject unless a concrete requirement needs transient state preserved |
| Lift runtime above all containers | Runtime instance survives moves | Couples all content to one provider; undermines isolation | Reject — conflicts with isolated runtimes |

**Decision:** moving content preserves conversation identity and durable state; transient UI state may reset on a cross-container move. Document this as the user-visible contract. Sibling reordering within one panel remains remount-free.

### 5.6 Identity ownership **[DECISION]**

- `chatTabs` remains the sole conversation/tab identity and membership system. Panels store references (`tabKey`) into it.
- Non-chat content gets identity in `PanelTab` (project id, file id, URL) — a separate concern, not a second tab system.
- No second conversation store, no mirrored message state.

### 5.7 Layout persistence and restoration **[DECISION]**

- Layout tree (node types, order, sizes, active tabs) → device-local localStorage, following `useDesktopLayout` `persist` with `version` + `migrate` + `partialize`. **[VERIFIED pattern]**
- Content identity refs → existing SQLite `sharedTabs` mirror, reconciled removal-only at boot. **[VERIFIED]**
- Migration: a versioned `migrate` that drops unknown node types and reconciles tab keys against `chatTabs`; a corrupt payload falls back to defaults field by field (existing rule). **[DECISION]**
- Scope: device-wide first (per `technical-audit.md:174`); per-project layouts deferred.
- Never persist message state or secrets.

### 5.8 Future content types **[DECISION]**

- Add a `contentType` discriminator and a small host registry (`contentType → component`). Each host owns its lifecycle and security. No framework, no universal content abstraction.
- First new types: file tree + read-only viewer, which need a conversation-scoped, containment-checked file endpoint (`technical-audit.md:25-29,168`). Editor needs a dependency + ADR; interactive browser needs CSP/webview work (`:37-51`). Both deferred.
- Security: all file paths through `resolveConversationWorkspace` + `resolveSafe`; terminal labeled unsandboxed; OpenCode via allowlist; MCP server-privileged.

---

## 6. Runtime, identity, layout and persistence ownership

| Concern | Owner | Rationale |
|---|---|---|
| Conversation identity / membership | `chatTabs` + preferences snapshot | Single source of truth; panels reference it |
| Direct runtime (active surface) | AppShell (current); content host (if position independence required) | Coordinated change with draft binding |
| Direct runtime (panel) | `DirectChatHost` | Proven isolated host; keep |
| OpenCode runtime | `OpenCodeView` / extracted host | Session-scoped, isolated |
| Panel layout tree | `features/workspace/state/` | Feature-owned; no shared dumping ground |
| Device-local layout persistence | `useDesktopLayout` persist pattern | Established pattern |
| Portable preferences | `/api/preferences` + SQLite | Server-authoritative |
| One-shot provider overrides | currently global `providersStore`; **should be scoped per draft/surface** | Concrete race risk |

---

## 7. Decisions with alternatives, trade-offs and rationale

1. **Layout model:** minimal recursive tree vs FlexLayout vs no model. Chosen: minimal tree. FlexLayout rejected by prior ADR; no model cannot meet split/resize/tabs requirements.
2. **Runtime relocation:** keep vs extract. Chosen: keep now; extract only as a coordinated change when position independence is required. Extraction is not a simple refactor (§2.1).
3. **Cross-container moves:** accept remount vs portals vs lifted runtime. Chosen: accept remount with durable identity (§5.5).
4. **OpenCode host:** extract now vs defer. Chosen: defer — no owner requirement to place OpenCode outside Chat; the view is not a thin wrapper.
5. **Adapter strategy:** shared singleton vs per-panel. Chosen: shared — the real defect was the cache, now query-keyed; fresh instances add no isolation (§2.4, `decisions.md:9047`).
6. **One-draft assumption:** keep v1. Multi-draft would need per-draft idempotency key and pick scope; no requirement contradicts v1.
7. **One-shot overrides:** scope per draft/surface. Alternative (global) has a proven race risk.
8. **New dependencies:** none for v1 layout; editor/browser need ADRs and are deferred.

---

## 8. Migration strategy preserving working functionality

1. **Phase 0 — no code change:** accept this plan; resolve the two owner questions in §14.
2. **Phase 1 — coverage before change:** add permanent tests for two real Direct runtimes with distinct reply markers (record message parts individually, per §2b.5), and a `DirectChatHost` isolation-contract test. This locks in what already works.
3. **Phase 2 — scope one-shot overrides** to the draft/surface that owns them; regression test: a pick in surface A does not affect surface B's send.
4. **Phase 3 — extend the panel model** with `contentType` and, only if required, a layout tree; keep `tabKey` references into `chatTabs`. Add persistence with versioned migration.
5. **Phase 4 — content hosts** for new types, starting with file tree + viewer behind a secure endpoint.
6. **Phase 5 — runtime relocation, only if required:** move runtime + draft binding + engine selection + route binding as one change; verify with the Phase 1 tests.
7. **Phase 6 — documentation reconciliation** (§13) in the same commits as the changes.

At every phase: preserve existing working code, no runtime merger, no second tab system, no new dependency without ADR, `bun run verify` + DOM + E2E + security gates, and the Definition of DONE in `AGENTS.md`.

---

## 9. Phased implementation sequence with dependencies

| Phase | Depends on | Work | Exit evidence |
|---|---|---|---|
| 0 | — | Owner decisions (§14); plan accepted | Approved plan |
| 1 | 0 | Permanent two-runtime + isolation tests | Tests pass with distinct markers; guard proven able to fail |
| 2 | 1 | Scope one-shot overrides | Race regression test passes |
| 3 | 2 | Panel model + persistence (contentType, layout tree, migrate) | DOM tests for add/close/reorder/split/resize/restore |
| 4 | 3 + secure file endpoint | File tree + read-only viewer | E2E for traversal/symlink rejection |
| 5 | 1, 3 (only if required) | Runtime relocation as coordinated change | Phase 1 tests still pass; no duplicate conversation on move |
| 6 | each phase | Documentation reconciliation | Docs match code |

Do not start a later phase before the earlier exit evidence exists.

---

## 10. Acceptance criteria and regression-test requirements

- Two Direct runtimes in one page: distinct conversation ids, distinct reply markers, each panel contains only its own marker; record message parts individually (§2b.5). **[required before any panel expansion]**
- Mixed Direct + OpenCode in one page: both mount, sends isolated (§2b.4 outcome, now permanent).
- Provider pick in one surface does not affect another surface's send.
- Panel add/close/reorder/split/resize/restore: DOM + E2E; layout survives reload; corrupt layout falls back safely.
- Cross-container move: conversation identity preserved; transient UI state may reset (documented contract).
- Unmount one panel while another streams: the other completes normally.
- File content: traversal and symlink escape rejected; paths confined to conversation workspace.
- No `runBash` or terminal surface described as sandboxed.
- Quality gates: `bun run verify`, `test:dom`, `test:e2e`, `bun run security`; exact counts recorded; no commit/push before end-to-end verification.

---

## 11. Security considerations

- Path arguments confined by `resolveSafe`/`inspectTarget`; resolve authorized root via `resolveConversationWorkspace` first (`technical-audit.md:28`).
- `runBash` confines only the starting directory; command body runs with server privileges — **not sandboxed** (`src/services/tools.ts:1-40,342-360`). Future terminal UX must state this.
- OpenCode exposure only via explicit proxy allowlist entries + session→workspace authorization; drift tests must stay green (`technical-audit.md:33`).
- MCP tools are server-executed and privileged; UI must not imply browser-local isolation.
- Layout persistence stores identities only — never secrets, message text, or absolute filesystem paths (`interaction-model.md:37`).
- Tauri CSP currently blocks external frames; interactive browser needs explicit CSP/capability work (`technical-audit.md:49-51`).

---

## 12. Deferred work and explicit non-goals

- Multi-draft (one-draft v1 assumption retained).
- Per-project layout overrides (device-wide first).
- Writable editor (needs dependency + ADR), interactive browser (CSP/webview work).
- Writable file operations beyond existing tools.
- Runtime relocation unless a requirement demands position independence.
- OpenCode outside Chat unless a requirement demands it.
- LRU/capacity policy for many panels — no evidence of need.
- Generic runtime framework, universal content abstraction, second tab system, second router, layout framework — all rejected.
- No Direct/OpenCode runtime merger; no change to the frozen assistant-ui train without explicit review.

---

## 13. Documentation reconciliation list

| Document | Issue | Recommended update |
|---|---|---|
| `docs/state-management.md:74,147` | Describes `tbai:openTabs` persistence; absent in code | Replace with `preferences.snapshot.sharedTabs` mirror description |
| `docs/architecture.md:80-118,212-266` | Omits `features/workspace/` | Add workspace feature to directory layout and ownership tables |
| `docs/workspace-redesign/README.md:8` | Stale "uncommitted diff touches 6 production files" | Remove or replace with current status |
| `docs/workspace-redesign/product-architecture.md:15,23-26` and `interaction-model.md:6,18` | Use "Primary Chat" term | Replace with "Chat area"; state explicitly that no Primary Chat concept exists |
| `docs/workspace-redesign/multi-chat-architecture-audit.md:27,34,90,103,142` | Names `lastGoodThreads`/`lastMountedConversationId` | Update to `threadListCache`/`lastMountedByOwner`; mark fixes as present in `55b8ed5` |
| `docs/workspace-redesign/technical-audit.md:42,72` | Line numbers and "RISKY" framing predate `DirectChatHost` and `55b8ed5` | Annotate as historical; mark two-Direct as implemented + experimentally proven, with permanent-test gap |
| `docs/decisions.md:9044,9047` (ADR 2026-11-22) | Says "moving never remounts the runtime host" — true only for sibling reorder | Qualify: sibling reorder preserves host; cross-container moves remount |
| `docs/decisions.md:9047` | "paneling the active Primary Chat" | Replace term; describe active-surface filter without the concept |
| `web/src/app/router.tsx:24-27` | Comment says ChatShell provides the Direct runtime | Correct to AppShell creates it; ChatShell renders Outlet |
| `docs/2026-11-22-foundation-architecture-audit.md` | Superseded by this plan | Mark as historical input; this plan is authoritative |

---

## 14. Remaining genuinely unresolved questions

These are product/owner decisions, not technical questions resolvable from repository evidence:

1. Is single-draft a durable product assumption? (Plan keeps it; multi-draft needs per-draft idempotency and pick scope.)
2. Is layout persistence device-wide only, or per-project later? (Plan recommends device-wide first.)
3. Is there a requirement to place OpenCode or non-chat content outside Chat now? (Plan defers both.)
4. Is position-independent runtime ownership a requirement now, or only a future option? (Plan keeps current ownership and defines a coordinated extraction path.)

All technical architecture decisions in §5–§7 are resolved by this plan from repository evidence and do not require owner input beyond review.

---

## 15. Relation to prior documents

This plan consolidates and supersedes the product requirements, technical investigations, and architectural decisions in the documents listed in §13. It preserves the completed multi-runtime findings (§2b.1–2b.5) as evidence, does not repeat them, and treats the fixes in `55b8ed5` as present. It is subject to owner review and approval; it does not authorize implementation.
