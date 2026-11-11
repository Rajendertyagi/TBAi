# TBAi Portable Settings Architecture — CodeG Reference Study

## 1. Executive recommendation

**Verified facts (summary):** CodeG uses a small, generic SQLite `app_metadata` key/value table as the authoritative owner for many portable application preferences and feature toggles, with per-key `upsert_value`/`get_value` access, JSON-or-scalar string values, and explicit `*_core` load/save/apply/broadcast patterns. It does **not** store everything in SQLite: startup-critical rendering preferences live in `~/.codeg/preferences.json` (`preferences.rs`), OS autostart is OS-owned, config-sync/WebDAV credentials live in the keyring/token store, and config sync/export/import/WebDAV has its own domain allowlist, manifest/checksum, rollback, and encryption boundaries. Cross-window/cross-client convergence is event-driven (`EventEmitter`/`WebEventBroadcaster`, Tauri events, and web transport subscriptions) with best-effort broadcasts after persistence; there is no global settings revision/ETag protocol in the inspected settings paths.

TBAI currently has no unified portable-preferences owner. Portable UI/application preferences are client-local (`localStorage`, Zustand `persist`, `sessionStorage`), while `app_settings` holds only process/machine/security keys (`log.settings`, `server.port`, `server.startMinimized`, encrypted `security.tool_approval_secret`). Theme and typography require synchronous pre-paint from local cache (`web/index.html`) to avoid flash/layout shift.

**Recommendation (architectural, not implemented):** adopt **Option A with a narrow, typed portable-preferences service over the existing `app_settings` table**, but **do not** treat `app_settings` as an untyped dumping ground and **do not** move process/security/device concerns out of their current owners. This is the smallest CodeG-inspired path that fits TBAI: CodeG’s core lesson is a generic key/value metadata store plus typed per-domain load/save/apply/broadcast/validation rules, not a large settings framework. TBAI already has `app_settings`; adding a dedicated table (Option B) is reasonable but not materially better unless TBAI needs scope/revision columns or wants stronger structural separation than conventions provide. The decisive requirement is **typed ownership and boundaries**, not table count.

**Non-negotiable boundaries:** SQLite becomes authoritative only for **portable application preferences**. Keep device-local/runtime/process config, domain-owned records, transient workflow state, and sensitive credentials/security controls in their existing owners. Preserve theme/typography pre-paint by keeping localStorage as a **write-through cache** read synchronously before React mounts; SQLite is authoritative after successful hydration/reconciliation. Never let arbitrary stale localStorage overwrite an established SQLite value.

**Assumptions:** TBAI remains anonymous/single-install scoped (no user identity model found). Cross-client consistency is required for clients connected to the same backend/database; separate TBAI installs/Tauri data dirs do not share SQLite. No implementation is authorized by this study.

---

## 2. CodeG architecture findings (verified facts)

### 2.1 Database initialization and migrations

- `src-tauri/src/db/mod.rs` initializes the SQLite database under the app data dir, creates the directory, applies pending restore before opening a live connection, opens SeaORM/SQLite, and runs migrations via `Migrator::up(&conn, None)` (`init_database`, L32–60+; file read L1–129). It uses `codeg-dev.db` in debug tauri-runtime and `codeg.db` otherwise (`database_file_name`, L24–30).
- `src-tauri/src/db/migration/m20260211_000001_init.rs` creates `app_metadata` in the initial migration: `id` integer PK autoincrement, `key` string not null unique, `value` string not null, `created_at`/`updated_at` timestamp with time zone not null, `deleted_at` nullable timestamp (`AppMetadata` table creation, L9–43 in the migration excerpt; enum/table references L9,13–40,318,324). The table is a generic metadata store, not a typed preferences table.

### 2.2 `app_metadata` schema and service

- Entity: `src-tauri/src/db/entities/app_metadata.rs` defines `Model` with `id` PK, unique `key`, `value: String`, `created_at`, `updated_at`, `deleted_at: Option<DateTimeUtc>` (`#[sea_orm(table_name = "app_metadata")]`, L1–19).
- Service: `src-tauri/src/db/service/app_metadata_service.rs` provides generic operations:
  - `upsert_value(conn, key, value)` inserts or updates on key conflict, updating `value` and `updated_at` (`INSERT ... ON CONFLICT(key) DO UPDATE value, updated_at`, L9–33).
  - `get_value(conn, key)` returns `Option<String>` for a non-deleted row (`deleted_at IS NULL`, L35–45).
  - `get_value_conn<C: ConnectionTrait>` is the generic variant (L47–57).
  - `delete_value` soft-deletes by setting `deleted_at` and `updated_at` (L59–72).
  - Tests cover upsert, missing key, and soft delete (L74–102).
- **Key naming:** flat string keys, often namespaced by feature with dots/underscores, e.g. `system_proxy_settings`, `system_language_settings`, `system_terminal_settings`, `system_close_behavior_settings`, `system_rendering_settings`, `delegation.enabled`, `delegation.depth_limit`, `question.enabled`, `feedback.enabled`, `logging.level`, `config_sync_settings`, `config_sync_state` (verified in `system_settings.rs` L26–31; `delegation.rs` L4–10,42–45; `question.rs` L5–7,21–22; `feedback.rs` L3–6,24–25; `config_sync/webdav_sync.rs` L41–46).
- **Serialization:** values are stored as strings. Complex settings are usually JSON-serialized structs (`serde_json::to_string`/`from_str`), while simple toggles/limits may be stored as scalar strings (`"true"`, numbers) depending on the domain. Examples: system settings structs serialized as JSON (`system_settings.rs` L495, and similar save paths); delegation/question/feedback use scalar/JSON values as appropriate (`delegation.rs` L42–45, `question.rs` L21–22, `feedback.rs` L24–25).
- **Defaults/malformed handling:** representative services parse stored JSON and fall back to defaults on missing/corrupt data rather than failing hard. `system_settings.rs` normalizes/validates settings and has load/save/apply helpers; `webdav_sync.rs` `load_settings` returns defaults on missing/parse/read errors and logs warnings (L276–314). `preferences.rs` returns `Default::default()` for missing/unreadable/malformed startup prefs (L27–35).
- **Atomicity/transactions:** individual `app_metadata` upserts are single-row operations. Config sync applies domain snapshots in a **single database transaction** and rolls back on domain failure (`snapshot.rs` `apply_snapshot_core`, L137–187). It also suppresses auto-sync during apply/import/rollback to avoid uploading half-applied state (`local_io.rs` L267–278; `webdav_sync.rs` download/apply path L772–776; `auto_sync.rs` suppression L52–83).
- **Access pattern:** generic metadata service + domain-specific `*_core`/load/save/apply functions. Commands/handlers call domain cores; cores read/write `app_metadata` and may emit events or apply runtime state.

### 2.3 Representative settings lifecycle flows

#### A. System language settings (portable app setting, cross-client broadcast)
- **UI read:** frontend calls `getSystemLanguageSettings()` (`src/lib/api.ts` L2014+ area shows system settings APIs; `src/components/i18n-provider.tsx` loads settings on mount, L183–203).
- **API/command:** Tauri command `get_system_language_settings` / `update_system_language_settings` in `src-tauri/src/commands/system_settings.rs` (constants/handlers around L27, and update/load helpers; web handler mirrors in `src-tauri/src/web/handlers/system_settings.rs` L9–28,35+). Web mode uses HTTP handlers that call the same core logic.
- **Validation/normalization:** settings are normalized to supported locales/modes (`i18n.ts` `normalizeLanguageSettings`, `DEFAULT_LANGUAGE_SETTINGS`, L1–35,120+; `system_settings.rs` language settings load/save helpers).
- **Persistence:** JSON stored in `app_metadata` under `system_language_settings` (`SYSTEM_LANGUAGE_SETTINGS_KEY`, `system_settings.rs` L27; web handler references same key, `web/handlers/system_settings.rs` L10).
- **Runtime update:** frontend provider updates local state and persists a localStorage/cookie cache for fast startup/SSR-like behavior (`i18n-provider.tsx` L58–80,125–132,210–213; `i18n.ts` storage/cookie keys L16–18).
- **Cross-window/cross-client update:** backend emits `app://language-settings-updated` / `LANGUAGE_SETTINGS_UPDATED_EVENT` (`system_settings.rs` event constant usage; `web/handlers/system_settings.rs` imports `LANGUAGE_SETTINGS_UPDATED_EVENT`; frontend subscribes in `i18n-provider.tsx` L39,155–181). Tauri uses event listeners; web transport uses subscriptions.
- **Startup restore:** frontend loads from backend, falls back to local cache/defaults, and resolves system locale candidates (`i18n-provider.tsx` L101–213).
- **Missing/malformed:** normalization/default fallback (`normalizeLanguageSettings`, `DEFAULT_LANGUAGE_SETTINGS`).

#### B. System terminal settings (portable app setting, runtime apply + broadcast)
- **UI read/write:** frontend terminal context loads `getSystemTerminalSettings()` and subscribes to `app://terminal-settings-updated` (`src/contexts/terminal-context.tsx` L17–18,45,286–320).
- **Backend:** `system_settings.rs` defines `SYSTEM_TERMINAL_SETTINGS_KEY = "system_terminal_settings"` (L28), `apply_persisted_terminal_settings` (L317+), and a shared persist/apply/broadcast path that emits `TERMINAL_SETTINGS_UPDATED_EVENT` via `crate::web::event_bridge::emit_event` (L336–363). Web handler accepts `{ settings }` wrapper (`web/handlers/system_settings.rs` L30–33).
- **Persistence:** JSON in `app_metadata`.
- **Runtime update:** applied to terminal shell runtime config and broadcast to listeners.
- **Missing/malformed:** load helpers normalize/fallback (pattern consistent with system settings module).

#### C. Close-window behavior (portable preference with device/runtime constraints)
- **Backend:** `system_settings.rs` stores `system_close_behavior_settings` (`SYSTEM_CLOSE_BEHAVIOR_SETTINGS_KEY`, L30), caches behavior in-process (`CLOSE_BEHAVIOR_CACHE`, L382–454), loads/saves settings (`load_system_close_behavior_settings` L461+, `save_system_close_behavior_settings` L485+), applies persisted behavior on startup (`apply_persisted_close_behavior`, L506–508), and exposes get/update commands (L592–660). The module contains careful logic around close prompts/emits because delivery to a dialog is not provable (L399–554).
- **Boundary:** the preference is stored in SQLite, but its effect is constrained by desktop runtime/tray capability (`preferences`/tray checks referenced in config-sync portable key comment: `minimize` is safe to carry because close path short-circuits on `can_hide_to_tray()` before reading preference, `config_sync/portable_keys.rs` L20–23).
- **Cross-client:** desktop/web clients can read/update through commands/handlers; runtime effect is local to the desktop process.

#### D. Delegation/question/feedback toggles (feature settings in `app_metadata`, runtime config push)
- **Delegation:** `src-tauri/src/commands/delegation.rs` persists `delegation.enabled`, `delegation.depth_limit`, `delegation.agent_defaults`, `delegation.completed_cache_max_mb` in `app_metadata` (L4–10,42–45). `apply_persisted_config` reads keys and pushes into live `DelegationBroker`; `set_delegation_settings_core` writes and immediately re-applies (L10–18). Old `delegation.default_timeout_seconds` is ignored on read (L14–17).
- **Question:** `src-tauri/src/commands/question.rs` persists `question.enabled` (default true) in `app_metadata` (L5–7,21–22). Startup applies persisted config into shared `QuestionRuntimeConfig`; UI save writes and re-applies (L16–20).
- **Feedback:** `src-tauri/src/commands/feedback.rs` persists `feedback.enabled` (default false) in `app_metadata` (L3–6,24–25). Startup applies into shared `FeedbackRuntimeConfig`; save writes and re-applies (L8–13). Frontend subscribes to `feedback-settings://changed` (`src/hooks/use-feedback-enabled.ts` L10,26,101–107; `src/lib/types.ts` L667–668).
- **Pattern:** SQLite key/value persistence + in-memory/runtime config + event/broadcast for UI convergence.

#### E. Config sync settings/state (device-local sync control, secrets outside row)
- **Settings/state keys:** `config_sync_settings` and `config_sync_state` are stored in `app_metadata` but are **not portable** (`webdav_sync.rs` L41–46; `portable_keys.rs` L47–56 forbids them). `config_sync_state` tracks last uploaded hash/target/time/error (L226–242,542–559).
- **Secrets:** WebDAV password and snapshot passphrase are stored in keyring/token store, not in the settings row (`webdav_sync.rs` L64–74,156–175,292–314,1001–1026; `credentials.rs` L1–57). Legacy plaintext password migration moves it out of the row and retries interrupted migrations (L294–382,1031–1133).
- **Upload/download:** upload is hash-compared and target-aware; unchanged snapshots skip network (`upload_snapshot_core`, L584–663; tests L1444–1577). Download is explicit/manual, validates manifest/checksum/schema/encryption, suppresses auto-sync during apply, saves rollback, and applies snapshot (`download_and_apply_core`, L729–783). Auto-sync loop uploads only, never downloads (`auto_sync.rs` L1–24,107–158).
- **Portable allowlist:** only selected `app_metadata` keys and selected domain data travel; allowlist is checked on collection and on application (`portable_keys.rs` L13–78; `domains.rs` preferences collection/apply L908–955; `snapshot.rs`/`local_io.rs` parse/validate/apply paths).

### 2.4 Cross-window and cross-client synchronization

- **Event bridge:** `src-tauri/src/web/event_bridge.rs` defines `WebEvent { channel, payload: Arc<serde_json::Value> }` and `WebEventBroadcaster` using `tokio::sync::broadcast` (L1–34+). Payloads are `Arc` to avoid copying large JSON trees per subscriber (L9–17). The module bridges internal/Tauri events to web clients and carries many channels (file read/write, session events, settings-related events, etc., L1–120+).
- **Emission pattern:** domain cores/commands emit events after persistence/runtime apply, e.g. terminal settings emit via `emit_event` (`system_settings.rs` L336–363), assistant changes emit `assistant://changed` resync after config snapshot apply when assistants changed (`snapshot.rs` L134–186), config-sync auto status emits `config-sync://status` (`auto_sync.rs` L34–173). Frontend subscribes through Tauri `listen` or web transport `subscribe` (`i18n-provider.tsx` L155–181; `terminal-context.tsx` L298–319; `use-feedback-enabled.ts` L101–107; `api.ts`/transport abstractions).
- **Consistency model:** **eventual/best-effort convergence after successful writes**, not transactional cross-client consistency. A write persists first (or as part of its core path), then emits/broadcasts; listeners refresh local state. There is no evidence of a global settings revision number, ETag/If-Match protocol, or distributed lock for ordinary settings.
- **Concurrency controls:** per-key `app_metadata` upserts are last-write-wins at the row/key level. Config snapshot apply is transactional across domains (`snapshot.rs` L150–178). Auto-sync/upload has a remote lock and suppression counter to avoid interleaving uploads and uploading during apply/import (`webdav_sync.rs` `remote_lock` L266–269; `auto_sync.rs` suppression L52–83). WebDAV upload order is `config.json` then `manifest.json` so interrupted uploads fail checksum validation rather than appearing valid (`webdav_sync.rs` L10–18,621–637).
- **Multi-window/remote behavior:** Tauri windows receive Tauri events; web/remote clients receive broadcast/subscription events through the transport/event bridge. Some settings also use localStorage/cookies as UI caches (language provider stores normalized settings/cookies, `i18n-provider.tsx` L58–80,210–213), but backend `app_metadata` remains the persisted source for those settings.
- **Fundamental vs CodeG-specific:** fundamental patterns are key/value metadata persistence, typed domain normalization, and post-write event notification. CodeG-specific complexity comes from Tauri+web dual runtime, remote web clients, WebDAV config sync, tray/close behavior, and runtime process integration.

### 2.5 Storage boundaries (CodeG does not store everything in SQLite)

| Boundary | CodeG owner/evidence | Why it exists |
|---|---|---|
| SQLite `app_metadata` application settings/preferences | `app_metadata` entity/service/migration; system settings, delegation/question/feedback, logging, appearance/language/close behavior, config-sync settings/state keys (device-local but still metadata) (`app_metadata_service.rs`; `system_settings.rs`; `delegation.rs`; `question.rs`; `feedback.rs`; `webdav_sync.rs`) | Simple durable key/value store for many small settings; easy per-key upsert and startup load. |
| Startup preferences outside SQLite | `src-tauri/src/preferences.rs` stores `~/.codeg/preferences.json` (e.g. `disable_hardware_acceleration`) read synchronously before Tauri builder/tokio/webview startup (L1–53) | Must be readable before DB/runtime/webview initialization; tiny synchronous file is appropriate. |
| Credentials/secrets | Config-sync WebDAV password and snapshot passphrase in keyring/token store, not settings row (`config_sync/credentials.rs`; `webdav_sync.rs` L64–74,292–314,1001–1026). Legacy plaintext password migrated out of row (L294–382). | Secrets must not live in plaintext SQLite rows or portable snapshots/backups. |
| Device-specific OS configuration | OS autostart and tray/window/runtime behaviors are handled by OS/Tauri/runtime code; close behavior preference interacts with tray capability (`system_settings.rs` close behavior cache/apply; `portable_keys.rs` L20–23 notes tray short-circuit). | OS/runtime is authoritative for machine integration. |
| Domain-owned data | Config sync snapshot domains include model providers, agent settings, custom agents, assistants, quick messages, task templates, and selected preferences (`config_sync/domains.rs` L44–159,232+). These are domain tables/records, not generic app settings. | Domain schemas need natural keys, relations, validation, and targeted apply semantics. |
| Portable configuration export/import/WebDAV | `config_sync/*`: allowlist (`portable_keys.rs`), domain DTOs/collect/apply/validate/count (`domains.rs`), snapshot/manifest/checksum/schema/rollback (`snapshot.rs`), local file import/export and rollback (`local_io.rs`), WebDAV settings/upload/download/peek (`webdav_sync.rs`), auto upload loop with suppression/backoff (`auto_sync.rs`), keyring credentials (`credentials.rs`). | Portability/sync is a separate product boundary with security, integrity, conflict, and partial-apply rules. |
| Runtime/process/in-memory state | In-memory caches and runtime configs (e.g. close behavior cache, delegation/question/feedback runtime configs, terminal runtime config) are applied from persisted settings but not themselves the durable source. | Fast runtime access and process-local behavior; durable source remains persisted settings/domain data. |

**Conclusion:** CodeG’s strongest reusable pattern is **authoritative SQLite metadata for selected portable settings + typed domain cores + explicit non-SQLite boundaries**. It is not “put everything in SQLite”.

---

## 3. TBAI current-state inventory (re-audited)

Evidence is current source. “Proposed TBAI owner” is a recommendation, not implementation.

| Setting/state | Current owner | Current storage | Required behavior | CodeG equivalent | Proposed TBAI owner | Evidence |
|---|---|---|---|---|---|---|
| Theme mode | `web/src/features/appearance/theme-storage.ts`, `ThemeProvider`, `web/index.html` pre-paint | `localStorage["tbai-theme"]` | No flash; portable across clients of same backend; preserve existing value | Portable appearance preference in metadata-like settings domain (CodeG stores many UI prefs in `app_metadata`; exact theme key not inspected here) | SQLite portable prefs + local pre-paint cache | `theme-storage.ts` L24,28,46–53; `index.html` L22–35 |
| Light/dark palette ids | `theme-storage.ts`, `ThemeProvider`, `index.html` | `localStorage["tbai-theme-light"|"tbai-theme-dark"]` | No flash; independent per mode; preserve existing values | Portable appearance preference | SQLite portable prefs + local pre-paint cache | `theme-storage.ts` L25–26,55–68; `index.html` L28–29 |
| Typography config v3 | `typography.ts`, `index.html`, `main.tsx`, `TypographyPage.tsx` | `localStorage["tbai-typography"]` JSON | No flash/layout shift; preserve v1/v2/v3 migration/normalization; portable | Portable preference with normalization; CodeG uses typed load/save/normalize patterns | SQLite portable prefs + local pre-paint cache | `typography.ts` L15–63,254,490–664; `index.html` L36–166; `main.tsx` L8–11 |
| Window zoom (desktop WebView) | `web/src/lib/platform.ts`, `TypographyPage.tsx` | `localStorage["tbai-window-zoom"]` + Tauri native `setZoom` | Device/runtime-specific; browser unsupported; native authority in Tauri | Device/OS/runtime-specific display behavior; CodeG has rendering/zoom-like device concerns outside generic portable prefs | Keep device-local (native authority + local cache) | `platform.ts` L237–445 |
| Sidebar visible/status bar/chat width/sort/section order/collapsed/show completed/spell check | `web/src/features/desktop/state/desktopLayout.ts` (Zustand persist) | `localStorage["tbai:desktopLayout"]` | Portable UI prefs; preserve existing values; split from device geometry | Portable UI preferences (CodeG `app_metadata` pattern) | SQLite portable prefs (portable subset only) | `desktopLayout.ts` L30–54,120–260 |
| Sidebar width px | `desktopLayout.ts` | same `tbai:desktopLayout` blob | Device/display-specific geometry; do not sync pixel width | Device-local layout geometry | Keep device-local; extract from portable blob | `desktopLayout.ts` L34–35,124,168–171,196,250 |
| Last settings route | `web/src/config/navigation.ts` | `localStorage["tbai:settingsRoute"]` | Low-value convenience; portable optional | Portable UI convenience preference | SQLite portable prefs (low priority/optional) | `navigation.ts` L307–327 |
| Welcome engine/agent/model/variant | `web/src/features/chat/state/welcomeEngine.ts` | `localStorage["tbai:welcome-engine"]` | Draft defaults; engine-specific fields cleared on engine switch; product decision on portability | Portable user defaults/toggles pattern | SQLite portable prefs, subject to product decision | `welcomeEngine.ts` L3–134 |
| Welcome auto-approve shield | `welcomeEngine.ts` | same | **Security/UX sensitive**; materializes to `conversations.opencode_auto_approve`; fail closed | Feature toggle/default with runtime effect; CodeG toggles are explicit and often default-safe | **Defer/owner decision**; if persisted, fail closed and never silently expand permissions | `welcomeEngine.ts` L10–28,67–69,91–121; `db/index.ts` L319–321; `validation.ts` L190–191,221; `routes/conversations.ts` L180 |
| Welcome scope (mode/folderId) + quick actions tab | `web/src/features/chat/state/welcomeScope.ts`, `config/welcome.ts` | `localStorage["tbai:welcome-scope"]`, `["tbai:quick-actions-tab"]` | Mode/tab portable; folderId references server folder registry but folder paths/availability may differ across machines; validate/fallback | Portable defaults with domain references; CodeG config sync remaps/validates domain references carefully | SQLite portable prefs with safe folder fallback, subject to decision | `welcomeScope.ts` L11–119 |
| Open tabs + active tab | `web/src/features/chat/state/chatTabs.ts` | `localStorage["tbai:openTabs"]` | Workbench layout; refs are server conversation ids; same-browser storage convergence exists; cross-client sync may surprise | UI/workbench state; not clearly equivalent to CodeG portable config-sync prefs | **Defer/product decision** (device-local, portable, or opt-in restore) | `chatTabs.ts` L6,92–153,232–370 |
| Selected folder / folder expansion (Folders UI) | `web/src/features/folders/state/foldersStore.ts` | `localStorage["tbai:selectedFolder"]`, `["tbai:folderExpanded"]` | Navigation/expansion UI state; refs server folder ids | UI navigation state | Keep device-local by default (or defer) | `foldersStore.ts` L62–81,101–107,242–267 |
| Unsent composer drafts | `web/src/features/chat/state/composerDraft.ts` | `localStorage["tbai:composer-draft:<threadKey>"]` | Crash-recovery convenience; unsent user text; not portable preference | Not a portable setting | Keep device-local transient/durable draft state | `composerDraft.ts` L11–61 |
| Pending first OpenCode prompt handoff | `web/src/features/chat/state/pendingFirstMessage.ts` | `localStorage["tbai:pending-first-prompt:<conversationId>"]` | Exactly-once workflow handoff; idempotent message id; never replay/sync | Runtime workflow state, not setting | Keep device-local transient workflow state | `pendingFirstMessage.ts` L1–169 |
| Direct resumable stream pointer | `web/src/features/chat/state/resumable-stream.ts` | `sessionStorage["tbai-resume:<threadId>"]` | Tab-scoped recovery pointer | Runtime recovery state | Keep transient | `resumable-stream.ts` L3–128 |
| Scheduler badge seen timestamp | `ActivityBar.tsx`, `SchedulerPage.tsx` | `localStorage["tbai:schedSeenTs"]` | Device-local dismissal UI | UI dismissal state | Keep device-local | `ActivityBar.tsx` L31; `SchedulerPage.tsx` L31,151 |
| Log capture settings | `src/services/log-settings.ts`, `src/routes/logs.ts`, `validation.ts` | SQLite `app_settings["log.settings"]` JSON | Process-local logging/file sink; env may lock | Runtime/process logging config; CodeG has logging/operational settings patterns but boundary differs | Keep existing `app_settings`/service owner (device/process config) | `log-settings.ts` L10,37–88; `routes/logs.ts` L41–86; `validation.ts` L819–847,904 |
| Server configured port | `src/services/server-port.ts`, `src/routes/server.ts` | SQLite `app_settings["server.port"]` + `data/port` mirror | Network/process binding; Tauri rendezvous; env lock | Device/process/runtime config, not portable UI pref | Keep existing owner | `server-port.ts` L7–79; `routes/server.ts` L26–53; `validation.ts` L907–910 |
| Start minimized | `src/services/startup-prefs.ts`, `src/routes/server.ts`, `src-tauri/src/main.rs` | SQLite `app_settings["server.startMinimized"]` + `data/start-minimized` mirror | Desktop machine behavior; launcher reads mirror | Device/desktop startup behavior; CodeG close/startup behaviors have device constraints | Keep existing owner | `startup-prefs.ts` L6–49; `routes/server.ts` L122–139; `main.rs` L121–125,954–959 |
| Tool approval HMAC secret | `src/services/credentials.ts` | SQLite `app_settings["security.tool_approval_secret"]` encrypted envelope | Security material; fail closed; never expose | Secret/credential boundary (CodeG keeps secrets out of portable settings/snapshots) | Keep encrypted existing owner; never portable prefs | `credentials.ts` L23,95–164 |
| Provider configs/active provider | `src/routes/providers.ts`, `src/db/index.ts` | SQLite `provider_configs` | Domain config; shared in same DB | Domain-owned config (CodeG config sync treats model providers/agent settings as domains with DTOs/remapping) | Keep domain owner | `db/index.ts` L90–103,420–424; `routes/providers.ts` L40–185 |
| Provider API keys | `src/services/credentials.ts`, `routes/providers.ts` | SQLite `provider_configs.encrypted_api_key` | Secret; server-only | Secret boundary | Keep encrypted domain/credential owner | `credentials.ts` L173–227 |
| Conversation settings/state | `src/routes/conversations.ts`, `db/index.ts`, `validation.ts` | SQLite `conversations` | Per-conversation domain state | Domain-owned records | Keep domain owner | `db/index.ts` L146–396; `validation.ts` L166–222; `routes/conversations.ts` L104–354 |
| MCP server config | `src/routes/mcp.ts`, `db/index.ts`, `validation.ts` | SQLite `mcp_servers`; `auth_token` encrypted; `headers`/`env` JSON text | Domain config; auth token sensitive | Domain config + secret boundary | Keep domain owner; preserve secret handling | `db/index.ts` L437–465; `validation.ts` L492–550 |
| Scheduler jobs/runs | `src/routes/scheduler.ts`, `db/index.ts`, `validation.ts` | SQLite `scheduler_jobs`/`scheduler_runs` | Domain config/history | Domain-owned records | Keep domain owner | `db/index.ts` L601–697; `validation.ts` L552–743 |
| Folders/groups/links | `db/index.ts`, folder routes/services | SQLite `folders`/`folder_groups`/`folder_links` | Registry shared; filesystem paths machine-specific semantics | Domain-owned records with machine/path caveats | Keep domain owner | `db/index.ts` L541–584 |
| Quick messages | `db/index.ts`, quick-messages routes/store | SQLite `quick_messages` | User content/config domain | Domain-owned portable content in CodeG config sync domain (`quickMessages`) | Keep domain owner | `db/index.ts` L589–599 |
| Memories | `db/index.ts`, memories routes/store | SQLite `memories` | User data domain | Domain-owned data | Keep domain owner | `db/index.ts` L426–433 |
| OS autostart | `web/src/lib/platform.ts`, `StartupSection.tsx`, Tauri plugin | OS registration | Machine/OS-specific | OS-owned/device-specific | Keep OS/Tauri owner | `platform.ts` L212–222; `main.rs` L918–921 |
| Tauri window geometry | `src-tauri/src/main.rs`, window-state plugin | Tauri plugin storage | Machine-specific window placement | Device-local | Keep Tauri plugin owner | `main.rs` L924–933 |
| OpenCode runtime config | `src/routes/opencode.ts`, `services/opencode/*` | OpenCode/runtime files/APIs | Separate runtime boundary | External/runtime domain boundary | Keep OpenCode boundary owner | `routes/opencode.ts` L256–524 |

---

## 4. Direct CodeG-versus-TBAI comparison

| Area | CodeG (verified) | TBAI (verified) | Lesson for TBAI |
|---|---|---|---|
| Authoritative settings store | Generic `app_metadata` key/value table (`key` unique, string `value`, timestamps, soft delete) with `upsert_value`/`get_value` (`app_metadata_service.rs` L9–72; entity/migration). | `app_settings` key/value table exists (`db/index.ts` L136–144) but only for `log.settings`, `server.port`, `server.startMinimized`, encrypted `security.tool_approval_secret`. Portable UI prefs are localStorage/Zustand. | Reuse the *pattern* (typed service over key/value rows) before adding schema. Do not make `app_settings` an untyped junk drawer. |
| Domain logic | Per-domain load/save/apply/broadcast cores; config sync has explicit domain table with collect/validate/count/apply and natural-key upserts (`domains.rs` L79–159,232+). | Domain tables/routes/services already exist for providers, conversations, MCP, scheduler, folders, quick messages, memories. Portable UI prefs lack a domain owner. | Add a portable-preferences domain owner; keep existing domain owners intact. |
| Startup-critical prefs | `preferences.rs` stores `~/.codeg/preferences.json` for pre-webview flags (hardware acceleration) — outside SQLite (L1–53). | Theme/typography are pre-paint critical and read from localStorage in `web/index.html` (L22–166). | Startup-critical UI prefs need a synchronous local cache; SQLite cannot be read before first paint in the browser. |
| Secrets | Config-sync secrets in keyring/token store; settings row never carries password/passphrase; legacy migration removes plaintext (`credentials.rs`; `webdav_sync.rs` L292–382,1001–1026). | Provider keys encrypted in `provider_configs`; MCP auth token encrypted; tool approval secret encrypted in `app_settings` (`credentials.ts`; `db/index.ts` L437–465). | Keep secrets out of portable preferences and out of any export/sync path. |
| Cross-client sync | Event bridge/broadcast + frontend subscriptions; post-write emit; no global settings revision protocol observed (`event_bridge.rs`; `system_settings.rs` emits; frontend listeners). | No settings push channel; localStorage prefs do not propagate; server-backed domain data shared in same DB but UI usually refreshes on fetch/reload. `chatTabs` has same-browser storage convergence only. | Start with pull + write-through + focus/visibility refresh. Do not add WebSocket/event bus without evidence. |
| Portability/export | Config sync is a separate subsystem: allowlist, manifest/checksum, schema version, encryption option, rollback, explicit download, auto upload only (`config_sync/*`). | No equivalent portable-preferences export/import subsystem. | If TBAI later adds export/import, copy CodeG’s boundary discipline: allowlist, checksums, schema/version, secrets excluded, explicit apply/rollback. |
| Atomicity | Single-row metadata upserts; multi-domain snapshot apply in one transaction with rollback (`app_metadata_service.rs`; `snapshot.rs` L150–178). | `app_settings` writes are simple upserts; domain routes/services vary. No portable-prefs transaction boundary yet. | Per-key preference updates are fine; multi-key writes should be validate-all then apply predictably, or per-key with explicit partial semantics. |
| Malformed data | Defaults/fallbacks common; config sync validates manifests/domains and refuses unsafe applies (`webdav_sync.rs` load defaults; `snapshot.rs` parse/validate; `local_io.rs` parse). | Many local stores fail safe to defaults; server schemas validate inputs; `app_settings` consumers parse defensively. | Every portable preference key needs schema/default/normalization and corrupt-data fallback. |

---

## 5. Storage and ownership classification

### 5.1 Portable application preferences (SQLite authoritative, after migration)

Candidates: theme mode, light/dark palette ids, typography config, portable desktop layout fields (`sidebarVisible`, `statusBarVisible`, `chatWidth`, `sidebarSort`, `sectionOrder`, `sectionCollapsed`, `showCompleted`, `spellCheck`), last settings route (low priority), welcome engine/agent/model/variant (product decision), welcome scope mode/tab with folder fallback (product decision). **Deferred/decision:** `autoApprove` (security-sensitive), open tabs (workbench layout).

**Rule:** stored as typed, validated portable preference keys/groups; local cache only where required for startup paint.

### 5.2 Device-local preferences

`sidebarWidth` px, window zoom/native zoom cache, OS autostart, Tauri window geometry, Folders UI selected folder/expanded map (default), scheduler badge seen timestamp (default), any machine-specific display/layout geometry.

**Rule:** keep local to device/runtime/profile; do not sync as portable preferences.

### 5.3 Runtime/process configuration

`log.settings`, `server.port`, `server.startMinimized` (and their mirror files), OpenCode runtime process/config boundaries, in-memory caches, active listener state.

**Rule:** keep existing owners. They may live in `app_settings` or runtime files/plugins, but they are not portable UI preferences.

### 5.4 Domain-owned records

`provider_configs`, `conversations`/messages/compactions/todos, `mcp_servers`, `scheduler_jobs`/`scheduler_runs`, `folders`/`folder_groups`/`folder_links`, `quick_messages`, `memories`, OpenCode runtime config/documents.

**Rule:** never duplicate into generic preferences. If a global default is needed later, store only the default reference, not the domain record.

### 5.5 Transient state

Unsent composer drafts, pending first OpenCode prompt handoff, direct resumable stream pointers, in-memory search UI, one-shot UI/runtime flags.

**Rule:** do not persist as shared portable preferences. Device-local crash-recovery drafts/handoffs may remain local by explicit design.

### 5.6 Sensitive credentials and security controls

Provider API keys, MCP auth tokens, tool approval HMAC secret, local DEK/credential envelopes, any future sync/export passphrases/tokens.

**Rule:** encrypted/secret-store owners only; never in portable preferences, never in browser responses, never in export/sync unless a separate explicit encrypted design is approved.

### 5.7 Startup-critical preferences

Theme mode/palettes and typography are startup-critical for first paint in TBAI (`web/index.html` L22–166). Server port/start-minimized are startup-critical for process/Tauri launcher but are process/device concerns, not portable UI prefs.

**Rule:** synchronous local cache/bootstrap for UI paint; mirror files or runtime files only where an external process must read before normal app APIs.

---

## 6. Options A/B/C evaluation

| Criterion | A. Extend existing `app_settings` with a typed portable-preferences service | B. Dedicated portable-preferences table | C. Other CodeG-inspired approach (e.g. namespace/scope column, single JSON document, or config-sync-style domain registry now) |
|---|---|---|---|
| Simplicity | **High** for schema (table exists); medium for discipline. Closest to CodeG’s generic metadata pattern and TBAI’s current shape. | Medium: additive table/migration and a second settings-like store. | Low-medium to low: more concepts than needed now. |
| Duplicate infrastructure | Low if existing process/security keys remain owned by current services and portable prefs get one service. | Medium: another table/service alongside `app_settings`. | Medium-high: risks parallel registries/framework. |
| Number of custom modules | **Low**: one service + validation/schema helpers + route(s), reusing existing patterns. | Low-medium: same plus migration/schema ownership. | Medium-high. |
| Migration complexity | Low schema, medium data ownership/import. | Medium schema + data import. | Medium-high. |
| Type safety | Good if enforced by service/Zod per key; table remains untyped. | **Best structural** type/ownership separation. | Depends; document/blob approaches reduce safety. |
| Independent setting updates | **Good** with per-key rows (`key` PK already supports upsert). | Good with per-key rows. | Poor if single JSON document; okay if namespaced rows but more complex. |
| Atomicity | Per-key upsert is atomic; multi-key updates need explicit validate/apply semantics. Same as B. | Same. | Same or worse. |
| Startup performance | No schema advantage; UI startup still needs local pre-paint cache. | Same. | Same. |
| Cross-client consistency | Same: depends on API + refresh/reconciliation, not table choice. | Same. | Same. |
| Testability | Good with typed schemas and service tests. | Good. | Variable; framework/registry increases surface area. |
| Tauri compatibility | Good; same backend API/cache model. | Good. | Good if kept simple. |
| Portability/backup | Neutral; export/import would need allowlist regardless of table. | Neutral. | Config-sync-style registry is useful later, but premature now. |
| Security boundaries | Requires strict key allowlist/namespace discipline because secrets/process keys already live in `app_settings`. | Stronger structural separation from process/security keys. | Can be strong, but easy to overbuild. |

**Evaluation:** **Option A is recommended** for TBAI now, with guardrails. CodeG demonstrates that a generic key/value metadata store works when every domain has typed normalization and explicit boundaries; TBAI can apply that lesson by creating a **typed portable-preferences service** that owns only an allowlisted set of portable keys in `app_settings` (or a reserved namespace convention), while `log.settings`, `server.port`, `server.startMinimized`, and `security.tool_approval_secret` remain owned by their existing services and are never exposed/mutated by the portable-preferences API. **Option B** is acceptable if maintainers want hard separation from process/security rows; it is not required by current evidence. **Option C** is not recommended now: a single JSON document creates coarse conflicts; a full config-sync domain registry is premature before TBAI has a portable-preferences product boundary.

---

## 7. Recommended TBAI architecture

### 7.1 Ownership

- **Authoritative SQLite owner for portable app prefs:** a new typed `PortablePreferencesService` (name illustrative) using `app_settings` per-key rows under an explicit allowlist/namespace, e.g. `prefs.appearance.theme`, `prefs.appearance.typography`, `prefs.desktop.layout`, `prefs.welcome.defaults`, `prefs.navigation.settingsRoute`. Exact key names are implementation details; the allowlist is the contract.
- **Existing `app_settings` owners remain authoritative for their keys:** `log-settings.ts` (`log.settings`), `server-port.ts` (`server.port`), `startup-prefs.ts` (`server.startMinimized`), `credentials.ts` (`security.tool_approval_secret`). The portable-preferences service must reject these keys.
- **Domain owners unchanged:** providers, conversations, MCP, scheduler, folders, quick messages, memories, OpenCode runtime config.
- **Device-local owners unchanged:** Tauri window state/autostart, native zoom, sidebar pixel width, folder UI selection/expansion by default, scheduler seen timestamp by default.
- **Transient owners unchanged:** composer drafts, pending first prompt, resumable stream pointers.

### 7.2 Data flow

```text
Pre-paint (sync, before React):
  web/index.html -> read localStorage cache (theme/typography)
                 -> normalize/migrate (same rules as canonical TS)
                 -> apply DOM/root styles

Post-mount hydration (async):
  React/bootstrap -> GET /api/preferences (or equivalent)
                  -> validate/normalize server values
                  -> apply to stores/DOM
                  -> write-through refresh local pre-paint cache
                  -> if server missing key and local cache has valid migratable value:
                       run deterministic first-migration import (once, guarded)
                       -> server becomes authoritative

User changes portable pref:
  UI -> validate locally -> optimistic apply (optional)
     -> PATCH /api/preferences { key/group, value }
     -> server validates/normalizes -> upsert SQLite
     -> response returns confirmed value
     -> UI commits confirmed value -> refresh local cache

Other client observes:
  focus/visibility/reload -> GET /api/preferences
                          -> reconcile (server wins after successful load)
                          -> refresh local cache
```

### 7.3 API/service shape (minimal)

- Follow existing Hono route composition (`src/routes/index.ts`), Zod validation (`src/lib/validation.ts` conventions), and small service modules (`src/services/*`).
- Suggested endpoints: `GET /api/preferences` returns allowlisted portable preferences with defaults; `PATCH /api/preferences` accepts one or more allowlisted keys/groups, validates each independently, rejects unknown keys/secrets/process keys, and returns confirmed values. Avoid a generic opaque blob overwrite.
- No secrets, no domain records, no transient drafts/handoffs/resume pointers in payloads.
- Errors use existing structured error patterns; do not log raw preference payloads unnecessarily.

### 7.4 Why this fits CodeG’s lesson without copying CodeG

CodeG’s reusable core is: **generic durable metadata + typed per-domain behavior + explicit boundaries**. TBAI can reuse that core with far less machinery because it does not need CodeG’s Tauri/web event bridge complexity, WebDAV sync, or multi-runtime settings surface for this task. The study borrows the discipline (allowlists, normalization, startup boundaries, secrets outside portable prefs, transactional apply where needed) while keeping TBAI’s implementation small.

---

## 8. Migration strategy

### 8.1 Deterministic rules

1. **SQLite becomes authoritative only after a successful validated read/write/import.** Local cache is never authoritative after successful hydration.
2. **Never let arbitrary stale localStorage overwrite an established SQLite value.** If a server value exists for a key, reconcile client cache/state to server.
3. **First migration/import:** only when the server has no authoritative value for that key/group may a client import a valid, normalized local value. Use a per-key migration marker/guard (server-side state or a dedicated metadata key) so repeated startups do not re-import.
4. **Validate and normalize before import.** Typography must pass the same v1/v2/v3 migration/normalization rules as `typography.ts`/`index.html`. Theme ids/modes must be validated against known values/defaults.
5. **Preserve device-local values.** Do not import `sidebarWidth`, window zoom, Tauri window state, OS autostart, server port/start-minimized/log settings, drafts, handoffs, resume pointers, badge dismissal, or folder UI selection/expansion by default.
6. **Corrupt legacy data:** ignore invalid localStorage payloads and fall back to defaults; do not write corrupt data to SQLite.
7. **Failed migration attempts:** leave existing authoritative SQLite untouched; keep local cache usable; record safe diagnostic state/logging; retry only according to the guarded first-migration rule.

### 8.2 Existing installs

| Case | Behavior |
|---|---|
| Existing SQLite value present | Load server value, apply it, refresh local cache. Ignore stale localStorage for authority. |
| No SQLite value, valid localStorage value | First eligible client imports normalized value once; server stores it; cache refreshed from confirmed server value. |
| No SQLite value, missing/invalid localStorage | Use defaults; optionally persist defaults only through normal validated write path if product wants explicit rows. |
| Corrupt localStorage | Fall back to defaults/cache-safe behavior; do not import. |
| Corrupt SQLite value (unexpected) | Service validates/normalizes; if unrecoverable, fall back to default and log safely; do not crash startup/API. |

### 8.3 First browser / multiple browsers / same backend

- **First browser:** may seed missing server keys from its valid local cache under the guarded first-migration rule.
- **Multiple browsers, same backend:** after migration, all read/write the same SQLite-backed preferences through the backend. Concurrent edits are last-write-wins per key/group unless a later revision mechanism is added.
- **Conflicting pre-migration local values:** unavoidable before first seed. Deterministic rule: first successful validated import wins only when server lacks the key; thereafter server wins. This may change a browser’s local appearance once, which is safer than silent multi-writer overwrites.

### 8.4 Repeated startup and stale caches

- Pre-paint always reads local cache synchronously.
- After hydration, server value refreshes cache. A stale cache can affect only the initial paint of a client that has not yet reconciled; it must not overwrite server state.
- Cache metadata (e.g. updated timestamp/version) may be added only if kept simple and consistent; it is not required for correctness if reconciliation always prefers confirmed server state.

### 8.5 User retention

- Existing theme/typography customizations are preserved by reading current localStorage keys, normalizing/migrating them, and importing them when server has no authoritative value.
- Existing desktop layout/welcome/navigation values are preserved by field-mapped extraction from current stores/keys; mixed blobs must be split (portable fields imported, device-local fields retained locally).

---

## 9. Theme/typography startup strategy

### 9.1 Current TBAI constraint (verified)

`web/index.html` applies theme and typography before React mounts by reading localStorage and setting classes/attributes/CSS variables/root font size (L22–166). `typography.ts` contains canonical normalization/migration/DOM application (L490–664) and `main.tsx` reads typography on startup (L8–11). This avoids flash/layout shift and must be preserved.

### 9.2 Strategy

1. **Synchronous first paint:** keep `web/index.html` (or an equivalent synchronous pre-paint path) reading local cache keys (`tbai-theme*`, `tbai-typography`) and applying normalized values before first paint. No backend fetch in pre-paint.
2. **Local cache/SQLite interaction:** local cache is a write-through bootstrap cache. SQLite is authoritative after successful hydration. Writes update SQLite first/authoritatively via API response confirmation, then refresh cache.
3. **Stale cache detection:** on successful hydration, compare normalized server values to cache; if different, apply server values and rewrite cache. Optional cache metadata is secondary; correctness comes from server reconciliation.
4. **Migration:** import existing local theme/typography only when server lacks authoritative values, using canonical validation/migration. Preserve v1/v2/v3 typography semantics (`typography.ts` L326–495; `index.html` L90–144).
5. **SQLite authority after hydration:** once `GET /api/preferences` succeeds, in-memory state and subsequent cache writes come from confirmed server values.
6. **Failure behavior:** if backend unavailable, use last valid cache/defaults; do not mark cache authoritative over missing server confirmation; retry hydration on next trigger. If cache is corrupt, fall back to defaults (current fail-safe behavior).
7. **Pre-paint/runtime normalization consistency:** eliminate drift risk. Preferred implementation order: **short term** keep duplication only with strong drift tests (already indicated by `index.html` L40–42 and typography tests); **target** generate or share a framework-free normalization module/snippet used by both pre-paint and runtime. Do not add async pre-paint or a runtime dependency that delays first paint.

### 9.3 Theme/typography cache rules

- Cache keys may remain `tbai-theme`, `tbai-theme-light`, `tbai-theme-dark`, `tbai-typography` for compatibility.
- Cache values are normalized/canonical.
- Cache never overwrites an established server value.
- Cache may seed server only under the guarded first-migration rule.

---

## 10. Concurrency and synchronization strategy

### 10.1 Recommended model (smallest reliable)

- **Per-key/group updates:** `appearance.theme`, `appearance.typography`, `desktop.layout`, `welcome.defaults`, `navigation.settingsRoute` as independent units. A theme change must not overwrite typography.
- **Atomic DB operations:** each key upsert is atomic (`INSERT ... ON CONFLICT DO UPDATE` pattern, as TBAI already uses for `app_settings` and CodeG uses for `app_metadata`). Multi-key PATCH should validate all keys first; apply either per key with explicit per-key results or in a clearly defined transaction. Avoid partial silent corruption.
- **Concurrent writes from multiple windows/clients:** last-write-wins per key/group is acceptable for v1. No global lock.
- **Same-setting conflicts:** LWW per key. If product later needs stronger guarantees, add optional `updatedAt`/revision and conditional write (`If-Match`/expected revision) per key only.
- **Stale frontend responses:** client applies only responses matching its latest request context where practical; after focus/visibility refresh, server state wins.
- **Cross-client refresh:** no WebSocket/event bus initially. Refetch on window focus and/or `visibilitychange` (throttled), after successful writes, and on reconnect/bootstrap. This covers the “Firefox remains open while Chrome changes theme” case with eventual consistency.
- **Broadcasts/polling:** not necessary initially. CodeG’s broadcasts are useful in its dual-runtime architecture; TBAI can defer equivalent push complexity until evidence shows focus/visibility refresh is insufficient.

### 10.2 Scenario

1. Chrome and Firefox connect to the same TBAI backend/SQLite DB.
2. Both load authoritative portable preferences and refresh local caches.
3. Chrome updates theme; server validates and upserts the theme key; Chrome applies confirmed value and refreshes cache.
4. Firefox has stale in-memory/cache state until focus/visibility refresh or reload.
5. Firefox refetches, receives server theme, applies it, and refreshes its local pre-paint cache. Next cold start uses the refreshed cache.

---

## 11. Test strategy

### 11.1 Existing relevant tests (verified by inspection/references)

- Typography/appearance tests exist: `tests/unit/appearance/typography.test.ts`, DOM typography tests, and `tests/e2e/typography-standardization.spec.ts` (pre-existing modified file in worktree; not changed). `web/index.html` references typography drift comparison (`index.html` L40–42).
- General settings-related behavior is covered indirectly by existing route/service/UI tests patterns in the repo; this study did not execute tests.

### 11.2 Recommended new/expanded tests (if implementation is later authorized)

| Area | Scenario | Type |
|---|---|---|
| Defaults/validation | Missing keys return defaults; unknown keys rejected; invalid theme ids/modes rejected; typography schema rejects/corrects out-of-range values; no secrets accepted. | Unit/service/route |
| Persistence/reload | Save portable pref, reload API/client state, value persists; per-key updates do not clobber unrelated keys. | Integration/route |
| Migration | Existing localStorage theme/typography/desktop/welcome values import when server missing; server-existing values are not overwritten; corrupt localStorage ignored; v1/v2/v3 typography migration preserved. | Unit/integration |
| Theme/typography pre-paint | Pre-paint applies cache before React; no flash/layout shift regression; cache refreshed after server hydration; backend unavailable uses cache/defaults safely. | DOM/E2E/manual visual check as appropriate |
| Cache reconciliation | Stale cache differs from server -> server wins after hydration; cache rewritten. | Integration/DOM |
| Concurrent updates | Two clients update different keys -> both persist; same key -> deterministic LWW result; no unrelated key loss. | Integration |
| Multiple clients | Same backend: change in client A observed by client B after focus/visibility refresh/reload. | Integration/E2E where feasible |
| Malformed data | Corrupt SQLite JSON/value falls back safely; corrupt cache falls back safely; API returns structured errors for invalid writes. | Unit/route |
| Storage/DB failures | DB write failure does not report success; UI keeps last confirmed state; cache not falsely promoted. | Service/route |
| Security boundaries | Portable prefs API never returns/accepts provider keys, MCP auth tokens, tool approval secret, or DEK material; process keys (`log.settings`, `server.port`, `server.startMinimized`, `security.tool_approval_secret`) inaccessible through portable-prefs API. | Route/service |
| Upgrade survival | Existing users keep theme/typography/layout/welcome customizations after migration; Tauri/browser profiles migrate independently as appropriate. | Integration/manual upgrade scenario |

---

## 12. Phased implementation proposal (not authorized)

1. **Design lock:** confirm Option A guardrails (allowlisted portable keys in `app_settings` vs dedicated table), key names/groups, `autoApprove`/open-tabs/folder-ref decisions, and conflict policy (LWW per key).
2. **Service/schema foundation:** add typed portable-preferences service, Zod schemas/defaults/normalizers, and minimal routes. Exclude process/security keys and domain data.
3. **Theme/typography first:** implement authoritative storage + write-through cache + hydration reconciliation; preserve pre-paint path and v1/v2/v3 migration; add/adjust drift tests.
4. **Desktop layout split:** migrate portable `tbai:desktopLayout` fields; keep `sidebarWidth` device-local; preserve existing users.
5. **Welcome/navigation prefs:** migrate selected welcome scope/tab/settings-route items with folder validation/fallback; handle `autoApprove` only after explicit decision.
6. **Cross-client refresh:** add focus/visibility refresh and post-write reconciliation; no push channel.
7. **Deferred decisions:** open tabs, folder UI selection/expansion portability, composer draft policy (keep local unless separately designed).
8. **Cleanup:** remove obsolete local authorities only after migration and tests pass.

---

## 13. Risks, assumptions, and unresolved product decisions

### Risks

- **Pre-paint drift:** duplicated normalization logic between `web/index.html` and `typography.ts` can regress if SQLite-backed hydration changes semantics. Mitigation: shared normalization source or stronger drift tests.
- **Mixed-state migration errors:** `tbai:desktopLayout` bundles portable and device-local fields; blind import would sync `sidebarWidth`. Mitigation: explicit field mapping.
- **Security-sensitive defaults:** syncing `welcomeEngine.autoApprove` could silently change permission posture across clients. Mitigation: defer or fail closed.
- **Stale local cache after cross-client change:** first paint may show old theme/typography until hydration. Mitigation: refresh cache on every successful reconciliation; accept brief stale paint only when cache differs.
- **`app_settings` ownership confusion (Option A):** process/security keys and portable prefs would share a table. Mitigation: strict allowlist/namespace and service-level rejection of reserved keys; consider Option B if discipline is insufficient.
- **Folder/path portability:** folder ids may exist in shared DB but paths/availability can differ across machines. Mitigation: validate and fall back to simple scope/local UI defaults.

### Assumptions

- TBAI remains anonymous/installation-scoped for preferences (no user identity model found).
- Cross-client consistency target means clients connected to the same backend/database.
- LWW per key/group is acceptable for initial portable UI preferences.
- No live push channel is required initially.
- Existing domain tables and OpenCode runtime boundaries remain authoritative.

### Unresolved product decisions

1. **Option A guardrails vs Option B:** allowlisted portable keys in `app_settings` (recommended here) or a dedicated portable-preferences table?
2. **`welcomeEngine.autoApprove`:** sync, keep device-local, or reset to safe default? If persisted, what UX communicates cross-client permission impact?
3. **Open tabs (`tbai:openTabs`):** device-local, portable, or opt-in restore?
4. **Welcome scope folder references:** when a referenced folder is unavailable on another machine, fall back silently to simple scope, preserve reference but mark invalid, or prompt?
5. **Folder UI selection/expansion:** keep device-local (recommended) or make portable?
6. **Settings route / scheduler seen timestamp:** worth syncing or keep local/low priority?
7. **Conflict policy:** accept LWW per key for v1, or add minimal revision/conditional writes now?
8. **Cross-client freshness:** is focus/visibility refresh sufficient, or is there a concrete need for push/invalidation?

---

## Evidence index (files inspected)

### CodeG
- `D:\Temp\codeg\src-tauri\src\db\mod.rs` (DB init/migrations, L1–129 read)
- `D:\Temp\codeg\src-tauri\src\db\entities\app_metadata.rs` (L1–19)
- `D:\Temp\codeg\src-tauri\src\db\service\app_metadata_service.rs` (L1–102)
- `D:\Temp\codeg\src-tauri\src\db\migration\m20260211_000001_init.rs` (`app_metadata` table excerpt L9–43; references L318,324)
- `D:\Temp\codeg\src-tauri\src\preferences.rs` (L1–53)
- `D:\Temp\codeg\src-tauri\src\commands\system_settings.rs` (L1–1271 read; key constants L26–31; terminal apply/broadcast L317–363; close behavior L375–660; targeted search)
- `D:\Temp\codeg\src-tauri\src\web\handlers\system_settings.rs` (L1–154)
- `D:\Temp\codeg\src-tauri\src\web\event_bridge.rs` (L1–120+ read)
- `D:\Temp\codeg\src-tauri\src\commands\delegation.rs` (L1–45+)
- `D:\Temp\codeg\src-tauri\src\commands\question.rs` (L1–22+)
- `D:\Temp\codeg\src-tauri\src\commands\feedback.rs` (L1–25+)
- `D:\Temp\codeg\src-tauri\src\commands\config_sync\mod.rs` (L1–237)
- `D:\Temp\codeg\src-tauri\src\commands\config_sync\portable_keys.rs` (L1–102)
- `D:\Temp\codeg\src-tauri\src\commands\config_sync\domains.rs` (L1–1339 read)
- `D:\Temp\codeg\src-tauri\src\commands\config_sync\snapshot.rs` (L1–1122 read)
- `D:\Temp\codeg\src-tauri\src\commands\config_sync\local_io.rs` (L1–616)
- `D:\Temp\codeg\src-tauri\src\commands\config_sync\webdav_sync.rs` (L1–1578)
- `D:\Temp\codeg\src-tauri\src\commands\config_sync\auto_sync.rs` (L1–243)
- `D:\Temp\codeg\src-tauri\src\commands\config_sync\credentials.rs` (L1–215)
- `D:\Temp\codeg\src\lib\api.ts` (targeted search/read)
- `D:\Temp\codeg\src\lib\i18n.ts` (L1–209)
- `D:\Temp\codeg\src\components\i18n-provider.tsx` (L1–285)
- `D:\Temp\codeg\src\contexts\terminal-context.tsx` (L1–320+ read)
- `D:\Temp\codeg\src\hooks\use-feedback-enabled.ts` (targeted search)
- `D:\Temp\codeg\src\lib\types.ts` (targeted search)

### TBAI
- `D:\Temp\ai-chat-app\src\db\index.ts` (L1–727)
- `D:\Temp\ai-chat-app\src\services\log-settings.ts` (L1–88)
- `D:\Temp\ai-chat-app\src\services\server-port.ts` (L1–79)
- `D:\Temp\ai-chat-app\src\services\startup-prefs.ts` (L1–49)
- `D:\Temp\ai-chat-app\src\services\credentials.ts` (L1–267)
- `D:\Temp\ai-chat-app\src\routes\server.ts` (L1–141)
- `D:\Temp\ai-chat-app\src\lib\validation.ts` (L1–917)
- `D:\Temp\ai-chat-app\web\index.html` (L1–172, pre-existing modified; preserved)
- `D:\Temp\ai-chat-app\web\src\features\appearance\theme-storage.ts` (L1–68)
- `D:\Temp\ai-chat-app\web\src\features\appearance\typography.ts` (L1–664)
- `D:\Temp\ai-chat-app\web\src\features\desktop\state\desktopLayout.ts` (L1–260)
- `D:\Temp\ai-chat-app\web\src\features\chat\state\welcomeEngine.ts` (L1–134)
- `D:\Temp\ai-chat-app\web\src\features\chat\state\welcomeScope.ts` (L1–119)
- `D:\Temp\ai-chat-app\web\src\features\chat\state\chatTabs.ts` (L1–378)
- `D:\Temp\ai-chat-app\web\src\features\chat\state\composerDraft.ts` (L1–61)
- `D:\Temp\ai-chat-app\web\src\features\chat\state\pendingFirstMessage.ts` (L1–169)
- `D:\Temp\ai-chat-app\web\src\features\chat\state\resumable-stream.ts` (L1–128)
- `D:\Temp\ai-chat-app\web\src\features\folders\state\foldersStore.ts` (L1–268)
- `D:\Temp\ai-chat-app\web\src\config\navigation.ts` (L1–327)
- Background only (not modified): `D:\Temp\ai-chat-app\docs\2026-11-08-settings-audit.md`, `D:\Temp\ai-chat-app\docs\2026-11-08-preferences-architecture-review.md`

### Not inspected / limitations

- Full CodeG frontend transport implementation details beyond targeted files; some system settings flows (rendering/autostart command bodies) were located by search but not fully quoted.
- Full TBAI route/service implementations for every domain table (providers/MCP/scheduler/folders/quick messages/memories/OpenCode) beyond schema/DB/store evidence already gathered.
- Runtime behavior under concurrent multi-client edits (no tests executed).
- Tauri webview localStorage physical path and Rust-side test coverage.
- No implementation, schema changes, dependency changes, or test runs were performed.
