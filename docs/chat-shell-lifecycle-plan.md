# Chat Shell Lifecycle Plan — /code chrome, refresh/reconnect, first-message

Status: **Phase 1 implemented on disk (uncommitted). Phases 2–3 planned, not started.**
Written 2026-09-19 from direct source inspection (imports traced, library internals
verified in the installed `@assistant-ui/react@0.15.20` / `@assistant-ui/core@0.3.19`
/ `@assistant-ui/react-opencode@0.2.23`).

Reference studied: **OpenChamber** (`D:\Temp\openchamber`) — the patterns adopted here
are its `ChatContainer` hydration skeleton (Problem 2) and its materialize-first-then-send
draft submit (`materializeOpenDraftSession` + `routeMessage`, Problem 3).

---

## 1. Root cause — `/code` hides the normal TBAi chrome

`CodeShell` (`web/src/features/opencode/CodeShell.tsx`) renders only `ActivityBar` +
`CodeHeader` + `OpenCodeView`. It deliberately omits `Sidebar`, `TabStrip`, `StatusBar`,
`LeftEdgeChrome`, `RightEdgeChrome`.

The reason is a hard runtime constraint, not a presentation choice. The OpenCode
adapter's `useRemoteThreadListRuntime` degrades to a parent-context no-op when nested
inside another `RemoteThreadListRuntime`:

- `useRemoteThreadListRuntime.js` (core): `if (useAui().threadListItem.source !== null) { … return options.runtimeHook(); }` — the nested runtime reads the **parent** thread identity instead of its own session id.
- `threadListItem.source` is set to `"threads"` by any active `RemoteThreadListRuntime` (`RemoteThreadList.js:121`).

So the OpenCode runtime must be created where there is **no** ambient chat runtime.
The chrome components (`Sidebar`, `TabStrip`) read the chat runtime via `useAuiState`,
so they need the chat runtime present. The two requirements conflict under the current
single-provider layout.

## 2. Root cause — refresh/reconnect disruption

`OpenCodeView` gates the **entire** view behind `sessionId` resolution:

- `if (!sessionId) return "Starting OpenCode…"` (`OpenCodeView.tsx:183-190`) — a full
  viewport replacement shown until `POST /api/opencode/session` resolves.
- After the runtime mounts, agent-mode `ChatWindow` shows **no** boot skeleton while
  history loads (`showBoot = mode === "chat" && !isDraft && isHistoryLoading`), so the
  viewport is empty while `loadState === "loading"` and the `OpenCodeStatus` heart
  pulses "working".

The OpenCode conversation's messages live **only** in the OpenCode session (the runtime
uses an in-memory `messageRepository` from `projectOpenCodeThreadRepository`; it does
not persist to TBAi SQLite). So on refresh the history cannot be rendered before the
session is resumed. What CAN be restored immediately is the conversation identity and
the application chrome.

## 3. Root cause — first-message loss

The first send on an OpenCode-engine draft goes through the **Direct** runtime:

1. Draft thread lives in `ChatShell`'s Direct runtime (`/chat/new`).
2. Send → `initialize()` → `POST /api/conversations` (engine=opencode) → remoteId.
3. `handleThreadIdChange(remoteId)` → `resolveDraftId(remoteId, "opencode")` → agent tab → `TabUrlSync` navigates to `/code/<id>`.
4. Meanwhile the Direct runtime's `onNew(message)` sends to `/api/chat` with the **local** thread id (`__LOCALID_…`), so the backend treats it as an ad-hoc Direct send (no conversation row) and the Direct provider generates a response.
5. The Direct runtime unmounts on navigation; the response is discarded. The OpenCode runtime mounts at `/code/<id>`, loads history from the (empty) session, and never receives the first message.

Result: first prompt "disappears", no assistant response, second prompt works. The
Direct send also wastes tokens (a response is generated and thrown away).

## 4. Lifecycle / state ownership

| Concern | Owner | Change |
|---|---|---|
| Conversation identity | SQLite row (authoritative) | unchanged |
| URL | projection of the tab store | unchanged |
| Open/active tabs | `useChatTabsStore` | unchanged |
| Direct thread/message state | Direct runtime (`ChatShell`) | unchanged |
| OpenCode session/message state | OpenCode runtime (`OpenCodeView`) | unchanged |
| Chrome (sidebar/tabs/status) | chat runtime context | **new**: a chat runtime is created in `CodeShell` for the chrome |
| OpenCode runtime isolation | `AuiProvider extends={null}` | **new**: isolates the OpenCode subtree from the chrome's chat runtime |
| First-message handoff | `pendingFirstMessage` store | **new**: draft → conversation → OpenCode runtime |

## 5. Chosen fixes

### Phase 1 — `/code` shell  ✅ IMPLEMENTED ON DISK (uncommitted)

The disk implementation chose a **cleaner approach than the original plan**: instead of
creating a second chat runtime in `CodeShell` for the chrome, the chrome was made
**runtime-independent** so the unified `AppShell` renders everywhere with no chat runtime
above the OpenCode surface.

Verified on disk (2026-09-19, `bun run typecheck` exit 0):

1. **`AppShell`** (`web/src/app/layout/AppShell.tsx`) — accepts `children` and renders
   `{children ?? <Outlet />}` inside `PageContextMenu`. Doc comment now states the shell
   navigation does not depend on an assistant-ui execution runtime.
2. **`CodeShell`** (`web/src/features/opencode/CodeShell.tsx`) — renders the unified
   `AppShell` with `OpenCodeView` as children. No `useAppChatRuntime`, no
   `AssistantRuntimeProvider` (guarded by `CodeShell.test.tsx`).
3. **`OpenCodeIsolationBoundary`** (`web/src/features/opencode/OpenCodeIsolationBoundary.tsx`,
   new) — wraps children in `AuiProvider extends={null} config={AuiConfig({})}`. Verified in
   the library: `extends={null}` → `parent = DefaultAssistantClient` (`AuiProvider.js:72`),
   and the client's `threadListItem.source` returns `null` (`client-accessor.js:39`), so a
   nested OpenCode runtime does **not** degrade.
4. **`OpenCodeView`** — `AgentRuntime` wraps its content in `OpenCodeIsolationBoundary`.
   `useOpenCodeRuntime` runs above the boundary, but there is no chat runtime above
   `CodeShell`, so the OpenCode runtime is already top-level and does not degrade; the
   boundary is the safety net for descendants.
5. **Chrome decoupled from the chat runtime**:
   - `Sidebar` now loads via `useConversationsList` (`web/src/features/sidebar/hooks/useConversationsList.ts`,
     new) — a race-protected `fetch("/api/conversations")` projection — instead of
     `ThreadListPrimitive` + `useAuiState`.
   - `TabStrip` already decoupled in commit `07d17bf` (uses `threadListAdapter.fetch`).
   - `StatusBar` already runtime-free (uses `useSettingsStore`).

Remaining Phase 1 cleanup (optional): `CodeHeader.tsx` is no longer referenced by
`CodeShell` — delete it if nothing else imports it.

### Phase 2 — refresh / reconnect UX

Adopts OpenChamber's `ChatContainer` pattern: a **message-shaped hydration skeleton**
rendered inside the normal layout while a known session loads — never a full-screen
"Connecting" replacement.

1. **`OpenCodeView`**: replace the full-viewport `"Starting OpenCode…"` with a
   message-shaped boot skeleton rendered inside the normal chrome (the chrome is now
   always visible from Phase 1). The session resume stays a single idempotent
   `POST /api/opencode/session` (no polling, no fake readiness).
2. **`ChatWindow`**: show the boot skeleton in agent mode too while history loads
   (`showBoot` applies when `mode === "agent" && isHistoryLoading`), so the viewport is
   never empty during reconnect.
3. **`OpenCodeStatus`** heart remains the non-blocking connection indicator (error/off/
   working/idle). No new state system.

Constraint honored: OpenCode messages live only in the session, so the history appears
when the session is ready (fast when the managed server is already running). The
conversation surface + chrome appear immediately; a full-screen/empty replacement does
not.

### Phase 3 — first-message materialization

Adopts OpenChamber's `materializeOpenDraftSession` + `routeMessage` pattern: the draft
submit **materializes the conversation first, then sends the message to the new
conversation's runtime** — the message is never delivered through a draft runtime.

1. **`pendingFirstMessage`** (new, `web/src/features/chat/state/pendingFirstMessage.ts`):
   a Map keyed by conversation id with `setPendingFirstMessage(conversationId, text)` /
   `takePendingFirstMessage(conversationId)`.
2. **`runtime.ts` `prepareSendMessagesRequest`**: detect the OpenCode draft first send
   (`getWelcomeEngineSnapshot().engine === "opencode"` AND `messages.length === 1` AND
   the active tab is the draft). Store the last user message text in a single-slot
   pending message, and mark the request body `engine: "opencode"` so the backend
   short-circuits the Direct provider call (no wasted tokens, no invisible Direct send).
3. **Backend `src/routes/chat.ts`**: when the request body carries `engine: "opencode"`
   and there is no conversation row (a draft), return a benign empty UI message stream
   instead of running the Direct provider. This is the "materialize first, then send"
   guarantee: the first message is never delivered through the Direct runtime.
4. **`ChatShell.handleThreadIdChange`**: when the active tab is the draft AND the engine
   is "opencode", move the single-slot pending message to the conversation id
   (`remoteId`) before `resolveDraftId(remoteId, "opencode")`.
5. **`OpenCodeView`/`AgentRuntime`**: after the runtime mounts and history reaches
   `loadState === "ready"`, `takePendingFirstMessage(conversationId)`; if present, send
   it via `runtime.thread.send({ text })`. Sending after history load avoids the
   load/send race (the message cannot be overwritten by a stale history snapshot).

## 6. Tests (deterministic, no sleeps)

- `pendingFirstMessage` store: set/take semantics, take-once, unknown-id returns null.
- `prepareSendMessagesRequest` detection: source guard (the draft-first-send predicate).
- `handleThreadIdChange` move: unit test of the draft→conversation pending-message move.
- OpenCode runtime pending-message send: extend the existing fake-server harness
  (`reconnect.test.ts` / `liveStream.test.ts`) to assert the pending message is sent
  after history load, exactly once, and not duplicated.
- Concurrency coverage (deferred-promise/barrier style, no arbitrary delays):
  1. first-send creation + runtime binding overlap
  2. first-send creation + assistant response arrival
  3. refresh + OpenCode reconnect
  4. reconnect + existing message restoration
  5. conversation switch + late runtime event
  6. first message + route/tab update
  7. runtime reconnect + send new message

## 7. Browser verification

- A. `/code` chrome: sidebar, tabs, status bar, navigation, switch Direct↔OpenCode.
- B. OpenCode refresh: open existing conversation → refresh → chrome + skeleton
  immediately, history appears, background reconnect, send works, no duplicates.
- C. First prompt: Direct from Welcome (one send → message + response); OpenCode from
  Welcome (one send → message + response, no second prompt).
- D. Session switching: no runtime/session mixup.
- E. Regression: Shield stays OpenCode-only; Direct unchanged.

## 8. Files expected to change

Phase 1 (✅ on disk, uncommitted):
- `web/src/app/layout/AppShell.tsx` — `children` prop (`{children ?? <Outlet />}`).
- `web/src/features/opencode/CodeShell.tsx` — unified `AppShell` + `OpenCodeView`.
- `web/src/features/opencode/OpenCodeIsolationBoundary.tsx` — **new**.
- `web/src/features/opencode/OpenCodeView.tsx` — wraps content in `OpenCodeIsolationBoundary`.
- `web/src/components/Sidebar.tsx` — `useConversationsList` (runtime-independent).
- `web/src/features/sidebar/hooks/useConversationsList.ts` — **new**.
- `web/src/features/opencode/CodeShell.test.tsx` — **new** architecture guard.
- `web/src/features/sidebar/components/*` — row/view-menu decoupling.
- `web/src/features/opencode/CodeHeader.tsx` — delete if unreferenced (optional).

Phase 2 (next):
- `web/src/features/opencode/OpenCodeView.tsx` — message-shaped boot skeleton instead of "Starting OpenCode…".
- `web/src/components/ChatWindow.tsx` — agent-mode boot skeleton.

Phase 3 (after Phase 2):
- `web/src/features/chat/state/pendingFirstMessage.ts` — **new**.
- `web/src/runtime.ts` — OpenCode draft first-send detection + capture + `engine` body marker.
- `src/routes/chat.ts` — benign empty stream for OpenCode-engine draft sends.
- `web/src/app/layout/ChatShell.tsx` — pending-message move in `handleThreadIdChange`.
- `web/src/features/opencode/OpenCodeView.tsx` — pending-message send after `loadState === "ready"`.

Tests: `pendingFirstMessage.test.ts` (new), `chatShellLifecycle.test.ts` (new),
`reconnect.test.ts` (extend), `liveStream.test.ts` (extend).

## 9. Non-goals

- No merge of `ChatShell`/`CodeShell`; no new global shell abstraction.
- No redesign of the OpenCode runtime, Direct runtime, or assistant-ui integration.
- No change to Shield / permissions / questions / auto-approval.
- No second conversation identity; no temporary duplicate conversations.
- No timing hacks (setTimeout/sleeps/polling/forced second message).
- No change to conversation persistence or the OpenCode session model.

## 10. Phase 2 Refresh/Reconnect Audit (audit-only, no app code changed)

Traced from current on-disk source (imports + installed-library internals verified;
`useOpenCodeRuntime.ts`, `runtimeClient.ts`, `initialHydration.ts`, `sessions.ts`,
`chatTabs.ts`, `useConversationTab.ts`, `OpenCodeStatus.tsx` all untouched since the
Shield rebuild / web-port work — Phase 1 and Steps 1–3 touched chrome + loading
presentation only).

### 1. Actual refresh sequence (existing `/code/<id>` conversation)

1. Browser refresh → hash route restored (`/code/<id>`); `CodeShell` mounts the
   unified `AppShell` (Sidebar via `useConversationsList`, TabStrip via
   `threadListAdapter.fetch`, StatusBar) — chrome renders from persisted state.
2. `OpenCodeView` mounts: `agentId` from route; `useConversationTab(agentId,
   "agent")` opens/activates the agent tab and validates the row (deleted ids
   fall back to draft; engine mismatches redirect to the row-correct surface).
3. `sessionId` state starts `undefined` → message-shaped `ThreadBootSkeleton`
   inside the content surface (Step 1; no full-screen replacement).
4. Single idempotent `POST /api/opencode/session` → `ensureOpenCodeSession`:
   reuses the row's stored `opencode_session_id` when the server still knows it,
   else creates one session and persists the pointer; directory is read back from
   the server's own session record.
5. `AgentRuntime` mounts → `useOpenCodeRuntime` builds the client (event scope +
   permission/question scope + hydration + V2 normalization + todo projection)
   and the official runtime with `initialSessionId` (consumed once, never stale).
6. The controller `load()`s: `session.get` + `session.messages` → `history.loaded`
   (or `history.failed`); `ChatWindow` shows the boot skeleton while
   `isHistoryLoading` (Step 3), then the projected messages.
7. The scoped event subscription connects (`server.connected` → initial hydration
   replays pre-existing pending permissions/questions through the normal path);
   `OpenCodeStatus` heart settles to idle/Connected.

### 2. Current disruptive gate

No "Connecting…/Reconnecting…" full-screen text exists anywhere in `web/src` or
the installed adapter (grep-verified). The only "Reconnecting…" strings are the
logs-tail indicator (unrelated surface) and the Reconnect **button** label inside
the `OpenCodeStatus` popover (small, non-blocking, correct). The two historical
gates are already fixed on disk: the `!sessionId` full-viewport loader (Step 1 →
skeleton) and the empty agent-mode viewport while history loads (Step 3 → skeleton).

### 3. Persisted identities/state (survives refresh)

- TBAi SQLite: conversation id/title/engine/config, `opencode_session_id`
  pointer, tabs are NOT here (tabs live in localStorage via `chatTabs.ts`).
- Browser localStorage: open/agent tabs + active key, welcome draft/engine/scope.
- OpenCode server: session record, directory binding, full message history.
- Recreated on refresh (in-memory only): assistant-ui runtimes, event
  subscriptions, client epoch, todo projection, Shield `answered` sets.

### 4. Reconnect lifecycle (existing, verified)

- `reconnect()` bumps `clientEpoch` only; the rebuilt client carries the SAME
  `sessionId` + directory, so the adapter disposes its registry (single
  subscription torn down via the existing dispose path) and subscribes anew —
  then hydration + reconcile restore state through the normal path (pinned by
  `reconnect.test.ts`, including rapid double-reconnect and session-switch
  cases).
- Stale async resolutions are guarded by the controller's `reconnectSyncToken`;
  hydration replay is idempotent (`pending[id]` assignment) and shares the
  per-runtime `answered` set with the live path and the reconcile seam.
- Route switch unmounts `AgentRuntime`, whose registry dispose detaches the old
  subscription — a late event from a dead runtime cannot mutate the new one.

### 5. Message/history source (re-verified)

OpenCode message history comes **only** from the OpenCode session
(`session.messages` via the proxy). Nothing under
`web/src/features/opencode/` touches `threadHistoryAdapter`, the
`/api/conversations/:id/messages` store, or `messageService` (grep-verified);
the library builds its own thread-list adapter internally. The TBAi message
store is Direct-chat only. No storage change is proposed.

### 6. Exact root cause

The refresh disruption was **two presentation gates, not a lifecycle defect**:
(a) the whole view was replaced while `sessionId` resolved; (b) the agent-mode
message viewport was empty while history loaded. Both are fixed on disk
(Steps 1–3). The session/resume/reconnect lifecycle underneath — same session
identity on refresh, scoped subscription, idempotent hydration, epoch-serialized
reconnects — is already correct and covered by the existing deterministic tests.

### 7. Smallest proposed fix

**Category E: the existing reconnect lifecycle is already correct; only
presentation needed adjustment — done in Steps 1–3.** No session-API, runtime,
hydration-order, or reconnect change is proposed. If any follow-up is ever
needed, the only remaining lever is shortening cold-start session resolution
(server already running ⇒ fast path already exists); do NOT add polling,
retries, readiness simulation, or a second loading component.

### 8. Tests required (for the eventual implementation sign-off; not added here)

Deferred-promise/barrier style, no sleeps, reusing the existing
fake-server harness (`reconnect.test.ts` / `liveStream.test.ts`):
refresh of a known conversation, session reconnect, existing-message
restoration, no duplicate replay, no duplicate session, old-runtime event
isolation, conversation switch during reconnect, reconnect failure retaining
the known conversation surface.

### 9. Browser observations

Deferred: no app instance is listening (`127.0.0.1:3000` refused) and a live
run additionally needs the managed OpenCode server plus a working
provider/model. No code was altered to work around this. The loading
transitions (skeleton → history) are covered by the committed source-guard and
predicate tests instead.

### 10. Remaining uncertainties

- Cold-start session latency on a fresh machine (server boot + session resume)
  has not been timed; the skeleton covers it by design, but no number is on
  record.
- The full-suite baseline is red from unrelated backend/environment failures
  (see stabilization report), so end-to-end refresh proof still awaits a green
  tree or an isolated environment.