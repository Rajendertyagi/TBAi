# Right-Hand Workspace Panel — Architecture Audit

> **STATUS: AUDIT COMPLETE — AWAITING ARCHITECTURE APPROVAL.**
> Audit only. No code written, no dependencies added, no shadcn CLI run.
> Scope: establish the current application shell and the correct right-hand
> workspace structure before any implementation.

---

## 1. Current application shell structure

**Root layout:** `web/src/app/layout/AppShell.tsx` — the *single* shell for both
the browser and the Windows desktop (no `if (desktop) … else …` layout fork;
Tauri-only leaves self-gate via `isTauri()`).

**Verified structural tree (from `AppShell.tsx:79-129`):**

```
AppShell                                     ← h-screen flex-col
├── <div> flex flex-1 flex-row overflow-hidden   (the pane row)
│   ├── ActivityBar                     ← LEFT rail (fixed, ~48px)
│   ├── Sidebar  (when sidebarVisible)  ← LEFT, hand-resizable via SidebarResizeHandle
│   └── <main> flex flex-1 flex-col overflow-hidden
│       ├── TabStrip band (title-bar height, border-b)   ← chat/code tabs
│       └── PageContextMenu → {children ?? <Outlet />}   ← routed route surface
├── StatusBar (when statusBarVisible)
├── LeftEdgeChrome / RightEdgeChrome / WindowControls   (absolute overlays)
├── ChromeShortcuts / TabUrlSync / RouteObserver
```

**Route surfaces** (`<Outlet>` renders one of these inside `<main>`):

- `/chat/:threadId?` → `ChatShell`
- `/code/:agentId?` → `CodeShell` (OpenCode)
- settings / scheduler / other pages

**Providers:** the assistant-ui runtime is isolated *per route* (Direct thread
list vs the OpenCode V2 isolation boundary) — **not** in `AppShell`. Client UI
state lives in Zustand (`useDesktopLayout`), which drives chrome geometry.

**Chrome geometry:** `syncChromeVars({sidebarWidth, searchOpen, captionStrip})`
publishes CSS variables; components consume them via `var(--…)` classes — never
via inline `style=`.

---

## 2. Is the current shell suitable for a right workspace panel?

**Yes — with one small structural extension, and it is the right place.**

- `<main>` is `flex flex-1 flex-col overflow-hidden`. To host
  `chat | panel` side by side, `<main>`'s content must become **`flex-row`**.
  This is the **only** structural CSS change needed; it does not disturb
  `ActivityBar` / `Sidebar` / `sidebarWidth`, because those live in the outer
  `flex-row` *above* `<main>`.
- A right panel belongs **inside `<main>`** (the routed content region), so it
  can be scoped to chat surfaces and its root can follow the active
  conversation's workspace — **not** wrapping the whole app (the sidebar and
  status bar must not shrink).
- No god-file risk: `AppShell` stays a thin composer if the panel is its own
  component.

---

## 3–5. Existing implementations — classified

| Concern | What exists on disk | Class | Verdict |
|---|---|---|---|
| **Tabs** | ❌ none in `ui/` (15 files: alert-dialog, badge, button, collapsible, context-menu, dialog, dropdown-menu, input, marker, popover, select, switch, textarea, thread-running-dot, tooltip). `TabStrip` is *chat-tab* chrome, not a generic tabs primitive. | — | **Need Radix `Tabs`** via `radix-ui` |
| **ScrollArea** | ❌ none | — | **Need `radix-ui` `ScrollArea`** |
| **Separator** | ❌ none as a primitive | — | **Need `radix-ui` `Separator`** |
| **Resize handle** | ✅ **hand-rolled**: `Sidebar.tsx:194-220` `SidebarResizeHandle` — `role="separator"` + manual `pointerdown/move/up` window listeners writing `setSidebarWidth(startW + Δx)` | **B (hand-rolled)** | Library-first says replace **if** a panel-mechanics lib is adopted. Decision hinges on `react-resizable-panels` — see §10. |
| **File tree** | ⚠️ `components/shared/directory-browser.tsx` — a **folder picker** for registration: single-level-per-fetch, breadcrumb + Input. **Not** an explorer/tree. | **C (product-specific)** | Keep. It is a *picker*, not the workspace explorer. |
| **Collapsible primitive** | ✅ `ui/collapsible.tsx` (Radix `Collapsible` via flat `radix-ui`) | **A (correct)** | Reuse for tree expand/collapse. |
| **Preview** | ❌ none | — | Product component (`react-shiki` / `parse-diff` already installed). |

---

## 6. Primitive vs product boundary

- **Library territory (to use):** Tabs, ScrollArea, Separator, Collapsible —
  all imported from the flat `radix-ui` package.
- **Product territory (custom, correct to keep):** `FileExplorer`, the
  file-tree data model, `FilePreview`, selected-file state, workspace
  persistence, file loading, and the reveal-a-file-from-chat command.
- `directory-browser.tsx` is product-specific (folder *registration picker*) —
  **do not replace it** to satisfy a panel.

---

## 7. Target shell (derived, not assumed)

```
AppShell
├── ActivityBar │ Sidebar(resizable) │ <main>  flex-row   ← ONE change
│                                      ├── Conversation region (flex-1 min-w-0)
│                                      │   └── TabStrip → ChatShell/CodeShell (unchanged)
│                                      ├── <Separator />  (resize handle when resizable)
│                                      └── RightWorkspace (when open)
│                                           ├── WorkspaceTabs  (Radix Tabs: file_tree | preview | …)
│                                           └── ScrollArea → Explorer | Preview
├── StatusBar …
```

**Panel placement decisions (all supportable from the current shell):**

- **Lives inside `<main>`** so it is chat-surface-scoped and workspace-rooted;
  persists across conversation switching (conversation-driven), independent of
  the outer sidebar.
- **Independent scrolling** → Radix `ScrollArea`.
- **Main chat shrinks/grows with it** → `flex-1 min-w-0` on the chat column
  (already present).
- **Collapse** → `RightWorkspace` unmounts/hidden when closed.
- **Width persistence** → extend the **existing** `useDesktopLayout` store
  (already owns `sidebarWidth` + clamp + persist + `syncChromeVars`).
  **No new store, no new React context** — rule-compliant.

**Recommended composition: E — resizable + tabbed + scroll.** IDE-like, and
matches CodeG's aux-panel model.

---

## 8–9. Reuse vs genuinely-new primitives

- **Reuse:** `radix-ui` (Tabs / ScrollArea / Separator / Collapsible),
  `@tanstack/react-virtual` (tree virtualization), `react-shiki` (code
  preview), `parse-diff` (diff preview), `useDesktopLayout` (state), and the
  existing `cn` / variants conventions.
- **New files needed (hand-ported to project conventions):** `ui/tabs.tsx`,
  `ui/scroll-area.tsx`, `ui/separator.tsx`. Plus product components:
  `RightWorkspace`, `WorkspaceTabs`, `Explorer`, `Preview`.

---

## 10. Is `react-resizable-panels` required?

**Recommendation for v1: NO.**

The rule is "use an existing solution if one exists" — and one does:

- The app **already ships a working resize splitter** (`SidebarResizeHandle`)
  built on `desktopLayout.sidebarWidth`. The right panel can reuse the *same*
  mechanism: a `PanelResizeHandle` mirroring the left one, writing to a new
  `workspacePanelWidth` in the same store. Same pattern, same persistence, same
  CSS-variable path — zero new framework, zero second resize paradigm.
- `react-resizable-panels` would add nested/collapsible/multi-pane a11y, but v1
  is a **single** right column (not nested). It is genuinely optional and would
  introduce a new dependency alongside the existing resize mechanism.

**Decision point:** v1 can reuse the existing splitter pattern (no new dep).
If the full `PanelGroup` / collapsible / nested experience is wanted later,
that is the justified moment to add `react-resizable-panels`, documented in
`docs/decisions.md` with why, what it provides, duplication, and version
compatibility. **Recommend deferring it.**


**Verified against the installed flat package:** `radix-ui@1.6.7` exports
`Collapsible, ScrollArea, Separator, Tabs`. It does **not** export any
`Resizable`/`Panel` primitive.

---

## 11. No shadcn CLI

Confirmed: the current shadcn registry emits `@radix-ui/react-*` **scoped**
imports that **do not resolve** in this project (it is standardized on the flat
`radix-ui` package), would use `forwardRef` everywhere, and would omit
`data-slot` — all against project conventions. The registry is treated as
**reference material only**. The three primitives will be **hand-ported**: take
the correct official classNames (`data-[state=active]:…` etc.), rewrite imports
to `radix-ui`, use the modern function-component + `data-slot` style, no
`forwardRef`.

---

## 12. No UI polish yet

Correct — structural architecture only. Colors, typography, spacing,
animations, and shadows are deferred to a separate pass.

---

## 13. Deliverable summary

1. **Shell:** `AppShell` (`flex-col` outer; inner pane is `flex-row`); `<main>`
   is `flex flex-1 flex-col`.
2. **Suitable?** Yes — needs `<main>` content → `flex-row`. One structural
   change; sidebar/status untouched.
3. **Panel lives:** inside `<main>`, chat-scoped, workspace-rooted, survives
   conversation switch.
4. **Composition:** **E — resizable + tabbed + scroll** (Tabs + ScrollArea +
   reuse-existing-splitter).
5. **Existing resizable:** **hand-rolled `SidebarResizeHandle`** (`role="separator"`,
   pointer listeners → `desktopLayout`). Class B — reuse the pattern; do not
   import a second resize lib without justification.
6. **Tabs / Scroll / Separator:** none exist as primitives; use the verified
   `radix-ui` flat exports.
7. **Hand-rolled code overlapping Radix:** only `SidebarResizeHandle`.
   `directory-browser.tsx` is product code (keep).
8. **Reuse:** `radix-ui`, `@tanstack/react-virtual`, `react-shiki`,
   `parse-diff`, `useDesktopLayout`.
9. **New primitives:** `tabs.tsx`, `scroll-area.tsx`, `separator.tsx`
   (hand-ported) + product `RightWorkspace` / `Explorer` / `Preview`.
10. **`react-resizable-panels`:** **not required for v1** — reuse the existing
    splitter pattern; document it in `decisions.md` if added later.
11. **Final tree:** §7 above.
12. **Files expected to change (when approved):**
    - `app/layout/AppShell.tsx` — `<main>` content → `flex-row`, mount
      `RightWorkspace`.
    - `features/desktop/state/desktopLayout.ts` — add
      `workspacePanelOpen/Width/ActiveTab` + clamp + persist + `syncChromeVars`.
    - `lib/chrome-vars.ts` — publish the panel width variable.
    - **New:** `components/ui/tabs.tsx`, `scroll-area.tsx`, `separator.tsx`;
      `features/workspace/RightWorkspace.tsx`, `WorkspaceTabs.tsx`,
      `Explorer.tsx`, `Preview.tsx` (paths indicative).
    - **Backend (only when tree/preview are wired):** a new read-only GET
      tree/list endpoint under the workspace boundary, reusing the
      `resolveConversationWorkspace` path-containment guard — **not**
      `/api/tools/*` (which stays approval-gated and model-facing).
    - **No change to:** virtualization, P2 history/runtime, OpenCode,
      Workstream 1, `Sidebar`, `StatusBar`.

---

## Open decisions (blocking implementation)

1. **Resize approach:** reuse the existing `SidebarResizeHandle` pattern (no
   new dependency — recommended) **or** adopt `react-resizable-panels` now for
   full `PanelGroup` / collapsible support?
2. **v1 scope:** `file_tree` + `preview` tabs first (backend list/read
   endpoints come with it)? Or also `session_details`?

**No implementation proceeds until this structure is approved.**

