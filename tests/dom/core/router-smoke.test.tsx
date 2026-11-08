import { describe, expect, it } from "bun:test";
import { REPO_ROOT } from "../../helpers/repo-root";
import path from "node:path";

/**
 * Router STRUCTURAL smoke tests (source guards, not behavioral verification).
 *
 * These verify route registration, lazy-loading boundaries, redirect targets,
 * and catch-all behavior by matching the router source text. They prove the
 * routes are DECLARED, not that navigation WORKS — a passing suite here is
 * necessary but not sufficient for router acceptance.
 *
 * Behavioral coverage lives in Playwright E2E (`tests/e2e/routing/`), which
 * mounts the real application. DOM tests cannot mount the full router because
 * it requires the backend, assistant-ui runtime providers, and lazy-loaded
 * route components.
 */
describe("router-smoke", () => {
  async function readRouter(): Promise<string> {
    const raw = await Bun.file(path.join(REPO_ROOT, "web/src/app/router.tsx")).text();
    return raw.replace(/\r\n/g, "\n");
  }

  it("registers AppShell as the universal root component for '/'", async () => {
    const source = await readRouter();
    expect(source).toContain("path: ROUTE_PATTERNS.INDEX,");
    expect(source).toContain("Component: AppShell,");
  });

  it("registers ChatShell as a nested layout under AppShell", async () => {
    const source = await readRouter();
    expect(source).toContain("Component: ChatShell,");
    // ChatShell is inside AppShell's children
    const appShellSection = source.slice(source.indexOf("path: ROUTE_PATTERNS.INDEX,"));
    expect(appShellSection).toContain("Component: ChatShell,");
  });

  it("registers IndexRedirect as the index route under ChatShell", async () => {
    const source = await readRouter();
    expect(source).toContain("index: true,");
    expect(source).toContain('import("./IndexRedirect")');
  });

  it("lazy-loads ChatView at /chat/:threadId?", async () => {
    const source = await readRouter();
    expect(source).toContain("path: ROUTE_PATTERNS.CHAT");
    expect(source).toContain('import("../features/chat/components/ChatView")');
  });

  it("lazy-loads CodeShell at /code/:agentId? as sibling of ChatShell", async () => {
    const source = await readRouter();
    expect(source).toContain("path: ROUTE_PATTERNS.CODE");
    expect(source).toContain('import("../features/opencode/CodeShell")');
    // CodeShell is NOT nested under ChatShell (check the lazy import, not
    // the bare word — the comment above the Code route mentions CodeShell)
    const chatShellStart = source.indexOf("Component: ChatShell,");
    const codeShellStart = source.indexOf("path: ROUTE_PATTERNS.CODE");
    expect(codeShellStart).toBeGreaterThan(chatShellStart);
    // The CodeShell section is outside ChatShell's children block
    const chatShellSection = source.slice(chatShellStart, codeShellStart);
    expect(chatShellSection).not.toContain('import("../features/opencode/CodeShell")');
  });

  it("registers settings routes under SettingsLayout", async () => {
    const source = await readRouter();
    expect(source).toContain("Component: SettingsLayout,");
    const settingsRoutes = [
      "MEMORY",
      "MCP",
      "LOGS",
      "FOLDERS",
      "QUICK_MESSAGES",
      "PROVIDERS",
      "APPEARANCE",
      "DESKTOP",
      "WORKSPACE",
      "OPENCODE_CONFIG",
    ];
    for (const route of settingsRoutes) {
      expect(source).toContain(`path: ROUTE_PATTERNS.${route}`);
    }
  });

  it("catch-all '*' redirects to '/'", async () => {
    const source = await readRouter();
    expect(source).toContain(
      '{ path: ROUTE_PATTERNS.CATCH_ALL, element: <Navigate to="/" replace /> }',
    );
  });

  it("HydrateFallback is preserved on AppShell and CodeShell", async () => {
    const source = await readRouter();
    expect(source).toContain("Component: AppShell,");
    expect(source).toContain("HydrateFallback,");
    expect(source).toContain("path: ROUTE_PATTERNS.CODE");
  });

  it("errorElement is registered on AppShell, ChatShell, SettingsLayout, and CodeShell", async () => {
    const source = await readRouter();
    const appShellSection = source.slice(source.indexOf("path: ROUTE_PATTERNS.INDEX,"));
    expect(appShellSection).toContain("errorElement: <RouteError />");

    const chatShellStart = source.indexOf("Component: ChatShell,");
    const chatShellSection = source.slice(chatShellStart, chatShellStart + 300);
    expect(chatShellSection).toContain("errorElement: <RouteError />");

    const settingsStart = source.indexOf("Component: SettingsLayout,");
    const settingsSection = source.slice(settingsStart, settingsStart + 300);
    expect(settingsSection).toContain("errorElement: <RouteError />");

    const codeShellSection = source.slice(source.indexOf("path: ROUTE_PATTERNS.CODE"));
    expect(codeShellSection).toContain("errorElement: <RouteError />");
  });
});
