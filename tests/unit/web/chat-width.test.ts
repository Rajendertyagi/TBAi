import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../helpers/repo-root";
import {
  CHAT_WIDTHS,
  CHAT_WIDTH_ORDER,
  DEFAULT_CHAT_WIDTH,
  chatColumnWidth,
  isChatWidth,
  type ChatWidth,
} from "@web/config/chat";
import { migratePersisted } from "@web/features/desktop/state/desktopLayout";

/**
 * Guards for the chat-width preference and local desktop layout persistence.
 * Shared desktop fields are SQLite-authoritative; only sidebarWidth persists locally.
 */

describe("chat width settings", () => {
  it("offers exactly the three widths, in narrow → wide order", () => {
    expect(CHAT_WIDTH_ORDER).toEqual(["narrow", "comfortable", "wide"]);
    const labelled = Object.keys(CHAT_WIDTHS) as ChatWidth[];
    expect([...CHAT_WIDTH_ORDER].sort()).toEqual(labelled.sort());
  });

  it("keeps Comfortable at the composer's historical width", () => {
    expect(DEFAULT_CHAT_WIDTH).toBe("comfortable");
    expect(CHAT_WIDTHS.comfortable.px).toBe(768);
    expect(chatColumnWidth("comfortable")).toBe(768);
  });

  it("increases strictly from narrow to wide", () => {
    const widths = CHAT_WIDTH_ORDER.map(chatColumnWidth);
    expect(widths).toEqual([640, 768, 1024]);
    expect(new Set(widths).size).toBe(widths.length);
  });

  it("accepts only the three known values", () => {
    for (const id of CHAT_WIDTH_ORDER) expect(isChatWidth(id)).toBe(true);
    for (const bad of ["", "Comfortable", "widee", null, undefined, 1024, {}])
      expect(isChatWidth(bad)).toBe(false);
  });
});

describe("migratePersisted carries only local sidebarWidth", () => {
  it("defaults when payload has no sidebarWidth", () => {
    const migrated = migratePersisted({
      sidebarVisible: false,
      chatWidth: "wide",
      sidebarSort: "created",
    });
    expect(migrated).toEqual({ sidebarWidth: 224 });
  });

  it("preserves a valid persisted sidebarWidth", () => {
    expect(migratePersisted({ sidebarWidth: 300 }).sidebarWidth).toBe(300);
  });

  it("clamps invalid sidebarWidth", () => {
    expect(migratePersisted({ sidebarWidth: 99999 }).sidebarWidth).toBeLessThanOrEqual(480);
    expect(migratePersisted({ sidebarWidth: -1 }).sidebarWidth).toBeGreaterThanOrEqual(180);
  });

  it("survives a corrupt payload", () => {
    for (const bad of [null, undefined, "nope", 42]) {
      expect(migratePersisted(bad).sidebarWidth).toBe(224);
    }
  });
});

describe("the pre-mount CSS default", () => {
  it("matches the Comfortable width, so first paint equals settled layout", () => {
    const css = readFileSync(path.join(REPO_ROOT, "web/src/styles/globals.css"), "utf8");
    const match = css.match(/--chat-column-width:\s*(\d+)px\s*;/);
    expect(match, "globals.css must declare --chat-column-width").not.toBeNull();
    expect(Number(match![1])).toBe(CHAT_WIDTHS[DEFAULT_CHAT_WIDTH].px);
  });
});
