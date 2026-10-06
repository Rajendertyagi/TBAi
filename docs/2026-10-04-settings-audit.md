# TBAi Cross-Client Settings — Architecture Audit

Date: 2026-10-04. Read-only audit (no code, schema, migration, or route changes).
Objective: determine whether a server-backed, typed-DB settings system (Chrome + Firefox + Tauri, one source of truth in the existing SQLite DB, localStorage only as a no-flash cache) is compatible with the current TBAi architecture.

Tagging: **CONFIRMED** = read on disk; **NOT ESTABLISHED** = gap, no evidence on disk.

---

## A. User identity

**Bottom line: TBAi has no concept of a user. The database is a global, anonymous, single-installation store.**

| Question | Finding | Evidence | Status |
|---|---|---|---|
| Authentication (login/session/token/cookie) | **ABSENT.** Middleware is CORS + request-correlation + error handling only. No auth layer anywhere. | `src/routes/index.ts` L30–99; `docs/security.md` L158–159 ("there is currently no auth layer; this is a local/single-user tool"); `src/server.ts` L101 | CONFIRMED |
| User/account/profile table | **ABSENT.** All 16 real tables in `src/db/index.ts` have no `user_id`/`owner` column; the only FKs point to `conversations`, `folders`, `scheduler_jobs`. | full DDL inventory in `src/db/index.ts` | CONFIRMED |
| Device/installation identity | **ABSENT.** Zero `deviceId`/`installationId`/`machineId` matches. The only per-boot UUID is `TBAI_INSTANCE_ID` — a process-memory-only ownership-proof for the Tauri handshake, explicitly "never persist, never reuse"; it changes every launch. | `src-tauri/src/main.rs` L315–316; `src/services/server-listener.ts` L59–63; `GET /api/server/instance` in `src/routes/server.ts` L98–100 | CONFIRMED |
| Web identity | The browser carries **nothing identifying** between sessions. All `localStorage` keys are UI preferences (14 keys, §C), none are ever sent to the server. Requests are relative same-origin fetches + optional `X-TBAI-Operation-ID` (a logging correlation id, `web/src/lib/operation.ts` L29). Cookies: **ABSENT** (zero `document.cookie`). | full `localStorage` enumeration in `web/src/**`; `src/routes/index.ts` L60–67 | CONFIRMED |
| Tauri identity / login | **ABSENT.** The Tauri shell does not log in. Boot: spawn sidecar backend → scan free port → write port mirror → mint fresh UUID → verify against `GET /api/server/instance` → navigate webview to `http://127.0.0.1:<port>`. That verification proves *ownership of the process*, not *who the user is*. | `src-tauri/src/main.rs` L115–157 (`read_mirror_port`, `fetch_instance`); sidecar config `src-tauri/tauri.conf.json` L48 (`externalBin`) | CONFIRMED |
| **Concrete question: can Chrome + Firefox + Tauri resolve to the SAME logical user?** | **NO — not "no link": there is no logical user at all.** Three clients against one local server all read/write the same global rows *indistinguishably*. They "share" today only by sharing the same backend process + same `data/chat.db`. Exact missing link: no user id, no session token, no persisted install id by which a settings row could be keyed per-user. | §A; `docs/decisions.md` L129 ("no benefit for a single-user portable tool") | CONFIRMED |
| Anonymous/local-only users | **YES, by design** — "single-user portable tool" is a documented accepted trade-off. Tauri even refuses to run twice over one data folder (folder lock). | `docs/security.md` L12/22; `src-tauri/src/main.rs` L275–312 | CONFIRMED |

## B. Database architecture

| Item | Finding | Evidence | Status |
|---|---|---|---|
| Engine / file | `bun:sqlite` native `Database`, one module-level singleton connection. File: `<DATA_DIR>/chat.db`, `DATA_DIR` = env `DATA_DIR` else `./data`. PRAGMAs: WAL, `synchronous=NORMAL`, 64 MiB cache, 256 MiB mmap, `foreign_keys=ON`, `busy_timeout=5000`. | `src/db/index.ts` L10–51, export L606 | CONFIRMED |
| Migration mechanism | **No** `schema_migrations`, **no** `PRAGMA user_version`, **no** migrations folder. Migration = idempotent inline DDL at module load: ① `CREATE TABLE IF NOT EXISTS`; ② `addColumnIfNotExists(table, column, def)` helper (L190–195, ~20 uses); ③ `try { ALTER TABLE } catch {}`; ④ one full table REBUILD for `conversations` CHECK constraints (L211–276). A new table = one more `CREATE TABLE IF NOT EXISTS` block in this file. | `src/db/index.ts`; split-leaf pattern `src/services/chat-streams/schema.ts` L85–141 | CONFIRMED |
| Naming / key conventions | snake_case; `id` = TEXT cuid (`generateId()`, `src/lib/utils.ts` L3, cuid2) except `credential_key` INTEGER singleton; timestamps INTEGER epoch-ms; booleans INTEGER 0/1; inline `REFERENCES … ON DELETE CASCADE`. | `src/db/index.ts`; `src/db/mappers.ts` | CONFIRMED |
| Singleton settings tables | Two: `app_settings` (`key` PK, `value` JSON text, `updated_at`; `src/db/index.ts` L120–125) and `credential_key` (`CHECK(id = 1)` single DEK row, L99–105). `app_settings` is currently written by 4 services with dotted keys: `server.port` (`src/services/server-port.ts`), `server.startMinimized` (`src/services/startup-prefs.ts`), `log.settings` (`src/services/log-settings.ts`), `security.tool_approval_secret` (`src/services/credentials.ts` L118–148, encrypted value). **None are user-scoped; the table has no user column.** | — | CONFIRMED |
| User-scoped tables that could own preferences | **None exist.** Closest ownership structures: `conversations` (per-conversation defaults: `provider_id`, `model_id`, `reasoning_level`, `opencode_*` columns) and `provider_configs` (per-provider defaults + `is_active` global singleton). | `src/db/index.ts` L277–351 | CONFIRMED |

## C. Existing settings inventory

**User preferences (device-local today, syncable):**

| Preference | Current storage | Scope | Survives reload? | Syncable? |
|---|---|---|---|---|
| Theme mode | `localStorage["tbai-theme"]` (`web/src/features/appearance/theme-storage.ts` L24) | device | Y | **Yes** — 1 string, default `"dark"` |
| Light palette | `localStorage["tbai-theme-light"]` (L25) | device | Y | **Yes** — theme-family id |
| Dark palette | `localStorage["tbai-theme-dark"]` (L26) | device | Y | **Yes** |
| Spell check | inside `localStorage["tbai:desktopLayout"]` (zustand `persist`, `web/src/features/desktop/state/desktopLayout.ts` L251) | device | Y | Yes (portable boolean) |
| Sidebar/statusbar visible, sort, section order/collapsed, showRecent/Completed | same `tbai:desktopLayout` key | device | Y | Yes (portable) |
| Sidebar width (px) | same key | **machine** | Y | **No** — geometry |
| Last settings route | `localStorage["tbai:settingsRoute"]` (`web/src/config/navigation.ts` L291) | device | Y | Yes, low value |
| New-chat engine/agent/model/variant + auto-approve shield | `localStorage["tbai:welcome-engine"]` (`web/src/features/chat/state/welcomeEngine.ts` L30) | device | Y | **Yes — would become a global OpenCode default** |
| New-chat draft workspace scope + quick-actions tab | `localStorage["tbai:welcome-scope"]`, `["tbai:quick-actions-tab"]` (`web/src/config/welcome.ts` L132–133) | device | Y | Yes |
| Open tabs + active tab | `localStorage["tbai:openTabs"]` + `storage`-event bus (`web/src/features/chat/state/chatTabs.ts` L5, L399–410) | device | Y | Yes in principle (refs are server ids); today cross-tab-only |
| Selected/expanded folders | `localStorage["tbai:selectedFolder"]`, `["tbai:folderExpanded"]` (`web/src/stores/foldersStore.ts` L89–90) | device | Y | Yes (server folder ids) |
| Unsent composer drafts | `localStorage["tbai:composer-draft:<threadKey>"]` (`web/src/features/chat/state/composerDraft.ts` L11) | conversation | Y | Optional; crash-recovery role, not a preference |

**Already server-authoritative (no sync work; would gain user-scoping only if identity existed):** active provider + per-provider default model/thinking/protocol → `provider_configs.is_active/model/thinking/api_protocol` (`src/routes/providers.ts` L131–141 set-active singleton; in-memory `ProviderRegistry`, `src/config/providers.ts` L32–63); per-conversation defaults → `conversations.*` columns; MCP → `mcp_servers`; plus `folders`, `quick_messages`, `scheduler_jobs`, `memories`. Provider/model resolution chain: one-shot picker (memory-only, `useSettingsStore`) → conversation default (SQLite) → global default (SQLite); documented at `web/src/runtime.ts` L374–404.

**Device/installation-specific (must NOT become user settings):** server port (`app_settings["server.port"]` + mirror file `data/port`); start-minimized (`app_settings["server.startMinimized"]` + `data/start-minimized` mirror read by `main.rs` L159–163 — **no web UI consumer exists today**, CONFIRMED by grep); log capture (`app_settings["log.settings"]`); Tauri window geometry (`window.json` via `tauri-plugin-window-state`, `main.rs` L466–480, config dir `./data` per `tauri.conf.json` L16–18); OS autostart registration (`web/src/lib/platform.ts` L46–53); OpenCode's own `data/opencode-home/opencode.json` (`src/config/opencode.ts` L60); filesystem paths (`folders.path`, `folder_links.target_path`, `conversations.workspace_folder_id`, `scheduler_jobs.workspace_path`) — the folder *registry* is portable, the *paths* are not; `tbai:desktopLayout.sidebarWidth`.

**Transient/one-shot (never sync):** `tbai:pending-first-prompt:<convId>` (exactly-once OpenCode handoff); `sessionStorage["tbai-resume:<threadId>"]` (tab-scoped; server authority = `chat_streams` table); `tbai:schedSeenTs` (badge dismissal); one-shot picker selections.

**"Send on enter" / keyboard settings: DO NOT EXIST in TBAi** — no such preference; Enter-to-send is fixed composer behavior (`web/src/components/Composer.tsx`, `web/src/runtime.ts` L440). `/keyboard-lab` is a dev-only OpenCode-permission diagnostic page (`web/src/features/permissions/KeyboardLab.tsx`). CONFIRMED-NEGATIVE.

**Complete localStorage key list (web/ + src/; backend `src/` has zero localStorage usage):**
`tbai-theme`, `tbai-theme-light`, `tbai-theme-dark`, `tbai:settingsRoute`, `tbai:schedSeenTs`, `tbai:selectedFolder`, `tbai:folderExpanded`, `tbai:welcome-scope`, `tbai:quick-actions-tab`, `tbai:welcome-engine`, `tbai:composer-draft:<threadKey>` (prefix), `tbai:openTabs`, `tbai:pending-first-prompt:<conversationId>` (prefix), `tbai:desktopLayout`.
**sessionStorage:** `tbai-resume:<threadId>` (prefix). **Cookies/IndexedDB: none** (CONFIRMED-NEGATIVE).

## D. Theme architecture (traced first-hand)

1. **First paint:** `web/index.html` L22–35 — inline script *before React*: reads `tbai-theme` (default `"dark"` via static `class="dark"` on `<html>`), reads the matching palette key, sets `<html>` class + `data-tbai-theme` attribute (skipped for `classic`, which falls back to `globals.css` `:root`/`.dark` tokens), then syncs `meta[name="theme-color"]` from computed `--background`. Zero colour logic in the script — palettes must live in the stylesheet; that is the documented anti-drift contract with the provider.
2. **Storage module:** `web/src/features/appearance/theme-storage.ts` — 3 keys, total reads (unknown/corrupt → `classic`/`dark` defaults, never throws; "a bad key must never be able to brick the shell").
3. **React layer:** `web/src/components/theme-provider.tsx` — **React context, not Zustand** (`ThemeProvider` mounted in `web/src/main.tsx` L26). One effect, one DOM-write seam: `applyThemeToDom` (`web/src/features/appearance/theme-dom.ts`, attribute `data-tbai-theme`). Writes go back to the same 3 keys.
4. **Palette source:** `web/src/styles/themes.css` (render-blocking, generated by `scripts/build-themes.mjs`; 10 families + builtin `classic`; blocks keyed `html[data-tbai-theme="x"]:not(.dark)` / `.dark`, specificity table in file header; MIT-licensed OpenChamber-derived palettes, `theme-data.ts` header).
5. **Semantics: two independent slots** (light palette, dark palette) + one mode toggle — "mirrors OpenChamber's two-slot model" (`theme-storage.ts` header). There is **no "theme variant" setting** in TBAi; `variant` exists only as an OpenCode model concept (`conversations.opencode_variant`).
6. **Tauri uses the same code path** — the webview loads the same built SPA (`tauri.conf.json` L46–47 resources; backend serves `dist/web`), same 3 localStorage keys, but in the webview's own per-install localStorage instance. So Tauri theme is today fully independent of browser themes. CONFIRMED. Exact OS folder of that webview localStorage: **NOT ESTABLISHED** (low impact).
7. **Reusable abstraction already exists:** exactly one writer (`theme-dom.ts`), one reader module (`theme-storage.ts`), one UI surface (`AppearancePage.tsx` at `/appearance`). Swapping the storage backend is a bounded change to `theme-storage.ts` only.

## E. Client store architecture

| Store | Persisted? | Holds / sync status |
|---|---|---|
| `useSettingsStore` (`web/src/stores/index.ts` L39) | No | providers mirror of `/api/providers`; one-shot picker (explicitly session-only, consumed on send) |
| `useMemoryStore` (L107), `useFoldersStore`, `useMcpStore`, `useSchedulerStore`, `useQuickMessagesStore` | No | in-memory mirrors of DB-backed resources (server is authority) |
| `useStalePermissionsStore`, `useStreamRecoveryStore`, `useAvailabilityStore`, `useCommandsStore` | No | transient |
| `useDesktopLayout` (`web/src/features/desktop/state/desktopLayout.ts` L189) | **Yes** — zustand `persist`, key `tbai:desktopLayout`, `version: 1` + `migrate`, `partialize` excludes transient search UI (L250–266) | the only persisted store; mixes user prefs (spellcheck, flags, order) with device chrome (`sidebarWidth`) |
| `useChatTabsStore`, `useWelcomeEngineStore`, `useWelcomeScopeStore` | Yes — manual `localStorage` (keys in §C) | no `persist` middleware |

**No store has server synchronization** — mirrors are fetched at load and overwritten; writes go straight to the API. **Tauri and browsers share the store code but not the storage** (separate localStorage instances). CONFIRMED.

## F. API / server patterns

- **Route composition:** `src/routes/index.ts` — `cors()` (no options, L32) → request-correlation middleware (L68–99, `requestId`/`operationId` via `src/lib/logger.ts` AsyncLocalStorage) → per-concern sub-apps mounted at full paths (`providersApp`, `quickMessagesApp`, …) or prefixes (`/api/mcp`, `/api/logs`, `/api/scheduler`, `/api/opencode`, `/api/server`) → central `onError` (`{ error, requestId }` 500, L128–145) → static SPA catch-all.
- **Auth middleware: NONE.** Caller identity = none (matches §A). CONFIRMED.
- **Validation:** central Zod schemas in `src/lib/validation.ts`; route pattern `safeParse` → 400 `{ error, issues, requestId }` via `storageError` (`src/routes/shared.ts` L43–52); 500 `{ error: sanitizeStreamError(e), requestId }`.
- **Closest `/api/settings` precedent:** `GET/PUT /api/logs/settings` (`src/routes/logs.ts` L42–84 → `persistLogSettings` in `src/services/log-settings.ts`) and `PUT /api/server/port` + `GET/PUT /api/server/startup` (`src/routes/server.ts` L42–147). **Established convention: each concern persists its own settings behind its own route + service owner — there is no generic settings aggregator.** CONFIRMED.
- **Concurrency:** last-write-wins on `updated_at`; no transactions outside the migration rebuild. Idempotent replay precedent exists for one flow: `client_request_id` + partial-unique index on `POST /api/conversations` (`src/routes/conversations.ts` L33–67).
- **CORS:** `cors()` with no options = Hono v4 default wildcard — multi-origin access already allowed; all real clients are same-origin (SPA served by the same process). CONFIRMED.
- **ETag / If-Match / revision / optimistic concurrency anywhere in API or schema: NONE.** CONFIRMED-NEGATIVE (grep across `src/`; the only `version` fields are encryption-envelope versions).

## G. Tauri / desktop architecture

| Question | Finding | Evidence |
|---|---|---|
| Same React frontend? | **Yes** — the webview serves the built `dist/web` SPA; `frontendDist` is a placeholder, real assets come from the sidecar's static catch-all. | `tauri.conf.json` L10, L46–47; `src/routes/index.ts` L259–294 |
| Same backend? | **No — each Tauri install owns its own backend.** The shell compiles the entire Hono/Bun backend into one sidecar binary and spawns it per install. | `tauri.conf.json` L48; `src-tauri/src/main.rs` (sidecar spawn + `quit_owned` kills it) |
| Local or remote backend? | **Local only, hardcoded loopback.** Port is chosen by free-port scan on `127.0.0.1`, written to `data/port` mirror; webview navigates to `http://127.0.0.1:<port>`. No base-URL config, no remote-server support anywhere in the shell. | `main.rs` L103–134, L138–157, L322–353 |
| Data location | `data/` **next to the executable** (`resolve_data_dir`, `main.rs` L103–110) — portable; contains `chat.db`, `port`, `start-minimized`, `.lock` (folder lock prevents two processes on one data dir). Tauri `appDirectoriesOverride.config = "./data"` too (`tauri.conf.json` L16–18). | `main.rs` L275–312 |
| WebView storage | The webview has its own localStorage (separate from any browser's). Exact OS folder: **NOT ESTABLISHED**; the *separation* itself is CONFIRMED (distinct engine profile, identifier `com.tbai.app`, `tauri.conf.json` L5). | `main.rs` L315–316, L466–481 |
| Auth/session persistence in Tauri | **None** — only the per-boot UUID handshake; window geometry persists via `tauri-plugin-window-state` (`window.json`, SIZE/POSITION/MAXIMIZED only). No `tauri-plugin-store`. | `src-tauri/Cargo.toml` L13–17 |
| **What must be true for Chrome + Firefox + Tauri to read/write the SAME settings record?** | (a) All three must talk to **one backend process** (one `chat.db`). Chrome↔Firefox: trivial — both point at the local Bun server. (b) Tauri can only share **its own install's** record; a browser on the same machine can point at that Tauri-owned server (`127.0.0.1:<port>`, CORS wildcard, no auth) — architecturally possible *today*. (c) **Two desktop installs can never represent the same user**: no shared/remote backend, no sync protocol, no install/user id that would link them. | `main.rs` + `tauri.conf.json` + §F |

## H. Security boundaries

**A. Safe to sync (ordinary user settings):** theme mode + both palette ids; spellcheck; sidebar visibility/sort/section order; welcome-engine/scope presets; selected folder ids; last settings route.

**B. Device/installation-specific (keep local):** `server.port`, `server.startMinimized`, `log.settings` (process config, env-overridable); `data/port` + `data/start-minimized` mirror files (Tauri boot rendezvous); `window.json`; OS autostart; `opencode-home/opencode.json` (foreign engine's config, AGENTS.md boundary); filesystem paths (list in §C); `tbai:desktopLayout.sidebarWidth`.

**C. Secrets — must NOT be settings:** provider API keys (`provider_configs.encrypted_api_key`, AES-256-GCM under local DEK, `src/services/credentials.ts` L180–218); the DEK itself (`credential_key`, **plaintext in the DB** — documented accepted trade-off); MCP `auth_token` (encrypted; only `auth_type` echoed to the browser, AGENTS.md); tool-approval HMAC secret (`app_settings["security.tool_approval_secret"]`, encrypted value); OpenCode Basic-auth password (generated per boot, never persisted, `src/config/opencode.ts` L48–52).
**Loose end:** `mcp_servers.headers` and `mcp_servers.env` are **plain unencrypted JSON** (`src/db/index.ts` L372–373) — free-form headers can carry bearer tokens; the weakest secret handling in the DB. CONFIRMED.

## I. Concurrency primitives

| Primitive | Exists? |
|---|---|
| `updated_at` timestamps (last-write-wins) | **Yes**, on nearly every table (INTEGER ms) |
| Revision / etag / `If-Match` / optimistic locking | **No — CONFIRMED-NEGATIVE** (grep of `src/`) |
| Transaction helpers | Only the migration rebuild (`BEGIN/COMMIT` + `foreign_keys=OFF`, `src/db/index.ts` L222–258); routes do sequential `db.run`, no app-level transactions (bun:sqlite is synchronous) |
| DB-layer write serialization | **Yes** — WAL + `busy_timeout=5000` (`src/db/index.ts` L18–51); one backend process is the single writer today |
| Idempotent replay | One precedent: `client_request_id` partial-unique index (`src/routes/conversations.ts` L33–67); plus `UNIQUE(job_id, occurrence_id)` claim guard on `scheduler_runs` |

**Implication for Chrome+Firefox simultaneous edits:** SQLite serializes the *writes*, but the app has **no conflict detection** — a later write silently wins. A `revision`/`updated_at`-based guard would be a novel primitive for this codebase.

## J. Testing patterns

- **DB/service:** hermetic per-test-file sandbox — `bunfig.toml` preload `tests/setup.ts` + `tests/test-sandbox.ts` gives each test file its own `DATA_DIR` (`<tmp>/tbai-test-<pid>-<sha-slug>`), so the `src/db` singleton + migrations are automatically isolated; `bun test --isolate`. Representative: `tests/unit/quick-messages.test.ts` (service CRUD against sandbox DB), `tests/unit/db.test.ts` (WAL/busy_timeout readback), `src/services/credentials.test.ts` (falls back to `mkdtempSync` DATA_DIR standalone).
- **API routes:** in-process `app.request(...)` against the real (sub)app, sandbox DB behind — `tests/unit/memory-api.test.ts` L74/103, `tests/integration/chat-runs.test.ts` L66–129. No listening ports except external-boundary stubs (`Bun.serve` port-0 fake provider in `src/context/memory-chat-wiring.test.ts`; OpenCode client fixtures).
- **Frontend pure-logic:** co-located tests, e.g. `web/src/features/appearance/theme-css.test.ts`, `theme-color.test.ts`.
- **Tauri/Rust side:** test presence **NOT ESTABLISHED** (not inspected; low impact — a settings feature would live in the Bun/React layers).
- Best patterns for a future settings feature: sandbox-DB service test (`quick-messages` shape) + `app.request` route test (`memory-api` shape) + a pure-logic test for the settings mapper/validation.

## K. Proposed `user_settings` table assessment (audit only)

Against the current architecture (no users, install-scoped single-user DB, typed-table conventions from §B):

| Field | Classification | Reasoning |
|---|---|---|
| `user_id` | **UNKNOWN — currently has no referent.** | No user table, no auth, no session (§A). A `user_id TEXT` column would be syntactically fine (matches conventions) but every row would carry the same fabricated value. Viable only as *installation-scoped* (single row / no key column) until an identity layer exists. **Do not add it now for convenience.** |
| `theme_mode` | **Definitely belongs** | Simple string, device-local today (`tbai-theme`), portable, low-contention. |
| `light_theme_id` | **Definitely belongs** | Same; value must be validated against known family ids (`isThemeId`, `theme-data.ts`). |
| `dark_theme_id` | **Definitely belongs** | Same. |
| `theme_variant` | **Probably belongs elsewhere / doesn't exist** | TBAi has no theme-variant concept; the two palette slots *are* the variant story. Don't invent the column. |
| `spellcheck` | **Probably belongs** (with a caveat) | Portable user preference, but today it's bundled inside the device-chrome store `tbai:desktopLayout` alongside `sidebarWidth` (device px). Splitting it out is correct; the bundle must stay device-local. |
| `send_on_enter` | **Does not exist — reject** | No such setting in TBAi (§C CONFIRMED-NEGATIVE). Adding it would be inventing a feature. |
| `default_provider` | **Probably belongs elsewhere** | Authority already exists: `provider_configs.is_active` (global singleton, set-active route). A user-scoped copy creates a duplicate authority. Keep it where it is; it becomes user-scoped when identity lands. |
| `default_model` | **Probably belongs elsewhere** | Same — `provider_configs.model` + `conversations.model_id` already own it (3-layer chain, `web/src/runtime.ts` L374–404). |
| `revision` | **Unknown — no precedent; a decision required** | No ETag/revision/optimistic-concurrency anywhere (§I). A `revision INTEGER` column fits conventions, but the *protocol* (if-match semantics, stale-write handling) would be novel and needs its own decision + tests. |
| `updated_at` | **Definitely belongs** | Universal schema convention (INTEGER ms, LWW). |

**Fit verdict:** a typed, *installation-scoped* settings table (`CREATE TABLE IF NOT EXISTS user_settings …` with the theme triple + `updated_at`, optionally `revision`) fits the schema conventions, migration mechanism, route precedent (`/api/logs/settings`), Zod validation, and test sandbox cleanly. The blocking elements are only the **user dimension** (§K/§A) and the **conflict policy** (§I) — both design decisions, not architectural mismatches. A JSON-blob representation is *not* needed: typed columns are trivially consistent with the existing migration tooling, while `app_settings` JSON KV is already reserved for machine/installation config (§H-B).

## L. Cross-browser requirement (audit finding, not a plan)

Minimum infrastructure for Chrome ↔ Firefox ↔ Tauri ↔ same settings record:

1. **Identity:** none required *within one installation* — all clients are anonymous and the DB is global; "same user" = "same install" (§A). For genuinely **cross-device** sync: a persisted install/user id + an auth/session layer + a reachable shared backend — **all three are absent** (§A/§G).
2. **DB ownership:** one backend process owns `chat.db` (WAL tolerates concurrent readers; single writer today). Tauri installs own *separate* DBs; no link between installs exists.
3. **API:** one settings read/write endpoint pair (precedent: `src/routes/logs.ts` GET/PUT); CORS wildcard already permits all local origins (§F).
4. **Local cache:** keep the three `localStorage` theme keys as the **pre-paint source** — `index.html` L22–35 runs before any network can, so flash-prevention *requires* the cache to stay; the server becomes authority after load and the cache becomes a write-through mirror. (Same reasoning makes `tbai:welcome-engine`-style keys natural cache candidates later.)
5. **Synchronization trigger:** **pull on app start + write-through on change.** There is **no server→client push channel** in TBAi (no global event bus/WebSocket; streaming is per-request) — CONFIRMED-NEGATIVE, so live cross-client propagation would require either a new push primitive or is out of scope.

## M. Current gaps

1. No user/device/browser identity of any kind (§A) — the headline gap.
2. No persisted installation id (`TBAI_INSTANCE_ID` is per-boot, §A).
3. Two Tauri installs = two isolated DBs with no sync or shared-backend option (§G).
4. No optimistic-concurrency primitive; LWW is the entire conflict policy (§I).
5. No server→client push channel for live settings propagation (§L-5).
6. `mcp_servers.headers`/`env` unencrypted — secret-hygiene loose end (§H-C).
7. `server.startMinimized` has a DB key + Tauri consumer but **no web UI** (§C).
8. Settings state is fragmented across 3 formats with no shared contract: localStorage theme keys, one zustand-persisted blob (`tbai:desktopLayout`), 8 manual localStorage helpers, 4 `app_settings` JSON keys (§C).

## N. Implementation blockers

- **Blocker 1 (design gate, not code):** `user_id` has no referent — the table must ship as *installation-scoped* (singleton row, or a typed per-install settings table) until an identity decision exists. The audit cannot make that product call.
- **Blocker 2 (design gate):** conflict policy is undecided — without `revision`/if-match, simultaneous Chrome+Firefox edits silently last-write-win (§I).
- **Constraint 3 (hard, documented):** the no-flash first-paint contract means the localStorage cache is not optional even after server authority exists (§D-1/§L-4) — any implementation must keep `index.html` reading the cache, with server reconcile post-load.
- **Blocker 4 (scope):** cross-*device* (multiple installs) sync is not implementable on current infrastructure (§G); a "Chrome + Firefox + Tauri same record" claim is only true **within one installation**, and for Tauri that means the webview *or* a browser pointed at the Tauri-owned loopback server.
- Non-blocking unknowns: exact Tauri webview localStorage folder (NOT ESTABLISHED, low impact); Rust-side test presence (NOT ESTABLISHED, low impact).

## O. Recommended next audit/implementation step

1. **Decision memo** (in `docs/decisions.md`, per AGENTS.md) settling the two gates: ① installation-scoped typed settings table now, `user_id` deferred to a future identity decision; ② conflict policy — either accept LWW+`updated_at` for v1 (cheapest, matches every existing table) or add `revision` with if-match (novel primitive).
2. **Audit slice 1 (safe, bounded):** theme triple + spellcheck into the typed table, `theme-storage.ts` swap to cache-first/server-authority (the §D-7 bounded swap), GET/PUT endpoint following the `src/routes/logs.ts` precedent, Zod validation via `isThemeId`-style guards, tests in the `quick-messages`/`memory-api` sandbox shapes (§J).
3. **Companion audit (security):** encryption decision for `mcp_servers.headers`/`env` (§H-C) before any settings system ever replicates or syncs rows.

---

**Summary:** the preferred direction (typed DB table over the existing SQLite) **is compatible with the current architecture** — schema conventions, migration tooling, route precedent, validation, CORS, and test sandbox all fit. What is *not* available is the "user" in "user-scoped": today the truthful scoping is **per installation**, and cross-browser sharing works within one installation with zero new identity infrastructure, while Tauri is a closed per-install loop (own backend, own DB, loopback-only).

**AUDIT COMPLETE — IMPLEMENTATION READY**
