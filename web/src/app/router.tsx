import { createHashRouter, Navigate } from "react-router";
import { AppShell } from "./layout/AppShell";
import { ChatShell } from "./layout/ChatShell";
import { RouteError } from "./RouteError";
import { SettingsLayout } from "./layout/SettingsLayout";
import { HydrateFallback } from "./HydrateFallback";

// ─── Eager vs lazy route modules ────────────────────────────────────────────
//
// Three routes stay STATIC imports on purpose:
//
//   - `AppShell` is the universal application shell, required for every route.
//     Keeping it eager lets the chrome paint immediately on every surface.
//   - `ChatShell` is the Direct runtime provider for all normal app routes.
//     Deferring it would trade initial bytes for a slower first paint.
//   - `RouteError` is the `errorElement` for branches. A fallback that itself
//     has to be fetched cannot report the failure that stopped it.
//   - `SettingsLayout` is the frame every settings route renders inside, so
//     keeping it eager lets the settings chrome paint while children stream.
//
// Everything else is loaded through React Router's own `lazy()`.
//
// Branch/shell split (structural, not stylistic): AppShell is the universal
// parent (chrome + global singletons, mounted once). ChatShell provides the
// Direct runtime for all normal app routes. CodeShell provides the OpenCode
// runtime for /code. The two independent runtimes must never nest.

/**
 * Application surfaces (hash routing). The router owns PAGES only; chat message
 * state stays in the assistant-ui runtime, tab state in the chat-tab store.
 *
 * AppShell is the persistent parent — it mounts once and never unmounts during
 * normal navigation (including /chat ↔ /code). ChatShell and CodeShell are
 * children that provide their respective runtimes.
 */
export const router = createHashRouter([
  {
    path: "/",
    Component: AppShell,
    HydrateFallback,
    errorElement: <RouteError />,
    children: [
      {
        // ChatShell: Direct runtime provider for all normal app routes.
        // Renders <Outlet /> for its children; AppShell is the universal parent.
        Component: ChatShell,
        errorElement: <RouteError />,
        children: [
          {
            index: true,
            lazy: () => import("./IndexRedirect").then((m) => ({ Component: m.IndexRedirect })),
          },
          {
            path: "chat/:threadId?",
            lazy: () =>
              import("../features/chat/components/ChatView").then((m) => ({
                Component: m.ChatView,
              })),
          },
          // Dedicated Scheduler page (top-level workbench route, never inside
          // the settings sub-sidebar).
          {
            path: "scheduler",
            lazy: () =>
              import("../features/scheduler/SchedulerPage").then((m) => ({
                Component: m.SchedulerPage,
              })),
          },
          // Archived conversations (rail surface; the sidebar keeps
          // Folders → Chats → Recent only).
          {
            path: "archived",
            lazy: () =>
              import("../features/sidebar/ArchivedPage").then((m) => ({
                Component: m.ArchivedPage,
              })),
          },
          {
            Component: SettingsLayout,
            errorElement: <RouteError />,
            children: [
              {
                path: "memory",
                lazy: () =>
                  import("../features/memories/components/MemoryPanel").then((m) => ({
                    Component: m.MemoryPanel,
                  })),
              },
              {
                path: "mcp",
                lazy: () =>
                  import("../features/mcp/components/McpPanel").then((m) => ({
                    Component: m.McpPanel,
                  })),
              },
              {
                path: "logs",
                lazy: () =>
                  import("../components/LogsPanel").then((m) => ({ Component: m.LogsPanel })),
              },
              {
                path: "folders",
                lazy: () =>
                  import("../features/folders/FoldersPage").then((m) => ({
                    Component: m.FoldersPage,
                  })),
              },
              {
                path: "quick-messages",
                lazy: () =>
                  import("../features/quick-messages/QuickMessagesPage").then((m) => ({
                    Component: m.QuickMessagesPage,
                  })),
              },
              {
                path: "providers",
                lazy: () =>
                  import("../features/providers/ProvidersPage").then((m) => ({
                    Component: m.ProvidersPage,
                  })),
              },
              {
                path: "appearance",
                lazy: () =>
                  import("../features/appearance/AppearancePage").then((m) => ({
                    Component: m.AppearancePage,
                  })),
              },
              {
                path: "desktop",
                lazy: () =>
                  import("../features/desktop/DesktopSettings").then((m) => ({
                    Component: m.DesktopSettings,
                  })),
              },
              {
                path: "workspace",
                lazy: () =>
                  import("../features/workspace/WorkspacePage").then((m) => ({
                    Component: m.WorkspacePage,
                  })),
              },
              {
                path: "opencode-config",
                lazy: () =>
                  import("../features/opencode/OpenCodeConfigPage").then((m) => ({
                    Component: m.OpenCodeConfigPage,
                  })),
              },
            ],
          },
        ],
      },
      {
        // OpenCode Code mode: a managed agent chat surface (own runtime +
        // session) in a dedicated shell — deliberately OUTSIDE the chat
        // runtime/provider. AppShell is the universal parent; CodeShell
        // provides only the OpenCode runtime.
        path: "code/:agentId?",
        // Lazy because nothing outside `features/opencode` imports it, and it pulls
        // the whole `@opencode/client` runtime that most sessions never open.
        lazy: () =>
          import("../features/opencode/CodeShell").then((m) => ({ Component: m.CodeShell })),
        errorElement: <RouteError />,
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
  // Diagnostic page, DEV BUILDS ONLY, and deliberately outside the chat shell.
  //
  // `import.meta.env.DEV` is a compile-time constant, so both this route and its
  // lazy import are dropped from a production build — the lab cannot be reached
  // in a shipped app, and none of it reaches a user's bundle.
  //
  // Top-level rather than a child of the chat shell because the lab must render
  // with no session, no conversation list and no `/api` traffic. Nesting it would
  // make it depend on the very runtime it exists to inspect, and it would fail
  // closed whenever the backend was not running.
  ...(import.meta.env.DEV
    ? [
        {
          path: "/theme-lab",
          lazy: () =>
            import("../features/appearance/ThemeLab").then((m) => ({
              Component: m.ThemeLab,
            })),
        },
        {
          // Same reasoning as the theme lab: focus and key activation are
          // browser behaviour no static-markup test can observe, and a miss
          // here is silent -- Enter reaches the composer and sends an empty
          // message instead of approving, which reads as a hung card.
          path: "/keyboard-lab",
          lazy: () =>
            import("../features/permissions/KeyboardLab").then((m) => ({
              Component: m.KeyboardLab,
            })),
        },
      ]
    : []),
]);
