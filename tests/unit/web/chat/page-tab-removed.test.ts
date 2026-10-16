/**
 * Phase 5 — chatTabs.ts: page-tab code removed.
 *
 * Tests 16–17 from tests/test-prompts-phase5.md.
 *
 * The `kind: "page"` tab type and its supporting code (`pageKey`, `openPage`,
 * the page branch in `healTab`/`tabForKey`/`urlForTab`) were removed in Phase
 * 5. These guards pin that removal: the Tab model is now chat|agent only, and
 * no page-prefix handling remains anywhere in the store.
 */
import { describe, it, expect } from "bun:test";
import { REPO_ROOT } from "../../../helpers/repo-root";
import path from "node:path";
import { healTab } from "@web/features/chat/state/chatTabs";

const CHATTABS_SRC = path.join(REPO_ROOT, "web/src/features/chat/state/chatTabs.ts");

async function readSource(): Promise<string> {
  return Bun.file(CHATTABS_SRC).text();
}

describe("Test 16 — page tab code removed", () => {
  it("source does not contain pageKey", async () => {
    const src = await readSource();
    expect(src).not.toContain("pageKey");
  });

  it("Tab.kind is chat | agent only (no 'page')", async () => {
    const src = await readSource();
    // The kind union must be the two-engine set; 'page' is gone.
    expect(src).toContain('"chat" | "agent"');
    expect(src).not.toContain('"page"');
  });

  it("ChatTabsState does not declare openPage", async () => {
    const src = await readSource();
    expect(src).not.toContain("openPage");
  });
});

describe("Test 17 — healTab no longer handles page prefix", () => {
  it("a page-prefixed key returns null (no longer recognized)", () => {
    expect(healTab({ key: "page:/scheduler", kind: "page", ref: "/scheduler" })).toBeNull();
  });

  it("a well-formed chat tab heals unchanged", () => {
    expect(healTab({ key: "chat:t1", kind: "chat", ref: "t1" })).toEqual({
      key: "chat:t1",
      kind: "chat",
      ref: "t1",
    });
  });

  it("a well-formed agent tab heals unchanged", () => {
    expect(healTab({ key: "agent:a1", kind: "agent", ref: "a1" })).toEqual({
      key: "agent:a1",
      kind: "agent",
      ref: "a1",
    });
  });
});
