# AppShell Runtime Boundary Plan

## 1. Current Root Cause
`AppShell` renders top-level navigation chrome (`Sidebar`, `TabStrip`, `StatusBar`) across all application routes. Currently, `Sidebar` and `TabStrip` directly consume assistant-ui thread-list primitives and hooks (`ThreadListPrimitive.*`, `useAuiState((s) => s.threads)`). As a result:
- Mounting `AppShell` outside an assistant-ui runtime (such as on the `/code` route) causes `useAuiState` and `ThreadListPrimitive` components to throw `"You are using a component or hook that requires an AuiProvider"`.
- Wrapping `/code` in a Direct Chat runtime to fix this error conflated **application navigation** with **chat execution**, improperly initializing Direct Chat model streaming infrastructure on the OpenCode surface.

## 2. Exact assistant-ui Dependencies Inside AppShell
A complete audit of components rendered by `AppShell` reveals:
- **`web/src/components/Sidebar.tsx`**:
  - `ThreadListPrimitive.New`
  - `ThreadListPrimitive.Root`
  - `ThreadListPrimitive.Items`
  - `ThreadListPrimitive.LoadMore`
  - `useAuiState((s) => s.threads.isLoading)`
  - `useAuiState((s) => s.threads.threadIds.length)`
  - `useAuiState((s) => s.threads.threadItems)`
- **`web/src/components/TabStrip.tsx`**:
  - `useAuiState((s) => s.threads.threadItems)` in `useTabTitle` and `useTabRunning`
- **`web/src/components/StatusBar.tsx`**:
  - Zero assistant-ui dependencies (uses Zustand `useSettingsStore` and React Router).
- **`web/src/app/layout/AppShell.tsx`**:
  - Zero direct assistant-ui hooks (composes `ActivityBar`, `Sidebar`, `TabStrip`, `StatusBar`, `PageContextMenu`, `WindowControls`, `ChromeShortcuts`, `TabUrlSync`).

## 3. Pinned assistant-ui Dependency Audit & Provider Solution
- **Pinned Version:** `@assistant-ui/react` version `^0.15.20`.
- **Library-First Provider Check:** In `@assistant-ui/react` 0.15.20, `useAuiState((s) => s.threads)` reads from a `ThreadListRuntime`. The library does **not** expose a standalone, execution-free thread-list provider primitive separate from `useRemoteThreadListRuntime` or `AssistantRuntimeProvider`.
- **Durable Solution:** Decouple `AppShell` navigation chrome (`Sidebar` and `TabStrip`) from assistant-ui execution context. Application navigation should read directly from TBAi's canonical navigation state (`useChatTabsStore`, conversation API / Zustand stores) rather than requiring a chat execution runtime to render tabs and thread lists.

## 4. Decoupling Strategy & State Ownership

### Sidebar State Ownership
- `Sidebar` will map TBAi conversation lists and open tabs using TBAi's conversation identity (`conversationId`, `engine`, `title`, `status`, `lastMessageAt`).
- Thread switching calls React Router `navigate(threadUrl(remoteId, engine))`.
- Active thread selection and filtering use TBAi's conversation state.

### TabStrip State Ownership
- `TabStrip` reads `useChatTabsStore` (which already tracks open `tabs`, `activeKey`, `reorder`, `close`, `resolveDraftId`).
- Tab titles and running indicators will resolve from TBAi conversation metadata / tab state rather than `s.threads.threadItems`.

### Conversation & Session Identity Ownership
- **TBAi Conversation Identity:** Authoritative for application routing (`/chat/:threadId`, `/code/:agentId`), tab keys (`chat:<id>`, `agent:<id>`), and sidebar lists.
- **Direct Chat Runtime:** Active only on `/chat` routes within `ChatShell`.
- **OpenCode Session Identity:** Runtime-specific concern managed within `OpenCodeView` on `/code` routes.

## 5. Final Target Hierarchies

### `/chat` Route Hierarchy
```
Router
  └── ChatShell
        ├── AssistantRuntimeProvider (Direct Chat Execution Runtime)
        └── AppShell
              ├── Sidebar (TBAi Conversation State)
              ├── TabStrip (TBAi Tab State)
              ├── StatusBar
              └── ChatView (Direct Chat Surface)
```

### `/code` Route Hierarchy
```
Router
  └── CodeShell
        └── AppShell (Zero Direct Chat Runtimes)
              ├── Sidebar (TBAi Conversation State)
              ├── TabStrip (TBAi Tab State)
              ├── StatusBar
              └── OpenCodeView
                    └── OpenCodeIsolationBoundary (<AuiProvider extends={null}>)
                          └── AssistantRuntimeProvider (Isolated OpenCode Session Runtime)
                                └── ChatWindow (mode="agent")
```

## 6. Target Runtime Count by Responsibility

| Route | TBAi Navigation | Direct Execution Runtime | OpenCode Session Runtime |
|---|---|---|---|
| **/chat** | TBAi Stores / Hooks | **1** (`ChatShell`) | **0** |
| **/code** | TBAi Stores / Hooks | **0** | **1** (`OpenCodeView`) |

## 7. Migration Scope & Non-Goals

### Minimal Scope:
1. Refactor `TabStrip.tsx` to read tab titles and running state from TBAi tab/conversation state rather than `useAuiState`.
2. Refactor `Sidebar.tsx` thread lists to render TBAi conversations cleanly without requiring `ThreadListPrimitive.*` or `useAuiState`.
3. Update `CodeShell.tsx` so `AppShell` renders cleanly without instantiating any Direct Chat runtime.
4. Ensure `OpenCodeView.tsx` keeps its isolated OpenCode session runtime wrapped in `OpenCodeIsolationBoundary`.

### Non-Goals:
- Do NOT alter Direct Chat runtime behavior (`useAppChatRuntime` in `ChatShell`).
- Do NOT alter OpenCode session runtime, permissions, Shield, or Questions logic.
- Do NOT change backend conversation API, database schema, or Zod schemas.
- Do NOT add new third-party libraries or modify pinned `@assistant-ui/*` dependencies.

## 8. Verification & Acceptance Criteria
1. `bun run typecheck` exits 0.
2. `bun run lint` (Biome check) exits 0.
3. `bun test` passes all unit and integration tests.
4. `bun run build` exits 0.
5. `semgrep scan --config auto` completes cleanly.
6. Browser verification proves:
   - `/chat`: Direct chat loads, streams, switches conversations, renders sidebar & tabs.
   - `/code`: Sidebar, TabStrip, StatusBar render with ZERO `missing AuiProvider` errors; OpenCode chat, tools, and Shield operate normally.
   - Navigation between `/chat` and `/code` works seamlessly without context contamination.
