# State Management

Tiers, each with one job. Do not blur the boundaries. When unsure where a new
piece of state belongs, read §8 first.

## 1. Persistent data — SQLite (`bun:sqlite`)

Source of truth for anything that must survive reloads. Accessed only through the
backend (`src/db`, `src/services/*`); the browser never talks to the DB.

| Table group | Route prefix | Client cache |
|---|---|---|
| providers (`provider_configs`) | `/api/providers` | `useSettingsStore` |
| memories | `/api/memories` | `useMemoryStore` |
| conversations + messages | `/api/conversations`, `/api/chat` | assistant-ui runtime + sidebar hooks |
| folders / folder groups / links | `/api/folders` | `useFoldersStore` |
| quick messages | `/api/quick-messages` | `useQuickMessagesStore` |
| MCP servers (`mcp_servers`) | `/api/mcp` | `useMcpStore` |
| scheduler jobs + runs | `/api/scheduler` | `useSchedulerStore` |

## 2. Shared client state — Zustand

**Zustand is not the persistence layer.** It holds (a) caches/mirrors of server
data and (b) UI state more than one component needs. Never secrets.

There are 14 stores. Seven live in `web/src/stores/`, the rest are owned by the
feature they serve (`web/src/features/<name>/`).

### 2a. Server-mirror caches

Refetched from the API; the server wins. Every one retains the previous value on
a failed load — an outage must never render as "you have no data".

| Store | Holds | Failure behaviour |
|---|---|---|
| `useSettingsStore` | provider list (no keys), `activeProviderId` | retains previous list (`loadProvidersRetention.test.ts`) |
| `useMemoryStore` | memory list, in-flight `newMemory` draft | replaced on success |
| `useFoldersStore` | folders, groups, `selectedFolderId`, `folderExpanded`, `foldersLoaded` | `foldersLoaded` distinguishes "unknown" from "none"; stale responses dropped by load epoch |
| `useMcpStore` | `servers[]`, `pendingInsert` (composer insert queue) | throws with `requestId` attached |
| `useQuickMessagesStore` | `messages[]`, page error | mutations return `{ok, error}`; only `load()` drives the banner |
| `useSchedulerStore` | jobs, `runsByJob`, `recentRuns` | error string surfaced on the page |
| `useCommandsStore` | OpenCode `/` command feed | TTL + single-flight; retains list on failure |

`pendingInsert`, `newMemory` and the per-store `loading` / `error` flags are UI
concern and live beside the data because several components read them.

### 2b. Ephemeral UI state (never persisted, never mirrored)

| Store | Holds | Why a store and not `useState` |
|---|---|---|
| `useChatTabsStore` | open tabs, `activeKey`, `groupId` | read by the tab strip, `TabUrlSync`, the composer and the delete flow |
| `useWelcomeEngineStore` | draft engine / agent / model / variant / `autoApprove` | read by the welcome screen and `materializeDraft` |
| `useWelcomeScopeStore` | draft workspace `{mode, folderId}` + quick-action tab | read by the welcome screen and `materializeDraft` |
| `useStreamRecoveryStore` | per-thread "may I re-send this run?" verdict | written by the transport, read by the in-thread recovery strip |
| `useAvailabilityStore` | backend reachability + `recoveryEpoch` | one authority; also owns the single `/readyz` poller and the central recovery fan-out (`features/availability/recovery.ts`) |
| `useStalePermissionsStore` | permission ids the OpenCode server no longer holds | written by a failed approval reply, read by every approval surface |
| `useDesktopLayout` | sidebar/statusbar visibility, widths, sort, section order | read across the whole chrome; persists (§2c) |

`useAvailabilityStore` is the only store that owns a timer. It is the one place
that decides "the backend is down" — no other module infers liveness from a
failed request, and ordinary 4xx responses never enter `offline`.

### 2c. Client-side durable preferences (localStorage)

Device-scoped UI preferences that must survive a restart. These are not SQLite:
they are not application data and no server route owns them.

| Owner | Keys | Notes |
|---|---|---|
| `useDesktopLayout` (`zustand/middleware` `persist`) | `tbai:desktopLayout` | versioned (`STORE_VERSION` + `migrate`); `partialize` excludes transient search UI |
| `useChatTabsStore` | `tbai:openTabs` | a set of *references* into SQLite, reconciled at boot (§4) |
| `useWelcomeEngineStore` | `tbai:welcome-engine` | `autoApprove` survives an engine switch by design |
| `useWelcomeScopeStore` | `tbai:welcome-scope`, `tbai:quick-actions-tab` | key names come from `config/welcome.ts` |
| `useFoldersStore` | `tbai:selectedFolder`, `tbai:folderExpanded` | selected id is pruned against the live folder list |

Rule for anything added here: a corrupt or unreadable payload falls back to
defaults **field by field** and never throws into render. Several keys predate
their current shape and carry repair paths (`healTab`, `migratePersisted`) — do
not delete those branches.

### 2d. Plain-module client state (no store)

Deliberately not Zustand: either a single-value cache no other module reads, or a
protocol helper. Adding a store here would be framework multiplication.

| Module | Holds | Lifetime |
|---|---|---|
| `chat/state/composerDraft.ts` | unsent composer text per thread | localStorage `tbai:composer-draft:<key>`; cleared on send/clear |
| `chat/state/pendingFirstMessage.ts` | one-shot first-prompt handoff | localStorage `tbai:pending-first-prompt:<id>`; claimed-then-consumed, idempotent |
| `chat/state/resumable-stream.ts` | Direct run stream pointer | sessionStorage via `createResumableSessionStorage` (`tbai-resume:<thread>`) + a module-level `lastKnownStreamId` map |
| `appearance/theme-storage.ts` | mode + per-mode palette | localStorage `tbai-theme`, `tbai-theme-light`, `tbai-theme-dark` |
| `config/navigation.ts` | last visited settings route | localStorage `tbai:settingsRoute` |
| `desktop/state/serverIdentity.ts` | server port / reachability | React local state + poller (one consumer, not shared) |
| `features/scheduler/SchedulerPage.tsx` | `tbai:schedSeenTs` badge timestamp | localStorage, page-local |

Composer drafts and pending first prompts hold message text only — never
credentials.

### 2e. Functions and hooks that are not stores

`conversationExistence.ts` (the 2xx / 404 / other verdict contract),
`conversationMutations.ts` and `deleteConversation.ts` (domain operations),
`materializeDraft.ts` (draft → conversation owner), `tabReconciliation.ts` (boot
convergence) and `useConversationTab.ts` (route → tab binding) are functions and
hooks. They read stores; they do not become stores.

## 3. State the app does not own

### Conversation and message state — assistant-ui runtime

**Conversation and message state is NOT in Zustand.** `RemoteThreadListRuntime` +
`ThreadHistoryAdapter` own the thread list, selection and thread messages,
persisting through the backend HTTP adapters. A second conversation/message store
was deliberately removed to avoid duplicating what the runtime already manages —
the minimum-custom-code choice. Context/usage are read back off the runtime
(`useAuiState`) rather than recomputed or cached
(`features/chat/context/useCurrentContext.ts`).

### Code-mode OpenCode state — V2 controller

Code-mode OpenCode state is isolated under `web/src/features/opencode/`.
`V2ThreadState` is the normalized session model; the controller owns its
lifecycle and publishes snapshots through `useSyncExternalStore`. The
assistant-ui external-store repository is a projection, not a second message
store. Event identity, inbox admission, execution, recovery, permissions, forms,
and todos remain distinct state dimensions. Prompt admission preserves the
preallocated local `msg_...` identity when the inbox event arrives before the
prompt HTTP response; the later response is idempotent. An ambiguous prompt
remains reconciling until an inbox/history signal or disposal settles it. Inbox,
permission, and form snapshots are auxiliary hydration: a failure is logged
with sanitized fields and starts empty, while later events repopulate the
projection. The browser does not persist OpenCode wire events in Zustand or SQLite;
permissions are server-memory only, which is why `useStalePermissionsStore` exists.

### Draft materialization

`materializeDraft.ts` is the single owner of draft → conversation binding. It
captures the welcome-engine snapshot ONCE per send, so the engine chosen stays
stable for that first send and no mutable store is re-read after the decision.
`useChatTabsStore.resolveDraftId` then binds the tab using that recorded engine.

## 4. The persisted tab mirror is a cache, not data

`tbai:openTabs` holds references into SQLite and converges in two places:

- **Write side:** the in-app delete flow, via `closeByRef`.
- **Read side:** boot `reconcileTabMirror()` in `tabReconciliation.ts` —
  removal-only. `exists` has no write path at all and `unknown` has none either,
  so a stale or late response can neither resurrect a tab nor erase one. Only a
  proven 404 may evict.

`DELETE /api/conversations/:id` is a public REST contract also called by the e2e
cleanup and the scheduler, so a tab can outlive its row. Never add a write path
to the reconciliation pass.

## 5. Per-conversation AI config (three tiers — do not blur)

The conversation's AI config (provider / model / reasoning level) lives in exactly
three places, each with one job:

| Tier | Where | Role |
|---|---|---|
| **Source of truth** | SQLite `conversations.provider_id` / `model_id` / `reasoning_level` | The persisted conversation default. Owns the config across reloads; the only durable copy. |
| **Runtime projection** | `threadListItem.custom` (via `remoteThreadListAdapter`) | A live read of the SQLite row projected into the assistant-ui runtime; written back through `updateCustom` (PATCH). It is a mirror, not a store — it must never diverge from SQLite. |
| **One-shot overrides** | Zustand `selectedProviderId` / `selectedModelId` / `selectedReasoningLevel` | The composer picker's choice for the **next send only**. Cleared via `revertChatTarget` after the transport consumes them. Never the source of truth, never persisted. |

Effective resolution (`src/routes/chat-model.ts`, mirrored in `web/src/runtime.ts`):
`one-shot override → threadListItem.custom (conversation default) → global active
provider default`. Zustand holds the overrides only; the conversation default is
always read from SQLite.

The same three-tier rule applies to the OpenCode draft config (agent / model /
variant / autoApprove): draft snapshot in `useWelcomeEngineStore` → materialized
into the conversation row at first send → `conversation.opencode*` columns from
then on.

## 6. Component-local state — React `useState`

Anything used by a single component (input text, open/closed flags, local loading,
one surface's fetch state such as `useServerIdentity`) stays as React local state.
Do not promote it to Zustand.

## 7. Memory separation

Three things that are easy to conflate:

- **Conversation history** — SQLite + assistant-ui history adapters. Model-visible
  per turn.
- **Durable memory** — ICM, behind TBAi's `MemoryService`; its database is
  authoritative and the schemas are never merged.
- **Transient UI state** — Zustand, localStorage, React.

Memory is not "working" because it is stored; it is working only when it is
retrieved and supplied to the model.

## 8. Rules

- Zustand is **not** the database. The backend stays authoritative; reload from
  the API when needed (`loadProviders`, `recoveryEpoch` refetches).
- Conversation/message state belongs to the runtime. Do not add a second store.
- Never store secrets (API keys, MCP auth tokens) in any client store, in
  localStorage, or in a persisted Zustand slice.
- Prefer React local state over Zustand for component-scoped values; prefer a
  plain module over a store when nothing else reads it.
- Every persisted client key is total on read: bad payload → defaults, never a throw.
- New backend-owned list? Follow the `quickMessagesStore` shape (`load` with a
  `silent` option, `{ok, error}` mutations) and mirror nothing the server owns.

