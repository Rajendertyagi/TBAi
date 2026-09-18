# Dual-Chat Plan: Direct + OpenCode (assistant-ui, minimum custom code)

Owner: TBAi maintainer. Executor: external coding/testing agent (prompt packs below).
Planner role: this file is the source of truth — keep phase status current.

## Agreed decisions (locked unless user reopens)

1. **Unified CodeG-style picker** for both engines: `Chat` (no folder prompt;
   folder auto-created in background) vs `Folder chat` (pick a registered
   folder). Same picker for Direct and OpenCode.
2. **OpenCode always has a directory.** Chat mode = auto scratch
   (`workspace/chats/<conversationId>`); never folderless at the API level.
3. **Capability-driven, zero hardcode.** Agents/models/modes queried live from
   the managed OpenCode server, shown in the picker, picked once at creation,
   locked per conversation.
4. **Approvals in our style, no session rules.** OpenCode permissions +
   questions render in the shared `ApprovalCard` shell (collapse-after-decision,
   Denied-vs-Failed). No persisted "always allow". Liberality follows scope:
   folder chat = liberal, chat mode = restrictive, on the existing
   approval/grant machinery.
5. **Scope locked at creation.** Changing folder always means a new chat.
6. **History: we own only our rows** + the `opencode_session_id` binding
   (CodeG-style external binding). Never write/delete the OpenCode session store.
7. **Shared surface.** `ChatWindow` + `Composer` reused; Code mode shows an
   agent/model picker row + session status where direct mode shows the scope chip.
9. **Adapter isolation (locked 2026-09-15).** OpenCode logic lives only in
   `src/services/opencode/` (backend) and `web/src/features/opencode/`
   (frontend), behind small named functions. TBAi core files (chat route,
   workspace, `ChatWindow`, chat runtime) stay OpenCode-free; the module
   receives `conversationId` + resolved dir via existing entry points.
   Recorded in `AGENTS.md` Architecture boundaries; every prompt pack cites it.
8. **Stack constraint.** `@assistant-ui/react` (+ `react-opencode` adapter),
   AI SDK 7, Tailwind + shadcn/ui. Compose adapter contracts
   (`ToolFallback`/tool-approval path, `useOpenCodePermissions`,
   `useOpenCodeQuestions` + reply fns); no parallel permission system, no custom
   transport/projection.

## Phase status

> Engine/scope untangle (2026-09-16, maintainer directive): the product model
> is two orthogonal axes — ENGINE (Direct vs OpenCode, `conversations.engine`)
> × SCOPE (Chat without folder vs Folder chat, `workspace_mode` +
> `workspace_folder_id`). The data layer already models this cleanly; the
> prior agent conflated the axes at surface/entry layers. Rule for all phases:
> the conversation ROW is authoritative; routes are hints. Never "fix" by
> making route and row agree temporarily. Each phase is independently verified
> (test agent) before the next begins.
>
> - [x] UA-A — Entry points (IMPLEMENTED + VERIFIED 2026-09-16:
>   A1 Open-in-Code PATCHes `engine=opencode` first, navigates only on success
>   (`ChatHeader`, `updateConversation` helper in adapter); A2 engine choice in
>   folder flows — folder `+` presets draft scope and routes through the unified
>   picker (`FolderHeader`), New Project dialog has a Direct/Code switch
>   (shared `EnginePicker`, `WelcomeEnginePicker` refactored onto it) and is now
>   WIRED via a Folders-header trigger (`Sidebar` — the dialog was dead code
>   since creation); A3 folder highlight parses both `/chat/` and `/code/` via
>   `conversationIdFromPath` (`chatTabs`, `FoldersSection`); A4 dead-agent-tab
>   recovery preserves Code in the draft engine store (`useConversationTab`).
>   Follow-up fixes inside the gate: `foldersLoaded` guard stops the scope
>   picker pruning a fresh preset against an unloaded list (`foldersStore`,
>   `WelcomeScopePicker`). Proof: solo 549 pass / 0 fail (61 files); headed
>   phase-ua-a.spec.ts 4/4 (a–d); typecheck + build green. Spec notes: the `+`
>   button title is `copy.newChat` ("New Chat") — the tabstrip "New chat" tab
>   is a different element; opacity-revealed buttons are all "visible" to
>   Playwright so `+` lookups must be row-scoped.)
> - [x] UA-B — Row-authoritative views (IMPLEMENTED + VERIFIED 2026-09-16:
>   B1 `useConversationTab` reconciles surface from the fetched row engine —
>   route is a hint; on mismatch it opens the correct-kind tab FIRST (so
>   TabUrlSync converges instead of overwriting with /chat/new), closes the
>   wrong-kind tab, and replaces to the engine-correct route; nothing is
>   written. `threadEngine` helper (adapter module) is the single home for
>   row→engine reads (unknown/absent → Direct). B2 first-send binding unified
>   in `resolveDraftId` (store; Direct = key rewrite, OpenCode = draft→agent
>   swap); dead `attachRealId` removed (zero callers; `foundation.test.ts`
>   migrated). B3 lying prop names fixed: `showAgentPick`→`isWelcomeDraft`,
>   `showOpenCodePick`→`isCodeSurface` (`Composer`, `ChatWindow`).
>   Incident: chatTabs.ts lost a closing paren mid-phase (store ended `});`
>   instead of `}));` — every other store uses `}));`; restored, parse green.
>   Proof: solo 557 pass / 0 fail (62 files, incl. 8 new resolveDraftId/
>   threadEngine cases); headed 7/7 (phase-ua-a 4/4 + newchat-flow 3/3);
>   live browser proof both mismatch directions (/chat+opencode→/code with
>   session, /code+direct→/chat with history); typecheck + build green.
>   Spec note: Agent/Model/Bot icons are shared across engines, so chip-swap
>   asserts Bot count 1→2 + Agent-button presence, never icon identity.)
> - [x] UA-C — Backend engine guards (IMPLEMENTED + VERIFIED 2026-09-16:
>   C1 `/api/chat` refuses `engine=opencode` rows with 422 + `ENGINE_MISMATCH`
>   before run creation (missing/rowless sends unchanged); C2
>   `ensureOpenCodeSession` throws `EngineMismatchError` (canonical home of
>   the code; absent engine reads as Direct) before spawn/session/pointer —
>   route maps to 422 with the safe message. Proof: backend typecheck exit 0;
>   live probes both 422 (C1 names the Code surface, C2 names the actual
>   engine; refused C2 writes no pointer); solo 563 pass / 0 fail (63 files,
>   incl. 6 new hermetic cases in `tests/integration/engine-guards.test.ts`:
>   C1-422-no-run, C2-direct-throw, C2-legacy-throw, chat-admits-direct,
>   chat-admits-legacy, seam-admits-opencode via fake loopback); headed 7/7
>   (phase-ua-a 4/4 + newchat-flow 3/3; the thread-click spec self-skips on an
>   empty DB by design — proven passing with a scratch row, then cleaned up).
>   Incident: the test agent wiped the live `data/chat.db` pursuing a clean
>   headed state (all conversation/message/folder rows lost; workspace files
>   survive; frozen copies in `D:\PM\db-rescue\`; agent terminated). Standing
>   rule from this: NO test/seeding step ever touches the live `data/` dir —
>   hermetic tmp DATA_DIR only; headed specs create-then-delete their own rows.
>   Report-only: 5 Direct rows carried stale `opencodeSessionId` pointers from
>   pre-guard proofs — moot after the wipe; nothing to clean.)
> - [x] UA-D — 4-combo verification matrix (IMPLEMENTED + VERIFIED
>   2026-09-16, `web/e2e/phase-ua-d.spec.ts`, quota-free by design — one live
>   model send total, in D1):
>   D1 Direct+simple: draft live send → `/chat/<id>`, row engine=direct,
>   reload resumes, delete. D2 Direct+project: folder "+" presets the draft
>   (entry leg), API-created project row + seeded genuine-shape `ai-sdk/v6`
>   history resumes on `/chat/<id>`, exactly-one accented folder row whose
>   click re-lands the URL, reload resumes. D3 Code+simple: API-created
>   opencode row binds a session on `/code` open, reload keeps the SAME
>   pointer (resume, not recreate), terminate clears it. D4 Code+project:
>   API-created Code folder row routes `/code` with correct row fields,
>   reload keeps surface alive, terminate + delete.
>   Matrix discipline: model sends are quota-gated (Agnes 429s) and
>   tool-call-nondeterministic, proving nothing beyond D1 for binding; seeded
>   blobs + API creation cover the rest deterministically. By-design N/A:
>   sidebar highlight on `/code` routes (CodeShell is focused chrome, no
>   Sidebar); dialog entry covered by phase-ua-a (b).
>   Proof: headed 4/4 (15s); solo suite re-run 706 pass / 0 fail (708 cases,
>   75 files); typecheck + build green (spec-only phase, no source changes).

## Old phase status (dual-chat integration, pre-untangle)

- [x] P0 — Adapter truth (agent report reviewed 2026-09-15; file claims verified)
- [x] P0b — OpenCode module restructure (done 2026-09-15; planner-reviewed + ACCEPTED: zero stale refs, stubs comment-only, sessions.ts byte-identical, barrels correct)
- [ ] P1b — Single-screen composer extension (IMPLEMENTED 2026-09-15 by planner: engine pill above composer, Agent chip in composer row, scope row unchanged; typecheck + build green; pending test-agent verification)
- [x] P2 — Session creation (dir + agent/model in, 1:1 binding, idempotent resume; planner-reviewed + ACCEPTED; 2026-09-15 fix: detached `client.session.create` lost `this` → every create threw — fixed by calling on the narrowed service object; PROVEN live against a managed server: session created + resume returns same id; no tests per maintainer instruction)
- [x] P3a — OpenCode permission probe + ApprovalCard wiring (done 2026-09-15; typecheck + build green; planner-reviewed + ACCEPTED: `always` signal confirmed in adapter `types.d.ts`, no grant imports, sibling mount, security note complete)
- [x] P3b — OpenCode questions in our style (done 2026-09-15; planner-reviewed + ACCEPTED: shapes confirmed in adapter dist, sibling mount, no SDK leakage, both typechecks re-run exit 0; fix-forward: `OpenCodeQuestions` missing from `features/opencode/index.ts` barrel — folded into P4)
- [x] P4 — Code-surface session-identity row + barrel fix (done 2026-09-15; planner-reviewed + ACCEPTED: static row, conversation-record source justified, folders-store scope, sibling mount, both typechecks re-run exit 0)
- [ ] P5 — Verification matrix + history-ownership proof (E2E script issued, no tests)

> Test policy (user, 2026-09-15): this agent adds NO test files and runs NO
> test suites. A separate agent owns tests. Verification = typecheck + build +
> manual E2E script below.

## Prompt packs (hand to coding agent verbatim; report back verbatim)

### P0 — Adapter truth (read-only, no code changes)

> In D:\Temp\ai-chat-app, read-only: inspect the installed
> `@assistant-ui/react-opencode@0.2.22` package (in `web/node_modules` or
> bun lockfile-resolved path) plus our files `web/src/features/opencode/*`,
> `src/routes/opencode.ts`, `src/services/opencode/*`. Report: (1) exact
> exports available (runtime hook options incl. defaultAgent/defaultModel,
> permission/question hooks, runtime extras); (2) permission + question object
> shapes and reply values; (3) what HTTP endpoints on the OpenCode server the
> adapter calls (so we know what our `/api/opencode` proxy must forward);
> (4) how the adapter discovers agents/models (endpoint + shape, or
> client-only?). No edits. Verify with `bun run typecheck` untouched (zero
> diff expected).

Acceptance: report lists export names + endpoint paths + shapes; nothing hardcoded assumed.

### P0b — OpenCode module restructure (ISSUED 2026-09-15, behavior-preserving)

> Goal: make the OpenCode module structure clean and stable up front, so
> later phases need no avoidable renaming/rework. Move/rename ONLY; preserve
> behavior exactly (zero behavior change — `git diff` must show moves +
> import-path updates, no logic edits).
>
> Target backend layout (`src/services/opencode/`):
> `client.ts`, `sessions.ts`, `workspace.ts`, `events.ts`, `permissions.ts`,
> `index.ts`, `types.ts`, `serverManager.ts`.
> (Current disk: `serverManager.ts`, `session.ts`, `index.ts`.)
> Target frontend layout (`web/src/features/opencode/`):
> `useOpenCodeRuntime.ts`, `OpenCodeView.tsx`, `OpenCodeStatus.tsx`,
> `OpenCodePermissions.tsx`, `index.ts`.
> (Current disk: `useOpenCodeRuntime.ts`, `AgentView.tsx`, `OpenCodeStatus.tsx`,
> `OpenCodePermissions.tsx` — P3a landed; keep it, only re-export via index.)
>
> Rules:
> - Move/rename existing files into the structure above where appropriate
>   (`session.ts` → `sessions.ts`, `AgentView.tsx` → `OpenCodeView.tsx`
>   incl. the router import; `serverManager.ts`, `OpenCodePermissions.tsx` stay).
> - Do NOT duplicate existing functionality just to match filenames: if a
>   target module has no existing logic (e.g. `events.ts`, `permissions.ts`,
>   `workspace.ts`, `client.ts`, `types.ts` backend), either omit the file or
>   keep a one-line re-export/doc stub — never invent speculative APIs. Define
>   only the function surface the current implementation actually needs.
> - Keep ALL `@opencode-ai/sdk` imports inside `src/services/opencode/`.
> - Keep ALL `@assistant-ui/react-opencode` imports inside
>   `web/src/features/opencode/`.
> - Re-export through each `index.ts` so consumers have a stable import
>   boundary; update all importers to the new paths.
> - Keep `resolveConversationWorkspace()` as the shared workspace API —
>   do not wrap or fork it.
> - Do NOT modify normal TBAi chat behavior, scheduler, MCP, grants/
>   permissions, logging, or workspace logic — except import paths required
>   by the move.
> - Read and follow `AGENTS.md` Engineering standards §§1–6 + isolation
>   boundary + Output format. DO NOT add test files or run test suites
>   (separate agent owns tests per `AGENTS.md` "Agent division of labor").
>   Verify with `bun run typecheck` then `bun run build`. Report back:
>   old → new path map, files changed, typecheck/build output, confirmation
>   the diff contains no logic changes.

### P3a — OpenCode permission probe + ApprovalCard wiring (ISSUED 2026-09-15)

> In D:\Temp\ai-chat-app: (1) Read-only probe of the installed
> `@assistant-ui/react-opencode@0.2.22` package: list exact exports for
> permissions (`useOpenCodePermissions` shape, pending-request fields,
> reply values `once`/`always`/`reject`) and runtime extras
> (`useOpenCodeRuntimeExtras`: cancel/reply fns). List the HTTP endpoints the
> adapter calls for prompt/permission flows (must all pass through our
> `/api/opencode` proxy — flag any that would bypass it). (2) Then wire the
> minimal UI: in `web/src/features/opencode/` render pending OpenCode
> permission requests through the existing shared ApprovalCard shell
> (`web/src/components/shared/approval-card.tsx`, collapse-after-decision,
> Denied-vs-Failed copy). New component lives in `web/src/features/opencode/`
> (the ONLY frontend code allowed to import `@assistant-ui/react-opencode`,
> per `AGENTS.md` isolation boundary) and is mounted as a sibling panel in
> `AgentView` — never inside `ChatWindow.tsx`, never import the adapter
> elsewhere. Map: once → `reply(id, "once")`, reject →
> `reply(id, "reject")`. Render an Always action ONLY when OpenCode offers
> persist patterns for that request, calling `reply(id, "always")`; label it
> so the user knows OpenCode remembers it across chats (e.g. "Always
> (remembered by OpenCode, all chats)"). Do NOT implement any host-side
> persistence yourself. Scope liberality (folder chat liberal, chat mode
> restrictive) reuses existing approval/grant machinery — no new policy
> framework. (3) Add the security note to `docs/security.md`: OpenCode
> executes with the app's OS privileges, scoped to the conversation workspace
> dir; "Open in Code" is the explicit opt-in; in-app ApprovalCard answers
> reply straight to OpenCode (no TBAi grant involved); Always-rules, when
> offered and accepted, are remembered by OpenCode across chats, outside
> TBAi's scope policy and revocation; OpenCode is not confined by
> `resolveSafe`. Constraints: minimum custom
> code, shadcn/ui primitives + existing shared components only, no custom
> transport/projection, zero hardcoded agent/model names. Read and follow
> `AGENTS.md` Engineering standards §§1–6 (no hardcoding, modular/layered,
> named exports, explicit types, no `any`, boundary error handling, doc
> comments, git-diff self-review, Output format on completion). DO NOT add any test
> files or run any test suite (separate agent owns tests per `AGENTS.md`
> "Agent division of labor"). Verify with
> `bun run typecheck` then `bun run build`. Report back: exports + endpoint
> list, files changed, typecheck/build output.
> Out of scope: questions UI (P3b), unified picker (P1), session-create
> changes (P2), hard sandboxing (deferred).
>
> DECISION (user, 2026-09-15): option **A — reply directly to OpenCode**
> (`once` → `reply(id, "once")`, `reject` → `reply(id, "reject")`, no TBAi
> grant involved). Verified: `consumeGrant` is only consumed in
> `src/services/tools.ts:159` (TBAi's own `resolveSafe` path) — the OpenCode
> server process never consults it, so a minted grant would be a dead write.
> This matches CodeG exactly: CodeG routes the answer back as `optionId`
> (`acp_respond_permission`) and the agent enforces it, with no second
> permission layer on the host side.
>
> AMENDMENT (user, 2026-09-15): render an **Always** action too, but ONLY
> when OpenCode offers persist patterns for that request, calling
> `reply(id, "always")`. No host-side persistence. The Always action must be
> labeled so the user knows OpenCode remembers it across chats, and
> `docs/security.md` must record that Always-rules live in OpenCode's config,
> outside TBAi's scope policy and revocation. (Reopens locked decision #4
> deliberately and narrowly — one-shot default unchanged, no session rules
> on the TBAi side.)

### P5 — Manual E2E script (no automated tests)

> Human or agent with a browser, two terminals. T1: `bun run dev`
> (backend :3000). T2: `cd web && bun run dev` (Vite). Open app → open any
> chat → ⋯ → Open in Code. Expect: "Starting OpenCode…" → session id in
> `OpenCodeStatus` → surface renders. Backend log shows `opencode.spawn` +
> `opencode.session_create`. Type a message; confirm it streams and does NOT
> hit `/api/chat` (DevTools Network: traffic on `/api/opencode/...` only).
> Trigger a tool call needing permission; confirm our ApprovalCard renders
> with once/deny working. Reload `/code/<id>`; confirm tab reopens and
> session resumes (same id). Delete/archive the conversation; confirm our row
> is gone and the OpenCode session was NOT touched server-side.

### P1 — Unified new-chat picker (ISSUED 2026-09-15)

> Goal: one CodeG-style new-chat entry for BOTH engines — Engine (Direct /
> OpenCode) × Scope (Chat = no folder prompt, background folder auto-created
> / Folder = pick a registered folder) × Agent+Model (OpenCode only,
> live-queried, zero hardcoded names). Scope locked at creation; changing
> folder always means a new chat.
>
> (1) Read-only probe first (no edits): how does the managed OpenCode server
> expose available agents/models (SDK client methods / HTTP endpoints —
> reuse the P3a endpoint knowledge)? Report the exact discovery call + shape.
> (2) Then implement:
> - Capability discovery lives in the OpenCode module ONLY: backend
>   (`src/services/opencode/`, new small module + route under the existing
>   `/api/opencode` mount, Zod-validated) and frontend
>   (`web/src/features/opencode/`, query hook). No SDK/adapter imports
>   outside those dirs. Nothing hardcoded — every agent/model/mode string
>   comes from the live server.
> - Picker UI reuses existing pieces: `WelcomeScopePicker` + folders store
>   for the Folder scope; shadcn primitives for Engine and Agent+Model
>   selects. One entry point feeding both `/chat/new` and `/code/new`
>   creation flows (keep both routes working).
> - Creation: Chat scope + Direct = today's simple flow; Folder scope =
>   today's project flow (`workspaceMode` + `folderId`); OpenCode engine =
>   today's `OpenCodeView` creation flow extended with the folder choice
>   (chat scope → auto scratch dir as today; folder scope → registered
>   folder) — OpenCode ALWAYS gets a real directory. Persist the
>   engine/agent/model choice on the conversation with minimal new nullable
>   columns + validation + storage mapping ONLY if no existing field fits;
>   justify any schema addition in the report. Do NOT change the session
>   seam or runtime defaults (P2 wires agent/model through).
> - Direct-chat behavior unchanged; no chat-runtime changes.
> - Read and follow `AGENTS.md` Engineering standards §§1–6 + isolation
>   boundary + Output format. DO NOT add test files or run test suites
>   (separate agent owns tests). Verify `bun run typecheck` → `bun run build`.
>   Report: discovery call + shape, files changed, schema justification (if
>   any), typecheck/build output.
> Out of scope: session-seam agent/model passthrough (P2), questions UI
> (P3b), Code-surface picker row (P4), hard sandboxing.

### P1b — Single-screen new-chat fix (ISSUED 2026-09-15, replaces P1 dialog flow)

> Context: P1 shipped a `NewChatPicker` dialog that pre-creates the
> conversation and bypasses the `/chat/new` welcome surface. Verified against
> CodeG's source (`conversation-detail-panel.tsx`: `isWelcomeMode` single
> surface + first-send row creation), the correct design is: ALL picks on the
> existing welcome screen, conversation created at first send. Delete the
> dialog flow; extend the draft flow.
>
> (1) Extend `WelcomeScreen` (the `/chat/new` draft surface, single composer
> untouched) with an Engine select (Direct/OpenCode) + Agent/Model selects
> (OpenCode only, via the existing `useOpenCodeCapabilities` hook, hidden for
> Direct), reusing shadcn `Select` primitives and shared copy (fold
> `web/src/config/newChat.ts` strings into `welcomeConfig`, then delete that
> module). Placement follows the existing scope-picker row pattern.
> (2) Hold engine/agent/model in a draft store beside `welcomeScope` (same
> persisted pattern as `welcomeScope.ts`); extend the adapter's `initialize()`
> to pass `engine`/`opencodeAgent`/`opencodeModel` at creation alongside
> scope (it already reads `getWelcomeScopeSnapshot()` — same pattern).
> After creation, engine=opencode navigates to `/code/<id>`, direct stays
> `/chat/<id>` (find the thread-id-change navigation point; report which).
> (3) Delete `web/src/features/chat/components/NewChatPicker.tsx` and
> `web/src/features/chat/state/newChat.ts`; revert all six triggers
> (StatusBarQuickActions, PageContextMenu, ChatHeader, Sidebar, TabStrip "+",
> ChromeShortcuts Ctrl/Cmd+T) to navigate `/chat/new`. No other trigger
> behavior changes.
> Keep (still needed, do not touch): `/api/opencode/capabilities` +
> `useOpenCodeCapabilities`, the 3 persistence columns + validation + storage
> mapping, adapter `createConversation` extension (FolderHeader /
> NewProjectChatDialog explicit flows keep using it), `updateCustom` as-is
> (engine/agent/model are create-time-only, locked at creation).
> Follow `AGENTS.md` §§1–6 + isolation boundary + Output format. DO NOT add
> test files or run test suites. Verify `bun run typecheck` → `bun run build`.
> Report: files changed AND deleted, navigation point used for engine routing,
> draft-store fields, typecheck/build output.
> Out of scope: session seam (P2 done), questions (P3b done), session row
> (P4 done), hard sandboxing.

### P2 — Session seam agent/model passthrough (ISSUED 2026-09-15)

> Goal: the agent/model picked at creation actually drives the Code session.
> Read the conversation's persisted `opencodeAgent`/`opencodeModel` (P1
> columns) and apply them as the session/runtime defaults; idempotent resume
> preserved (existing `opencodeSessionId` still short-circuits).
>
> Implement inside the OpenCode module ONLY (`src/services/opencode/` +
> `web/src/features/opencode/`, same isolation rule): extend the session seam
> (`POST /api/opencode/session` + `ensureOpenCodeSession` in `sessions.ts`)
> and/or the runtime construction (`useOpenCodeRuntime` — the adapter
> supports `defaultAgent`/`defaultModel` per the P0 probe) so a Code tab
> opens with the stored agent/model. Directory keeps coming from
> `resolveConversationWorkspace` (already folder-aware via P1's
> `workspaceMode`/`folderId`) — do NOT add a directory override. If the
> OpenCode session-create API accepts agent/model natively, prefer that;
> otherwise runtime defaults. No new columns. Direct-chat behavior
> unchanged. Follow `AGENTS.md` §§1–6 + isolation boundary + Output format.
> DO NOT add test files or run test suites. Verify `bun run typecheck` →
> `bun run build`. Report: where agent/model are applied (seam vs runtime),
> files changed, typecheck/build output.
> Out of scope: questions UI (P3b), Code-surface picker row (P4).

### P3b — OpenCode questions in our style (ISSUED 2026-09-15)

> Goal: OpenCode interactive questions (mid-run prompts needing an answer,
> not approve/deny) render as our-style cards, same shell family as P3a.
> Probe the installed adapter first (no edits): `useOpenCodeQuestions`
> shape (question objects: id, text, options/answers shape) and
> `useOpenCodeRuntimeExtras` reply fns (`replyToQuestion(id, answers)`,
> `rejectQuestion(id)`) — report exact shapes.
> Then implement in `web/src/features/opencode/` ONLY (same isolation rule):
> new `OpenCodeQuestions.tsx` rendering pending questions through the shared
> ApprovalCard shell (or the closest shared card primitive; justify the
> choice in the report), with Answer/Skip actions mapping to
> `replyToQuestion`/`rejectQuestion`; answered/rejected collapse to
> `CollapsedDecisionRow`. Mount as a sibling in `OpenCodeView` next to
> `OpenCodePermissions` (never inside `ChatWindow`). No host-side
> persistence, nothing hardcoded. Follow `AGENTS.md` §§1–6 + isolation
> boundary + Output format. DO NOT add test files or run test suites.
> Verify `bun run typecheck` → `bun run build`. Report: question/answer
> shapes, files changed, typecheck/build output.
> Out of scope: Code-surface picker row (P4), hard sandboxing.

### P4 — Code-surface picker row + status (ISSUED 2026-09-15)

> Goal: the Code surface shows WHAT this session is — engine + scope +
> agent/model — in a static row where direct mode shows the scope chip
> (locked decision 7). `OpenCodeStatus` already covers live run state; this
> adds the session-identity row.
>
> Implement in `web/src/features/opencode/` ONLY (same isolation rule):
> (0) Prerequisite fix-forward: add the missing `OpenCodeQuestions`
> re-export to `web/src/features/opencode/index.ts` (P3b left the barrel
> without it).
> (1) New small `OpenCodeSessionRow.tsx` (or equivalent name you justify):
> reads the bound conversation's engine/scope/agent/model through the
> existing thread metadata (`threadListItem.custom` — P1 extended it; probe
> first, no edits, and report which fields you consume) and renders a static
> (non-editable — scope/agent/model are locked at creation; changing them
> means a new chat) row: engine badge + scope chip (folder name or chat
> mode, reuse `WelcomeScopePicker` in static mode or the folders store — do
> not invent a folder display) + agent/model names (data-driven, may be
> absent for pre-P1 sessions → render a neutral fallback, never hardcoded
> text). Mount as a sibling in `OpenCodeView` (never inside `ChatWindow`).
> shadcn primitives + shared components only. Follow `AGENTS.md` §§1–6 +
> isolation boundary + Output format. DO NOT add test files or run test
> suites. Verify `bun run typecheck` → `bun run build`. Report: metadata
> fields consumed, files changed, typecheck/build output.
> Out of scope: editing scope/agent/model post-creation, hard sandboxing.

## Verification commands (every phase touching code)

`bun run typecheck` → `bun run build` → start `:3000` → live matrix
(Direct×Chat/Folder, OpenCode×Chat/Folder) → permission + question flows in
both scopes → confirm no hardcoded agent/model names → confirm our
delete/archive leaves OpenCode sessions intact.

## Definition of DONE (locked 2026-09-15 — binds coding agent, test agent, planner)

No phase is marked complete until ALL hold:
1. Planner disk-review ACCEPTED (shapes, route order, boundary greps, no stale refs).
2. `bun run typecheck` (backend + web) exit 0 AND `bun run build` exit 0,
   independently re-run by the planner — agent-reported green is not sufficient.
3. Test-agent numbers recorded in the phase line (suite + cases, actual counts).
No commit/push until P5 passes end-to-end. A phase marked complete without
all three is not done — it is in-progress with a named owner.

> Process lesson 2026-09-15 (P1 dialog miss): planner acceptance now
> requires a user-flow walkthrough (entry → surface → creation → route) for
> every UI phase, exact-surface specification in every UI pack, and
> on-disk verification of any reference-implementation pattern before the
> pack ships. Recorded in `AGENTS.md` ("UI changes — extend surfaces, prove
> flows").

> Outstanding under this gate (2026-09-15): phases P0–P2, P0b, P3a carry
> review + typecheck/build but NO test-agent numbers yet — criterion 3 is
> owed. The test agent must backfill suite numbers for all touched areas
> before anything is committed.
>
> UPDATE 2026-09-15 — criterion 3 SATISFIED, independently re-run by planner:
> full `bun test` = **490 pass / 7 fail / 2 skip, 63 files** (25 new cases,
> 25/25 green in isolation). The 7 failures are pre-existing Playwright e2e
> import errors (`web/e2e/*.spec.ts` run under bun — unrelated to dual-chat).
> New files: `capabilities.test.ts` (7), `conversation-engine-validation`
> (7), `conversation-engine-storage` (5), `conversation-engine-routes` (6).
> Tests-only respected (no feature-file changes beyond the known P0b–P4 set).
