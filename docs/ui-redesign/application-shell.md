# Proposed application shell

## Structure

```
┌────┬──────────────┬──────────────────────────────────┬──────────────┐
│Rail│  Sidebar     │  Top header (title + actions)    │  Inspector   │
│    │  (264px)     ├──────────────────────────────────┤  (300px)     │
│ 52 │              │                                  │              │
│ px │  In work     │  WORKSPACE CONTENT               │  Context     │
│    │  Projects    │  (chat / scheduler / settings /  │  Conversation│
│    │  Recent      │   code / providers / ...)        │  Sources     │
│    │              │                                  │  Usage       │
├────┴──────────────┴──────────────────────────────────┴──────────────┤
│ Status bar: local/online · model · workspace                        │
└──────────────────────────────────────────────────────────────────────┘
```

## Regions

**Icon rail (52px).** Primary surface switching: Chat, Code, Scheduler, Folders, MCP, Settings. Active item has an accent marker and tinted background. Settings is a single gear at the bottom.

**Conversation sidebar (264px).** Grouped into In work, Projects, Recent. Each row shows an icon, title, and metadata (time/count). Active row has a clear accent background and a status dot. A search field sits at the top. Collapsible.

**Top header (52px).** Breadcrumb (Workspace › page), page title, short description, and contextual actions (search, more, primary action). Consistent across all pages. Replaces the current thin breadcrumb-only bar.

**Workspace content.** Each surface uses the layout that fits its workflow:
- Chat: message column + composer, optional inspector.
- Code: conversation + file/workspace panel, optional inspector.
- Scheduler: task list + detail panel.
- Settings: settings nav + content.
- Providers/MCP/Folders/Logs: list + detail or table layout.

**Inspector (300px, optional).** Shows Context usage, Conversation info, Context sources, and Usage. Relevant to Chat and Code; hidden on Settings/Scheduler unless there is useful data. Collapsible with a toggle in the header.

**Status bar (26px).** Local/online state, active model, workspace name.

## Behavior

- **Panel collapse:** sidebar and inspector can be collapsed independently. The workspace expands to fill the space. Collapse state persists per device.
- **Narrow windows (<1100px):** inspector hides automatically; sidebar can be toggled. At <800px the sidebar becomes an overlay.
- **Tab model:** the current many-tab strip is replaced with a single active conversation plus a compact "recent" dropdown in the sidebar header. This removes the unreadable truncated tab strip. If tabs are retained, cap visible tabs and move the rest to an overflow menu.
- **Window chrome:** the existing protected geometry (`window-chrome.ts`, `chrome-vars.ts`) is respected; this proposal does not change title bar height or drag regions.

## Rationale
The shell provides a stable frame (rail, sidebar, header, status) while allowing each workspace to use its own layout. This is the OpenChamber pattern adapted to TBAi: consistent where it helps, flexible where the workflow demands it.
