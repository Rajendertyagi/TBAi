# OpenCode retry visibility + honest session restoration — implementation and acceptance plan

**Status:** implemented and pushed. G1, G2, G3, G4, G5, and G6 pass within their
stated scope; G2 now includes the packaged shell hard-kill, G4 now includes 2.0.x,
G3 is the bounded process-kill guarantee, and G6 covers the Tauri sidecar restart.
**Open preflight:** P7 recorded as documentation-only acceptance. P3 is done.
**Branch:** `ci/tauri-e2e-verify`
**Date:** 2026-10-23

This revision began from the branch at `029229e`; the implementation was pushed
through `fe10255`. It was checked against the installed
`@opencode/client` 2.1.2 contract, the installed 2.1.2 OpenCode server, the
OpenCode `v2.0.15`, `v2.0.22`, and `v2.1.2` source tags, TBAi's existing
session/bootstrap/runtime/persistence code, the assistant-ui 0.15.30 package in
this checkout, and the official assistant-ui documentation. Persistence and
crash-recovery claims are scoped to the versions and paths named in §4 and are
labelled **verified**, **inferred**, or **unknown** there.

Evidence confirmed during this revision:

- `V2AuxiliaryAvailability` is exactly `"current" | "unavailable"`; there is no
  `"available"` value.
- `load_started` is dispatched by both `hydrate()` (a connection attempt) and
  `refresh()` (ordinary history refresh). A single unconditional rule is wrong.
- `session.active` is already a global map, so the browser boundary must remain
  a backend-owned, session-filtered read.
- The real wire event is `session.status`; `session.status.updated` is a dead
  allowlist literal.
- assistant-ui 0.15.30 has no retry/status primitive. Its `ThreadPrimitive`
  has no `Status` member, `AuiIf` reads assistant-ui runtime state, and
  `ErrorPrimitive` is for runtime/message errors. None of them owns OpenCode
  retry or restoration state.
- For OpenCode, TBAi persists only the conversation row and its
  `opencode_session_id`; the OpenCode server is the authority for OpenCode
  messages, pending input, retry records, and execution claims. TBAi's history
  adapter deliberately writes no OpenCode messages to TBAi SQLite.
- TBAi's managed child is default-mode `opencode serve`. In the supported
  source tags reviewed, OpenCode installs its restart-continuity sweep only for
  service mode, so an orphaned execution claim is durable but is **not**
  automatically resumed here.
- The OpenCode database is not under TBAi's `DATA_DIR` by default. It follows
  `XDG_DATA_HOME` plus `OPENCODE_DB` or the binary's channel-derived filename;
  `OPENCODE_CONFIG.serverHomeDir` is only the child's cwd. A launch-environment
  change can point the same saved session id at a different database.

## Corrections applied in this revision

1. All inbox checks use `auxiliary.inbox === "current"`. `"unavailable"` is a
   failed read and can never be treated as an authoritative empty queue.
2. Retry is no longer cleared on every `load_started`. The action carries
   `reason: "connection" | "refresh"`; only the connection reason invalidates
   the countdown. An ordinary successful refresh preserves an active retry.
3. Activity responses are guarded by an `activityRevision` ordering marker.
   Authoritative activity, retry, connection, and load events update activity
   where applicable and increment the revision; a response from an older revision
   is discarded. No polling loop or second runtime is added.
4. Every `session.execution.interrupted` clears retry, including
   `reason === "shutdown"`. An interruption does not prove a retry remains
   scheduled, and the plan no longer claims the run remains alive.
5. `session.active` is treated as present in the official handlers for
   `2.0.15`, `2.0.22`, and `2.1.2`. The plan makes no unsupported claim that
   supported 2.0.x releases lack the operation; request failures still become
   `unknown`.
6. The restoration notice is explicitly a **session-restoration notice shown on
   every verified live reuse**, including ordinary navigation and while a retry is
   active. `reusedExistingSession` proves verified reuse, not an application restart.
   It is not described as crash-only or restart-only.
7. assistant-ui was studied online and in the installed package. No new
   assistant-ui element or dependency is introduced; the two feature-owned
   surfaces stay in the existing `aboveComposerExtra` slot.
8. **Session identity and history have separate owners.** TBAi persists the
   conversation row and `opencode_session_id` in `DATA_DIR/chat.db`; OpenCode
   persists its session rows, messages, pending inbox rows, retry records, and
   execution claims in its own resolved OpenCode database (the filename depends
   on `OPENCODE_DB`, the channel, and the data root; see §4.2). TBAi stores no
   duplicate OpenCode transcript.
9. **The managed child is default-mode `opencode serve`.** OpenCode installs
   restart continuity only when the server is started with a lifecycle (service
   mode). TBAi passes none, so a durable execution claim is **not**
   automatically resumed. The plan makes no resumed-execution claim.
10. **OpenCode storage is not pinned to TBAi's data directory.** The child
    inherits `XDG_DATA_HOME` and `OPENCODE_DB`; `serverHomeDir` is only its cwd.
    The default filename is also channel-dependent: stable channels use
    `opencode.db`, other channels use `opencode-<channel>.db`. A launch-environment
    or binary-channel change can make the same session id resolve to a different
    database, where it is treated as missing.

### Technology guardrails (confirmed)

| Technology | Existing state | This plan's use |
|---|---|---|
| Zustand | Installed in `web/package.json` | **Do not migrate the OpenCode V2 runtime to Zustand.** It already has its controller, `getState()`, `subscribe()`, and reducer; extend those. Zustand remains for unrelated shared UI state only |
| Zod | Root dependency, already used by backend routes | Reuse it in `src/lib/validation.ts` for the activity request schema. No new validation library |
| SQLite / conversation storage | Already stores conversation and OpenCode session bindings | Verify the requested conversation owns the specified session before the OpenCode call. **No new table, column, or migration.** OpenCode remains the history authority |
| OpenCode SQLite | Owns `session_v2`, `session_message`, `session_inbox`, retry records, and execution claims | Read only through the official client. Do not open or copy this database as a second TBAi store. Its path must remain stable for a saved session id to resolve |
| `@opencode/client` | Version 2.1.2 installed | Use its existing `session.active()`, event types, and `SessionStatus`/retry shapes. No second client or hand-rolled protocol |
| React / assistant-ui | Existing WebUI and primitives | Render the retry and restoration surfaces in the existing feature UI. No new framework or assistant-ui element |

No new dependency, state-management library, persistence layer, database schema,
or migration is added. The existing controller/reducer is the single state flow
for this feature. OpenCode's existing database remains the only OpenCode history
store; this plan neither duplicates it nor moves it. The storage-path dependency
and its consequences are recorded in §4.

---

## 1. Answers to the review questions

### 1.1 Can/should existing functions be upgraded instead of adding new ones?

**Yes — nearly all of this feature is an upgrade of existing owners.**

| Existing function/module | Upgrade | Why |
|---|---|---|
| `src/services/opencode/sessions.ts` — `OpenCodeSessionBinding`, `ensureOpenCodeSessionInner` | Add `reusedExistingSession: boolean`; `true` only on the verified live-adoption branch, `false` on create and stale replacement | The backend already makes this decision; exposing it is a return-value extension, not a second resume path |
| `src/services/opencode/sessions.ts` | Add read-only `getOpenCodeSessionActivity(conversationId, sessionId)` | Session lifecycle already owns `conversationService`, `resolveConversationWorkspace`, `openCodeServerManager`, `createOpenCodeClient`, `logger`, and `classifyError`; no new backend module is needed |
| `src/routes/opencode.ts` | Extend `/session` with the reuse flag; add `POST /session/activity` in the same route module | The route module already owns `/session` and `/session/terminate`; reuse `openCodeError`/`classifyError` |
| `src/lib/validation.ts` | Reuse the existing `opencodeSessionId` constraints through a named schema; add `openCodeSessionActivitySchema` | Avoids a second inline Zod schema and keeps the id limits in one place |
| `web/src/features/opencode/v2Events.ts` | Extend the existing `session.retry.scheduled` case; add `session.status`; extend existing execution, idle, text/step, interruption, connection and load cases; add activity revision handling | The reducer already owns retry parts and lifecycle; no second event consumer |
| `web/src/features/opencode/v2ThreadController.ts` | Extend `hydrate()` with a non-blocking activity check; capture the activity revision; distinguish connection and refresh loads | The controller already owns hydration, reconnect, generation and abort guards |
| `web/src/features/opencode/useOpenCodeRuntime.ts` | Pass `conversationId` and the activity fetcher into the existing controller creation | No new runtime, hook, or store |
| `web/src/features/opencode/sessionBootstrap.ts` | Extend the existing bootstrap result with `reusedExistingSession`; add `fetchOpenCodeSessionActivity` to the same session HTTP module | This module already owns the `/api/opencode/session` HTTP family, `apiFetch`, and `logger`; no second session API client |
| `web/src/features/opencode/OpenCodeView.tsx` | Extend the existing `sessionId`/`eventDirectory` state with the reuse flag; add the new surfaces to the existing `aboveComposerExtra` | No new page, route, dialog, or ChatWindow slot |
| `web/src/features/opencode/statusView.ts` / `OpenCodeStatus.tsx` | Add a `retrying` presentation/branch; include confirmed activity in `running`; extend `HEARTS` | The status chip is the existing single mapping; no second status engine |
| `V2ThreadState` (already exposed through `V2RuntimeExtras.state` and `aboveComposerExtra`) | Add `retry`, `activity`, `activityRevision`, and the `load_started` reason to the existing state; the extras interface and composer slot already expose what is needed | No new context, extras field, or surface; `v2RuntimeExtras.ts` itself does not change |
| Existing `inboxById` + `auxiliary` hydration | Use the existing queued/steer records and the existing availability state for the restoration notice | No second inbox request; respects queued vs steer |
| `apiFetch`, `logger`, `V2SafeError`, `mapEventError`, `classifyError`, `openCodeError` | Reuse | No parallel transport, error mapper, or logger |

**No — these should not be reused or upgraded for this feature:**

| Existing thing | Decision | Why |
|---|---|---|
| Browser proxy allowlist / frontend V2 client | Do **not** add `session.active` | It returns the unfiltered active-session map; that is the security boundary this plan protects. Use only the backend-filtered activity endpoint |
| `web/src/components/composer/ComposerAlerts.tsx` | Do **not** reuse | It is the Direct-chat composer's inline error/recovery row, with Direct-chat props and a different boundary; the OpenCode retry banner is feature-owned |
| `auxiliaryNotice.ts#pendingSetNotice` | Do **not** reuse the function | It reports stale pending reads, not restored-session evidence; only its pure-copy pattern may be borrowed |
| `OpenCodeSessionRow` / `OpenCodeModelChip` / `OpenCodeAgentChip` | Do **not** put them in the banner | They are a full identity row and interactive pickers, not a small status mark. The banner shows retry text only; no second model/agent resolver |
| `fetchOpenCodeSession` | Do **not** use it as the activity check | It answers "does the server still know this session", not "does the server currently hold an active drain"; its 404 liveness rules are different |
| `ensureOpenCodeSession` | Do **not** call it from the activity endpoint | It creates a session when none exists; the activity read must be read-only |
| `GET /session/status` (older docs) | Do **not** hand-roll or add a second client | No supported status-snapshot request was found in the installed 2.1.2 surface; use the live `session.status` event instead |
| `formatDuration` (tool/scheduler) | Do **not** cross-import | The two existing formatters intentionally differ; the retry countdown is a feature-local pure formatter with its own test |
| assistant-ui `ErrorPrimitive` / `AuiIf` / `ThreadPrimitive` | Do **not** use one as the retry or restoration state owner | None represents OpenCode retry attempt/deadline or verified session reuse. `ErrorPrimitive` is for runtime/message errors; `AuiIf` only mirrors assistant-ui thread state; `ThreadPrimitive` has no status member (see §1.3) |

**Net new files:** only the two feature UI components and their tests. No new
backend module, frontend API module, runtime, store, persistence layer, database
migration, or dependency.

### 1.2 Official OpenCode API/docs review

1. **Official V2 HTTP API: `GET /api/session/active` (operation `session.active`)**
   Source: <https://opencode.ai/v2/docs/api>. The official description is:

   > "Retrieve foreground Session drains currently owned by this OpenCode process.
   > Sessions absent from the result are inactive."

   This confirms:
   - `session.active()` is a **global map**, not a session-scoped request.
   - `not-running` is authoritative only **for the current server process**; it does
     not prove that no queued prompt or scheduled retry exists.
   - A backend-owned, session-filtered endpoint is the right integration; the raw map
     must not reach the browser.

2. **Installed official client is `@opencode/client` 2.1.2.**
   Its generated types expose:
   - `session.active()` → `Record<SessionID, { type: "running" }>` → `/api/session/active`
   - `SessionStatus` = `idle | busy | retry { attempt, message, action?, next }`
   - event literal `session.status` (generated alias name: `SessionStatusUpdated`)
   - the retry record written by `session.retry.scheduled` =
     `{ assistantMessageID, attempt, at, error }`
   - `SessionExecutionInterrupted.reason` = `user | shutdown | superseded | inactivity`

3. **Compatibility of `session.active` is not a version-absence problem.**
   The official OpenCode server handlers for versions `2.0.15`, `2.0.22`, and
   `2.1.2` include `session.active`. The supported range here is
   `>=2.0.15 <2.2.0`.

   Consequences:
   - Do **not** add a version gate that assumes supported 2.0.x releases lack the
     operation.
   - Do **not** claim "2.0.x may not have the endpoint" without evidence for a
     specific version.
   - Still treat any actual request failure (network, auth, 404/405 from an
     unsupported future server, malformed response) as `unknown`, never as idle.
   - Keep the map behind the backend's session-filtered endpoint.

4. **No supported status-snapshot request was found in the installed 2.1.2 surface.**
   The older server docs list `GET /session/status`, but the installed 2.1.2 client
   has no `session.status` method and the installed 2.1.2 server binary contains
   `session/active` but not `session/status`. Therefore:
   - We will **not** build a status-snapshot restore path.
   - The exact retry countdown is **not** recovered after a reconnect. A live event
     is used only while it is observable; the activity notice supplies activity/queue
     evidence, not a retry deadline. No countdown is fabricated. This remains the
     allowed limitation.
   - We will not hand-roll raw HTTP or add a second client to reach an endpoint outside
     the installed official surface.

5. **Official v2 API documents the persisted retry shape.**
   `Session.Message.Assistant.Retry` has `attempt` (`integer > 0`), `at` (`number`), and
   `error`. The live event's `at` and the status event's `next` are absolute epoch-ms
   deadlines; the packaged reference maps `next: data.at`. We will use the installed
   types and the reference-verified mapping, not infer a unit from the field name.

6. **The `session.status.updated` literal in TBAi's allowlist is dead.**
   The real wire event is `session.status`; the generated alias name is misleading.
   We will add `session.status` and remove the dead literal. The live retry sources
   remain `session.retry.scheduled` and `session.status`; the durable record the
   former writes preserves the attempt in history but is not a scheduled wait.

7. **`reusedExistingSession` is a reuse fact, not a restart fact.**
   The backend sets it only when an existing live session was verified and adopted.
   It says nothing about whether the application restarted, crashed, or was merely
   navigated back to. The UI copy and tests must not infer a restart.

### 1.3 Assistant-ui element review (online and installed package)

Studied:

- <https://www.assistant-ui.com/llms.txt> (agent documentation index)
- <https://www.assistant-ui.com/docs/primitives/thread.md>
- <https://www.assistant-ui.com/docs/api-reference/primitives/assistant-if.md>
- <https://www.assistant-ui.com/docs/api-reference/primitives/error.md>
- <https://www.assistant-ui.com/elements/thread.md>
- Installed `@assistant-ui/react` 0.15.30 (`node_modules/@assistant-ui/react`)

Findings:

- `ThreadPrimitive` exports `Root`, `Empty`, `If`, `Viewport`,
  `ViewportProvider`, `ViewportFooter`, `Messages`, `MessageByIndex`,
  `Unstable_MessageById`, `Row`, `ScrollToBottom`, `LoadEarlier`, `Suggestion`,
  `Suggestions`, and `SuggestionByIndex`. **There is no `Status` member and no
  retry primitive.**
- `AuiIf` is the current conditional primitive and replaces the deprecated
  `ThreadPrimitive.If`. It can read `s.thread.isRunning`, `s.thread.isEmpty`, and
  similar assistant-ui runtime state. It cannot read OpenCode retry attempt,
  deadline, or verified session reuse.
- `ErrorPrimitive` renders assistant-ui runtime, thread, or message failures. A
  scheduled retry is not an error, and the retry banner is not inside a message
  error context.
- The assistant-ui `Thread` element is a complete chat surface (message list,
  composer, welcome/running/history-loading states). Replacing TBAi's shared
  `ChatWindow` with it would change the application surface and violate the
  existing ownership boundary; it is not an appropriate component for one
  OpenCode-only status row.

**Decision:** introduce **no** new assistant-ui element or dependency. Keep the
retry banner and the session-restoration notice feature-owned and render them in
the existing `aboveComposerExtra` slot. This is justified by a real capability
gap: assistant-ui has no retry/restoration state, and mapping OpenCode retry into
assistant-ui thread state would create a second source of truth. If a generic
assistant-ui running/empty condition is ever needed, use `AuiIf` only as a
supplementary condition; never as the retry source. Do not use `ErrorPrimitive`
for retry.

### 1.4 What is persisted, and what does that prove?

Short answer, with the evidence inventory in §4:

- **TBAi owns identity.** `DATA_DIR/chat.db` stores the conversation row,
  `engine`, and `opencode_session_id`. That is enough to find the OpenCode
  session again, but it is not a transcript and not an execution journal.
- **OpenCode owns recovery data.** Its own resolved OpenCode database (see §4.2)
  stores the session row, `session_message` history, `session_inbox` pending
  input, retry records, and the `session_v2.time_suspended` execution claim.
- **A verified `session.get` proves the session exists**, not that the app
  restarted, not that history will load, and not that an interrupted turn
  resumed. `reusedExistingSession` therefore remains a reuse flag only.
- **The claim is not a resume promise.** OpenCode's automatic restart sweep is
  installed only for service-mode servers; TBAi runs default-mode `serve`.
  After an OpenCode process death, a claim can remain without any process that
  will continue it.

---

## 2. What the user sees

### A. Live prompt retry

- A slim banner directly above the composer:
  **Retrying in 5s (attempt 2)**.
- The countdown is recomputed from the absolute deadline every 500 ms; there is no
  invented deadline when the field is missing or invalid.
- When the attempt starts, the retry ends, or the connection leaves `connected`
  (or a new connection attempt starts), the banner disappears. A later retry shows
  the newer attempt. A bare transition to `connected` does not clear by itself.
- An ordinary successful history refresh does **not** hide a still-active retry.
- If retrying is confirmed but the deadline is unknown:
  **Retrying (attempt 2)**, with no countdown.
- No retry → the component renders `null`; no permanent empty banner.
- Screen reader: one polite announcement per attempt (“Retrying, attempt 2”); the
  changing seconds are outside the announced live text.
- During disconnection/reconnection no stale countdown is shown. The status chip keeps
  its Reconnecting presentation. After reconnect, no countdown is restored; the
  restoration notice reports activity/queue evidence instead.
- The historical retry part remains in the transcript exactly as today.

### B. Session-restoration notice (explicit product decision)

This is a **session-restoration notice**, not a crash or restart detector.

The notice **appears on every verified live reuse**, including ordinary navigation
back to an existing conversation or tab, and it is **not suppressed by a live retry**.
The retry banner and the restoration notice may render together. That is deliberate:
the backend flag proves that an existing session was verified and adopted. It does
not prove that the application restarted. A restart-only notice would require
separate lifecycle tracking, which this plan does not add.

| Verified evidence | Copy |
|---|---|
| Activity `running`, inbox `current` with a queued user prompt | “Previous session restored — a run is still in progress, and a prompt is waiting to run.” |
| Activity `running`, no confirmed queued prompt | “Previous session restored — a run is still in progress.” |
| Activity `not-running`, inbox `current` with a queued user prompt | “Previous session restored — a prompt is waiting to run.” |
| Activity `not-running`, no confirmed queued prompt | “Previous session restored.” |
| Activity `unknown`, inbox `current` with a queued user prompt | “Previous session restored — a prompt is waiting to run.” |
| Activity `unknown`, no confirmed queued prompt | “Previous session restored.” |
| Newly created session (`reusedExistingSession: false`) | No notice |

- Dismissible; auto-hides after the configured duration; component-local state with
  effect cleanup.
- The notice is keyed by `sessionId`. Dismissal is not persisted across mounts, so a
  new verified reuse after a remount can show it again. This is also deliberate and
  must be covered by a test.
- A live retry banner does not suppress the restoration notice; both surfaces may be
  visible, with the retry banner closest to the composer.
- “Queued prompt” means a user inbox record with `delivery === "queue"`, and only when
  `state.auxiliary.inbox === "current"`. If the inbox read is `"unavailable"`, no
  record counts as confirmed queued, even when stale records remain in `inboxById`.
  Steer items are not “waiting”; an incomplete assistant message is never evidence.
- If activity is unknown, the notice never says “no run” or “idle”. It may say only
  “Previous session restored” or the confirmed queued-prompt sentence.
- The notice is about verified **session identity**, not transcript delivery. If
  the history read fails, the transcript's own error remains visible and the
  notice must not claim that history was loaded or that the run is healthy.
- The notice must never say “recovered from a crash”, “restarted”, or “the app was
  reopened”. Those facts are not established by the reuse flag.

### C. Status chip

- During an engine retry: **Retrying (attempt 2)**, a distinct presentation from
  Reconnecting.
- The retry branch comes after terminal failure/recovery/load errors and
  disconnection, and before “loading/reconciling/working”. Thus an ordinary refresh
  with `load: loading` still shows Retrying rather than hiding the retry.
- Terminal transport failure keeps its existing manual Reconnect control.
- If the server confirms the session is running but client execution is idle after
  hydration, the chip shows **Working**, not Connected/Idle.
- `statusView.attempt` remains the reconnect attempt only; it is not overloaded with
  the engine retry attempt.

---

## 3. State and lifecycle

### 3.1 Single live retry representation

`web/src/features/opencode/v2Types.ts`:

```ts
export interface V2RetryInfo {
  readonly attempt: number;
  /** Absolute epoch-ms deadline, or null when the server gave no trustworthy value. */
  readonly next: number | null;
  readonly error: V2SafeError;
}

export type V2ActivityState = "running" | "not-running" | "unknown";
```

Add to `V2ThreadState`:

```ts
readonly retry: V2RetryInfo | null;
readonly activity: V2ActivityState;
readonly activityRevision: number; // starts at 0
```

The historical `retry` message part is unchanged and is not used as live state.
The countdown is derived from the absolute deadline. TBAi persists **no**
countdown of its own and does not rebuild live retry state from history; the
OpenCode retry record may contain a deadline, but it is not a scheduled wait
after a reconnect or process death. A reload/reconnect alone does not recover
exact remaining time; a new live retry event can establish a new live retry.

Add these controller actions:

```ts
| { readonly type: "load_started"; readonly reason: "connection" | "refresh" }
| {
    readonly type: "activity_resolved";
    readonly activity: V2ActivityState;
    readonly revision: number;
  }
```

`hydrate()` dispatches `{ type: "load_started", reason: "connection" }`.
`refresh()` dispatches `{ type: "load_started", reason: "refresh" }`.
Those are the two current call sites; if implementation discovers another, it must
be classified and tested rather than defaulted to either reason.

Retry is event-driven; there are no parallel retry actions.

### 3.2 Event/lifecycle table

`activityRevision` increments **only** on the authoritative activity, retry,
connection, and load rows below. An event that does not establish activity does not
invalidate an in-flight activity snapshot.

| Event/transition | Retry | Activity | Revision |
|---|---|---|---|
| `session.retry.scheduled` | Set from `attempt`, `at`, `mapEventError(error)`; keep the historical part | `unknown` | +1 |
| `session.status` with `retry` | Set from `attempt`, `next`, safe message-derived error | `unknown` | +1 |
| `session.status` with `busy` | Clear | `running` | +1 |
| `session.status` with `idle` | Clear | `not-running` | +1 |
| `session.execution.started` (event or controller action) | Clear | `running` | +1 |
| `session.text.started` / `session.step.started` | Clear | `running` | +1 |
| `session.execution.succeeded` | Clear | `not-running` | +1 |
| `session.execution.failed` | Clear | `not-running` | +1 |
| `session.execution.interrupted` — **all reasons, including `shutdown`** | Clear | `unknown` | +1 |
| `session.idle` | Clear | `not-running` | +1 |
| `connection_changed` to a non-connected state | Clear | `unknown` | +1 |
| `connection_changed` to `connected` | No direct change | No direct change | No change |
| `load_started` with `reason: "connection"` | Clear | `unknown` | +1 |
| `load_started` with `reason: "refresh"` | **Preserve** | **Preserve** | No change |
| `load_failed` | **Preserve** | **Preserve** | No change |
| `load_completed` | Preserve | Preserve | No change |
| `session_hydrated` / history loaded | Preserve | Preserve | No change |
| Any unrelated event | Preserve | Preserve | No change |

**Why these rules:**

- **Proven retry ended:** `session.status busy/idle`, `execution.started`,
  `text.started`, `step.started`, `execution.succeeded/failed`, and `session.idle`
  are authoritative evidence that the retry wait is over or work has resumed.
- **Connection-invalidated countdown:** leaving `connected` for
  `waiting-for-server`, `reconnecting`, `failed`, or `closed` invalidates the
  countdown, and a new connection attempt (`load_started` with
  `reason: "connection"`) does so even if the prior connection state was not
  observed. `connected` alone does not clear; the paired connection attempt owns
  that transition.
- **Interruption:** `session.execution.interrupted` does not prove a retry remains
  scheduled. Clear retry on every reason, including `shutdown`. Set activity to
  `unknown`: the event does not establish that the session is idle (a `superseded`
  run may already have a successor) or that it is still alive. If work resumes, a
  later `execution.started`, text/step start, or `status busy` establishes
  `running`; `session.idle` or `status idle` establishes `not-running`. Do not claim
  the run remains alive because the reason is `shutdown`.
- **Ordinary refresh:** `load_started` with `reason: "refresh"` is history repair,
  not evidence that retry ended or that the connection changed. It preserves both
  retry and activity. A failed ordinary refresh (`load_failed`) also does not by
  itself clear retry; a real connection transition owns invalidation.
- **Hydration:** `session_hydrated`, `history_loaded`, and `load_completed` are not
  retry/status evidence. They preserve retry.

**Other retry rules:**

- **Lower attempt guard:** if `attempt < state.retry.attempt`, ignore the update
  entirely: do not change retry, activity, or `activityRevision`. Equal attempt
  updates the deadline/message; a higher attempt replaces. Terminal events clear
  first, so a new run's attempt 1 is accepted.
- **No history restore:** do not rebuild a countdown from the persisted retry part or
  event-log replay. The prompt permits the post-reconnect timing limitation.
- `next` is accepted only when finite and positive; otherwise `null`.
- The banner is also gated on `connection.type === "connected"` defensively.

### 3.3 Activity reconciliation and stale-response guard

Generation/liveness checks alone are insufficient: two authoritative events and an
activity response can all belong to the same generation. The ordering marker closes
that gap inside the existing reducer.

**State helper (conceptual):**

```ts
function withActivity(
  state: V2ThreadState,
  activity: V2ActivityState,
): V2ThreadState {
  return {
    ...state,
    activity,
    activityRevision: state.activityRevision + 1,
  };
}
```

Every §3.2 row that establishes or invalidates activity uses `withActivity`. A row
that also changes retry/execution composes those changes with it.

**Reducer guard:**

```ts
case "activity_resolved":
  // Accept only the snapshot taken at the current activity revision.
  // A newer authoritative event has already established newer state.
  if (action.revision !== state.activityRevision) return state;
  return { ...state, activity: action.activity };
```

**Controller rule:**

1. After the hydration history commit and buffer drain (`load_completed`),
   capture `const revision = state.activityRevision` immediately before
   starting the read. Starting after the drain means a retry event buffered
   during hydration has already been applied; it cannot remain invisible while
   an older activity response is accepted.
2. Start the existing non-blocking activity fetch with the existing generation,
   liveness, and abort signal.
3. If the generation/liveness guard fails, do not dispatch.
4. Otherwise dispatch `activity_resolved` with the captured `revision`.
5. If an authoritative activity, retry, connection, or load event arrived while
   the request was in flight, it incremented `activityRevision`; the response's
   revision is older and the reducer discards it.
6. If a later authoritative event arrives after the response, it updates activity
   and increments the revision, so the snapshot does not remain stale for the
   lifetime of the connection.
7. A failed lookup dispatches `unknown` with the same revision guard. It never
   becomes idle, and it cannot overwrite a newer event because its revision is
   stale.

This adds **no** second runtime, polling loop, or event log. There is one activity
read per hydration, and the existing event pipeline keeps it current.

### 3.4 Authoritative activity endpoint

**Backend** (`src/services/opencode/sessions.ts`, existing session service):

- Add read-only `getOpenCodeSessionActivity(conversationId, sessionId)`.
- Read the conversation with `conversationService.get`.
- Require `engine === "opencode"` and `conversation.opencodeSessionId === sessionId`;
  a mismatch is rejected before any OpenCode request (404 from the route).
- Reuse `resolveConversationWorkspace`, `openCodeServerManager.ensureBaseUrl`, and
  `createOpenCodeClient` with the resolved directory.
- Call the official `client.session.active()`, then read only `active[sessionId]`.
- Return `"running"` when the entry is `{ type: "running" }`; `"not-running"` when
  the session is absent; `"unknown"` when the active call fails.
- `session.active` is present in the official handlers for `2.0.15`, `2.0.22`, and
  `2.1.2`; do not turn those versions into an absence case. Any runtime failure
  (including a future unsupported endpoint) still returns `unknown`.
- Never return or log the map. Catch upstream failure, log with `classifyError`, and
  return `unknown`.

**Route** (`src/routes/opencode.ts`):

- Register `POST /session/activity` **before** the OpenCode proxy catch-all; add a
  route-order test proving TBAi handles it and `session.active` remains unproxied.
- `POST /session/activity` with `{ conversationId, sessionId }`.
- Zod schema in `src/lib/validation.ts`; reuse the existing id constraints.
- Invalid input → 400. Invalid conversation/session pair → 404. Valid request →
  `200 { activity }`. No `sessions`/map key.
- Reuse `openCodeError`/`classifyError`.

**Frontend** (`web/src/features/opencode/sessionBootstrap.ts`, existing session HTTP
module):

- Add `OPENCODE_SESSION_ACTIVITY_PATH = "/api/opencode/session/activity"`.
- Add `fetchOpenCodeSessionActivity({ conversationId, sessionId, signal })`.
- Return `"unknown"` on non-OK, malformed body, abort, or network failure; never throw
  into hydration. Log at debug/warn without secrets.

**Controller** (`web/src/features/opencode/v2ThreadController.ts`):

- Extend `createV2ThreadController` with optional deps:
  `conversationId` and an activity fetcher.
- After `load_completed` and the hydration buffer drain, start the activity check
  without awaiting it; use the existing generation/liveness guard and abort signal.
- Capture `state.activityRevision` and pass it in `activity_resolved` as described
  in §3.3. If hydration fails, leave activity `unknown`; do not start a stale check.
- On failure, dispatch `activity_resolved` with `"unknown"` and the captured revision.
- `load_completed` is never blocked by the activity check. Because the check starts
  after `load_completed`, a slow or failed activity request cannot delay or fail the
  conversation load; it only settles `activity` (or leaves it `unknown`).
- `useOpenCodeRuntime` supplies the deps from the existing `conversationId`.

**Semantics:**

- `running` = the server currently holds an active drain. It does **not** prove the
  engine is retrying; only retry events/status set the banner.
- `not-running` = absent from this process's active map. It does **not** mean “no work
  exists”; a durable execution claim, an orphaned server, or a queued inbox row can
  coexist with it. It never triggers a resume and is not an all-clear.
- `unknown` = the check could not establish a result; never treated as idle.
- Activity is a read, not a resume control. A `running` result means this server
  process owns the drain; it does not prove an interrupted turn was resumed.
- The backend endpoint is the only browser path to `session.active`. The global map
  stays server-side.

### 3.5 Honest reuse flag and restoration notice

`src/services/opencode/sessions.ts`:

- Add `reusedExistingSession: boolean` to `OpenCodeSessionBinding`.
- Verified live adoption returns `true`.
- New creation and stale-pointer replacement return `false`.
- The singleflight map and existing persisted-pointer behavior are unchanged.

`src/routes/opencode.ts`:

- `/session` returns `{ sessionId, directory, reusedExistingSession }`.

`web/src/features/opencode/sessionBootstrap.ts`:

- Extend `OpenCodeSessionBootstrapResult`; parse `data.reusedExistingSession === true`
  (strict boolean; absence is false).

`web/src/features/opencode/OpenCodeView.tsx`:

- Store the flag beside `sessionId`/`eventDirectory`; set it atomically from the
  bootstrap result.
- Pass it to `AgentRuntime`.
- Render `OpenCodeRecoveryNotice` and `OpenCodeRetryBanner` in the existing
  `aboveComposerExtra`, after `OpenCodeQuestions`; banner last (closest to composer).
- Key the notice by `sessionId` so dismissal state resets per session.
- **Product decision:** a normal navigation back to an existing conversation goes
  through verified reuse, so the notice is shown there too. Do not add boot-id,
  crash-detection, or restart heuristics to narrow it. The flag is evidence of
  reuse, not of a restart.

No auto-resubmit, no automatic execution resume, and no claim of continuation
merely because a durable execution claim survived. The claim is evidence that a
turn was in flight; in TBAi's default-mode `serve` it has no automatic resumer.

### 3.6 UI details

**`OpenCodeRetryBanner.tsx`** (new, feature-owned):

- Reads `useOptionalV2RuntimeExtras()`.
- Returns `null` when no retry or connection is not connected.
- Local 500 ms interval only when `next` is known; cleanup on unmount/dependency change.
- `remaining = Math.max(0, Math.ceil((next - now) / 1000))`.
- Visible copy equivalent to “Retrying in 5s (attempt 2)”; when the deadline is unknown
  or passed, “Retrying (attempt 2)”.
- Accessible structure: stable `role="status"` text for the attempt; the changing
  countdown is `aria-hidden`. No tick announcements.
- Theme tokens only; no inline styling; no empty wrapper.

**`OpenCodeRecoveryNotice.tsx`** (new, feature-owned):

- Props: `reusedExistingSession`, `sessionId`.
- Reads activity and inbox from extras.
- Returns `null` only if not reused; an active retry does not suppress it.
- `queued` is true only when:
  - `state.auxiliary.inbox === "current"`, and
  - there is a record with `type === "user"` and `delivery === "queue"`.
  `"unavailable"` never confirms a queue, even if stale records remain.
- Copy follows the table in §2B; unknown activity never becomes “not running”.
- `useState` visible/dismissed; timeout in `useEffect`; cleanup on unmount.
- `role="status"`; dismiss button with an accessible label; theme tokens.
- Because dismissal is component-local and keyed by `sessionId`, ordinary navigation
  that mounts the view again can show the notice again. This is the documented product
  decision, not a bug.

**`statusView.ts` / `OpenCodeStatus.tsx`**:

- Add `"retrying"` to `StatusPresentation`; add `retrying` to `HEARTS` (reuse
  `HeartPulse`/amber; the label, not the icon, distinguishes it from reconnect).
- Add a `retry` argument; branch after terminal failure/recovery/load errors and
  disconnection, before “loading/reconciling/working”.
- Label: `Retrying (attempt ${retry.attempt})`; `attempt` remains `null`;
  `canReconnect: false`; `failed: false`.
- `OpenCodeStatus` passes `state.retry ? { attempt: state.retry.attempt } : null`.
- `running` includes `state.activity === "running"`, so a confirmed active run does not
  render as Connected.
- Add `retry: null` / `activity: "unknown"` / `activityRevision: 0` to the fallback
  state.
- Do not remove or hide the terminal-failure Reconnect control.

**Config** (`web/src/features/opencode/config.ts`):

- `OPENCODE_RETRY_TICK_MS = 500`
- `OPENCODE_RECOVERY_NOTICE_MS` (one named duration; e.g. 12_000)
- Small local countdown formatter with constants for seconds/minutes/hours; do not
  import the scheduler/tool formatters.

**assistant-ui placement**:

- The two new surfaces stay in `aboveComposerExtra`; no change to `ChatWindow.tsx`,
  the assistant-ui runtime, or its message/tool rendering.
- Do not introduce `ErrorPrimitive`, `AuiIf`, or a wrapping assistant-ui `Thread`
  element for these surfaces. The feature owns retry/reuse state (see §1.3).

---

## 4. Persistence, identity, and crash recovery

### 4.1 Evidence scope and labels

This section answers four separate questions that must not be conflated:

1. **Conversation restoration** — can TBAi reopen the same conversation row?
2. **Session identity recovery** — can TBAi find the same OpenCode session?
3. **Current-activity determination** — does the current OpenCode process hold an
   active drain for that session?
4. **Execution resumption** — is an interrupted turn actually continued?

A “yes” to an earlier question does not imply a “yes” to a later one. In particular,
activity is a process-local snapshot, not a resume signal.

**Scope:** branch `029229e`; installed `opencode` 2.1.2; OpenCode source tags
`v2.0.15`, `v2.0.22`, and `v2.1.2` (the supported range is `>=2.0.15 <2.2.0`);
Windows host. No application test suite was run for this revision. Evidence is
source/config reading plus read-only database and `opencode debug paths`
inspection.

| Label | Meaning here |
|---|---|
| **Verified** | Read directly from TBAi code/config, the selected OpenCode tag, or an actual database/CLI output |
| **Inferred** | Follows from verified code or file format, but was not executed end-to-end in this revision |
| **Unknown** | Needs a process-level test or platform-specific check; do not build acceptance copy on it |

### 4.2 Persistence inventory

| Data | Owner | Persisted where | Mechanism | Evidence | Recovery meaning |
|---|---|---|---|---|---|
| Conversation row: id, title, `engine`, workspace, model/agent, `opencode_session_id` | TBAi | `DATA_DIR/chat.db`, table `conversations` | SQLite via `bun:sqlite`; idempotent column migration | **Verified** — `src/db/index.ts:288-292`, `src/services/storage/conversations.ts:38,90-91,153-164` | Finds the conversation and its session pointer. Not a transcript or execution journal |
| Direct-chat messages | TBAi | `DATA_DIR/chat.db`, table `messages` | SQLite | **Verified** — `web/src/adapters/threadHistoryAdapter.ts:178-182,334-339` skips OpenCode rows | Direct history only. OpenCode messages are never written here |
| OpenCode session row: id, directory, parent, title, model, `time_suspended`, `resume_attempts` | OpenCode | OpenCode database (resolved path; see below), table `session_v2` | SQLite; `time_suspended` is the execution-claim timestamp | **Verified** — actual 2.1.2 schema and `packages/core/src/session/sql.ts:22-77`; v2.0.15 source has the same table | Session identity, scope, and a durable in-flight claim. The claim is not an auto-resume promise |
| OpenCode transcript | OpenCode | Same database, table `session_message` | Ordered rows (`type`, `seq`, JSON `data`) | **Verified** — `packages/core/src/session/sql.ts:79-98`; actual database | The authoritative history TBAi reads through the official `message.list` operation |
| Pending prompts, queue, steer | OpenCode | Same database, table `session_inbox` | Pending-only rows with `delivery` set to `queue` or `steer`; deleted when promoted or cancelled | **Verified** — `packages/core/src/session/inbox.ts:319-335`, `sql.ts:125-145`; actual database | Pending input survives a process restart. It is not automatically delivered by TBAi |
| Retry record | OpenCode | Same database, `session_message.data.retry` | `session.retry.scheduled` is projected into `{ attempt, at, error }` on the assistant message; the wait itself is `Effect.sleep` | **Verified** — `packages/core/src/session/message-updater.ts:406-413`, `runner/retry.ts:57-76`; the `data` column is JSON in the actual schema. Survival across a process restart and the wait's death are **inferred** | Attempt/error/deadline record survives; exact remaining time and the scheduled wait do not |
| Execution claim | OpenCode | Same database, `session_v2.time_suspended` + `resume_attempts` | Write-ahead claim at turn start; released on success/failure and non-shutdown interruption; preserved for shutdown | **Verified** — `packages/core/src/session/execution.ts:73-83`, `store.ts:197-250` | Evidence a turn was in flight. It is not a crash marker (a graceful shutdown can preserve it) and **not** evidence that TBAi will resume it |
| OpenCode database location | OpenCode | `global.data` = `XDG_DATA_HOME/opencode` or `~/.local/share/opencode`; filename from `databasePath(global.data)` | `OPENCODE_DB` overrides the filename/path. Otherwise stable channels (`latest`, `dev`, `beta`, `next`, `prod`) or `OPENCODE_DISABLE_CHANNEL_DB=1`/`=true` use `opencode.db`; other channels use sanitized `opencode-<channel>.db`; `:memory:` is non-persistent | **Verified** — `packages/util/src/global-roots.ts:4-17`, `packages/cli/src/database-path.ts:4-13`, `packages/cli/src/version.ts:8-26`, `packages/cli/src/server-process.ts:113-115`; `opencode debug paths` | Resolves to `path.resolve(data, filename)`. The actual path on this host is recorded below. A data-root, override, or channel/filename change makes a saved id look missing |
| TBAi backend ownership / port | TBAi | Process memory only; no durable PID/port marker | `serverManager` starts a new child on a new loopback port | **Verified** — `src/services/opencode/serverManager.ts:309-318,411-447`; orphan survival is **unknown** | TBAi does not adopt or reconnect to a previous OpenCode process |

**Critical path distinction (verified):**

- `DATA_DIR` is TBAi's data root; `DB_PATH = DATA_DIR/chat.db`
  (`src/config/data-dir.ts`).
- `OPENCODE_CONFIG.serverHomeDir = DATA_DIR/opencode-home`
  (`src/config/opencode.ts:89`) is only the child's **cwd**.
- `serverManager.createChild` inherits `...process.env`, sets `cwd` and the auth
  environment, and does not set `OPENCODE_DB` or `XDG_DATA_HOME`
  (`src/services/opencode/serverManager.ts:297-305`). It also cannot change the
  binary's compiled `OPENCODE_CHANNEL`, which selects the default filename.
- On this host, `opencode debug paths` reports the resolved `db` path as
  `C:\Users\RTPC\.local\share\opencode\opencode.db` with a clean environment,
  but `D:\Coding\OpenCode\data\opencode\opencode.db` when the inherited
  `XDG_DATA_HOME=D:\Coding\OpenCode\data` is present. The current process
  environment has that value.
- The installed 2.1.2 binary resolves the filename `opencode.db` because its
  channel is in the stable set. A non-stable/local build would resolve
  `opencode-<channel>.db` in the same data root unless `OPENCODE_DB` or
  `OPENCODE_DISABLE_CHANNEL_DB` overrides it.
- Therefore a backup of `DATA_DIR` alone does **not** back up OpenCode history,
  and launching TBAi under a different environment can switch OpenCode stores.

**Packaged-app path (G1, Pass with controlled XDG):** Test 18 was run on
2026-10-23 against the portable build of commit `029229e` (workflow run
39930829361). Two launches used the same isolated XDG environment
(`XDG_DATA_HOME=C:\Users\RTPC\AppData\Local\Temp\opencode\g1-env\data`), and
Sysinternals Handle directly observed the managed OpenCode child holding
`...\g1-env\data\opencode\opencode.db` on both launches. The app, sidecar, and
OpenCode PIDs changed and the OpenCode port changed; the database path did not.
The developer's live XDG store (`D:\Coding\OpenCode\data`, 764 MB) was
deliberately not opened: a running OpenCode process (PID 11392) was writing it,
so a live-XDG launch would test G2's shared-database concurrency, not G1's path
stability. The app's resolution rule is `<XDG_DATA_HOME>/opencode/opencode.db`;
the production XDG value is fixed, so the production path is deterministic.
Evidence: `g1-evidence/launch-{1,2}-summary.json` and
`g1-evidence/launch-{1,2}-handles.txt`.

**G2 ownership finding (2026-10-23):** Test 15 is now covered by a tested
fail-closed path, not an unknown. The managed child’s database path is resolved
with `opencode debug paths db`; a named mutex keyed by the normalized path
serializes TBAi starts; Restart Manager names any existing holder of the DB or
its `-wal`/`-shm` files before the spawn and again after readiness. A foreign
holder is refused and never killed. A missing job makes the sidecar exit; the
shell and backend jobs are kill-on-close. Residual limits: a foreign process that
opens the database after the post-readiness check is outside the boundary; the
`Local\` mutex does not serialize Windows sessions (the Restart Manager checks are
the cross-session guard); a backend-job installation failure degrades the
descendant guarantee. The real-server retry/activity evidence is 2.1.2 only;
2.0.15/2.0.22 database compatibility is covered separately by G4, while their
retry/activity semantics remain unverified. The Rust build and packaged smoke
test passed in CI (Verify 39949223009, commit `7f28c11`), and the packaged
shell hard-kill is recorded in Verify 39951140626 (commit `fe10255`).

`session_pending` also exists in the 2.1.2 schema, but no runtime writer was found
in the inspected 2.1.2 source. The active pending-input store there is
`session_inbox`. Treat `session_pending` as **unknown/legacy**, never as a second
recovery source. This is not a claim about a 2.0.x database that has not been
opened by the test suite.

### 4.3 Six failure scenarios

| Scenario | TBAi state after | OpenCode state after | What TBAi can restore | Resumption / retry |
|---|---|---|---|---|
| 1. WebUI remount or navigation | Row, id, title, workspace/model config | Live session, history, inbox, claim, retry wait all remain in the same process | Same session id; history from OpenCode; current activity; restoration notice on every verified reuse | No interruption; the run and retry wait continue in place |
| 2. TBAi backend crash/relaunch | Row and id survive on disk | If the database path is stable: session, history, inbox, retry record, claim. The old child may or may not survive | Verified reuse when `session.get` succeeds; history; activity from the **new** server process | No automatic resume. An orphan child is not adopted; a new server cannot see its active map |
| 3. OpenCode subprocess crash/restart | Row and id survive | Database rows survive; the live retry wait and active map do not; the claim remains | History; queued/steer rows; activity; no false idle claim | No automatic resume and no automatic retry. A new user turn can run; its terminal event releases the old claim except when the new turn is itself interrupted by shutdown |
| 4. Full app/OS crash or reboot | Row and id survive if disk is intact | Database rows survive if disk is intact; an OS reboot kills all; an app-only crash may leave the same orphan as scenario 2 | Same as 2/3 after cold start: history, identity, pending rows, activity | No automatic resume, no auto retry, no exact countdown; an orphan is unsupported |
| 5. Loss or corruption of storage | `chat.db` lost ⇒ id and mapping lost. Intact ⇒ id survives | Lost/corrupt database ⇒ no history; changed path ⇒ different store | Only when both stores are intact and point at each other | No hidden fallback. A missing session is replaced; a corrupt/unavailable store is an error, unless OpenCode itself recreates it and returns 404, which is an **unknown** ambiguity and still not a restoration |
| 6. Saved id whose session is gone | Row and id remain until the next bootstrap | Authoritative 404, or a non-404 failure | 404 ⇒ new session and new id; other failures ⇒ error, no replacement | No resume. Old history is unavailable; the replacement is not a restoration |

Scenario details that must not be flattened:

1. **WebUI remount/navigation.** This is not a crash. The OpenCode process still
   owns the session, so `session.active` and the history read are meaningful. The
   notice is still shown because `reusedExistingSession` is true; it does not
   imply a restart. A live retry may continue, but the TBAi countdown is derived,
   not persisted.

2. **TBAi backend crash/relaunch.** Tauri restarts the sidecar up to three times
   in 30 seconds (`src-tauri/src/main.rs:449-484`); the backend's shutdown path
   also stops the OpenCode child (`src/server.ts:330-334,468-470`). A crash has no
   such handshake. TBAi allocates a new loopback port and starts a new
   `opencode serve`; it has no persisted PID/port to adopt the old child. Orphan
   survival on Windows is **unknown**. Even if the old child lives, the new
   server's `session.active` map is empty, so `not-running` is not proof that no
   work continues. Two servers on one database are not a supported ownership
   model; TBAi does not merge them. Do not claim recovery or safe concurrent use
   in that case.

3. **OpenCode subprocess crash/restart.** `serverManager` restarts up to three
   consecutive unexpected exits (`src/config/opencode.ts:85`). The new server
   opens the same database and the session id still resolves. The claim remains
   in `session_v2.time_suspended`; it is a durable record, not a resumer. A new
   user turn can run, and its terminal event releases the stale claim unless that
   turn is itself interrupted by shutdown. See §4.4.

4. **Full app/OS crash/reboot.** SQLite durability of the committed rows is
   **inferred**, not proven by this revision; a filesystem that loses recent
   commits can lose the newest rows. No TBAi process survives. A full OS reboot
   also kills OpenCode; an **app-only** crash can leave the same orphan as
   scenario 2, which is unsupported ownership, not recovery. The important
   distinction is that no TBAi process continues a turn or a retry wait. A cold
   start restores conversation/history if both stores are intact; it does not
   restore execution.

5. **Storage loss/corruption.**
   - TBAi `chat.db` lost: the OpenCode database may still contain the old session,
     but TBAi has no conversation-to-session mapping and no registry to search.
     This is **unsupported** and is not repaired by adding history duplication.
   - OpenCode database lost: the id remains but `session.get` returns 404; TBAi
     replaces it with a new session (see scenario 6).
   - OpenCode database corrupt or unreadable: if the server/health path fails, TBAi
     must surface the error and must not create a replacement on non-404 evidence.
     If OpenCode itself starts with a fresh/repaired store and returns 404, TBAi
     cannot distinguish that from a deleted session and will replace the pointer;
     record that as an **unknown** ambiguity, not a recovery. Never claim the old
     history was restored in either branch.
   - OpenCode path changed (`XDG_DATA_HOME`/`OPENCODE_DB`, or a channel-derived
     filename): the old store is not consulted; the saved id 404s and is replaced.
     This is indistinguishable from a genuinely deleted session.
   - Provider credentials are not a recovery input. TBAi's encrypted provider keys
     remain in TBAi storage; OpenCode's own auth/config remains OpenCode-owned.
     This plan neither reads nor duplicates them.

6. **Saved id whose OpenCode session is gone.** Only an authoritative 404 permits
   replacement. TBAi creates a new session, writes the new id, and returns
   `reusedExistingSession: false`; the restoration notice is not shown. A
   transport/auth/500/malformed response must propagate as an error and must not
   authorize replacement or a false notice. If the 404 was caused by a store
   change, the old history is unreachable but not actually deleted.

### 4.4 OpenCode's restart continuity does not run in TBAi's mode

This is a correction to the earlier assumption that a durable claim means the
turn will be resumed.

**Verified for `v2.0.15`, `v2.0.22`, and `v2.1.2`:**

- TBAi starts `opencode serve --port <port>`; it does not pass `--service` or
  `--stdio` (`src/services/opencode/serverManager.ts:20-25`).
- In the CLI, the `start` lifecycle is passed only when `mode === "service"`:
  `serviceOptions === undefined ? undefined : { onListen... }`
  (`packages/cli/src/server-process.ts` in all three tags).
- The server installs `resumeSuspendedSessions` only `if (lifecycle)`
  (`packages/server/src/process.ts` in all three tags).
- Therefore TBAi's managed default-mode server **does not sweep or resume**
  orphaned claims at boot. No public resume route was found in the installed
  2.1.2 client/server surface.

Consequences:

- An in-flight turn that dies with OpenCode remains a durable claim, but no
  process is scheduled to continue it. The UI must not say it resumed. A claim
  can also survive a graceful shutdown, so it is not proof of a crash.
- A queued prompt that was not yet promoted remains in `session_inbox`, but it is
  not automatically delivered after the restart. TBAi does not resubmit it.
- OpenCode's `--service` mode would install its own restart continuity, but it
  also changes ownership to the shared background service and its registration,
  port, and auth model. This plan does **not** switch modes; that is a separate
  lifecycle decision.
- If automatic resumption is later required, it needs an explicit design (service
  mode or a supported resume surface), not an inference from `time_suspended`.

Sources:
<https://github.com/anomalyco/opencode/blob/v2.0.15/packages/cli/src/server-process.ts>,
<https://github.com/anomalyco/opencode/blob/v2.0.15/packages/server/src/process.ts>,
<https://github.com/anomalyco/opencode/blob/v2.0.22/packages/cli/src/server-process.ts>,
<https://github.com/anomalyco/opencode/blob/v2.0.22/packages/server/src/process.ts>,
<https://github.com/anomalyco/opencode/blob/v2.1.2/packages/cli/src/server-process.ts>,
<https://github.com/anomalyco/opencode/blob/v2.1.2/packages/server/src/process.ts>.

### 4.5 What is restorable, and what is not

**Restorable, when the OpenCode database path is stable and intact:**

- The conversation row, title, engine, workspace binding, model/agent settings,
  and `opencode_session_id`.
- The OpenCode session identity and its full transcript.
- Pending queue/steer input as pending rows.
- The retry record (`attempt`, `error`, deadline), but **not** the live wait or
  an exact remaining countdown.
- The durable execution claim as evidence that a turn was in flight, but **not**
  as a promise that it will continue.

A working backup therefore needs **both** `DATA_DIR/chat.db` and the OpenCode
database at the same resolved path. Copying either one alone is incomplete.

**Not restorable through this feature:**

- Automatic continuation of an in-flight turn after the OpenCode process died.
- Automatic delivery of queued prompts after an OpenCode restart.
- An exact retry countdown after a reconnect or process death.
- Reachable history after TBAi's `chat.db` is lost (the OpenCode rows may still
  exist but are not mapped), or after OpenCode's database is lost, corrupted,
  or moved.
- An orphaned OpenCode process's ownership. TBAi does not adopt it, and two
  servers on one database are not a supported ownership model.
- Atomicity of “create OpenCode session” plus “write TBAi pointer” across two
  processes. A crash between them can leave an unreferenced OpenCode session; it
  is harmless disk residue, not something this plan will repair with a second
  registry.

**Current activity is not resumption.** The filtered `session.active` read is a
snapshot for the current server process. `not-running` can coexist with a
durable claim, a queued prompt, or an orphaned server. No activity result causes
a prompt to be sent, a retry to be scheduled, or a turn to be resumed.

### 4.6 Decision on additional persistence

| Candidate | Adopt now? | Reason |
|---|---|---|
| New TBAi table/column for session lifecycle | **No** | `engine` + `opencode_session_id` already identify the session; a second state row would drift |
| Copy OpenCode messages/pending/retry into TBAi | **No** | Duplicate history and a second recovery path; OpenCode is the authority |
| Persist the retry countdown | **No** | The deadline record already exists in OpenCode; the wait is in-process, and a persisted countdown would still not restore the wait |
| Persist activity/current run | **No** | `session.active` is process-local and changes immediately; a stored value would be stale |
| Boot/restart marker | **No** | The notice is deliberately shown on every verified reuse; a marker would not restore execution and would add a second lifecycle state |
| Automatic queue resubmission | **No** | Could duplicate side effects; queued rows are durable and can wait for a real user action |
| Pin the managed OpenCode database under `DATA_DIR` (e.g. `OPENCODE_DB`) | **Not in this plan** | It would materially improve backup and path determinism, but it relocates existing data and needs a one-time migration/approval. Until then, recovery is conditional on a stable path |
| Persist PID/port to adopt or kill an orphan OpenCode process | **Not in this plan** | It is process supervision, not session persistence. It needs its own lifecycle design and platform tests |

**Conclusion:** the existing persistence is sufficient for the honest behavior
this plan specifies: restore the conversation and session identity when both
stores agree; show history only from the authority; show activity as a
process-local read; and never claim execution resumption. No new TBAi schema or
duplicate session registry is justified. The unresolved recovery dependency is
the OpenCode database path, not a missing TBAi column.

**Re-evaluation of earlier decisions:**

- **“No DB migration” still stands for TBAi.** It does not mean there is no
  storage dependency; it means the dependency is OpenCode's database and must be
  documented, tested, and kept stable.
- **“No exact retry countdown after reconnect” still stands for the pre-reconnect
  wait, and is stronger.** After OpenCode process death there is no wait to count
  down. A durable retry record is not a scheduled retry. A new live event may
  establish a new live retry; that is not a restored countdown.
- **“Notice on every verified reuse” still stands.** There is no restart marker,
  and reuse does not prove a restart. Do not narrow it to crash-only.
- **`reusedExistingSession: true` only on verified live adoption; stale
  replacement returns `false`.** The notice must not appear for the replacement.
- **No automatic resubmission** remains, and is extended to **no automatic
  execution resumption** in TBAi's default-mode server.

## 5. File plan

### Backend

| File | Change |
|---|---|
| `src/services/opencode/sessions.ts` | `OpenCodeSessionBinding.reusedExistingSession`; add read-only `getOpenCodeSessionActivity`; reuse existing client/workspace/error helpers |
| `src/routes/opencode.ts` | Include the flag in `/session`; add `POST /session/activity` **before the proxy catch-all**; reuse error mapping |
| `src/lib/validation.ts` | Extract/reuse `opencodeSessionId` constraints; add `openCodeSessionActivitySchema` |
| `src/services/opencode/proxyRoutes.ts` | **No change**; `session.active` remains unproxied |

### Frontend

| File | Change |
|---|---|
| `web/src/features/opencode/v2Types.ts` | `V2RetryInfo`, `V2ActivityState`, `retry`, `activity`, `activityRevision`, `load_started.reason`, `activity_resolved.revision` |
| `web/src/features/opencode/v2Events.ts` | `session.status`; remove dead `session.status.updated`; retry lifecycle; attempt guard; activity revision/update; connection-only retry invalidation; all-reason interruption |
| `web/src/features/opencode/v2ThreadController.ts` | `load_started` reasons in `hydrate`/`refresh`; non-blocking activity check; capture/dispatch activity revision; deps; generation/abort guard |
| `web/src/features/opencode/useOpenCodeRuntime.ts` | Pass conversation id and activity fetcher |
| `web/src/features/opencode/sessionBootstrap.ts` | Reuse flag in result/parser; activity endpoint client |
| `web/src/features/opencode/OpenCodeRetryBanner.tsx` | New banner; feature-owned |
| `web/src/features/opencode/OpenCodeRecoveryNotice.tsx` | New restoration notice; feature-owned |
| `web/src/features/opencode/OpenCodeView.tsx` | Reuse flag; compose both components in `aboveComposerExtra`; notice on every verified reuse |
| `web/src/features/opencode/statusView.ts` | `retrying` branch with precedence over load-in-progress |
| `web/src/features/opencode/OpenCodeStatus.tsx` | Retry/activity wiring; `HEARTS` |
| `web/src/features/opencode/config.ts` | Tick/notice duration constants |

**No change:** `v2RuntimeExtras.ts`, `v2History.ts`, `ChatWindow.tsx`, Direct Chat,
assistant-ui runtime, database schema or migration, dependencies, and Zustand stores.
There is no new controller, reducer, or parallel state flow; the existing ones are
extended in place.

**Why two new UI files are allowed:** assistant-ui has no retry/status element
(§1.3), and the alternatives would either create a second source of truth or replace
the shared chat surface. The new files are feature UI only, not a generic framework.

---

## 6. Tests

**Scope discipline:** the reducer, controller, and DOM tests below cover state and
presentation only. They are **not** evidence for persistence or crash recovery. The
process-level cases in “Persistence and restart recovery” are evidence for §4, not a
complete acceptance gate; the binding gates in §8 also include the packaged-app path
check. A green reducer suite must not be reported as “crash recovery verified.”

### Reducer/lifecycle

- `session.status` is accepted and interpreted; no unsupported-event diagnostic.
- `session.retry.scheduled` stores attempt, absolute deadline, and mapped error; the
  historical part remains.
- Lower attempt cannot regress and does not bump the activity revision; equal updates;
  higher replaces.
- `session.status busy/idle`, `execution.started/succeeded/failed`, `session.idle`,
  `text.started`, and `step.started` clear retry.
- **`session.execution.interrupted` clears retry for every reason**, including
  `shutdown`; no test asserts preservation on shutdown.
- Interruption sets activity `unknown` (not `not-running` and not `running`); a
  subsequent `execution.started`/`status busy` establishes `running`, while idle
  evidence establishes `not-running`. It never claims the run remains alive.
- **Ordinary refresh:** `load_started` with `reason: "refresh"` leaves an active
  retry and activity unchanged; `load_started` with `reason: "connection"` clears
  retry and sets activity `unknown`.
- `connection_changed` to `reconnecting`/`failed`/`closed`/`waiting-for-server`
  clears retry and activity; `connection_changed` to `connected` alone does not.
- `load_failed`, `load_completed`, `session_hydrated`, and unrelated events do not
  clear retry.
- `activity_resolved` applies only at the current revision.
- An unrelated event leaves retry and activity revision unchanged.
- Dead `session.status.updated` is no longer accepted; the real `session.status` is.
- A historical `session_message.data.retry` record does **not** rebuild live retry
  state after a connection load; it remains a transcript part only.
- A replayed durable `session.retry.scheduled` during hydration does not establish a
  live retry or countdown; only a live event observed after hydration, or a live
  `session.status`, may do so.
- A durable execution claim is not represented as an automatic resume action. No
  reducer path sends a prompt, schedules a retry, or calls a resume API.
- `not-running` with a queued inbox row or an orphaned claim does not trigger work;
  it remains a read-only state.

### Activity race and activity semantics

- A response captured at revision N is discarded after an authoritative event bumps
  the revision.
- A response captured at revision N is accepted when no event intervened.
- A retry event buffered during hydration is applied before the activity request
  captures its revision; it cannot be overwritten by an older activity response.
- A later authoritative event overwrites an accepted snapshot; activity does not
  remain stale for the connection lifetime.
- A failed lookup produces `unknown`, never `not-running`/idle.
- A stale generation/liveness result is discarded even if its revision matches.
- Running, not-running, and failed/unknown lookups are distinct.
- Failed or slow activity does not block hydration, `load_completed`, or conversation
  loading; it only settles `activity` to `unknown` when the result is unavailable.
- Status/execution events update activity as well as retry:
  busy/started/text/step → `running`; idle/succeeded/failed → `not-running`;
  interrupted → `unknown`; retry status/scheduled → `unknown`.
- No polling loop is introduced; one activity request per hydration.

### Backend and security

- Backend returns only the requested session; response has no map/sessions key.
- Mispaired conversation/session is rejected before the active lookup.
- Request failure (network, auth, malformed, unsupported future route) → `unknown`.
- `session.active` is verified present in the 2.0.15, 2.0.22, and 2.1.2 official
  handlers; the test must not assert absence for a supported 2.0.x release.
- `POST /api/opencode/session/activity` is handled by TBAi before the proxy catch-all;
  the request does not reach the upstream allowlist.
- Proxy allowlist test still proves `session.active` is not browser-exposed.
- Verified adoption → `reusedExistingSession: true`; create and stale replacement →
  `false`; transport failure does not report false.

### Persistence and restart recovery (process-level)

These cases must run against a **real `opencode serve`** and a **real TBAi backend**,
using separate OS processes. Cases 1–17 are process-level; case 18 is the packaged-app
manual gate. They may reuse `tests/harness/opencodeRuntimeHarness.ts`
and the stub provider, but destructive cases must set a temporary `DATA_DIR` and a
temporary `OPENCODE_DB` (or isolated `XDG_DATA_HOME`). Never run them against the
developer's live OpenCode database. A DOM or reducer test cannot substitute.

1. **Ordinary remount/navigation.** Create a conversation and session; load history;
   navigate away and back. Assert: same `opencode_session_id`; no second
   `session.create`; history equals the pre-navigation rows; `reusedExistingSession`
   is true; the restoration notice is shown again; a live run/retry remains owned by
   the same OpenCode process.
2. **TBAi backend restart.** With a fixed `DATA_DIR` and `OPENCODE_DB`, create a
   conversation and history, then stop/restart the TBAi backend. Assert: conversation
   row and id survive; `/api/opencode/session` verifies the same session; history
   loads; no duplicate session is created; `reusedExistingSession` is true. If a turn
   was in flight, assert that **no automatic resume** occurs and the UI does not claim
   one. Include the Tauri sidecar restart path if the harness can exercise it.
3. **OpenCode subprocess crash/restart.** Kill the managed child while TBAi stays up.
   Assert: `serverManager` applies its bounded restart; the same database is used; the
   id still resolves; history loads; `session.active` has no entry; the
   `time_suspended` claim may remain; there is no automatic retry and no automatic
   continuation. A later real user turn can run; assert that its terminal event
   clears the old claim (except the shutdown-interruption case).
4. **Cold start after all processes die.** SIGKILL the TBAi backend and OpenCode (this
   simulates app/OS crash, not a literal reboot), then relaunch both against the same
   paths. Assert: conversation, id, pending rows, and history survive; no process
   resumes the old run; no retry countdown is invented; the notice is reuse-only. A
   true OS reboot remains a manual acceptance check, labelled as such.
5. **History availability.** After each restart above, compare the loaded transcript
   to the pre-crash OpenCode rows, including a tool call and an assistant message.
   Assert: history is non-empty and not duplicated; no TBAi `messages` rows appear for
   the OpenCode conversation; a failed history read leaves the transcript error
   visible and never produces a fabricated transcript.
6. **Saved id that is gone (404).** Remove the session from the OpenCode database (or
   launch against an empty database). Assert: `session.get` is authoritative 404; TBAi
   clears/replaces the pointer; a new session is created; `reusedExistingSession` is
   false; no restoration notice; the old history is not shown. Assert the TBAi row is
   updated, not left pointing at the dead id.
7. **Non-404 lookup failure.** Use wrong auth or a controlled 500/malformed body. Do not
   rely on simply stopping the server: `ensureBaseUrl` may start it again. Assert: the
   bootstrap fails with an error; the saved pointer is **not** replaced; no restoration
   notice; no false “not running” state.
8. **Storage path change.** Create a session with `OPENCODE_DB=A`; relaunch with
   `OPENCODE_DB=B` and the same `DATA_DIR`. Record the resolved `db` path from
   `opencode debug paths` in both launches and assert it matches A/B. Assert: the saved
   id 404s in B; TBAi replaces it with a new session; old history is unavailable; no
   fallback searches A and no duplicate registry is consulted.
9. **TBAi database loss.** In a temp `DATA_DIR`, create a conversation and session,
   then remove `chat.db` and restart. Assert: the conversation list is empty; the
   OpenCode database still exists but is not discovered or reattached; the documented
   outcome is “mapping lost”, not a hidden recovery. This case is an expected
   limitation, not a passing recovery test.
10. **OpenCode database loss/corruption.** Missing database ⇒ 404 replacement as in
    case 6. Corrupt/unreadable database: if the server fails, assert the error path
    and no replacement on non-404 evidence; if OpenCode recreates the store and
    returns 404, assert the documented replacement and the absence of a restoration
    notice. No fabricated history in either branch. Use a copied temp database; never
    corrupt the live one.
11. **Queued prompt after restart.** Queue a user prompt while a run is active; verify
    `session_inbox` has a `queue` row. Kill/restart OpenCode. Assert: the row survives;
    `session.active` is empty; no automatic promotion or duplicate prompt occurs; the
    notice reports only a confirmed queued prompt when the inbox read is `current`. A
    subsequent real run may promote it; assert exactly one delivery.
12. **Retry timing limit.** Force a retryable provider failure (controlled provider
    error or stub mode). Confirm a retry record/event. Kill/restart OpenCode during the
    wait. Assert: no countdown is restored from history; no retry is automatically
    rescheduled; the durable record may remain in history but is not treated as a live
    wait; after reconnect the banner is absent unless a new live event establishes one.
    If the test harness cannot force a retry, record this as a manual acceptance case
    rather than claiming it passed.
13. **Cross-process database behavior.** Assert that TBAi `chat.db` and the
    resolved OpenCode database are separate stores: restarting TBAi does not modify
    OpenCode history; restarting OpenCode does not modify the TBAi conversation row;
    no OpenCode transcript is written to TBAi `messages`; `DATA_DIR/opencode-home` is
    not the OpenCode database.
14. **Ambiguous outcomes.** Cover: `session.get` succeeds then OpenCode exits before
    history; activity fetch fails; activity response arrives at a stale revision;
    session creation succeeds but the pointer write is interrupted; OpenCode restarts
    between lookup and prompt. In every case assert an explicit error or `unknown`,
    never a fabricated history, false idle, automatic resubmit, or “recovered” claim.
15. **Orphan process and shared database (platform-dependent).** Kill the TBAi
    backend abruptly. Inspect whether the OpenCode child survives. If it survives:
    (a) assert the new backend does **not** adopt it and does not claim its run;
    (b) start a second server against the same database and test whether both can
    read and write safely; assert either safe refusal/error or no corruption and no
    duplicate ownership. If concurrent access is unsafe and no fail-closed detection
    exists, record the gate as failed and the mode as **unsupported**, not recovery.
    If the platform kills the child, assert that path instead.
16. **SQLite integrity after abrupt termination.** In temporary stores, create a
    conversation, session, message, queued inbox row, and retry record. Kill TBAi and
    OpenCode abruptly without graceful shutdown (on Windows, use forced process
    termination). Reopen `chat.db` and the resolved OpenCode database, then run
    `PRAGMA integrity_check` and table/row checks. Assert expected committed rows are
    readable and no corrupt or duplicate result is reported. Record this as a bounded
    guarantee; it is a process-level simulation, and a literal OS crash or power loss
    remains untested. It does not prove resilience to disk corruption or lost WAL
    state.
17. **Supported-version database matrix.** For `2.0.15` (oldest), `2.0.22` (mid), and
    `2.1.2` (newest available supported), start each exact binary against a copy of a
    representative OpenCode database, use the same TBAi conversation row and session
    id, and run the session lookup, history, and active path. Inspect the before/after
    schema and any migration. Assert the session id and history survive and no
    destructive migration occurs. If a version fails, narrow the supported range or
    block it; do not claim cross-version recovery. If a binary is unavailable, mark
    the gate unverified rather than inventing a result.
18. **Packaged-app path stability (manual unless automatable).** Launch the packaged
    Tauri application multiple times with the same user environment. Record the
    managed child's resolved `db` path (or an equivalent probe using the same
    environment) on each launch. Assert it is identical; if it changes, record the
    gate as failed and do not claim reliable restoration.

### Inbox and restoration notice

- Inbox `current` + empty inbox + activity not-running → plain restoration copy.
- Inbox `current` + queued user record → queued-prompt copy.
- Inbox `unavailable` + no records → no queued claim; plain/activity copy only.
- **Inbox `unavailable` + stale queued records → still no queued claim** (a failed
  read is not an authoritative empty queue, and is not a confirmed queue either).
- Steer records are not “waiting”; incomplete assistant messages are not evidence.
- **Verified reuse after ordinary navigation/remount shows the notice**, including
  while a live retry is active.
- A test documents that this is a reuse notice, not a restart notice; no copy says
  “crash” or “restarted”, and no restart evidence is required.
- New session (`reusedExistingSession: false`) shows no notice.
- **Stale-pointer replacement returns `reusedExistingSession: false` and shows no
  restoration notice**; the UI must not imply the old session was restored.
- A failed history read does not make the notice claim history loaded; the
  transcript's own history-error state remains visible.
- Retry does not suppress the notice; the restoration notice and retry banner can
  coexist.
- Dismiss/timeout work; dismissal is component-local; a remounted verified reuse can
  show the notice again.

### UI

- Known retry renders above the composer with correct attempt/countdown.
- Unknown deadline shows no fabricated countdown; no retry renders nothing.
- An ordinary refresh with retry active keeps the banner visible.
- A connection change hides the banner and shows the existing Reconnecting state.
- Countdown ticks without changing the accessible announcement.
- Every restoration-copy row; new session shows none; verified reuse with an active
  retry still shows the notice, and both surfaces render together.
- Status chip shows Retrying, not Idle/Reconnecting, and does not reuse the reconnect
  attempt field.
- Retrying wins over `load: loading` so an ordinary refresh does not hide it.
- Terminal failure keeps its reconnect control.
- The new surfaces render in `aboveComposerExtra`; no assistant-ui retry/status
  element was added.

For the new guards, deliberately introduce the defect, confirm the test fails, then
revert: unconditional `load_started` retry clearing, stale activity response,
shutdown retry preservation, unavailable-inbox queued claim, reuse-notice-as-restart,
raw map exposure, durable-claim-as-automatic-resume, history-failure-as-history-loaded,
and stale-replacement-showing-restoration.

---

## 7. Verification

The implementation is pushed. CI Verify run `39949223009` (`verify`, `e2e`, and
`tauri`) passed, including the Rust/Tauri build and packaged smoke test, and the
gate evidence is recorded in §8. A green unit/DOM run is still not a persistence
result; the bounded and version-specific limits below remain binding. The commands
below are the verification order if evidence needs to be reproduced:

```text
bun test --isolate tests/unit/web/opencode/...
bun test --isolate --preload ./tests/setup/dom-preload.ts tests/dom/opencode/...
# New process-level persistence/restart suite: real opencode serve + real TBAi backend.
# Use a temporary DATA_DIR and OPENCODE_DB; never the live OpenCode database.
bun test --isolate tests/integration/opencode
bun run test:locations
bun run typecheck
bun run lint
bun run format:check
bun run build
bun run test
bun run test:dom
bun run verify        # if feasible
```

A green unit/DOM run is not a persistence result. The process-level suite is the only
evidence for restart recovery, history availability, stale/missing sessions, queued
prompts, retry timing limits, cross-process database behavior, and ambiguous outcomes.
If a case cannot be automated, report it as manual and state the exact steps and
observed result; do not mark it passed. Gate statuses follow §8's evidence policy:
Pass or Fail requires an artifact, not the implementer's summary.

The binding gates are in §8. Two of them are outside the controlled-path test setup and
must be recorded separately:

- **Packaged-app path:** launch the packaged Tauri app twice with the same user
  environment, capture the resolved OpenCode `db` path each time, and confirm it is
  identical. A changed path is a 404 replacement, not reliable session restoration.
- **Windows orphan:** the managed child's lifetime and database ownership now have
  a tested fail-closed path (see §8 G2). The Rust build and packaged smoke test are
  recorded in Verify 39949223009 (commit `7f28c11`), and the packaged hard-kill is
  recorded in Verify 39951140626 (commit `fe10255`). The documented limits still
  apply: a late-opening foreign process, cross-session mutex scope, and backend-job
  installation failure. Concurrent servers on one database remain unsupported and
  must not be described as recovery.

Do not bind port 3030. Report exact commands, exit codes, and pass/fail/skip counts.
Any real-server/manual check uses a separate port. The implementation is already
pushed; gate evidence must still be recorded before claiming a gate or completion
state.

---

## 8. Limitations, checks, and acceptance

### Intentional limitations

1. **Exact retry timing after reconnect or process restart is not recovered.** The
   installed official surface has no status-snapshot request. A live retry may still
   be observed while the same OpenCode process runs, but a connection load clears the
   banner and no countdown is rebuilt from history; a later live event may establish a
   new live retry. After an OpenCode restart there is no wait to count down at all. No
   fabricated deadline.
2. **`session.active` availability is not a supported-version absence case.** The
   official handlers for `2.0.15`, `2.0.22`, and `2.1.2` include it. A request that
   actually fails still yields `unknown`; the notice is then plain or queue-confirmed,
   never a false idle.
3. **`not-running` is process-local.** It means absent from the current server
   process's active map, not “the run is dead” and not “no queued work”. It can coexist
   with a durable orphaned claim, a queued inbox row, or an orphan OpenCode process.
4. **The restoration notice appears on every verified reuse**, including ordinary
   navigation and while a live retry is active. It is a reuse notice, not a
   restart/crash detector. This is deliberate; a restart-only notice would require
   separate lifecycle tracking, which is not added.
5. **No automatic resubmission and no automatic execution resumption.** OpenCode's
   restart-continuity sweep is installed only for service-mode servers; TBAi runs
   default-mode `serve`. A surviving `time_suspended` claim is evidence of interrupted
   work, not a resumer. Queued prompts wait for a real run; they are not auto-sent.
6. **OpenCode history is outside `DATA_DIR` by default and is launch-environment
   dependent.** A backup of `chat.db` alone is insufficient. If `XDG_DATA_HOME`,
   `OPENCODE_DB`, or the binary's channel (which changes the default filename)
   changes, a saved id resolves against a different store and is treated as missing.
   Pinning the path is a separate migration decision, not adopted here.
7. **Storage loss is not repaired by a hidden fallback.** Losing `chat.db` loses the
   conversation mapping; losing/corrupting/moving the OpenCode database loses or hides
   history. TBAi has no second registry to search, by design.
8. **Orphan OpenCode process ownership is bounded, not perfect.** TBAi does not
   persist a PID/port or adopt a previous child. It resolves the child’s database
   path, serializes TBAi starts on a per-path named mutex, and refuses when Restart
   Manager names any existing holder of the DB or its `-wal`/`-shm` files. After
   readiness it re-checks and kills only its own child on a foreign holder. The
   shell and sidecar are bound by two nested kill-on-close jobs. Residual limits: a
   foreign process that opens the database after the post-readiness check is outside
   the boundary; the `Local\` mutex does not serialize Windows sessions; a backend-job
   failure degrades the descendant guarantee. 2.0.x process ownership/restart is not
   separately exercised; G4 covers only 2.0.15/2.0.22 database compatibility.
   Silent concurrent use is refused; the mode must not be presented as recovery.
9. **Session creation and pointer write are not atomic across processes.** A crash
   between them can leave an unreferenced OpenCode session. This is accepted residue;
   it is not repaired by a second registry or automatic reattachment.

### Completion states

Two completion states are separate and must not be collapsed:

1. **Retry/status/restoration UI.** Implemented and pushed; G5 verified the installed
   2.1.2 runtime behavior, and the UI/backend tests are in the suite. This state does
   not require proof of crash recovery.
2. **Persistence/crash recovery.** Satisfied for the tested Windows x64 scope:
   G3 passed as a bounded process-kill guarantee, G4 passed for 2.1.2 and the
   2.0.15/2.0.22 database endpoints, G6 passed for the Tauri sidecar restart, and
   G2's packaged hard-kill is recorded (Verify 39951140626 artifact - see G2).
   The bounded limits remain: no power-loss/disk-corruption guarantee, no late
   foreign-holder prevention, and no 2.0.x retry/activity/restart claim.

### Current scope decision (2026-10-23)

The implementation target for this phase is OpenCode **2.1.2**. G4 now verifies
database compatibility for the advertised `2.0.15` and `2.0.22` endpoints as well:
both opened a 2.1.2-created store, preserved the session id and all message rows,
and passed `PRAGMA integrity_check` without a destructive migration. Do not
generalize that result to every `2.0.x` release: only `2.0.15` and `2.0.22` were
tested, and 2.0.x retry/activity/restart semantics remain unverified. Do not narrow
the advertised range merely to make the gate easier.

### Pre-implementation preflight

These tasks are not gates. They make the gates executable and prevent implementation
from assuming an unverified mechanism.

| ID | Task | Why it is needed | Done when |
|---|---|---|---|
| P1 | Observe the actual managed child's OpenCode database path | G1 says “record the resolved path” but a separate `opencode debug paths` shell is not proof that the child used that path | **Done 2026-10-23.** G1 used Sysinternals Handle to observe the managed child's open DB on both packaged launches; see G1. |
| P2 | Choose G2's ownership/refusal mechanism | “Fail-closed” has no effect without a way to detect or prevent a competing process | **Done 2026-10-23.** Two nested Windows kill-on-close jobs (the Rust shell’s named job and the sidecar’s unnamed backend job) plus per-database ownership: resolve the child’s path with `opencode debug paths db`, take a named mutex keyed by the normalized path, query Restart Manager for DB/`-wal`/`-shm` holders before the spawn and after readiness, and refuse (killing only TBAi’s own child) on any foreign holder or unanswerable check. No PID/port lease. Evidence: `opencode-ownership-runtime.test.ts` (2 pass, real 2.1.2), `process-ownership.test.ts` (6 pass), `ownership.test.ts` (15 pass); ADR 2026-10-23. Non-Windows is a no-op; cross-session and late-opening limits are documented. |
| P3 | Acquire or verify the `2.0.15` and `2.0.22` binaries, or narrow the claim | G4 cannot pass for 2.0.x by source reading alone | **Done 2026-10-23.** `@opencode/cli-windows-x64` 2.0.15 (SHA256 `64E18BA6…`) and 2.0.22 (SHA256 `036A92F8…`) acquired from npm and run against a 2.1.2-created database copy: both opened the store, preserved the session id, table count unchanged (20), `PRAGMA integrity_check` `ok`, no destructive migration. G4 is now Pass for 2.0.x. Evidence: `C:\Users\RTPC\AppData\Local\Temp\opencode\g4-env\g4-matrix-results.json`. |
| P4 | Make a retry deterministic in the test harness | G6 requires a real retry, and the existing stub has no retryable-error behavior | **Done 2026-10-23.** `tests/harness/opencodeStubProvider.ts` has a controlled `retryable-error` behavior; `opencode-retry-restart.test.ts` uses it for the deterministic retry. |
| P5 | Register `POST /session/activity` before the OpenCode proxy catch-all | The route must be handled by TBAi, not swallowed by the proxy | **Done 2026-10-23.** `tests/unit/opencode/sessionActivity.test.ts` asserts the activity route is TBAi-handled and `POST /api/session/activity` is not a proxy route; the parameterized `session.active` path remains `session.get`. |
| P6 | Define the durable-retry replay rule | `session.retry.scheduled` is durable; a replay must not become a live countdown | **Done 2026-10-23.** `tests/unit/web/opencode/v2RetryActivity.test.ts` proves a replayed durable retry does not become a live countdown; only live events establish one. |
| P7 | Decide the activity-read server-start side effect | `ensureBaseUrl()` starts a server if needed, which is not strictly read-only | **Done 2026-10-23.** The start-path is documented in `sessions.ts` as accepted and deliberate; the activity unit test stubs `ensureBaseUrl`, so the start path is not exercised. This is recorded as **documentation-only acceptance**, not as a test. The start-path test would require a real server spawn, which is outside the unit test's hermetic boundary; the integration-level coverage (capabilities read, session creation) already exercises `ensureBaseUrl` start implicitly through the real server manager. |

### Acceptance gates (binding)

Acceptance is **not** declared in advance. These six gates are the release criteria;
the numbered checks in the next subsection are supporting detail, not substitutes. A
gate marked must pass cannot be waived by prose, and a bounded guarantee is reported as
bounded, not as full crash safety.

| ID | Gate | Required action | Pass requirement / disposition | Current status | Supporting case |
|---|---|---|---|---|---|
| G1 | OpenCode database path stability | Launch the packaged Tauri app multiple times with the same user environment and record the resolved `db` path from each managed launch. | **Must pass.** All launches resolve the same path. If it changes, do not claim reliable session restoration; the saved id is treated as missing in the new store. | **Pass (controlled isolated XDG)** — 2026-10-23, portable build `029229e` (run 39930829361), two launches; Handle directly observed the managed child's open DB at `C:\Users\RTPC\AppData\Local\Temp\opencode\g1-env\data\opencode\opencode.db` on both. PIDs and ports changed, path identical. Live `XDG_DATA_HOME` (`D:\Coding\OpenCode\data`) was not opened because PID 11392 is actively writing the 764 MB live DB; live-XDG concurrency is G2, not G1. | Test 18; §4.2 packaged-app gate; `g1-evidence/launch-{1,2}-summary.json` and `launch-{1,2}-handles.txt` |
| G2 | Windows orphan process and shared database | Kill the Tauri backend abruptly, inspect whether OpenCode survives, restart the backend, and test whether two servers can access the same database safely. | **Must pass or define a safe fallback.** If an orphan survives and concurrent access is unsafe, the fallback is fail-closed: no second server against that database and no ownership claim; require explicit orphan cleanup. Silent concurrency is not acceptable. The gate must name the detection/refusal mechanism; without one it remains failed. | **Pass (safe fallback, Windows x64)** — 2026-10-23. Database ownership is implemented and tested against real OpenCode 2.1.2 with isolated `OPENCODE_DB`/`XDG_DATA_HOME`: a foreign holder is refused and left running; a hard shell kill takes the sidecar and OpenCode; restart on the same DB has no orphan (2 pass). Fixture tests prove the named job, backend job, mutex, Restart Manager, and the no-join counterfactual (6 pass); policy tests (15 pass). **Build/smoke Pass (CI):** Verify run 39949223009 (commit `7f28c11`) passed the `tauri` job - Rust type-check, Rust tests, Tauri build, portable assembly, packaged smoke test. **Packaged hard-kill recorded (2026-10-23):** artifact `tbai-windows-x64-portable` from Verify run 39951140626 (commit `fe10255`, SHA256 `ec0d32e4aa21cbaee17784bfd6e13e203a1ad410abe9a490ac78b74e62e08ee8`, 47,572,352 bytes, artifact id 12500552176), extracted under `C:\Users\RTPC\AppData\Local\Temp\opencode\g2-artifact` and run with isolated `DATA_DIR`/`XDG_DATA_HOME`/`OPENCODE_DB`. g2-1: shell 11744, sidecar 4680, OpenCode 3684 (`serve --port 60833`; DB `C:\...\g2-env\g2-1\xdg\opencode\g2-opencode.db`); `Stop-Process -Id 11744 -Force` at 18:30:43 took sidecar and OpenCode within 5 s. g2-2 relaunch on same DB (18:30:54): shell 18904, sidecar 2680, OpenCode 16324; no orphan; exactly one OpenCode child; session `ses_e9724478affeK35SqB7lWH62ZU` for conversation `ng51vm7yx9th2h9yesk1sqxx` created. g2-3 foreign-holder refusal (18:33:44): second instance (shell 14160, sidecar 20012) with the same `XDG_DATA_HOME`/`OPENCODE_DB` was refused via Restart Manager; `POST /api/opencode/session` returned 500 "Failed to start OpenCode session"; g2-2 child 16324 was untouched and its activity read still succeeded (`not-running`); only g2-3 PIDs were killed. Final hard kill of g2-2 (18:34:23): `Stop-Process -Id 18904 -Force` took sidecar 2680 and OpenCode 16324. OpenChamber PID 2388 and the live store were untouched. Evidence: `C:\Users\RTPC\AppData\Local\Temp\opencode\g2-env\g2-evidence.json` plus `g2-1\launch1-summary.json` and `g2-2\launch2-summary.json`. 2.0.x process ownership/restart is not separately exercised; G4 covers 2.0.15/2.0.22 database compatibility only. Limits: a foreign process opening after the post-readiness check is outside the boundary; the `Local\` mutex does not serialize Windows sessions; a backend-job failure degrades the descendant guarantee. | Test 15; `opencode-ownership-runtime.test.ts`; `process-ownership.test.ts`; `ownership.test.ts`; ADR 2026-10-23 |
| G3 | SQLite durability under OS crash (partial) | Kill TBAi and OpenCode abruptly without graceful shutdown (a process-level simulation, not a literal OS crash), reopen `chat.db` and the resolved OpenCode database, and run `PRAGMA integrity_check` with row/table checks. | **Bounded guarantee; disclose limitation.** Committed rows remain readable and integrity checks pass for the tested kill paths. This does not prove resilience to actual power loss, disk corruption, or lost WAL state; report that limitation. | **Pass (bounded guarantee, Windows x64)** — 2026-10-23. Packaged `tbai-server.exe` from run 39951140626 launched with isolated `DATA_DIR`/`XDG_DATA_HOME`/`OPENCODE_DB`; a conversation (`kqbj8ohl8kvzdlsal591cyw0`) and OpenCode session (`ses_e971cbed7ffeII9MaYoAnxykI5`) were created. The sidecar was hard-killed (`Stop-Process -Id 14212 -Force`); the OpenCode child (`13132`) was taken by the sidecar's kill-on-close backend job. Both stores reopened read-only: `chat.db` integrity `ok` (24 tables; conversation row present; 0 TBAi message rows for the OpenCode conversation), `g3-opencode.db` integrity `ok` (20 tables; session row present). Bounded process-kill guarantee only — power loss, disk corruption, and lost WAL state not tested. Evidence: `C:\Users\RTPC\AppData\Local\Temp\opencode\g3-env\g3-evidence.json` and `g3-integrity.ts` output. | Test 16 |
| G4 | OpenCode 2.1.2 / 2.0.x database compatibility | Establish the configured range (`2.0.15` inclusive to `2.2.0` exclusive), run the current `2.1.2` target, and test `2.0.15` and `2.0.22` before making any 2.0.x claim. Use copies of existing databases and migrations. | **Must pass for supported versions; current scope is 2.1.2 plus the tested 2.0.15/2.0.22 endpoints.** The 2.1.2 target must open the database and preserve the session id and history without a destructive migration. 2.0.x versions beyond those endpoints remain unverified; if a version fails, narrow the range or block it. | **Pass (2.1.2 + 2.0.15 + 2.0.22)** — 2026-10-23. 2.1.2 same-version round-trip verified (as before). 2.0.15 and 2.0.22 binaries acquired from the official `@opencode/cli-windows-x64` npm package (SHA256 `64E18BA6…` and `036A92F8…` respectively) and run against a 2.1.2-created database with real message history: both versions opened the store, session lookup `200`, session id preserved, **all 4 message rows preserved**, table count unchanged (20), `PRAGMA integrity_check` `ok`, no destructive migration, `session.active` correctly empty on a new process. Evidence: `C:\Users\RTPC\AppData\Local\Temp\opencode\g4-env\g4-history-results.json` and `g4-matrix-results.json`. | Test 17; `opencode-database-compat.test.ts`; `g4-matrix.ts`; `g4-history.ts` |
| G5 | `session.retry.scheduled` and `session.active` (2.1.2) | Run the exact installed OpenCode 2.1.2 binary, capture real events and responses during a live retry, and verify payload fields, timing, status transitions, and failure behavior. | **Must pass for 2.1.2 only.** `session.active` reports process-local execution activity and matches the observed `{ sessionId: { type: "running" } }` behavior; `session.retry.scheduled` is delivered live and `data.at` is an absolute epoch-ms deadline. A durable replay during hydration must not become a live countdown. `session.status` is declared by the client but was NOT delivered by 2.1.2 in the tested flows and is not a 2.1.2 requirement. Hydration/live timing and failure-to-`unknown` are observed. Handler presence alone does not pass. 2.0.x retry/activity semantics remain unverified. | **Pass (2.1.2 only)** - observed 2026-10-23, binary v2.1.2 (SHA256 85C9506B...FAFACA1); 2.0.x semantics unverified | Tests 1, 3, 12, 14; activity tests |
| G6 | Real retry and Tauri sidecar restart | Trigger a retry deterministically, exercise the Tauri sidecar restart path, and confirm the UI recovers honestly. | **Must pass or remain explicitly unverified.** The UI must not invent a restored countdown or claim execution resumed. If deterministic retry or the sidecar restart path cannot be exercised, mark the gate unverified and do not claim it. | **Pass (Tauri sidecar restart, Windows x64)** — 2026-10-23. Packaged `TBAi.exe` launched with isolated `DATA_DIR`/`XDG_DATA_HOME`/`OPENCODE_DB`; a conversation and OpenCode session were created. The Tauri sidecar (`tbai-server`, PID 7276) was hard-killed; the Tauri shell automatically restarted it within 1 s (new sidecar PID 2236). The session was reused (`reusedExistingSession=true`), activity read returned `not-running`, and no restored retry countdown was observed. The deterministic retry path was exercised by `opencode-retry-restart.test.ts` (3 pass, 0 fail; deterministic retry in the stub, no restored wait, fresh deadline only after a new prompt). The Tauri shell→sidecar restart path is now the missing piece this run supplies. 2.0.x Tauri restart behavior remains unverified. Evidence: `C:\Users\RTPC\AppData\Local\Temp\opencode\g6-env\` (tauri-data, tauri-xdg, sidecar logs) and `tests/integration/opencode/opencode-retry-restart.test.ts` run output. | Tests 2, 12; `opencode-retry-restart.test.ts`; Tauri shell restart loop |

G2’s ownership decision is recorded (2026-10-23), not open. The fail-closed
mechanism is concrete: resolve the child’s database path, serialize TBAi starts on
a per-path named mutex, refuse when Restart Manager names an existing holder, and
re-check after readiness before accepting the child. The OS lifetime layer is two
nested kill-on-close jobs (shell → sidecar, sidecar → children). The tested
guarantee is the ownership/refusal path; the Rust build and packaged smoke test
passed in CI, and the packaged Tauri shell hard-kill run is now recorded
(2026-10-23, run 39951140626 artifact — see the G2 row above). G2 governs the
crash-recovery completion state, not the retry/status/restoration UI.

### Evidence policy

Gate status is exactly one of **Pass**, **Fail**, or **Unverified**. Only observed
evidence sets Pass or Fail: the command, timestamp, OpenCode binary version, build or
commit identifier, artifact path, and exit code. An implementer's report, a typecheck,
or a source inspection is not a gate pass. Absence of evidence is **Unverified**, not
“probably fine.” A failed gate blocks only the completion claim it governs.

### Supporting implementation checks

These checks feed the gates above; they are not acceptance by themselves. Each must be
checked against the installed versions and real flows; if one fails, the fallback is
`unknown`/plain copy, never a false idle or fabricated timing.

1. **`session.active` behavior, not just handler presence:** the response key matches
   `sessionId`, the entry is `{ type: "running" }`, and absence means inactive for the
   current process. Observed in `2.1.2`; `2.0.15` and `2.0.22` `session.active`
   behavior remains unverified (database compatibility alone is not a claim about
   live activity semantics).
2. **Retry signal and units (2.1.2 observed):** the live retry signal is
   `session.retry.scheduled`, carrying `attempt`, a structured provider `error`, and
   `at` as an absolute epoch-ms deadline. `session.status` is declared by the
   official client/schema but was not delivered by 2.1.2 in the tested normal,
   connected-retry, or connect-during-retry flows, so it is not a 2.1.2 requirement.
   A durable `session.retry.scheduled` replayed during hydration must not become a
   live countdown; only a live event may establish one. 2.0.x retry signal/units
   remain unverified.
3. **`session.retry.scheduled` units and delivery:** `at` is absolute epoch-ms,
   the live event is delivered while connected, and the historical part is still
   produced. Do **not** rely on event replay after a reconnect; the durable record
   is evidence of the attempt, not a scheduled wait.
4. **Load call sites:** `load_started` is dispatched only by `hydrate()` and
   `refresh()` today; `hydrate` is classified `connection` and `refresh` `refresh`.
   Any additional call site must be classified, not defaulted.
5. **Activity revision ordering:** the activity check starts after the hydration
   buffer drain, so a buffered retry event is already applied; status events arriving
   while the request is in flight increment the revision; the reducer’s equality
   guard is the final authority.
6. **Reuse flag:** every return path that reports `true` is verified live adoption;
   create and stale replacement cannot report `true`; the UI’s ordinary-navigation
   path is covered.
7. **Inbox availability:** a successful read sets `"current"`; a failed read sets
   `"unavailable"` and leaves stale records intact; the notice never treats
   `"unavailable"` as an empty or confirmed queue.
8. **UI slot and assistant-ui boundary:** `aboveComposerExtra` renders outside
   assistant-ui message context, so no `ErrorPrimitive`/message-error context is
   assumed; no new assistant-ui primitive is required.
9. **Status precedence and accessibility:** `retrying` wins over an ordinary
   `load: loading` state, reconnect/failure still wins over retrying, and the
   countdown does not create repeated screen-reader announcements.
10. **Backend error mapping:** invalid conversation/session pairs return 404 before
    the OpenCode call; request failures return `unknown` with no map leakage.
11. **Default-mode lifecycle:** the installed 2.1.2 binary and the supported 2.0.x
    releases (`2.0.15`, `2.0.22`) take the no-lifecycle path for `serve --port`; no
    restart-continuity sweep runs. A process-level test must confirm this for the exact
    binary under test. If a version differs, revise the no-auto-resume conclusion
    before shipping.
12. **Storage-path stability:** production must confirm that the managed child uses
    the same data root, override, and channel-derived filename across app launches.
    The tests pin `XDG_DATA_HOME`/`OPENCODE_DB` explicitly; the product currently does
    not. A path change is a 404 replacement, not a recovery.
13. **SQLite durability and orphan behavior:** committed rows survive a normal process
    restart; OS-crash durability and Windows orphan survival are platform facts to
    measure. Do not claim them from a reducer or a single graceful restart test.
14. **Cross-version persistence:** `v2.0.15` and `v2.1.2` have the same inspected
    `session_v2`/`session_message`/`session_inbox` shapes, but a real database opened by
    each version must be covered before claiming recovery across the whole supported
    range. A schema migration is an implementation-time check, not an assumption.

If implementation-time evidence contradicts any gate or supporting check, stop and
revise this plan with the measured behavior rather than weakening the invariant.
