# Assistant-ui provider consumer audit (Phase E / §5a decision 8)

**Date:** 2026-11-23
**Scope:** repository-wide inventory of every assistant-ui context consumer in
`web/src` (the only browser source tree), including indirect imports, dynamic
`import()` calls and conditionally mounted components.

## Method

Two searches were run over `web/src`:

1. Hook/provider symbols: `useAui`, `useAuiState`, `useAssistantRuntime`,
   `useThreadListItem*` (all variants), `AuiProvider`, `AssistantRuntimeProvider`.
2. Every import from `@assistant-ui/react`, `@assistant-ui/ai-sdk` and
   `@assistant-ui/react-devtools` (68 files), so type-only imports and indirect
   consumers were not missed.

Each consumer was then traced to the component that renders it and classified:

| Classification | Meaning |
|---|---|
| **Ambient-dependent** | Relies on AppShell's root `AssistantRuntimeProvider` and has no provider of its own. |
| **Host-isolated** | Rendered inside a per-host provider (`DirectChatHost`, `DraftChatHost`, `OpenCodeChatHost`, `v2Runtime`, or the runtime's own internal provider). |
| **Optional/fallback** | Does not read assistant-ui React context; operates without any provider. |

## Inventory

### Host-isolated consumers (replacement provider already exists)

All of these render **inside** a per-host `AssistantRuntimeProvider` /
`AuiProvider extends={null}`. Removing the root provider does not affect them.

| Consumer file | Hooks | Provider owner |
|---|---|---|
| `runtime.ts` (`ResumableThreadRuntime`) | `useAui`, `useAuiState` | assistant-ui `RemoteThreadListRuntime` internal per-thread provider (mounted by every `useAppChatRuntime` host) |
| `adapters/remoteThreadListAdapter.tsx` (`useAdapters`) | `useAui` | `unstable_Provider` mounted inside the runtime |
| `components/ChatWindow.tsx` | `useAuiState` | `DirectChatHost` / `DraftChatHost` / `OpenCodeChatHost` |
| `components/Composer.tsx` | `useAui`, `useAuiState` | same |
| `components/VirtualizedTranscript.tsx` | `useAuiState` | same |
| `components/ScrollPill.tsx` | `useAuiState` | same |
| `components/context-ring.tsx` | `useAuiState` | same (via `Composer`) |
| `components/composer/DirectChips.tsx` | `useAui`, `useAuiState` | same |
| `components/chat/ComposerContextMenu.tsx` | `unstable_useComposerInput` | same |
| `components/assistant-ui/elements/*` (`mermaid-diagram`, `reasoning`, `context-display`, `shiki-highlighter`, `session-timeline`, `message-actions`, `tool-group`, `tool-fallback`) | `useAuiState`, `useScrollLock`, `useThreadTokenUsage` | same |
| `tools/{opencode,filesystem,computer,elapsed}/*` | `useAui`, `useAuiState`, `useToolCallElapsed` | same |
| `features/chat/hooks/useAssistantActivity.ts` | `useAuiState` | same (via `ChatWindow`) |
| `features/chat/history/DirectViewportBridge.tsx` | `useAui`, `useAuiState` | same |
| `features/chat/context/useCurrentContext.ts` | `useAuiState` | same |
| `features/chat/components/WelcomeScopePicker.tsx` | `useAuiState` | same |
| `features/chat/components/QuickActions.tsx` | `unstable_useComposerInput` | same |
| `features/chat/components/ComposerDock.tsx` | `useThreadViewport`, `ThreadPrimitive` | same |
| `features/chat/history/useDirectHistoryWindow.ts` | `useAISDKChat` | same |
| `features/chat/components/ChatHeader.tsx` | `useAui`, `useAuiState` | `DirectChatHost` / `DraftChatHost` (and previously the routed `ChatView` — removed in Phase E) |
| `features/opencode/*` (`FirstPromptHandoff`, `OpenCodePrimaryStatus`, `v2RuntimeExtras`, `v2Runtime`, `v2RuntimeStore`, `v2Permissions`, …) | `useAuiState`, `AssistantRuntimeProvider`, `useExternalStoreRuntime` | `OpenCodeChatHost` → `OpenCodeIsolationBoundary` (`AuiProvider extends={null}`) → `v2Runtime` |

### Optional / fallback consumers (no provider required)

| Consumer | Why it is safe |
|---|---|
| `components/DevToolsGate.tsx` (`DevToolsModal`) | Inspected the installed `@assistant-ui/react-devtools@*` bundle: `DevToolsModal` → `DevToolsModalImpl` → `DevToolsOverlay` → `DevToolsPanel` reads data from the global `DevToolsHooks` registry via `createInProcessClient`/`useDevToolsClient`. It never calls `useAui`, `useAuiState` or `useAssistantRuntime`. It is also dev-only (`DEV_TOOLS_ENABLED` returns `null` in production). |
| Type-only imports (`import type { … }`) across `tools/*`, `adapters/*`, `features/*` | Erased at compile time; no runtime context read. |

### Ambient-dependent consumers (relied on AppShell's root provider)

| Consumer | Rendering path before Phase E | Phase E replacement |
|---|---|---|
| `features/chat/components/ChatView.tsx` → `ChatHeader` + `ChatWindow` | Routed `/chat/:id` and `/chat/new` surface, rendered directly under AppShell's root provider | **Removed.** `ChatView` becomes a thin focus/open trigger (no `ChatWindow`). The conversation is rendered by the per-host provider inside its Dockview `DirectPanel` / draft panel. |
| `features/opencode/OpenCodeView.tsx` → `OpenCodeChatHost` | Routed `/code/:id` surface under `CodeShell` (which itself had no provider; it relied on AppShell's root provider for the shared `Composer`/`ChatWindow` inside the host) | **Removed.** `OpenCodeView` becomes a thin focus/open trigger. The host renders inside `OpenCodePanel` with its own isolation boundary + provider. |

No other ambient-dependent consumer exists: the chrome components
(`Sidebar`, `TabStrip`, `StatusBar`, `ActivityBar`, `CommandPalette`,
`LeftEdgeChrome`, `RightEdgeChrome`, `WindowControls`, `ChromeShortcuts`,
`ZoomController`, `PageContextMenu`, `RouteObserver`, `TabUrlSync`) contain **no**
`@assistant-ui/*` imports. The Sidebar's running indicator
(`components/ui/thread-running-dot.tsx`) reads the HTTP-owned activity
projection (`useConversationExecution`), not ambient runtime state.

## Gate result

**SATISFIED.** Every ambient-dependent consumer is either removed in Phase E
(the routed chat/code views) or has a verified provider/fallback:

- All message/composer/tool rendering is host-isolated behind per-host
  providers.
- Sidebar status is activity-projection-owned (no ambient runtime read).
- DevTools is provider-independent (global registry) and dev-only.

Therefore the root `AssistantRuntimeProvider` may be removed from `AppShell`
in Phase E. A permanent source-guard test
(`tests/unit/web/workspace/provider-boundaries.test.ts`) fails if a chrome
component gains an ambient assistant-ui hook or if a host loses its provider.

## POC exclusion

`features/workspace/DockviewOpenCodeHost.tsx` is a DEV-only POC artifact
(Phase F cleanup). It mounts its own `AssistantRuntimeProvider` and is not
part of the production path; it is intentionally out of scope.
