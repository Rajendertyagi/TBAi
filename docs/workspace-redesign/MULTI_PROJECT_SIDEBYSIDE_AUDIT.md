# READ-ONLY ARCHITECTURE AUDIT — Multi-Project Side-by-Side in TBAi

**Scope inspected:** actual local working tree at `ui-foundation-upgrade` @ `da556a9`, including all 38 uncommitted modified/untracked files (the A–G startup work). No files modified, no subagents, no plan files created during the audit.

---

## 1. Plain-English executive summary

**TBAi already supports both requirements at the data and execution level.** Project identity is not stored in the tab or panel — it is stored **on each conversation row** in SQLite (`workspace_folder_id` + `workspace_mode`). Every tool call, terminal command, and OpenCode session resolves its working directory **from that conversation's own row**, per request. Two panels with different conversation IDs therefore execute against their own projects automatically.

The architecture is essentially **Approach A** (one shared workspace, per-panel identity) and has been since before the Dockview work. The Dockview integration did not change this — it made the panels persistent and visible side by side.

**The one real gap:** there is a **single global layout** and a **single global "active project" for new drafts**. These do not break two already-open panels from different projects, but they mean the workspace is not "per-project organized" in the way Approach C imagines.

**Verdict: safe to proceed with Approach A — it already works. No architectural change is needed for the two stated requirements.** The prerequisites below are about *verification* and *one global-state caveat*, not about adding capability.

---

## 2. Evidence from actual local files

### Panel identity carries no project — but doesn't need to
- `web/src/features/workspace/dockviewParams.ts:16-20` — `PanelParams = { tabKey, contentType }`. Comment at `:11-12`: *"Params carry IDENTITY ONLY — never message text, drafts, credentials, paths or runtime instances."*
- `web/src/features/chat/state/chatTabs.ts:92-108` — `chatKey(ref)` / `agentKey(ref)`; a tab key is `chat:<conversationId>` or `agent:<conversationId>`. The conversation ID **is** the identity; project is derived from it.

### Project identity is per-conversation in the database
- `src/services/storage/conversations.ts:39` — row has `workspace_folder_id: string | null`.
- `src/db/index.ts:239,301` — `workspace_folder_id TEXT` column on `conversations`.
- `src/services/workspace.ts:399-449` — `resolveConversationWorkspace(conversationId)` loads the conversation, then its folder row, and returns that folder's path. `:451` — `mode = row.kind === "chat" ? "simple" : "project"`. `:459-478` — a missing project folder throws `WorkspaceError` rather than silently switching to another folder.

### Every Direct tool/terminal command is scoped per-request
- `src/routes/chat/assemble-run.ts:121` — `resolveConversationWorkspace(threadId)` per run; `:142` stores `workspaceDir` in run state.
- `src/routes/chat/assemble-run.ts:326-333` — `buildToolsContext({ workspaceDir, threadId, providerId, modelId })`.
- `src/tools/index.ts:436-462` — `buildToolsContext` builds a **per-request** context: `read_file`, `write_file`, `edit_file`, `run_command`, `list_dir`, `search_files`, `file_info`, `delete_file`, `todo`, `scheduler` all get that run's `workspaceDir`/`threadId`. `:443-445` — fails closed if no workspace root.
- `src/routes/tools.ts:133-144,153-167` — `/api/tools/check` and `/grant` take `conversationId` in the body and resolve the directory from it.
- `src/routes/chat/execute-direct-stream.ts:173,437` — the per-run `toolsContext` is passed to `streamText`.

### Every OpenCode session is scoped per-conversation, and the proxy enforces it
- `src/services/opencode/workspace.ts:19-35` — `resolveOpenCodeSessionDirectory(conversation)` uses `conversation.opencodeDirectory` or falls back to `resolveConversationWorkspace(conversation.id).dir`.
- `src/services/opencode/sessions.ts:879` — `sessionEnsuresInFlight` is a `Map` keyed by `conversationId` (`:869,873-875`), so concurrent bootstraps for different conversations are independent.
- `src/services/opencode/proxyAuthorization.ts:13-18` — the rule: *"session id → conversation → folder → absolute directory"*. `:114-120` refuses a request whose path session and header session disagree. `:132-143` resolves the conversation and its directory.
- `src/routes/opencode.ts:863-878` — the proxy **deletes the browser-supplied `x-opencode-directory` and `x-tbai-session` headers** (`:866-867`) and **sets the server-resolved directory** (`:872-877`). A panel cannot make another panel's tool run in the wrong project.

### Per-panel runtimes and caches — no cross-panel state
- `web/src/features/workspace/components/DirectChatHost.tsx:14-17,42` — each host owns its own runtime for its `threadId`; unmount disposes only that host.
- `web/src/features/opencode/useOpenCodeRuntime.ts:23-47` — each panel builds its own client (sessionId + directory) and controller via `useMemo`.
- `web/src/features/opencode/v2RuntimeStore.ts:138-140` — *"The cache lives in this closure rather than at module scope so two open sessions cannot evict each other's entry."*
- `web/src/features/opencode/v2ThreadController.ts:1272,1315` — event handlers filter `event.data.sessionID !== client.sessionId` and return; each controller processes only its own session's events.
- `web/src/features/opencode/v2Client.ts:205` — each client creates its own `event.subscribe(...)`.
- `web/src/features/chat/state/conversationActivity.ts:50-76` — activity store keyed by `conversationId`.
- `web/src/features/workspace/components/usePanelMountClaim.ts:18-27` — claims by `tabKey`, so two panels of the *same* conversation can't both mount a runtime (the second shows a placeholder). Different conversations are unaffected.

### Global state that exists — and its actual blast radius
- `web/src/features/chat/state/welcomeScope.ts:25-51` — **one global** welcome scope (`mode`, `folderId`), persisted to preferences. This is the "active project for new chats."
  - `web/src/features/chat/state/materializeDraft.ts:88-119` — `captureDraftSnapshot()` reads it **only when a draft is first sent**, writing `workspaceMode`/`workspaceFolderId` into the new conversation row. Once created, the conversation's project is fixed in its own row. **Changing the global scope does not change any existing panel's project.**
- `web/src/features/providers/state/providersStore.ts:30,90` — global `selectedProviderId`/`selectedModelId` (one-shot picker).
  - `web/src/runtime.ts:437-481` — a pending pick overrides the conversation default for the next send, then `s.revertChatTarget()` clears it (`:479-481`). `sendConfigs` (`:89`) is module-global but keyed by `threadKey:lastUser.id` (`:435`), so it cannot cross conversations.
- `web/src/features/chat/state/chatTabs.ts:35,45` — single `localActiveKey` and single `groupId = "main"` (`:9,180`). These are **focus/selection**, not project context. Focus changes which panel is active; it does not rewrite any panel's `workspace_folder_id`.

### Layout, hidden panels, recovery, close-vs-delete
- `web/src/features/workspace/state/layoutPersistence.ts:17-18` — **one** localStorage key `tbai:dockview-layout`, version 1. `:121-147` — `reconcileLayout` keeps only panels whose tab keys are in shared membership. This is a single workspace layout for all projects (relevant to Approach C).
- `web/src/features/workspace/components/usePanelVisibility.ts:1-8` — visibility is **visual only**; hidden `renderer:"always"` panels keep DOM, streaming, and subscriptions alive.
- `tests/e2e/workspace/dockview-workspace.spec.ts:124,145,174,199,230` — tests prove: two Direct chats as independent panels with distinct identities; a move does not close/dispose a host; composer text survives a move; an active response continues while hidden; chat→settings→chat keeps the workspace mounted.
- `web/src/components/TabStrip.tsx:237-246` and `web/src/features/chat/state/chatTabs.ts:207-239` — closing a tab calls `requestSharedClose`, which only removes shared membership. It does **not** delete the conversation or its OpenCode session.
- `web/src/features/chat/state/deleteConversation.ts:61-104,114-121` — the only path that terminates an OpenCode session is **explicit conversation deletion** from the sidebar/chat-header delete button.

---

## 3. Comparison of approaches A, B, C

| | **A — one shared workspace, per-panel identity** | **B — nested Dockview per project** | **C — one active project, per-project layouts** |
|---|---|---|---|
| Matches current code | **Yes — this is what exists** | No — would require new nested instances | No — would require per-project layout store + switching |
| Two panels, different projects | Works now: each conversation resolves its own folder (`workspace.ts:399`) | Would work, but redundant | Works only within one active project at a time |
| Two panels, same project | Works now | Works | Works |
| Tool/terminal correctness | Enforced per-request (`tools/index.ts:436`, `proxyAuthorization.ts:96`) | Also correct, but duplicates the same enforcement | Correct |
| Independent runtimes | Yes (`DirectChatHost`, `useOpenCodeRuntime`, per-controller caches) | Yes | Yes |
| Focus changing another panel's project | No — focus is selection only | No | No |
| Layout persistence | One layout (`:17`) — all projects mixed | Per-project nested layouts needed | Per-project layouts needed (new work) |
| Disruption | **None** | High — new layout engine instances, new persistence, new focus routing | Medium-high — new layout keying, project switcher, migration |
| Risk | Low | High (nested DnD/context conflicts; AGENTS.md forbids a second layout tree) | Medium |

---

## 4. Risks and likely regression areas

1. **Single global layout (real limitation for A).** `tbai:dockview-layout` is one key. If you close and reopen a project's chats, their positions are not restored per-project. This affects *organization*, not correctness.
2. **Global welcome scope.** If a user selects project X, then opens a draft panel while intending project Y, the new conversation binds to X (`materializeDraft.ts:98-111`). Existing panels are unaffected, but new-chat creation is globally scoped.
3. **One-shot model picker.** A pending global pick applies to the next send in whichever panel sends first (`runtime.ts:437-481`). It is reverted after send, so the window is small, but it is a shared slot.
4. **Duplicate-mount claim.** Two panels of the *same* conversation intentionally show a placeholder in the second (`usePanelMountClaim.ts`). This is correct behavior, not a bug, but worth knowing.
5. **OpenCode session lifecycle (observed in this session, separate from this audit).** Several existing code conversations point to sessions deleted from the shared OpenCode DB. That is a data-lifecycle issue in `src/services/opencode/sessions.ts` / orphan reconciler, **not** a multi-project isolation issue — the proxy correctly refuses those sessions.
6. **Approach B specifically** would violate `DOCKVIEW_INTEGRATION_PLAN.md:48` — *"Dockview owns spatial layout only. No second recursive layout tree … alongside it."*

---

## 5. Which approach meets both requirements with least disruption

**Approach A — and it is already implemented.** No code change is required for:
- two chats from the same project side by side, or
- chats from different projects side by side.

The per-conversation folder binding plus per-request tool context plus session-scoped proxy authorization already guarantee that each panel uses its own project directory. Approach B adds a second layout engine against an explicit project rule; Approach C adds a project switcher and per-project layout persistence that the current single-layout design does not have.

---

## 6. Tests required before implementation

Since no implementation is proposed, these are **verification tests to confirm the existing capability** (all can be added under `tests/`):

1. **E2E:** open two Direct conversations bound to two different project folders side by side; in each, run a file/terminal tool; assert each writes to its own folder and neither touches the other.
2. **E2E:** open two OpenCode conversations from different projects; assert each session's `x-opencode-directory` resolves to its own folder and a mismatched session header is refused (covers `proxyAuthorization.ts:114-120`).
3. **Unit:** `resolveConversationWorkspace` for two conversations with different `workspace_folder_id` returns two different dirs (extends `tests/unit/workspace/workspace.test.ts:38-63`).
4. **Unit:** `buildToolsContext` for two different `threadId`/`workspaceDir` pairs produces independent contexts (extends `src/tools/index.ts:436`).
5. **E2E:** focus panel B while panel A has a running stream; assert A's stream continues and A's tool calls still use A's folder (extends `dockview-workspace.spec.ts:199`).
6. **E2E:** change the global welcome scope while two project panels are open; assert neither existing panel's project changes (covers `welcomeScope.ts` blast radius).
7. **Unit:** layout persistence with panels from two projects restores both after reload (documents the single-layout behavior of Approach A).

---

## 7. Verdict

**SAFE TO PROCEED — with specific prerequisites.**

- The two stated requirements are **already met** by the current architecture (Approach A). No architectural change is needed.
- **Prerequisites before relying on it in production:**
  1. Run tests 1–3 above to *prove* cross-project isolation with real folders (the code demonstrates it, but no existing test asserts two different projects side by side).
  2. Decide whether the **single global layout** and **global welcome scope** are acceptable. If per-project layout organization is required, that is a separate, scoped change (Approach C) — not needed for the two requirements as stated.
  3. Keep the OpenCode session-lifecycle issue (deleted sessions) as a separate investigation; it does not affect multi-project isolation.

**Not recommended:** Approach B (nested Dockview) — it conflicts with the approved "one spatial layout owner" rule and adds high regression risk for no benefit over A.
