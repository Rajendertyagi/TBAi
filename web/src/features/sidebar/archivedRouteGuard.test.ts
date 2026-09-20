import { describe, it, expect, beforeAll } from "bun:test";
import { normalizeSectionOrder } from "@/lib/sidebar-sections";
import {
  SIDEBAR_SECTION_IDS,
  type SidebarSectionId,
} from "@/config/sidebar";

/**
 * Guards for the Archived page: route registration order, rail presence,
 * sidebar section ids, and the stale-persisted-order normalization.
 *
 * The router/navigation guards are source-level (no DOM runner); the
 * `normalizeSectionOrder` cases are real behavioural tests of the exported
 * pure function in `lib/sidebar-sections.ts`.
 */

let routerSource = "";
let navigationSource = "";
let sidebarConfigSource = "";

beforeAll(async () => {
  routerSource = await Bun.file(
    new URL("../../app/router.tsx", import.meta.url),
  ).text();
  navigationSource = await Bun.file(
    new URL("../../config/navigation.ts", import.meta.url),
  ).text();
  sidebarConfigSource = await Bun.file(
    new URL("../../config/sidebar.ts", import.meta.url),
  ).text();
});
describe("/archived route registered after scheduler", () => {
  it("registers /scheduler before /archived in the router", () => {
    const schedIdx = routerSource.indexOf('path: "scheduler"');
    const archivedIdx = routerSource.indexOf('path: "archived"');
    expect(schedIdx, "scheduler route must exist").toBeGreaterThan(-1);
    expect(archivedIdx, "archived route must exist").toBeGreaterThan(-1);
    expect(archivedIdx).toBeGreaterThan(schedIdx);
  });

  it("renders ArchivedPage on the /archived route", () => {
    expect(routerSource).toMatch(/path: "archived",\s*Component: ArchivedPage/);
  });
});

describe("rail entry for Archived is present", () => {
  it("navigation.ts declares an archived nav item with a rail-visible default", () => {
    // The item must not opt out of the rail (railVisible: false).
    expect(navigationSource).toMatch(
      /id: "archived",[\s\S]*?route: "\/archived"/,
    );
    // Confirm the archived entry does not carry `railVisible: false`.
    const archivedBlock = navigationSource.match(
      /id: "archived",[\s\S]*?order: \d+/,
    );
    expect(archivedBlock, "archived nav item must exist").not.toBeNull();
    expect(archivedBlock![0], "archived must be rail-visible").not.toContain(
      "railVisible: false",
    );
  });
});

describe("sidebar section ids are exactly folders/chats/recent", () => {
  it("SIDEBAR_SECTION_IDS has exactly the three known sections, in order", () => {
    expect([...SIDEBAR_SECTION_IDS]).toEqual(["folders", "chats", "recent"]);
  });

  it("the SidebarSectionId type is a union of exactly those three", () => {
    expect(sidebarConfigSource).toMatch(
      /export type SidebarSectionId = "folders" \| "chats" \| "recent"/,
    );
  });
});

describe("normalizeSectionOrder drops unknown ids, dedupes, and re-adds missing", () => {
  it("drops unknown ids from a persisted value", () => {
    const result = normalizeSectionOrder([
      "chats",
      "some-removed-section",
      "folders",
    ]) as readonly SidebarSectionId[];
    // Unknown entry dropped; known entries preserved in their relative order;
    // omitted `recent` appended in default order.
    expect(result).toEqual(["chats", "folders", "recent"]);
  });

  it("dedupes repeated ids", () => {
    const result = normalizeSectionOrder(["folders", "chats", "chats"]);
    expect(result).toEqual(["folders", "chats", "recent"]);
  });

  it("returns the default order for a non-array value", () => {
    expect(normalizeSectionOrder("not-an-array")).toEqual([
      "folders",
      "chats",
      "recent",
    ]);
    expect(normalizeSectionOrder(null)).toEqual([
      "folders",
      "chats",
      "recent",
    ]);
    expect(normalizeSectionOrder(undefined)).toEqual([
      "folders",
      "chats",
      "recent",
    ]);
  });

  it("returns a full permutation even when the persisted array is empty", () => {
    const result = normalizeSectionOrder([]) as readonly SidebarSectionId[];
    expect([...result].sort()).toEqual([...SIDEBAR_SECTION_IDS].sort());
    expect(result).toHaveLength(SIDEBAR_SECTION_IDS.length);
  });

  it("appends newly-added sections in default order for existing users", () => {
    // A user whose persisted order predates `recent` gets it appended.
    const result = normalizeSectionOrder(["folders", "chats"]);
    expect(result).toEqual(["folders", "chats", "recent"]);
  });
});
