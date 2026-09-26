# State Management

Three tiers, each with a single responsibility. Do not blur the boundaries.

## 1. Persistent data — SQLite (`bun:sqlite`)

Source of truth for anything that must survive reloads:
- providers (`provider_configs`)
- conversations + messages
- memories

Accessed only via the backend (`src/db`, `src/services/storage`). The browser never
talks to the DB directly.

## 2. Shared client / UI state — Zustand

`web/src/stores/index.ts` holds **only** state that multiple components share and
that is a cache/mirror of server data, not the persistence layer:

- `useSettingsStore` — provider list (without keys), active provider id, settings.
- `useMemoryStore` — memory list, create/delete.

**Conversation and message state is NOT in Zustand.** The assistant-ui runtime
(`RemoteThreadListRuntime` + `ThreadHistoryAdapter`) owns the thread list, selection,
and thread messages, persisting them to SQLite through the backend. A second
conversation/message store was deliberately removed to avoid duplicating state the
runtime already manages. This is the minimum-custom-code choice — the library owns
chat message state; the app only provides thin HTTP adapters. See `architecture.md`
(Conversation persistence) and `decisions.md`.

## OpenCode V2 runtime state

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
projection. The browser does not persist OpenCode wire events in Zustand or
SQLite.

### Per-conversation AI config (three tiers — do not blur)

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

## 3. Component-local state — React `useState`

Anything used by a single component (input text, open/closed flags, local loading)
stays as React local state. Do not promote it to Zustand.

## Rules

- Zustand is **not** the database. It is a client cache; the backend remains
  authoritative. Reload from the API when needed (`loadProviders`, etc.).
- Never store secrets (API keys) in any client store.
- Prefer React local state over Zustand for component-scoped values.
