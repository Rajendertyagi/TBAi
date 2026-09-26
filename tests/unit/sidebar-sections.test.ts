/**
 * Sidebar section-order unit tests (no DOM, no server).
 *
 * Covers the pure helpers in `web/src/lib/sidebar-sections.ts`: section-order
 * normalization and moves. Executed with `bun test`.
 *
 * SCOPE NOTE: this file used to also cover `sortThreads`, `filterThreads`, and
 * `dateGroupLabel`. All three were removed alongside the code they tested —
 * they were dead (see docs/decisions.md, "Sidebar sections are scoped
 * server-side"). `dateGrouping` was already `false`, so its render branch was
 * unreachable; `sortThreads`/`filterThreads`/`SidebarThread` had no callers at
 * all, and thread ordering/filtering is now the server's job via
 * `conversationService.list` (see tests/integration for that coverage).
 * `tests/` is not covered by either tsconfig, so a stale import here would only
 * ever surface as a module-load SyntaxError at run time.
 */
import { describe, it, expect } from "bun:test";
import {
  moveSectionInOrder,
  normalizeSectionOrder,
} from "../../web/src/lib/sidebar-sections";

describe("normalizeSectionOrder", () => {
  it("passes a full permutation through", () => {
    // Archived is a rail surface (not a sidebar section) — only folders/chats/
    // recent are known sidebar section ids, so an "archived" entry is dropped.
    expect(normalizeSectionOrder(["recent", "chats", "archived", "folders"])).toEqual([
      "recent",
      "chats",
      "folders",
    ]);
  });

  it("drops unknowns and repeats, appends missing in default order", () => {
    expect(
      normalizeSectionOrder(["recent", "nope", "recent", "chats"]),
    ).toEqual(["recent", "chats", "folders"]);
  });

  it("falls back to default for absent or corrupt values", () => {
    expect(normalizeSectionOrder(undefined)).toEqual([
      "folders",
      "chats",
      "recent",
    ]);
    expect(normalizeSectionOrder("chats-first")).toEqual([
      "folders",
      "chats",
      "recent",
    ]);
    expect(normalizeSectionOrder(null)).toEqual([
      "folders",
      "chats",
      "recent",
    ]);
  });
});

describe("moveSectionInOrder", () => {
  const order = ["folders", "chats", "recent"] as const;

  it("moves down and up", () => {
    expect(moveSectionInOrder(order, "chats", 1)).toEqual([
      "folders",
      "recent",
      "chats",
    ]);
    // `recent` (index 2) moved up two slots lands at index 0.
    expect(moveSectionInOrder(order, "recent", -2)).toEqual([
      "recent",
      "folders",
      "chats",
    ]);
  });

  it("returns the same reference for clamped or unknown moves", () => {
    // The same-reference contract is load-bearing, not incidental: the
    // desktopLayout store relies on it to skip notifying subscribers when a
    // move changes nothing.
    expect(moveSectionInOrder(order, "folders", -1)).toBe(order);
    expect(moveSectionInOrder(order, "recent", 1)).toBe(order);
    expect(moveSectionInOrder(order, "chats", 0)).toBe(order);
    expect(
      moveSectionInOrder(order, "unknown" as never, 1),
    ).toBe(order);
  });
});
