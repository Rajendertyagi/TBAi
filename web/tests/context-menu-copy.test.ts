/**
 * Contract tests for the two context-menu features, read from source.
 *
 * WHY SOURCE-SCOPED, NOT RENDERED. Both menus are Radix context menus: they
 * render through a portal, open only on a real `contextmenu` event, and read
 * live DOM selection. This repo has no DOM test environment (no happy-dom,
 * jsdom, or testing-library), so `renderToStaticMarkup` renders the trigger and
 * nothing of the menu — asserting behaviour through it would be vacuous. The
 * behaviour itself is covered against real code in
 * `web/src/lib/word-suggestions.test.ts`, `spellcheck.test.ts`, and
 * `page-selection.test.ts`, all of which execute the actual helpers the menus
 * call. What is left is wiring: which helpers each menu uses, and that the
 * existing menu entries survived. That is exactly what these assertions pin,
 * and a source guard is honest about being a wiring check rather than pretending
 * to be a render.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { constBody, functionBody, stripComments } from "@/testing/source-scope";

const read = (relative: string) =>
  readFileSync(join(import.meta.dir, "..", relative), "utf8");

const composer = stripComments(read("src/components/chat/ComposerContextMenu.tsx"));
const pageMenu = stripComments(read("src/components/PageContextMenu.tsx"));

describe("composer context menu — spelling wiring", () => {
  it("captures the caret from the contextmenu event, not from menu open", () => {
    // The whole feature rests on this: Radix opens the menu after taking focus,
    // so by `onOpenChange` the textarea selection has collapsed and the
    // right-clicked word is unrecoverable. The read must therefore be scoped to
    // the trigger's own contextmenu handler, not merely present in the file.
    const trigger = composer.slice(
      composer.indexOf("<ContextMenuTrigger"),
      composer.indexOf("<ContextMenuContent"),
    );
    expect(trigger).toContain("onContextMenu");
    expect(trigger).toContain("resolveSpellingOffer");
    // `selectionStart` is read inside the resolver, which the trigger awaits.
    expect(constBody(composer, "resolveSpellingOffer")).toContain("selectionStart");
    expect(constBody(composer, "resolveSpellingOffer")).toContain("findWordAtCaret");
  });

  it("resolves suggestions through the spellcheck helper, not the library", () => {
    // The UI must never reach into typo-js; `spellcheck.ts` owns it.
    expect(composer).toContain("ensureSpellchecker");
    expect(composer).toContain("getSpellingSuggestions");
    expect(composer).not.toContain("typo-js");
  });

  it("finds and replaces the word through the shared helper", () => {
    expect(composer).toContain("findWordAtCaret");
    expect(composer).toContain("replaceWord");
  });

  it("updates the composer through the supported state mechanism", () => {
    // `setText` from `unstable_useComposerInput` is the only supported way to
    // change composer state; a raw DOM value write would desync the runtime.
    expect(composer).toContain("setText");
  });

  it("restores focus and the caret after a replacement", () => {
    // Scoped to the handler, so a `focus()` call in some unrelated handler
    // cannot satisfy this.
    const body = constBody(composer, "applySuggestion");
    expect(body).toContain("ta.focus()");
    expect(body).toContain("setSelectionRange");
  });

  it("does not restore the caret on a timer", () => {
    // A `setTimeout` here would be a race dressed up as a fix.
    expect(composer).not.toContain("setTimeout");
  });

  it("renders the header with the SpellCheck icon", () => {
    // Scoped to the menu content, past the trigger, so the JSX block itself
    // carries the icon and label rather than a comment or import.
    const content = composer.slice(composer.indexOf("<ContextMenuContent"));
    expect(content).toContain("SpellCheck");
    expect(content).toContain("copy.spellingSuggestions");
  });

  it("hides the whole spelling block when there is no offer", () => {
    // One guarded fragment: when the offer is null, neither the header nor a
    // suggestion row nor a stray separator is rendered.
    const content = composer.slice(composer.indexOf("<ContextMenuContent"));
    expect(content).toContain("{spellingOffer && (");
  });

  it("renders suggestions above the cut/copy/paste entries", () => {
    // Order is a user-facing contract: corrections belong where the browser
    // puts them, before the text-editing actions.
    const blockAt = composer.indexOf("spellingOffer &&");
    const cutAt = composer.indexOf("copy.cut");
    const pasteAt = composer.indexOf("copy.pasteAsPlainText");
    expect(blockAt).toBeGreaterThan(-1);
    expect(cutAt).toBeGreaterThan(blockAt);
    expect(pasteAt).toBeGreaterThan(cutAt);
  });
});

describe("composer context menu — existing actions preserved", () => {
  const existing = [
    ["cut", "copy.cut"],
    ["copy", "copy.copy"],
    ["paste as plain text", "copy.pasteAsPlainText"],
    ["select all", "copy.selectAll"],
    ["quick messages submenu", "copy.quickMessages"],
  ] as const;

  for (const [label, marker] of existing) {
    it(`still offers ${label}`, () => {
      expect(composer).toContain(marker);
    });
  }

  it("still uses the shared clipboard helpers for the text actions", () => {
    for (const helper of [
      "cutTextareaSelection",
      "copyTextFromMenu",
      "pastePlainTextInto",
      "selectAllTextareaText",
      "insertTextAtCursor",
    ]) {
      expect(composer).toContain(helper);
    }
  });

  it("keeps the cut/copy/paste/select-all handlers", () => {
    for (const handler of ["handleCut", "handleCopy", "handlePaste", "handleSelectAll"]) {
      // `constBody` throws if the handler is missing, so this asserts both its
      // presence and that it is still a real arrow body.
      expect(constBody(composer, handler).length).toBeGreaterThan(0);
    }
  });
});

describe("page context menu — copy wiring", () => {
  it("captures the selection when the menu opens", () => {
    // Scoped to the handler, so the capture is proven to happen in the
    // open-time callback rather than somewhere else in the component.
    expect(constBody(pageMenu, "handleOpenChange")).toContain("readPageSelection");
  });

  it("reads the live selection only inside the open-time handler", () => {
    // The single `getSelection()` call must live where the selection still
    // exists. Anywhere else is the bug this feature is built to avoid.
    const body = constBody(pageMenu, "handleOpenChange");
    expect(body).toContain("window.getSelection()");
    const readCount = pageMenu.split("getSelection()").length - 1;
    expect(readCount).toBe(1);
  });

  it("copies exactly the captured text via the existing clipboard helper", () => {
    // Not a re-read of the live selection: by click time Radix has collapsed
    // it, so a re-read would copy nothing.
    const body = constBody(pageMenu, "handleCopySelection");
    expect(body).toContain("selectedText");
    expect(body).toContain("copyTextFromMenu");
    expect(body).not.toContain("getSelection");
  });

  it("enables Copy only when the captured text is copyable", () => {
    expect(constBody(pageMenu, "handleCopySelection")).toContain(
      "canCopySelection(selectedText)",
    );
    const content = pageMenu.slice(pageMenu.indexOf("<ContextMenuContent"));
    expect(content).toContain("disabled={!canCopySelection(selectedText)}");
  });
});

describe("page context menu — existing items preserved", () => {
  const existing = [
    ["new chat", "copy.newChat"],
    ["toggle sidebar", "copy.toggleSidebar"],
    ["toggle status bar", "copy.toggleStatusBar"],
    ["open settings", "copy.openSettings"],
  ] as const;

  for (const [label, marker] of existing) {
    it(`still offers ${label}`, () => {
      expect(pageMenu).toContain(marker);
    });
  }

  it("places Copy above the chrome toggles", () => {
    const copyAt = pageMenu.indexOf("copy.copy");
    const sidebarAt = pageMenu.indexOf("copy.toggleSidebar");
    expect(copyAt).toBeGreaterThan(-1);
    expect(sidebarAt).toBeGreaterThan(copyAt);
  });

  it("still navigates for new chat and settings", () => {
    expect(constBody(pageMenu, "handleNewChat")).toContain('"/chat/new"');
    expect(constBody(pageMenu, "handleOpenSettings")).toContain("lastSettingsRoute()");
  });
});
