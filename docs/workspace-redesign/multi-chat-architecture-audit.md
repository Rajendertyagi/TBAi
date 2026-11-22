# Multi-Chat Architecture — Focused Engineering Audit

**Status:** implementation-ready plan, awaiting owner review. No production code changed.
**Baseline verified this task:** branch `ui-foundation-upgrade`, HEAD `244b412aa85f67dd68f7678f7d1230a46d190dc5`, one worktree. Local `technical-audit.md` §2b.1–§2b.5 is newer than the pushed baseline and is preserved.

This audit does **not** repeat the completed runtime/backend/browser investigations. It turns their findings into a concrete production plan.

---

## 1. Current architecture assessment

**What is already correct and must be retained:**
- One unified tab store (`chatTabs.ts:20-27`) holds both `kind: "chat"` and `kind: "agent"` with `ref` = conversation id. Engine comes from the conversation row, not the tab. This is the right identity model — panels/tabs reference conversations; they do not own message state.
- Direct identity chain and OpenCode identity chain are sound (§2b facts).
- OpenCode per-session state is genuinely independent (client/controller/cache scoped per session).
- The backend handles two concurrent conversations correctly (§2b.3) — no backend change needed for multi-chat.
- assistant-ui/AI SDK keep all message state per-thread `Chat` instance; no library global forwards stream text (§2b.5).
- `sendConfigs` (`runtime.ts:77`) is already keyed by `threadKey:lastUserMsgId` and holds config only — correct model, retain it.

**What genuinely blocks multiple live Direct runtimes:** five unkeyed global slots (§2b.2), plus runtime/adapter ownership. The "cross-write" from Option B was a probe artifact (§2b.5) — **not** a product bug and not a reason to change architecture.

---

## 2. Verified defects vs multi-instance limitations vs safe global state

### 2.1 Verified correctness defect (fix regardless of workspace)
**`lastGoodThreads` cache** (`remoteThreadListAdapter.tsx:104,182,186,198`): a failed `list()` for one query (search/sort/offset) returns the cached threads from a *different* query. This is a live bug with one runtime. Fix: key the cache by the query tuple (search + sort + offset) or drop the fallback for mismatched queries. Retain the stale-with-badge behavior for the *same* query.

### 2.2 Multi-instance limitations (fix before two live Direct panels)
1. **Operation context** — `current`/`enclosing` (`operation.ts:51,53`) and `activeSendOperation` (`send-operation.ts:27`) are single global slots. Proven (§2b.2): a second send supersedes the first's id; a tool continuation can supersede a newer send. Effect is **telemetry/correlation only** (operation id headers + log lines), **not** message-state corruption (§2b.5). Must be scoped per logical send.
2. **One-shot provider overrides** — `selectedProviderId/ModelId/ReasoningLevel` in `useSettingsStore` (`providersStore.ts:30-32`) are global and consumed in `prepareSendMessagesRequest` (`runtime.ts:345,384-428`). A pick in panel A can be consumed by panel B's send. Real cross-panel interference.
3. **`lastMountedConversationId`** (`useDirectHistoryWindow.ts:415`) — single global slot; its own comment assumes one Direct surface. Two mounted surfaces misfire the one-shot recovery budget.
4. **`draftClientRequestId`** (`materializeDraft.ts:46`) — single global idempotency key, justified by the singleton `chat:new` draft. See §2.4 for the product decision.
5. **Adapter ownership** — the module singleton `threadListAdapter` (`app/adapter.ts:8`) is explicitly designed to be shared ("stateless apart from React hooks it hosts; safe to share"). `createRemoteThreadListAdapter()` returns an object whose history provider is React-hook-based, but the module-level `threadListSearchQuery`, `threadListSortOrder` and `lastGoodThreads` (`remoteThreadListAdapter.tsx:87,95,104`) live **outside the factory** — creating another adapter instance does **not** isolate them. Option B Run 1's failure was the **nesting guard** (`useRemoteThreadListRuntime cannot be nested`), fixed by the `AuiProvider extends={null}` boundary — **not** by adapter identity. Conclusion: the canonical adapter can remain shared; do **not** create fresh instances merely for the appearance of isolation. The only real adapter correctness problem is the stale cross-query cache (§2.1), fixed at the cache-keying boundary.

### 2.3 Safe global state (do NOT change)
`useAvailabilityStore`, `useChatTabsStore`, `useDesktopLayout`, `mutationListeners`, logger/platform singletons, search/sort vars (they are application-wide navigation state — pass them as `list()` params, do not make them per-runtime), `sendConfigs` (keyed by thread **+ last user message id** — correct for distinct threads, but two panels on the *same* thread with the same last message would share an entry), all thread-keyed history/resume/recovery maps.

### 2.4 Draft product assumption
Multiple *existing* conversations open in panels does **not** require multiple drafts. The singleton `chat:new` draft remains sufficient **if** the product keeps one unsaved draft at a time. Consequence of supporting multiple independent unsaved drafts: `draftClientRequestId` must become per-draft/tab and the draft tab key must stop being a singleton. **Recommendation:** keep one draft for v1; defer multi-draft. State this as an explicit product assumption.

---

## 3. Recommended target architecture

### Ownership table (correct model)

| Concept | Correct ownership |
|---|---|
| Primary Chat / optional panel | Workspace position |
| Direct Chat / OpenCode Chat | Content type and separate runtime implementation |
| Conversation/session ID | Persistent content identity |
| Runtime instance | Lifetime of the displayed chat content |
| Panel and tab arrangement | Workspace layout state |
| Shared conversation navigation | Application-level state |
| Message history | Conversation/runtime integration |
| Operation context | Individual logical send and its continuations |
| Provider override | Correct chat/conversation context |

### A. Runtime ownership follows content, not position

**Core rule:** a workspace position (Primary Chat or an optional panel) is a generic container that renders the content of its selected tab. It does **not** own a runtime. The tab's identity (`kind` + `ref`) determines the content type and the conversation/session id; the appropriate existing runtime is mounted for that content, for as long as that content is displayed. Direct Chat and OpenCode Chat remain separate runtime implementations — never merged, never tied to a fixed screen position.

- **Content component is the runtime owner.** A `ChatContent` component keyed by tab identity mounts the runtime for that tab: for `kind: "chat"` it calls `useAppChatRuntime(adapter, threadId, ...)` and wraps itself in `AssistantRuntimeProvider`; for `kind: "agent"` it uses the existing `useOpenCodeRuntime` + `OpenCodeIsolationBoundary` + `OpenCodeRuntimeContext` stack (`OpenCodeView.tsx:310-353`). The runtime's lifetime is the content instance's lifetime — not the panel's, not the shell's.
- **Primary Chat is just the first position.** It renders whatever tab is selected there, using the same `ChatContent` component as any optional panel. Preserve current Primary Chat behavior where practical (it will usually hold a Direct chat), but do not let `AppShell.tsx:103-119` hardwire "Primary Chat = the one Direct runtime." The canonical runtime/adapter can remain the one used by the Primary Chat's content initially; the architecture must not require that.
- **Isolation when nesting.** If a chat content instance is mounted inside another `AssistantRuntimeProvider`'s subtree, wrap the runtime-creating component in `AuiProvider extends={null}` **outside** it (§2b.1). Sibling providers are isolated by default. This is a mounting detail of the content component, not a panel-position rule.
- **Tab moves and disposal.** Moving a tab between panels must preserve its identity (`kind` + `ref`) and, where the framework allows, its mounted runtime state — the content component should be keyed by tab identity so React can relocate rather than remount it. Closing a panel unmounts only the content instances it held, releasing only their runtime resources; shared navigation/thread state is untouched. assistant-ui/AI SDK dispose per-instance state on unmount — no manual teardown beyond clearing any per-content operation context (§B).
- **Retain the stable hook.** Keep the module-level stable `ResumableThreadRuntime` hook (`runtime.ts:198-547`; stability comment `:549-559`; `useAppChatRuntime` wrapper `:560-571`) — do not duplicate it. Multiple content instances may call `useAppChatRuntime`; the hook itself stays single and stable.

### B. Operation context — explicit per-send context (no AsyncLocalStorage)
Do not introduce AsyncLocalStorage or a custom async-context framework. The browser runtime is single-threaded and the send path is explicit. Use an **explicit context object passed through the send pipeline**:
- Mint an `OperationContext { operationId, threadId, startedAt }` at the single funnel (`prepareSendMessagesRequest`, `runtime.ts:338-450`) for a fresh send; snapshot it into `sendConfigs` (already done at `:415-424`).
- Replace the global `current`/`enclosing`/`activeSendOperation` with a **thread-keyed registry** `Map<threadKey, OperationContext>` (or pass the context explicitly to `operationHeaders()`/`operationInitFor()`). The global fetch wrapper (`operation.ts:183-196`) must resolve the operation id from the **request**, not a global slot — e.g. carry it in an explicit header set at the funnel, or key by the request's conversation id. Keep `operationInitFor` pure and testable.
- Continuations (`attachSendOperation(sel.operationId)`, `runtime.ts:434`) re-open the context for the **same thread** only. Overlapping sends in different threads keep independent contexts.
- Lifecycle: begin on fresh send; re-open on tool/approval continuation; end on stream settle/cancel/failure via the existing `observeBodySettled` path (`send-operation.ts:75+`). Guard late settles by `expectedId` as today.
- **Scope note:** this fixes correlation/logging. It does not touch message state (which is already correct per §2b.5).

### C. Provider overrides — per-chat, not global
- Move one-shot overrides from the global `useSettingsStore` into **per-chat state**: either component-local state in each composer, or a `Map<threadKey, Override>` in a feature-owned store. The composer chip already reads/writes these values; make that read/write thread-scoped.
- `prepareSendMessagesRequest` reads the override for **its own `threadKey`** (`runtime.ts:347`) instead of `useSettingsStore.getState()` globals (`:345,384-387`). Revert only that thread's override after send (`:426-428`).
- Retain the global provider registry, `activeProviderId`, and conversation defaults (`threadListItem.custom`, SQLite) as the fallback layers. Do not duplicate the registry.

### D. Direct history recovery — per-surface
- Replace `lastMountedConversationId` (`useDirectHistoryWindow.ts:415`) with a per-surface record: pass a `surfaceId` (panel/tab id) into `beginHistoryVisit` and key the "last mounted" map by surface. Each Direct surface then tracks its own new-visit vs remount decision.
- Retain the bounded recovery logic, `byThread` notices, and all keyed maps — they are correct. Only the single global slot changes.

### E. Thread-list adapter and caching
- **Keep the canonical `threadListAdapter` singleton shared.** It is designed to be shared, and creating fresh instances does not isolate the module-level state behind it (§2.2 item 5). Do not duplicate navigation or thread-list state.
- **Separate the genuinely instance-owned responsibility:** the React-hook-based history provider (`unstable_Provider`/`unstable_useAdapters`, `remoteThreadListAdapter.tsx:142-159`) is already created per adapter instance via `useState` — that is the correct place for hook-bound state. The module-level search/sort/cache are a different concern and should be handled at their own boundary, not by multiplying adapters.
- **Fix `lastGoodThreads` (§2.1) at the correct boundary:** key the cache by the query tuple (search + sort + offset) so a failed list for one query cannot return another query's threads. Search/sort remain application-wide navigation state synced via `useThreadListQuerySync.ts` — pass them as `list()` params rather than reading module globals inside `list()`. Retain stale-with-badge behavior for the *same* query.

### F. Draft and idempotency
Keep the singleton draft for v1 (§2.4). No change.

### G. Other state
No changes — all correctly global or thread-keyed (§2.3).

---

## 4. Prioritized implementation sequence

**Phase 1 — correctness fixes independent of workspace (do first):**
1. `lastGoodThreads` query-keyed cache (`remoteThreadListAdapter.tsx`). Tests: failed list for query B must not return query A's threads; same-query failure still returns stale.
2. Operation context per-send (§B) — `operation.ts`, `send-operation.ts`, `runtime.ts`, `logger.ts` if needed. Tests: overlapping sends keep distinct operation ids; tool continuation reopens only its own; late settle guarded; log headers carry correct id.

**Phase 2 — changes required for multiple live Direct instances:**
3. Per-chat provider overrides (§C) — `providersStore.ts`, composer chips, `runtime.ts`. Tests: pick in panel A does not affect panel B's send; conversation default still applies.
4. Per-surface history visit (§D) — `useDirectHistoryWindow.ts`, `DirectViewportBridge.tsx`. Tests: two mounted surfaces, one remounts, recovery budget not double-spent.
5. Content-owned runtime component (§A) — a `ChatContent` component keyed by tab identity mounts the correct runtime (Direct or OpenCode) for the displayed content; `AuiProvider extends={null}` boundary only when nesting. The canonical `threadListAdapter` stays shared (§E). Tests: two Direct panels mount with distinct thread ids; unmount one leaves the other working; no duplicate conversation on tab move.

**Phase 3 — workspace integration:**
6. Panel/tab model renders positions that display `ChatContent` by `kind`+`ref`; Primary Chat stays a permanent position (not a fixed runtime); optional panels generic. Tests: all arrangements from the product spec; Direct and OpenCode can appear in any position; tab move preserves identity/runtime; closing a panel releases only its content's runtime.

**Deferred (unrelated):** visual redesign, file tree/viewer, editor, interactive browser, multi-draft.

---

## 5. Concrete acceptance tests
- Two Direct panels, distinct conversation ids, **distinct reply markers**, overlapping sends → each panel contains only its own marker (record message parts individually, do not join text).
- Two overlapping sends → two distinct operation ids in request headers and logs; tool continuation of send A reopens A's id only.
- Provider pick in panel A → panel B's send uses its own/default config.
- Two mounted Direct surfaces → one remounts → recovery budget spent once, no loop.
- Failed `list()` for query B after success for query A → B does not receive A's threads.
- Unmount panel A while B streams → B completes normally.
- Mixed Direct + OpenCode in one page → both mount, sends isolated (already proven in §2b.4; keep as regression).

---

## 6. Risks and genuine unresolved decisions
- **Operation context resolution in the global fetch wrapper**: choosing request-based resolution (header vs thread-keyed map) must not break existing single-runtime behavior or third-party requests. Evaluate with tests before committing.
- **Per-chat override storage location**: component-local vs feature store — decide based on where composer chips live; avoid a new shared `web/src/stores/`.
- **Multi-draft**: product decision required (§2.4). Recommendation: one draft for v1.
- **No new dependencies, no assistant-ui upgrade, no second tab system** — all constraints retained.

---

## 7. Documentation note
`technical-audit.md` §2b.4 had two stale lines calling the Option B observation a real defect; corrected to point at §2b.5 (measurement artifact). All spike evidence preserved. Workspace specifications unchanged.

**Independent verification (subagent, 2026-11-22):** all 14 factual claims checked against source — none contradicted. Corrections applied: (a) adapter-singleton causality in §2.2 item 5 was overstated (Run 1's failure was the nesting guard, not adapter identity); (b) `ResumableThreadRuntime` line range precision (`:198-547`, not `:549-571`); (c) `sendConfigs` keying nuance (thread + last user message id). Claims marked "structurally confirmed" (backend concurrency, OpenCode reuse, `extends={null}` ordering) are inherited from the completed spikes, not re-executed in this audit.

**Owner corrections (2026-11-22):** (1) runtime ownership now follows chat content, not panel position — Primary Chat is a permanent position rendering a `ChatContent` component, not a fixed Direct runtime; (2) the blanket "fresh adapter per panel" recommendation was removed — the canonical `threadListAdapter` stays shared, and the real adapter defect is fixed by query-keying the `lastGoodThreads` cache. The ownership table in §3 and the implementation sequence were updated accordingly.
