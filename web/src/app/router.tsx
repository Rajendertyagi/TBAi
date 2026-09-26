import { createHashRouter, Navigate } from "react-router";
import { ChatShell } from "./layout/ChatShell";
import { RouteError } from "./RouteError";
import { SettingsLayout } from "./layout/SettingsLayout";
import { IndexRedirect } from "./IndexRedirect";
import { ChatView } from "../features/chat/components/ChatView";
import { ProvidersPage } from "../features/providers/ProvidersPage";
import { AppearancePage } from "../features/appearance/AppearancePage";
import { WorkspacePage } from "../features/workspace/WorkspacePage";
import { MemoryPanel } from "../components/MemoryPanel";
import { McpPanel } from "../components/McpPanel";
import { LogsPanel } from "../components/LogsPanel";
import { SchedulerPage } from "../features/scheduler/SchedulerPage";
import { DesktopSettings } from "../features/desktop/DesktopSettings";
import { FoldersPage } from "../features/folders/FoldersPage";
import { QuickMessagesPage } from "../features/quick-messages/QuickMessagesPage";
import { ArchivedPage } from "../features/sidebar/ArchivedPage";
import { CodeShell } from "../features/opencode/CodeShell";

/**
 * Application surfaces (hash routing: works under vite dev, the Bun SPA
 * fallback, and the ElectroBun desktop bundle serving local files — the
 * hash never reaches the server). The router owns PAGES only; chat message
 * state stays in the assistant-ui runtime, tab state in the chat-tab store.
 *
 * Branch/shell split (structural, not stylistic): the chat branch renders
 * inside `ChatShell` (normal TBAi thread-list runtime + full chrome) while
 * the Code branch renders inside `CodeShell` (native OpenCode V2 runtime at its
 * top, focused chrome). The two independent runtimes must never nest because
 * each owns its own thread-list and session lifecycle; paths are unchanged,
 * only the grouping.
 */
export const router = createHashRouter([
  {
    path: "/",
    Component: ChatShell,
    errorElement: <RouteError />,
    children: [
      { index: true, Component: IndexRedirect },
      { path: "chat/:threadId?", Component: ChatView },
      // Dedicated Scheduler page (top-level workbench route, never inside
      // the settings sub-sidebar).
      { path: "scheduler", Component: SchedulerPage },
      // Archived conversations (rail surface; the sidebar keeps
      // Folders → Chats → Recent only).
      { path: "archived", Component: ArchivedPage },
      {
        Component: SettingsLayout,
        children: [
          { path: "memory", Component: MemoryPanel },
          { path: "mcp", Component: McpPanel },
          { path: "logs", Component: LogsPanel },
          { path: "folders", Component: FoldersPage },
          { path: "quick-messages", Component: QuickMessagesPage },
          { path: "providers", Component: ProvidersPage },
          { path: "appearance", Component: AppearancePage },
          { path: "desktop", Component: DesktopSettings },
          { path: "workspace", Component: WorkspacePage },
        ],
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
  {
    // OpenCode Code mode: a managed agent chat surface (own runtime +
    // session) in a dedicated shell — deliberately OUTSIDE the chat
    // runtime/provider (see above).
    path: "/code/:agentId?",
    Component: CodeShell,
    errorElement: <RouteError />,
  },
]);
