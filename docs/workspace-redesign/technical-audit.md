# Technical audit — verified findings

All findings verified by reading source on 2026-11-21 at HEAD `4c47aca`. Paths are absolute under `D:\Temp\ai-chat-app`. Verdicts: **already / partial / missing / risky**.

## 1. What TBAi already has

| Capability | Verdict | Evidence |
|---|---|---|
| Persistent shell shared by web + desktop | already | `web/src/app/layout/AppShell.tsx:195-251` |
| ActivityBar, resizable left sidebar, tab strip, status bar | already | `AppShell.tsx`, `components/ActivityBar.tsx`, `components/Sidebar.tsx:259-291`, `components/TabStrip.tsx`, `components/StatusBar.tsx` |
| Separate Direct Chat and OpenCode runtimes | already | `web/src/runtime.ts:560-571`; `features/opencode/OpenCodeIsolationBoundary.tsx:10-15` (`AuiProvider extends={null}`); `OpenCodeView.tsx:313-351` |
| Tab model with `groupId` reserved for split | already | `features/chat/state/chatTabs.ts`; `docs/decisions.md:542-605` (ADR-018), `:373` in architecture.md |
| dnd-kit tab reordering + keyboard | already | `components/TabStrip.tsx:5-13,81-160`; `docs/decisions.md:4455-4618` |
| Hand-rolled resize handle pattern | already | `components/Sidebar.tsx:259-291` (pointer capture, clamped width) |
| Device-local + portable preference persistence | already | `features/desktop/state/desktopLayout.ts:129-224` (localStorage `tbai:desktopLayout`, `partialize` persists `sidebarWidth`); `features/preferences/state/preferencesStore.ts:168-374` (SQLite via `/api/preferences`) |
| Registered folder/workspace model | already | `src/routes/folders.ts`, `src/services/folders.ts`, `src/services/workspace.ts:399-522` (`resolveConversationWorkspace`) |
| Code/markdown/diff/mermaid rendering | already | `web/package.json`: `react-shiki` 0.11.2, `@assistant-ui/react-markdown` 0.14.24, `remark-gfm` 4.0.1, `parse-diff` 0.12.0, `beautiful-mermaid` 1.1.3 |
| Browser automation tool (headless) | already | `src/services/browser.ts`, `src/tools/index.ts:383-404`, `web/src/tools/browser/ui.tsx` |
| Tauri frameless window + window controls | already | `src-tauri/tauri.conf.json`, `web/src/components/WindowControls.tsx` |

## 2. Gaps and risks

### 2.1 File APIs — PARTIAL
- `/api/folders/browse` lists **directories only** (`src/routes/folders.ts:112-135`, filter at `:121-125`). It is a folder-registration picker with **no containment check** (`:115-116`) by design — do not copy it for a file explorer.
- Tool endpoints exist (`POST /api/tools/read|list|stat|search`, `src/routes/tools.ts:65-104`) but are bound to the global `WORKSPACE_DIR`, not the conversation workspace.
- Security primitives exist and must be reused: `src/services/tools.ts:90-177` (`canonicalizeRoot`, `insideRoot`, `inspectTarget`, `resolveSafe`, `OutsideWorkspaceError`), grants at `:153-177`.
- **Needed:** a dedicated, Zod-validated, conversation-scoped `GET /api/files/list` and `/read` using `resolveConversationWorkspace` + `resolveSafe`. First step: read-only list with a traversal/symlink-escape test.

### 2.2 OpenCode filesystem — PARTIAL / RISKY
- Pinned `@opencode/client` 2.2.6 exposes `file.read/list/find` (`node_modules/@opencode/client/dist/promise/generated/client.d.ts:370-379`).
- The app's V2 boundary does not expose them (`web/src/features/opencode/v2Client.ts:90-111`) and the proxy allowlist blocks `/api/file/*` (`src/services/opencode/proxyRoutes.ts:105-205`). Drift tests enforce this.
- Browser-chosen directories are deliberately stripped (`v2Client.ts:174-179`); the proxy resolves directory from session id (`proxyAuthorization.ts:96-159`).
- **Needed:** new `location`-scoped allowlist entries + V2 methods, with drift tests proving no client-supplied directory reaches upstream. High security risk.

### 2.3 Editor — MISSING (real) / PARTIAL (textarea)
- No CodeMirror, Monaco, or editor library in `web/package.json`. Only textareas and the assistant-ui composer input.
- A real editor needs a new dependency → ADR required. Read-only preview is feasible today with installed libraries.

### 2.4 Multiple Direct chat panels — RISKY
- One root `AssistantRuntimeProvider` (`AppShell.tsx:196`), one runtime bound to one thread (`AppShell.tsx:103-119`).
- A second Direct panel needs a second isolated runtime via `AuiProvider extends={null}`, careful handling of module-level `sendConfigs` (`runtime.ts:77`) and stable `runtimeHook` (`:549-558`).
- AGENTS.md dependency/context integrity rules (`:49-79`) and train freeze (`:81-85`) apply. This is the highest-risk item.

### 2.5 Interactive browser — MISSING / RISKY
- Three distinct things exist: web-search tool cards, headless browser automation tool, and no interactive browser panel.
- No `iframe`/`webview`/`WebviewWindow` usage. Tauri CSP has no `frame-src` (`src-tauri/tauri.conf.json:33-35`); capabilities lack webview creation (`src-tauri/capabilities/default.json:6-20`).
- Most sites refuse framing (`X-Frame-Options` / `CSP frame-ancestors`). CORS trusts loopback ports (`src/config/cors.ts:86-124`) — framing arbitrary URLs is a major attack surface.
- **Minimum first step:** read-only screenshot viewer from the existing `agent-browser screenshot` result (`src/services/browser.ts:318-324`), avoiding iframe/webview entirely.

### 2.6 Split/resize/tabs — PARTIAL
- Installed: `@dnd-kit/dom` 0.5.1, `@dnd-kit/react` 0.5.1, `radix-ui` 1.8.1, `@tanstack/react-virtual` 3.14.21. No split-pane library.
- Reuse the Sidebar resize handle and dnd-kit tab reordering. No new dependency needed for v1.
- FlexLayout POC was evaluated but **not authorized** (`docs/decisions.md:4620-4679`): tab identity reconciliation, mutable model/stale closures, splitter count, popup context loss, DOM-test impossibility. Any layout model choice needs an ADR.

## 3. Highest-leverage first step

A **safe, conversation-scoped, containment-checked file-serving endpoint** unblocks three things at once: file tree, file preview, and a read-only browser screenshot viewer. Build that primitive first.

## 4. Quality gates (every implementation phase)

`bun run verify` = typecheck → lint (`--error-on-warnings`) → format:check → test:locations → build → unit/integration → three lifecycle suites → DOM contracts → OpenCode quarantine. Plus `bun run test:e2e`, `bun run test:opencode-runtime`, `bun run security`. Build before tests. Definition of DONE: planner disk-review accepted; typecheck and build independently re-run exit 0; real test counts recorded; no commit/push until end-to-end verification passes. UI work must walk the user-visible flow step by step.
