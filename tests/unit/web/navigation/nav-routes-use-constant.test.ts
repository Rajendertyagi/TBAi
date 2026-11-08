/**
 * Phase 5 — navigation.ts: ROUTES constant is the single source for route
 * literals in NavItem routes.
 *
 * Test 15 from tests/test-prompts-phase5.md.
 *
 * `ROUTES` was extracted in Phase 5 so that route path strings live in exactly
 * one place (alongside the router's own definitions). NavItem entries that
 * name a route covered by a constant must reference the constant, not a bare
 * literal — a second copy of the path string is the defect this guard stops.
 */
import { describe, it, expect } from "bun:test";
import { REPO_ROOT } from "../../../helpers/repo-root";
import path from "node:path";
import { ROUTES } from "@web/config/navigation";

const NAV_SRC = path.join(REPO_ROOT, "web/src/config/navigation.ts");

async function readNav(): Promise<string> {
  return Bun.file(NAV_SRC).text();
}

describe("Test 15 — NavItem routes reference ROUTES constants", () => {
  it("ROUTES defines CHAT, CHAT_NEW, FOLDERS, and CODE", () => {
    expect(ROUTES.CHAT).toBe("/chat");
    expect(ROUTES.CHAT_NEW).toBe("/chat/new");
    expect(ROUTES.FOLDERS).toBe("/folders");
    expect(ROUTES.CODE).toBe("/code");
  });

  it("the chat nav entry uses ROUTES.CHAT", async () => {
    const src = await readNav();
    expect(src).toContain("route: ROUTES.CHAT");
  });

  it("the folders nav entry uses ROUTES.FOLDERS", async () => {
    const src = await readNav();
    expect(src).toContain("route: ROUTES.FOLDERS");
  });

  it("no NavItem route is a bare literal for a ROUTES-covered path", async () => {
    const src = await readNav();
    // The two paths that have constants must not appear as bare literals in
    // a `route:` position. The settings-area routes (/providers, /mcp, …)
    // have no constant yet and are out of scope for this Phase 5 guard.
    expect(src).not.toContain('route: "/chat"');
    expect(src).not.toContain('route: "/folders"');
  });
});
