/**
 * IndexRedirect: hydration-aware landing route.
 *
 * Waits for authoritative workspace hydration, then deterministically opens a
 * local draft and redirects to `/chat/new`. Renders loading/error states while
 * hydration is pending or failed, and uses declarative `<Navigate>` for the
 * final redirect.
 */
import { describe, it, expect } from "bun:test";
import { REPO_ROOT } from "../../helpers/repo-root";
import path from "node:path";

const IDX_SRC = path.join(REPO_ROOT, "web/src/app/IndexRedirect.tsx");

async function readIndexRedirect(): Promise<string> {
  return Bun.file(IDX_SRC).text();
}

describe("IndexRedirect — hydration-aware declarative redirect", () => {
  it("does not use imperative useNavigate", async () => {
    const src = await readIndexRedirect();
    expect(src).not.toContain("useNavigate");
  });

  it("returns a <Navigate element for the resolved target", async () => {
    const src = await readIndexRedirect();
    expect(src).toContain("<Navigate");
    expect(src).toContain("replace");
  });

  it("targets the deterministic local draft route", async () => {
    const src = await readIndexRedirect();
    expect(src).toContain("ROUTES.CHAT_NEW");
    expect(src).toContain("openNewDraft");
  });

  it("waits for authoritative workspace hydration", async () => {
    const src = await readIndexRedirect();
    expect(src).toContain("usePreferencesStore");
    expect(src).toContain("hydration");
    expect(src).toContain("Loading workspace");
  });
});
