# Interaction model — generic panels, tabs, context, persistence

## 1. Permanent foundation

- **Chat Threads** (left, ~272px): navigation for both Direct Chat conversations and OpenCode sessions, grouped by runtime with clear labels. Never removed.
- **Primary Chat** (immediately right): a permanent **position** holding a tab (Direct or OpenCode). Never removed. Expands to all remaining width when no optional panels exist.

Optional panels appear only when the user adds them, to the right of Primary Chat.

## 2. Generic panel and tab behavior

A panel is a generic container. It has a tab strip; each tab has a content type and identity.

| Action | Behavior |
|---|---|
| Open a panel | `⊞` in a tab strip opens a menu of content types (Direct Chat, OpenCode Chat, File Tree, File Viewer, Browser). A new generic panel is created. |
| Add a tab | `+` in a tab strip adds a tab of a chosen content type to that panel. |
| Close tab / panel | `×` on a tab closes it; closing the last tab closes the panel. Primary Chat always keeps at least one tab. |
| Activate tab | Click a tab to show its content. |
| Move tab | Drag a tab to another panel's strip. The tab keeps its identity, runtime, and state. Source panel closes if empty. |
| Reorder tab | Drag a tab within its strip. |
| Split | `⧉` splits the panel right (row) or down (column), duplicating the active tab's content into a new generic panel. |
| Resize | Drag a divider; minimum panel width ~200px. |
| Save / Restore | Save the arrangement to localStorage; restore after reload. |

**Runtime independence:** moving a Direct Chat tab or an OpenCode Chat tab between panels never changes its runtime, creates a new conversation, or loses state. The panel is only a container.

## 3. Context and identity model

Relationship: Application → Project (registered folder) → Conversation → Tab → Content.

Verified identity chains (from source):
- **Direct:** `conversations.id` → assistant-ui `remoteId` → tab `ref` → key `chat:<id>` → `/chat/<id>`.
- **OpenCode:** `conversations.id` (= tab `ref`, key `agent:<id>`, `/code/<id>`) → bootstrap → `opencode_session_id` → scoped V2 client.

Rules:
- A tab stores IDs only (conversation id, project id, file id) — never absolute filesystem paths.
- The backend resolves authorized roots via `resolveConversationWorkspace` + `resolveSafe`; it rejects paths outside the workspace.
- Tabs are **pinned by default**; "follow active conversation" is an explicit opt-in.
- Switching Primary Chat never silently changes an unrelated tab's context. A file tab whose file is absent in the new context shows an inline "not in this workspace" state.
- Chat/message state stays in the assistant-ui runtime; never duplicate it in a client store.

## 4. Persistence

Follow `docs/state-management.md` tiers:
- Panel tree (types, order, sizes, active tabs) and Primary Chat tabs: device-local localStorage (prototype uses `tbai:workspace-prototype-layout`; production should extend `useDesktopLayout` `persist` `partialize`, precedent `sidebarWidth`).
- Conversation/message state: assistant-ui runtime only.
- Tab membership references: SQLite preferences (existing `sharedTabs` mirror), reconciled removal-only at boot.
- No new shared `web/src/stores/`; a panel store belongs in its owning feature's `state/`.

## 5. Keyboard and accessibility

- Visible focus rings; 24×24 minimum targets.
- Tab reordering: reuse dnd-kit KeyboardSensor (Space, arrows, Escape) from `TabStrip.tsx`.
- Panel focus navigation: to be specified.
- Reduced-motion support for panel animations.

## 6. Responsive behavior

- ≥1280px: all arrangements fit; Primary Chat keeps a minimum width.
- ≤960px: optional panels become a right-side overlay that stacks panels vertically so each stays readable; the two permanent regions remain. No horizontal overflow.

## 7. Empty, loading, error states

- No optional panels: Primary Chat simply fills the width (no empty column, no placeholder card).
- Panel loading: lightweight skeleton.
- File access denied: inline message with workspace name and "choose project" action.
- Second chat runtime unavailable: inline error in that tab only, without affecting Primary Chat.

## 8. What the prototype demonstrates

`prototype/index.html` is standalone and interactive. Scenario buttons are prototype-only (violet bar), not app navigation. Demonstrations:
1. Default — Chat Threads + Primary Chat (Direct).
2. Primary Chat displaying OpenCode Chat.
3. Two Direct Chat conversations side by side.
4. Two OpenCode sessions side by side.
5. Mixed Direct + OpenCode side by side (both orders available via tabs/panels).
6. Chat with file tools in optional panels (File Tree + File Viewer; Browser).
7. Adding, closing, splitting, resizing, rearranging panels.
8. Moving/reordering tabs, including mixed runtimes in one panel.
9. Saving/restoring a user-created arrangement.

Runtime badges: Direct = amber, OpenCode = blue. Chat type is visible in the tab and context bar, but never forces a panel position.

Interactions verified by a scripted test: 15/15 PASS, zero console errors. Screenshots captured at 1440×900, 1280×800, 960×800 in `prototype/screenshots/`.
