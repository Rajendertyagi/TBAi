/**
 * Sidebar section-order unit tests (no DOM, no server).
 *
 * Covers the pure helpers in `web/src/features/desktop/state/sidebarSections.ts`: section-order
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
 *
 * The sidebar has TWO sections. The former `recent` section was removed with the
 * redesign (every conversation appears exactly once: project chats inside their
 * folder, simple chats in `chats`), so `recent` now behaves like any other
 * retired id — dropped by normalization.
 */
import { describe, it, expect } from "bun:test";
import {
  moveSectionInOrder,
  normalizeSectionOrder,
} from "@web/features/desktop/state/sidebarSections";

describe("normalizeSectionOrder", () => {
  it("passes a full permutation through", () => {
    // Archived is a rail surface (not a sidebar section) — only folders/chats
    // are known sidebar section ids, so an "archived" entry is dropped.
    expect(normalizeSectionOrder(["chats", "archived", "folders"])).toEqual(["chats", "folders"]);
  });

  it("drops unknowns and repeats, appends missing in default order", () => {
    // `recent` is retired: unknown to `SIDEBAR_SECTION_IDS`, therefore dropped
    // rather than re-appended.
    expect(normalizeSectionOrder(["recent", "nope", "recent", "chats"])).toEqual([
      "chats",
      "folders",
    ]);
  });

  it("falls back to default for absent or corrupt values", () => {
    expect(normalizeSectionOrder(undefined)).toEqual(["folders", "chats"]);
    expect(normalizeSectionOrder("chats-first")).toEqual(["folders", "chats"]);
    expect(normalizeSectionOrder(null)).toEqual(["folders", "chats"]);
  });
});

describe("moveSectionInOrder", () => {
  const order = ["folders", "chats"] as const;

  it("moves down and up", () => {
    // With two sections, a single-slot move in the legal direction swaps them.
    expect(moveSectionInOrder(order, "folders", 1)).toEqual(["chats", "folders"]);
    // Moving the top section up is clamped; moving the second one up swaps.
    expect(moveSectionInOrder(order, "chats", -1)).toEqual(["chats", "folders"]);
  });

  it("returns the same reference for clamped or unknown moves", () => {
    // The same-reference contract is load-bearing, not incidental: the
    // desktopLayout store relies on it to skip notifying subscribers when a
    // move changes nothing.
    expect(moveSectionInOrder(order, "folders", -1)).toBe(order);
    expect(moveSectionInOrder(order, "chats", 1)).toBe(order);
    expect(moveSectionInOrder(order, "folders", 5)).toBe(order);
    expect(moveSectionInOrder(order, "folders", 0)).toBe(order);
    expect(moveSectionInOrder(order, "unknown" as never, 1)).toBe(order);
  });
});
