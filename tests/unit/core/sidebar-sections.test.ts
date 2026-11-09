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

describe("normalizeSectionOrder (strict, backend/frontend parity)", () => {
  it("passes a valid permutation through and dedupes", () => {
    expect(normalizeSectionOrder(["chats", "folders"])).toEqual(["chats", "folders"]);
    expect(normalizeSectionOrder(["folders", "folders", "chats"])).toEqual(["folders", "chats"]);
  });

  it("appends missing known sections in default order", () => {
    expect(normalizeSectionOrder(["chats"])).toEqual(["chats", "folders"]);
  });

  it("returns default for absent or empty values", () => {
    expect(normalizeSectionOrder(undefined)).toEqual(["folders", "chats"]);
    expect(normalizeSectionOrder(null)).toEqual(["folders", "chats"]);
    expect(normalizeSectionOrder([])).toEqual(["folders", "chats"]);
  });

  it("throws for corrupt values and unknown IDs (no silent repair)", () => {
    expect(() => normalizeSectionOrder("chats-first")).toThrow();
    expect(() => normalizeSectionOrder([1, 2])).toThrow();
    expect(() => normalizeSectionOrder(["recent", "chats"])).toThrow();
    expect(() => normalizeSectionOrder(["chats", "archived", "folders"])).toThrow();
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
