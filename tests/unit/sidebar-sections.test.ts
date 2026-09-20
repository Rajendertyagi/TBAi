/**
 * Sidebar list-logic unit tests (no DOM, no server).
 *
 * Covers the pure helpers in `web/src/lib/sidebar-sections.ts`: section-order
 * normalization/moves, thread sorting, title filtering, and date grouping.
 * Executed with `bun test`.
 */
import { describe, it, expect } from "bun:test";
import {
  dateGroupLabel,
  filterThreads,
  moveSectionInOrder,
  normalizeSectionOrder,
  sortThreads,
  type SidebarThread,
} from "../../web/src/lib/sidebar-sections";

function thread(
  id: string,
  opts: Partial<SidebarThread> = {},
): SidebarThread {
  return { id, remoteId: id, status: "regular", ...opts };
}

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
    expect(moveSectionInOrder(order, "folders", -1)).toBe(order);
    expect(moveSectionInOrder(order, "recent", 1)).toBe(order);
    expect(moveSectionInOrder(order, "chats", 0)).toBe(order);
    expect(
      moveSectionInOrder(order, "unknown" as never, 1),
    ).toBe(order);
  });
});

describe("sortThreads", () => {
  const a = thread("a", {
    lastMessageAt: new Date("2026-01-01T00:00:00Z"),
    createdAtMs: Date.parse("2026-01-03T00:00:00Z"),
  });
  const b = thread("b", {
    lastMessageAt: new Date("2026-01-02T00:00:00Z"),
    createdAtMs: Date.parse("2026-01-01T00:00:00Z"),
  });

  it("sorts updated by last activity, newest first", () => {
    expect(sortThreads([a, b], "updated").map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("sorts created by creation time, newest first", () => {
    expect(sortThreads([a, b], "created").map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("falls back to last activity when createdAt is missing", () => {
    const c = thread("c", {
      lastMessageAt: new Date("2026-02-01T00:00:00Z"),
    });
    expect(sortThreads([a, c], "created").map((t) => t.id)).toEqual(["c", "a"]);
  });

  it("keeps server order on ties", () => {
    const x = thread("x");
    const y = thread("y");
    expect(sortThreads([x, y], "updated").map((t) => t.id)).toEqual(["x", "y"]);
  });
});

describe("filterThreads", () => {
  const items = [thread("1", { title: "Buy milk" }), thread("2", { title: "Roadmap" })];

  it("matches case-insensitively", () => {
    expect(filterThreads(items, "buy").map((t) => t.id)).toEqual(["1"]);
    expect(filterThreads(items, "ROAD").map((t) => t.id)).toEqual(["2"]);
  });

  it("returns everything for an empty query", () => {
    expect(filterThreads(items, "  ")).toHaveLength(2);
  });
});

describe("dateGroupLabel", () => {
  it("groups today / yesterday / week / older", () => {
    const now = new Date();
    expect(dateGroupLabel(now)).toBe("Today");
    expect(dateGroupLabel(new Date(now.getTime() - 86400000))).toBe(
      "Yesterday",
    );
    expect(dateGroupLabel(new Date(now.getTime() - 3 * 86400000))).toBe(
      "Previous 7 days",
    );
    expect(dateGroupLabel(new Date(now.getTime() - 30 * 86400000))).toBe(
      "Older",
    );
    expect(dateGroupLabel(undefined)).toBe("Older");
  });
});
