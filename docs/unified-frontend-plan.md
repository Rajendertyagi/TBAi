# Unified Chat Frontend — audit + plan

Status: **audit complete, plan only. No application code changed.**
Written 2026-09-19 from direct source inspection (imports traced, not filenames).

---

## 1. Current Direct frontend architecture

| Concern | Where it lives |
|---|---|
| Route | `/chat/:threadId?` → `ChatView` (inside `ChatShell` router branch) |
| Shell | `ChatShell` → `AssistantRuntimeProvider` (Direct runtime) → `AppShell` (sidebar, tabs, status bar) |
| Page | `ChatView` → `ChatHeader` + `ChatWindow` |
| Runtime | `useAppChatRuntime` (`web/src/runtime.ts`) → `useRemoteThreadListRuntime` + `ResumableThreadRuntime` (`useChatRuntime` + `AssistantChatTransport` → `POST /api/chat`) |
| Composer | `Composer` (shared) with Direct chips: `ThinkingChip` + `ModelChip` |
| Message list | `ChatWindow` → `ThreadPrimitive.Messages` → `UserMessage` / `AssistantMessage` |
| Message renderer | `AssistantMessage` → `MessagePrimitive.GroupedParts` → reasoning / tool groups / text (`MarkdownText`) / tool-call (`part.toolUI ?? ToolFallback`) |
| Markdown | `MarkdownText` (shared element) |
| Attachments | `AttachDropdown` (stub — not wired) |
| Loading | `ThreadBootSkeleton` (history loading) |
| Errors | `AssistantError` / `AssistantErrorMessage` (transport-classified) |
| Conversation switching | `ChatShell.handleThreadIdChange` → `useChatTabsStore` |
| Tabs | `useChatTabsStore` (unified chat/page/agent model) |
| State ownership | assistant-ui runtime (threads/messages/streaming); Zustand (tabs, settings, welcome draft); SQLite (persistence via adapter) |
| Model controls | `ModelChip` (Direct provider/model picker) |
| Thinking controls | `ThinkingChip` (Direct) |
| Provider UI | `useSettingsStore` providers + `ModelOptionList` |

## 2. Current OpenCode frontend architecture

| Concern | Where it lives |
|---|---|
| Route | `/code/:agentId?` → `CodeShell` (separate router branch, OUTSIDE `ChatShell`) |
| Shell | `CodeShell` → focused chrome (`ActivityBar`, `CodeHeader`, `WindowControls`, `PageContextMenu`, `ChromeShortcuts`, `TabUrlSync`) → `OpenCodeView` |
| Page | `OpenCodeView` → session init → `AgentRuntime` → `OpenCodeRuntimeContext.Provider` → `AssistantRuntimeProvider` (OpenCode runtime) → `OpenCodeSessionRow` + `OpenCodePermissions` + `OpenCodeQuestions` + `OpenCodeTodoTracker` + `ChatWindow mode="agent"` |
| Runtime | `useOpenCodeRuntime` → `useOpenCodeRuntimeBase` (`@assistant-ui/react-opencode`) + `createOpenCodeRuntimeClient` (compat patches: event scope, permission/question scope, hydration, V2 payload, todo) |
| Composer | `Composer` (shared) with OpenCode chips: `OpenCodeAgentChip` + `OpenCodeModelChip` + `OpenCodeThinkingChip` + `OpenCodeShieldChip` |
| Message list | `ChatWindow` (shared) — same `UserMessage` / `AssistantMessage` |
| Message renderer | same `AssistantMessage` — tool-call parts resolve to `openCodeToolkit` renderers |
| Markdown | `MarkdownText` (shared) |
| Loading | session init states ("Starting OpenCode…", error + retry) |
| Errors | session init error + retry; `OpenCodeStatus` heart (error/off/working/idle) |
| Conversation switching | `useConversationTab(agentId, "agent")` → `useChatTabsStore` |
| Tabs | same `useChatTabsStore` (agent tabs) |
| State ownership | OpenCode runtime (session/thread); Zustand (tabs, welcome draft, `sessionAutoPolicy` cache); SQLite (conversation config) |
| Agent UI | `OpenCodeAgentChip` |
| Model UI | `OpenCodeModelChip` |
| Thinking UI | `OpenCodeThinkingChip` |
| Shield | `OpenCodeShieldChip` |
| Permissions | `OpenCodePermissions` + `PermissionCard` (shared `ApprovalCard` shell) |
| Questions | `OpenCodeQuestions` + `QuestionFormCard` (shared) |
| Tool rendering | `openCodeToolkit` (read/glob/grep/bash/edit/write/task/todowrite/webfetch/websearch/skill/question) |
| Terminal | `OpenCodeBashToolUI` (shared `TerminalBlock`) |
| Diffs | `OpenCodeEditToolUI` (shared `CodeDiff`) |
| Session controls | `OpenCodeStatus`, `OpenCodeSessionRow`, `OpenCodeTodoTracker` |

## 3. Component classification

### A. ALREADY SHARED
- `ChatWindow` — the entire message surface (viewport, messages, scroll-to-bottom, composer placement, welcome/boot states). OpenCode uses `<ChatWindow mode="agent">`.
- `Composer` — the composer box (textarea, attach, voice, send/stop). Only the chip row branches by engine.
- `UserMessage` / `AssistantMessage` — inside `ChatWindow`, shared.
- `MarkdownText`, `Reasoning`, `ToolGroup`, `ToolFallback`, `CodeDiff`, `TerminalBlock`, `TodoList`, `WebSearch`, `ApprovalCard` — shared assistant-ui elements.
- `WelcomeScopePicker` — shared (editable draft / static bound).
- `EnginePicker` — shared (welcome draft + `NewProjectChatDialog`).
- `WelcomeScreen` / `WelcomeHero` / `QuickActions` — shared (draft only, chat mode).
- `useConversationTab` — shared hook (both `ChatView` and `OpenCodeView`).
- `useChatTabsStore` + `threadUrl` + `conversationIdFromPath` — shared tab/routing model.
- `ActivityBar`, `WindowControls`, `PageContextMenu`, `ChromeShortcuts`, `TabUrlSync` — shared chrome (CodeShell reuses them).
- `appToolkit` — combined native + OpenCode renderer registry, registered in BOTH shells.
- `QuestionFormCard` — shared (OpenCodeQuestions + tool-linked questions).

### B. SAFE TO SHARE
- The message surface is already shared. No additional "safe to share" component was found that is not already shared.

### C. SHOULD BE SHARED WITH CAPABILITY CONDITION
- **Composer chip row** — already branches by engine (`isCodeSurface || showOpenCodeDraft`). This is a de-facto capability switch. Could be formalized into a small capability slot, but the current branch is small and localized.
- **Header chrome** (`ChatHeader` vs `CodeHeader`) — both are "headers" but with different contracts (see F). A shared surface header with capability slots is possible but low value.

### D. MUST REMAIN OPENCODE-SPECIFIC
- `OpenCodeShieldChip` (Shield)
- `OpenCodePermissions` (permission UI)
- `OpenCodeQuestions` (question UI)
- `OpenCodeBashToolUI` / `OpenCodeEditToolUI` / all `OpenCode*ToolUI` (OpenCode tool renderers)
- `OpenCodeSessionRow` (session identity)
- `OpenCodeStatus` (session heart)
- `OpenCodeTodoTracker` (todo projection)
- `OpenCodeAgentChip` (agent control)
- `OpenCodeModelChip` / `OpenCodeThinkingChip` (OpenCode model/thinking — different data source than Direct)
- `OpenCodeView` (session init + runtime composition)
- `useOpenCodeRuntime` / `runtimeClient` / `eventScope` / `opencodeScope` / `permissionCompat` / `permissionPayloadCompat` / `initialHydration` / `questionCompat` / `todoState` / `sessionAutoPolicy` / `autoApproveWrite` (runtime + Shield)

### E. MUST REMAIN DIRECT-SPECIFIC
- `ModelChip` (Direct provider/model picker)
- `ThinkingChip` (Direct thinking)
- `runtime.ts` (Direct runtime wiring)
- `ChatHeader` (conversation breadcrumb + actions incl. "Open in Code")

### F. DUPLICATED BUT NOT SAFE TO MERGE YET
- `ChatHeader` vs `CodeHeader` — both "headers", different contracts (breadcrumb+actions vs back+label). Not identical; merging requires a capability model.
- `ModelChip` (Direct) vs `OpenCodeModelChip` — both "model pickers", different data sources (Direct providers vs OpenCode capabilities). Not safe to merge.
- `ThinkingChip` (Direct) vs `OpenCodeThinkingChip` — same.

### G. RUNTIME/STATE COUPLED — DO NOT TOUCH INITIALLY
- `ChatShell` / `CodeShell` — the two shells MUST NOT nest (the OpenCode adapter's `useRemoteThreadListRuntime` degrades to a no-op under another `RemoteThreadListRuntime`). Hard architectural constraint.
- `runtime.ts` (Direct runtime)
- `useOpenCodeRuntime` (OpenCode runtime)
- `OpenCodeView` (session lifecycle)
- `chatTabs.ts` (tab model — already unified)
- `welcomeEngine.ts` / `welcomeScope.ts` (draft state)
- `settingsStore` (provider/model state)

## 4. Actual duplicated UI

**The headline finding: there is NO duplicated chat application.** The message surface (`ChatWindow`), the composer (`Composer`), the markdown rendering, the tool-rendering infrastructure (`appToolkit`), the tab model, and the routing helpers are all already shared.

The only "duplication" is at the shell/header/control level, and it is structural, not accidental:

| Pair | Responsibility | Degree | Behavior identical? | Runtime deps | Safe to extract? |
|---|---|---|---|---|---|
| `ChatShell` vs `CodeShell` | app shell | low (different chrome) | no | Direct vs OpenCode runtime | **No** — must not nest |
| `ChatHeader` vs `CodeHeader` | surface header | low | no | `useAui` vs none | No (different contract) |
| `ModelChip` vs `OpenCodeModelChip` | model picker | low | no | settings store vs capabilities API | No (different data source) |
| `ThinkingChip` vs `OpenCodeThinkingChip` | thinking picker | low | no | settings store vs capabilities API | No |

## 5. Safe sharing candidates

None beyond what is already shared. The presentation layer is already unified; the remaining differences are runtime/contract-driven and should stay separate.

## 6. OpenCode-only components

See §3-D. These must remain OpenCode-specific: Shield, permissions, questions, OpenCode tool renderers, session controls, agent/model/thinking chips, and the entire OpenCode runtime/compat layer.

## 7. Direct-only components

See §3-E: `ModelChip`, `ThinkingChip`, `runtime.ts`, `ChatHeader`.

## 8. Runtime boundaries

```
Direct:
  UI (ChatWindow/Composer)
    ↓
  useAppChatRuntime (runtime.ts) → useRemoteThreadListRuntime + useChatRuntime
    ↓
  AssistantChatTransport → POST /api/chat (AI SDK streamText server-side)
    ↓
  assistant-ui runtime state (threads/messages)

OpenCode:
  UI (ChatWindow mode="agent" + OpenCode panels)
    ↓
  useOpenCodeRuntime → useOpenCodeRuntimeBase (@assistant-ui/react-opencode)
    ↓
  createOpenCodeRuntimeClient (compat patches) → /api/opencode proxy → OpenCode server
    ↓
  OpenCode session state (session/thread/permissions/questions)
```

**The boundary is `ChatWindow`.** It is the shared presentation that reads from whichever assistant-ui runtime the shell provides. Runtime-specific logic lives in the shells (`ChatShell`/`CodeShell`) and the runtime hooks. No new abstraction is needed — the existing `mode="chat" | "agent"` prop on `ChatWindow` is the stable interface.

## 9. State ownership map

| State | Owner | Shared? |
|---|---|---|
| Threads / messages / streaming / composer input / tool state | assistant-ui runtime (Direct or OpenCode) | per-runtime |
| Open/active tabs (chat + agent + page) | `useChatTabsStore` (Zustand) | **shared** |
| Draft engine/agent/model/variant/autoApprove | `useWelcomeEngineStore` (Zustand) | **shared** |
| Draft scope (folder) | `useWelcomeScopeStore` (Zustand) | **shared** |
| Providers / model selection / one-shot picks | `useSettingsStore` (Zustand) | Direct-specific |
| OpenCode Shield runtime cache | `sessionAutoPolicy` (module Map) | OpenCode-specific |
| Conversation config (engine/model/agent/autoApprove) | SQLite (authoritative) | **shared** |
| OpenCode session id / directory / permissions / questions | OpenCode runtime | OpenCode-specific |
| MCP / folders / scheduler / quick-messages | respective Zustand stores | **shared** |

No duplicated or conflicting state found. The tab model is unified; message state is owned by the respective runtime; conversation config is the single authoritative source.

## 10. Capability-model assessment

The Composer already branches by engine (`isCodeSurface || showOpenCodeDraft`): Direct shows Model+Thinking, OpenCode shows Agent+Model+Thinking+Shield. This is a de-facto capability switch.

**Verdict: a formal capability model is NOT justified now.** The branching is small, localized, and driven by a single `mode` prop. Introducing a capability descriptor (a `capabilities` object with `model/thinking/agent/tools/permissions/questions/terminal/diff/shield` flags) would add indirection without removing real duplication — the two engines genuinely have different data sources and runtime contracts, not just different feature flags. If a third engine or many more engine-specific controls appear, revisit; until then the `mode` prop is the pragmatic capability switch.

## 11. Routing assessment

`/chat` and `/code` are genuinely separate routes with separate shells. `/code` is **not** "the same frontend with an OpenCode-specific shell" — it is a genuinely separate shell (`CodeShell`) because the OpenCode adapter's `useRemoteThreadListRuntime` degrades to a no-op when nested under another `RemoteThreadListRuntime`. This is a hard runtime constraint, not a presentation choice.

However, **both routes project into the same `ChatWindow`** — the unified ChatSurface already exists. The routing difference is only about which shell + runtime wraps it.

**Future direction:** `/code` could conceptually become "same ChatSurface with OpenCode selected", but the shell split must remain (the runtime nesting constraint). Recommendation: keep the two shells; recognize `ChatWindow` as the unified ChatSurface. Do not merge the shells.

## 12. Proposed target architecture

The repository **already has** the target architecture:

```
ChatWindow (unified ChatSurface)
 ├── ThreadPrimitive (message list + renderer)
 ├── Composer (shared, engine-branched chips)
 └── mode="chat" | "agent"
       ├── Direct runtime (ChatShell)
       └── OpenCode runtime (CodeShell + OpenCodeView)
```

Satisfies all target requirements:
1. One visual chat experience — `ChatWindow` + `Composer` are shared.
2. Direct and OpenCode runtimes independent — separate shells, separate runtime hooks.
3. OpenCode-only features do not leak into Direct — OpenCode panels/chips only mount under the OpenCode runtime.
4. Shared components are not giant engine-conditional components — `ChatWindow` branches only on `mode`; `Composer` branches only on the chip row.
5. Runtime-specific behavior stays close to its runtime — in the shells and runtime hooks.
6. Conversation identity authoritative — `useConversationTab` + `chatTabs` + SQLite engine column.
7. assistant-ui is the chat runtime/UI foundation — both engines use it.
8. No duplicate chat implementations — the message surface is shared.

## 13. Incremental migration phases

The audit shows the presentation is **already unified**. The realistic remaining work is small and optional:

### Phase A — Document the shared surface (no code)
Record that `ChatWindow` is the unified ChatSurface and the shells are runtime-bound. Update `docs/architecture.md` if needed. Independently verifiable: no behavior change.

### Phase B — Formalize the composer capability slot (optional, low risk)
Extract the engine chip branch in `Composer` into a small `ComposerCapabilities` descriptor (`{ showAgent, showShield, modelSource }`) so future engine-specific controls slot in without growing the `if` chain. Files: `Composer.tsx`, `OpenCodeChipShared.tsx`. Tests: existing composer/welcome tests stay green; add a source guard that the chip row is capability-driven.

### Phase C — Shared surface header with capability slots (optional, low value)
Unify `ChatHeader`/`CodeHeader` behind a common header that takes capability slots (breadcrumb+actions for Direct, back+label for OpenCode). **Low value** — the two headers have genuinely different contracts and the OpenCode header must stay runtime-free (it renders above the OpenCode provider boundary). Recommend deferring unless a third surface appears.

### Phase D — /code as an explicit OpenCode projection of ChatSurface (documentation only)
No code change. `/code` already renders `ChatWindow`. Document that the route is an OpenCode projection of the shared surface, keeping the shell split.

## 14. Files likely to change in each phase

- Phase A: `docs/architecture.md` (documentation only).
- Phase B: `web/src/components/Composer.tsx`, `web/src/features/opencode/OpenCodeChipShared.tsx` (+ a source-guard test).
- Phase C: `web/src/features/chat/components/ChatHeader.tsx`, `web/src/features/opencode/CodeHeader.tsx` (deferred).
- Phase D: documentation only.

## 15. Files that should remain untouched initially

- `web/src/runtime.ts` (Direct runtime)
- `web/src/features/opencode/useOpenCodeRuntime.ts`, `runtimeClient.ts`, `eventScope.ts`, `opencodeScope.ts`, `permissionCompat.ts`, `permissionPayloadCompat.ts`, `initialHydration.ts`, `questionCompat.ts`, `todoState.ts`, `sessionAutoPolicy.ts`, `autoApproveWrite.ts` (OpenCode runtime + Shield)
- `web/src/features/opencode/OpenCodeView.tsx` (session lifecycle)
- `web/src/app/layout/ChatShell.tsx`, `web/src/features/opencode/CodeShell.tsx` (shells — must not nest)
- `web/src/features/chat/state/chatTabs.ts`, `welcomeEngine.ts`, `welcomeScope.ts` (state)
- `web/src/adapters/remoteThreadListAdapter.tsx` (persistence)
- `web/src/app/router.tsx` (routing)
- `web/e2e/**` (E2E infrastructure)

## 16. Test strategy

- Phase A: no tests (documentation).
- Phase B: existing `welcomeEngine.test.ts`, `remoteThreadListAdapter.test.ts`, `openCodeShield.test.ts` stay green; add a source guard that the composer chip row is capability-driven. Run `bun run verify`.
- Phase C (if done): existing header tests stay green; browser verification of both surfaces.
- Phase D: no tests.

## 17. Browser verification strategy

- Phase B: manual browser check that Direct shows Model+Thinking and OpenCode shows Agent+Model+Thinking+Shield, both before and after the refactor.
- Phase C (if done): browser check of both headers.
- Use the existing `web/e2e` Playwright infrastructure for any behavioral change.

## 18. Risks

- **High risk: merging the shells.** `ChatShell` and `CodeShell` must never nest (OpenCode adapter degrades to a no-op under another `RemoteThreadListRuntime`). Any attempt to unify the shells would break the OpenCode runtime. This is the single highest-risk area and is explicitly out of scope.
- **Moderate risk: capability-model over-engineering.** Introducing a formal capability descriptor before it is needed adds indirection without removing real duplication. The two engines have different data sources and runtime contracts, not just different feature flags.
- **Low risk: composer chip refactor (Phase B).** The branch is small and localized; a source guard + browser check covers it.
- **Low risk: header unification (Phase C).** The OpenCode header must stay runtime-free (renders above the provider boundary); forcing a shared contract could leak runtime assumptions.
- **Low risk: state.** No duplicated or conflicting state found; the tab model is already unified.

## 19. Explicit non-goals

- Do NOT merge `ChatShell` and `CodeShell`.
- Do NOT add OpenCode features to Direct Chat.
- Do NOT add a formal capability framework/abstraction now.
- Do NOT create a universal `ChatManager` or a single interface containing every engine-specific operation.
- Do NOT change the runtimes, Shield, permissions, questions, routing, or persistence.
- Do NOT rewrite the frontend.

## 20. Recommended FIRST implementation phase

**Phase A — document the shared surface (no code).** The audit's core finding is that the presentation is already unified (`ChatWindow` + `Composer` shared; shells runtime-bound). The first implementation step is to record this in `docs/architecture.md` so future work starts from the correct model: one ChatSurface, two runtime-bound shells, engine-specific controls isolated. This is zero-risk, independently verifiable, and commit-able.

If a code change is required immediately, **Phase B** (formalize the composer capability slot) is the smallest safe code change: it touches only the composer chip branch, keeps all existing tests green, and is covered by a source guard + browser check.

---

## Appendix — evidence notes

- `ChatWindow` is imported by both `ChatView` (Direct) and `OpenCodeView` (OpenCode) — verified by grep.
- `Composer` is imported by `ChatWindow` only; it branches on `isCodeSurface || showOpenCodeDraft`.
- `appToolkit` (native + OpenCode renderers) is registered in both `ChatShell` and `OpenCodeView`.
- `useConversationTab` is consumed by both `ChatView` and `OpenCodeView`.
- `chatTabs.ts` models chat + agent + page tabs in one store; `threadUrl`/`conversationIdFromPath` are shared.
- The shell split is documented in `router.tsx` and `CodeShell.tsx` as a hard runtime constraint (OpenCode adapter no-op under another RemoteThreadListRuntime).