# Page designs

Visual proposals are in `screenshots/proposed/` and the interactive prototype is `prototype/index.html`.

## Chat (`/chat/:threadId?`)
See `screenshots/proposed/chat-dark.png` and `chat-light.png`.

- Conversation sidebar with grouped In work / Projects / Recent and a clear active row.
- Top header with conversation title and contextual actions.
- Message column with clear role distinction: user messages and assistant messages have separate avatars, names, and model labels.
- Code blocks are bounded surfaces with a filename header and READ ONLY marker.
- Tool executions are compact rows with a status badge, tool name, and duration.
- Composer is a grounded surface at the bottom with Commands, Mention, engine, and model chips inline.
- Optional right inspector shows context usage, conversation info, sources, and credits.
- Welcome state (not shown in prototype) should use the space purposefully with a restrained starting action, not random-colored cards.

**Code workspace (`/code/:agentId?`)** uses the same shell with a file/workspace panel in place of the plain message column. The Direct/OpenCode runtime boundary is preserved; this is presentation only.

## Settings (`/appearance`, `/providers`, etc.)
See `screenshots/proposed/settings-dark.png` and `settings-light.png`.

- Settings navigation grouped into Workspace, Intelligence, System with clear section labels.
- Page header with title and description.
- Settings organized into cards with clear section titles (Theme, Chat layout).
- Each row has a label, description, and right-aligned control (segmented control, swatches, toggle).
- Consistent alignment and spacing; no page-specific styling.

## Scheduler (`/scheduler`)
See `screenshots/proposed/scheduler-dark.png` and `scheduler-light.png`.

- Two-panel layout: task list (380px) and task detail.
- Task list rows show icon, name, schedule, and a status badge (ACTIVE / PAUSED / FAILED / DRAFT).
- Selected task has an accent background.
- Detail panel shows task title, schedule, three stat cards (total runs, success rate, last run), recent runs list, and primary actions (Run now, Edit, Pause).
- Empty state should be focused: a primary action plus a small set of suggested templates, not a wall of eight cards.

## Providers (`/providers`)
Not separately mocked; follows the Settings pattern with a list of provider rows and a detail/edit panel. Provider keys remain server-side; the UI shows only metadata and `credentialConfigured`, as today.

## Dialogs, menus, overlays
- Dialogs: centered, bounded surface with a clear title, description, and actions. Elevated shadow derived from theme. No dark halo in dark mode.
- Dropdowns/context menus: compact, hairline border, consistent item states.
- Toasts: restrained, semantic color only.
- All overlays keep visible focus and keyboard navigation.

## Before/after summary
| Area | Before | Proposed | Improvement |
|---|---|---|---|
| Tabs | Many truncated tabs | Single active + recent dropdown | Readable, less noise |
| Sidebar | Dense mixed groups | Clear grouped sections, stronger active | Faster orientation |
| Chat | Flat message flow, random cards | Clear roles, bounded code/tool surfaces | Better hierarchy |
| Inspector | Absent | Context/session panel | Workspace feel |
| Scheduler | Wall of template cards | Task list + detail | Action-focused |
| Settings | Flat stacked cards | Grouped nav, clear headers | Stronger hierarchy |
| Themes | Near-inversion | Deliberately designed light/dark | Better contrast |
