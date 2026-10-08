import { describe, expect, it } from "bun:test";
import { HydrateFallback } from "./HydrateFallback";

describe("HydrateFallback component & router registration", () => {
  it("renders a full-screen background container without errors", () => {
    const element = HydrateFallback();
    expect(element).toBeDefined();
    expect(element.props["data-testid"]).toBe("hydrate-fallback");
    expect(element.props.className).toContain("bg-background");
  });

  it("registers HydrateFallback on root routes in router.tsx", async () => {
    const raw = await Bun.file(new URL("./router.tsx", import.meta.url)).text();
    const source = raw.replace(/\r\n/g, "\n");
    expect(source).toContain('import { HydrateFallback } from "./HydrateFallback";');
    expect(source).toContain("path: \"/\",\n    Component: ChatShell,\n    HydrateFallback,");
    expect(source).toContain("path: \"/code/:agentId?\",");
    expect(source).toContain("HydrateFallback,\n    errorElement: <RouteError />,");
  });
});
