/**
 * Page-tab code removed. The Tab model is chat|agent only.
 * Legacy tab import/localStorage authority is retired.
 */
import { describe, it, expect } from "bun:test";
import { REPO_ROOT } from "../../../helpers/repo-root";
import path from "node:path";

const CHATTABS_SRC = path.join(REPO_ROOT, "web/src/features/chat/state/chatTabs.ts");

async function readSource(): Promise<string> {
  return Bun.file(CHATTABS_SRC).text();
}

describe("page tab code removed", () => {
  it("source does not contain pageKey", async () => {
    const src = await readSource();
    expect(src).not.toContain("pageKey");
  });

  it("Tab.kind is chat | agent only (no 'page')", async () => {
    const src = await readSource();
    expect(src).toContain('"chat" | "agent"');
    expect(src).not.toContain('"page"');
  });

  it("ChatTabsState does not declare openPage", async () => {
    const src = await readSource();
    expect(src).not.toContain("openPage");
  });

  it("does not export legacy open-tabs localStorage authority", async () => {
    const src = await readSource();
    expect(src).not.toContain("LEGACY_OPEN_TABS_STORAGE_KEY");
    expect(src).not.toContain("readLegacyOpenTabs");
  });
});
