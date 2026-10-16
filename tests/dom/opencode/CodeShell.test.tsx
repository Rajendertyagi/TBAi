import { describe, it, expect, beforeAll } from "bun:test";
import { REPO_ROOT } from "../../helpers/repo-root";
import path from "node:path";

describe("CodeShell architecture guard", () => {
  let source = "";

  beforeAll(async () => {
    source = await Bun.file(path.join(REPO_ROOT, "web/src/features/opencode/CodeShell.tsx")).text();
  });

  it("does NOT import or render AppShell (router owns the shell boundary)", () => {
    expect(source).not.toContain("import { AppShell }");
    expect(source).not.toContain("<AppShell>");
  });

  it("owns the OpenCode surface, not the Direct chat runtime", () => {
    expect(source).toContain("OpenCodeView");
    expect(source).not.toContain("useAppChatRuntime");
  });

  it("does not instantiate a duplicate chat runtime or AssistantRuntimeProvider", () => {
    expect(source).not.toContain("useAppChatRuntime");
    expect(source).not.toContain("AssistantRuntimeProvider");
  });
});

describe("router registers Code as sibling under AppShell", () => {
  let routerSource = "";

  beforeAll(async () => {
    routerSource = await Bun.file(path.join(REPO_ROOT, "web/src/app/router.tsx")).text();
  });

  it("CodeShell is a sibling of ChatShell under AppShell", () => {
    // CodeShell's lazy import is NOT nested inside ChatShell's children.
    //
    // The router is now built from the shared `ROUTE_PATTERNS` constants, so
    // the guard asserts the constant half plus the structural halves — the
    // invariant (CodeShell registered as a sibling of ChatShell under the
    // universal AppShell, not nested inside it) is preserved rather than
    // pinned to the literal `path: "code/:agentId?"` string that no longer
    // appears.
    const chatShellStart = routerSource.indexOf("Component: ChatShell,");
    const codePathStart = routerSource.indexOf("ROUTE_PATTERNS.CODE");
    expect(chatShellStart).toBeGreaterThan(-1);
    expect(codePathStart).toBeGreaterThan(chatShellStart);
    const chatShellSection = routerSource.slice(chatShellStart, codePathStart);
    expect(chatShellSection).not.toContain('import("../features/opencode/CodeShell")');
    // CodeShell is registered as a sibling
    expect(routerSource).toContain("ROUTE_PATTERNS.CODE");
    expect(routerSource).toContain('import("../features/opencode/CodeShell")');
  });
});
