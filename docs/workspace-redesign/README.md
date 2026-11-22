# TBAi — Unified Workspace Redesign (durable handoff)

**Read `WORKSPACE_ARCHITECTURE_PLAN.md` first — it is the authoritative architecture plan.** This README is the durable handoff and background context; where it conflicts with the plan, the plan wins.

## Current status (2026-11-22, revision 6)

- **Phase:** the five confirmed multi-chat fixes from `multi-chat-architecture-audit.md` are implemented and committed. The authoritative, implementation-ready `WORKSPACE_ARCHITECTURE_PLAN.md` is complete and awaits owner review; no further implementation is authorized by it.
- **Production code:** the five fixes are committed (thread-list cache, operation ownership, Direct model/reasoning selection, history visit ownership, stable workspace panel hosts). No dependencies were added. See `docs/decisions.md` for the `features/workspace/` ownership decision. The working tree is clean at the audited HEAD apart from untracked prototype screenshots.
- **Verification (agent-reported, not re-run in the latest audit):** typecheck, build, lint, format, test-locations exit 0; unit 4999 pass / 3 skip / 0 fail, integration 1037 pass / 85 skip / 0 fail, DOM 828 pass / 0 fail. No live browser/Tauri E2E was run, and no CI results exist for this branch.
- **Prototype:** `prototype/index.html` — standalone, zero dependencies, interactive, dark + light. Rebuilt in revision 4 around generic panels + content types. Interaction test: 16/16 PASS, zero console errors.
- **Screenshots:** the `arch-*` renders were review artifacts and are NOT committed to the repository (removed in a follow-up commit). They remain on the local disk under `prototype/screenshots/` as untracked files; the links below are therefore local-only and will not resolve from a fresh clone.

## The core idea

**The workspace provides layout infrastructure. The user decides which conversations and tools appear in which panels.**

**One application. Multiple workspaces. Shared context.**

Two regions are permanent:
1. **Chat Threads** — conversation navigation for both Direct Chat and OpenCode sessions, far left.
2. **Primary Chat** — a permanent main conversation **position** immediately right. It is NOT a runtime; it can hold a Direct Chat or an OpenCode Chat.

Everything else is an optional **generic panel** to the right. Panels are containers, not features. A **tab** determines what content appears (Direct Chat, OpenCode Chat, File Tree, File Viewer, Browser). Direct Chat and OpenCode Chat are separate runtimes that may appear in any panel, side by side, or as tabs in the same panel.

## Confirmed decisions (owner-approved)

1. Chat Threads and Primary Chat are permanent; Primary Chat is a position, not a runtime.
2. Optional panels are generic containers, created only when the user adds them; no reserved empty column.
3. Each panel has its own tabs; tabs can be added, closed, reordered, and moved between panels.
4. Panels can be added, closed, resized, split, rearranged, and restored.
5. Direct Chat and OpenCode Chat are separate runtimes — never merge them, never tie either to a fixed panel position.
6. Users can arrange both chat types in any supported combination, including side by side and mixed in one panel.
7. File tools and other features are optional content, not mandatory predefined columns.
8. Project/conversation context and runtime isolation must remain intact; backend resolves all file paths.
9. No new dependencies; library-first; assistant-ui train frozen.
10. No production code changes until the architecture and prototype are approved.

## Superseded / historical (do not treat as current requirements)

- A mandatory "Development workflow" / three-column Code layout.
- A dedicated "Code Workspace" or "AI Assistant panel"; treating OpenCode as a generic assistant panel.
- Any rule assigning a runtime to a fixed panel position.
- `docs/right-hand-workspace-audit.md` and `docs/right-hand-workspace-demo.html` — old single right-panel research, historical only.
- `docs/ui-redesign/` — earlier visual redesign material; `application-shell.md` is an old rejected layout. Useful visual guidance only.
- Earlier prototype scenarios named "Development", "Two chats", "Files", "Browser" as fixed arrangements — replaced by generic content-type scenarios.

## Verified facts (from source, 2026-11-21)

- The tab store already unifies both chat types via `kind: "chat" | "agent"` with `ref` = conversation id (`chatTabs.ts:20-27`); engine comes from the conversation row, not the tab.
- Direct identity: `conversations.id` → `remoteId` → tab `ref` → `chat:<id>` → `/chat/<id>`.
- OpenCode identity: `conversations.id` (= tab `ref`, `agent:<id>`, `/code/<id>`) → bootstrap → `opencode_session_id` → scoped V2 client.
- One Direct runtime provider in AppShell bound to one active thread; OpenCode has its own isolated provider (`AuiProvider extends={null}`). Two simultaneously live Direct tabs require new isolation work and decisions on module-level shared state.
- Sidebar already shows both types with engine icons; no engine grouping today.

## Recommendations (not yet approved)

- Build the generic panel foundation before adding chat panels; prove runtime isolation with a spike first.
- Ship file tree + read-only viewer first (lowest risk); chat panels after isolation is proven.
- Defer writable editor (no editor library; needs ADR) and interactive browser (CSP/webview security).
- Saved layouts: device-wide first (localStorage, like `sidebarWidth`); per-project later.
- Keep the existing unified tab store; do not introduce a second tab-management system.

## Unresolved questions

1. Should saved layouts be global, per-project, or per-conversation? (Recommendation: device-wide first.)
2. Is a writable editor or interactive browser required in v1? (Recommendation: defer both.)
3. How should two simultaneously live Direct chat tabs be isolated? (Needs a spike; highest risk.)
4. Should Chat Threads group by runtime? (Prototype does; production is a UI change needing flow verification.)

## Documents

- `multi-chat-architecture-audit.md` — **implementation-ready plan** for multiple live Direct runtimes. Runtime ownership follows chat content (not panel position); the canonical thread-list adapter stays shared and the real cache fix is query-keyed. Also covers operation context, provider overrides and history recovery. Start here for implementation planning.
- `product-architecture.md` — concept model, permanent structure, chat types as content, context/isolation, superseded concepts.
- `technical-audit.md` — verified findings, chat identity/runtime facts, feasibility, official API links, quality gates.
- `interaction-model.md` — generic panel/tab behavior, context model, persistence, responsive, prototype demos.
- `prototype/index.html` — interactive visual prototype (open directly in a browser).
- `prototype/screenshots/` — architecture renders (`arch-*`, local-only, not committed):
  - Default: [1440×900](prototype/screenshots/arch-default-1440x900.png) · [1280×800](prototype/screenshots/arch-default-1280x800.png) · [960×800](prototype/screenshots/arch-default-960x800.png) · [light](prototype/screenshots/arch-default-light-1440x900.png)
  - Primary OpenCode: [1440×900](prototype/screenshots/arch-primary-opencode-1440x900.png) · [1280×800](prototype/screenshots/arch-primary-opencode-1280x800.png) · [960×800](prototype/screenshots/arch-primary-opencode-960x800.png)
  - Two Direct: [1440×900](prototype/screenshots/arch-two-direct-1440x900.png) · [1280×800](prototype/screenshots/arch-two-direct-1280x800.png) · [960×800](prototype/screenshots/arch-two-direct-960x800.png)
  - Two OpenCode: [1440×900](prototype/screenshots/arch-two-opencode-1440x900.png) · [1280×800](prototype/screenshots/arch-two-opencode-1280x800.png) · [960×800](prototype/screenshots/arch-two-opencode-960x800.png)
  - Mixed runtimes: [1440×900](prototype/screenshots/arch-mixed-1440x900.png) · [1280×800](prototype/screenshots/arch-mixed-1280x800.png) · [960×800](prototype/screenshots/arch-mixed-960x800.png)
  - Chat + Files: [1440×900](prototype/screenshots/arch-chat-files-1440x900.png) · [1280×800](prototype/screenshots/arch-chat-files-1280x800.png) · [960×800](prototype/screenshots/arch-chat-files-960x800.png)
  - Chat + Browser: [1440×900](prototype/screenshots/arch-chat-browser-1440x900.png) · [1280×800](prototype/screenshots/arch-chat-browser-1280x800.png) · [960×800](prototype/screenshots/arch-chat-browser-960x800.png)

## Recommended next implementation phase (not authorized)

1. Finalize workspace model and interactions (this document set).
2. Establish permanent two-region layout + generic panel foundation (reuse `useDesktopLayout`, Sidebar resize handle, dnd-kit).
3. Add layout persistence (device-local first).
4. Add secure project file browsing + read-only preview (conversation-scoped endpoint with `resolveSafe`).
5. Spike: validate two isolated Direct runtimes and two OpenCode sessions before adding chat panels.
6. Add further content types only after their technical requirements are proven.
7. Apply the broader visual redesign consistently last.

Owner must review and approve before any implementation. An ADR in `docs/decisions.md` is required for the panel layout model and any new dependency.
