# TBAi Workspace Architecture Plan

> **SUPERSEDED (2026-11-23).** This document proposed a custom recursive layout tree, splitter/geometry engine, and stable-host placement mechanism. That proposal was **not implemented**. Dockview was adopted as the workspace layout engine instead; see the ADR in `docs/decisions.md` ("Dockview as the workspace layout engine") and `DOCKVIEW_INTEGRATION_PLAN.md` for the implemented architecture. The custom-layout sections below are retained as historical design reasoning only — do not treat them as the current architecture. The current ownership split is: Dockview = spatial layout, `chatTabs` = canonical conversation identity/membership, TBAi = orchestration/routing/activity/preferences/security, Direct and OpenCode = separate runtimes.

**Status:** SUPERSEDED — historical design document. The implemented architecture is Dockview-based (see banner above).
**Date:** 2026-11-22
**Branch / HEAD inspected:** `ui-foundation-upgrade` @ `b02ca473334ccf288a402d11fdfbbc0bc4197d51` (verified equal to `origin/ui-foundation-upgrade` via `git ls-remote` before work began).
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

The real gaps are: (a) the panel model cannot yet express generic content, split, resize, tabs-per-panel, panel-local selection, or persistence; (b) one-shot provider overrides are global and can race across concurrent Direct sends; (c) there is no permanent test with two real Direct runtimes, though prior experiments showed they work; (d) AppShell owns the root Direct runtime together with draft materialization and engine selection, so runtime relocation is a coordinated design change, not a simple refactor; (e) cross-container moves currently have no mechanism to preserve runtime/session, stream, composer, and scroll state — the stable host layer in §5.5 is the required answer.

**Recommended direction:** extend the existing model incrementally; do not rebuild runtimes, do not add a layout framework, do not create a second tab system. Requirements 5–8 (position independence, mixed Direct/OpenCode arrangements, tabs/split/resize/move, save/restore) are **binding**, not optional: the target architecture must support them. They may be delivered in phases, but no phase may close off a later requirement. Runtime ownership and OpenCode panel support are therefore target capabilities, not deferred ideas.

---

## 2. Current implementation and ownership map

### 2.1 Application shell and routing

- `AppShell.tsx:87-305` is the universal parent, mounted once. It owns chrome composition, global singletons, and the root Direct runtime. **[VERIFIED]**
- `router.tsx:37-43` makes `AppShell` the parent; `ChatShell` and `CodeShell` are children. The router owns pages only; no message/thread/tool state in `app/`. **[VERIFIED]** (Note: the router comment at `router.tsx:24-27` says "ChatShell provides the Direct runtime", but the runtime is actually created in `AppShell.tsx:128`; `ChatShell` only renders `<Outlet />`. The comment is stale wording, not a behavior defect.)
- `AppShell` responsibilities, traced in full: draft-pick lifecycle subscription (`:91`); chrome state + `syncChromeVars` (`:93-97,179-186`); active tab selection via `visibleTabs` (`:99-111`); `runtimeThreadId` derivation excluding drafts (`:112-113`); draft materialization binding via `handleThreadIdChange` → `resolveDraftId(id, peekMaterializedEngine(id) ?? getWelcomeEngineSnapshot().engine)` or `presentChat(id)` (`:115-126`); runtime creation (`:128`); panel candidate selection and open-in-panel (`:137-152,246-257`); provider loading (`:154-157`); `AuiConfig` (`:159-170`); availability/recovery/tab reconciliation registration (`:194-203`); preferences start/sync (`:205-212`); remote shared-membership detached marking (`:217-226`); UI composition (`:228-303`). **[VERIFIED]**

### 2.2 Sidebar ownership — two distinct dependencies

The Sidebar has **two different** dependencies that must not be conflated:

1. **Conversation listing is HTTP-owned.** `Sidebar.tsx:19` uses `useConversationsList` (`features/sidebar/hooks/useConversationsList.ts:1-55`), an HTTP hook over `apiFetch`, plus `useChatTabsStore` and `useThreadListQuerySync` (which writes module-level adapter search/sort globals). The Sidebar component itself has no `useAui`/`useAuiState`/`ThreadListPrimitive` call. **[VERIFIED]**
2. **Live status decorations are currently runtime-dependent (existing implementation).** `SidebarThreadRow.tsx:218,229` renders `ThreadRunningDot` and `ThreadLastMessageTime`. Both currently call `useAuiState` on the assistant-ui thread list: `thread-running-dot.tsx:14-40` reads `threadListItem.isRunning` for the open row and `state.threads.threadItems[].isRunning` for other rows; `thread-last-message-time.tsx:26-35` reads `threadItems[].lastMessageAt`. Both wrap the selector in `try/catch` and fall back (running → false, time → the HTTP-fetched `fallback`) when no `AuiProvider` is present. **[VERIFIED]** This is the **current** behavior; the target behavior differs — `ThreadRunningDot` moves to the activity projection and `ThreadLastMessageTime` drops its runtime read entirely in favor of the HTTP value (see "Consumers" below). **[DECISION]**

**The ambient provider does not observe isolated hosts.** `AuiProvider extends={null}` creates a fresh root client that ignores ambient context (§2b.1; `DirectChatHost.tsx:33`, `OpenCodeIsolationBoundary.tsx:10-15`). The ambient thread list (`state.threads.threadItems`) is the AppShell Direct runtime's list; it does not contain isolated panel hosts or OpenCode sessions. `useOptionalV2RuntimeExtras` (`v2RuntimeExtras.ts:98-101`) reads `state.thread.extras` from the **ambient** provider, so it only sees the currently-mounted OpenCode runtime, not other sessions. Therefore the current Sidebar indicators are accurate only for conversations present in the AppShell Direct thread list; OpenCode sessions and isolated panel hosts fall back to static values. **[VERIFIED]** It is incorrect to assume relocation "just works" because a provider exists.

**Chosen design — centralized conversation-activity projection (not a second conversation/message store):** **[DECISION]**

- Add a small feature-owned store (owner: `features/chat/state/conversationActivity.ts`; it holds derived activity, not conversation records or message content) keyed by the canonical conversation id — the `ref` from `chatTabs`, which equals `conversations.id` for both Direct and OpenCode. **[DECISION]**
- Entry shape holds only **execution status** and **transport health**:
  `{ execution: "unknown" | "idle" | "running" | "stopping" | "completed" | "failed" | "cancelled", health: "unknown" | "ok" | "degraded", updatedAt: number, engine: "direct" | "opencode" }`. No message text, tool parts, credentials, or timestamps are stored — the Sidebar already receives the authoritative timestamp over HTTP (see below). **[DECISION]**
- **Execution status is defined only by authoritative execution evidence:**
  - Direct: `running` only while `useAuiState((s) => s.thread.isRunning)` is true (or a server run-status read confirms `streaming`). Terminal `completed`/`failed`/`cancelled` only from the runtime's terminal status or a server status read — never inferred from message text. **[DECISION]**
  - OpenCode: `running` only when `projection.hasActiveSessionWork` is true (`execution.activity === "active" || execution.activeExecution !== null`, `lifecycleProjection.ts:131-132`) or the server activity read returns `"running"`. **[VERIFIED / DECISION]**
  - **Transport health is separate.** `projection.health.degraded` and `primaryStatus === "reconciling"` (`lifecycleProjection.ts:114-119,189-196`) describe recovery/transport health, **not** execution. They map only to `health: "degraded"`; they must **not** manufacture `execution: "running"`. **[DECISION]**
  - **Cancellation is not terminal until confirmed.** `projection.pendingLifecycle.cancellationPending` (`lifecycleProjection.ts:124-126,192`) maps to `execution: "stopping"` — the conversation is still active. `cancelled` is published only after an authoritative terminal cancellation outcome (server activity `"not-running"` plus a terminal cancellation status, or an explicit terminal event). **[DECISION]**
- **Publishers:** each content host publishes from inside its own provider, where the data is real:
  - Direct host: a hook reads `useAuiState((s) => s.thread.isRunning)` and the terminal message status; publishes `running` while active and a terminal state only on authoritative evidence. **[DECISION]**
  - OpenCode host: a hook reads `useOptionalV2RuntimeExtras()` inside the OpenCode provider and publishes `execution` from `projection.hasActiveSessionWork` and terminal status, and `health` from `projection.health.degraded` (`v2RuntimeExtras.ts:98-101`, `lifecycleProjection.ts:56-75`). **[DECISION]**
- **Last-message timestamp source — two distinct existing paths, not conflated:**
  - **Sidebar (authoritative):** `lastMessageAt` comes from the conversation API's `lastMessageAt` property, backed by SQLite `last_message_at`. `mapConversation()` maps `row.last_message_at` → `lastMessageAt` (`src/services/storage/conversations.ts:91-117`, specifically `:114`); message persistence bumps `updated_at` and `last_message_at` separately (`src/services/storage/messages.ts:539-544`); the Sidebar reads the HTTP response's `lastMessageAt` (`useConversationsList.ts:137-155`, specifically `:141,154`). This is the value `ThreadLastMessageTime` displays. **[VERIFIED]**
  - **assistant-ui adapter metadata (separate existing behavior):** `remoteThreadListAdapter.toMetadata` maps `c.updatedAt` to its own `lastMessageAt` metadata field (`remoteThreadListAdapter.tsx:56-64`, specifically `:63`). This is a distinct path used by the assistant-ui thread-list metadata, **not** the Sidebar's timestamp source. It is documented as-is; this plan does not change it. **[VERIFIED]**
  - The activity projection therefore does **not** duplicate `lastMessageAt`; it stays focused on execution status and transport health. The Sidebar continues to receive the correct timestamp through HTTP. **[DECISION]**
- **Consumers (target behavior):**
  - `ThreadRunningDot` reads **execution status** from the centralized conversation-activity projection, keyed by canonical conversation id (`remoteId` / `conversations.id`), instead of ambient `useAuiState`. It keeps a static fallback (running → false) when the projection has no entry. **[DECISION]**
  - `ThreadLastMessageTime` continues to display the **HTTP-provided `lastMessageAt`** from `useConversationsList` (SQLite `last_message_at`). It must **not** depend on the activity projection or on assistant-ui runtime metadata (`threadItems[].lastMessageAt`); the current ambient `useAuiState` read in `thread-last-message-time.tsx:26-35` is existing behavior to be removed, not the target. **[DECISION]**
- **Lifecycle and cleanup — UI unmount is not execution termination.** Backend runs continue detached when a client disconnects (`src/services/chat-runs.ts:189-193`: "Connection dropped while running: run continues, marked detached"); OpenCode `controller.dispose()` retires the local attempt and pipeline (`v2ThreadController.ts:2993-3004`) but does not prove the server session stopped. Therefore:
  - **Host temporarily hidden:** keep the last published execution status; do not publish `idle`. The host stays mounted (§5.5). **[DECISION]**
  - **Host closed while execution is active:** do **not** publish `idle` or any terminal state on unmount. Remove the host as a publisher and let the server-backed source reconcile (below). **[DECISION]**
  - **Runtime reconnects:** re-publish from the fresh runtime state; a reconnect is not a terminal event. **[DECISION]**
  - **Genuine cancel/complete:** publish `cancelled`/`completed`/`failed` only on authoritative terminal evidence (server status or terminal runtime status). **[DECISION]**
  - **Application restart:** the store starts empty. Reconcile from server-backed sources: OpenCode `fetchOpenCodeSessionActivity` (`sessionBootstrap.ts:143-188`) returns `"running" | "not-running" | "unknown"`, and its contract states `unknown` is **not** idle and must never be rendered as "not running"; Direct uses `fetchConversationRunStatus` via `resolveStreamRecovery` (`streamRecovery.ts:366-425`), where `status: "streaming"` is a healthy in-progress run and a finished status is authoritative. Where no publisher exists, use these sources rather than inventing `idle`. **[VERIFIED / DECISION]**
- **Ambient provider:** still required for in-surface consumers that read `useAuiState` inside a host (`ChatWindow`, `Composer`, `ChatHeader`, `useAssistantActivity`, `OpenCodePrimaryStatus`, tool UIs) — those are inside a host's own provider, not the AppShell one. The AppShell ambient provider is **no longer needed for the Sidebar** once the projection exists; it remains only while the routed Chat area is still AppShell-owned (§5.4), and can be removed when that ownership moves, provided every in-surface consumer is inside a host provider. **[DECISION]**

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
- Completed experiments (harnesses removed): §2b.1 two real Direct runtimes with stub transports (3 tests, 29 assertions passed; `extends={null}` must wrap the component that calls `useRemoteThreadListRuntime`); §2b.2 shared-state audit; §2b.3 real backend with two concurrent conversations (1 test, 7 assertions passed); §2b.4 Option B two real runtimes in one page (mixed Direct+OpenCode **mounted**; two-Direct "cross-write" later proven a probe artifact); §2b.5 root-cause investigation (backend clean, no cross-route mechanism). **[EXPERIMENT]**
- **The §2b.4 mixed Direct+OpenCode run asserted mounting only** — §2b.5 states explicitly: "The mixed Direct+OpenCode test passed because no sends were asserted there." It did **not** prove independent sends, concurrent execution, isolated responses, or isolated lifecycle events. **[EXPERIMENT]**
- No permanent test currently exercises two real Direct runtimes with distinct reply markers, no permanent test exercises mixed Direct+OpenCode sends, and no E2E covers workspace panels. **[VERIFIED]**

### 2.8 Reconciliation of the multi-runtime experimental evidence

Three documents describe overlapping experiments with apparently conflicting conclusions. They are reconciled as follows; **no experiment is repeated**.

| Source | What it actually demonstrated | Status |
|---|---|---|
| `technical-audit.md` §2b.4 **Run 1** | Two Direct panels using the **shared singleton adapter** with **no isolation boundary** on the first attempt: a nesting-guard error (`useRemoteThreadListRuntime cannot be nested`), then both user messages landed in one panel's thread. | **[EXPERIMENT]** The document's own finding 2 reads this as "the singleton adapter cannot be shared". |
| `technical-audit.md` §2b.4 **Run 2** | Fresh adapter per runtime + `AuiProvider extends={null}`: mixed Direct+OpenCode passed; two-Direct user messages stayed in correct panels; assistant replies appeared duplicated in both panels. | **[EXPERIMENT]** |
| `technical-audit.md` §2b.5 | Root-cause investigation: the duplicated assistant text was a **probe measurement artifact** (joining multiple text parts of one message), not cross-writing. Backend SSE bodies were clean; no frontend cross-route mechanism exists. | **[EXPERIMENT]** This supersedes the §2b.4 "cross-write" interpretation. |
| `multi-chat-architecture-audit.md` §2.2 item 5 | The module-level adapter state (search/sort/cache) lives **outside** `createRemoteThreadListAdapter()`, so a fresh instance adds no isolation. It attributes Run 1's failure to the **nesting guard**, not adapter identity, and concludes the canonical adapter can stay shared. Its §7 note records that the adapter-singleton causality claim was **overstated** and corrected. | **[EXPERIMENT]** Later, corrected interpretation. |

**Reconciled conclusions:**

1. The **nesting guard** is real and is fixed by `AuiProvider extends={null}` wrapping the component that calls `useRemoteThreadListRuntime` (§2b.1, §2b.4 Run 2). This is a React-context issue, not an adapter-identity issue. **[EXPERIMENT]**
2. The **duplicated assistant text** was a measurement artifact, not a product defect (§2b.5). No production fix was warranted for that symptom. **[EXPERIMENT]**
3. The **shared adapter** is safe to keep: its module-level state is not isolated by creating fresh instances, and the real correctness defect (stale cross-query cache) was fixed by query-keying (`55b8ed5`). The §2b.4 Run 1 claim that the singleton "cannot be shared" is **superseded** by the corrected §2.2 item 5 and §2b.5. **[EXPERIMENT / VERIFIED]**
4. **What remains unverified:** whether two live Direct runtimes with the **shared** adapter and correct isolation boundary route messages correctly under **concurrent** sends with distinct reply markers. Run 2 used fresh adapters; §2b.1 used stub transports; §2b.3 tested the backend only. No permanent test combines the production shared adapter + two real runtimes + distinct markers. This is a verification gap, not evidence of a defect. **[UNRESOLVED → acceptance criterion §10]**
5. **Mixed Direct + OpenCode was a mount-only result.** §2b.4 Run 2 proved both runtime types mount in one page with distinct ids and no cross-talk in the *mount assertion*. §2b.5 states no sends were asserted in that test. Therefore **independent message submission, concurrent execution, correctly isolated responses, and isolated lifecycle events are all unproven** for the mixed case. The earlier plan's phrase "sends isolated (§2b.4 outcome)" overstated the evidence and is withdrawn. **[EXPERIMENT → acceptance criterion §10]**

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
2. **Panel model too narrow.** `workspacePanels.ts:15-19` cannot express content type, multiple tabs per panel, panel-local active selection, size, split, or persistence. **[VERIFIED]** This is a missing capability, not a defect in what it currently does.
2b. **No state-preserving cross-container move.** The current sibling-reorder invariant does not extend to moving a tab between panels; a stable host layer is required (§5.5). **[VERIFIED / DECISION]**
2c. **Sidebar activity is not accurate across isolated hosts.** Live indicators read the ambient thread list, which excludes isolated panel hosts and OpenCode sessions; a centralized activity projection is required (§2.2). **[VERIFIED / DECISION]**
3. **No permanent multi-runtime regression coverage.** Prior experiments proved feasibility but their harnesses were removed; mixed Direct+OpenCode sends were never asserted (§2.8). **[VERIFIED]**
4. **AppShell concentration.** Runtime ownership is coupled to draft materialization, engine selection, and active-tab binding (§2.1). **[VERIFIED]** Relocation is a coordinated change.
5. **Documentation drift.** `docs/state-management.md:74,147` describes `tbai:openTabs` (absent in code); `docs/architecture.md:80-118,212-266` omits `features/workspace/`; `README.md:8` has a stale worktree claim; older audits name `lastGoodThreads`/`lastMountedConversationId` (now `threadListCache`/`lastMountedByOwner`); "Primary Chat" terminology persists. **[VERIFIED]**
6. **`runBash` unsandboxed** — a boundary fact that future terminal/UX work must make explicit, not a bug. **[VERIFIED]**

Explicitly **not** gaps: backend concurrency (§2b.3 proved it), cross-write (§2b.5 proved measurement artifact), operation scoping / history ownership / query cache (fixed in `55b8ed5`), and the shared `threadListAdapter` (the real defect was the cache, now query-keyed; a fresh adapter per panel adds no isolation). **[VERIFIED / EXPERIMENT]**

---

## 5. Proposed target architecture

### 5.1 Layering diagram

```
Chat Threads (persistent navigation)   Workspace layout tree (§5.2)
  useConversationsList (HTTP)            panels + splits + panel-local activeTabId
  useChatTabsStore (identity/membership) + hostId references
  live decorations via useAuiState       |
  (ThreadRunningDot / LastMessageTime)   v  placement slots (hostId refs)
        |                                       |
        +---------- chatTabs tabKey ------------+
                  kind + ref
                        |
             STABLE HOST LAYER (§5.5)
             one host per hostId, never reparented
                        |
        +---------------+----------------+
        |                                |
  Direct content host              OpenCode content host
  (AuiProvider extends=null,        (OpenCodeIsolationBoundary,
   useAppChatRuntime,                 session bootstrap, scoped client,
   shared threadListAdapter)          controller, dispose/reconnect)
        |                                |
   AI SDK / providers              OpenCode V2 session

Conversation-activity projection (§2.2) feeds Sidebar live decorations; no ambient provider dependency.
```

### 5.2 Layout and panel structure **[DECISION]**

Adopt a minimal recursive layout model owned by `features/workspace/state/`. The model is a **discriminated union** so each node type carries only valid fields:

```ts
// RESOURCE identity — which conversation / file / terminal / URL is involved.
// Conversation resources reference chatTabs; the engine is derived from the
// conversation row by threadEngine(), never stored independently here.
type ConversationResource = {
  source: "chatTabs";
  tabKey: `chat:${string}` | `agent:${string}`;   // chatTabs.ts:92-108
  conversationId: string;                          // === tab ref === conversations.id
};
type FileResource = { source: "file"; projectId: string; fileId: string };
type TerminalResource = { source: "terminal"; sessionId: string };
type BrowserResource = { source: "browser"; url: string };
type Resource = ConversationResource | FileResource | TerminalResource | BrowserResource;

// HOST INSTANCE identity — which mounted UI/runtime instance survives a move.
// For conversations/files/terminals this is deterministic (one host per resource).
// For browser it is a fresh instance id: two browser panels may show the same URL.
type HostId = `conv:${string}` | `file:${string}` | `terminal:${string}` | `browser:${string}`;

// Discriminated union: the resource shape is tied to the content type, so an
// invalid combination (e.g. a Direct host with a file resource) cannot compile.
type DirectTab = {
  contentType: "direct";
  hostId: `conv:${string}`;
  resource: ConversationResource & { tabKey: `chat:${string}` };
  label?: string;
};
type OpenCodeTab = {
  contentType: "opencode";
  hostId: `conv:${string}`;
  resource: ConversationResource & { tabKey: `agent:${string}` };
  label?: string;
};
type FileTab = {
  contentType: "file";
  hostId: `file:${string}`;
  resource: FileResource;
  label?: string;
};
type TerminalTab = {
  contentType: "terminal";
  hostId: `terminal:${string}`;
  resource: TerminalResource;
  label?: string;
};
type BrowserTab = {
  contentType: "browser";
  hostId: `browser:${string}`;   // unique per instance, NOT derived from url
  resource: BrowserResource;
  label?: string;
};
type PanelTab = DirectTab | OpenCodeTab | FileTab | TerminalTab | BrowserTab;

type PanelNode = {
  kind: "panel";
  id: string;
  tabs: PanelTab[];               // ordered
  activeTabId: HostId | null;     // PANEL-LOCAL selection
};

type SplitNode = {
  kind: "split";
  id: string;
  direction: "row" | "column";
  children: LayoutNode[];
  sizes: number[];                // fractional, length === children.length, sum ≈ 1
};

type LayoutNode = PanelNode | SplitNode;

type WorkspaceLayout = {
  version: number;
  root: LayoutNode;
  // The persistent Chat area is a designated panel id, not a privileged runtime.
  chatPanelId: string;
};
```

Key properties:

- **Resource identity vs host instance identity.** `resource` says *what* is displayed; `hostId` says *which mounted instance* must survive a move. For conversations, files, and terminals `hostId` is deterministic from the resource (one host per resource). For browser, `hostId` is a fresh `browser:<uuid>` per instance, so two browser panels may legitimately display the same URL while remaining independent hosts. **[DECISION]**
- **Genuine type safety.** `PanelTab` is a discriminated union on `contentType`; each variant fixes both the `hostId` prefix and the `resource` shape. A Direct tab with a file resource, or a conversation tab with a browser URL, is a compile error. The `tabKey` template-literal types further constrain conversation tabs to the `chat:`/`agent:` forms produced by `chatTabs.ts:92-108`. **[DECISION]**
- **Relationship to `chatTabs`.** `ConversationResource` references the canonical `chatTabs` key and `conversationId` (`=== tab ref === conversations.id`). The engine is **not** stored in the tab: it is derived from the conversation row by `threadEngine()` (`remoteThreadListAdapter.tsx:370-380`), which reads `custom.engine === "opencode"`. The reconciler must validate that a `DirectTab`'s conversation actually resolves to Direct and an `OpenCodeTab`'s to OpenCode, and correct the variant if the row disagrees — no second conversation identity system is introduced. **[DECISION]**
- **Panel-local active selection:** `activeTabId` lives on `PanelNode`, not in `chatTabs`. `chatTabs.localActiveKey` remains the single URL-authoritative selection for the routed Chat area; each optional panel tracks its own active tab in the layout tree. This is required for multiple panels to show different conversations simultaneously. **[DECISION]**
- **No duplicate conversation host:** `hostId` for a conversation is `conv:<conversationId>`; the reconciler rejects or deduplicates a second placement of the same `hostId` so a conversation cannot be mounted in two panels. Two browser hosts with the same URL are allowed because their `hostId`s differ. **[DECISION]**
- **Split sizing:** `SplitNode.sizes` holds fractional weights; resize updates these values. This is the only layout-specific numeric state. **[DECISION]**
- Reuse the existing dnd-kit stack for tab reordering and the Sidebar pointer-capture resize handle pattern; no new dependency for v1. **[VERIFIED: installed libs in `technical-audit.md:54-56`]**
- **Alternative rejected:** FlexLayout (`decisions.md:4620-4679`) — tab identity would need re-derivation, mutable model/stale-closure traps, popup context loss, and DOM-test impossibility. Its evaluation stands; no migration authorized.
- **Alternative rejected:** a generic layout framework or enterprise layout infra — no evidence of need.

### 5.3 How Chat and panels render content **[DECISION]**

- The routed Chat area is the panel identified by `WorkspaceLayout.chatPanelId`. It renders that panel's `activeTabId` through a content host selected by `contentType`: Direct → `DirectChatHost`, OpenCode → `OpenCodeChatHost`, other types → their registered host. **[DECISION]**
- Every panel renders its own `activeTabId` through the same host components. A panel is a container, not a feature; no "Direct panel" or "OpenCode panel" classes. Panel-local selection is independent (§5.2). **[DECISION]**
- Hosts live in the stable host layer (§5.5); a panel's slot displays the host referenced by its active tab. Moving a tab changes slot references, not the host instance. **[DECISION]**
- Panels reference `chatTabs` tab keys for chat content. Non-chat content (files/terminal/browser) uses its own `Resource` variant (§5.2) and is **not** forced into `chatTabs`. **[DECISION]** This reuses `chatTabs` for conversation identity without making it responsible for files or terminals.

### 5.4 Runtime ownership **[DECISION]**

Binding requirement 5 says runtime ownership must not be tied to a fixed screen position, and requirement 7 says Direct and OpenCode must coexist in mixed arrangements. The target therefore uses **content-owned runtimes**: a runtime belongs to a content instance identified by `(contentType, identity)`, not to a panel slot or to "the active surface".

- **Direct:** `DirectChatHost` already implements this pattern (`AuiProvider extends={null}` + `useAppChatRuntime` + shared adapter). Keep it; do not rebuild it. Two Direct runtimes are implemented and were proven by §2b.1/§2b.4. **[VERIFIED / EXPERIMENT]**
- **OpenCode:** extract a reusable `OpenCodeChatHost` from `OpenCodeView` that owns the session bootstrap + `useOpenCodeRuntime` chain by conversation id. This is required for mixed arrangements, not optional. The view is not a thin wrapper — route binding, config/model resolution, timeout/retry, recovery, first-prompt handoff, permissions, forms, terminal, and diff must be preserved in the host or its owning surface. **[DECISION]**
- **AppShell root runtime:** its removal/relocation is a coordinated change because it owns draft materialization binding, engine selection, and route binding (§2.1). The Sidebar's live decorations no longer depend on it once the centralized activity projection exists (§2.2); in-surface `useAuiState` consumers live inside their own host providers. The ambient provider can therefore be removed when ownership moves, provided the projection and host providers are in place. **[DECISION]**
- **No runtime merger, no universal runtime abstraction.** Direct and OpenCode hosts share only the presentation layer (`ChatWindow` with `mode`).

### 5.5 Moving content between containers — stable content-host ownership **[DECISION]**

**The requirement is state preservation, not remount acceptance.** Moving a tab between panels must preserve conversation identity, the runtime/session instance, active stream and execution state, composer contents, and scroll/viewport state where technically feasible. The earlier plan's "accept remount and lose transient state" does not satisfy this and is withdrawn.

**React lifecycle fact (not negotiable):** React preserves component state only when an element keeps the same type and key **at the same position in the same parent**. Moving an element to a different parent unmounts it from the old parent and mounts a new instance in the new parent; local state is lost. CSS `order` changes visual order only, not DOM/reconciliation order. The existing DOM test (`workspace-surface-stability.test.tsx:101-133`) proves only sibling reordering under one parent with a **mocked** host — it does not prove cross-container moves or runtime-state preservation. **[VERIFIED]**

**Chosen mechanism — stable host layer with absolutely positioned host wrappers:**

The unit of persistence is a **content host** keyed by a stable `hostId` (§5.2), not by its panel. The layout tree stores references to hosts; it never owns the host component instance. The concrete React and DOM structure is:

```
<WorkspaceRoot>                              // position: relative; overflow: hidden
  <LayoutFrames>                             // visual chrome ONLY, no content
     <PanelFrame rect={...}>                 // background, border, header, tab strip
     <Splitter rect={...} onResize={...}/>   // pointer-capture resize handle
  </LayoutFrames>
  <HostLayer>                                // position: absolute; inset: 0; pointer-events: none
     <HostWrapper key={hostId} rect={...}>   // position: absolute; transform/left/top/width/height
        <ContentHost .../>                   // DirectChatHost / OpenCodeChatHost / ...
     </HostWrapper>
     ...
  </HostLayer>
</WorkspaceRoot>
```

- **React parent:** every `HostWrapper` is a direct child of the single `HostLayer`. Its key is `hostId` and its position in the children array is stable (host creation order). Moving a tab between panels changes only the `rect` prop, never the parent or key. React therefore preserves the `ContentHost` instance and all its local state. **[DECISION]**
- **DOM parent:** every host wrapper's DOM parent is the `HostLayer` div. The host's content is *not* a DOM descendant of the panel frame — it is visually placed over it by geometry. This is the key distinction from the current `WorkspaceSurface`, where the host is a DOM child of the panel wrapper. **[DECISION]**
- **Visual placement:** a recursive geometry function walks `WorkspaceLayout.root`; each `SplitNode` divides its rect by `sizes` along `direction`, each `PanelNode` yields a leaf rect. The panel's active `hostId` is looked up and that host wrapper receives the leaf rect (inset by the panel header height). The host is drawn inside the panel by absolute positioning, not by DOM nesting. **[DECISION]**
- **Nested splits / resize / clipping:** nested splits are just recursive rect division; a `Splitter` is an absolutely positioned element at the boundary with pointer capture that updates `SplitNode.sizes`, which recomputes all rects. Each `HostWrapper` sets `overflow: hidden` and a border radius so content is clipped to its panel. No remount occurs on resize. **[DECISION]**
- **Panel headers and tab strips:** rendered by `LayoutFrames` as siblings of `HostLayer`, positioned at the panel rect's top. The host rect is inset below the header, so content never overlaps chrome. Because the header is a sibling (not a parent) of the host, activating a different tab does not reparent the host. **[DECISION]**
- **Inactive tabs:** all tabs of a panel stay mounted in `HostLayer`. Only the active tab's wrapper receives the panel rect and `visibility: visible; pointer-events: auto`. Inactive wrappers are kept mounted but given `visibility: hidden; pointer-events: none; aria-hidden="true"; inert` and moved off-screen (or zero-sized) so they cannot intercept input or appear in the accessibility tree. `inert` also removes them from keyboard tab order. Their DOM nodes and scroll positions remain intact. **[DECISION]**
- **Focus and keyboard:** the active host is in normal tab order; `inert` on inactive hosts prevents focus. Tab activation moves focus from the tab strip into the newly active host explicitly. Because DOM order follows host creation order rather than visual order, keyboard tab order may not match visual panel order — this must be verified in the real-host test and mitigated with explicit focus management if needed. **[DECISION / UNRESOLVED until tested]**
- **Scrolling:** each host owns its scroll container (the `ChatWindow` viewport). Because the node is never unmounted or reparented, scroll position survives moves and tab switches. **[DECISION]**
- **Overlays and accessibility:** assistant-ui menus/popovers that portal to `document.body` are outside the host wrapper; their positioning relative to the host must be verified (the FlexLayout ADR recorded popup context loss at `decisions.md:4664-4666`). Each active host wrapper carries `role="region"` and an `aria-label` derived from its content. **[DECISION / UNRESOLVED until tested]**
- **Close vs hide:** "hide" (inactive tab) keeps the host mounted with `inert`; "close" unmounts the `HostWrapper`, which disposes the runtime/session and releases its resources. Closing the last tab of a panel removes the panel frame. **[DECISION]**

**Alternatives evaluated:**

| Option | Preserves | Cost / risk | Verdict |
|---|---|---|---|
| Stable host layer + absolute wrappers (chosen) | Identity, runtime/session, stream, composer, scroll — by never unmounting or reparenting | Manual geometry computation; DOM order ≠ visual order (focus/ARIA risk); portaled overlays need verification; hidden hosts consume memory | **Chosen** — only option that meets the requirement without state reconstruction |
| CSS Grid with generated areas | Same state preservation | Grid areas cannot express arbitrary nested splits cleanly; dynamic split trees awkward | Reject — insufficient for nested splits |
| React portals into panel DOM | Component state survives (React tree unchanged) | DOM reparenting can reset scroll; focus/ARIA hazards; FlexLayout ADR recorded popup context loss | Reject — no state benefit over absolute wrappers |
| Lift all runtimes into one provider | Runtime instance survives | Couples all content to one provider; undermines isolation; does not preserve composer/scroll local state | Reject — conflicts with isolated runtimes |
| Accept remount, reconstruct state | Identity + durable history only | Loses runtime instance, stream, composer, scroll | Rejected — does not satisfy the requirement |

**State preservation is not yet proven.** The mechanism above is designed to support it, but the current DOM test uses a mocked host and only sibling reorder (`workspace-surface-stability.test.tsx:101-133`). A **real-host cross-panel move test is required** before claiming the requirement is met: mount two real `DirectChatHost`s, type into a composer, scroll, start a stream, move a tab between panels, and assert the same host component instance, runtime, composer text, scroll position, and stream continuity. **[UNRESOLVED → acceptance criterion §10]**

**Practical limits:** hidden hosts consume memory, so "close" must genuinely unmount. Restoring after an application restart cannot preserve in-memory runtime/composer state — only durable identity and layout; that is a different operation from an in-session move. **[DECISION]**

**Migration note:** the current `WorkspaceSurface` already keeps hosts as stable keyed siblings under one parent, which is why sibling reorder preserves the host node. The target generalizes that property from "one parent, reorder only" to "one host layer, arbitrary placement via geometry". The existing DOM test remains valid for the sibling case. **[VERIFIED / DECISION]**

### 5.6 Identity ownership **[DECISION]**

- `chatTabs` remains the sole **conversation** identity and shared-membership system. `ConversationResource` in §5.2 stores a `tabKey` reference into it; the layout never duplicates conversation identity or message state.
- Panel placement, split sizing, and **panel-local active tab selection** are owned by the workspace layout tree (`WorkspaceLayout`), not by `chatTabs`. `chatTabs.localActiveKey` stays the URL-authoritative selection for the Chat area only.
- Non-chat content gets a `Resource` variant (project id, file id, URL) — a separate concern, not a second tab system.
- A `hostId` is unique per content identity; the reconciler prevents the same conversation from being mounted in two panels.
- No second conversation store, no mirrored message state, no second router.

### 5.7 Layout persistence and restoration **[DECISION]**

- Layout tree (node types, order, sizes, active tabs) → device-local localStorage, following `useDesktopLayout` `persist` with `version` + `migrate` + `partialize`. **[VERIFIED pattern]**
- Content identity refs → existing SQLite `sharedTabs` mirror, reconciled removal-only at boot. **[VERIFIED]**
- Migration: a versioned `migrate` that drops unknown node types and reconciles tab keys against `chatTabs`; a corrupt payload falls back to defaults field by field (existing rule). **[DECISION]**
- Scope: **device-wide first** (per `technical-audit.md:174`) — this is the v1 default, not an owner question. Per-project overrides are a later, non-v1 enhancement that reuses the same layout model with a project key; they add no v1 dependency. **[DECISION]**
- Never persist message state or secrets.

### 5.8 Future content types **[DECISION]**

- Add a `contentType` discriminator and a small host registry (`contentType → component`). Each host owns its lifecycle and security. No framework, no universal content abstraction.
- First new types: file tree + read-only viewer, which need a conversation-scoped, containment-checked file endpoint (`technical-audit.md:25-29,168`). Editor needs a dependency + ADR; interactive browser needs CSP/webview work (`:37-51`). Both deferred.
- Security: all file paths through `resolveConversationWorkspace` + `resolveSafe`; terminal labeled unsandboxed; OpenCode via allowlist; MCP server-privileged.

---

## 6. Runtime, identity, layout and persistence ownership

| Concern | Owner | Rationale |
|---|---|---|
| Conversation identity / membership | `chatTabs` + preferences snapshot | Single source of truth; layout references it |
| Panel placement / split sizes / panel-local active tab | workspace layout tree (`features/workspace/state/`) | Feature-owned; not `chatTabs` responsibility |
| Stable content host (runtime/session/UI state) | stable host layer keyed by `hostId` (§5.5) | Never reparented; preserves state on move |
| Direct runtime | `DirectChatHost` (content-owned) | Proven isolated host; keep |
| OpenCode runtime | extracted `OpenCodeChatHost` (content-owned) | Session-scoped, isolated; required for mixed arrangements |
| Conversation-activity projection | `features/chat/state/conversationActivity.ts` | Derived execution status + transport health for Sidebar; timestamps stay HTTP-owned; not a conversation/message store (§2.2) |
| Device-local layout persistence | `useDesktopLayout` persist pattern | Established pattern |
| Portable preferences | `/api/preferences` + SQLite | Server-authoritative |
| One-shot provider overrides | currently global `providersStore`; **should be scoped per draft/surface** | Concrete race risk |

---

## 7. Decisions with alternatives, trade-offs and rationale

1. **Layout model:** minimal recursive discriminated tree vs FlexLayout vs no model. Chosen: minimal tree with panel-local `activeTabId` and split `sizes` (§5.2). FlexLayout rejected by prior ADR; no model cannot meet binding split/resize/tabs requirements.
2. **Runtime ownership:** content-owned hosts (target) vs AppShell-owned active runtime (current). Chosen: content-owned hosts, because position independence is binding. The move is a coordinated change (draft binding, engine selection, route binding, Sidebar provider — §2.1, §2.2), not a simple refactor.
3. **Cross-container moves:** stable host layer vs portals vs lifted runtime vs remount. Chosen: stable host layer (§5.5) — the only option preserving runtime/session, stream, composer, and scroll. Remount rejected because it violates the requirement; portals and lifted runtimes rejected on lifecycle/context/isolation grounds.
4. **OpenCode host:** extract a reusable host (target) vs keep route-bound. Chosen: extract — mixed Direct/OpenCode arrangements are binding. The view is not a thin wrapper; its responsibilities must be preserved in the host or owning surface (§2.5).
5. **Adapter strategy:** shared singleton vs per-panel. Chosen: shared — the real defect was the cache, now query-keyed; fresh instances add no isolation (§2.4, `decisions.md:9047`). See §2.8 for the experiment reconciliation.
6. **One-draft assumption:** keep v1 (recommended default). Multi-draft would need per-draft idempotency key and pick scope; no requirement contradicts v1.
7. **One-shot overrides:** scope per draft/surface. Alternative (global) has a proven race risk.
8. **Layout persistence scope:** device-wide v1 default; per-project later without v1 dependency (§5.7).
9. **New dependencies:** none for v1 layout; editor/browser need ADRs and are deferred.

---

## 8. Migration strategy preserving working functionality

1. **Phase 0 — no code change:** accept this plan. Defaults are already decided (§14): single draft for v1, device-wide layout persistence first, per-project later. No owner decision blocks the technical sequence.
2. **Phase 1 — coverage before change:** add permanent tests for two real Direct runtimes with distinct reply markers (record message parts individually, per §2b.5), and a `DirectChatHost` isolation-contract test. This locks in what already works and closes the §2.8 gap.
3. **Phase 2 — scope one-shot overrides** to the draft/surface that owns them; regression test: a pick in surface A does not affect surface B's send.
4. **Phase 3 — introduce the layout model** (§5.2) with panel-local `activeTabId`, split `sizes`, `contentType`, and `hostId` references into `chatTabs`; add device-wide persistence with versioned migration. This is required for tabs/split/resize/move/restore, not optional.
5. **Phase 4 — stable host layer + content hosts:** generalize the stable-sibling property to arbitrary placement (§5.5); extract `OpenCodeChatHost` for mixed arrangements (§5.4); add file tree + viewer behind a secure endpoint.
6. **Phase 5 — complete runtime ownership move:** move runtime + draft binding + engine selection + route binding as one coordinated change, with the activity projection (§2.2) already feeding the Sidebar; verify with Phase 1 tests plus cross-panel move tests.
7. **Phase 6 — documentation reconciliation** (§13) in the same commits as the changes.

At every phase: preserve existing working code, no runtime merger, no second tab system, no new dependency without ADR, `bun run verify` + DOM + E2E + security gates, and the Definition of DONE in `AGENTS.md`.

---

## 9. Phased implementation sequence with dependencies

| Phase | Depends on | Work | Exit evidence |
|---|---|---|---|
| 0 | — | Plan accepted; defaults in §14 applied | Approved plan |
| 1 | 0 | Permanent two-runtime + isolation tests | Tests pass with distinct markers; guard proven able to fail |
| 2 | 1 | Scope one-shot overrides | Race regression test passes |
| 3 | 2 | Layout model (§5.2) + device-wide persistence + migrate | DOM tests for add/close/reorder/split/resize/restore; panel-local selection independent |
| 4 | 3 | Stable host layer (§5.5) + `OpenCodeChatHost` + file tree/viewer behind secure endpoint | Cross-panel move preserves runtime/composer/scroll; mixed Direct+OpenCode E2E; traversal/symlink rejection |
| 5 | 1, 4 | Complete runtime ownership move (draft binding, engine selection, route binding); install activity projection (§2.2) | Phase 1 tests still pass; no duplicate conversation on move; Sidebar live decorations accurate across isolated hosts |
| 6 | each phase | Documentation reconciliation | Docs match code |

Do not start a later phase before the earlier exit evidence exists.

---

## 10. Acceptance criteria and regression-test requirements

- Two Direct runtimes in one page: distinct conversation ids, distinct reply markers, each panel contains only its own marker; record message parts individually (§2b.5). **[required before any panel expansion]**
- **Mixed Direct + OpenCode permanent integration/E2E test (outstanding):** two independent conversations (one Direct, one OpenCode), **concurrent** sends with distinct reply markers, record message parts individually, assert each surface contains only its own marker, assert correct isolated responses and lifecycle events (running/completed/failed/cancelled), and assert no cross-runtime interference. §2b.4 proved mounting only; this test closes that gap. **[required before mixed arrangements are declared complete]**
- Provider pick in one surface does not affect another surface's send.
- **Sidebar activity projection:** with multiple isolated Direct and OpenCode hosts open, the Sidebar shows correct `running`/`stopping`/terminal execution status and separate transport health from the projection, keyed by canonical conversation id, while its last-message timestamp continues to come from the HTTP conversation API's `lastMessageAt` (SQLite `last_message_at`). Transport degradation never produces a running indicator; pending cancellation stays `stopping` until confirmed; closing or hiding a host never invents `idle`, and server-backed sources reconcile when no publisher exists (§2.2). **[required before ambient provider removal]**
- **Real-host cross-panel move:** two real `DirectChatHost`s, composer text, scroll position, and an active stream survive a tab move between panels; assert the host component instance is not remounted (§5.5). **[required before claiming state preservation]**
- Panel add/close/reorder/split/resize/restore: DOM + E2E; layout survives reload; corrupt layout falls back safely.
- Cross-container move: conversation identity, runtime/session instance, active stream/execution state, composer contents, and scroll/viewport state are preserved (§5.5). Test with a real host, not a marker; assert the host component instance is not remounted.
- Panel-local selection: two panels show two different active conversations simultaneously; `chatTabs.localActiveKey` remains the single URL-authoritative Chat-area selection.
- No conversation is mounted in two panels at once (hostId uniqueness enforced by the reconciler).
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

- Multi-draft (one-draft v1 default; not a binding requirement).
- Per-project layout overrides (device-wide v1 default; later enhancement, no v1 dependency).
- Writable editor (needs dependency + ADR), interactive browser (CSP/webview work).
- Writable file operations beyond existing tools.
- LRU/capacity policy for many panels — no evidence of need.
- Generic runtime framework, universal content abstraction, second tab system, second router, layout framework — all rejected.
- No Direct/OpenCode runtime merger; no change to the frozen assistant-ui train without explicit review.

**Not deferred (binding, phased in §9):** position-independent runtime ownership, OpenCode content in mixed arrangements, and tabs/split/resize/move/restore with save/restore. These are target capabilities, not optional ideas.

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
| `docs/decisions.md:9044,9047` (ADR 2026-11-22) | Says "moving never remounts the runtime host" — true only for sibling reorder under one parent | Qualify: sibling reorder preserves host; cross-container moves require the stable host layer (§5.5) and are not proven by the current DOM test |
| `docs/decisions.md:9047` | "paneling the active Primary Chat" | Replace term; describe active-surface filter without the concept |
| `web/src/app/router.tsx:24-27` | Comment says ChatShell provides the Direct runtime | Correct to AppShell creates it; ChatShell renders Outlet |
| `docs/2026-11-22-foundation-architecture-audit.md` | Superseded by this plan | Mark as historical input; this plan is authoritative |

---

## 14. Resolved defaults and review scope

The following are decided by engineering judgment from repository evidence and are **not** owner blockers:

1. **Single draft for v1.** The one-draft assumption is retained; multi-draft would need per-draft idempotency and pick scope, and no binding requirement contradicts v1.
2. **Device-wide layout persistence first.** Per-project overrides are a later enhancement reusing the same layout model; they add no v1 dependency.
3. **Position-independent runtime ownership and mixed Direct/OpenCode arrangements are binding requirements**, not open questions. They are phased in §9 but the target supports them.
4. **Tabs/split/resize/move/restore and save/restore are binding requirements**, phased in §9.

All technical architecture decisions in §5–§7 are resolved by this plan from repository evidence. Owner review is for approval of the plan as a whole, not for resolving technical sub-decisions. The only genuinely open item is the §2.8 verification gap (two live Direct runtimes with the shared adapter and distinct markers), which is closed by a Phase 1 acceptance test, not by a design choice.

---

## 15. Relation to prior documents

This plan consolidates and supersedes the product requirements, technical investigations, and architectural decisions in the documents listed in §13. It preserves the completed multi-runtime findings (§2b.1–2b.5) as evidence, does not repeat them, and treats the fixes in `55b8ed5` as present. It is subject to owner review and approval; it does not authorize implementation.
