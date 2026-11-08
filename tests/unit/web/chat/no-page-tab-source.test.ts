/**
 * Phase 5 — source guard: no page-tab references remain in chatTabs.ts.
 *
 * Test 25 from tests/test-prompts-phase5.md.
 *
 * This is the umbrella guard over the whole Phase 5 cleanup: even if an
 * individual symbol reappears (a reintroduced `pageKey`, a new `"page"`
 * branch), this test fails. It reads the source as text so it catches
 * reintroduction at the string level, not just at the type level.
 */
import { describe, it, expect } from "bun:test";
import { REPO_ROOT } from "../../../helpers/repo-root";
import path from "node:path";

const CHATTABS_SRC = path.join(REPO_ROOT, "web/src/features/chat/state/chatTabs.ts");

async function readSource(): Promise<string> {
  return Bun.file(CHATTABS_SRC).text();
}

describe("Test 25 — no page tab references in chatTabs source", () => {
  it('source does not contain kind: "page"', async () => {
    const src = await readSource();
    expect(src).not.toContain('kind: "page"');
  });

  it("source does not contain pageKey", async () => {
    const src = await readSource();
    expect(src).not.toContain("pageKey");
  });

  it("source does not contain openPage", async () => {
    const src = await readSource();
    expect(src).not.toContain("openPage");
  });

  it("source does not construct a page:-prefixed key", async () => {
    const src = await readSource();
    expect(src).not.toContain("page:");
  });
});
