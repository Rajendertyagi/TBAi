# TBAi Settings, Preferences, and Persistent State Audit (Rebuilt)

## 1. Audit date and verified repository/branch/commit

- **Audit date:** 2026-11-08
- **Repository:** `D:\Temp\ai-chat-app`
- **Branch:** `work/primary-consolidated-2026-11-08` (`git branch --show-current`)
- **HEAD commit:** `b61c81c05219b9a939481f0b49e75f7d69fe324f` (`git rev-parse HEAD`)
- **HEAD summary:** `b61c81c docs(typography): correct remaining range comments` (`git log -1 --oneline`)
- **Working tree at audit time (`git status --short`):**
  - ` M tests/e2e/typography-standardization.spec.ts` — pre-existing user change; preserved, not modified.
  - ` M web/index.html` — pre-existing user change; preserved, not modified. This file was read as current source evidence.
  - ` M web/src/features/appearance/TypographyPage.tsx` — pre-existing user change; preserved, not modified. This file was read as current source evidence.
  - `?? docs/2026-11-08-settings-audit.md` — audit document replaced by this audit (authorized scope).

**Scope of changes made by this audit:** replaced `docs/2026-11-08-settings-audit.md` only. No application source, database schema/migration, test, dependency, build configuration, or unrelated documentation was modified. No branch switch, reset, stash, clean, commit, push, merge, or release was performed.

**Method:** read-only inspection of current source files and targeted searches (`localStorage`, `sessionStorage`, `persist(`, `app_settings`, `CREATE TABLE`, `tbai[-:]`, `startMinimized|/api/server/startup`, `zustand/middleware`, `document.cookie|indexedDB|openDB|idb|tauri-plugin-store`, validation schema names). No runtime execution, no tests executed. Previous audits (`docs/2026-10-04-settings-audit.md`, prior `docs/2026-11-08-settings-audit.md`) were not used as evidence sources for inventory/counts/classifications/conclusions.

---

## 2. Executive findings

**Verified facts**

1. **No unified portable-preferences system exists.** Persistent state is split across browser/webview storage (`localStorage`, `sessionStorage`), one Zustand `persist` store, SQLite `app_settings` (4 keys), and multiple domain-owned SQLite tables (`provider_configs`, `conversations`, `mcp_servers`, `scheduler_jobs`/`scheduler_runs`, `folders`/`folder_groups`/`folder_links`, `quick_messages`, `memories`, etc.).
2. **SQLite is not the source of truth for portable UI/application preferences.** Theme, typography, desktop layout preferences, welcome defaults, tab layout, folder UI selections, settings-route convenience, and window-zoom cache are stored locally in the client. They are not shared across Chrome/Firefox/Tauri clients.
3. **`app_settings` is a global, anonymous key/value table** (`key` PK, JSON `value`, `updated_at`) with no user/device scope. Current keys are process/machine/security oriented: `log.settings`, `server.port`, `server.startMinimized`, `security.tool_approval_secret` (encrypted).
4. **Pre-paint bootstrap depends on localStorage for theme and typography.** `web/index.html` reads `tbai-theme*` and `tbai-typography` before React mounts to avoid flash/layout shift. `typography.ts` and `index.html` both contain migration/validation logic (tests guard drift per file comments).
5. **Domain configuration already has appropriate SQLite owners** in most cases: providers, conversations, MCP servers, scheduler jobs, folders, quick messages, memories. These should not be duplicated into a generic preferences store.
6. **No user identity, no settings revision/optimistic concurrency, and no settings push channel** were found. Cross-client observation of server-backed settings currently depends on fetch/reload behavior; localStorage-backed preferences do not propagate.
7. **Tauri desktop state is partly machine-local by design:** window geometry uses `tauri-plugin-window-state`; OS autostart uses `tauri-plugin-autostart`; window zoom uses native WebView zoom plus local cache; `start-minimized` uses `app_settings` + a mirror file read by Tauri. Tauri webview storage is separate from browser profiles.
8. **No cookies or IndexedDB usage** was found by targeted search in `web/src`/`src`. Backend `AsyncLocalStorage` hits are Node/Bun request context, not browser storage.

**Architectural recommendation (summary)**

Classify state first, then move only **portable persistent application preferences** (Category A) to a SQLite-backed source of truth with typed validation and explicit ownership. Keep device-specific, domain-owned, transient, and sensitive data in their appropriate owners. Preserve localStorage as a **write-through pre-paint cache** only where required (theme/typography). Reuse existing Hono/Zod/SQLite/Zustand patterns; do not introduce a generic settings framework.

---

## 3. Actual settings and state inventory

The inventory below is evidence-backed. "SQLite should own it" answers the stated architectural objective for portable persistent application preferences; it does not authorize implementation.

| # | Setting/state | Exact source file and relevant symbol(s) | Current read location(s) | Current write location(s) | Persistence mechanism | Default / origin | Portable across browsers/clients today? | Classification | SQLite should own it? | Reasoning / dependencies / risks |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Theme mode (`light`/`dark`) | `web/src/features/appearance/theme-storage.ts` (`MODE_KEY="tbai-theme"`, `readMode`, `writeMode`, `DEFAULT_MODE="dark"`); `web/src/components/theme-provider.tsx` (`ThemeProvider`, `setTheme`, `toggleTheme`); `web/index.html` pre-paint script (L22–35) | `theme-storage.ts` L46–49; `index.html` L23–27; `ThemeProvider` initial state L51 | `theme-storage.ts` L51–53; `ThemeProvider` L59–69 | `localStorage["tbai-theme"]` | `"dark"` (`DEFAULT_MODE`, `theme-storage.ts` L28; `index.html` fallback) | No | **A. Portable persistent application preference** | Yes, with local pre-paint cache | User-facing appearance preference; must remain consistent across clients. Pre-paint cache required to avoid flash. |
| 2 | Light palette id | `theme-storage.ts` (`LIGHT_KEY="tbai-theme-light"`, `readThemeId`, `writeThemeId`, `readThemeIds`); `theme-provider.tsx` (`themeIds`, `setThemeId`); `index.html` L28–29 | `theme-storage.ts` L55–58,66–68; `index.html` L28–29 | `theme-storage.ts` L60–63; `ThemeProvider` L72–79 | `localStorage["tbai-theme-light"]` | `DEFAULT_THEME_ID`/`"classic"` fallback via `isThemeId` (`theme-storage.ts` L20,57) | No | **A** | Yes, with cache | Independent per-mode palette slot; portable preference. |
| 3 | Dark palette id | `theme-storage.ts` (`DARK_KEY="tbai-theme-dark"`, `readThemeId`, `writeThemeId`); `theme-provider.tsx`; `index.html` L28–29 | same pattern | same pattern | `localStorage["tbai-theme-dark"]` | `DEFAULT_THEME_ID`/`"classic"` fallback | No | **A** | Yes, with cache | Same as #2. |
| 4 | Typography configuration (v3 JSON) | `web/src/features/appearance/typography.ts` (`STORAGE_KEY="tbai-typography"`, `TypographyConfig`, `DEFAULT_TYPOGRAPHY`, `readTypography`, `writeTypography`, `applyTypographyToDom`, `migrateTypography`, reset helpers); `web/index.html` pre-paint (L36–167); `web/src/main.tsx` L8–11; `web/src/features/appearance/TypographyPage.tsx` (`TypographyPage`, `updateTypography`, reset handlers) | `typography.ts` L504–531; `index.html` L48–166; `main.tsx` L11; `TypographyPage.tsx` L109,131–138 | `typography.ts` L536–558,608–667; `TypographyPage.tsx` L131–184,234–238,337–341,441–445,556–563 | `localStorage["tbai-typography"]` (JSON) | `DEFAULT_TYPOGRAPHY` (`typography.ts` L49–63) | No | **A** | Yes, with local pre-paint cache | Complex portable preference set (fonts/sizes/weights/wrap/line height). Migration v1/v2/v3 and duplicated pre-paint logic are compatibility risks; cache required for no-flash/no-layout-shift. |
| 5 | Window zoom (desktop WebView) | `web/src/lib/platform.ts` (`WINDOW_ZOOM_STORAGE_KEY="tbai-window-zoom"`, `readWindowZoom`, `writeWindowZoom`, `requestWindowZoom`, `getConfirmedWindowZoom`, `commitConfirmedZoom`); `web/src/features/appearance/TypographyPage.tsx` (zoom UI/state) | `platform.ts` L271–281,332–344; `TypographyPage.tsx` L110,122 | `platform.ts` L283–291,350–356,425–445; `TypographyPage.tsx` L140–161,174,561,578,595,620,631 | `localStorage["tbai-window-zoom"]` + Tauri native `setZoom` (desktop authority) | `DEFAULT_WINDOW_ZOOM=1.0` (`platform.ts` L239) | No | **B. Device-specific preference** | No (not as portable shared preference) | Native WebView zoom is device/runtime-specific; browser mode unsupported. Local cache/persistence is appropriate for the device. |
| 6 | Sidebar visible | `web/src/features/desktop/state/desktopLayout.ts` (`DesktopLayoutState.sidebarVisible`, `setSidebar`, `toggleSidebar`, `defaultPersisted`, `migratePersisted`, `partialize`); `web/src/features/desktop/DesktopSettings.tsx` | `desktopLayout.ts` store selectors; `DesktopSettings.tsx` L15,17,36 | `desktopLayout.ts` L192–195; `DesktopSettings.tsx` L37 | `localStorage["tbai:desktopLayout"]` via Zustand `persist` (name L243, v1 L244) | `true` (`defaultPersisted` L122) | No | **A** | Yes | Portable UI preference; currently bundled with device-specific `sidebarWidth`. |
| 7 | Status bar visible | `desktopLayout.ts` (`statusBarVisible`, `setStatusBar`, `toggleStatusBar`); `DesktopSettings.tsx` | `desktopLayout.ts`; `DesktopSettings.tsx` L16,18,48 | `desktopLayout.ts` L193,195; `DesktopSettings.tsx` L49 | same `tbai:desktopLayout` | `true` (L123) | No | **A** | Yes | Portable UI preference. |
| 8 | Sidebar width (px) | `desktopLayout.ts` (`sidebarWidth`, `setSidebarWidth`); `web/src/lib/window-chrome.ts` constants imported | `desktopLayout.ts` state; chrome consumers | `desktopLayout.ts` L196 (clamped) | same `tbai:desktopLayout` | `SIDEBAR_DEFAULT_WIDTH` (L124) | No | **B** | No | Geometry depends on display/window/device; syncing pixel width across clients is undesirable. Must be split from portable layout prefs. |
| 9 | Chat width | `desktopLayout.ts` (`chatWidth`, `setChatWidth`); `web/src/config/chat.ts` (`ChatWidth`, `DEFAULT_CHAT_WIDTH="comfortable"`); `web/src/features/appearance/AppearancePage.tsx` | `desktopLayout.ts`; `AppearancePage.tsx` L16 | `desktopLayout.ts` L197; `AppearancePage.tsx` L17,111 | same `tbai:desktopLayout` | `"comfortable"` (`config/chat.ts` L25, `desktopLayout.ts` L125) | No | **A** | Yes | Portable reading/layout preference. |
| 10 | Sidebar sort mode | `desktopLayout.ts` (`sidebarSort`, `setSidebarSort`); `web/src/config/sidebar.ts` (`SidebarSortMode`, `defaultSort="updated"`) | `desktopLayout.ts`; sidebar UI consumers | `desktopLayout.ts` L198 | same `tbai:desktopLayout` | `sidebarConfig.defaultSort` / `"updated"` (L126, `config/sidebar.ts` L18,141) | No | **A** | Yes | Portable list preference. |
| 11 | Sidebar section order | `desktopLayout.ts` (`sectionOrder`, `moveSection`); `config/sidebar.ts` (`SIDEBAR_SECTION_IDS`, `DEFAULT_SECTION_ORDER`) | `desktopLayout.ts`; sidebar sections | `desktopLayout.ts` L199–207 | same `tbai:desktopLayout` | `sidebarConfig.defaultSectionOrder` (L127) | No | **A** | Yes | Portable UI arrangement. |
| 12 | Sidebar section collapsed map | `desktopLayout.ts` (`sectionCollapsed`, `setSectionCollapsed`, `setAllSectionsCollapsed`) | `desktopLayout.ts`; sidebar sections | `desktopLayout.ts` L208–217 | same `tbai:desktopLayout` | `{}` (L128) | No | **A** | Yes | Portable UI arrangement. |
| 13 | Show completed/archived in sidebar | `desktopLayout.ts` (`showCompleted`, `setShowCompleted`) | `desktopLayout.ts`; sidebar lists | `desktopLayout.ts` L218 | same `tbai:desktopLayout` | `false` (L129) | No | **A** | Yes | Portable UI preference. |
| 14 | Spell check (composer) | `desktopLayout.ts` (`spellCheck`, `setSpellCheck`); `AppearancePage.tsx` | `desktopLayout.ts`; `AppearancePage.tsx` L18; composer consumers | `desktopLayout.ts` L219; `AppearancePage.tsx` L19,138 | same `tbai:desktopLayout` | `true` (L130–132) | No | **A** (with platform caveat) | Yes, as user intent | User intent is portable; actual dictionary/capability is browser/OS-specific. |
| 15 | Last settings route | `web/src/config/navigation.ts` (`LAST_SETTINGS_ROUTE_KEY="tbai:settingsRoute"`, `lastSettingsRoute`, `rememberSettingsRoute`, `appConfig.settingsIndexRoute`) | `navigation.ts` L310–318 | `navigation.ts` L320–327 | `localStorage["tbai:settingsRoute"]` | `appConfig.settingsIndexRoute` (`/settings/providers`, L96,103,317) | No | **A** (low value) | Optional; low priority | Convenience preference; safe to sync but not critical. |
| 16 | Welcome engine | `web/src/features/chat/state/welcomeEngine.ts` (`STORAGE_KEY="tbai:welcome-engine"`, `WelcomeEngineState`, `load`, `persist`, `useWelcomeEngineStore`, `getWelcomeEngineSnapshot`) | `welcomeEngine.ts` L32–73,90; consumers of store/snapshot | `welcomeEngine.ts` L75–121 | `localStorage["tbai:welcome-engine"]` (JSON) | `"direct"` (L46,63) | No | **A** (product decision) | Yes, subject to owner decision | Global draft default for new chats; portable if users expect same starting engine across clients. |
| 17 | Welcome OpenCode agent | `welcomeEngine.ts` (`agent`, `setAgent`; cleared on engine switch L91–101) | `welcomeEngine.ts` L64,90 | `welcomeEngine.ts` L102–106 | same `tbai:welcome-engine` | `""` (L47,64) | No | **A** (engine-specific draft default) | Yes, subject to decision | Draft-only; engine-specific. |
| 18 | Welcome OpenCode model | `welcomeEngine.ts` (`model`, `setModel`) | L65,90 | L107–111 | same | `""` | No | **A** | Yes, subject to decision | Draft-only. |
| 19 | Welcome OpenCode variant | `welcomeEngine.ts` (`variant`, `setVariant`) | L66,90 | L112–116 | same | `""` | No | **A** | Yes, subject to decision | Draft-only. |
| 20 | Welcome auto-approve shield | `welcomeEngine.ts` (`autoApprove`, `setAutoApprove`; **not** cleared on engine switch L91–101; strict boolean L67–69) | L67–69,90 | L117–121 | same | `false` (L50,68) | No | **A** with security/UX sensitivity | Owner decision required | Materializes into conversation `opencodeAutoApprove` (`conversations` table). Syncing changes permission posture across clients; keep explicit. |
| 21 | Welcome scope (workspace mode/folder) | `web/src/features/chat/state/welcomeScope.ts` (`WelcomeScope`, `loadScope`, `persistScope`, `setScope`, `validateAgainstFolderIds`); `web/src/config/welcome.ts` (`storage.scopeKey="tbai:welcome-scope"`) | `welcomeScope.ts` L25–43,70; consumers | `welcomeScope.ts` L53–59,72–94,99–113 | `localStorage["tbai:welcome-scope"]` (JSON) | `{ mode:"simple", folderId:null }` (L26,39) | No | **A** with machine/path caveat | Conditional | Mode is portable; `folderId` references server folder registry, but folder paths are machine-specific. Cross-client behavior needs safe fallback. |
| 22 | Quick actions tab | `welcomeScope.ts` (`quickActionTab`, `loadTab`, `persistTab`, `setQuickActionTab`); `config/welcome.ts` (`storage.tabKey="tbai:quick-actions-tab"`, `DEFAULT_QUICK_ACTION_TAB="coding"`) | `welcomeScope.ts` L44–51,71 | `welcomeScope.ts` L61–67,95–98 | `localStorage["tbai:quick-actions-tab"]` | `"coding"` (L47,49, `config/welcome.ts` L290) | No | **A** | Yes | Simple portable UI preference. |
| 23 | Open tabs + active tab | `web/src/features/chat/state/chatTabs.ts` (`STORAGE_KEY="tbai:openTabs"`, `Tab`, `loadPersisted`, `persist`, `useChatTabsStore`, `storage` event convergence L359–370) | `chatTabs.ts` L92–142,155; store consumers | `chatTabs.ts` L144–153 and all mutators; cross-tab convergence via `storage` event | `localStorage["tbai:openTabs"]` (JSON) | one fresh draft tab (`loadPersisted` L94–98) | No across browsers/Tauri; partial same-browser tab convergence | **A/B boundary (owner decision)** | Owner decision | References server conversation ids (portable identifiers) but represents device/workbench layout. Syncing may surprise users; can be useful. Not transient. |
| 24 | Selected folder (Folders UI navigation) | `web/src/features/folders/state/foldersStore.ts` (`SELECTED_KEY="tbai:selectedFolder"`, `selectedFolderId`, `setSelectedFolder`, `pruneSelectedFolderId`) | `foldersStore.ts` L101–107,120–128 | `foldersStore.ts` L123–125,244–246 | `localStorage["tbai:selectedFolder"]` | `null` (L103–106) | No | **B/D-leaning UI selection** | Usually no | Navigation selection; references server folder id but primarily local UI state. |
| 25 | Folder expanded map | `foldersStore.ts` (`EXPANDED_KEY="tbai:folderExpanded"`, `folderExpanded`, `loadFolderExpanded`, `saveFolderExpanded`, `setFolderExpanded`, `setAllFoldersExpanded`) | `foldersStore.ts` L65–73,108 | `foldersStore.ts` L75–81,255,264 | `localStorage["tbai:folderExpanded"]` (JSON) | `{}` (L72) | No | **B/D-leaning UI preference** | Usually no | Local tree expansion state. |
| 26 | Unsent composer draft per thread | `web/src/features/chat/state/composerDraft.ts` (`DRAFT_PREFIX="tbai:composer-draft:"`, `readComposerDraft`, `writeComposerDraft`, `clearComposerDraft`) | `composerDraft.ts` L23–37 | `composerDraft.ts` L40–61 | `localStorage["tbai:composer-draft:<threadKey>"]` (JSON `{text,updatedAt}`) | none | No | **D. Transient/runtime-local draft state** (durable across reload on same device) | No | Contains unsent user text; crash-recovery convenience. Not a portable application preference. |
| 27 | Pending first OpenCode prompt handoff | `web/src/features/chat/state/pendingFirstMessage.ts` (`KEY_PREFIX="tbai:pending-first-prompt:"`, `setPendingFirstMessage`, `peekPendingFirstMessage`, `claimPendingFirstMessage`, `markPendingFirstMessageFailed`, `clearPendingFirstMessage`) | `pendingFirstMessage.ts` L76–92,114–116 | `pendingFirstMessage.ts` L95–100,107–111,145,158,165 | `localStorage["tbai:pending-first-prompt:<conversationId>"]` (JSON) | none | No | **D. Transient workflow handoff state** | No | Exactly-once runtime handoff; moving/syncing would risk duplication or broken workflow semantics. |
| 28 | Direct resumable stream pointer | `web/src/features/chat/state/resumable-stream.ts` (`DIRECT_RESUME_KEY_PREFIX="tbai-resume:"`, `createDirectResumableStorage`, `readDirectResumableStreamId`); `web/src/runtime.ts` uses sessionStorage-backed resume flow (L233,267,543) | `resumable-stream.ts` L67–70,90–97; runtime | `resumable-stream.ts` via assistant-ui storage wrapper L71–73; runtime | `sessionStorage["tbai-resume:<threadId>"]` | none | No (tab-scoped) | **D. Transient runtime recovery state** | No | Tab/session recovery pointer; not a preference. |
| 29 | Scheduler badge "seen" timestamp | `web/src/components/ActivityBar.tsx` (L31 reads `tbai:schedSeenTs`); `web/src/features/scheduler/SchedulerPage.tsx` (L31 reads, L151 writes) | `ActivityBar.tsx` L31; `SchedulerPage.tsx` L31 | `SchedulerPage.tsx` L151 | `localStorage["tbai:schedSeenTs"]` | `0` | No | **D. Device-local UI dismissal state** | No | Ephemeral badge acknowledgment. |
| 30 | Log capture settings | `src/services/log-settings.ts` (`KEY="log.settings"`, `getPersistedLogSettings`, `persistLogSettings`, `applyPersistedLogSettings`); `src/routes/logs.ts` (`GET/PUT /settings`, uses `logSettingsSchema`); `src/lib/validation.ts` (`logSettingsSchema` L843, `LogSettings` L904) | `log-settings.ts` L37–53,77–85; `logs.ts` L41–57 | `log-settings.ts` L55–61; `logs.ts` L59–85 | SQLite `app_settings["log.settings"]` (JSON) | env/logger defaults; persisted only when saved (`log-settings.ts` L26–35,77–87) | Yes for same backend DB; effect is process-local | **B. Device/process configuration** (server-local) | No as portable user preference | Controls local process logging/file sink; env may lock. Shared DB row does not make file sink semantics portable. |
| 31 | Server configured port | `src/services/server-port.ts` (`PORT_SETTING_KEY="server.port"`, `getPersistedPort`, `persistConfiguredPort`, `resolveConfiguredPort`, `writePortFile`); `src/routes/server.ts` (`GET /`, `PUT /port`, `POST /restart`); `src/lib/validation.ts` (`serverPortBodySchema` L908) | `server-port.ts` L28–53; `server.ts` L26–35 | `server-port.ts` L71–79; `server.ts` L39–53, restart flow | SQLite `app_settings["server.port"]` + `data/port` mirror file | `DEFAULT_WEB_PORT=3000` or env `PORT` (`server-port.ts` L6,48–53) | DB row shared by same backend; runtime binding is machine/process-specific | **B** | No | Network/process binding and Tauri rendezvous concern. |
| 32 | Start minimized (desktop startup) | `src/services/startup-prefs.ts` (`START_MIN_KEY="server.startMinimized"`, `START_MIN_FILE="start-minimized"`, `getPersistedStartMinimized`, `persistStartMinimized`, `readStartMinimizedMirror`); `src/routes/server.ts` (`GET/PUT /startup`, `startupPrefsBodySchema`); `src-tauri/src/main.rs` reads mirror (`read_minimized` L121–123, used L954–956) | `startup-prefs.ts` L15–26,42–49; `server.ts` L124–126; Tauri `read_minimized` | `startup-prefs.ts` L28–40; `server.ts` L128–139 | SQLite `app_settings["server.startMinimized"]` + `data/start-minimized` mirror | `false` (L20,24) | DB row shared by same backend; behavior is Tauri/machine-specific | **B** | No | Desktop machine behavior. No web UI consumer found in `web/src` (search for `startMinimized|/api/server/startup` returned no matches). |
| 33 | Tool approval HMAC secret | `src/services/credentials.ts` (`TOOL_APPROVAL_SECRET_SETTING_KEY="security.tool_approval_secret"`, `getToolApprovalSecret`, `loadOrCreateToolApprovalSecret`, `decryptToolApprovalSecret`) | `credentials.ts` L95–116,118–145 | `credentials.ts` L127–145 (generated/persisted encrypted) | SQLite `app_settings["security.tool_approval_secret"]` (encrypted envelope) | generated random 32-byte hex on first init (L127) | Same backend DB only; secret | **E. Sensitive data / credential** | No (never as ordinary preference) | Security material; fail-closed behavior. Must not be exposed or treated as user preference. |
| 34 | Active provider | `src/routes/providers.ts` (`POST /api/providers/:id/set-active` L175–185; create sets first active L48–53); `src/db/index.ts` `provider_configs.is_active`; `web/src/features/providers/state/providersStore.ts` mirrors | provider routes/registry; `providersStore.ts` L52–63,97–109 | `routes/providers.ts` L175–185 | SQLite `provider_configs.is_active` | first created provider becomes active (L48–53) | Yes | **C. Domain-owned persistent data** (global provider config) | Already SQLite-owned; do not duplicate | Existing domain owner is correct. |
| 35 | Provider definitions/defaults (name/type/endpoint/model/models/thinking/apiProtocol) | `src/routes/providers.ts` (CRUD/discover/test); `src/db/index.ts` `provider_configs` (L91–103,422–424); `src/lib/validation.ts` provider schemas; `providersStore.ts` | provider routes/store/UI | provider routes | SQLite `provider_configs` | type-specific protocol default (`defaultApiProtocol`, `routes/providers.ts` L20–25); user-provided fields | Yes | **C** | Already SQLite-owned | Domain configuration; keep in provider domain. |
| 36 | Provider API keys | `src/services/credentials.ts` (`CredentialStore.set/get/has/delete`); `src/routes/providers.ts` accepts `apiKey` but never returns it; `provider_configs.encrypted_api_key` | credential store on server only | `credentials.ts` L173–186; provider routes L74–78,132–138 | SQLite `provider_configs.encrypted_api_key`/`credential_version` (AES-256-GCM under local DEK) | none | Same backend DB; secret | **E** | No | Secret. Browser receives metadata/`credentialConfigured` only. |
| 37 | Conversation-specific settings/state | `src/routes/conversations.ts` (create/patch/get/list); `src/db/index.ts` `conversations` columns (provider/model/reasoning/system prompt/workspace/engine/OpenCode fields/status/title metadata) | conversation routes/runtime/thread metadata | conversation routes | SQLite `conversations` | create persists explicit values or nulls; absent resolved at request time (`routes/conversations.ts` L109–117); workspace defaults `simple`, engine `direct` (L174–176) | Yes | **C** | Already SQLite-owned | Per-conversation domain state, not global preference. |
| 38 | MCP server configuration | `src/routes/mcp.ts`; `src/services/mcp/manager` (referenced); `src/db/index.ts` `mcp_servers` (L437–465); `web/src/features/mcp/state/mcpStore.ts` | MCP routes/store/UI | MCP routes | SQLite `mcp_servers`; `auth_token` encrypted; `headers`/`env` stored as JSON text | schema/route defaults (enabled/auto-connect/auth_type) | Yes | **C** (contains **E** for auth token) | Already SQLite-owned | Domain configuration. Security note: `headers`/`env` plaintext is a separate concern. |
| 39 | Scheduler jobs and runs | `src/routes/scheduler.ts`; `src/services/scheduler/*` (referenced); `src/db/index.ts` `scheduler_jobs`/`scheduler_runs`; `web/src/features/scheduler/state/schedulerStore.ts` | scheduler routes/store/UI | scheduler routes | SQLite `scheduler_jobs`, `scheduler_runs` | schema defaults (enabled, timezone UTC, policies, retries/timeouts) | Yes | **C** | Already SQLite-owned | Domain configuration/history. |
| 40 | Folder/group/link registry | `src/db/index.ts` `folders`, `folder_groups`, `folder_links`; folder routes/services (referenced by stores/routes); `web/src/features/folders/state/foldersStore.ts` | folder APIs/store/UI | folder APIs | SQLite folder tables | none/user-created | Registry rows shared; filesystem paths machine-specific | **C** with machine-specific path semantics | Already SQLite-owned for registry | Registry is domain-owned. Path portability is not guaranteed across machines. |
| 41 | Quick messages | `src/db/index.ts` `quick_messages`; `web/src/features/quick-messages/state/quickMessagesStore.ts` | quick-messages API/store/UI | quick-messages API | SQLite `quick_messages` | empty | Yes | **C** (user content/config) | Already SQLite-owned | Domain-owned reusable content. |
| 42 | Memories | `src/db/index.ts` `memories`; `web/src/features/memories/state/memoryStore.ts` | memories API/store/UI | memories API | SQLite `memories` | empty | Yes | **C** (user data) | Already SQLite-owned | Domain-owned data; model injection separately gated by env. |
| 43 | OS autostart registration | `web/src/lib/platform.ts` (`isAutostartEnabled`, `setAutostartEnabled`); `web/src/features/desktop/StartupSection.tsx`; `src-tauri/Cargo.toml` `tauri-plugin-autostart` | `StartupSection.tsx` L28–33,46–52 | `StartupSection.tsx` L59 via platform API | OS registration via Tauri autostart plugin | OS state | No | **B** | No | Machine/OS-specific. OS is source of truth. |
| 44 | Tauri window geometry/state | `src-tauri/src/main.rs` window-state plugin setup (grep L925–929: SIZE/POSITION/MAXIMIZED); `src-tauri/Cargo.toml` `tauri-plugin-window-state` | Tauri plugin/runtime | Tauri plugin/runtime | Tauri window-state plugin storage | OS/Tauri defaults | No | **B** | No | Machine-specific window placement. |
| 45 | OpenCode runtime configuration documents | `src/routes/opencode.ts` config endpoints (L256–524); `src/services/opencode/*` (referenced) | OpenCode config routes/services | OpenCode config routes/services (policy-gated) | OpenCode/runtime files and service APIs; not TBAi `app_settings` | OpenCode/runtime defaults | Depends on same OpenCode runtime/home; separate from TBAi SQLite prefs | **C** (external runtime domain) / boundary-owned | No, not in TBAi generic preferences | Separate ownership boundary; TBAi must not duplicate OpenCode config as ordinary preferences. |
| 46 | Send-on-enter / configurable keyboard send behavior | No setting symbol found; `web/src/config/welcome.ts` tip states Enter sends / Shift+Enter newline (L113) | N/A | N/A | N/A | fixed behavior (as documented by tip) | N/A | **Confirmed absent** (not a persistent setting) | No | Do not invent. If added later, classify deliberately. |
| 47 | Search feature flag / nav visibility | `web/src/config/navigation.ts` (`features` empty L90; nav items L105–268; no search item) | static config consumers | source code/config only | static code/config | build-time config | N/A | **Static product configuration**, not user preference | No | Not persisted user state. |

---

## 4. Classification and persistence ownership

### A. Portable persistent application preferences (SQLite should normally own)

**Verified candidates from current implementation:** theme mode and palette slots (#1–3), typography (#4), portable desktop layout fields (#6,7,9–14), last settings route (#15, low priority), welcome draft defaults (#16–19, product decision), welcome auto-approve (#20, owner decision due to permission UX impact), welcome scope/tab (#21–22, with folder-reference caveats). Open tabs (#23) is a boundary case requiring owner decision.

**Ownership rule:** one SQLite-backed source of truth per portable preference domain, with typed validation and explicit defaults. Browser storage may act only as a narrowly defined cache where required for startup/paint behavior.

### B. Device-specific preferences (keep local)

**Verified:** window zoom (#5), sidebar pixel width (#8), log capture/process sink settings (#30), server port (#31), start-minimized (#32), OS autostart (#43), Tauri window geometry (#44). Folder filesystem paths (aspect of #40/#21) are machine-specific semantics even when registry ids are shared.

**Ownership rule:** keep under device/runtime/local-process owners (localStorage/webview storage, OS/Tauri plugins, `app_settings` + mirror files where already used). Do not sync as portable user preferences.

### C. Domain-owned persistent data (keep existing owners)

**Verified:** provider configs/active provider (#34–35), conversation settings (#37), MCP server config (#38), scheduler jobs/runs (#39), folder/group/link registry (#40), quick messages (#41), memories (#42), OpenCode runtime config boundary (#45).

**Ownership rule:** preserve existing domain tables/routes/services. A future portable-preferences design must not duplicate these models.

### D. Transient/runtime state (do not persist as preferences)

**Verified:** unsent composer drafts (#26, local crash-recovery only), pending first OpenCode prompt handoff (#27), resumable stream pointer (#28), scheduler badge seen timestamp (#29), plus in-memory UI state (search input/query/open/focus in `desktopLayout` is explicitly transient and excluded from persistence, `desktopLayout.ts` L59–71,246–257).

**Ownership rule:** keep transient. Do not promote to shared SQLite preferences.

### E. Sensitive data and credentials (separate handling)

**Verified:** tool approval HMAC secret (#33), provider API keys (#36), MCP auth tokens (within #38, encrypted), local DEK/credential store internals (`src/services/credentials.ts`, `credential_key` table in `src/db/index.ts` L110–116). MCP `headers`/`env` are stored as JSON text in `mcp_servers` (`src/db/index.ts` L445–446) — a security concern to track separately, not an ordinary preference.

**Ownership rule:** never store in ordinary preference records, never expose to browser, never sync as user preferences.

---

## 5. Current SQLite architecture assessment

**Verified facts**

- SQLite is opened as a single `bun:sqlite` `Database` in `src/db/index.ts` (L25) with WAL/NORMAL/foreign_keys/busy_timeout pragmas (L28–61). Data dir is install-anchored (`src/config/data-dir.ts` referenced by `src/db/index.ts` L16–23).
- Schema management is idempotent at module load: `CREATE TABLE IF NOT EXISTS`, `addColumnIfNotExists`, targeted rebuilds/migrations, and leaf schema helpers (`chat-streams`, `opencode-session-orphans`, `messages`). No `schema_migrations` table or `PRAGMA user_version` was found.
- `app_settings` exists (`src/db/index.ts` L136–144): `key TEXT PRIMARY KEY`, `value TEXT NOT NULL`, `updated_at INTEGER NOT NULL`. It is global/anonymous.
- Current `app_settings` consumers are narrow and explicit: `log.settings`, `server.port`, `server.startMinimized`, `security.tool_approval_secret` (encrypted). Reads/writes use direct SQL in owning services; routes expose only the relevant settings endpoints.
- Domain tables already cover major configuration domains (providers, conversations, MCP, scheduler, folders, quick messages, memories). This reduces the need for a generic preferences table.

**Assessment**

- **Can existing schema support required portable preferences cleanly?** Not as-is. `app_settings` can technically store JSON values, but it lacks typing, scope, and conflict semantics for user-facing portable preferences, and it currently mixes process/security concerns. Domain tables are not appropriate owners for cross-cutting UI preferences.
- **Can existing APIs/services be reused?** Yes, partially. The codebase already has the right patterns: small Hono routes, Zod validation, service-owned persistence, Zustand UI mirrors, and pre-paint local cache for appearance. A portable-preferences solution should follow these patterns.
- **Is a new table or migration necessary?** **Unknown / owner decision.** A small typed table or narrowly scoped schema addition may be justified for portable UI preferences, but this audit does not authorize schema changes. A generic settings registry is not justified by current evidence.
- **Duplicated ownership / unnecessary abstraction?** Current risk is duplication across localStorage, Zustand persist, and future SQLite if migrated carelessly. `app_settings` is simple but not a typed portable-preferences owner. No generic settings framework exists today (positive).
- **Database location/lifecycle and shared-client behavior?** SQLite supports multiple clients of the **same backend process** reading/writing shared rows. It does **not** imply safe sharing across independent backend processes or independent Tauri installs with separate data dirs. The product requirement is satisfied only when clients connect to the same backend/database.

---

## 6. Cross-client consistency assessment

### Actual lifecycle (verified)

1. **Startup (backend):** DB module initializes schema/migrations; services apply persisted settings where designed (e.g., log settings at boot). Server port/startup prefs use `app_settings` and mirror files.
2. **Startup (frontend first paint):** `web/index.html` reads localStorage theme/typography and applies DOM/root styles before React mounts.
3. **Startup (React):** `ThemeProvider` reads theme keys; `main.tsx` calls `readTypography()`; feature stores initialize from localStorage or fetch server state.
4. **Change preference (local-only today):** theme/typography/desktop layout/welcome/tabs/folder UI selections write localStorage/Zustand persist and update local UI; no API/SQLite write.
5. **Change preference (server-backed today):** logs/server/provider/MCP/scheduler/quick messages/memories/folders operations call APIs; routes/services persist to SQLite/domain tables; UI refreshes from responses/fetches.
6. **Another client observes change:** server-backed domain/config rows are shared in the same DB, but most UIs require fetch/reload; no settings push channel found. Local-only preferences are not observed.
7. **Refresh/restart:** localStorage/sessionStorage/Tauri plugin state restores device-local state; SQLite restores server-backed state; theme/typography pre-paint uses local cache.
8. **Errors/recovery:** many localStorage helpers fail safe (catch and keep session/default behavior). Server routes return structured errors; some services fall back to defaults on corrupt persisted values.
9. **Concurrent changes:** SQLite/route handlers generally use last-write-wins upserts/updates. No ETag/If-Match/revision protocol for settings was found.

### Where local browser storage is currently an authority

- Theme mode/palette slots, typography, desktop layout blob, welcome engine/scope/tab, open tabs, selected folder/folder expansion, composer drafts, pending first prompt, scheduler seen timestamp, window zoom cache. For these, localStorage is the effective authority today (not merely a cache), except window zoom where Tauri native state is the runtime authority and localStorage is a baseline/cache.

### Narrowly defined cache requirement

- **Theme and typography pre-paint:** localStorage (or equivalent synchronous local cache) is necessary before first paint to avoid flash/layout shift. If SQLite becomes authoritative, local cache must be write-through, version/shape-compatible, and reconciled after server load; it must not silently override newer server state without a defined rule.

### Process/database semantics

- **Verified constraint:** same backend/database enables sharing. Independent backend processes/Tauri installs with separate `data/chat.db` files do not share preferences. This audit found no evidence of safe multi-process SQLite coordination beyond normal single-process server ownership.

---

## 7. Confirmed problems and risks

| Problem / risk | Evidence | Impact |
|---|---|---|
| Portable UI preferences are device-local, not SQLite-authoritative | localStorage keys/stores for theme, typography, desktop layout, welcome, tabs, folder UI, settings route, zoom cache | Fails stated cross-client consistency objective |
| Fragmented persistence ownership | localStorage + Zustand persist + `app_settings` + domain tables | Hard to reason about, migrate, and test |
| `app_settings` is global/untyped and mixes concerns | `src/db/index.ts` L136–144; keys for log/port/start-minimized/tool-approval secret | Poor fit for typed portable user preferences; secret lives beside config |
| No settings conflict protocol | upserts/updates without revision/If-Match; no settings push | Concurrent edits are last-write-wins; stale clients may overwrite |
| Pre-paint bootstrap duplicates typography logic | `web/index.html` L36–167 vs `web/src/features/appearance/typography.ts` | Migration/persistence changes can drift; tests mitigate but maintenance risk remains |
| `tbai:desktopLayout` bundles portable and device-specific fields | `desktopLayout.ts` includes `sidebarWidth` (B) with portable prefs (A) | Blanket sync/migration would be incorrect |
| `welcomeEngine.autoApprove` persisted as draft default | `welcomeEngine.ts` L11–28,67–69,94–121 | Permission UX/security-sensitive preference; syncing/defaulting needs explicit decision |
| `server.startMinimized` has backend/Tauri support but no web UI | `routes/server.ts` `/startup`, `startup-prefs.ts`, `tauri/main.rs`; no `web/src` consumer found | Capability exists but is not user-manageable in web UI |
| MCP `headers`/`env` stored as plaintext JSON | `src/db/index.ts` L445–446 | Security hygiene risk adjacent to configuration storage |
| Cross-client sharing depends on same backend instance | Tauri owns local sidecar/data dir in normal packaged model; no shared remote backend | "Chrome + Firefox + Tauri" consistency is only realistic when connected to the same backend/database |

---

## 8. Recommended target architecture

**Recommendations (not implemented):**

1. **Define a portable-preferences boundary.** Only Category A items become SQLite-authoritative portable preferences. Keep B/C/D/E in their current owners unless a specific item is reclassified with evidence.
2. **Use the smallest maintainable SQLite design.** Prefer typed, explicit persistence over a generic key/value settings framework. Reuse existing route/service/validation patterns. Do not overload `app_settings` with untyped portable UI preference blobs; do not duplicate domain tables.
3. **Preserve pre-paint behavior.** Keep localStorage as a write-through cache for theme and typography first-paint bootstrap. Define reconciliation: server is authoritative after successful load; cache is updated from server; corrupt/missing server data falls back safely.
4. **Split mixed stores.** Separate portable desktop layout preferences from device-specific geometry (`sidebarWidth`, window zoom). Migrate existing `tbai:desktopLayout` carefully.
5. **Handle sensitive and workflow state explicitly.** Never move secrets into preferences. Keep pending handoffs, resume pointers, and unsent drafts out of shared preference sync unless a separate, deliberate design exists.
6. **Start with pull + write-through.** No live settings push is required initially. Add refresh-on-focus or targeted notifications only if a concrete UX gap remains.
7. **Decide conflict policy before implementation.** Accept explicit LWW for v1 or add minimal revision/If-Match; document the choice.

---

## 9. Minimal migration strategy and sequencing

1. **Owner decisions (prerequisite):** installation scope, conflict policy, persistence owner shape, `autoApprove` sync/default, open-tabs portability, composer-draft policy, folder-reference fallback behavior, `startMinimized` UX.
2. **Schema/API design (authorized separately):** smallest typed SQLite-backed portable-preferences contract; Zod validation; explicit defaults; no secret fields.
3. **Low-risk portable prefs first:** theme mode/palette slots and typography, preserving pre-paint cache and migration semantics.
4. **Desktop layout split:** migrate portable fields from `tbai:desktopLayout`; keep `sidebarWidth` local; preserve existing users.
5. **Welcome/navigation prefs:** migrate selected welcome/tab/settings-route items after product decisions, with safe fallbacks for stale folder references.
6. **Boundary cases last:** open tabs, selected folder/expanded state, and any security-sensitive defaults (`autoApprove`) only after explicit decisions.
7. **Cleanup:** remove obsolete local authorities only after server-backed read/write, cache reconciliation, and migration tests pass.

---

## 10. Test coverage assessment and required verification scenarios

**Assessment (from inspection, not executed):** the codebase contains appearance/typography-related tests and comments indicating bootstrap drift guards (e.g., `web/index.html` references `tests/unit/appearance/typography.test.ts`; typography/theme files are structured for testability). This audit did not run tests and does not claim coverage adequacy.

**Required verification scenarios for future implementation:**

- Theme/typography: server-authoritative after sync; local cache write-through; no first-paint flash/layout shift; v1/v2/v3 typography migration preserved.
- Cross-client: portable preference changed in client A is observed by client B connected to the same backend after reload/fetch (and any agreed refresh behavior).
- Device-specific isolation: `sidebarWidth`, window zoom, server port/log/start-minimized machine behavior, OS autostart, Tauri window geometry remain local.
- Domain isolation: provider/MCP/scheduler/conversation/folder/quick-message/memory domain data remains in existing owners; no duplication.
- Transient isolation: resume pointers, pending first prompt, one-shot overrides, search UI, badge dismissal, and unsent drafts are not promoted to shared preferences.
- Security: no secrets in preference APIs/payloads; browser never receives secret values.
- Migration: existing localStorage/Zustand payloads migrate safely; corrupt/partial data falls back to defaults; Tauri webview-local values considered.
- Concurrency: chosen conflict policy behaves as specified.

---

## 11. Open questions, clearly separated from established facts

**Established facts**

- No user identity/settings scope model exists.
- `app_settings` is global key/value and currently used for process/security concerns.
- Portable UI preferences are currently localStorage/Zustand-persist authoritative.
- Theme/typography require pre-paint local cache for current UX.
- No settings revision protocol or settings push channel was found.
- Same-backend/database sharing is required for cross-client consistency; separate Tauri installs have separate data dirs.

**Open questions (owner decisions)**

1. Should portable preferences be installation-scoped (current anonymous model) or user-scoped?
2. Is last-write-wins acceptable for v1, or is minimal revision/If-Match required?
3. What is the smallest acceptable SQLite owner for portable UI preferences (without creating a generic framework or duplicating domain tables)?
4. Should `welcomeEngine.autoApprove` sync across clients, remain device-local, or reset to a safe default?
5. Should `tbai:openTabs` be portable, device-local, or opt-in restore?
6. Should composer drafts remain device-local only (recommended) or have a separate explicit design?
7. How should folder-referencing preferences behave when folder registry/path semantics differ across machines?
8. Should `server.startMinimized` remain backend/Tauri-only, gain web UI, or be redesigned?
9. Is reload/fetch-on-focus sufficient for observing changes from other clients?

**Unknowns**

- Exact OS path of Tauri webview localStorage.
- Rust-side test presence/coverage (not inspected).
- Runtime behavior under concurrent multi-client edits (not executed).
- Whether any generated/runtime-only code path persists settings outside inspected patterns (search coverage was broad but not formally complete).