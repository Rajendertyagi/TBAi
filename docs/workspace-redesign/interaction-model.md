# Interaction model — panels, context, persistence

## 1. Permanent foundation

- **Chat Threads** (left, ~272px): conversation list grouped by project, with search, filter, new-folder, new-chat. Bottom strip: Scheduler, Archived, Folders, Settings. Never removed.
- **Primary Chat** (immediately right): the main conversation, its tab strip, context bar, transcript, composer. Never removed.

Both remain in every scenario. The additional workspace region starts to the right of Primary Chat and is empty by default.

## 2. Panel behavior

| Action | Behavior |
|---|---|
| Add panel | `+` in a panel's tab strip opens a menu of panel types (chat, files, viewer, browser, editor, assistant). A new panel is appended to the workspace region. |
| Close panel | `×` on the panel. If it was the last tab, the panel disappears. |
| Tabs | Each panel has its own tab strip with an active tab. `+` adds a tab to that panel. `×` closes a tab. |
| Move tab | Drag a tab from one panel's strip to another. The source panel closes if it becomes empty. |
| Split | `⧉` duplicates the active tab into a new panel beside it. |
| Resize | Drag the divider between two panels. Minimum width ~220px. |
| Collapse / reopen | A panel can be collapsed to its tab strip and reopened. |
| Restore | Saved layouts restore panel types, order, sizes, and active tabs. |

## 3. Context association

Every panel shows a context badge: project name, and conversation name when relevant.

- A **file tree** shows the selected project's files, or the active conversation's resolved workspace.
- A **file preview** keeps the project/thread relationship it was opened from.
- A **second chat** keeps its own conversation identity and its own runtime.
- Switching the Primary Chat does not change what another panel is showing, unless the user explicitly chooses "follow active conversation".

Open question: should panels "follow" the active conversation by default, or stay pinned? Recommendation: stay pinned; make following an explicit opt-in per panel.

## 4. Persistence

Follow the existing three-tier rules (`docs/state-management.md`):

| Data | Where | Why |
|---|---|---|
| Panel tree (types, order, sizes, active tabs) | Device-local localStorage via `useDesktopLayout` `persist` `partialize` | Geometry is device-specific; precedent: `sidebarWidth` |
| Saved layout list (named arrangements) | SQLite preferences if portable across devices; localStorage if device-only | Open question — needs owner decision |
| Conversation/message state | assistant-ui runtime only | Never duplicate in a client store |
| Tab membership references | SQLite preferences (existing `sharedTabs` mirror) | Reconcile removal-only at boot |

Do not create a new shared `web/src/stores/`. A panel store belongs in its owning feature's `state/` directory.

## 5. Keyboard and accessibility

- Visible focus rings on all interactive elements (already a project rule).
- 24×24 minimum click targets.
- Tab reordering: reuse dnd-kit KeyboardSensor (Space to start, arrows, Escape) from `TabStrip.tsx`.
- Panel focus: a keyboard command to move focus between panels (to be specified).
- Reduced-motion support for panel animations.

## 6. Responsive behavior

- At wide widths (≥1440px): all scenarios fit comfortably.
- At 1280px: panels shrink toward their minimum; the Primary Chat keeps a minimum of ~360px.
- At 1024px: additional panels become collapsible; at most one or two are visible at once; the user can switch between them.
- Below that: the additional region becomes an overlay/drawer; the two permanent regions remain.

The prototype demonstrates the wide layouts; narrow behavior is specified here, not yet prototyped.

## 7. Empty, loading, error states

- **Empty workspace region:** a subtle hint ("Use + to add a panel") — no large empty card grid.
- **Panel loading:** a lightweight skeleton in the panel body.
- **File access denied:** an inline message in the panel with the workspace name and a "choose project" action.
- **Second chat unavailable:** if the isolated runtime cannot be created, show an inline error in that panel without affecting the Primary Chat.

## 8. What the prototype demonstrates

`prototype/index.html` is standalone and interactive:

1. **Default** — Chat Threads + Primary Chat only.
2. **Two chats** — a second chat panel with its own tab strip and context badge.
3. **Files** — File Tree + File Viewer panels.
4. **Browser** — a conceptual browser panel (read-only; see technical-audit.md for why a real browser is high risk).
5. **Development** — File Tree + Code Editor + OpenCode AI Assistant panels.

Interactions: scenario switcher, `+` to add a tab/panel, drag dividers to resize, `⧉` to split, `×` to close, drag tabs between panels, dark/light theme toggle.

The prototype is a design artifact only. It does not use production code or libraries and is isolated from production routes.
