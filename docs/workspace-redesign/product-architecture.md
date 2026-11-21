# Product architecture — unified workspace

## 1. The model

TBAi is one application containing several **workspaces** that share navigation, project context, a design system, and contextual panels.

```
Application shell
├── Permanent region 1: Chat Threads (conversation list)
├── Permanent region 2: Primary Chat (main conversation + composer)
└── Additional workspace region (optional, user-controlled)
    ├── Panel A (own tabs)
    ├── Panel B (own tabs)
    └── Panel C (own tabs)
```

The first two regions are the foundation. They are always present. Everything to the right is optional and arranged by the user.

## 2. Workspaces

| Workspace | Purpose | Typical panels |
|---|---|---|
| **Chat** | Conversation-first work | Primary Chat + optional file preview, artifact preview, second chat |
| **Code** | Development | Primary Chat + file tree + code editor + OpenCode assistant |
| **Files** | Project browsing | Primary Chat + file tree + file viewer |
| **Scheduler** | Automation | Primary Chat + task list/detail (existing page) |
| **Providers & Models** | AI configuration | existing settings surface |
| **Settings** | Application configuration | existing settings surface |

Workspaces are not fixed three-column pages. They are starting arrangements of the same panel system. The user can change them.

## 3. Panel types

| Type | Description | Feasibility today |
|---|---|---|
| `chat` | A second conversation with its own runtime | Risky — needs isolated second Direct runtime |
| `files` | File tree for the active project/workspace | Needs a conversation-scoped file-list endpoint |
| `viewer` | Read-only file preview (code, markdown, diff) | Mostly possible with installed libraries |
| `editor` | Writable code editor | Missing — no editor library installed |
| `browser` | Interactive web page | Missing / high risk — no iframe/webview path |
| `assistant` | OpenCode AI assistant panel | Possible — reuse existing OpenCode runtime |

Each panel instance owns an ordered list of tabs and an active tab. Tabs can be moved between panels.

## 4. Context ownership

The workspace must always make it clear **which project and which conversation** a panel belongs to.

| Scope | What belongs here |
|---|---|
| **Application** | Global navigation, theme, window chrome, saved layout list |
| **Project** | Registered folder, its file tree root, project-level settings |
| **Conversation** | Thread identity, messages, artifacts, the workspace resolved from it |
| **Panel** | Which tab is active, panel size, panel type |
| **Tab** | The thing it points at (conversation id, file path, artifact id) |

Rules:
- A file tree shows the files of the selected project or the active conversation's resolved workspace.
- Switching the Primary Chat must not silently show files from an unrelated conversation.
- A second chat keeps its own conversation identity and its own runtime.
- A file preview opened from a conversation keeps the project/thread relationship that opened it.
- Every panel shows a small context badge (project name, and conversation when relevant).

## 5. Cross-workspace workflow (the thing that proves the architecture)

The first end-to-end workflow to implement and test:

```
Select project → browse files → open Chat → preview a file
→ open it in Code → interact with OpenCode assistant → verify the resulting file
```

If this works without losing context or layout, the architecture is sound. Isolated pages working is not enough.

## 6. What this is NOT

- Not a permanent three-column layout on every page.
- Not a second file-management system independent of registered folders/workspaces.
- Not a merge of Direct Chat and OpenCode runtimes.
- Not a custom editor built before evaluating existing options.
- Not a redesign of every page independently.
- Not production implementation before approval.
