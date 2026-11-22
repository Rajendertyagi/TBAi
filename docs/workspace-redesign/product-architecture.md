# Product architecture — unified workspace

## 1. The core principle

**The workspace provides layout infrastructure. The user decides which conversations and tools appear in which panels.**

Chat runtimes and panel positions are separate concerns. A runtime is never tied to a column.

## 2. Concept model

| Concept | Responsibility |
|---|---|
| **Workspace** | Overall user-controlled working environment |
| **Chat Threads** | Permanent left-side conversation navigation (both runtimes) |
| **Primary Chat** | Permanent main conversation **position** — not a runtime |
| **Panel** | A generic container — not an application feature |
| **Tab** | A specific piece of content displayed inside a panel |
| **Content type** | Direct Chat, OpenCode Chat, File Tree, File Viewer, Editor, Browser |
| **Runtime** | Execution system for a chat tab (Direct or OpenCode) — independent of panel |
| **Layout** | Arrangement of panels and their contents |

Key distinctions:
- **Primary Chat is a position, not a runtime.** It can hold a Direct Chat or an OpenCode Chat.
- **A panel is a container, not a feature.** There is no "Direct Chat panel", "OpenCode panel", "Code Workspace panel", or "AI Assistant panel".
- **A tab identifies content.** Its content type determines what renders; its position does not.
- **Direct Chat and OpenCode Chat are content types with separate runtimes.** They must stay isolated but may appear anywhere, side by side, or even as tabs in the same panel.

## 3. Permanent structure

```
Chat Threads | Primary Chat | [optional generic panels...]
```

1. Chat Threads always far left; Primary Chat immediately right. Both permanent.
2. Primary Chat expands to all remaining width when no optional panels exist.
3. Optional panels are created only when the user adds them; they never reserve unused space.
4. Users can add, close, resize, split, rearrange, and restore optional panels.
5. Users can move tabs between compatible panels and reorder them within a panel.
6. No predefined feature-specific column is mandatory.

## 4. Chat types are content, not positions

Both runtimes are valid in Primary Chat or any optional panel. All of these are valid user arrangements:

- `Chat Threads | Primary Chat (Direct)`
- `Chat Threads | Primary Chat (OpenCode)`
- `Chat Threads | Direct Chat | Direct Chat`
- `Chat Threads | OpenCode Chat | OpenCode Chat`
- `Chat Threads | Direct Chat | OpenCode Chat`
- `Chat Threads | OpenCode Chat | Direct Chat`
- `Chat Threads | Primary Chat | File Tree | File Viewer`
- `Chat Threads | Primary Chat | Browser`

These are examples, not fixed layouts. The user chooses which conversation or tool occupies each panel.

## 5. Tab content types

A panel can hold multiple tabs. A tab's content type determines what renders:

| Content type | Runtime | Identity carried by tab |
|---|---|---|
| Direct Chat | Direct (`chat:` key) | conversation id (`ref`) |
| OpenCode Chat | OpenCode (`agent:` key) | conversation id (`ref`) + session id resolved by backend |
| File Tree | — | project / registered-folder id |
| File Viewer | — | file identity + project context |
| Code Editor | — | file identity + project context |
| Browser | — | URL / tool output reference |

Rules:
- Do not hardcode a Direct Chat panel, OpenCode panel, Code Workspace panel, or AI Assistant panel.
- A tab's label/icon may show its content type, but its panel position is never determined by that type.
- Different chat types may coexist in the same workspace, including side by side and as tabs in one panel.
- **Never assume two visible chat tabs share a runtime.** Each conversation keeps its own identity and runtime. Moving a tab must not create a new conversation, change its runtime, or lose its state.

## 6. Chat Threads behavior

Chat Threads is the permanent navigation for both conversation types. Verified from source:
- Direct conversation identity: `conversations.id` → assistant-ui `remoteId` → tab `ref` → key `chat:<id>` → `/chat/<id>`.
- OpenCode session identity: `conversations.id` (= tab `ref`, key `agent:<id>`, `/code/<id>`) → bootstrap → `opencode_session_id` → scoped V2 client.
- The tab store already unifies both via `kind: "chat" | "agent"` (`chatTabs.ts:20-27`); engine comes from the conversation row, not the tab.
- The sidebar already shows both with engine icons (Direct blue, OpenCode emerald) but no engine-based grouping today.

Rules:
- Users recognize each type by a clear icon and label (the prototype adds explicit "Direct chats" / "OpenCode sessions" group headings).
- Selecting a conversation opens it in Primary Chat; "open in panel" opens it in an optional panel.
- Switching conversations must not change unrelated open panels' content or context.
- Do not duplicate conversation state or create a second conversation-management system.

## 7. Context and isolation

Every tab retains its own identity and context:
- **Chat tabs:** runtime type, conversation/session id, project context, lifecycle/execution state.
- **File tabs:** project/folder context, file identity, source conversation when applicable.

Pinned vs follow-active:
- Tabs are **pinned by default** to the context they were opened with.
- "Follow active conversation" is an explicit per-tab opt-in.
- Switching Primary Chat never silently changes an unrelated tab's context.
- All file access is resolved and authorized by the backend; never trust a client-supplied absolute path.

## 8. What this is NOT (superseded concepts)

The following earlier ideas are **superseded** and must not be treated as requirements:
- A mandatory "Development workflow" / three-column Code layout.
- A dedicated "Code Workspace" or "AI Assistant panel".
- Treating OpenCode as a generic assistant panel — it is a chat runtime with its own sessions.
- Any rule that assigns a runtime to a fixed panel position.
- The old `docs/right-hand-workspace-*` single-panel proposal and the old `docs/ui-redesign/application-shell.md` layout.

## 9. Decisions (recommendations)

- Saved layouts: device-wide first (localStorage, like `sidebarWidth`); per-project later.
- First content types to implement: file tree + read-only viewer (lowest risk); chat panels after runtime-isolation feasibility is proven.
- Deferred: writable editor (no editor library; needs ADR), interactive browser (CSP/webview security), per-conversation layout persistence.
- Keep the existing unified tab store; do not introduce a second tab-management system.
