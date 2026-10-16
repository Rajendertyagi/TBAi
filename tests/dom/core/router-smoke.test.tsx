import { describe, expect, it } from "bun:test";
import { REPO_ROOT } from "../../helpers/repo-root";
import path from "node:path";

/**
 * Router structural smoke tests.
 *
 * These verify route registration, lazy-loading boundaries, redirect targets,
 * and catch-all behavior through source guards. Live router mounting is
 * covered by Playwright E2E; DOM tests cannot mount the full router because
 * it requires the backend, assistant-ui runtime providers, and lazy-loaded
 * route components.
 */
describe("router-smoke", () => {
  async function readRouter(): Promise<string> {
    const raw = await Bun.file(path.join(REPO_ROOT, "web/src/app/router.tsx")).text();
    return raw.replace(/\r\n/g, "\n");
  }

  it("registers ChatShell as the component for '/'", async () => {
    const source = await readRouter();
    expect(source).toContain('path: "/",');
    expect(source).toContain("Component: ChatShell,");
  });

  it("registers IndexRedirect as the index route under ChatShell", async () => {
    const source = await readRouter();
    expect(source).toContain("index: true,");
    expect(source).toContain('import("./IndexRedirect")');
  });

  it("lazy-loads ChatView at /chat/:threadId?", async () => {
    const source = await readRouter();
    expect(source).toContain('path: "chat/:threadId?"');
    expect(source).toContain('import("../features/chat/components/ChatView")');
  });

  it("lazy-loads CodeShell at /code/:agentId? outside ChatShell", async () => {
    const source = await readRouter();
    expect(source).toContain('path: "code/:agentId?"');
    expect(source).toContain('import("../features/opencode/CodeShell")');
    expect(source).toContain("errorElement: <RouteError />,");
  });

  it("registers settings routes under SettingsLayout", async () => {
    const source = await readRouter();
    expect(source).toContain("Component: SettingsLayout,");
    const settingsRoutes = [
      "memory",
      "mcp",
      "logs",
      "folders",
      "quick-messages",
      "providers",
      "appearance",
      "desktop",
      "workspace",
      "opencode-config",
    ];
    for (const route of settingsRoutes) {
      expect(source).toContain(`path: "${route}"`);
    }
  });

  it("catch-all '*' redirects to '/'", async () => {
    const source = await readRouter();
    expect(source).toContain('{ path: "*", element: <Navigate to="/" replace /> }');
  });

  it("HydrateFallback is preserved on ChatShell and CodeShell", async () => {
    const source = await readRouter();
    expect(source).toContain("Component: ChatShell,");
    expect(source).toContain("HydrateFallback,");
    expect(source).toContain('path: "code/:agentId?"');
  });

  it("errorElement is preserved on ChatShell and CodeShell", async () => {
    const source = await readRouter();
    const chatSection = source.slice(source.indexOf('path: "/",'));
    expect(chatSection).toContain("errorElement: <RouteError />");
    const codeSection = source.slice(source.indexOf('path: "code/:agentId?"'));
    expect(codeSection).toContain("errorElement: <RouteError />");
  });
});
