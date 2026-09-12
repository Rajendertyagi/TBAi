import { createHashRouter, Navigate } from "react-router";
import { AppShell } from "./layout/AppShell";
import { SettingsLayout } from "./layout/SettingsLayout";
import { SettingsWindow } from "./layout/SettingsWindow";
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

/**
 * Application surfaces (hash routing: works under vite dev, the Bun SPA
 * fallback, and the ElectroBun desktop bundle serving local files — the
 * hash never reaches the server). The router owns PAGES only; chat message
 * state stays in the assistant-ui runtime, tab state in the chat-tab store.
 */
export const router = createHashRouter([
  {
    path: "/",
    Component: AppShell,
    children: [
      { index: true, Component: IndexRedirect },
      { path: "chat/:threadId?", Component: ChatView },
      // Dedicated Scheduler page (top-level workbench route, never inside
      // the settings sub-sidebar).
      { path: "scheduler", Component: SchedulerPage },
      {
        Component: SettingsLayout,
        children: [
          { path: "memory", Component: MemoryPanel },
          { path: "mcp", Component: McpPanel },
          { path: "logs", Component: LogsPanel },
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
    // Dedicated settings window (decorated native window on desktop): the
    // settings nav + section content with no app chrome. Outside AppShell
    // on purpose — the window brings its own native frame.
    path: "settings-window/:section?",
    Component: SettingsWindow,
  },
]);
