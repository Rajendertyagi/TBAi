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
    // The router is now built from the shared `ROUTE_PATTERNS` / `ROUTES`
    // constants, so the guard asserts the constant half plus the structural
    // halves — the invariant (HydrateFallback registered on the universal
    // AppShell root, CodeShell as a sibling branch) is preserved rather than
    // pinned to literal `path: "/"` / `path: "code/:agentId?"` strings that
    // no longer appear.
    expect(source).toContain('import { HydrateFallback } from "./HydrateFallback";');
    // AppShell is the universal root component for the index route.
    expect(source).toContain("ROUTE_PATTERNS.INDEX");
    expect(source).toContain("Component: AppShell,");
    expect(source).toContain("HydrateFallback,");
    // ChatShell is nested under AppShell
    expect(source).toContain("Component: ChatShell,");
    // CodeShell is a sibling branch under AppShell (not under ChatShell),
    // registered via the CODE pattern constant.
    expect(source).toContain("ROUTE_PATTERNS.CODE");
    expect(source).toContain("errorElement: <RouteError />");
  });
});
