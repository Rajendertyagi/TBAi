/**
 * Phase 5 — IndexRedirect.tsx: declarative Navigate replaces the imperative
 * navigate()-in-useEffect pattern.
 *
 * Test 23 from tests/test-prompts-phase5.md.
 *
 * Before Phase 5, `IndexRedirect` called `useNavigate()` inside a
 * `useEffect` and returned `null`. The library now owns when the redirect
 * fires: the component returns `<Navigate to={...} replace />` declaratively,
 * and React Router performs the navigation during render. These source
 * guards pin that shape so the imperative pattern cannot silently return.
 */
import { describe, it, expect } from "bun:test";
import { REPO_ROOT } from "../../helpers/repo-root";
import path from "node:path";

const IDX_SRC = path.join(REPO_ROOT, "web/src/app/IndexRedirect.tsx");

async function readIndexRedirect(): Promise<string> {
  return Bun.file(IDX_SRC).text();
}

describe("Test 23 — IndexRedirect renders Navigate declaratively", () => {
  it("does not use useEffect", async () => {
    const src = await readIndexRedirect();
    expect(src).not.toContain("useEffect");
  });

  it("does not use useNavigate", async () => {
    const src = await readIndexRedirect();
    expect(src).not.toContain("useNavigate");
  });

  it("returns a <Navigate element", async () => {
    const src = await readIndexRedirect();
    expect(src).toContain("<Navigate");
  });

  it("uses ROUTES.CHAT_NEW as the redirect target", async () => {
    const src = await readIndexRedirect();
    expect(src).toContain("ROUTES.CHAT_NEW");
  });

  it("does not return null (the Navigate element is the render output)", async () => {
    const src = await readIndexRedirect();
    expect(src).not.toContain("return null");
  });
});
