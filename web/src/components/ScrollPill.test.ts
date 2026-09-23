import { describe, it, expect } from "bun:test";
import { stripComments } from "@/testing/source-scope";
import { unseenCount } from "./ScrollPill";

/**
 * Primary proof for the scroll pill is runtime execution of its count math
 * (pure, no DOM needed). Mount wiring is guarded at source level below —
 * additional proof only, since `web/` has no component-test runner.
 */
describe("unseenCount", () => {
  it("counts messages arrived since last seen at bottom", () => {
    expect(unseenCount(10, 7)).toBe(3);
    expect(unseenCount(100, 0)).toBe(100);
  });

  it("is zero when caught up", () => {
    expect(unseenCount(5, 5)).toBe(0);
    expect(unseenCount(0, 0)).toBe(0);
  });

  it("clamps a replaced (shorter) history instead of going negative", () => {
    expect(unseenCount(3, 8)).toBe(0);
  });
});

describe("ChatWindow scroll pill mount (wiring guard)", () => {
  it("mounts the shared ScrollPill instead of an inline pill", async () => {
    const source = stripComments(
      await Bun.file(new URL("./ChatWindow.tsx", import.meta.url)).text(),
    );
    expect(source).toContain("<ScrollPill");
    // The old inline pill must be gone: one integration point per surface,
    // not a duplicate.
    expect(source).not.toContain('tooltip="Scroll to bottom"');
  });
});
