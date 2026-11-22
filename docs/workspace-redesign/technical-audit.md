# Technical audit — verified findings

All findings verified by reading source on 2026-11-21. Revision 2 re-verified at HEAD `244b412` (the pushed workspace-redesign commit). Paths are absolute under `D:\Temp\ai-chat-app`. Verdicts: **already / partial / missing / risky**.

**Verified facts vs recommendations:** Sections 1–2 are independently verified facts from source (12 claims checked: 11 TRUE, 1 nuance noted in 2.1). Section 3+ and all "Needed/Minimum first step" lines are **recommendations**, not verified behavior.

## 1. What TBAi already has

| Capability | Verdict | Evidence |
|---|---|---|
| Persistent shell shared by web + desktop | already | `web/src/app/layout/AppShell.tsx:195-251` |
| ActivityBar, resizable left sidebar, tab strip, status bar | already | `AppShell.tsx`, `components/ActivityBar.tsx`, `components/Sidebar.tsx:259-291`, `components/TabStrip.tsx`, `components/StatusBar.tsx` |
| Separate Direct Chat and OpenCode runtimes | already | `web/src/runtime.ts:560-571`; `features/opencode/OpenCodeIsolationBoundary.tsx:10-15` (`AuiProvider extends={null}`); `OpenCodeView.tsx:313-351` |
| Tab model with `groupId` reserved for split | already | `features/chat/state/chatTabs.ts`; `docs/decisions.md:542-605` (ADR-018), `:373` in architecture.md |
| dnd-kit tab reordering + keyboard | already | `components/TabStrip.tsx:5-13,81-160`; `docs/decisions.md:4455-4618` |
| Hand-rolled resize handle pattern | already | `components/Sidebar.tsx:259-291` (pointer capture, clamped width) |
| Device-local + portable preference persistence | already | `features/desktop/state/desktopLayout.ts:129-224` (localStorage `tbai:desktopLayout`, `partialize` persists `sidebarWidth`); `features/preferences/state/preferencesStore.ts:168-374` (SQLite via `/api/preferences`) |
| Registered folder/workspace model | already | `src/routes/folders.ts`, `src/services/folders.ts`, `src/services/workspace.ts:399-522` (`resolveConversationWorkspace`) |
| Code/markdown/diff/mermaid rendering | already | `web/package.json`: `react-shiki` 0.11.2, `@assistant-ui/react-markdown` 0.14.24, `remark-gfm` 4.0.1, `parse-diff` 0.12.0, `beautiful-mermaid` 1.1.3 |
| Browser automation tool (headless) | already | `src/services/browser.ts`, `src/tools/index.ts:383-404`, `web/src/tools/browser/ui.tsx` |
| Tauri frameless window + window controls | already | `src-tauri/tauri.conf.json`, `web/src/components/WindowControls.tsx` |

## 2. Gaps and risks

### 2.1 File APIs — PARTIAL
- `/api/folders/browse` lists **directories only** (`src/routes/folders.ts:112-135`, filter at `:123`). It is a folder-registration picker with **no containment check** (`:115-117`, arbitrary `?path=`) by design — do not copy it for a file explorer.
- Tool endpoints exist (`POST /api/tools/read|list|stat|search`, `src/routes/tools.ts:65-104`) but are bound to the global `WORKSPACE_DIR`, not the conversation workspace.
- `resolveConversationWorkspace` (`src/services/workspace.ts:399-522`) maps conversation → folder → dir, but **does not itself enforce containment** (project dirs may be anywhere). Real containment (`resolveSafe`, `inspectTarget`, `insideRoot`, `OutsideWorkspaceError`) lives in `src/services/tools.ts:116-177`. Both are needed: resolve the authorized root via `workspace.ts`, then confine every path via `tools.ts`.
- **Needed (recommendation):** a dedicated, Zod-validated, conversation-scoped `GET /api/files/list` and `/read` that resolves the root via `resolveConversationWorkspace` and confines paths via `resolveSafe`. First step: read-only list with a traversal/symlink-escape test.

### 2.2 OpenCode filesystem — PARTIAL / RISKY
- Pinned `@opencode/client` **2.2.6** (`web/package.json:30`). The promise client exposes `file.read` (`dist/promise/client.d.ts:332`), `file.list` (`:333`), `file.find` (`:334`); types at `dist/promise/generated/types.d.ts:5267-5295`. Official SDK docs: https://docs.opencode.ai/docs/sdk/ and https://docs.opencode.ai/docs/server (`GET /file`, `/file/content`, `/find/file`).
- The app's V2 boundary does not expose them (`web/src/features/opencode/v2Client.ts:90-111`) and the proxy allowlist has **no `/api/file/*` route** (`src/services/opencode/proxyRoutes.ts:105-205`; matcher `:238-273`). Drift tests enforce this: `tests/integration/opencode/opencode-proxy-allowlist.test.ts`, `tests/unit/web/opencode/v2ClientProxyRoutes.test.ts`.
- Browser-chosen directories are deliberately stripped (`v2Client.ts:174-179`); the proxy resolves directory from session id (`proxyAuthorization.ts:96-159`).
- **Needed (recommendation):** new `location`-scoped allowlist entries + V2 methods, with drift tests proving no client-supplied directory reaches upstream. High security risk.

### 2.3 Editor — MISSING (real) / PARTIAL (textarea)
- No CodeMirror, Monaco, or editor library in `web/package.json`. Only textareas and the assistant-ui composer input.
- A real editor needs a new dependency → ADR required. Read-only preview is feasible today with installed libraries.

### 2.4 Multiple Direct chat panels — RISKY
- One root `AssistantRuntimeProvider` (`AppShell.tsx:196`), one `<Outlet/>` (`:223`), one runtime bound to one thread (`AppShell.tsx:98-119`, `runtimeThreadId` from the single active tab).
- The proven isolation pattern is `AuiProvider extends={null}` (`features/opencode/OpenCodeIsolationBoundary.tsx:12`) — it resets ambient context so a child runtime is independent. `OpenCodeView.tsx:311-353` wraps its own `AssistantRuntimeProvider` this way. `router.tsx:24-27` states the two runtimes must never nest. (Nuance: CodeShell is a JSX child route of AppShell, but `extends={null}` makes the runtimes independent, not nested.)
- A second Direct panel needs the same isolation, plus careful handling of module-level `sendConfigs` (`runtime.ts:77`) and stable `runtimeHook` (`:549-558`). Official docs: https://www.assistant-ui.com/docs/api-reference/context-providers/assistant-runtime-provider and https://www.assistant-ui.com/docs/store/api-reference (`extends={null}` isolates).
- AGENTS.md dependency/context integrity rules (`:49-79`) and train freeze (`:81-85`) apply. This is the highest-risk item.

### 2.5 Interactive browser — MISSING / RISKY
- Three distinct things exist: web-search tool cards, a **headless** browser automation tool (`src/services/browser.ts:7,171` — `agent-browser` CLI via `Bun.spawn`; render-only UI at `web/src/tools/browser/ui.tsx:20-26`), and **no interactive browser panel**. Do not describe the headless tool as an embedded browser.
- No `iframe`/`webview`/`WebviewWindow` usage. Tauri CSP has no `frame-src` (`src-tauri/tauri.conf.json:34`), so it falls back to `default-src 'self'` and blocks external frames. Official docs: https://v2.tauri.app/security/csp, https://v2.tauri.app/reference/config, https://v2.tauri.app/concept/process-model.
- Most sites refuse framing (`X-Frame-Options` / `CSP frame-ancestors`). CORS trusts loopback ports (`src/config/cors.ts:86-124`) — framing arbitrary URLs is a major attack surface.
- **Minimum first step (recommendation):** read-only screenshot viewer from the existing `agent-browser screenshot` result (`src/services/browser.ts:318-324`), avoiding iframe/webview entirely. A genuinely interactive browser needs a backend headless-browser live relay (web) or Tauri webview + CSP/capability changes (desktop) — significant new work.

### 2.6 Split/resize/tabs — PARTIAL
- Installed: `@dnd-kit/dom` 0.5.1, `@dnd-kit/react` 0.5.1, `radix-ui` 1.8.1, `@tanstack/react-virtual` 3.14.21. No split-pane library.
- Reuse the Sidebar resize handle and dnd-kit tab reordering. No new dependency needed for v1.
- FlexLayout POC was evaluated but **not authorized** (`docs/decisions.md:4620-4679`): tab identity reconciliation, mutable model/stale closures, splitter count, popup context loss, DOM-test impossibility. Any layout model choice needs an ADR.

## 2b. Chat identity and runtime facts (verified 2026-11-21)

**Already implemented:**
- One unified tab store holds both chat types: `kind: "chat" | "agent"`, `ref` = conversation id (`web/src/features/chat/state/chatTabs.ts:20-27`). Keys `chat:<id>` / `agent:<id>` (`:92-102`). No runtime instance or engine field in the store — engine comes from the conversation row via `threadEngine()` (`remoteThreadListAdapter.tsx:348-358`).
- Direct identity chain: `conversations.id` (`src/db/index.ts:147-155`) → assistant-ui `remoteId` (`remoteThreadListAdapter.tsx:56-58`) → tab `ref` → `/chat/<id>`.
- OpenCode identity chain: `conversations.id` (= tab `ref`, `/code/<id>`) → `bootstrapOpenCodeSession(conversationId)` → `opencode_session_id` (`src/db/index.ts:305`) → scoped V2 client (`v2Client.ts:168-184`). Backend verifies the pair (`sessions.ts:438`).
- Sidebar shows both types with engine icons (Direct blue, OpenCode emerald) but no engine grouping (`config/sidebar.ts:9,14`; `SidebarThreadRow.tsx:208-223`). Active-row matching handles both key forms (`:102-105`).
- OpenCode per-session state is genuinely independent: client scoped per sessionId, controller per client, per-controller repository cache so two sessions cannot evict each other (`v2RuntimeStore.ts:128-140,157`).

**Feasible with existing infrastructure:**
- A tab of either type can be placed in any panel — the store already unifies them; panel position is presentation only.
- Moving a tab between panels can preserve identity if the tab keeps `kind` + `ref` (and the OpenCode session id is re-resolved from the conversation id by the backend).

**Requires architectural work / risky:**
- A second **simultaneously live** Direct tab: AppShell binds one `runtimeThreadId` to one provider (`AppShell.tsx:103-104,119,196`). Needs a second isolated provider (`AuiProvider extends={null}` pattern from `OpenCodeIsolationBoundary.tsx:10-15`) and decisions on module-level shared state: `sendConfigs` (`runtime.ts:77`), `threadListSearchQuery` / `lastGoodThreads` (`remoteThreadListAdapter.tsx:87,102-104`). assistant-ui caches per-thread runtimes for *switches*, which is not the same as two live mounted tabs.
- A second live OpenCode session: structurally easier (each `OpenCodeView` owns its client/controller/runtime) but today only one `CodeShell` route mounts at a time (`router.tsx:162-173`) and `sessionId` is component-local (`OpenCodeView.tsx:43`). Needs two mounted isolated providers and a tab model that keeps both mounted.

### 2b.1 Runtime isolation spike — REAL integration test (2026-11-21)

A temporary DOM integration harness (since removed) mounted the **real installed assistant-ui runtime** — `useRemoteThreadListRuntime` + `useChatRuntime` + `AssistantRuntimeProvider` — with only the network transport replaced by a deterministic SSE stub (the pattern in `tests/dom/components/p2-runtime-integration.test.tsx:61-83`). Three tests, 29 assertions, all passed:

1. **Two Direct runtimes, separate React roots, distinct thread ids** (`conv-refactor`, `conv-concurrency`): each bound to its own id, a send in A produced `REPLY-FROM-A` only in A, a send in B produced `REPLY-FROM-B` only in B, request bodies carried the correct ids, histories stayed independent, and unmounting A left B working.
2. **Two Direct runtimes nested in one React tree**: a critical ordering finding — `AuiProvider extends={null}` must wrap the component that *calls* `useRemoteThreadListRuntime`. Placing the boundary *inside* that component (around only `AssistantRuntimeProvider`) still throws `useRemoteThreadListRuntime cannot be nested...` (`@assistant-ui/core` `useRemoteThreadListRuntime.js:166-169`). With the boundary correctly outside, both runtimes were independent top-level runtimes (`source: null`) and messages did not cross.
3. **Real Direct + real OpenCode side by side**: Direct runtime (stub SSE transport) plus real OpenCode runtime (`createV2ThreadController` with the stub client from `tests/helpers/web/opencode/v2ThreadControllerHarness.ts:492-533` → real `useV2AssistantRuntime` `v2Runtime.tsx:9-31`) wrapped in the real `OpenCodeIsolationBoundary`. Both mounted; sends stayed in their own runtime.

**What `extends={null}` actually isolates (verified):** the assistant-ui client/context (`useAui`, `useAuiState`, scope accessors) — it creates a fresh root client that ignores ambient context (`@assistant-ui/store` `AuiProvider.tsx:170-174`). `AssistantRuntimeProvider` already installs its own `AuiProvider` internally, so **sibling providers are isolated by default**; the boundary is only needed when a second runtime is nested inside the first provider's subtree. It does **not** isolate module-level app state: `sendConfigs` (`runtime.ts:77`), `threadListSearchQuery`/`lastGoodThreads` (`remoteThreadListAdapter.tsx:87,104`), global operation state (`lib/operation.ts:51-53`, `lib/send-operation.ts:27`), and global Zustand stores remain shared across instances.

**Simplest safe architectural recommendation:** mount each chat panel as a **sibling** `AssistantRuntimeProvider` (no nesting) with its own `threadId`; keep the tab's `kind` + `ref` as identity. If a panel must nest inside another provider's subtree, wrap it in `AuiProvider extends={null}` **outside** the component that creates the runtime. Before shipping, decide how to handle the shared module-level state — it is benign for sequential sends but concurrent sends from two runtimes can supersede each other's global `operationId`. The spike used deterministic transports; real streaming/tool/error paths with a live backend were **not** exercised (out of scope for a DOM spike).

**Risks / unresolved:** duplicate assistant-ui context (AGENTS.md context-integrity rules `:49-79`); frozen assistant-ui train (`:81-85`); module-level shared state across runtime instances; no second tab-management system allowed.

### 2b.2 Shared-state concurrency audit (2026-11-21)

A narrowly scoped audit traced every module-level shared variable to its readers/writers, plus a temporary test (since removed) exercising interleaved operations against the real `operation.ts` / `send-operation.ts` modules (3 tests, 10 assertions, all passed). Findings:

**Already correctly keyed by thread/conversation — no change needed:**
- `sendConfigs` (`runtime.ts:77`, key `${threadKey}:${lastUserMsgId}` at `:382`) — per-thread; only the global 60-entry cap can evict another runtime's snapshot early.
- `resumable-stream.ts` `settledHistory`/`lastKnownStreamId` (`:18,:113`), `streamRecovery` `byThread`/`recheck*` (`streamRecovery.ts:64,71,73`), `materializedEngines` (`materializeDraft.ts:60`), `pendingFirstMessage` (localStorage keyed by conversation), all history-window Maps/Sets (`useDirectHistoryWindow.ts:115-546`) — all thread-keyed.

**Unkeyed global slots — must be scoped before two live Direct runtimes:**
1. `current` + `enclosing` (`lib/operation.ts:51,53`) and `activeSendOperation` (`lib/send-operation.ts:27`) — one global operation slot/stack. The interleaving test proved: a second `beginSendOperation` supersedes the first's id; a late `endSendOperation(expectedId)` is guarded out; a tool continuation `attachSendOperation(oldId)` supersedes a newer send. With two runtimes, operation ids and log headers cross conversations. Fix: per-send/async-local context, not a single global stack — cannot be fixed in `runtime.ts` alone because the logger and global fetch wrapper also read `currentOperationId()`.
2. `draftClientRequestId` (`materializeDraft.ts:46`) — single global idempotency key ("one slot suffices" assumes one draft tab). Two concurrent drafts share one key and can dedupe into one conversation row. Fix: key by draft/tab id or serialize materialization.
3. `lastMountedConversationId` (`useDirectHistoryWindow.ts:415`) — single global "last mounted" slot; two surfaces mounting different conversations misfire the one-shot history-recovery budget. Fix: per-surface or component state.
4. `lastGoodThreads` (`remoteThreadListAdapter.tsx:104`) — global cache; a failed `list()` for one query can return another query's threads. This is a **live correctness bug even with one runtime**. Fix: key by query tuple (search+sort+offset) or per-instance.
5. One-shot provider overrides in `useSettingsStore` (`providersStore.ts:30-32`) — a model/provider pick for one thread can be consumed by another's send. Fix: capture per-send before any `await`.

**Acceptable as global:** `useAvailabilityStore`, `useChatTabsStore`, `useDesktopLayout`, search/sort vars (pass as `list()` params), `mutationListeners`, logger/platform singletons.

**Smallest safe correction (recommendation, not implemented):** before enabling two simultaneous Direct panels, scope items 1–5; item 4 should be fixed regardless. No workspace architecture change is required — the spike supports generic panels, independent tabs, and separate Direct/OpenCode runtimes.

### 2b.3 Real backend streaming + tool execution — two concurrent conversations (2026-11-21)

A temporary integration test (since removed) drove the **real `/api/chat` Hono route in-process** with a local OpenAI-compatible SSE stub (tool call on first request, text on continuation), two real conversations, and **two concurrent POSTs** with different conversation ids. Pattern copied from `tests/integration/core/context-occupancy-runtime.test.ts:37-38,88-137,235-246`. Result: **1 test, 7 assertions, all passed** (~840 ms).

Verified evidence from the run:
- Two distinct `requestId`s and `conversationId`s in the logs — the requests genuinely overlapped (`Promise.all`).
- `upstreamCalls === 4` — each conversation made a tool call + continuation (real multi-step turn).
- Real tool execution logged for both: `tool.start/finish tool=list_dir` with distinct `toolCallId`s (`call_STREAM_A_7f3a`, `call_STREAM_B_9c1d`) and distinct conversation ids.
- Each SSE body contained its own marker and **not** the other's (`bodyA` has A not B; `bodyB` has B not A) — no cross-conversation text bleed at the backend.
- Both streams carried `text-delta` chunks and completed with `runStatus=completed`, `hadError=false`.

**What this proves:** the real backend (route + validation + registry + SQLite + context assembly + tool declaration/execution + workspace resolution + AI SDK streaming/continuation) handles two simultaneous conversations correctly — streams and tool results stay in their own conversation.

**What it does NOT prove:** two mounted assistant-ui *browser* runtimes against one backend (that is Option B / E2E, not yet run); real provider model calls (upstream was a stub); and the client-side shared-state risks in §2b.2 (this test exercised the backend only). The earlier DOM spike (§2b.1) covered two mounted runtimes with stub transports; together they cover both halves, but not in one test.

### 2b.4 Option B — two real runtimes in ONE browser page (2026-11-21)

A temporary lab route + component under `web/src` (since removed; originals restored byte-for-byte) mounted real runtimes in one React tree against the real E2E backend with the deterministic stub provider. Two runs:

**Run 1 (module-singleton adapter):** both Direct panels used the shared `threadListAdapter` (`web/src/app/adapter.ts:8`). Result: both user messages landed in ONE panel's thread; the other was empty. Confirms the audit's warning that sharing the singleton adapter across two runtimes is unsafe.

**Run 2 (fresh adapter per runtime):** each Direct panel created its own `createRemoteThreadListAdapter()`; OpenCode used the real `useOpenCodeRuntime` + `OpenCodeIsolationBoundary` after a real `POST /api/opencode/session` bootstrap. Results:
- **Mixed Direct + OpenCode: PASSED** — both runtimes mounted in one page with distinct thread ids (`qo3x...` Direct, `ses_e0107...` OpenCode session); no cross-talk observed in the mount assertion.
- **Two Direct: FAILED** — user messages stayed in the correct panels (A: `ALPHA_7f3a`, B: `BETA_9c1d`), but **both assistant replies appeared in BOTH panels with duplicated text** (`"REPLY ALPHA_7f3aREPLY ALPHA_7f3a"` in each). Initially read as shared-state interference; §2b.5 later proved this was a **probe measurement artifact** (joining multiple text parts of one message), not a product defect.

**Browser console/network:** no uncaught page errors in run 2; the earlier nesting-guard error from run 1's first attempt was resolved by the `AuiProvider extends={null}` boundary. Network showed normal `/api/chat`, `/api/opencode/session`, `/api/conversations/*/messages/window` traffic; no 5xx. (The mixed test's first attempt had a 422 on `/api/opencode/session` because the seeded conversation was `engine=direct`; fixed by seeding `engine=opencode`.)

**Real vs simulated:** real frontend runtime integrations, real backend, real SQLite, real streaming/tool continuation; only the upstream model was the deterministic stub.

**Findings from this run (see §2b.5 for the corrected interpretation):**
1. The apparent cross-write was a probe artifact, NOT a product defect (proven in §2b.5).
2. The module-singleton `threadListAdapter` cannot be shared by two runtimes — each needs its own adapter instance (confirmed: Run 1 with the singleton failed, Run 2 with fresh adapters mounted correctly).
3. AppShell always mounts a root Direct runtime, so any second Direct panel is necessarily nested and requires `AuiProvider extends={null}` around the runtime-creating component.

**Cleanup:** temporary lab component, route constant, router entry, and spec removed; `router.tsx` and `routes.ts` restored to exact original SHA-256 hashes; generated E2E log artifact removed. No production code, dependencies, commits, or pushes.

### 2b.5 Cross-write defect investigation (2026-11-21) — ROOT CAUSE: measurement artifact, not a product defect

Follow-up investigation traced the complete message path with temporary in-process tests (since removed) and full source audits of both the backend and the installed assistant-ui/AI SDK packages.

**Backend — proven clean:**
- Two concurrent `/api/chat` requests with different conversation ids and the SAME stub reply text produced SSE bodies each containing exactly **one** reply and no other conversation's text (`zz-spike-crosswrite.test.ts`, since removed).
- No shared stream controller: `streamWriter` holder + `terminal` are created per request (`src/routes/chat/index.ts:64-66`); all stream artifacts keyed by a unique per-request cuid2 `streamId` (`chat-runs.ts:155`, `assemble-run.ts:109-115`, `resumable.ts:27-35`).
- The request's `messageId` field is **ignored** by the backend (declared `validation.ts:63`, not destructured at `index.ts:32`, zero matches in `src/routes/chat/`). Assistant reply ids are server-generated cuid2 (`execute-direct-stream.ts:845,957`).
- Persistence rejects cross-conversation id collisions (`storage/messages.ts:490-498` `MessageOwnershipError`, `:516-524` guarded upsert). The backend does not persist normal replies at all — that is client-side via the history adapter (`zz-spike-persist-check.test.ts` showed 0 backend rows after a successful tool turn).

**Frontend — no cross-route mechanism found:**
- Every stream-append path is scoped to a per-thread `Chat` instance. `useChatThread.ts:290-297` creates one `Chat` per thread; `DynamicChatTransport.ts:117-120` keys contexts by `chatId`; `requestsByChat` is a WeakMap keyed by Chat identity (`useChatThread.ts:156`); all library module-level state is WeakMaps/instance-scoped. No global message map, singleton Chat, shared AbortController, or event bus forwards stream text between runtimes.
- `sendConfigs` (`runtime.ts:77`) is keyed by `threadKey:lastUser.id` and holds config only; operation/send singletons (`operation.ts:51`, `send-operation.ts:27`) affect logging/correlation only. Ruled out as causes of text concatenation.

**Root cause of the observed "cross-write":** the Option B probe itself. It read `s.thread.messages` and joined each message's text parts with `""` (`TwoRuntimeLab.tsx` Probe). A single tool-using turn legitimately produces an assistant message with **multiple text parts** (tool-call step + continuation step), so the probe rendered `"REPLY ALPHA…REPLY ALPHA…"` — one message's parts concatenated — in **both** panels (both were sent the same stub reply text). The user messages were distinct and correctly placed, and the backend SSE bodies were clean, which is consistent with a measurement artifact rather than cross-writing. The mixed Direct+OpenCode test passed because no sends were asserted there.

**Classification:** NOT a backend stream-generation, persistence, or frontend event-routing defect. The "cross-write" was a **test-harness measurement artifact** (probe joining multiple text parts of one message). The genuine shared-state risks from §2b.2 remain open but were not the cause of this observation.

**Smallest safe fix (for the test, not production):** in any future two-runtime probe, record each message part separately (array of `{type, text}`) and assert on distinct reply markers per conversation, rather than joining all text parts into one string. No production fix is warranted for the observed symptom.

**Focused test plan if re-verification is desired:** (1) two runtimes, distinct reply markers per conversation, assert each panel contains only its own marker; (2) record message parts individually to distinguish multi-part single messages from cross-written streams; (3) compare overlapping vs sequential sends; (4) assert persisted rows via the client history adapter with polling.

## 3. Highest-leverage first step

A **safe, conversation-scoped, containment-checked file-serving endpoint** unblocks three things at once: file tree, file preview, and a read-only browser screenshot viewer. Build that primitive first.

## 3b. Product decisions — recommendations with trade-offs (task §7)

| Decision | Recommendation | Trade-off |
|---|---|---|
| Saved layout scope | Device-wide first (localStorage, like `sidebarWidth`); per-project override later | Device-wide is simplest and matches existing persistence; per-project adds complexity but better context isolation |
| Pinned context on project/conversation change | Pinned by default; follow is explicit opt-in | Prevents leakage; costs one extra click when the user does want following |
| First panel types | `files` + `viewer` (read-only) | Lowest risk — needs only the file endpoint + installed renderers; proves the workflow |
| Deferred | writable editor, interactive browser, per-conversation layouts, full narrow-screen redesign | Each needs new deps/security work; deferring keeps v1 small and reviewable |
| Primary Chat tabs | Keep existing tab behavior; no second tab system | Avoids duplicate state and context risk |

## 3c. Recommended implementation sequence (task §8)

1. Finalize workspace model and interactions (this document set).
2. Establish permanent two-region layout + optional panel foundation (reuse `useDesktopLayout`, Sidebar resize handle, dnd-kit).
3. Add layout persistence (device-local first).
4. Add secure project file browsing + read-only preview (new conversation-scoped endpoint with `resolveSafe` containment).
5. Validate isolated Direct Chat and OpenCode panel feasibility with a spike before adding those panel types.
6. Add further panel types only after their technical requirements are proven.
7. Apply the broader visual redesign consistently last.

This order is unchanged from the earlier plan because the code audit supports it: the file endpoint is the highest-leverage primitive, and the second-runtime risk must be proven before chat/assistant panels are committed.

## 4. Quality gates (every implementation phase)

`bun run verify` = typecheck → lint (`--error-on-warnings`) → format:check → test:locations → build → unit/integration → three lifecycle suites → DOM contracts → OpenCode quarantine. Plus `bun run test:e2e`, `bun run test:opencode-runtime`, `bun run security`. Build before tests. Definition of DONE: planner disk-review accepted; typecheck and build independently re-run exit 0; real test counts recorded; no commit/push until end-to-end verification passes. UI work must walk the user-visible flow step by step.
