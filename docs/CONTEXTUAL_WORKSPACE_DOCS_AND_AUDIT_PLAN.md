# TBAi Contextual Workspace — Documentation and Repository Audit Plan

**Status:** Historical task brief. Its fixed Main/Right region and two-level contextual-tab target (§2) is **superseded** by `docs/workspace-redesign/CONTEXTUAL_WORKSPACE_ARCHITECTURE.md`, which specifies a recursive workspace. Preserved as evidence of the original brief; do not treat §2 as the current target. This file does not authorize implementation.

**Repository:** `Rajendertyagi/TBAi`  
**Audited branch:** `ui-foundation-upgrade`  
**Audited remote HEAD:** `39ec6fe7603872d56483d66b79c20e4292fc6e62`  
**Audit date:** 2026-11-27

## 1. Purpose

Turn the owner's clarified workspace design into one coherent, evidence-backed architecture specification. Audit the current repository against it, identify what can be reused, identify gaps and risks, and produce a phased implementation plan.

This task is **documentation, source inspection, and verification planning only**. Do not implement the UI, add dependencies, modify tests, change application configuration, or commit/push.

## 2. Target user experience (superseded — see architecture document)

The original brief below described two symmetric working regions. That model is superseded by the recursive workspace in `docs/workspace-redesign/CONTEXTUAL_WORKSPACE_ARCHITECTURE.md`. Preserved verbatim as historical evidence.

The workspace has a fixed conversation navigator on the left and two symmetric working regions to its right. Each working region can display a different conversation and has the same content navigation in the same order.

```text
┌────────────────────┬──────────────────────────────────────┬──────────────────────────────────────┐
│ FIXED CHAT THREADS │ MAIN WORKSPACE                       │ RIGHT WORKSPACE                      │
│                    │                                      │                                      │
│ Projects/Folders   │ [Project A / Chat 1] [Chat 2]         │ [Project B / Chat 3]                  │
│ Project chats      │                                      │                                      │
│ Other chats        │ Chat | File Viewer | Browser | Files │ Chat | File Viewer | Browser | Files │
│ OpenCode sessions  │                                      │                                      │
│                    │ Content for selected conversation    │ Content for selected conversation    │
│                    │                                      │                                      │
└────────────────────┴──────────────────────────────────────┴──────────────────────────────────────┘
```

The diagram is conceptual. The right workspace may be collapsed or resized; when absent, the main workspace uses the available width. The main and right regions are not tied to a particular runtime or project. Both must support Direct Chat and OpenCode conversations.

### 2.1 Two levels of navigation

**Level 1 — conversation tabs, at the top of each workspace region**

- Each region has its own conversation tab group.
- These tabs represent conversations open in that region (for example, Project A / Chat 1 and Chat 2 in the main region, Project B / Chat 3 in the right region).
- They are not a second copy of the whole Chat Threads list. Chat Threads remains the fixed navigation and source for finding conversations.
- A conversation keeps the same canonical identity and runtime when moved between regions.

**Level 2 — contextual tabs, immediately below the conversation tabs**

Every conversation panel exposes the same four tabs, in this exact order:

1. **Chat** — the conversation transcript and composer, using the existing Direct or OpenCode runtime.
2. **File Viewer** — displays the file selected from Files. First version should be read-only unless a separate editor decision is approved.
3. **Browser** — an in-workspace browser/preview surface. Do not assume the existing headless browser tool is this UI.
4. **Files** — the file/folder tree for the selected conversation's resolved workspace. “Files” is the visible tab label; it means the file tree.

The tabs are available in both the main and right regions in precisely the same order. A tab may show a useful empty/disabled state when its context is unavailable, but the row/order should not change between regions.

### 2.2 Expected interactions

- Chat Threads stays anchored on the far left and is independent of the Dockview layout.
- Selecting a conversation from Chat Threads opens or focuses it in the current/last-focused workspace region. Provide a clear way to open a conversation in the other region.
- Dragging a conversation tab to the other Dockview group moves it there without creating a new conversation or runtime.
- Each region can contain multiple conversation tabs. The selected conversation in one region is independent of the selected conversation in the other region.
- Selecting Chat/File Viewer/Browser/Files changes the view for that conversation only. Switching conversations must not unexpectedly change the other region.
- Each conversation remembers its own selected contextual tab and relevant view state when the user switches away and returns.
- Selecting a file in Files opens it in File Viewer without replacing the conversation tab or losing the chat state.
- The Chat view must remain alive while another contextual tab is selected. Switching to Files, File Viewer, or Browser must not dispose the runtime, interrupt a stream, clear the composer, or lose scroll state.
- Closing/collapsing the right region must not silently delete conversations or their history. Closing a conversation tab and hiding a region are distinct actions.
- A conversation should have at most one live runtime host in the workspace unless a separately approved design explicitly requires mirrored views. Do not duplicate the same canonical conversation in two regions by accident.

### 2.3 Context isolation

- Contextual views bind to the conversation currently selected in their own region.
- The file root is resolved server-side from the selected conversation. Never use a global active-project variable to determine a chat's file root.
- A file identity should use stable project/folder identity plus a safe relative path; never persist an arbitrary absolute path in Dockview params or client state as authority.
- Switching conversations in the main region must not change the right region's project, file, browser, or selected contextual tab.
- Direct Chat and OpenCode remain separate runtime systems. Workspace navigation must not merge them.

## 3. Recommended technical direction to verify against source and official APIs

The preferred direction is to reuse the existing **single Dockview instance** as the spatial layout owner:

- Dockview groups represent the main and right workspace regions (and can support additional splits only if the product later requires them).
- Dockview's native group tab strip represents the conversations open in that region.
- Each existing conversation panel (`DirectPanel` or `OpenCodePanel`) renders a small contextual workspace shell with the four secondary tabs in the required order.
- The Chat view remains mounted while contextual views change. The runtime host must not be conditionally destroyed when Chat is not the visible sub-tab.
- TBAi continues to own conversation identity, project context, runtime activation, contextual-view state, and persistence policy. Dockview owns spatial groups, tab movement, split/resize mechanics, and layout serialization.

This is the target hypothesis to prove, not permission to implement. The agent must check that Dockview's group/panel APIs and the current host lifecycle can support it without a parallel splitter/layout framework.

### 3.1 Conversation-tab ownership conflict to resolve

Current `AppShell` renders a global `TabStrip` above the Dockview surface, while Dockview also renders native conversation tabs inside each group. The new design needs group-local conversation tabs so the main and right regions can have different open conversations.

The audit must decide and document one clear ownership model. Recommended direction: use Dockview's native group tab strips for region-local conversation tabs; keep Chat Threads as the fixed all-conversation navigator; remove or repurpose the global `TabStrip` only after identifying and preserving any unique behavior it currently provides (close, reorder, membership, route/focus, context menu, keyboard access). Do not leave two competing sources of conversation-tab navigation.

### 3.2 State ownership constraints

Preserve existing project rules:

- `chatTabs` and SQLite `sharedTabs` remain the canonical conversation identity/open-membership system. They must not become a second message store or a layout tree.
- Dockview's serialized layout remains identity + geometry only. Do not add transcripts, composer drafts, runtime instances, credentials, arbitrary paths, or browser session objects to `PanelParams`.
- Direct conversation/message state remains owned by assistant-ui; OpenCode state remains owned by the OpenCode V2 runtime/controller.
- Zustand is UI state only. Any contextual-tab selection persistence must have a single documented owner and must not create a parallel conversation/tab store.
- Continue to use device-local persistence conventions unless the owner approves a different scope.

## 4. Repository facts already verified at the audited HEAD

These facts were checked against the remote `ui-foundation-upgrade` branch at `39ec6fe` on 2026-11-27. The implementation agent must re-check the current branch/HEAD before relying on them.

1. `web/src/app/layout/AppShell.tsx` mounts the fixed app `Sidebar`, a global top-level `TabStrip`, and one persistent `DockviewWorkspace` in the main content area. The Dockview workspace stays mounted across route changes.
2. `web/src/components/Sidebar.tsx` is the project/folder and conversation navigator. It already displays folder/project sections and conversation rows; it is outside Dockview.
3. `web/src/components/TabStrip.tsx` renders a global chat-tab strip using `chatTabs` and dnd-kit. Dockview also renders its own native tab strips per group.
4. `web/src/features/workspace/components/DockviewWorkspace.tsx` registers exactly two Dockview components: `tbai-direct` and `tbai-opencode`.
5. `web/src/features/workspace/components/DirectPanel.tsx` and `OpenCodePanel.tsx` render their corresponding conversation hosts directly. There is no contextual sub-tab shell around the chat host yet.
6. `web/src/features/workspace/dockviewParams.ts` currently allows `{ tabKey, contentType }`, with `contentType` restricted to `direct | opencode`. Params are validated and identity-only.
7. `web/src/features/workspace/panelRegistry.ts` prevents duplicate live panel claims for one canonical conversation key.
8. `web/src/features/workspace/dockviewController.ts` owns Dockview event handling, reconciliation, moves, genuine close confirmation, panel creation and `renderer: "always"`.
9. `web/src/features/workspace/state/layoutPersistence.ts` persists a versioned device-local Dockview layout and validates/prunes it against canonical open tab keys.
10. `web/src/features/chat/state/chatTabs.ts` unifies Direct and OpenCode conversation identities (`chat:<id>` / `agent:<id>`), local active selection and shared membership. Its `groupId` is not a second split-layout implementation.
11. `web/package.json` already includes `dockview-react`, `@dnd-kit/*`, `radix-ui`, `zustand`, and the existing chat renderers. Do not add or upgrade a dependency in this task.
12. `web/src/features/workspace/WorkspacePage.tsx` is a settings/system-information page, not the visual workspace.
13. `components/shared/directory-browser.tsx` (or its current equivalent) is a folder-registration picker, not a project file explorer.
14. `src/routes/folders.ts` `/browse` lists directories for registration. It is not a conversation-scoped file-tree API.
15. `src/routes/tools.ts` exposes manual `/api/tools/*` operations against the global `WORKSPACE_DIR`. Do not reuse those endpoints as the authority for project file browsing.
16. `src/services/workspace.ts#resolveConversationWorkspace` resolves a conversation's registered project or private chat workspace. A future file API must pair this with safe path containment (`resolveSafe` / related helpers in `src/services/tools.ts`) and an explicit threat-model note; path containment is not caller authentication.
17. `src/services/browser.ts` drives the `agent-browser` CLI/daemon for tool execution. It is not an embedded browser component/panel.
18. The existing E2E workspace suite verifies real Dockview conversation panels, drag/move, split, runtime/composer preservation, hidden-panel execution, and layout restoration. Existing DOM split/group tests verify the persistence contract; do not overstate them as pointer-driven Dockview tests.
19. The current production workspace has no registered File Tree, File Viewer, Editor, Terminal, or embedded Browser content panel.

## 5. Required source and document audit

Read the repository instructions and the current branch source before writing conclusions.

### 5.1 Mandatory governance documents

- `AGENTS.md`
- `docs/PROJECT_MANAGER_PROTOCOL.md`
- `docs/workspace-redesign/README.md`
- `docs/workspace-redesign/WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md` (the current authoritative product/roadmap document)
- `docs/workspace-redesign/DOCKVIEW_INTEGRATION_PLAN.md`
- `docs/workspace-redesign/DOCKVIEW_POC_RESULT.md`
- `docs/workspace-redesign/MULTI_PROJECT_SIDEBYSIDE_AUDIT.md`
- `docs/workspace-redesign/PROVIDER_AUDIT.md`
- `docs/workspace-redesign/technical-audit.md`
- `docs/decisions.md` (Dockview ADR and any tab/runtime/state decisions)
- `docs/state-management.md`

Treat `product-architecture.md`, `interaction-model.md`, `WORKSPACE_ARCHITECTURE_PLAN.md`, `DOCKVIEW_EVALUATION_PLAN.md`, `right-hand-workspace-audit.md`, and `right-hand-workspace-demo.html` according to the status stated in the current README/roadmap. Do not silently promote historical/superseded documents to current requirements. Preserve historical evidence and explain conflicts explicitly.

### 5.2 Mandatory production source areas

Inspect actual current source and relevant consumers/callers, not just comments:

- Shell and navigation: `web/src/app/layout/AppShell.tsx`, `web/src/components/Sidebar.tsx`, `web/src/components/TabStrip.tsx`, `web/src/components/ActivityBar.tsx`, `web/src/features/sidebar/`, `web/src/features/folders/`.
- Dockview: `web/src/features/workspace/components/DockviewWorkspace.tsx`, `DirectPanel.tsx`, `OpenCodePanel.tsx`, `DirectChatHost.tsx`, `DraftChatHost.tsx`, `usePanelVisibility.ts`, `usePanelMountClaim.ts`, `dockviewController.ts`, `dockviewParams.ts`, `panelRegistry.ts`, `state/layoutPersistence.ts`, `state/workspaceActivation.ts`, `routeFocus.ts`, `state/useWorkspaceFocusSync.ts`.
- Conversation identity/preferences: `web/src/features/chat/state/chatTabs.ts`, preferences store/API/types, folder and conversation APIs.
- Runtime and context: `web/src/runtime.ts`, the OpenCode public host/isolation boundary, conversation workspace resolution, Direct tool context.
- Files/security/browser: `src/routes/folders.ts`, `src/routes/tools.ts`, `src/services/workspace.ts`, relevant safe-path helpers in `src/services/tools.ts`, `src/services/browser.ts`, browser tool UI, and any existing file preview/rendering components.
- Persistence/layout preferences: `web/src/features/desktop/state/desktopLayout.ts`, layout persistence, and state-management documentation.
- Dependencies: `web/package.json`, lockfile, existing Radix UI wrappers and installed package APIs.

### 5.3 Mandatory tests

Inspect relevant unit, DOM, integration and E2E coverage, especially:

- `tests/unit/web/workspace/`
- `tests/dom/workspace/`
- `tests/e2e/workspace/dockview-workspace.spec.ts`
- `tests/unit/web/chat/chatTabs*`
- Direct/OpenCode runtime isolation tests
- folder/workspace path-containment integration tests

For each claim, state whether it is source-verified, covered by a test, behavior-verified in a real browser, agent-reported, or still unverified. Do not infer a test passed from its existence.

## 6. Questions the audit must answer

1. Can one existing Dockview instance represent the main and right regions as independently tabbed groups, with each group's tabs representing different conversations?
2. Can the existing `DirectPanel` and `OpenCodePanel` host wrappers safely contain the secondary four-tab navigation without unmounting or interrupting their runtime hosts?
3. How should the secondary tab's selected state be keyed and persisted so it belongs to one conversation and does not leak between projects or between the main/right regions?
4. What is the correct way to open a thread into the main region versus the right region from Chat Threads? What happens when the same conversation is already open elsewhere?
5. What are the exact current responsibilities of the global `TabStrip` versus Dockview's group tab strips? What should be retained, moved, or retired to prevent duplicate conversation-tab systems?
6. How should closing a conversation tab differ from collapsing/closing the right region? Ensure region operations do not accidentally remove shared conversation membership or delete history.
7. How are project and private-chat file roots resolved per conversation? Which existing helpers are safe to reuse, and which endpoints are explicitly not suitable?
8. What is meant by the Browser tab technically? Distinguish an embedded interactive browser from the existing `agent-browser` tool. Document feasible options, security constraints and unresolved decisions; do not select/install a library in this task.
9. Which existing UI primitives/packages can support secondary tabs, file tree, viewer and resizing? Prove compatibility from current dependencies. No new package recommendation without a demonstrated gap and a future ADR.
10. What must happen on cold restart, corrupt layout, stale/deleted conversations, unavailable projects, hidden panels, concurrent Direct/OpenCode work, narrow windows and multiple application windows?
11. What parts of the previous generic-panel design remain valid, and what must be revised to express the new two-level navigation model?

## 7. Required documentation deliverables

Create these new files under `docs/workspace-redesign/`:

### A. `CONTEXTUAL_WORKSPACE_ARCHITECTURE.md`

The canonical user-facing and technical architecture specification. Include:

- The target layout diagram and terminology.
- The two navigation levels and the exact contextual tab order.
- Main/right region behavior and symmetry.
- Conversation opening, movement, selection, closing and recovery interactions.
- Context binding and project isolation rules.
- Runtime preservation requirements when secondary tabs change.
- State ownership and persistence boundaries.
- A component/ownership map (Chat Threads, Dockview groups, conversation hosts, contextual views, file service, browser surface).
- Clear distinction between existing behavior, target behavior, recommendations and decisions still requiring owner approval.

### B. `CONTEXTUAL_WORKSPACE_REPOSITORY_AUDIT.md`

An evidence-based current-state audit. Include:

- Branch and HEAD inspected.
- Actual source paths and line numbers for important claims.
- Current shell/TabStrip/Dockview structure.
- Current Dockview registrations, params, registry, controller and persistence behavior.
- Existing runtime/provider isolation and hidden-panel guarantees.
- Existing project/file/browser capabilities and security boundaries.
- Test inventory and what each test does/does not prove.
- A current-vs-target gap matrix with severity, impact, and evidence.
- Explicit conflicts or stale statements in older docs.

### C. `CONTEXTUAL_WORKSPACE_IMPLEMENTATION_PLAN.md`

A phased, implementation-ready plan, but **not implementation authorization**. It must include:

- Prerequisites and owner decisions.
- Architecture decisions that must be frozen before code changes.
- Small phases with goals, in/out of scope, likely modules, dependencies, tests, acceptance criteria, risks and rollback.
- A traceability table mapping each target behavior to a future test.
- Separate treatment of: conversation-tab ownership, contextual-tab shell, runtime preservation, conversation-to-region placement, Files tree/API, read-only File Viewer, Browser feasibility, persistence, responsive/accessibility and performance.
- No speculative general-purpose framework, no second layout engine, no merged runtime, and no dependency churn.

Also make minimal, accurate cross-reference updates to:

- `docs/workspace-redesign/README.md`
- `docs/workspace-redesign/WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md`

The README must clearly identify the new architecture document as the current owner-directed target and explain which older documents are historical/supporting. Update the roadmap only where needed to align terminology, phase sequencing and links. Do not rewrite historical evidence or erase useful prior audit records.

## 8. Required acceptance criteria for the target design

The future implementation plan must contain testable criteria for all of the following:

| ID | Required behavior |
|---|---|
| CW-01 | Chat Threads remains the fixed left-side conversation navigator, independent of Dockview group layout. |
| CW-02 | Main and right workspace regions can show different conversations simultaneously. |
| CW-03 | Each region has its own conversation tab strip; selecting a tab in one region does not change the selected conversation in the other. |
| CW-04 | Each conversation panel shows `Chat`, `File Viewer`, `Browser`, `Files` in exactly that order. |
| CW-05 | The same contextual navigation and behavior exists in both regions. |
| CW-06 | Each conversation remembers its own selected contextual tab and relevant view state. |
| CW-07 | Files and File Viewer always use the current conversation's server-resolved workspace, never a global active-project path. |
| CW-08 | Selecting a file opens it in File Viewer without replacing the conversation tab. |
| CW-09 | Switching away from Chat does not unmount/dispose its runtime, interrupt a stream, clear composer text, or lose scroll state. |
| CW-10 | Moving a conversation between Dockview groups preserves canonical identity, runtime instance and conversation state. |
| CW-11 | Closing/collapsing a region is distinct from closing a conversation; region operations do not delete history. |
| CW-12 | There is one unambiguous owner for conversation tabs; no duplicate global/per-group navigation that creates conflicting state. |
| CW-13 | Direct and OpenCode runtimes remain isolated and can coexist side by side. |
| CW-14 | Layout and contextual-view state restore safely after restart; stale/deleted conversations and unavailable project folders fail safely. |
| CW-15 | Browser is documented as a distinct embedded-panel requirement; the existing headless browser tool is not misrepresented as the panel. |
| CW-16 | Keyboard, focus, screen-reader, minimum-size, narrow-window, and performance behavior are included in the plan. |

## 9. Constraints and stop conditions

- **No production code edits.** No app source, tests, package manifests, lockfiles, database schemas, or runtime configuration changes.
- **No dependency installation, upgrade, downgrade or removal.** Record any package question for later approval only.
- **No UI prototype or screenshot rewrite** in this task. Preserve `docs/workspace-redesign/prototype/screenshots/` and all pre-existing user work.
- Do not create another layout engine, splitter tree, DnD system, chat runtime, message store, or conversation-tab store.
- Do not merge Direct and OpenCode runtimes.
- Do not treat folder-picker APIs or global `/api/tools/*` endpoints as a safe project file explorer.
- Do not claim embedded-browser support merely because the headless `agent-browser` tool exists.
- Do not commit, push, merge, delete, clean, reset, stash, or overwrite unrelated work.
- If a source claim cannot be verified, mark it unverified. If the target design requires an owner decision not specified here, isolate it as a decision; do not silently invent product behavior.
- Stop after the documentation and audit are complete. Present a concise report and wait for explicit approval before any implementation task.

## 10. Final report required from the agent

Report:

1. Exact branch and HEAD inspected.
2. New/updated documentation files.
3. Most important current-vs-target findings.
4. Whether the recommended one-Dockview/two-region/two-level-tab model is supported by current architecture and official Dockview APIs.
5. Any blocking architectural risks or owner decisions.
6. Acceptance-criteria coverage and test recommendations.
7. Confirmation that no production source, tests, dependencies, lockfiles, configuration, screenshots, or unrelated user work was changed.
8. Confirmation that no commit or push was performed.

**Completion means the documentation is internally consistent and evidence-backed. It does not mean the workspace feature has been implemented.**
