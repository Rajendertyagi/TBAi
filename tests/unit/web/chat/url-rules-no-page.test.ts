/**
 * Phase 5 — chatTabs.ts: URL rules no longer carry a page-tab branch.
 *
 * Tests 18–19 from tests/test-prompts-phase5.md.
 *
 * `urlForTab` now resolves exactly two kinds: agent → Code surface, chat →
 * Direct surface. `tabForKey` is module-private, so its page-prefix behaviour
 * is exercised through the exported `healTab`/store path instead.
 */
import { describe, it, expect } from "bun:test";
import { REPO_ROOT } from "../../../helpers/repo-root";
import path from "node:path";
import { urlForTab, type Tab } from "@web/features/chat/state/chatTabs";

const CHATTABS_SRC = path.join(REPO_ROOT, "web/src/features/chat/state/chatTabs.ts");

async function readSource(): Promise<string> {
  return Bun.file(CHATTABS_SRC).text();
}

describe("Test 18 — tabForKey no longer handles the page prefix", () => {
  it("source has no page-prefix branch in key resolution", async () => {
    const src = await readSource();
    // The only prefix branches that remain are agent: and chat:.
    expect(src).not.toContain('startsWith("page:")');
  });
});

describe("Test 19 — urlForTab handles only chat and agent", () => {
  it("a chat tab points at /chat/<ref>", () => {
    const tab: Tab = { key: "chat:t1", kind: "chat", ref: "t1" };
    expect(urlForTab(tab)).toBe("/chat/t1");
  });

  it("an agent tab points at /code/<ref>", () => {
    const tab: Tab = { key: "agent:a1", kind: "agent", ref: "a1" };
    expect(urlForTab(tab)).toBe("/code/a1");
  });

  it("the function has no page fallback branch", async () => {
    const src = await readSource();
    // urlForTab is the two-kind if/return: agent → Code surface, everything
    // else → chat. A third branch for page tabs is gone.
    const fn = src.match(/export function urlForTab[\s\S]*?\n}/)?.[0] ?? "";
    expect(fn).not.toContain("page");
    expect(fn).toContain('kind === "agent"');
  });
});
