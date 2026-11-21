# TBAi UI/UX Redesign — Consolidated Implementation Plan

**Status:** design complete, awaiting owner approval to implement. **No production code has been changed.**

This is the single authoritative plan. It supersedes the scattered preference list in `requirements.md` and the stale `application-shell.md` (which still describes an old rail/header/inspector design that was later rejected). Those files are kept only as a historical record of how the design evolved.

---

## 1. What TBAi already has (verified in code, 2026-11-21)

Do not rebuild any of these:

| Capability | Where |
|---|---|
| oklch theme system, many light/dark themes, border + shadow tokens | `web/src/styles/globals.css`, `features/appearance/theme-data.ts` |
| Tab strip: reorder (drag + keyboard), close (X / middle-click / context menu), "+", shortcuts | `web/src/components/TabStrip.tsx`, `config/tabStrip.ts` |
| Search: top-left icon, Ctrl/⌘K, command palette, inline sidebar results | `web/src/components/LeftEdgeChrome.tsx`, `CommandPalette.tsx` |
| Status bar with hide/show (settings, corner button, context menu) | `web/src/components/StatusBar.tsx`, `RightEdgeChrome.tsx`, `DesktopSettings.tsx` |
| Sidebar hide/show + resize, persisted | `web/src/components/LeftEdgeChrome.tsx`, `Sidebar.tsx`, `desktopLayout.ts` |
| Sidebar header (one row: locate / expand-all / view-options) | `web/src/features/sidebar/components/SidebarHeader.tsx` |
| Real context-usage data, readable by any component under the root runtime | `web/src/features/chat/context/useCurrentContext.ts:198-219` |
| Pages for Scheduler, Archived, Folders, Settings | `web/src/app/router.tsx` |
| "Import from OpenCode" can open a child session as a full chat | `web/src/features/opencode/OpenCodeImportDialog.tsx`, `src/services/opencode/import.ts` |
| Tauri frameless window + native window controls | `src-tauri/tauri.conf.json`, `web/src/components/WindowControls.tsx` |

**Label in the real app is "Folders"** (`config/navigation.ts`, sidebar section, Settings page title) — not "Projects". The mockup has been corrected.

---

## 2. What is genuinely missing (the real work)

| Gap | Frontend only? | Backend work? | Risk |
|---|---|---|---|
| **Side-by-side chat** — two conversations visible at once | Yes | None | **High** — needs a second isolated assistant-ui runtime; duplicate-context risk is real |
| **Right panel** — container for the second chat | Yes | None | Low, but only exists when a chat is docked |
| **Two-row sidebar header + bottom nav strip** | Yes | None | Low — must preserve window-chrome geometry |
| **Subagents as clickable cards + parent links** | Partly | Yes — persist `parentID`, expose children endpoint | Medium-high — data model absent; API claim needs live re-verification |
| **File tree + file viewer** | No | **Yes — new endpoints with path confinement** | High — explicitly future work |

---

## 3. What we are deliberately NOT doing

These were my guesses, not real requirements. Removing them:

- **"Session details" panel with Context / Cache hit / Sources / Credits.** Only context usage is real; cache hit, credits, and source counts are not surfaced anywhere in the app. The two real facts (context, model) are already shown in the composer ring and status bar. **The right panel exists only to hold a second chat.**
- **"Help" nav item.** No Help page, route, or component exists. Removed from the bottom strip.
- **"Projects" rename.** The app says Folders everywhere. Dropped.
- **File tree / file viewer in this phase.** No REST endpoint lists files or reads file contents. Future work only — the layout reserves a slot, nothing more.
- **assistant-ui upgrade.** Train is frozen. The SubagentList element must be vendored locally if/when needed.

---

## 4. The sequence — one coherent build, not scattered edits

Each phase is complete on its own and must pass all quality gates (§6) before the next begins.

### Phase 0 — Settle the spec (no code)
- Accept this plan.
- Reconcile the two competing foundation plans: `docs/ui-foundation/canonical-ui-coherence-plan.md` (PROPOSED, 3 milestones) vs `docs/ui-foundation/self-audit-and-plan.md` (older 12-phase). The redesign must build on whichever is authoritative — decide before touching source.
- Live-verify the OpenCode 2.2.6 child-session API before promising subagent parent links (the older "404 for child routes" claim in `tools/opencode/ui.tsx:794-802` may be stale).
- **Output:** this plan accepted, foundation plan chosen, subagent API verified.

### Phase 1 — Shell and navigation (frontend only, low risk)
- Two-row sidebar header: row 1 = panel toggle + "TBAi" + back/forward; row 2 = plain "⌕ Search" + filter / add-folder / new-chat icons.
- Move the search trigger from `LeftEdgeChrome` into sidebar row 2, reusing `searchOpen` / `CommandPalette` — no new search UI.
- Bottom strip: **Scheduler, Archived, Folders, Settings**. Remove the main-nav list from the sidebar.
- Preserve `--title-bar-height`, `--left-chrome-width`, and drag regions.
- Files: `SidebarHeader.tsx`, `Sidebar.tsx`, `ActivityBar.tsx`, `config/sidebar.ts`, `config/navigation.ts`, `LeftEdgeChrome.tsx`.
- **Verify:** `bun run verify` + walk the visible flow (open search, switch pages, toggle sidebar).

### Phase 2 — Side-by-side chat (frontend only, HIGH risk — the headline feature)
- The right panel appears **only when a second chat is docked**. No empty panel, no fake tabs.
- Second Direct runtime must use the isolation pattern already proven for OpenCode: `AuiProvider extends={null}` (`web/src/features/opencode/OpenCodeIsolationBoundary.tsx:10-15`). Never nest runtimes (`router.tsx:24-27`).
- Per-pane active tab state in `chatTabs.ts`; focused-pane rule (a sidebar click affects only the active pane; already-open chats are revealed where they live).
- "Open side by side" in the chat-row context menu and the tab context menu.
- Files: `AppShell.tsx`, `runtime.ts`, `chatTabs.ts`, `router.tsx`, new right-panel components.
- **Verify:** two panes stream independently; no duplicate-context errors; `bun run verify` + `test:dom` + e2e.

### Phase 3 — Subagents (frontend + backend, medium-high risk)
- Backend: persist `parentID` on imported conversations (**schema change → record in `docs/decisions.md` first**), expose the active session's children via an endpoint.
- Frontend: vendor the SubagentList element locally with an `onSelect` callback; clickable progress cards in the parent chat; "back to parent" link.
- **Verify:** import a child, open it as a chat, parent link returns correctly.

### Phase 4 — File tree + file viewer (future, backend + frontend)
- New Zod-validated endpoints to list files and read file text, with path confinement to the conversation workspace root (same rule as `src/services/tools.ts`).
- File tree dock + file tabs with preview reuse + "Open to Side".
- **Only start after Phases 1–3 are shipped and verified.**

---

## 5. Quality gates — every phase must pass

Run `bun run verify` (typecheck → lint with `--error-on-warnings` → format:check → test:locations → build → test → shutdown → startup-rollback → lifecycle-integration → dom → quarantine), plus `bun run test:e2e`, `bun run test:opencode-runtime`, and `bun run security`.

Definition of DONE also requires: planner disk-review accepted; typecheck and build independently re-run with exit 0; real test counts recorded; no commit/push until end-to-end verification passes. For UI work, typecheck + build green is **necessary but not sufficient** — the report must walk the user-visible flow step by step.

---

## 6. Constraints that never change

- Design-only until owner approves implementation.
- One local checkout (`D:\Temp\ai-chat-app`); no worktrees, no second checkout.
- Preserve all existing uncommitted work; no commit / push / merge / reset / clean.
- No new dependencies; assistant-ui train frozen; no second runtime/state/router framework.
- Keep the Direct/OpenCode runtime boundary; keep window-chrome geometry tokens.
- Prototype stays isolated in `docs/ui-redesign/prototype/`.
