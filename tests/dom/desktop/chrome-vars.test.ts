import { describe, expect, it, beforeEach } from "bun:test";
import { CHAT_WIDTH_ORDER, chatColumnWidth } from "@web/config/chat";
import { syncChromeVars } from "@web/lib/chrome-vars";
import { SIDEBAR_DEFAULT_WIDTH } from "@web/lib/window-chrome";

/**
 * `syncChromeVars` is the ONLY module that turns geometry tokens into CSS
 * variables. The chat column joined that set with the chat-width setting, and
 * this suite holds both halves of the contract: the column variable is written
 * for every setting, and adding it did not displace the variables that were
 * already there.
 *
 * Run under `bun run test:dom` — `syncChromeVars` writes to the real
 * `documentElement.style`, which happy-dom supplies in this preload.
 */
describe("syncChromeVars publishes the chat column width", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
  });

  function read(name: string): string {
    return document.documentElement.style.getPropertyValue(name);
  }

  for (const chatWidth of CHAT_WIDTH_ORDER) {
    it(`writes ${chatWidth} as ${chatColumnWidth(chatWidth)}px`, () => {
      syncChromeVars({
        sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
        chatColumnWidth: chatColumnWidth(chatWidth),
        searchOpen: false,
        captionStrip: false,
      });
      expect(read("--chat-column-width")).toBe(`${chatColumnWidth(chatWidth)}px`);
    });
  }

  it("still writes every variable that existed before the setting", () => {
    // A regression here would be silent: the column would work and the chrome
    // would collapse to zero-width geometry.
    syncChromeVars({
      sidebarWidth: 304,
      chatColumnWidth: 640,
      searchOpen: true,
      captionStrip: true,
    });
    expect(read("--sidebar-width")).toBe("304px");
    expect(read("--left-chrome-width")).not.toBe("");
    expect(read("--right-chrome-reserve")).not.toBe("");
    expect(read("--title-bar-height")).not.toBe("");
    expect(read("--activity-bar-width")).not.toBe("");
    expect(read("--caption-button-width")).not.toBe("");
  });

  it("overwrites a previous value instead of appending", () => {
    syncChromeVars({
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      chatColumnWidth: chatColumnWidth("wide"),
      searchOpen: false,
      captionStrip: false,
    });
    syncChromeVars({
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      chatColumnWidth: chatColumnWidth("narrow"),
      searchOpen: false,
      captionStrip: false,
    });
    expect(read("--chat-column-width")).toBe("640px");
  });
});
