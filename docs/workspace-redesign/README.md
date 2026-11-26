# TBAi — Unified Workspace Redesign (durable handoff)

**Start with `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md` — it is the authoritative product direction and implementation roadmap.** For the implemented Dockview specification and verification record, read `DOCKVIEW_INTEGRATION_PLAN.md` and the Dockview ADR in `docs/decisions.md`. This README is a historical handoff; where it conflicts with those documents, they win.

## Current status (superseded snapshot — 2026-11-22, revision 6)

- **Historical phase:** the five confirmed multi-chat fixes from `multi-chat-architecture-audit.md` were implemented and committed. `WORKSPACE_ARCHITECTURE_PLAN.md` was **superseded by Dockview** on 2026-11-23; its custom recursive layout-tree proposal was never implemented. See `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md` for the current roadmap and `DOCKVIEW_INTEGRATION_PLAN.md` for the implemented architecture.
- **Production code:** the five fixes are committed (thread-list cache, operation ownership, Direct model/reasoning selection, history visit ownership, stable workspace panel hosts). No dependencies were added. See `docs/decisions.md` for the `features/workspace/` ownership decision. The working tree is clean at the audited HEAD apart from untracked prototype screenshots.
- **Verification (agent-reported, not re-run in the latest audit):** typecheck, build, lint, format, test-locations exit 0; unit 4999 pass / 3 skip / 0 fail, integration 1037 pass / 85 skip / 0 fail, DOM 828 pass / 0 fail. No live browser/Tauri E2E was run, and no CI results exist for this branch.
- **Prototype:** `prototype/index.html` — standalone, zero dependencies, interactive, dark + light. Rebuilt in revision 4 around generic panels + content types. Interaction test: 16/16 PASS, zero console errors.
- **Screenshots:** the `arch-*` renders were review artifacts and are NOT committed to the repository (removed in a follow-up commit). They remain on the local disk under `prototype/screenshots/` as untracked files; the links below are therefore local-only and will not resolve from a fresh clone.

## The core idea

**The workspace provides layout infrastructure. The user decides which conversations and tools appear in which panels.**

**One application. Multiple workspaces. Shared context.**

Current vocabulary (the older "Primary Chat" concept is explicitly removed):
- **Chat Threads** — conversation navigation for both Direct Chat and OpenCode sessions.
- **Chat workspace** — the area where conversation and other content panels appear. There is no privileged main position.
- **Panel** — a generic spatial container. **Tab** — a piece of content inside a panel. **Content type** — what a panel renders. **Runtime** — the independent execution system (Direct or OpenCode). **Layout** — the spatial arrangement managed by Dockview.

In production today only two content types are registered: Direct Chat and OpenCode Chat. File Tree, File Viewer, Browser, Editor and Terminal appear only in the prototype and design documents; see `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md` for their planned status. Direct Chat and OpenCode Chat are separate runtimes that may appear in any panel, side by side, or as tabs in the same panel.

## Confirmed decisions (owner-approved)

1. Chat Threads is the permanent conversation navigation; there is no "Primary Chat" position in the current product direction.
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

- `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md` — **authoritative product direction and roadmap** (start here).
- `DOCKVIEW_INTEGRATION_PLAN.md` — **authoritative implementation specification and verification record** for the Dockview workspace.
- `DOCKVIEW_POC_RESULT.md`, `DOCKVIEW_STARTUP_OPTIMIZATION_PLAN.md` — completed implementation evidence.
- `MULTI_PROJECT_SIDEBYSIDE_AUDIT.md`, `PROVIDER_AUDIT.md`, `technical-audit.md`, `multi-chat-architecture-audit.md` — supporting audits.
- `product-architecture.md`, `interaction-model.md` — product/design references (still use the superseded "Primary Chat" vocabulary; read with the roadmap's terminology).
- `WORKSPACE_ARCHITECTURE_PLAN.md`, `DOCKVIEW_EVALUATION_PLAN.md`, `2026-11-22-foundation-architecture-audit.md`, `right-hand-workspace-audit.md`, `right-hand-workspace-demo.html` — **historical / superseded**; do not treat as current requirements.
- `OPENCODE_SESSION_LOSS_INVESTIGATION.md` — **separate workstream** (OpenCode session lifecycle), not part of the workspace layout roadmap.
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

## Next implementation phase

Superseded by `WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md` §11. The Dockview foundation and layout persistence are already implemented; the current sequence starts with P0 foundation correctness, then a generic content-type contract, a project-scoped read-only File Tree, a read-only Viewer, and UX polish. Owner must review and approve each phase before implementation. An ADR in `docs/decisions.md` is required for any new dependency or architectural boundary change.
