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
 * Guards for the chat-width preference: the three settings themselves, the
 * migration path that has to carry existing users onto the default, and the
 * stylesheet value the first paint uses before `syncChromeVars` runs.
 *
 * The behavioural half (`syncChromeVars` actually writing the variable, and the
 * column being applied to all three surfaces) lives in
 * `tests/dom/desktop/chrome-vars.test.ts` and the chat-layout DOM suite — this
 * file covers the pure data and the migration, which need no DOM.
 */

describe("chat width settings", () => {
  it("offers exactly the three widths, in narrow → wide order", () => {
    expect(CHAT_WIDTH_ORDER).toEqual(["narrow", "comfortable", "wide"]);
    // Order and the label table must not drift apart: a setting that has no
    // entry in `CHAT_WIDTHS` would render a blank button.
    const labelled = Object.keys(CHAT_WIDTHS) as ChatWidth[];
    expect([...CHAT_WIDTH_ORDER].sort()).toEqual(labelled.sort());
  });

  it("keeps Comfortable at the composer's historical width", () => {
    // 768px is `max-w-3xl`, which is what the composer used before this setting
    // existed. Defaulting to anything else would move every existing user's
    // layout on upgrade.
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

describe("migratePersisted carries the chat width", () => {
  it("defaults a payload written before the preference existed", () => {
    // This is the real upgrade path: an existing user's stored layout has no
    // `chatWidth` key at all.
    const migrated = migratePersisted({
      sidebarVisible: false,
      sidebarWidth: 300,
      sidebarSort: "created",
    });
    expect(migrated.chatWidth).toBe(DEFAULT_CHAT_WIDTH);
    // The rest of the payload still loads — the default is merged field by
    // field, not by resetting the whole layout.
    expect(migrated.sidebarVisible).toBe(false);
    expect(migrated.sidebarWidth).toBe(300);
    expect(migrated.sidebarSort).toBe("created");
  });

  it("preserves a valid persisted value", () => {
    expect(migratePersisted({ chatWidth: "wide" }).chatWidth).toBe("wide");
    expect(migratePersisted({ chatWidth: "narrow" }).chatWidth).toBe("narrow");
  });

  it("falls back to the default for an invalid value", () => {
    expect(migratePersisted({ chatWidth: "huge" }).chatWidth).toBe(DEFAULT_CHAT_WIDTH);
    expect(migratePersisted({ chatWidth: 1024 }).chatWidth).toBe(DEFAULT_CHAT_WIDTH);
    expect(migratePersisted({ chatWidth: null }).chatWidth).toBe(DEFAULT_CHAT_WIDTH);
  });

  it("drops the retired showRecent preference instead of carrying it", () => {
    // `showRecent` belonged to the removed Recent section. It must not reappear
    // on the migrated state, where a future reader could mistake it for live
    // state.
    const migrated = migratePersisted({ showRecent: false, chatWidth: "wide" });
    expect("showRecent" in migrated).toBe(false);
    expect(migrated.chatWidth).toBe("wide");
  });

  it("survives a corrupt payload", () => {
    for (const bad of [null, undefined, "nope", 42]) {
      expect(migratePersisted(bad).chatWidth).toBe(DEFAULT_CHAT_WIDTH);
    }
  });
});

describe("the pre-mount CSS default", () => {
  it("matches the Comfortable width, so first paint equals settled layout", () => {
    // `:root` declares the column width because components can paint before the
    // layout effect that calls `syncChromeVars` has run. The two values are
    // independent literals (CSS cannot read a TS constant), so they are pinned
    // here — the same technique as the disclosure-duration guard.
    const css = readFileSync(path.join(REPO_ROOT, "web/src/styles/globals.css"), "utf8");
    const match = css.match(/--chat-column-width:\s*(\d+)px\s*;/);
    expect(match, "globals.css must declare --chat-column-width").not.toBeNull();
    expect(Number(match![1])).toBe(CHAT_WIDTHS[DEFAULT_CHAT_WIDTH].px);
  });
});
