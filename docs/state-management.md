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

## 3. Component-local state — React `useState`

Anything used by a single component (input text, open/closed flags, local loading)
stays as React local state. Do not promote it to Zustand.

## Rules

- Zustand is **not** the database. It is a client cache; the backend remains
  authoritative. Reload from the API when needed (`loadProviders`, etc.).
- Never store secrets (API keys) in any client store.
- Prefer React local state over Zustand for component-scoped values.
