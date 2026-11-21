# TBAi — Unified Workspace Redesign (durable handoff)

**This is the canonical handoff document.** A future agent with no access to the previous chat must read this file first.

## Current status (2026-11-21)

- **Phase:** product architecture + feasibility + prototype complete. Awaiting owner review and approval.
- **Production code:** NOT touched. No dependencies added. No behavior changed.
- **Repository:** one checkout only, `D:\Temp\ai-chat-app`, branch `ui-foundation-upgrade`, HEAD `4c47acaea3311d48b326f5b4d13bc3a04a18f37e`. All pre-existing uncommitted/untracked work preserved. No commits, pushes, branch changes, resets, stashes or cleans.
- **Prototype:** `prototype/index.html` — standalone, zero dependencies, interactive, dark + light.

## The core idea

**One application. Multiple workspaces. Shared context.**

Two regions are permanent and never disappear:
1. **Chat Threads** — the conversation list on the left.
2. **Primary Chat** — the main chat window immediately to its right.

Everything else is an **optional panel** to the right of the Primary Chat. The user controls the arrangement: add, close, resize, split, move tabs, collapse, restore.

## Confirmed decisions (owner-approved)

1. The first two regions (Chat Threads + Primary Chat) are permanent in every layout.
2. Additional panels are optional and appear to the right of the Primary Chat.
3. Each panel has its own independent tabs.
4. Panels can be added, closed, resized, split, and have tabs moved between them.
5. Project and conversation context must be preserved and visible per panel.
6. Direct Chat and OpenCode runtimes must NOT be merged — unify presentation, isolate execution.
7. File access must stay workspace-scoped with path containment; do not repurpose `/api/folders/browse`.
8. No new dependencies during this planning phase; library-first; assistant-ui train frozen.
9. No production code changes until the architecture and prototype are reviewed and approved.
10. Keep all existing uncommitted UI foundation work intact; build on it.

## Recommendations (not yet approved)

- Build the panel foundation before adding capabilities (files, editor, browser).
- Ship a read-only file preview before any real editor (no editor library is installed).
- Treat an interactive browser panel as a later, high-risk capability; start with a read-only screenshot viewer from the existing browser tool.
- Extend `useDesktopLayout` for device-local panel geometry; use SQLite preferences only if layout must be portable across devices.
- Reuse the existing `SidebarResizeHandle` pointer pattern and dnd-kit tab reordering; do not add a split-pane library without an ADR.

## Assumptions (need owner confirmation)

- "Layouts" means saved arrangements of panels (e.g. Default, Files, Development), not per-conversation layouts. Whether layouts should be global, per-project, or per-conversation is an open question (see technical-audit.md).
- The Code workspace's file tree belongs on the LEFT of the editor, not in the right panel. The right panel in Chat is for previews/artifacts.
- A real code editor is out of scope for the first implementation; read-only preview is enough to prove the workflow.

## Unresolved questions

1. Should saved layouts be global, per-project, per-conversation, or a combination?
2. Is an interactive browser panel required, or is a read-only screenshot viewer acceptable for v1?
3. Is a writable editor required in v1, or is read-only preview acceptable?
4. Should the permanent Primary Chat be a single fixed thread, or a tabbed area with its own tabs?
5. Which panel types ship in the first release (chat, files, viewer, browser, editor, assistant)?

## Documents

- `product-architecture.md` — product structure and workspace model.
- `technical-audit.md` — verified findings, source references, capabilities and gaps.
- `interaction-model.md` — panel behavior, context ownership, persistence, keyboard, responsive.
- `prototype/index.html` — interactive visual prototype (open directly in a browser).

## Historical / related (do not treat as current spec)

- `docs/right-hand-workspace-audit.md` — OLD single right-panel proposal, unapproved. Useful ideas, but superseded by the multi-panel requirement.
- `docs/right-hand-workspace-demo.html` — OLD single-panel demo. Historical reference only.
- `docs/ui-redesign/IMPLEMENTATION-PLAN.md` — earlier authoritative plan for the visual redesign; this workspace spec supersedes its panel model but preserves its constraints.
- `docs/ui-redesign/requirements.md` — 21 earlier preferences; historical record.

## Next approved step

Owner reviews the prototype and the three documents, answers the unresolved questions, and approves (or rejects) the architecture. Only then may implementation planning begin, with an ADR in `docs/decisions.md` for the panel layout model and any new dependency.
