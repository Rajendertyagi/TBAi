# PM Infrastructure Audit Report

**Date:** 2026-10-05
**Scope:** `docs/pm-audit-request.md` — what EXISTS today across the full application.
**Method:** read-only audit of the working tree on disk (the tree is dirty; git state ignored). Three parallel auditors + first-hand spot-verification of the load-bearing claims (Bun.serve call, DB pragmas, MCP constants, 128k fallback, health routes, overflow-gate wiring, char/token estimate, instance-id handshake).
**Format:** one section per numbered request item. Facts + file:line only. Absence stated as **"Does not exist."** No fixes, no suggestions.

---

## 1. Session Lifecycle

### 1.1 "Session start" event

There is no named application-level "session start" object. What exists is a per-boot process-identity handshake:

- The Tauri launcher passes a fresh `TBAI_INSTANCE_ID` UUID per boot; the backend reads it or generates its own (`src/services/server-listener.ts:59-66`):
```ts
process.env.TBAI_INSTANCE_ID?.trim() || crypto.randomUUID();
```
- The id is published to the frontend: `GET /api/server` returns `{ instanceId }` (`src/server.ts:99`).
- Boot log event: `logger.info("server", "started", …)` (`src/server.ts:111`).

CONFIRMED: that is the full extent of "session start" on disk.

### 1.2 "Session end" / cleanup event

There is no named "session end" event. The end paths that exist:

- **Tauri window close does NOT stop the app.** The close is intercepted and the window hides to the tray; the sidecar keeps running (`src-tauri/src/main.rs:567-577`).
- The only desktop quit path is tray "Quit TBAi" / settings `quit_app` → `quit_owned` → `child.kill()` (`src-tauri/src/main.rs:169-180, 549, 182-185`). CONFIRMED: `child.kill()` is a raw OS kill; it does **not** route through the backend's SIGINT/SIGTERM handlers, so `shutdownServer` does not run on desktop quit.
- The backend's only shutdown triggers are two signal handlers (`src/server.ts:36-43`).
- NOT ESTABLISHED: whether any other OS-level event (crash, power loss) triggers `shutdownServer`; only those two handlers exist on disk.

### 1.3 Backend shutdown sequence (when the signals do arrive)

`shutdownServer` (`src/server.ts:133-240`), ordered, each step best-effort in its own try/catch:

| Step | Code | What it does |
|---|---|---|
| 1 | `server.ts:137-138` | idempotence guard `shuttingDown` |
| 2 | `server.ts:144` | `beginSchedulerShutdown()` — gate new fires, clear all cron/timeout handles |
| 3 | `server.ts:154` | `server.stop(true)` — force-close client connections |
| 4 | `server.ts:160` | `openCodeServerManager.shutdown()` |
| 5 | `server.ts:166` | `mcpManager.disconnectAll()` |
| 6 | `server.ts:172` | `chatRuns.abortAll()` |
| 7 | `server.ts:180` | `await chatRuns.awaitSettled()` |
| 8 | `server.ts:187` | `abortAllRuns()` (scheduler runs) |
| 9 | `server.ts:194` | `drainInflightRequests()` |
| 10 | `server.ts:199-205` | await the listener stop |
| 11 | `server.ts:210, 219` | `stopChatStreamCleanup()`, `stopHistoryReconciliation()` |
| 12 | `server.ts:229` | `db.close()` — SQLite last |
| 13 | `server.ts:234-239` | log `"stopped"`, set `process.exitCode = 0` (no `process.exit()` call; event loop drains) |

### 1.4 Frontend close-time cleanup

- `beforeunload`: **Does not exist.** Zero matches in `web/src`.
- Exactly one close-time hook — a `pagehide` log flush, lazily installed once at module scope, no removal path (`web/src/lib/log-transport.ts:152-163`):
```ts
window.addEventListener("pagehide", () => {
  void flushClientEvents({ keepalive: true });
});
```
- No other window-close/Tauri-close listeners exist in `web/src`.

### 1.5 "Session" concept in the DB

No. The full CREATE TABLE inventory in `src/db/index.ts`: `conversation_compactions` (:58), `provider_configs` (:80), `credential_key` (:99), `app_settings` (:120), `conversations` (:128), `todos` (:142), `messages` (:156/:172), `memories` (:354), `mcp_servers` (:365), `folders` (:454), `folder_links` (:472), `folder_groups` (:483), `quick_messages` (:502), `scheduler_jobs` (:515), `scheduler_runs` (:545). No table named `sessions` or `session`.

The only "session" string in the schema is a foreign pointer: `conversations.opencode_session_id` (`src/db/index.ts:296`) — it references sessions owned by the separately-managed `opencode serve` process; TBAi SQLite stores no session rows of its own.

---

## 2. Memory Management (Frontend)

### 2.1 Every Zustand store — CONFIRMED: 14 stores in 13 files

| # | File (line) | Stores | Cap / cleanup boundary |
|---|---|---|---|
| 1 | `web/src/stores/index.ts:39` `useSettingsStore` | `providers[]`, active id, one-shot picker fields | no cap on `providers` (array replaced wholesale on load) |
| 2 | `web/src/stores/index.ts:107` `useMemoryStore` | `memories[]`, `newMemory` | no cap; replaced from `/api/memories` responses |
| 3 | `web/src/stores/mcpStore.ts:50` `useMcpStore` | `servers[]`, `loading`, `pendingInsert` | no cap on `servers` (replaced on `loadServers`); `pendingInsert` is a single slot |
| 4 | `web/src/stores/schedulerStore.ts:38` `useSchedulerStore` | `jobs[]`, `runsByJob` Record, `recentRuns[]` | no cap on `runsByJob` keys; each value is a server page `?limit=50`; `recentRuns` server-capped at 100 |
| 5 | `web/src/stores/foldersStore.ts:128` `useFoldersStore` | `folders[]`, `folderGroups[]`, `folderExpanded` Record | `folderExpanded` has no key cap; one key per folder on expand/collapse; persisted to localStorage; only `setAllFoldersExpanded` rebuilds it |
| 6 | `web/src/stores/quickMessagesStore.ts:53` `useQuickMessagesStore` | `messages[]` | no cap; replaced on load |
| 7 | `web/src/stores/stalePermissionsStore.ts:64` `useStalePermissionsStore` | `stale` Set | **no cap, no removal path** — `markStale` only adds; entries live until page reload |
| 8 | `web/src/features/chat/state/chatTabs.ts:262` `useChatTabsStore` | `tabs[]`, `activeKey`, `groupId` | no cap on open tabs; removed by `close`/`closeByRef`; persisted to localStorage |
| 9 | `web/src/features/chat/state/welcomeScope.ts:68` | scope + quick-action tab | fixed-size scalars, persisted |
| 10 | `web/src/features/chat/state/welcomeEngine.ts:89` | engine/agent/model/variant/autoApprove | fixed-size scalars, persisted |
| 11 | `web/src/features/chat/state/streamRecovery.ts:149` `useStreamRecoveryStore` | `byThread` Record | no cap; `clear`/`clearAll` remove per thread |
| 12 | `web/src/features/opencode/commandsStore.ts:43` `useCommandsStore` | `commands[]`, `loadedAt` | replaced wholesale; 30s TTL re-fetch guard |
| 13 | `web/src/features/desktop/state/desktopLayout.ts:189` `useDesktopLayout` | chrome/sidebar prefs + `sectionOrder` | fixed-size; persisted with `partialize` excluding transient search fields |
| 14 | `web/src/features/availability/availabilityStore.ts:183` `useAvailabilityStore` | status/reason/backoff scalars | fixed-size; single poll timer; listener Set has subscribe/unsubscribe |

### 2.2 useEffects without cleanup

CONFIRMED: **all 7 `setInterval` effects and all `addEventListener`-in-effect sites have cleanup returns** (`ElicitationModal.tsx:37/41`, `ChatWindow.tsx:310/311`, `McpPanel.tsx:141/142`, `serverIdentity.ts:53/56-59`, `SchedulerPage.tsx:135/136-139`, `useOpenCodeAuxiliaryResync.ts:42/47-50`, `useFormDockMaxHeight.ts:59-66`; listener pairs at `Sidebar.tsx:205-209`, `ChromeShortcuts.tsx:66-67`, `LeftEdgeChrome.tsx:71-72`, `LogsPanel.tsx:428-457`, `reasoning.tsx:284-288`, `mermaid-diagram.tsx:124-125`, `OpenCodeChipShared.tsx:307-311`, `ime.ts:80-89`).

No cleanup (module-scope, not hooks — exactly 3 sites):
1. `web/src/features/chat/state/chatTabs.ts:399-409` — `window.addEventListener("storage", …)` registered once at module load; no removal anywhere in the file.
2. `web/src/lib/logger.ts:184-209` — registers `unhandledrejection` (:190) and `error` (:198) on window; one-shot guard `hooksInstalled`; no removal path.
3. `web/src/lib/log-transport.ts:152-163` — `pagehide` listener; `pagehideInstalled` guard; no removal path.

### 2.3 Module-level arrays/maps/sets in `web/src/` that grow over time

**Bounded (hard cap and/or removal path):**
- `lastGoodHistory` Map — `web/src/adapters/threadHistoryAdapter.ts:13`, LRU cap 20, per-key delete + `clear()`
- `sendConfigs` Map — `web/src/runtime.ts:69`, cap 60, evict-oldest
- `materializedEngines` Map — `web/src/features/chat/state/materializeDraft.ts:59`, cap 50, per-key delete
- `lastKnownStreamId` Map — `web/src/features/chat/state/resumable-stream.ts:55`, per-thread delete on successful outcome
- `recheckTimers`/`recheckAttempts` — `web/src/features/chat/state/streamRecovery.ts:70-72`, chain capped at 5 attempts, deleted on cancel/settle
- `inFlightBootstraps` Map — `web/src/features/opencode/sessionBootstrap.ts:35`, single-flight, delete on settle
- log queue — `web/src/lib/log-transport.ts:109`, `MAX_QUEUE = 200`, oldest dropped

**Unbounded (no cap; removal only via explicit lifecycle or none):**
- `stale` Set — `web/src/stores/stalePermissionsStore.ts:65` — **no removal path; add-only**
- `configOverrides` Map — `web/src/features/opencode/useOpenCodeConversationConfig.ts:105` — **no `delete`/`clear` anywhere in the file**
- `policies` Map — `web/src/features/opencode/sessionAutoPolicy.ts:32` — clearable (`clearAutoPolicy` :86) but no cap
- `runsByJob` Record — `web/src/stores/schedulerStore.ts:40` — no per-job removal, no cap
- `byThread` Record — `web/src/features/chat/state/streamRecovery.ts:150` — clearable but no cap
- `folderExpanded` Record — `web/src/stores/foldersStore.ts:139` — full rebuild only; keys for removed folders persist (also in localStorage, :104)
- `tabs` array — `web/src/features/chat/state/chatTabs.ts:263` — removed on close; no cap; mirrored to localStorage

**Whole-store arrays that grow with backend data (no local cap):** `useSettingsStore.providers`, `useMemoryStore.memories`, `useMcpStore.servers`, `useQuickMessagesStore.messages`, `jobs`/`recentRuns` (schedulerStore).

**Subscriber-bounded Sets (removal via unsubscribe):** `overrideListeners` (`useOpenCodeConversationConfig.ts:107`), `recoveryListeners` (`availabilityStore.ts:55`), `focusListeners` (`web/src/lib/focus.ts:154`).

**Static (do not grow with input):** `theme-data.ts:962 BY_ID`, tool-name sets (`web/src/tools/filesystem/ui.tsx:498`, `v2Events.ts:24,28`, `v2MessageProjection.ts:31`, `compactCommand.ts:189`, `approval-options.ts:29,35,41`, `session-timeline.tsx:143`, `log-transport.ts:59`).

NOT ESTABLISHED: whether `stale`, `configOverrides`, `runsByJob`, `folderExpanded`, or `tabs` ever reach meaningful size in a long Tauri instance — no size limit or metric exists on disk to observe it.

### 2.4 "Free memory when idle"

No. Nothing in `web/src` runs on an idle condition to reclaim memory; grep for `memoryUsage`/`performance.memory` in `web/src`: 0 matches.

What exists instead is bounded-cache eviction, not idle reclamation: the LRU caps listed in 2.3, a one-shot full invalidation on backend recovery (`invalidateHistoryCache()` called from `web/src/features/availability/recovery.ts:44`), and a 30s refresh-TTL on the command feed (`web/src/features/opencode/commandsStore.ts:26`) — a fetch policy, not memory freeing. The word "idle" in `web/src` refers exclusively to the OpenCode execution-state type (`web/src/features/opencode/v2Types.ts:144-157`) — no memory semantics.

---

## 3. Memory Management (Backend)

### 3.1 In-memory structures in `src/` that grow over time

| File:line | Variable | What adds | What removes |
|---|---|---|---|
| `src/lib/logger.ts` | `Logger.buffer` (fixed-capacity ring) | every `write()` | capped at `config.bufferSize` (default 5000, :60) by overwriting the head slot; one eviction counted per write once full |
| `src/lib/logger.ts:582` | `Logger.fileQueue` | `enqueueFileLine` | capped at `fileQueueLimit` (default 5000, :62); overflow dropped + counted (:780-783); drained in 10ms/64KB batches (:561-562, 786-794) |
| `src/lib/logger.ts:597` | `Logger.throttleStates` Map | one entry per log scope on first info/debug (:687-691) | **nothing in production** — only test-support `resetThrottleStates()` (:675-677); bounded by number of distinct scopes |
| `src/services/scheduler/scheduler.ts:45` | `timers` Map | per active job (:279, :306) | `clearTimer` on job change/disable/terminal (:120-130) and `clearAllTimers` at shutdown (:518-529) |
| `src/services/scheduler/scheduler.ts:48` | `runControllers` Map | per in-flight run (:78) | `releaseRun` on settle (:82-84) |
| `src/services/scheduler/scheduler.ts:51` | `pendingRuns` Set | `trackRun` per fire (:63-70) | `finally` delete on settlement (:66) |
| `src/services/grants.ts:21` | `grants` Map | `mintGrant` (:57) | lazy `sweep()` on every mutation: 10-min TTL (:18) **and hard cap `MAX_GRANTS = 500`** (:19, :23-33) |
| `src/context/observed-limits.ts:66` | `observations` Map | `observeContextWindow` (:97-98) | capped at `MAX_OBSERVED_LIMIT_ENTRIES = 256` (:45), oldest-first eviction (:99-103); deliberately not persisted |
| `src/services/chat-runs.ts:69` | `records` Map | `create` per chat run (:159, :175) | lazy `sweep()` on every create: 1h terminal TTL (:54) **and hard cap 2000** (:55, :105-115) |
| `src/routes/conversations.ts:59-60` | `createInFlight`, `createCompleted` Maps | per idempotent create (:217, :226) | in-flight deleted on settle (:232-233); completed: 10-min TTL pruned when size > 200 (:45, :62-67) |
| `src/services/mcp/manager.ts:130` | `connections` Map | per `connect()` (:423) | **only `deleteConfig`** (:320). `disconnect`/`disconnectAll` (:572-600) mark status but **leave the entry in the map** — a disconnected server keeps its object (with up to 50 events + tools/resources/prompts arrays) for the whole process lifetime |
| `src/services/mcp/manager.ts` (per-conn `events`, :420) | per-connection events array | `pushEvent` | capped at `MAX_EVENTS = 50` (:82, :733-735) |
| `src/services/opencode/sessions.ts:241` | `sessionEnsuresInFlight` Map | per in-flight ensure (:231) | `finally` delete on settle (:235-237) |
| `src/services/opencode/serverManager.ts:228` | `childDiagnostics` WeakMap | per live subprocess | GC when the subprocess is released; single-child design (:216) |
| `src/services/scheduler/cron.ts:152` | `tzPartFormatterCache` Map | one `Intl.DateTimeFormat` per distinct timezone string | **nothing** — no removal; bounded by number of distinct TZ strings configured |
| `src/config/providers.ts:20` | `providers` Map | `loadFromDb` / register | removed on provider delete/update; bounded by DB rows |
| `src/context/cache/capabilities.ts:194` | `REGISTRY` Map | module load | static; does not grow |
| `src/services/http-metrics.ts:15-20` | metric scalars | per request | counters only (monotonic), not collections |

Structurally unbounded without removal: `connections` (MCP entries survive disconnect), `throttleStates`, `tzPartFormatterCache`. Everything else has a hard cap, TTL, or in-flight lifetime.

### 3.2 Idle cleanup / memory ceiling

No. Grep `process.memoryUsage|memoryUsage|heapSize` across `src/` and `web/src`: **0 matches**. No memory-pressure checks, no eviction-on-pressure, no idle-reclamation loops.

What exists instead: the hard caps + TTL sweeps in 3.1; SQLite PRAGMA budgets (64 MiB page cache, 256 MiB mmap, in-memory temp store — `src/db/index.ts:25-36`, a storage-engine budget, not app-memory reclamation); scheduled **row** pruning (hourly `chat_stream_chunks`/`chat_streams` 24h-TTL cleanup, `src/services/chat-streams/cleanup.ts:28,119`; `schedulerStore.pruneOldRuns` 30 days, called at `src/services/scheduler/scheduler.ts:453`); file-log rotation (`src/lib/logger.ts:421-442,493-517`, disk not RAM).

### 3.3 Log ring buffer

- Size: `DEFAULT_LOG_BUFFER_SIZE = 5000` entries (`src/lib/logger.ts:60`), overridable per boot via `TBAI_LOG_RING` env → `config.bufferSize` (:111).
- When full — FIFO drop-oldest, counted, never blocks. The ring is a fixed-capacity circular buffer, so eviction is an O(1) slot overwrite plus a head bump:
```ts
const capacity = this.buffer.length;
this.buffer[this.bufferHead] = buffered;
this.bufferHead = (this.bufferHead + 1) % capacity;
if (this.bufferCount < capacity) {
  this.bufferCount += 1;
} else {
  this.ringSpliced += 1;
}
```
  This replaced an array-as-queue that ran `splice(0, overflow)` on every warm write — O(cap) per line. See `docs/TBAiPERFORMANCEAUDIT.md`.
- Reads (`getRecentEntries`, `lastSeq`) walk from the oldest occupied slot, so the oldest-first contract holds across wrap-around. Shrinking `bufferSize` via `configure` re-clamps the ring, keeping the newest survivors; those resize-time drops are deliberately not charged to `ringSpliced`, which is attributed to writes (no runtime caller changes `bufferSize` — it comes from `TBAI_LOG_RING` at boot).
- The loss counter is exposed: `getWriteStats().loss.ringSpliced` (:638-664) and as Prometheus text `tbai_log_entries_ring_spliced` (`src/services/http-metrics.ts:51-53`). Live-tail SSE subscribers still receive the seq notification (:759-765).

---

## 4. Resource Lifecycle — Streams & Connections

### 4.1 Backend-opened streams

| Stream | File | What opens | What closes |
|---|---|---|---|
| `POST /api/chat` UI-message stream | `src/routes/chat.ts:194, 1044, 1080, 1519, 1552, 1635` | route handler + `createUIMessageStream` | (a) 30-min per-run wall clock aborts the run's own AbortController (`src/services/chat-runs.ts:53, 160-174`, unref'd :174); (b) `POST /api/chat/cancel/:streamId` → `controller.abort()` (`chat.ts:1852-1901`); (c) client disconnect **detaches but does not kill** the run (`chat.ts:1604-1613`, `chatRuns.markDetached`); (d) shutdown: `chatRuns.abortAll()` + `server.stop(true)` (`server.ts:154, 172`) |
| `GET /api/chat/resume/:streamId` | `chat.ts:1653-1658` | persisted-stream replay | ends when replayed chunks end / client disconnects; `disableIdleTimeout` (:1654) |
| `GET /api/logs/stream` (SSE) | `src/routes/logs.ts:184-242` | `ReadableStream` (:187) + 5s heartbeat `setInterval` (:213-220) | `c.req.raw.signal` abort → `clearInterval` + `unsubscribe` + `controller.close()` (:221-232); shutdown force-close |
| OpenCode proxy catch-all `app.all("*")` | `src/routes/opencode.ts:348` | upstream `fetch` (:411), incl. long-lived `/event` SSE (detected :428-429); body wrapped in `observeBody` ReadableStream (:493-586) | client disconnect; the 240s idle backstop applies — this route does **not** call `disableIdleTimeout` |
| MCP SSE probe | `src/services/mcp/manager.ts:507-530` | one-shot `fetch` with `AbortSignal.timeout(3000)` (:511), body discarded | timeout / one-shot |
| provider stream (upstream of `streamText`) | AI SDK | aborted by `run.controller.signal` (`chat.ts:1133`) | run abort/cancel |
| child-process pipes (not HTTP) | `src/services/opencode/serverManager.ts:364-388` (stdout/stderr drains), `src/services/tools.ts:338-349`, `src/services/browser.ts:224-259` | process spawn | process exit/kill |

(`GET /api/chat/stream-status` at `chat.ts:1783` is one-shot JSON, not a stream.)

### 4.2 Frontend-opened streams

| Stream | File | Opener | Closer |
|---|---|---|---|
| chat fetch stream | `web/src/runtime.ts:314-323` | `AssistantChatTransport({ api: "/api/chat", resumable: { storage, resumeApi: /api/chat/resume/:id } })` — owned by `@assistant-ui/ai-sdk` | library-owned AbortController per send; body-settle observed in `web/src/lib/send-operation.ts:81-94` |
| logs SSE | `web/src/components/LogsPanel.tsx:432` | `new EventSource("/api/logs/stream")` | effect cleanup `source?.close()` (:453-457); `onerror` → close + 2000ms retry (:441-448), retry timer cleared on unmount (:456) |
| OpenCode event subscription | `web/src/features/opencode/v2Client.ts:178` | `officialClient.event.subscribe({ signal: connectionSignal })` (SSE through the TBAi proxy) | `events.close()` = `iterator.return()` (:205-209); aborted via `connectionController.abort()` + `failedGeneration.events.close()` in `v2ThreadController.ts:439-459` |
| recurring fetch pollers (one-shot fetches) | `ElicitationModal.tsx:37` (3s), `McpPanel.tsx:141` (3s), `SchedulerPage.tsx:135` (5s), `serverIdentity.ts:53`, `availabilityStore.ts:177` (re-armed) | interval/re-arm loops | matching `clearInterval`/`clearTimeout` cleanups (see §5.1) |

### 4.3 Long-lived fetch/HTTP connections

- `POST /api/chat` runs — up to 30 min (`chat-runs.ts:53`).
- `/api/logs/stream` SSE — no timeout (`disableIdleTimeout` + 5s heartbeat).
- `/api/opencode/.../event` SSE proxy — 240s global idle backstop only (`server-listener.ts:27`).
- OpenCode child-process stdout/stderr pipes (`serverManager.ts:364`).
- MCP stdio subprocesses — one per configured stdio server (`manager.ts:351-361`).

Lifecycle managers: `chatRuns` singleton (`chat-runs.ts:266`); `server-listener.ts` for the listener; `drainInflightRequests` polls the in-flight gauge at shutdown (`src/services/http-metrics.ts:88-93`).

### 4.4 Stream timeouts

- chat-run wall clock: `DEFAULT_WALL_TIMEOUT_MS = 30*60*1000` (`chat-runs.ts:53-54, 63-64, 160-174`), env-overridable `TBAI_CHAT_RUN_TIMEOUT_MS`.
- listener idle backstop: `LISTENER_IDLE_TIMEOUT_S = 240` (Bun's max) (`server-listener.ts:27`); per-request disable via `server.timeout(req, 0)` (`src/routes/shared.ts:18-31`) used by chat/resume/logs.
- `/api/logs/stream`: **no timeout.**
- opencode proxy SSE: **no per-request timeout** (240s global backstop only).
- MCP SSE probe: `SSE_PROBE_TIMEOUT_MS = 3000` (`manager.ts:86`).
- scheduler runs: per-job `timeout_seconds` (default 600, `db/index.ts:534`) → `setTimeout(() => controller.abort(), timeoutMs)` (`schedulerExecution.ts:311-312`).

---

## 5. Resource Lifecycle — Timers & Background Jobs

### 5.1 Every `setInterval`

**Backend (3):**
- `src/routes/logs.ts:213` — 5s SSE heartbeat per `/api/logs/stream` connection; stopped by `clearInterval(heartbeat)` inside the abort handler (:224).
- `src/services/chat-streams/cleanup.ts:119` — hourly reclamation of expired stream rows (`DEFAULT_CLEANUP_INTERVAL_MS`, :28); unref'd (:125); stopped by `stopChatStreamCleanup()` (:130-136), called at `server.ts:210`.
- `src/services/chat-streams/historyReconciler.ts:259` — periodic history finalization; unref'd (:265); stopped by `stopHistoryReconciliation()` (:270-276), called at `server.ts:219`.

**Frontend (6):** `ElicitationModal.tsx:37` (3s poll; cleared :41), `ChatWindow.tsx:310` (1s streaming ticker; cleared :311), `McpPanel.tsx:141` (3s status poll; cleared :142), `SchedulerPage.tsx:135` (5s poll; `clearTimeout(timer)` at :138 — note: `clearTimeout` on an interval handle; browser timer-id pools are shared, so it does stop it), `useOpenCodeAuxiliaryResync.ts:42` (idle-resync poll; cleared :48), `serverIdentity.ts:53` (`/api/server` poll; cleared :58).

All 9 have a stop path.

### 5.2 `setTimeout`s that are not fire-and-forget (stored / re-armed / loop-driving)

**Backend:** `chat-runs.ts:160` (per-run wall clock, stored on the record) and `:238` (shutdown settlement bound); `mcp/manager.ts:631` (reconnect timer, stored on the connection); `scheduler/scheduler.ts:298-306` (one-time job timers in the `timers` Map) and `:555` (shutdown bound); `schedulerExecution.ts:264` (abortable sleep) and `:312` (run timeout); `lib/terminal-stream.ts:105-108` (batcher flush timer, re-armed per push, cleared :85-87, :134); `lib/logger.ts:584, 791-793` (file-sink flush timer, re-armed per line, unref'd, cleared :799-801); `chat-streams/sqliteResumableStore.ts:418-431` (resume-poll wait loop, re-armed per poll, unref'd); `compaction/summarize.ts:294, 320-323` (deadline raced against `generateText`, cleared in finally); `opencode/serverManager.ts:86` (readiness probe abort, cleared in finally), `:156-158` (poll loop re-armed until timeout/exit), `:442` (SIGTERM→SIGKILL bound); `server-listener.ts:149-155` (500ms delayed stop of a replaced listener, `OLD_LISTENER_CLOSE_DELAY_MS` :33); `modelDiscovery.ts:36`, `http-metrics.ts:91` (one-shot drain timers).

**Frontend:** `lib/log-transport.ts:110, 139-149` (batch-flush timer, re-armed with backoff, cleared :132-137); `availabilityStore.ts:53, 177-180` (re-armed poll loop: 15s healthy, exponential 1s→30s on failure, `stop()` :194-197); `streamRecovery.ts:70, 131-138` (bounded re-read chain, delays `[1500,3000,6000,12000,25000]` :90, cancelled :107-114); `v2ThreadController.ts:230, 450-458` (event-stream reconnect timer, re-armed with capped exponential delay, capped at `OPENCODE_V2_MAX_RECONNECT_DELAY_MS` — **no attempt-count cap found in this controller**); `LogsPanel.tsx:427, 446-448` (SSE retry, cleared on unmount :456); debounces at `JobEditor.tsx:336-357` (400ms) and `desktopLayout.ts:113, 237-240`; abort/exit timers at `ProviderDialog.tsx:208` (20s), `approval-card.tsx:144, 167-171`, `OpenCodeView.tsx:99-126`.

### 5.3 Every `Bun.cron` registration

Exactly **one registration site** — `src/services/scheduler/scheduler.ts:267-279` in `scheduleRecurring`:
```ts
const handle = Bun.cron(expression, () => {
  trackRun(fireJob(jobId, slotOccurrenceId()));
}, { tz: job.timezone });
try { handle.unref?.(); } catch { /* unref is best-effort */ }
timers.set(job.id, { kind: "cron", cronHandle: handle });
```
One handle per active cron job, kept in the module `timers` Map (:45). Stopped via `clearTimer` → `entry.cronHandle?.stop()` + map delete (:120-130), invoked from `scheduleJob`/`unscheduleJob`/terminal transitions (:236, :239, :346, :358-368) and `clearAllTimers()` → `beginSchedulerShutdown()` (:518-529), called first in the shutdown spine (`server.ts:144`). One-time jobs use stored, unref'd `setTimeout`s instead (:298-306).

### 5.4 What happens when a job/timer errors

- **Cron fire failures do NOT stop or restart the timer** (`scheduler.ts:141-258`): conversation-setup errors are caught and logged, the run proceeds with an empty conversationId (:200-213); execution outcomes come from `executeJobRun` — retries per `job.maxRetries` (`schedulerExecution.ts:292-449`), terminal `failed`/`cancelled` recorded via `schedulerStore.updateRun` (:383-441); the cron handle stays registered and keeps firing (no-overlap guarantee, :176-177; next-run bookkeeping refreshed :246-257).
- **One-time job outcomes:** success → `status:"completed", enabled:false` + `clearTimer` (:229-236); non-retryable failure → `status:"failed"` + `clearTimer` (:237-240); retryable failure → job left active, timer already consumed (:241-242).
- **Rejection containment:** fire paths go through `trackRun`, whose `.catch(() => {})` swallows rejections (:63-70); cancellation via `runControllers` + `cancelRun` (:91-118); shutdown via `abortAllRuns` (:548-563).
- **Boot recovery** disables a failing job rather than leaving it in an unknown state: `scheduler.ts:487-498` (`update(job.id, { enabled: false, status: "failed", next_run_at: null })`).

---

## 6. Resource Lifecycle — MCP Connections

### 6.1 Concurrent connections / cap

One connection per configured server, **no count cap.** `init` loads ALL `mcp_servers` rows and fire-and-forget connects every enabled+autoConnect row (`src/services/mcp/manager.ts:141-151, 155-160`):
```ts
const configs = this.loadConfigs();
for (const cfg of configs) {
  if (cfg.enabled && cfg.autoConnect) void this.connect(cfg.id);
}
```
Connections live in one `Map` (:130). No maximum-connections constant exists (the module's only constants: `MAX_EVENTS=50`, `MAX_RECONNECT_ATTEMPTS=5`, `RECONNECT_DELAY_MS=5000`, `SSE_PROBE_TIMEOUT_MS=3000` — :82-86).

### 6.2 Full lifecycle of one connection

- **OPEN** — `connect()` (:380-500): tears down the prior connection (:388-400), `new Client` (:402), transport build (:440-441; stdio :351-362 / http :367-371 / sse :372-376), `await client.connect(transport)` (:445), `status="connected"` + `reconnectAttempts=0` (:447-450), capability discovery (:459, :647-688).
- **ERROR** — catch at :467-499 → `status="error"` (:484) or classified SSE failure → `auth_failed`/`error` + `failureReason` (`failConnect`, :537-570); both call `scheduleReconnect` (:498/:569). CONFIRMED: **there is no live-disconnect detection** — no `onerror`/`onclose`/`.on(` handler is registered anywhere in the manager (grep: 0 matches); a mid-session transport drop is only noticed if a later operation fails.
- **RECONNECT** — `scheduleReconnect` (:624-643):
```ts
if (!conn.config.enabled) return;
if (conn.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
conn.reconnectAttempts += 1;
conn.reconnectTimer = setTimeout(() => {
  const c = this.connections.get(id);
  if (!c || !c.config.enabled || c.status === "connected") return;
  void this.connect(id);
}, RECONNECT_DELAY_MS);
```
- **GIVE UP** — at attempt 5, `scheduleReconnect` silently returns (:628). No terminal "given up" status is written; the entry stays `error`/`auth_failed`.

### 6.3 Shutdown close

Explicit. Signal → `shutdownServer` → `await mcpManager.disconnectAll()` (`src/server.ts:40-43, 166-169`). `disconnectAll` = `Promise.allSettled(ids.map(disconnect))` (:597-600); `disconnect` clears the reconnect timer (:575-578), resolves pending elicitation (:582), sets `status="disconnected"` **before** closing (:586), then `await conn.client.close()` (:588).

### 6.4 Release after `MAX_RECONNECT_ATTEMPTS`

NOT ESTABLISHED as released. Facts on disk: after 5 failed attempts the connection object **remains in the `connections` Map** with status `error`/`auth_failed`. The only `connections.delete` is in `deleteConfig` (:320); the only `client.close()` calls are the prior-teardown (:396), `disconnect` (:588), and temporary test-connection clients (:1118/:1160/:1195). The failure catch in `connect` (:467-499) does not close the failed client or remove the record — nothing reclaims it until the next connect/disconnect/delete for that id.

---

## 7. Context Budget (Direct Chat)

### 7.1 Where the context window limit is stored

Per-model, inside the `provider_configs.models` **JSON column** — not a dedicated DB column: `contextWindow` + `contextWindowSource` on `ModelOption` (`src/types/index.ts:91-93`); column added by migration `ADD COLUMN models TEXT` (`src/db/index.ts:349`); deserialized at `src/config/providers.ts:36-40`. Written by discovery (Anthropic-only today, `src/services/modelDiscovery.ts:145-153`) or a user-typed value (`source: "configured"`, `web/src/config/modelContext.ts:103-110`).

Read path before building a request — `src/context/assemble.ts:252-275`:
```ts
const selectedModel = selectModelOption(provider.models, modelId);
const observed = readObservedContextWindow({ providerId, modelId, endpoint, protocol });
const limit = resolveContextLimit({ providerType, modelId, model: selectedModel, observedContextWindow: observed?.limitTokens, ... });
const budget = computeBudget({ limit, modelOutputTokens: selectedModel?.maxOutputTokens });
```
A separate in-memory map holds provider-stated limits learned from overflow errors: `src/context/observed-limits.ts:66` (`new Map<string, ObservedContextWindow>()`, deliberately not persisted — module comment :12-21).

### 7.2 Pre-send fit check

Exists. `decideBudget` judges accept/advisory/reject on the measured request (`src/context/budget.ts:149-252`); `evaluateTier2` judges the universal ceiling (`src/context/tier2.ts:119-135`). Both run inside `assembleContext` **before** conversion/transport (`src/context/assemble.ts:354-373`; `sendable = decision.action !== "reject" && tier2.outcome === "within_assembly_limit"`, :378). The route enforces before `streamText` — `src/routes/chat.ts:759-805`: Tier-2 breach → 400 `ASSEMBLY_LIMIT_EXCEEDED`; `decision.action === "reject"` → 400 `CONTEXT_OVERFLOW`.

### 7.3 Fallback constant when no limit is known

`src/context/limits.ts:51`:
```ts
export const UNKNOWN_LIMIT_CEILING = 128_000;
```
Resolution falls to it with `source: "conservative_default"` (`src/context/limits.ts:238-246`). An unconditional secondary ceiling exists: `TIER_2_MAX_TOKENS = 4_194_304` (`src/context/tier2.ts:80`). The Code-surface ring resolver has its own copy: `DEFAULT_MODEL_CONTEXT_WINDOW = 128_000` (`web/src/config/modelContext.ts:42`).

### 7.4 Token counting method

Pre-request estimate = serialized character count / 3 chars-per-token (pessimistic). `src/context/measure.ts:46, 69-72`:
```ts
export const CHARS_PER_TOKEN_ESTIMATE = 3;
function tokenize(chars: number, charsPerToken: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / charsPerToken);
}
```
No tiktoken or provider tokenizer anywhere in `src/context/` (no such import). Provider usage readback is post-request and feeds the display meter, not the budget: `src/routes/chat-model.ts:116-146` (`occupancyKind: "provider" | "estimate" | "unknown"`), `buildChatMessageMetadata` :164-177. Overflow-rejected limits are additionally learned from provider error text: `src/lib/context-window-observation.ts:150-184`, called at `src/routes/chat.ts:1296-1315`.

---

## 8. Context Budget (OpenCode / Code Mode)

### 8.1 Where TBAi reads the context limit for the active OpenCode model

`web/src/features/opencode/OpenCodeContextRing.tsx:26-49`:
```tsx
const { models } = useOpenCodeCapabilities(true);
const current = extras.model
  ? models.find((m) => m.id === extras.model?.modelID && m.providerID === extras.model?.providerID)
  : undefined;
return <StandaloneRing modelContextWindow={resolveContextWindow({ limitContext: current?.limit?.context })} … />;
```
`models` come from `GET /api/opencode/capabilities` (`useOpenCodeCapabilities.ts:105`) — a backend pass-through of the OpenCode host's own `model.limit` (`src/services/opencode/capabilities.ts:27-30, 69-82, 276-284`). Resolution order: live host limit → configured model window → `DEFAULT_MODEL_CONTEXT_WINDOW = 128_000` (`web/src/config/modelContext.ts:42, 69-79`).

### 8.2 Does TBAi know when OpenCode is near its limit?

No. The only consumers of the window/usage pair are the ring display components. No threshold/pressure check exists (grep `threshold|pressure|near|remaining|headroom` in `web/src/features/opencode`: 0 matches). Post-compaction, the reading is explicitly `unknown` rather than a distance-to-limit (`web/src/features/opencode/codeOccupancy.ts:34-42, 62-85`).

### 8.3 Who decides when to compact in OpenCode mode — OpenCode itself

TBAi only observes server-published lifecycle events: `session.compaction.started/delta/ended/failed` in `PUBLIC_EVENT_TYPES` (`web/src/features/opencode/v2Events.ts:72-75`), dispatched as `compaction_running` / `compaction_settled` / `compaction_failed` (`v2ThreadController.ts:315-328`; comment :296-313 states OpenCode "publishes all three events"). OpenCode records its own compaction as a `type: "compaction"` message with `status` (`codeOccupancy.ts:21-28, 51-53`). No TBAi-side scheduling/triggering code exists for the Code surface.

### 8.4 Can TBAi trigger a manual compact?

Yes. `web/src/features/opencode/v2ThreadController.ts:828-835`:
```ts
async function compact(): Promise<void> {
  await awaitReady();
  …
  const result = await generation.operations.compact({ sessionID: client.sessionId, id, delivery: "steer" });
  dispatch({ type: "compaction_admitted", inbox: { … } });
}
```
`operations.compact` is the official client's `officialClient.session.compact` (`web/src/features/opencode/v2Client.ts:267-270`). Exposed to the composer via `V2RuntimeExtras.compact` (`v2RuntimeExtras.ts:32, 64`), wired at `OpenCodeView.tsx:270`, and logged via `runCompactSession` (`compactSession.ts:55-70`).

---

## 9. Compaction

### 9.1 Every place compaction is triggered

1. **Manual Direct `/compact` (aliases `/compress`)** — `src/routes/chat.ts:339-365` → `runManualCompaction` (`src/routes/direct-compact-command.ts:472-521`, `forceCompaction: true` at :495).
2. **Automatic pressure trigger** during ordinary-turn assembly — `src/context/assemble.ts:286-304` (`runCompactionPhase` → `maybeCompact` :540) when the measured total ≥ 80% of usable input: `triggerAt = floor(usableInputTokens * policy.triggerFraction)` (`src/context/compaction/contract.ts:605`), `DEFAULT_COMPACTION_POLICY.triggerFraction = 0.8` (`src/context/compaction/index.ts:84-90`). Divider published at `src/routes/chat.ts:738-749`.
3. **Provider-overflow recovery** — `src/routes/chat.ts:1326-1382`: `withOverflowRecovery` gate (`src/routes/direct-overflow-gate.ts:168-285`, max 2 attempts, `MAX_PROVIDER_ATTEMPTS` :52); its `recover()` calls `assembleForRequest({ forceCompaction: true })` (:1362-1382), decision policy `decideOverflowRecovery` (`src/context/recovery.ts`, wired :1343-1350).
4. **Replay of an existing durable record** on every turn — `applyExistingCompaction` (`src/context/compaction/orchestrate.ts:322-364`, called from `assemble.ts:519`) — re-applies without re-summarizing.
5. **OpenCode surface `/compact`** — local composer interception (`web/src/features/opencode/compactSession.ts:11-13`) → `v2ThreadController.compact()` → OpenCode's own compaction operation (see §8.4).

### 9.2 DB-transaction wrapping

No. Compaction persistence is two independent single-statement atomic writes, not a multi-statement transaction:
- the record: one `INSERT … ON CONFLICT(conversation_id) DO UPDATE … WHERE excluded.generation > …` (single upsert, generation-guarded) — `src/services/compaction.ts:116-156`;
- the divider row: one `messageService.upsertStored` — `src/routes/direct-compact-command.ts:320-342`.

`db.transaction` exists only in unrelated modules (`chat-streams/sqliteResumableStore.ts:527, 586, 593, 633, 872`, `src/services/todos.ts:58`, boot migration `src/db/index.ts:222-258`). No transaction wraps the compaction path.

### 9.3 DB tables touched

- `conversation_compactions` (`src/db/index.ts:58-76`, PK `conversation_id`).
- `messages` (`src/db/index.ts:171-184`) — the divider row, via `messageService.upsertStored` (`direct-compact-command.ts:327-333`).
No compaction path deletes or rewrites stored history messages.

### 9.4 In-memory runtime state after a DIRECT compaction

Not reloaded, not reset; left as-is plus a divider part. Messages are not removed from the thread or DB — compaction reshapes the *request* server-side; the transcript learns of it through the divider part:
- automatic/recovery: a live `data-tbai-compact` part appended to the in-flight response — `src/routes/chat.ts:712-736` (`compactionPart`) + durable row `chat.ts:648-699` (`publishCompactionDivider`).
- manual: the client appends an optimistic divider only — `web/src/components/Composer.tsx:588-625` (`aui.thread().append({ role: "assistant", content: [buildDividerPart(status)], startRun: false })`); the server-persisted row (`anchorMessageId`) is what a reload replays (`Composer.tsx:601-606` comment; `direct-compact-command.ts:288-300`).
- No `thread().reset()`/reload call exists anywhere in the compact path. Stale history stays in the thread until the next assembly re-applies the record server-side.

### 9.5 Tests for compaction correctness

`src/context/compaction/compaction.test.ts`, `seam.test.ts`, `runtime.test.ts`, `forward-progress.test.ts`, `stale-boundary.test.ts`; `src/routes/direct-compact-command.test.ts`; `web/src/features/chat/compactCommand.test.ts`, `manualCompactPersistence.test.ts`; `web/src/features/opencode/compactSession.test.ts`, `codeCompactConformance.test.ts`; `web/src/components/assistant-ui/elements/compaction-divider.test.tsx`; `tests/unit/compaction-log-guard.test.ts`; `tests/integration/direct-manual-compact.test.ts`, `direct-compaction-invariant.test.ts`.

**Stale-comment fact (as found):** `src/routes/direct-overflow-gate.ts:74-92` still says "THE ROUTE MUST NOT WIRE THIS GATE YET", but the gate **is** wired at `src/routes/chat.ts:1326`, where a newer comment explains why it is now safe ("measured, not assumed … upstream of the composition is the only place where the surviving attempt can be chosen").

---

## 10. Hono Server Health

- **10.1 Health check** — exists. `src/routes/index.ts:148`: `app.get("/api/health", (c) => c.json({ status: "ok" }));` plus `/healthz` (:219, plain "ok"), `/readyz` (:224-239, SQLite `SELECT 1` liveness, 503 on failure), `/metrics` (:241-247).
- **10.2 Concurrent-request tracking** — Yes. `http_requests_inflight` gauge (`src/services/http-metrics.ts:15-20`) incremented per request in `accountingMiddleware` (:71-83, `inflight++` … `finally inflight--`), mounted at `src/routes/index.ts:252`; drained at shutdown via `drainInflightRequests` (:88-93).
- **10.3 Request timeout** — Does not exist (no global per-request timeout; the nearest things are the 240s keep-alive idle backstop, `server-listener.ts:27,78`, and the per-chat-run 30-min wall clock, `chat-runs.ts:53`). No Hono timeout middleware is registered.
- **10.4 Maximum request body size** — Does not exist (no `bodyLimit`/payload middleware anywhere in `src`; the chat body schema is uncapped: `src/lib/validation.ts:57` `messages: z.array(z.unknown()).min(1, …)` with no `maxItems`).
- **10.5 Uncaught route errors** — global handler exists. `src/routes/index.ts:128-145`:
```ts
app.onError((err, c) => {
  …
  logger.error("http", "http.error", { requestId, …errorLogFields(err) });
  return c.json({ error: sanitizeStreamError(err), requestId, … }, 500);
});
```
Non-throwing ≥400 responses are centrally logged at :82-92.

---

## 11. Bun Runtime

- **11.1 Server configuration** — entry `src/index.ts:7-12` → `startServer` (`src/server.ts:46`); the serve call (`src/services/server-listener.ts:78`):
```ts
return Bun.serve({ fetch: requireFetch(), port, idleTimeout: LISTENER_IDLE_TIMEOUT_S });
```
with `LISTENER_IDLE_TIMEOUT_S = 240` (:27) and a boot bind self-heal scan of up to `HEAL_SCAN_LIMIT = 100` ports (:92-114).
- **11.2 Maximum concurrent connections** — Not configured. No connection-limit option on the `Bun.serve` call; none anywhere else in `src/`.
- **11.3 Memory limit** — Not configured. `package.json:9` runs `bun run src/index.ts` and `:11` compiles with `bun build src/index.ts --compile` (no `-sm` flag); the Tauri shell spawns the compiled sidecar with no args (`src-tauri/src/main.rs:336-355`).
- **11.4 Signal handlers** — `src/server.ts:36-43`:
```ts
process.on("SIGINT", () => {
  const server = getActiveServer();
  if (server) void shutdownServer(server, "SIGINT");
});
process.on("SIGTERM", () => { … shutdownServer(server, "SIGTERM"); … });
```
- **11.5 `uncaughtException` / `unhandledRejection`** — Does not exist. No such handlers anywhere in `src/` (the only other process hooks: `process.once("exit")` for the logger flush, `src/lib/logger.ts:929-930`, and the two signal handlers above). Rejections are contained locally (e.g. `trackRun` catch, `chat-runs.ts:233-242`), not globally.

---

## 12. Database

- **12.1 Pool vs single connection** — single shared connection, no pool. `src/db/index.ts:15` `const sqlite = new Database(DB_PATH);`, exported as the process singleton (`:606`). The module comment (:45-49) states the single synchronous `bun:sqlite` connection cannot self-contend.
- **12.2 Long-running queries / query timeout** — `busy_timeout` exists but only as a defensive 5s retry bound (`src/db/index.ts:50-51`):
```ts
const SQLITE_BUSY_TIMEOUT_MS = 5000;
sqlite.run(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);
```
The comment labels it "Defensive only … Not a shutdown mechanism." There is **no per-query abort or statement timeout** (bun:sqlite is synchronous; a long query blocks the thread — no guard is established).
- **12.3 WAL** — Enabled. `src/db/index.ts:18` `sqlite.run("PRAGMA journal_mode=WAL");`, paired with `synchronous=NORMAL` (:23), `cache_size=-65536` KiB (64 MiB, :25-28), `mmap_size=256` MiB (:31-32), `temp_store=MEMORY` (:36), `foreign_keys=ON` (:43).
- **12.4 Size ceiling / rotation** — No global ceiling or rotation for the main tables. Retention exists only for: `chat_streams`/`chat_stream_chunks` (24h TTL + hourly cleanup, `src/services/chat-streams/schema.ts:65-73`, `cleanup.ts:28,119`); `scheduler_runs` (30-day prune, `src/services/scheduler/schedulerStore.ts:501-518`); rotated log files (`maxMb`/`keepFiles`/`retentionHours`, `src/routes/logs.ts:48-54`). `messages`, `conversations`, `memories` have no size or rotation policy.
- **12.5 Largest expected growth** — `messages`. `messages.content` stores the full serialized assistant-ui JSON per turn (`src/db/index.ts:171-184`, format column :281) and is written on every chat response **and** every scheduled run (`schedulerExecution.ts:338-343` user prompt, :357-362 assistant reply, :411-417 error message — three inserts per run, plus dedicated `[Scheduler]` conversations :246-252), with no retention. Growth is effectively doubled because rows are mirrored (appended) into the FTS sidecar `conv_fts.content` by trigger `trg_msg_fts_ai` (`db/index.ts:428-433`). `chat_stream_chunks` grows fastest per request but is TTL-capped.

---

## 13. Frontend Performance

- **13.1 memo/useMemo/useCallback in high-frequency components**
  - `memo`-wrapped: `MarkdownText` (`web/src/components/assistant-ui/elements/markdown-text.tsx:84`), `Reasoning` (`reasoning.aui.tsx:84`), `MermaidDiagram` (`mermaid-diagram.aui.tsx:54` and `mermaid-diagram.tsx:396`), `LogRow` (`web/src/components/LogsPanel.tsx:197`).
  - `Composer.tsx` — `useMemo` only (:475, :484, :637); the component itself is not wrapped in `memo`.
  - Message-list items `UserMessage` / `AssistantMessage` — **not** memoized (`web/src/components/ChatWindow.tsx:216, 256`).
  - Tool card renderers — no `memo(` anywhere under `web/src/tools/**` (grep: 0 matches).
- **13.2 Message-list virtualization** — No. The list is assistant-ui's `ThreadPrimitive.Messages` with plain children (`web/src/components/ChatWindow.tsx:165-169`); no virtualizer is configured anywhere in `web/src` (grep `virtual|react-window|VirtualList` → only a comment in `ModelOptionList.tsx:21`, "virtualizer — plain scroll"). Whether assistant-ui's built-in `MessageList` virtualizes internally: **not established** from TBAi's code — TBAi configures nothing.
- **13.3 Re-renders per streaming chunk** (estimate from the component tree)
  - Direct chat: each chunk updates the assistant-ui runtime; because TBAi's message items are un-memoized, all N message items plausibly re-render per chunk, while the `memo`-ed leaf cards (MarkdownText/Reasoning/Mermaid) only re-run where their text changed. Plausible total: O(N messages) per chunk, not O(1).
  - Code mode is heavier by construction: each event dispatch mutates controller state → `useSyncExternalStore` (`web/src/features/opencode/v2Runtime.tsx:16-20`) → adapter rebuilt in `useMemo` (:21-24) → `useExternalStoreRuntime` re-created → the whole `AssistantRuntimeProvider` subtree re-renders. The codebase documents this: `v2Events.ts:128-132` ("allocating a fresh array here would … rebuild the assistant-ui adapter and re-render the whole transcript") — mitigated by no-op identity checks (`sameIdentitySequence`, :138-144).
- **13.4 Composer-input debouncing** — No. Composer text is persisted synchronously per keystroke: `web/src/components/Composer.tsx:432` → `writeComposerDraft` → `localStorage.setItem` (`web/src/features/chat/state/composerDraft.ts:37-48`, no timer). The only debounces in the app: sidebar search query (`web/src/features/desktop/state/desktopLayout.ts:86, 230`) and a scheduler schedule-sentence recompute (`JobEditor.tsx:326`).

---

## 14. OpenCode Event Pipeline

- **14.1 Transport** — SSE stream of the official `@opencode/client`, consumed per-event via async iteration: `web/src/features/opencode/v2Client.ts:178-210`:
```ts
const eventStream = officialClient.event.subscribe({ signal: connectionSignal });
const iterator = eventStream[Symbol.asyncIterator]();
```
The client targets the TBAi backend proxy (`OPENCODE_PROXY_BASE_URL`, `v2Client.ts:35, 137-152`); no WebSocket; no polling on the response path (polling appears only in the auxiliary resync, `useOpenCodeAuxiliaryResync.ts`).
- **14.2 Handler + per-event call chain** — the loop is `consumeEvents` (`web/src/features/opencode/v2ThreadController.ts:424-429`); the handler `applyEvent` (:405-422) calls, per event:
  1. `dispatch({ type: "v2_event", mode: "observe-only" })` (:406)
  2. hydration-buffering of assistant-message events (`eventBuffer`, :407-414, capped at `OPENCODE_V2_EVENT_BUFFER_LIMIT`) else `dispatch({ mode: "observe-and-apply" })` (:415/:418)
  3. `applyAdmissionEvent` (:330-355) → `dispatch("inbox_recorded")` + optional `dispatch("prompt_admitted")` + `rejectAdmission`
  4. `applyAutoApproveEvent` (:378-403) → `shouldAutoApprove` + fire-and-forget `replyToPermission` (not awaited)
  5. `applyCompactionLifecycleEvent` (:315-328) → `dispatch("compaction_running" | "compaction_settled" | "compaction_failed")`

  A typical event = 2 reducer dispatches + up to 3 more, conditionally.
- **14.3 Throttling / batching** — No application-level throttle or batch. Events are processed strictly sequentially, one `await` per event; no rAF/queue/microtask coalescing (grep `batch|throttl|requestAnimationFrame` in `web/src/features/opencode`: 0 hits outside test fixtures). The only buffer is the hydration buffer (512 entries, `web/src/config/opencode.ts:7`), flushed after history load — a re-ordering guard, not throttling.

---

## 15. What Does NOT Exist (explicit checks)

- **15.1 Centralized context-budget service across all models** — **No.** Budget logic exists only in the Direct assembly path (`src/context/`); the Code ring resolver is explicitly "Code-only" display resolution (`web/src/config/modelContext.ts:60-67`), and no budget is enforced for OpenCode sessions.
- **15.2 Session start/end lifecycle with explicit resource allocation + cleanup** — **No.** What exists: a per-request run registry with a 30-min wall clock (`src/services/chat-runs.ts:120-172`), an in-flight drain at shutdown (`src/services/http-metrics.ts:88-93`), and a frontend `controller.dispose()` on unmount (`web/src/features/opencode/useOpenCodeRuntime.ts:27-30`). No resource-allocation lifecycle.
- **15.3 CPU/memory resource governor per response** — **No.** (grep `heapUsed|resourceUsage|totalMemory` → only a system-memory report in `src/services/tools.ts:616`; no governor.)
- **15.4 Health monitor tracking app state (context pressure, connections, memory)** — **No.** `/metrics` exposes request totals, in-flight count, duration, and log-loss counters (`src/services/http-metrics.ts:15-61`) — no context pressure, no memory, no per-connection tracking.
- **15.5 Graceful degradation policy under load** — **No** load-shedding/slowdown policy. Nearest concept: an availability store "degraded" state that still allows sending (`web/src/runtime.ts:201-204`) — a reachability flag, not a load governor.
- **15.6 Circuit breaker for provider/MCP failures** — **No** breaker state machine. What exists: `DIRECT_MAX_RETRIES = 0` (`src/routes/chat.ts:100, 1070, 1083`), bounded MCP reconnect (`MAX_RECONNECT_ATTEMPTS = 5`, `src/services/mcp/manager.ts:624-642`), overflow recovery capped at 2 attempts (`src/routes/direct-overflow-gate.ts:52`).
- **15.7 Backpressure on the event pipeline** — **No.** The OpenCode event consumer is a sequential per-event `await` loop with no queue/credit mechanism (`web/src/features/opencode/v2ThreadController.ts:424-429`); the Direct stream has no backpressure knob (the overflow gate only *holds* lifecycle markers, `direct-overflow-gate.ts:171-268`).
- **15.8 Maximum message-history size enforced before context overflow** — **No** message-count cap. Enforcement is token-estimate-based: budget reject/advisory (`src/context/budget.ts:149-252`), the Tier-2 4,194,304-token assembly ceiling (`src/context/tier2.ts:80`), and the 80%-of-usable compaction trigger (`src/context/compaction/contract.ts:605`, `index.ts:84-90`). The request schema imposes no array bound (`src/lib/validation.ts:57`).

---

## Audit-caveat facts (as found, no interpretation added)

- `src/routes/direct-overflow-gate.ts:74-92` carries a stale module comment ("THE ROUTE MUST NOT WIRE THIS GATE YET") that contradicts the wiring at `src/routes/chat.ts:1326`.
- MCP `connections` entries are not removed on `disconnect`/give-up (see §6.4); their lifetime is process-lifetime until config deletion.
- Whether `shutdownServer` ever runs on a Tauri desktop quit is answered by code: it does not — `child.kill()` bypasses the signal handlers (§1.2).
- Items marked NOT ESTABLISHED above are absences of evidence on disk, not confirmed negatives: they mean the audit could not find the thing after targeted search, not that it is impossible.
