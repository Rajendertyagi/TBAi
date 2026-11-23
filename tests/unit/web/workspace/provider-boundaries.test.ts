/**
 * Step 0 provider-audit gate (plan §5a decision 8 / test 18).
 *
 * These source guards fail if an ambient-dependent assistant-ui consumer is
 * left without a provider after the root `AssistantRuntimeProvider` is removed
 * from AppShell. The full inventory and classification live in
 * `docs/workspace-redesign/PROVIDER_AUDIT.md`.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import path from "node:path";
import { REPO_ROOT } from "../../../helpers/repo-root";

async function sourceOf(relativePath: string): Promise<string> {
  return Bun.file(path.join(REPO_ROOT, relativePath)).text();
}

let appShell = "";
let directHost = "";
let draftHost = "";
let openCodeHost = "";
let directHostProvider = "";
let openCodeBoundary = "";
let devToolsGate = "";
let runningDot = "";
let chromeSources: Record<string, string> = {};

beforeAll(async () => {
  [
    appShell,
    directHost,
    draftHost,
    openCodeHost,
    directHostProvider,
    openCodeBoundary,
    devToolsGate,
    runningDot,
  ] = await Promise.all([
    sourceOf("web/src/app/layout/AppShell.tsx"),
    sourceOf("web/src/features/workspace/components/DirectChatHost.tsx"),
    sourceOf("web/src/features/workspace/components/DraftChatHost.tsx"),
    sourceOf("web/src/features/opencode/OpenCodeChatHost.tsx"),
    sourceOf("web/src/features/workspace/components/directHost.tsx"),
    sourceOf("web/src/features/opencode/OpenCodeIsolationBoundary.tsx"),
    sourceOf("web/src/components/DevToolsGate.tsx"),
    sourceOf("web/src/components/ui/thread-running-dot.tsx"),
  ]);
  const chromePaths = [
    "web/src/components/Sidebar.tsx",
    "web/src/components/TabStrip.tsx",
    "web/src/components/StatusBar.tsx",
    "web/src/components/ActivityBar.tsx",
    "web/src/components/CommandPalette.tsx",
    "web/src/components/LeftEdgeChrome.tsx",
    "web/src/components/RightEdgeChrome.tsx",
    "web/src/components/WindowControls.tsx",
    "web/src/components/ChromeShortcuts.tsx",
    "web/src/components/ZoomController.tsx",
    "web/src/components/PageContextMenu.tsx",
    "web/src/app/RouteObserver.tsx",
  ];
  const texts = await Promise.all(chromePaths.map(sourceOf));
  chromeSources = Object.fromEntries(chromePaths.map((p, i) => [p, texts[i]!]));
});

describe("root provider removed", () => {
  it("AppShell no longer mounts AssistantRuntimeProvider or a root runtime", () => {
    expect(appShell).not.toContain("<AssistantRuntimeProvider");
    expect(appShell).not.toContain("useAppChatRuntime");
    expect(appShell).not.toContain("AuiConfig(");
    expect(appShell).not.toContain("makeAssistantDataUI");
  });

  it("TabUrlSync is retired — URL sync lives in the single focus controller", () => {
    expect(appShell).not.toContain("TabUrlSync");
    expect(appShell).toContain("useWorkspaceFocusSync");
  });

  it("the persistent Dockview layer is mounted outside the route-swapped Outlet", () => {
    expect(appShell).toContain("<DockviewWorkspace");
    expect(appShell).toContain("<Outlet />");
    // The workspace mount precedes the Outlet in the same content row, so
    // route changes never unmount the hosts. Use lastIndexOf because the
    // JSDoc also mentions `<Outlet />` in prose.
    expect(appShell.indexOf("<DockviewWorkspace")).toBeLessThan(appShell.lastIndexOf("<Outlet />"));
  });
});

describe("every ambient-dependent consumer has a replacement provider", () => {
  it("each Direct host mounts its own AssistantRuntimeProvider", () => {
    expect(directHost).toContain("<AssistantRuntimeProvider");
    expect(draftHost).toContain("<AssistantRuntimeProvider");
  });

  it("the Direct host provider is isolated with AuiProvider extends={null}", () => {
    expect(directHostProvider).toContain("<AuiProvider extends={null}");
  });

  it("the OpenCode host mounts its own provider behind an isolation boundary", () => {
    expect(openCodeHost).toContain("<AssistantRuntimeProvider");
    expect(openCodeBoundary).toContain("<AuiProvider extends={null}");
  });

  it("DevToolsGate is provider-independent (global DevToolsHooks registry)", () => {
    expect(devToolsGate).toContain("DevToolsModal");
    expect(devToolsGate).not.toContain("useAui");
    expect(devToolsGate).not.toContain("useAssistantRuntime");
  });

  it("the Sidebar running indicator reads the activity projection, not ambient runtime", () => {
    expect(runningDot).toContain("useConversationExecution");
    expect(runningDot).not.toContain("@assistant-ui/react");
  });
});

describe("chrome components never read assistant-ui context", () => {
  it("no chrome component imports assistant-ui hooks or providers", () => {
    for (const [file, text] of Object.entries(chromeSources)) {
      expect(text, file).not.toContain('from "@assistant-ui/react"');
      expect(text, file).not.toContain("useAuiState");
      expect(text, file).not.toContain("useAssistantRuntime");
      expect(text, file).not.toContain("AssistantRuntimeProvider");
    }
  });
});
