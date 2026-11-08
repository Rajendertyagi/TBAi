/**
 * Phase 5 — navigation.ts cleanup: dead `search` entry and empty `features` object.
 *
 * Tests 13–14 from tests/test-prompts-phase5.md.
 *
 * The `search` nav entry and `features.search` flag were removed in Phase 5.
 * These source-text guards pin that removal so a future refactor cannot
 * silently re-introduce the dead code.
 */
import { describe, it, expect } from "bun:test";
import { REPO_ROOT } from "../../../helpers/repo-root";
import path from "node:path";
import { appConfig } from "@web/config/navigation";

const NAV_SRC = path.join(REPO_ROOT, "web/src/config/navigation.ts");

async function readNav(): Promise<string> {
  return Bun.file(NAV_SRC).text();
}

describe("Test 13 — search nav entry removed", () => {
  it('source contains no `id: "search"` nav entry', async () => {
    const src = await readNav();
    expect(src).not.toContain('id: "search"');
  });

  it("source does not import the Search icon from lucide-react", async () => {
    const src = await readNav();
    // The Search icon import was removed with the entry. The lowercase type
    // value `"search"` remains in the ViewId union (still referenced by
    // existing guards), so only the PascalCase icon import must be gone.
    expect(src).not.toContain("Search,");
    expect(src).not.toContain("SearchText");
  });

  it("appConfig.nav has no entry with id 'search'", () => {
    const ids = appConfig.nav.map((n) => n.id);
    expect(ids).not.toContain("search");
  });
});

describe("Test 14 — features object is empty", () => {
  it("source declares features as Record<string, never> or equivalent", async () => {
    const src = await readNav();
    // The constant is typed Record<string, never>; verify that shape.
    expect(src).toContain("Record<string, never>");
    expect(src).toMatch(/features\s*:\s*Record<string,\s*never>\s*=\s*\{\s*\}/);
  });

  it("no code references features.search", async () => {
    const src = await readNav();
    expect(src).not.toContain("features.search");
  });

  it("appConfig.features has no keys at runtime", () => {
    expect(Object.keys(appConfig.features)).toHaveLength(0);
  });
});
