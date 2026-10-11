import { describe, expect, it } from "bun:test";
import { REPO_ROOT } from "../../helpers/repo-root";
import path from "node:path";
import { HydrateFallback } from "@web/app/HydrateFallback.tsx";

describe("HydrateFallback component & router registration", () => {
  it("renders a full-screen background container without errors", () => {
    const element = HydrateFallback();
    expect(element).toBeDefined();
    expect(element.props["data-testid"]).toBe("hydrate-fallback");
    expect(element.props.className).toContain("bg-background");
  });

  it("registers HydrateFallback on root routes in router.tsx", async () => {
    const raw = await Bun.file(path.join(REPO_ROOT, "web/src/app/router.tsx")).text();
    const source = raw.replace(/\r\n/g, "\n");
    expect(source).toContain('import { HydrateFallback } from "./HydrateFallback";');
    expect(source).toContain('path: "/",\n    Component: ChatShell,\n    HydrateFallback,');
    expect(source).toContain('path: "/code/:agentId?",');
    expect(source).toContain("HydrateFallback,\n    errorElement: <RouteError />,");
  });
});
