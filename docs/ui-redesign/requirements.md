# What we want TBAi to look like — collected requirements

This is a working list of the visual and UX goals gathered from our discussions. It is not a final spec. Review it and tell me what to add, remove, or change. No code or prototype has been touched to produce this.

## 1. Overall character
- A **complete, visibly meaningful UI/UX upgrade** — not a token/border-radius/shadow cleanup.
- Feel like **one coherent, professionally designed desktop application**, not a collection of separately styled pages.
- Take inspiration from **OpenChamber's desktop experience**, adapted to TBAi's own features.
- **Dense and compact** like a developer tool, but not crowded.
- **Thin, compact fonts** — ChatGPT-like feel.
- **Hairline borders**, subtle **color variation**, and **layered shadows**.
- **Modern and polished** enough to be judged as a product interface, not a wireframe.
- **Visually calm** with restrained accent colors.

## 2. Application shell
- **PREFERENCE #1 (owner-confirmed):** Use a **left-hand sidebar with icons + text labels** for the primary navigation items currently in the rail (Chat, Scheduler, Settings, etc. — from `getRailNav()`). Do NOT use an icon-only rail. Each primary item shows its icon and its text label together in the left sidebar.
- **PREFERENCE #2 (SUPERSEDED by #10 — kept for history):** Originally "no search box or search icon in the left sidebar". The owner later changed this: #10 is final — a **plain ⌕ Search row** belongs in the sidebar header. The underlying rule still holds: reuse the app's **existing search UI** (`CommandPalette` / `SearchResults`), do not invent a new search control.
- **PREFERENCE #3 (owner-confirmed):** TBAi has two kinds of chats — **project/folder chats** (attached to a folder/project) and **simple chats** (disposable, no folder). In the left sidebar, list chats under their **respective headings/groups**: project chats under their project/folder, simple chats under a separate "Simple chats" (or equivalent) heading. Do not mix them into one flat list. The existing sidebar already has Folders/Chats sections (`SidebarSection.tsx`); extend that grouping so each chat appears under the correct head.
- **PREFERENCE #4 (owner-confirmed, FINAL — OpenChamber model):** Side-by-side chat is done by **opening a chat into the right-hand panel**, not by a separate split screen. **Right-click a chat in the sidebar → "Open side by side"** (OpenChamber's "Open in Side Panel" context-menu action) → that chat is docked as a tab in the right panel. Result: main chat on the left, second chat on the right, with **only two tab strips total** (main + right panel). The earlier idea of a separate "Split view" screen with per-pane tab strips is **rejected and removed** — it produced three sets of tabs and was clutter. The existing `groupId` field in `chatTabs.ts` is not needed for this model.
- **PREFERENCE #5 (owner-confirmed):** The composer must keep the capabilities of the existing one — **model selection, thinking level, and agent mode** (Direct/OpenCode) controls. These are needed. Do NOT include **command buttons** or **@mention** controls in the redesigned composer. Reuse the existing controls (`ModelChip`, `ThinkingChip`, `OpenCodeChipsAndRing` in `Composer.tsx` / `composer/DirectChips.tsx`); do not invent new ones.
- Left **icon rail** for primary surfaces (Chat, Code, Scheduler, Folders, MCP, Settings).
- **Conversation sidebar** with clear grouping (In work / Projects / Recent), strong active state, and search.
- **Top header** with page title, short description, and contextual actions — consistent across pages.
- Optional **right inspector panel** showing session/context information (context usage, model, sources, credits) — TBAi already has this data.
- **Status bar** at the bottom.
- Panels should be **collapsible** and adapt to smaller windows.
- Do **not** force every page into an identical three-column layout — each workspace uses the layout that fits its workflow.

### Codeg reference — right panel and tabs (owner-directed study, `D:\Temp\codeg`)
- **PREFERENCE #6 (owner-confirmed; tab list finalised in #21):** The **right-hand panel** should follow codeg's AuxPanel model: a resizable panel (default ~320px, min ~200–260px, max ~900px) with its **own vertical icon tab rail down the panel's right edge** (not a horizontal bar at top). Each tab has its own content panel, mounted lazily. codeg's tabs (Session Details, Files, Changes, Commits, Automations, Tasks, Issues, Pull Requests) were **inspiration only** — the final TBAi tab set is in #21.
- **PREFERENCE #7 (owner-confirmed, FINAL):** **Each panel has its own tabs.** The main area has one tab strip; the right panel has its **own tab strip** inside it (OpenChamber's `SortableTabsStrip`), holding whatever is docked there — Session details, a side-by-side chat, Files, etc. Tabs in the right panel are reorderable. There is no per-pane tab strip in a split screen (that model was removed — see #4).
- **PREFERENCE #8 (owner-confirmed):** Right-panel behaviors from codeg: **reselect-to-close** (clicking the active tab again hides the panel), **reorderable tabs** (drag or Alt+↑/↓, saved per device), **context-aware tabs** (folder tabs only when a folder workspace is open; plain chat collapses to Session Details), and **keyboard accessibility** (roving focus, focus restored after reorder).
- **PREFERENCE #9 (owner-confirmed):** Panel **hide/show state and width persist per device** (codeg uses localStorage `workspace:right-sidebar`). TBAi should persist its panel state similarly.
- **PREFERENCE #10 (owner-confirmed, final):** The sidebar header is **two rows, always visible**. Row 1: panel toggle + "TBAi" + back/forward arrows. Row 2: a **plain "⌕ Search"** (icon + text, no box, no border, no background) on the left; filter / add-folder / new-chat icons on the right. No divider line under the header. Search opens the app's existing search UI (`CommandPalette`). NOT in the top bar.
- **PREFERENCE #11 (owner-confirmed):** Reuse the app's **existing sidebar hide/show mechanism** — `toggleSidebar` in `LeftEdgeChrome.tsx` (a panel-toggle button at the top-left that calls `useDesktopLayout.toggleSidebar`). The mockup must show this same toggle, not a new custom one in the top bar. Remove the ▤/▥ top-bar toggles I added.
- **PREFERENCE #12 (owner-confirmed, streamline; amended by #20):** Remove the main-nav item list entirely — the chat list is the main content. **"Code" was invented by the assistant and does not exist in the real app** (coding is an OpenCode mode inside chat, not a separate page) — removed. **MCP** lives only in the right rail — removed from the left nav. **Chat** is redundant with "New chat" + tabs — removed. **Folders** moved to the bottom strip with **Scheduler** and **Archived**. **Appearance** merged into Settings (no separate icon). NOTE: the earlier "Folders → Projects" rename is **dropped** — the real app calls it Folders everywhere (see NAMING DECISION below). The bottom strip's "Local workspace" item was later removed by #20.
- **PREFERENCE #13 (owner-confirmed, top bar; amended by #20):** Remove the ⌕ search icon from the right end of the tab strip. Put **desktop window controls** (minimize / maximize / close) at the top-right of the tab strip. Remove the **"+ New chat"** button from the bar under the tabs — the "+" in the tab strip already creates a new chat. Move the remaining top-bar buttons (▥ inspector toggle, ⋯) into the tab strip's right side. NOTE: the bar under the tabs was later **removed entirely** by #20 (the breadcrumb was redundant with the tab strip).
- **PREFERENCE #14 (owner-confirmed, OpenChamber study — `D:\Temp\openchamber`):** The **right-hand rail's role** is to switch what the right panel shows and manage which surfaces are docked there — it is **not** a second navigation menu. OpenChamber's `ContextPanelRail` is a vertical icon rail; right-clicking a rail icon opens a menu to move it between zones. The **context menu on a chat row** is the entry point for side-by-side chat: `SessionActionsMenuItems` → "Open in Side Panel" → `openSessionInSidePanel()` → `openContextPanelTab(mode:'chat')`. The right panel has its own `SortableTabsStrip` and a min width of 320px for chat. TBAi should mirror this: right-click a chat → "Open side by side" → chat docks in the right panel.
- **PREFERENCE #15 (owner-confirmed, FINAL — Paseo study `D:\Temp\paseo`, supersedes the OpenChamber-only model where they differ):** Adopt Paseo's **focused-pane** rule so side-by-side chats stay put. Two panes, each with its own tab strip; **one pane is active** (click it to activate). Clicking a chat in the sidebar **affects only the active pane** — the other pane is untouched. If that chat is **already open** in either pane, clicking it just focuses it where it lives (never moves or replaces it). "Open side by side" explicitly opens in the **other** pane. This fixes the OpenChamber flaw where switching threads hid both chats.
- **PREFERENCE #16 (owner-confirmed, Paseo subagents, refined by #18):** Subagents are **not separate windows**. The child chats are listed once, as clickable progress cards in the parent chat (#18); clicking a card opens it as a **tab** in the active pane. Every subagent chat has a **"back to parent"** link. Closing a subagent tab only closes the view — it does not delete the subagent. Managed subagents are interactive; provider subagents are read-only.
- **PREFERENCE #17 (owner-directed, FUTURE — file tree + file viewer):** TBAi does not have these yet but will add them. Follow Paseo: the **file tree** is a right-side dock (same area as our right panel), toggled by a shortcut; the **file viewer** opens files as **tabs in the same strip as chats**, with preview-tab reuse (clicking another file replaces an unmodified preview tab instead of piling up tabs) and an "Open to Side" action. The layout must reserve space for these now. **One tab/pane system for everything** — chats, subagents, file tree, file viewers — is the organizing principle.
- **PREFERENCE #18 (owner-confirmed, assistant-ui element, FINAL):** Use the official **SubagentList** element pattern (`https://www.assistant-ui.com/elements/subagent-list`) as the **single** subagent list — one card per worker with status icon, name, model, and progress bar, shown inside the parent chat. **Make each card clickable to open that subagent's chat.** The official element is display-only and is **not shipped in our frozen `@assistant-ui/react` 0.15.32** (the docs import a locally vendored file), so vendor it following our existing `web/src/components/assistant-ui/elements/` convention (like `AgentStatus` / `progress-stages`) and add a small `onSelect` callback — a documented extension to the official API. **Do not** upgrade assistant-ui. The earlier separate "◈ Subagents" pill + list is **removed** — it duplicated the same workers. Keep only the **"Back to parent"** link inside a subagent chat.
- **PREFERENCE #19 (owner-confirmed, visual language, FINAL):** Surfaces are separated by **subtle colour steps, not heavy lines**. Use **borderless or hairline borders** — borders are translucent (alpha) and read only where needed. Differentiate things with **colour variation** (distinct surface tiers: sidebar / panel / chat / code / cards), not outlines. Use **layered, low-opacity shadows** (xs/sm/md/lg) for elevation. Use **modern CSS standards**: `oklch()` colours, alpha hairlines, `:focus-visible` rings, logical/inset shadows. Both dark and light themes are designed intentionally. This replaces the earlier flat "hairline border + shadow cleanup" idea with a genuinely modern, calm, layered look.
- **BORDER AUDIT (owner-directed, manual check of every usage):** Borders are kept **only where they carry meaning** — list-row dividers (settings rows, tasks, run history, right-panel sections), menu separators, selection rings (colour swatches), and the floating context-menu boundary. Removed everywhere colour variation + shadow already separates: app-shell outline, sidebar / inspector / rail dividers, composer outline and inner divider, tab strip / top bar / chat head / panel tabs dividers, code block, tool card, chips, icon/split buttons, subagent cards, settings cards, stat cards, nav/task-list right borders, status bar, segmented control, pills, and the sidebar bottom strip (now a tinted surface). Result: fewer lines, calmer look, same structural clarity.
- **PREFERENCE #20 (owner-confirmed, redundancy cleanup):** Remove the **chat-head strip** ("Refactor Auth API · Direct" + "Open side by side" button) — the title was shown three times (tab strip, breadcrumb, strip) and "Direct" was in the composer and right panel. Remove the **breadcrumb bar** too — the tab strip is the single source of "where am I". Move **"Open side by side"** into the **tab's right-click menu** (and the "⋯" menu), matching Paseo/codeg; the chat-row context menu still works. **Status bar** keeps only the connection fact ("● Local · 3015") — the model was duplicated. **Sidebar bottom** drops "Local workspace" (overlapped the status bar), leaving 5 icons: Scheduler, Archived, Folders, Settings, Help. Tabs keep their strip with "+", inspector toggle, "⋯", and window controls.
- **PREFERENCE #21 (owner-confirmed, final right-panel tabs):** The right panel's tabs are **Session, Chat (side-by-side), Files, Changes, Tasks, MCP** — matching the mockup. codeg's Commits / Automations / Issues / Pull Requests are **not** included (no equivalent data in TBAi). Files is future work (#17) but the slot is reserved.
- **NAMING DECISION (owner-directed, 2026-11-21):** Keep **"Folders"** — the real app uses this label everywhere (`navigation.ts` nav item, sidebar section, Settings → Folders page title). The earlier "Projects" rename was based on the mockup, not the real app, and is **dropped**. The mockup's bottom-strip tooltip is updated to "Folders". Renaming the real feature would be a separate, explicit task.
- **CHROME HEIGHT UNIFICATION (owner-caught defect, refined):** The sidebar bottom strip was content-sized (~48px) while the status bar was 26px — they looked misaligned. Three bars now share `--chrome-h: 38px`: main tab strip, right-panel tab strip, and sidebar bottom strip. The **status bar is deliberately slimmer** at `--status-h: 26px` (38px felt too big) and is **hideable** via a prototype toggle next to the theme button; the sidebar bottom strip is never hidden. Both heights are tokens — one source of truth each, no inline dimensions.
- **FULL-PAGE + CONSISTENCY AUDIT (owner-caught defects):** The prototype now fills the whole viewport (`position:fixed; inset:0`) — a closer match to the frameless Tauri desktop window. Two defects fixed: (1) a **pane-level 2px accent line** (`.pane-active::after`) appeared under the tabs in Shell but not in the old Chat screen — removed; the **active tab's underline** in each strip is the single focus cue, and the focused-pane state stays in JS only for sidebar-click behavior. (2) the **"Chat" screen was a stale duplicate** of Shell's chat area (missing subagent cards, file viewer, back-to-parent) — removed entirely, along with its switcher button. Switcher is now Shell / Settings / Scheduler. All three screens verified full-page with no console errors.

## 3. Tabs
- **Microsoft Edge–like** tab behavior and appearance.
- Active tab marked by a **top accent line** and a **matching icon color**.
- **Project color** comes from the folder's stored color (user data, survives theme changes).
- A **default color** when a tab has no project color.
- Tabs must be **readable** — the current crowded strip of truncated labels is unacceptable.
- Prefer a single active conversation + recent dropdown, or cap visible tabs with an overflow menu.

## 4. Chat
- Clear **message hierarchy** — distinct user and assistant roles, model labels.
- **Code blocks** as bounded surfaces with filename headers and READ ONLY markers.
- **Tool execution states** shown clearly (status, name, duration).
- **Composer** as a grounded surface with model/agent/mode controls inline.
- **Contextual actions** on messages.
- **Welcome state** should use space purposefully — no random-colored suggestion cards.
- Optional right inspector for context/session info.

## 5. Settings
- **Grouped settings navigation** with clear section labels (Workspace, Intelligence, System).
- Strong **page headers** with title and description.
- Consistent **control alignment** and spacing.
- Appearance settings should show theme, palette, chat width, and line spacing clearly.

## 6. Scheduler
- **Task list + detail panel** layout with realistic tasks.
- Clear **status indicators** (ACTIVE / PAUSED / FAILED / DRAFT).
- **Scheduling actions** (Run now, Edit, Pause) and task details (stats, recent runs).
- Empty state should be **focused** — a primary action plus a few suggestions, not a wall of cards.

## 7. Other surfaces
- **Providers**: list + detail/edit, keys stay server-side (metadata only in UI).
- **Code workspace**: same shell, with a file/workspace panel; Direct/OpenCode runtime boundary preserved.
- **Dialogs, menus, overlays**: bounded surfaces, hairline borders, theme-derived elevation, visible focus.

## 8. Themes and color
- **Dark and light** both designed intentionally — light is not an inversion.
- All colors **controlled by the theme system** — no hardcoded hex/rgb/oklch in components.
- **One restrained accent** (warm amber/gold direction) used for active states and primary actions.
- Semantic status colors only for status (success, warning, danger, info).
- No random per-card accent colors.

## 9. Typography, spacing, shape
- Clear type scale: page title, section title, body, meta, micro.
- Thin-to-regular body weights; medium/semibold for titles and active states.
- Monospace only for code, paths, IDs, technical metadata.
- **One 4/8px spacing scale** — no second competing scale.
- Moderate corner radius (8–12px); no pill-shaped controls except small status chips.
- Three elevation levels: controls, panels, dialogs.

## 10. Accessibility (non-negotiable)
- **Visible focus rings** on all interactive elements.
- **24×24px minimum** click targets.
- **Reduced-motion** support — all motion collapses to zero when requested.
- Keyboard navigation works throughout.

## 11. Constraints
- Build on the **existing UI foundation** — no second competing design system.
- **No new dependencies** or frameworks.
- Preserve the **Direct/OpenCode runtime boundary**.
- Preserve all existing work and user changes.
- **One local checkout only**: `D:\Temp\ai-chat-app`.
- Design-only for now — no production implementation until approved.

## 12. Real-app mapping — what already exists vs. what is a gap
Checked against the actual code on 2026-11-20 so implementation reuses existing pieces instead of rebuilding them.

**Already in the app (reuse, do not recreate):**
- **Tauri window is frameless** — `src-tauri/tauri.conf.json` has `"decorations": false`. The app must draw its own window controls.
- **Window controls already exist** — `web/src/components/WindowControls.tsx` draws minimize / maximize-restore / close and calls Tauri APIs through `web/src/lib/platform.ts`. `AppShell.tsx` places them as a top-right corner overlay on the tab-strip row. They return `null` in the browser (correct — the browser has its own controls). This matches the mockup's top-right window controls.
- **Tab strip already has the "+" new-chat button** and a `data-tauri-drag-region` for dragging the frameless window (`web/src/components/TabStrip.tsx`). It has no search icon — the mockup now matches.
- **Sidebar hide/show already exists** — `toggleSidebar` in `web/src/components/LeftEdgeChrome.tsx` via `useDesktopLayout`.
- **Search UI already exists** — `CommandPalette` opened by `searchOpen` in `web/src/features/desktop/state/desktopLayout.ts`.

**Gaps the mockup introduces (need real implementation later, not yet done):**
- **Sidebar header** — real `SidebarHeader.tsx` is one row (drag filler + locate-active + expand/collapse + view menu) with a bottom border. Mockup wants two rows, no divider, plain "⌕ Search" + filter/add-folder/new-chat icons.
- **Search trigger location** — real app opens search from the top-left `LeftEdgeChrome`; mockup puts it in the sidebar row 2. The trigger must move, not a new search UI.
- **Bottom strip** — real app has Scheduler / Archived / Folders as nav items; mockup moves Scheduler / Archived / Folders to a bottom icon strip and drops the main-nav list.
- **Right panel** — real inspector is not a codeg-style vertical icon rail; that is a new panel behavior (reselect-to-close, reorder, per-device persistence).
- **Side-by-side chat via right panel** — real app has no context menu on chat rows and no way to dock a chat in the right panel. Needs: a chat-row context menu ("Open side by side"), a tab strip inside the right panel, a chat view there, and the **focused-pane rule** (#15) so switching threads does not hide both chats. The separate "Split view" screen with per-pane tabs is rejected (see #4).
- **Subagents track** — real app has no subagents pill/list or parent link; needs the Paseo-style track (#16).
- **File tree + file viewer** — not present in TBAi; future work (#17). Reserve layout space now.

## Open for your review
Anything above can be changed. Tell me what to add, remove, or adjust.
