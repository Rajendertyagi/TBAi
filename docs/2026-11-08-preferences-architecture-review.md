# TBAi Shared Workspace Preferences — Final Consolidated Replacement Plan

**Document status:** Clean consolidated replacement plan and **implementation baseline** (subject to explicit approval). Supersedes the prior 909-line draft and all earlier revisions for implementation purposes.  
**Authorization:** **IMPLEMENTATION NOT AUTHORIZED — pending explicit approval.** No code changes, no commits/pushes, no destructive Git operations, no worktrees/branches created by this plan.  
**Baseline (verified):** `D:\Temp\ai-chat-app`, `develop` @ `7407d49ccdd4bd4c3c70d72eeef472593c81e8b6`, uncommitted WIP present. Preserve all existing WIP, untracked audit docs, `stash@{0}` (`07c928ae2795c4e5e0cc6e8bfa2a9daf3a5bab9a`), and the backup/artifact paths named in the project checkpoint. Do not include unrelated audit docs in product changes.

---

## 1. Executive decisions (normative)

| # | Decision | Normative rule |
|---|---|---|
| 1 | **Fresh settings only** | No migration of old TBAi preferences. No reading old TBAi localStorage keys to initialize SQLite. No `localPortablePrefs.ts`, no seed-if-absent, no legacy preference transfer, no migration ordering/race handling, no migration receipts/initialization flags/versions/compatibility frameworks, no startup wizard/conflict/override dialog. Old local keys **must not** be migration sources and their values **must not** be transferred into SQLite: `tbai-theme`, `tbai-theme-light`, `tbai-theme-dark`, `tbai-typography`, `tbai:desktopLayout` (shared fields), `tbai:welcome-scope`, `tbai:welcome-tab`, `tbai:welcome-engine` (shared `engine`), `tbai:selectedFolder`, `tbai:folderExpanded`, `tbai:openTabs`. Preserve unrelated active-feature local storage (composer drafts, pending first-message handoff, resumable streams) and genuinely device-specific settings. |
| 2 | **SQLite sole authority for shared portable settings and shared tabs** | Shared portable settings load from SQLite. **SQLite is the sole authority.** `localStorage` is **never** a migration source or authority for shared portable settings. **Appearance pre-paint cache (narrow, non-authoritative):** before the first paint, the `web/index.html` pre-paint script may read cached appearance keys (`tbai-theme`, `tbai-theme-light`, `tbai-theme-dark`, `tbai-typography`) only as a **temporary visual hint** to prevent white flash/typography layout shift. The cache is **never** an authority or a source for SQLite. **Before React hydration, application state uses application defaults** (not cache values as authority). Once authoritative SQLite state loads, its values **replace** cache-derived visuals/state even when they differ. **Only after receiving authoritative SQLite state** may the application update the appearance cache (write-through mirror of authoritative state only). Cache values must never seed SQLite, and stale cache values must never override authoritative SQLite. **All other shared portable fields:** prohibit localStorage reads for initial render and prohibit localStorage writes/persistence. Local persistence retained only for genuinely device-specific settings and active-feature local storage. No cache-versioning framework. |
| 3 | **No shared active pointer / no activation** | Remove `sharedActiveConversationId` completely. Remove activation endpoint/service/actions/indicator/state/UI/tests (`POST /api/preferences/tabs/activate`, `activateSharedTab`, `requestSharedActivate`, `SharedActivationIndicator`). Active conversation/navigation is strictly per-window local. |
| 4 | **Legacy Import Open Tabs removed completely** | Remove the retired `tbai:openTabs` browser-tab migration into shared SQLite tabs: `LegacyTabImportDialog`, `LEGACY_OPEN_TABS_STORAGE_KEY`/`readLegacyOpenTabs` authority, `POST /api/preferences/tabs/import-legacy|mark-initialized`, `importLegacySharedTabs`/`markSharedTabsInitialized`, `sharedTabImportLegacyBodySchema`, `sharedTabsInitialized` product behavior, and migration logic solely for this feature. No replacement, no reviewed import selection, no one-time import flow. |
| 5 | **OpenCode Import Chat preserved completely (separate capability)** | Do not remove, disable, simplify, or break. Preserve: `web/src/features/opencode/OpenCodeImportDialog.tsx`, `web/src/features/opencode/opencodeImportApi.ts`, Sidebar import entry (`web/src/components/Sidebar.tsx`), `GET /api/opencode/importable`, `POST /api/opencode/import` (`src/routes/opencode.ts`), `src/services/opencode/import.ts` (`listImportableOpenCodeSessions`, `importOpenCodeSession`, `encodeSourceRef`/`decodeSourceRef`), OpenCode runtime/client/history-boundary/error/route/proxy infrastructure, and conversation-service deps used by it (`listImportedOpenCodeSessionIds`, `findByOpenCodeSession`, `create`). Must discover/import existing OpenCode sessions created outside TBAi, never opened/started in TBAi. Completely separate from Legacy Import Open Tabs. |
| 6 | **Preserve data and active functionality** | **Never delete conversations, messages, or history.** Preserve any valid existing workspace snapshot/shared-tab data if present. **Do not import old localStorage tab lists. Do not introduce a destructive database migration.** Preserve existing Settings functionality, normal conversation history/creation/storage services, composer drafts/pending first-message handoff/resumable streams, device-specific persistence (window geometry, native zoom `tbai-window-zoom`, sidebar pixel width `sidebarWidth` only), credentials/secrets secure handling, OpenCode `autoApprove` local/fail-closed, and any shared service still used by active functionality. |
| 7 | **No unrelated refactoring** | No broad rewrites. Every deletion requires verified dependency analysis. |

---

## 2. Target architecture (normative)

### 2.1 Authority and boundaries
- **SQLite `app_settings` snapshot** `workspace.preferences.snapshot` is the single source of truth for shared tabs + allowlisted portable preferences.
- **One typed `WorkspacePreferencesService`** owns read/normalize/validate/mutate/CAS/SSE notification. Strict validation for active canonical fields.
- **REST (preferences + explicit tab intents):** `GET /api/preferences`, `GET /api/preferences/stream`, `PATCH /api/preferences`, `POST /api/preferences/tabs/open|close|close-batch|reorder`. **No** activate, import-legacy, mark-initialized, migrate/portable, or profile endpoints.
  - `GET /api/preferences` → authoritative snapshot (or canonical defaults for absent row; explicit error for corrupt row).
  - `GET /api/preferences/stream` → SSE invalidation only. Event: `preferences.changed` with `{ revision: number, originWindowId?: string }`. Clients coalesce/debounce refetch triggers (e.g. ~50ms) to avoid wake/reconnect storms; use exponential backoff on EventSource disconnect/reconnect (e.g. 1s–5s). If `originWindowId` matches the local window id, the originating window may skip the redundant refetch and rely on the mutation response / known revision (it must still accept newer revisions from other windows).
  - `PATCH /api/preferences` → `{ baseRevision: number, patch: <allowlisted portable preference patch>, originWindowId?: string }` (CAS). **Settings only** (allowlisted portable preferences: `appearance`, `desktop`, `welcome`, `navigation` as defined). **`PATCH` must not be used for `sharedTabs` membership mutations**; tab membership changes use the explicit intent endpoints below. **Nested merge semantics:** supplied preference fields are merged at the **allowlisted leaf-field level**; omitted fields remain unchanged. Example: updating only `appearance.themeMode` preserves `appearance.lightTheme`, `appearance.darkTheme`, and `appearance.typography`. `sharedTabs` is never patched via this endpoint (explicit tab intents only). Server validates the merged result against the canonical schema.
  - `POST /api/preferences/tabs/open` → `{ conversationId: string, kind: "chat" | "agent", baseRevision: number, originWindowId?: string }`. Server appends `{ ref: conversationId, kind }` if not present (idempotent for already-present tab), validates shape/constraints, applies atomically.
  - `POST /api/preferences/tabs/close` → `{ conversationId: string, baseRevision: number, originWindowId?: string }`. Server removes the tab if present (idempotent if absent from authoritative membership).
  - `POST /api/preferences/tabs/close-batch` → `{ mode: "others" | "right" | "all", anchorConversationId?: string, baseRevision: number, originWindowId?: string }` (`anchorConversationId` required for `others`/`right`). Server computes the result relative to authoritative state inside the transaction.
  - `POST /api/preferences/tabs/reorder` → `{ conversationId: string, toIndex: number, baseRevision: number, originWindowId?: string }`. Server reorders within authoritative state.
  - **Why explicit tab intents (durable):** clients send intent, not a stale full `sharedTabs` array; server computes/validates against authoritative state atomically. This reduces client-side stale-array overwrite risk and keeps contracts clear. **CAS still applies** (single workspace `revision`): concurrent mutations may still produce `409`; stale `409` never auto-retries with fresh revision, client refreshes authoritative state and requires a new explicit user action where appropriate.
  - All mutations are transactional CAS operations; stale `baseRevision` => `409` authoritative `{ conflict, revision, snapshot }`, no auto-retry with fresh revision. Exact Zod schemas finalized in implementation (strict, allowlisted). Mutation responses should return the authoritative snapshot/revision so the originating window can apply it without a redundant refetch.
- **SSE:** invalidation only (`preferences.changed` with `revision` and optional `originWindowId`) after successful commit. Clients refetch authoritative snapshot; ignore stale/duplicate revisions; coalesce/debounce refetch triggers (~50ms) and use exponential backoff on disconnect/reconnect (1s–5s); refresh on reconnect/focus/visibility. Originating window may skip redundant self-refetch when it already has the authoritative mutation response. **Never** changes local route/active/focus/drafts.
- **CAS:** one workspace `revision` + transactional compare `baseRevision`. Stale mutation => no write, `409` authoritative `{ conflict, revision, snapshot }`. **No automatic stale-write retry with a newer revision.** No silent overwrite/partial apply/revision substitution. Client refreshes, preserves local work, requires a new explicit user action.
- **Local/per-window only:** active conversation/route/URL, local draft, detached markers, focus/scroll/IME/transient UI. No implicit shared-tab creation via routing/hydration/sync/runtime init. `TabUrlSync` local-only. `IndexRedirect` deterministic local fallback only after hydration.
- **OpenCode Import Chat:** unchanged `/api/opencode/importable|import` capability and dependencies; independent of preferences migration and Legacy Import Open Tabs removal.

### 2.2 Retained technical safeguards (normative, from verified research)
Retain and implement these safeguards; do not discard them:
- **SQLite/app_settings architecture** for the workspace preferences snapshot.
- **Single workspace `revision` + transactional CAS** for all shared mutations.
- **REST + SSE invalidation/refetch** (invalidation only; authoritative refetch), with coalesced refetch/debounced triggers and reconnect backoff; optional `originWindowId` to avoid redundant self-refetch. `PATCH` for settings only; explicit tab intent endpoints for shared tab membership.
- **Per-window URL and active conversation**; remote shared updates never steal route/focus/drafts.
- **Detached conversation behavior:** if a shared tab is removed remotely while a window is viewing it, that window remains on the conversation, keeps route/UI state intact, presents it as detached/local, and **must not** silently re-add it. Only an explicit user action can add it back. Reconnect/refresh/reload must not re-add it.
- **Confirmed-gone vs unknown handling (exact rules):** distinguish authoritative “not in shared membership” from transient/unknown states; do not guess.

  | Backend/result condition | Required behavior |
  |---|---|
  | Successful `2xx` | Conversation exists. |
  | `404` | Conversation is **confirmed gone**. |
  | Network error, timeout, or `5xx` | **Unknown**; preserve conversation and runtime state. Never treat as gone. |

  **Removing a conversation from shared-tab membership must never be interpreted as deleting that conversation.** Only an actual deletion or a **confirmed-gone** result may trigger destructive local cleanup. This is critical for detached conversations and message/runtime preservation.
- **Draft materialization and first-message safety:** local drafts remain local; first-message/send flows must not create duplicate conversations/messages or implicitly create shared membership except through explicit, authorized shared mutations.
- **Direct/OpenCode coordination:** preserve existing engine boundaries and OpenCode runtime/history behavior; OpenCode Import Chat remains native/attached as designed.
- **Delayed add-vs-close race protection:** failed shared-tab insertion must not leave phantom shared state; delayed/stale operations must not resurrect closed tabs. Use revision/CAS/authoritative refetch and ignore stale results; never apply stale mutations.
- **Loopback/backend identity research:** retain as verified context where relevant to multi-client/backend identity; do not reintroduce shared localStorage authority.
- **Dead-code removal and dependency audit:** mandatory after approved removals (§8).

### 2.3 Direct and OpenCode shared-membership integration points (normative)
Conversation creation and first-message delivery **must not depend** on shared-tab insertion.

- **Direct:** trigger shared membership insertion **after** `remoteThreadListAdapter.initialize()` returns the canonical conversation ID.
- **OpenCode:** trigger shared membership insertion **only after** `setPendingFirstMessage()` successfully stages the first-message handoff.
- **Neither operation** runs inside `AppShell.handleThreadIdChange()`.
- **Membership failure must not fail** conversation creation or first-message delivery.
- **Retrying membership** reuses the existing conversation ID and **must never** recreate a conversation or resend the first message.
- Shared-tab insertion is a separate, non-blocking (with respect to creation/delivery success) operation after the canonical ID/handoff preconditions are satisfied; failure is handled via §2.4 recovery.

### 2.4 Delayed add-vs-close and membership failure recovery (normative)
**Delayed add-vs-close (no tombstones, no operation-ticket framework, no additional revision clocks):**
1. Serialize shared mutations within the same window.
2. A delayed add must not override a later explicit close.
3. A stale `409` must never automatically retry with a fresh revision.
4. On stale `409` (or authoritative state showing the close won): refresh authoritative state and preserve the close.
5. Only a new explicit user action can add the conversation again.
6. Membership recovery is separate from conversation creation and first-message recovery.

**Membership failure recovery (minimal, no new recovery framework):**
- Capture failed non-awaited membership operations independently.
- Keep transient failure state **per window**, keyed by conversation ID.
- Provide an explicit retry action.
- Retry only the shared membership operation.
- Do not persist temporary error indicators and do not build a new recovery framework.

---

## 3. Canonical snapshot, defaults, and validation

### 3.1 Canonical shared portable defaults (backend registry = source of truth)
| Field | Exact default |
|---|---|
| `revision` (absent representation) | `0` |
| `sharedTabs` | `[]` | Canonical type: `Array<{ ref: string; kind: "chat" | "agent" }>` (real conversations only, ordered; `ref` = conversation ID). |
| `appearance.themeMode` | `"system"` |
| `appearance.lightTheme` | `"default"` |
| `appearance.darkTheme` | `"default"` |
| `appearance.typography` | `"default"` (sentinel; app uses `DEFAULT_TYPOGRAPHY`) |
| `desktop.sidebarVisible` | `true` |
| `desktop.statusBarVisible` | `true` |
| `desktop.chatWidth` | `"comfortable"` |
| `desktop.sidebarSort` | `"updated"` |
| `desktop.sectionOrder` | `[]` stored; effective order per §3.2 |
| `desktop.sectionCollapsed` | `{}` |
| `desktop.showCompleted` | `false` |
| `desktop.spellCheck` | `true` |
| `welcome.engine` | `"direct"` |
| `welcome.quickActionTab` | `"coding"` |
| `welcome.scopeMode` | `"simple"` |
| `welcome.folderId` | `null` |
| `navigation.selectedFolderId` | `null` |
| `navigation.folderExpanded` | `{}` |

**Not in canonical target:** `sharedActiveConversationId`, `migration`, `sharedTabsInitialized`, `portablePrefsInitialized`, receipts, `profileId`, `migrationEpoch`, activation/import-legacy/migrate state.

### 3.2 `sectionOrder` — deterministic, strict, canonical (one implementation semantics)
| Stored `desktop.sectionOrder` value | Behavior |
|---|---|
| Missing / `undefined` / `null` / empty array `[]` | Effective order = `["folders","chats"]` (`DEFAULT_SECTION_ORDER` / `SIDEBAR_SECTION_IDS`). |
| Array of valid known section ID strings | Deduplicate (preserve first occurrence order), append missing known IDs in `DEFAULT_SECTION_ORDER` → full deterministic permutation. |
| Non-array | **Explicit corruption/validation error.** |
| Array with invalid element types | **Explicit corruption/validation error.** |
| Array containing unknown section IDs | **Explicit corruption/validation error.** Reject; do not silently drop/hide invalid data. |

Backend and frontend **must not disagree**. Parity is required and tested.

### 3.3 Snapshot states (must not be conflated)
| State | Read | Mutation |
|---|---|---|
| **No row** | Return canonical defaults (valid uninitialized). No migration/seeding/init marker. | Normal legitimate CAS mutations may create/update snapshot. No unnecessary default write. |
| **Valid row** | Parse/normalize; return authoritative saved preferences. | Normal CAS mutations allowed. |
| **Invalid/corrupt row** (malformed JSON, invalid active canonical fields including invalid `sectionOrder`, unreadable/unsafe snapshot) | **Explicit error** (not defaults). Preserve existing row unchanged. | **Block unsafe overwrite.** Mutations depending on authoritative snapshot fail safely with explicit error until resolved by an approved repair path. No silent repair, no destructive rewrite. |

Obsolete legacy JSON fields may be ignored/stripped on read only (**no behavior restore**). **Do not weaken validation for active canonical fields.**

---

## 4. Shared vs local persistence (normative)

### 4.1 SQLite authority; prohibit local persistence for shared portable fields (with narrow pre-paint cache exception)
- **`web/src/features/appearance/theme-storage.ts`:** SQLite is authoritative for shared theme settings. `localStorage` keys `tbai-theme`, `tbai-theme-light`, `tbai-theme-dark` may be read by the `web/index.html` pre-paint script only as a **temporary visual hint** before first paint (to prevent white flash). They are **never** an authority or a source for SQLite. **Before React hydration, application state uses application defaults** (not cache values as authority). Once authoritative SQLite state loads, its values replace cache-derived visuals/state even when they differ. **Only after receiving authoritative SQLite state** may the application update these keys as a passive write-through mirror of authoritative state. Cache values must never seed SQLite; stale cache values must never override authoritative SQLite.
- **`web/src/features/appearance/typography.ts`:** SQLite is authoritative for shared typography. `localStorage` key `tbai-typography` follows the same pre-paint temporary visual hint / post-authoritative write-through-only rules (prevents typography layout shift in `web/index.html`).
- **`web/src/features/desktop/state/desktopLayout.ts`:** persist **only `sidebarWidth`** locally. Shared desktop fields (`sidebarVisible`, `statusBarVisible`, `chatWidth`, `sidebarSort`, `sectionOrder`, `sectionCollapsed`, `showCompleted`, `spellCheck`) must not be hydrated from old cached values and must not be written as shared persistence.
- **`web/src/features/chat/state/welcomeScope.ts`:** shared `quickActionTab`/`scopeMode`/`folderId` use SQLite, not localStorage.
- **`web/src/features/chat/state/welcomeEngine.ts`:** shared `engine` uses SQLite, not localStorage. Local draft `agent`/`model`/`variant` may remain local; `autoApprove` remains local/fail-closed, never shared.
- **`web/src/features/folders/state/foldersStore.ts`:** shared `selectedFolderId`/`folderExpanded` use SQLite, not localStorage.
- **All other shared portable settings (non-appearance):** prohibit localStorage reads for initial render and prohibit localStorage writes/persistence. Defaults before hydration; authoritative SQLite after hydration; stale local state must not appear or overwrite.

### 4.2 Retain local/device/active-feature persistence
- Device-specific: window geometry (OS/Tauri), native zoom `tbai-window-zoom`, sidebar pixel width `sidebarWidth`.
- Active-feature local storage: composer drafts, pending first-message handoff, resumable streams.
- Local/per-window runtime: active route/URL, local draft, detached markers, focus/scroll/IME/transient UI.
- Security/local-only: credentials/secrets backend-encrypted handling; OpenCode `autoApprove` local/fail-closed.

---

## 5. Complete Settings inventory (owner, save behavior, default)

| Control / area | Persistence owner | Save/update behavior | Default | Class |
|---|---|---|---|---|
| Startup — “Start TBAi with Windows” | **OS registration** (Tauri autostart) | Toggle → set → re-read OS state; UI reflects actual OS state | OS state | Device/OS |
| Server — port, Save/Test/Restart | **Backend/runtime config + server identity** | Explicit `POST /api/server/port|check-port|restart`; reload identity | backend/runtime | Backend/runtime |
| Quit — Quit TBAi | **Tauri command** | `invoke("quit_app")` (desktop) | n/a | Device action |
| Providers — list/add/edit/delete/activate, credentials | **Backend provider config/DB; credentials encrypted backend-side, never shown to browser, never in workspace prefs** | Existing provider APIs | no providers / backend-defined | Backend config + secret |
| MCP — servers/config/status/tools/prompts/resources | **MCP backend/config/runtime** | Existing MCP APIs/actions | no servers / backend-defined | Backend config/runtime |
| OpenCode Config | **OpenCode/backend config** | Existing OpenCode config APIs | OpenCode-defined | Backend/OpenCode config |
| Memory | **Backend memory APIs/storage** | Existing memory APIs | backend-defined | Backend/domain |
| Quick Messages | **Existing quick-messages persistence** | Existing APIs | empty / backend-defined | Separate domain |
| Appearance (theme/palettes, message width, spell check) | **SQLite shared portable** | `PATCH /api/preferences` (CAS) → SQLite → SSE/refetch | §3.1 | Shared portable |
| Typography config / native zoom | Config: **SQLite shared portable**; zoom: **local/Tauri `tbai-window-zoom`** | Config via `PATCH`; zoom via platform/local API | `"default"` sentinel / `1.0` | Shared + local device |
| Desktop (sidebar/status/sort/sections/show completed) / sidebar width | Shared: **SQLite**; `sidebarWidth`: **local device only** | Shared via `PATCH`; width local persist only | §3.1 / `SIDEBAR_DEFAULT_WIDTH` | Shared + local device |
| Workspace info/sysinfo | **Read-only/runtime** | n/a | n/a | Informational |
| Folders registry / selected+expanded | Registry: **backend folder APIs/DB**; selected/expanded: **SQLite shared portable** (soft refs) | Registry via folder APIs; selected/expanded via `PATCH` | empty / `null` / `{}` | Backend domain + shared |
| Welcome engine/quick tab/scope/folder; draft agent/model/variant; `autoApprove` | Shared: **SQLite**; drafts: **local**; `autoApprove`: **local, fail-closed, never shared** | Shared via `PATCH`; local store only for drafts/autoApprove | §3.1 / empty / `false` | Shared + local |
| Logs | **Existing log settings/services** | Existing APIs/services | backend-defined | Separate |
| OpenCode Import Chat | **OpenCode runtime discovery + TBAi conversation binding** | Explicit import action | n/a | Preserved capability |

*Hidden per-control persistence details discovered during implementation must remain outside `workspace.preferences.snapshot` unless explicitly designed and approved.*

---

## 6. Exact removal inventory (reference-driven)

| Area | Remove/retire (trace all references) | Preserve |
|---|---|---|
| Shared active/activation | `sharedActiveConversationId`; `activateSharedTab`; `POST /api/preferences/tabs/activate`; `sharedTabActivateBodySchema`; web `activateSharedTab`; `requestSharedActivate`; `SharedActivationIndicator`; call sites/tests | Local tab selection/navigation; detached model |
| Legacy Import Open Tabs (A) | `LegacyTabImportDialog`; `LEGACY_OPEN_TABS_STORAGE_KEY`/`readLegacyOpenTabs` authority; `importLegacySharedTabs`/`markSharedTabsInitialized`; `POST /api/preferences/tabs/import-legacy|mark-initialized`; `sharedTabImportLegacyBodySchema`; web API/store/types; `sharedTabsInitialized` product behavior/markers/receipts solely for this feature | Existing conversations/messages/history/SQLite shared tabs data; **OpenCode Import Chat** |
| Legacy preference migration/seeding (complete) | `localPortablePrefs.ts`; `PortablePrefsMigrationDialog`; `migratePortablePreferences`/`markPortablePrefsInitialized`; `POST /api/preferences/migrate/portable|mark-initialized`; `portablePrefsMigrationBodySchema`; web API/store/types; `portablePrefsInitialized`/receipts/flags/wizard UX; seed-if-absent, migration ordering/race handling, migration versions/compatibility frameworks | Active-feature local storage; device-specific settings |
| Local persistence of shared portable fields | Shared-field localStorage reads/writes/initial hydration in `theme-storage.ts`, `typography.ts`, `desktopLayout.ts` (shared fields), `welcomeScope.ts`, `welcomeEngine.ts` (shared `engine`), `foldersStore.ts` (shared selected/expanded); obsolete adapters/constants/helpers solely for retired shared-prefs local persistence | `desktopLayout` `sidebarWidth` local only; local drafts/`autoApprove` fail-closed; drafts/handoff/resumable streams |
| Profile/migration machinery | `profileId`, `tbai:prefs-profile-id`, `migrationEpoch`, multi-profile abstractions; dead migration-only receipts/flags/fallbacks | Ignore obsolete snapshot `migration` fields safely (no behavior restore) |
| Global/legacy authority remnants | Shared navigation commands, cross-window active convergence, `storage`-event tab authority, first-shared-tab-as-active hacks, `tbai:openTabs` authority | `TabUrlSync` local-only; SSE refetch shared snapshot only |

Repo-wide trace required for every retired symbol (imports/exports/functions/methods/types/schemas/API clients/routes/components/hooks/state/selectors/listeners/helpers/tests/mocks/fixtures/docs). No orphaned references or unreachable feature paths may remain.

---

## 7. OpenCode Import Chat preservation contract (normative)

**Completely separate from Legacy Import Open Tabs.** Do not weaken during implementation.

**Preserve:** `web/src/features/opencode/OpenCodeImportDialog.tsx`, Sidebar import entry (`web/src/components/Sidebar.tsx`), `web/src/features/opencode/opencodeImportApi.ts`, `GET /api/opencode/importable`, `POST /api/opencode/import` (`src/routes/opencode.ts`), `src/services/opencode/import.ts` (`listImportableOpenCodeSessions`, `importOpenCodeSession`, `encodeSourceRef`/`decodeSourceRef`), OpenCode session discovery/runtime dependencies, OpenCode runtime/client/history-boundary/error/route/proxy infrastructure, and conversation-service lookup/create/binding functionality (`listImportedOpenCodeSessionIds`, `findByOpenCodeSession`, `create`).

**Required acceptance tests:**
- Discover an existing OpenCode session **never opened in TBAi**.
- Discover an existing OpenCode session **never started through TBAi** (created outside TBAi, present in OpenCode session/history storage).
- Import/open successfully via `GET /api/opencode/importable` + `POST /api/opencode/import` and the dialog flow.
- Preserve conversation identity and messages (native attached session; no message-history duplication; correct `opencodeSessionId`/service owner/import metadata).
- Removing Legacy Import Open Tabs / `tbai:openTabs` migration has **no effect** on OpenCode chat discovery/import.

---

## 8. Mandatory phase — complete dead-code and dependency cleanup

After approved removals, perform **complete reference-driven cleanup** across backend, frontend, persistence, tests, and dependencies (actual cleanup, not disabling/hiding):

1. Trace every removed feature through all source files and references.
2. Remove unused imports, exports, functions, methods, types, schemas, API clients, route handlers, components, hooks, state variables, selectors, event listeners, and helpers.
3. Remove obsolete localStorage readers/writers/persistence adapters/constants associated with retired shared preferences and retired `tbai:openTabs` authority (preserve active-feature local storage and device-specific settings).
4. Remove persistence and synchronization bridges with no genuine consumer.
5. **Prefer a single coordinated sync owner** (e.g. one `usePreferencesSync()` hook mounted once in `AppShell.tsx`) instead of multiple `Preferences*Sync` components/effects. When a new authoritative revision is applied, update appearance, desktop layout, navigation, and welcome/shared portable state in one coordinated pass with loop suppression. **No shared-portable localStorage writes except the narrow passive write-through pre-paint cache for appearance keys** (`tbai-theme`, `tbai-theme-light`, `tbai-theme-dark`, `tbai-typography`) mirroring authoritative SQLite state only (§4.1); never as authority/migration source. Remove obsolete `Preferences*Sync` components if replaced.
6. Remove obsolete tests/mocks/fixtures/test utilities for retired features; replace with tests for the new architecture (§9).
7. Remove packages/dependencies **only when exclusively used by retired functionality** (verified dependency analysis; record evidence).
8. Update outdated documentation/architecture descriptions (record decisions in `docs/decisions.md` during implementation if approved).
9. Run repository-wide searches for retired symbols and verify no orphaned references or unreachable feature paths remain.

**Strict preservation boundaries:** OpenCode Import Chat and its dependencies; normal conversation history/creation/storage services; composer drafts, pending first-message handoff, resumable streams; device-specific persistence (window geometry, zoom, sidebar width); existing Settings functionality; any shared service still used by active functionality.

**Cleanup acceptance criteria:** no dead code from retired features; no unused compatibility wrappers or duplicate state authorities; no shared portable setting persisted to localStorage **except the narrow passive write-through pre-paint cache for appearance keys** (`tbai-theme`, `tbai-theme-light`, `tbai-theme-dark`, `tbai-typography`) mirroring authoritative SQLite state only (§4.1); no unnecessary abstraction introduced; typecheck/lint/build/relevant tests pass; final report lists deleted files, removed symbols, retained shared dependencies, and verification results.

---

## 9. Required tests / acceptance criteria (normative)

### 9.1 Retirement and contracts
- Preferences REST is `GET /api/preferences`, `GET /api/preferences/stream`, `PATCH /api/preferences` (settings only: `appearance`, `desktop`, `welcome`, `navigation` allowlist; **not** `sharedTabs`), and explicit tab intents `POST /api/preferences/tabs/open|close|close-batch|reorder`. Retired endpoints absent (activate, import-legacy, mark-initialized, migrate/portable, profile).
- No `sharedActiveConversationId`, no activation, no Legacy Import Open Tabs, no legacy preference migration/seeding/wizard, no `tbai:openTabs` authority, no profile/migration machinery in product behavior.
- `PATCH /api/preferences` merges supplied preference fields at the **allowlisted leaf-field level**; omitted fields remain unchanged (e.g. updating only `appearance.themeMode` preserves `appearance.lightTheme`, `appearance.darkTheme`, `appearance.typography`). `sharedTabs` is never patched via `PATCH`.
- CAS stale `409` returns authoritative `{ conflict, revision, snapshot }`; **no automatic stale-write retry with fresh revision**. SSE invalidation/refetch works with coalesced/debounced triggers and reconnect backoff; optional `originWindowId` avoids redundant self-refetch; remote updates never steal local route/focus/drafts. Tab intents are server-computed/validated atomically; CAS still applies (concurrent mutations may 409).

### 9.2 Snapshot lifecycle
- **Absent row:** canonical defaults returned; no migration/init marker; no unnecessary default write.
- **Valid row:** authoritative saved preferences returned.
- **Corrupt/invalid row** (including invalid `sectionOrder` per §3.2): explicit error; existing row preserved; mutations blocked from overwrite. Obsolete legacy fields ignored/stripped without behavior restore; active canonical validation not weakened.

### 9.3 `sectionOrder` parity
- Backend/frontend normalization semantics identical.
- Missing/`undefined`/`null`/`[]` => `["folders","chats"]`.
- Valid known IDs => deduped (first occurrence) + missing appended in default order.
- Non-array / invalid element types / unknown IDs => corruption/validation error.

### 9.4 Multi-window, detached, navigation, existence, and race safety
- **Conversation-existence rules (exact):** `2xx` => exists; `404` => **confirmed gone**; network error/timeout/`5xx` => **unknown** (preserve conversation and runtime state; never treat as gone). **Removing a conversation from shared-tab membership must never be interpreted as deleting that conversation.** Only actual deletion or a confirmed-gone result may trigger destructive local cleanup.
- **Detached scenario:** Window B removes shared tab X; Window A stays on X, route/UI intact, X detached/local, **not** silently re-added; backend `sharedTabs` excludes X unless explicitly re-added; messages/history preserved; reconnect/refresh/reload does not re-add.
- Selecting a shared tab = local navigation only. Explicit open/close/close-batch/reorder use CAS.
- Fresh `/` after hydration => deterministic local draft only. Existing `/chat/:id` or `/code/:id` preserved.
- Failed shared-tab insertion leaves no phantom shared state. Delayed/stale operations do not resurrect closed tabs.
- **Delayed add-vs-close:** serialize shared mutations within same window; delayed add must not override later explicit close; stale `409` never auto-retries with fresh revision; refresh authoritative state and preserve close; only new explicit user action can add again.

### 9.5 Direct/OpenCode integration and membership recovery
- **Direct:** shared membership insertion triggered after `remoteThreadListAdapter.initialize()` returns canonical conversation ID; not in `AppShell.handleThreadIdChange()`.
- **OpenCode:** shared membership insertion triggered only after `setPendingFirstMessage()` successfully stages first-message handoff; not in `AppShell.handleThreadIdChange()`.
- Membership failure must not fail conversation creation or first-message delivery.
- Retrying membership reuses existing conversation ID and never recreates a conversation or resends the first message.
- Membership recovery is separate from conversation creation and first-message recovery.
- Failed non-awaited membership operations captured independently; transient per-window failure state keyed by conversation ID; explicit retry retries only shared membership operation; no persisted temporary error indicators, no new recovery framework.

### 9.6 Portable setting cross-client sync (E2E)
- Window A changes a shared portable setting (e.g. theme mode/typography/chat width) via CAS; SQLite authoritative; Window B receives via SSE invalidation → authoritative refetch/apply without stealing route/focus/drafts; survives restart as applicable; **stale local state must not overwrite** saved SQLite value.

### 9.7 Old local preference keys ignored (authority/migration) and pre-paint cache safety
- Populate stale values in `tbai-theme`, `tbai-theme-light`, `tbai-theme-dark`, `tbai-typography`, `tbai:desktopLayout` (shared fields), `tbai:welcome-scope`, `tbai:welcome-tab`, `tbai:welcome-engine` (shared `engine`), `tbai:selectedFolder`, `tbai:folderExpanded`, `tbai:openTabs`.
- Verify: **before React hydration, application state uses application defaults** (not cache values as authority); authoritative SQLite/canonical defaults control shared portable settings after hydration; old local keys are **never** read as migration sources or authority and their values are **never** transferred into SQLite.
- **Appearance pre-paint cache exception (§4.1) — explicit cases:**
  - Stale appearance cache values may provide a temporary pre-paint visual hint only; they must **never** seed SQLite and must **never** be treated as authority.
  - Once authoritative SQLite state loads, its values **replace** cache-derived visuals/state **even when they differ** from stale cache.
  - **Only after receiving authoritative SQLite state** may the application update the appearance cache (write-through mirror of authoritative state only).
  - Tests must explicitly cover: stale cache values present, SQLite overriding them, and **no cache-to-database transfer**.
- **All other shared portable fields:** no localStorage reads for initial render and no localStorage writes/persistence. `tbai:desktopLayout` retains only `sidebarWidth` locally and does not hydrate shared fields from old cached values. `tbai:openTabs` never influences shared membership/order/active intent.

### 9.8 OpenCode Import Chat preservation
- Satisfy §7 contract and all required acceptance tests.

### 9.9 Data/settings preservation
- Conversations/messages/history preserved (no destructive deletion). Any valid existing workspace snapshot/shared-tab data preserved if present. No old localStorage tab-list import. No destructive database migration. Existing Settings functionality preserved. Composer drafts/pending first-message handoff/resumable streams preserved. Device-specific persistence preserved. Credentials/secrets never exposed; OpenCode `autoApprove` remains local/fail-closed.

---

## 10. Implementation boundary and phases (active only after explicit approval)

**Implementation order (normative):**
1. Build the canonical SQLite preferences contract.
2. Implement REST, SSE, and transactional CAS.
3. Refactor tab membership and per-window navigation.
4. Correct all Settings persistence and remove shared localStorage persistence.
5. Remove obsolete code and dependencies through reference tracing.
6. Run tests, including OpenCode Import Chat, multi-window, detached conversations, first-send safety, and dead-code checks.

| Phase | Scope | Measurable acceptance |
|---|---|---|
| 1. Canonical contract cleanup | **WIP-cleanup boundary (strict):** preserve all existing WIP, untracked audit documents, and the stash. **Before removing anything, inspect the existing diff and untracked files.** Remove **only** files and changes **conclusively attributable** to the earlier preferences implementation (reference-traced). **Unrelated or ambiguous WIP must remain untouched.** Likely attributable candidates (verify before deletion): `web/src/features/preferences/components/LegacyTabImportDialog.tsx`, `web/src/features/preferences/components/PortablePrefsMigrationDialog.tsx`, `web/src/features/preferences/components/SharedActivationIndicator.tsx`; unused migration/activation/import-legacy handlers/semantics in `src/routes/preferences.ts` (keep/reshape explicit tab intent endpoints per §2.1; remove activation/import-legacy/mark-initialized/migrate/portable); corresponding schemas in `src/lib/validation.ts` (`sharedTabActivateBodySchema`, `sharedTabImportLegacyBodySchema`, `portablePrefsMigrationBodySchema` and migration/activation-only schemas); corresponding service methods/exports/types/registry fields in `src/services/preferences/*` (`sharedActiveConversationId`, activation, legacy import, migration/seed/wizard/receipt/init/profile product fields) as applicable; web API/store/type references. Then implement canonical preferences domain/routes/schemas: `GET /api/preferences`, `GET /api/preferences/stream`, `PATCH /api/preferences` (**settings only**, leaf-field merge per §2.1), and explicit tab intents `POST /api/preferences/tabs/open|close|close-batch|reorder` per §2.1; canonical defaults; absent/corrupt snapshot handling; strict `sectionOrder` normalization/validation; `sharedTabs` canonical type `Array<{ ref: string; kind: "chat" | "agent" }>`. **No OpenCode Import Chat changes.** | Target prefs/tab-intent endpoints only; only conclusively attributable retired WIP removed; unrelated/ambiguous WIP preserved; absent/corrupt/valid states correct; CAS/SSE correct; OpenCode import endpoints unchanged. |
| 2. Frontend state/UI cleanup | Remove retired APIs/store/actions/types/components; prefer a single coordinated `usePreferencesSync()` (or equivalent single owner) mounted once in `AppShell.tsx` for authoritative snapshot apply/loop suppression/pre-paint cache exception; keep settings patch paths; keep `OpenCodeImportDialog`/Sidebar OpenCode import. | No retired requests/dialogs; Settings save/load; OpenCode import works; single coordinated sync pass. |
| 3. Navigation/tab semantics | `IndexRedirect` deterministic local fallback; remove `requestSharedActivate`; local-only tab selection; explicit shared mutations only; retire `tbai:openTabs` authority/import paths; preserve detached model and race safeguards; implement §2.3/§2.4 integration/recovery rules. | Fresh `/` local draft; existing URLs preserved; no implicit shared add; detached not re-added; no phantom/resurrected tabs; Direct/OpenCode first-send/membership rules satisfied. |
| 4. Settings authority & local-persistence cleanup | Apply §4/§5: shared portable from SQLite; before React hydration application state uses defaults; **no shared portable localStorage persistence, except the narrow passive write-through pre-paint cache for appearance keys** (`tbai-theme`, `tbai-theme-light`, `tbai-theme-dark`, `tbai-typography`) mirroring authoritative SQLite state only per §4.1. No old local preference values may be read as application state or authority; the appearance cache may only provide the temporary pre-paint visual hint described in §4.1. `tbai:desktopLayout` only `sidebarWidth` local; SQLite sole authority. | Every Settings control verified; shared prefs persist/reload/sync; stale local cannot overwrite; old keys ignored; appearance cache follows §4.1 only. |
| 5. Mandatory dead-code/dependency cleanup | Execute §8 with verified dependency analysis. | §8 acceptance criteria met; repo-wide retired-symbol search clean. |
| 6. Tests & verification | Update/remove affected tests; add §9 tests; run §11 gates; report real results. | Relevant suites pass; no data loss; no retired feature active; OpenCode Import Chat preserved; fresh/empty/corrupt snapshot behaviors correct. |

**No active phase includes:** shared active pointer/activation, Legacy Import Open Tabs, old preference migration/seed-if-absent/`localPortablePrefs.ts` migration helper, migration receipts/initialization flags, localStorage reads/writes for shared portable settings (except the narrow passive write-through pre-paint cache for appearance keys per §4.1), or startup migration wizard. No unrelated refactoring or broad rewrite.

---

## 11. Verification gates (report real exit codes/counts; classify failures with evidence)

- `bun run typecheck`
- `bun run build`
- `bun run test:locations`
- Relevant unit/DOM/E2E: preferences service/routes, chat tabs/shared membership, `IndexRedirect`, folder soft-ref/navigation, foundation, shared-tab workflows/multi-window, portable-setting cross-client sync/restart/stale-local non-overwrite, old local preference keys ignored, corrupt snapshot handling incl. `sectionOrder`, **OpenCode Import Chat preservation**, retirement guards, CAS/SSE/restart/fresh-install/empty-DB/data-preservation, detached/race safeguards, Direct/OpenCode first-send + membership-failure/retry safety.
- `bun run test` (full) — final pass/fail/skip summary; classify pre-existing vs new failures with evidence.

---

## 12. Rollback and safety (normative)

- **No destructive data migration.** Never delete conversations/messages/history. Preserve any valid existing workspace snapshot/shared-tab data if present. No old localStorage tab-list import. No destructive rewrite of snapshot rows except through normal legitimate CAS mutations on valid state.
- **Corrupt snapshot:** preserve row, return explicit error, block unsafe overwrite. No silent repair.
- **Stale writes:** 409 authoritative response; no automatic retry with fresh revision.
- **Rollback strategy must not retain local caches as shared-preference authority.** If implementation is reverted, revert code changes; do not reintroduce shared localStorage authority, migration/seed-if-absent, activation, or Legacy Import Open Tabs.

---

## 13. Final report format (required at implementation completion)

List **deleted files**, **removed symbols/endpoints/schemas/components**, **retained shared dependencies** (especially OpenCode Import Chat and conversation-domain deps), **packages removed** (only if exclusively retired, with evidence), **tests added/updated/removed**, and **verification results** (exact commands, exit codes, pass/fail/skip counts, classified failures).

---

## 14. Plan self-check

- **Authorization:** single status only — **IMPLEMENTATION NOT AUTHORIZED — pending explicit approval**. No “GRANTED”.
- **Removed/prohibited only:** shared active conversation & activation; Legacy Import Open Tabs; old preference migration / `localPortablePrefs.ts` migration helper / seed-if-absent / old TBAi localStorage keys as migration sources / migration receipts & initialization flags; localStorage reads/writes for shared portable settings **except the narrow passive write-through pre-paint cache for appearance keys** (`tbai-theme`, `tbai-theme-light`, `tbai-theme-dark`, `tbai-typography`) mirroring authoritative SQLite state only (§4.1), never as authority/migration source.
- **Explicitly preserved:** OpenCode Import Chat (complete contract + acceptance tests), existing conversations/messages/history, Settings functionality, drafts/handoff/resumable streams, device-specific persistence, credentials/secrets handling, OpenCode `autoApprove` local/fail-closed.
- **Settled:** `sectionOrder` deterministic/strict with backend/frontend parity; corrupt snapshot = explicit error + preserve + block overwrite; stale 409 = no auto-retry.
- **Integration/race/recovery clarified:** Direct/OpenCode membership insertion points; membership failure isolated from creation/first-message delivery; retry reuses existing conversation ID and never resends first message; delayed add-vs-close rules explicit; transient per-window membership recovery only.
- **Lean/rock-solid (AGENTS.md-aligned, durable):** `PATCH /api/preferences` for **settings only** (`appearance`, `desktop`, `welcome`, `navigation`); **explicit tab intent endpoints** (`POST /api/preferences/tabs/open|close|close-batch|reorder`) so clients send intent (not stale full `sharedTabs` arrays) and server computes/validates atomically (CAS still applies). SSE `originWindowId` to avoid redundant self-refetch plus coalesced/debounced refetch and reconnect backoff; single coordinated `usePreferencesSync()` owner preferred over multiple sync components.

**This is the final consolidated implementation baseline for explicit approval.**
