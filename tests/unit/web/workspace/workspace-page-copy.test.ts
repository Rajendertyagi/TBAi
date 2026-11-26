/**
 * The Workspace settings copy must not overstate tool scoping.
 *
 * Model-driven file tools resolve inside the active conversation's workspace
 * root (routes/chat/assemble-run.ts:119-135). The manual /api/tools/* surface
 * uses the global WORKSPACE_DIR (routes/tools.ts:65-120), and runBash is not
 * sandboxed (services/tools.ts:5-13). The page must say so.
 */
import { describe, it, expect } from "bun:test";
import path from "node:path";
import { REPO_ROOT } from "../../../helpers/repo-root";

const PAGE = path.join(REPO_ROOT, "web/src/features/workspace/WorkspacePage.tsx");

describe("Workspace settings copy", () => {
  it("does not claim every file tool is confined to one folder", async () => {
    const source = await Bun.file(PAGE).text();
    expect(source).not.toContain("Every file tool is confined here");
  });

  it("distinguishes the global folder from per-conversation workspaces", async () => {
    const source = await Bun.file(PAGE).text();
    expect(source).toContain("manual /api/tools/* endpoints");
    expect(source).toContain("private chat folder");
    expect(source).toContain("registered project folder");
  });

  it("states that shell commands are not sandboxed", async () => {
    const source = await Bun.file(PAGE).text();
    expect(source).toContain("not sandboxed");
  });
});
