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
 *
 * TWO RULES LEARNED THE HARD WAY, and they shaped every assertion below.
 *
 * 1. DO NOT PIN A FUNCTION NAME. An earlier version of the caret test reached
 *    into `constBody(composer, "resolveSpellingOffer")`. Renaming that function
 *    — a rename that changed no behaviour at all — turned the one test that
 *    covered this file RED, while the structural regression sitting in the same
 *    diff (the spelling header demoted from a `menuitem` to a bare `div`) left
 *    every test GREEN. Names are implementation detail; the caret and the
 *    element are the contract. Assertions here are scoped to a region of the
 *    file instead, so a rename is invisible and a structural change is not.
 *
 * 2. PIN THE ELEMENT, NOT THE STRING. `expect(content).toContain("SpellCheck")`
 *    passed against a bare `<div>`, because the icon and the copy string were
 *    both still there — only the element carrying them had changed. Where the
 *    contract is about structure (is this a menuitem? is there a raw `div` in a
 *    menu?), the assertion names the element.
 *
 * `web/e2e/context-menu-spellcheck.spec.ts` remains the behavioural proof; it
 * drives a real browser and is the only place the rendered menu can be checked.
 * This tier exists so a regression of either kind fails in `bun test` too.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  constBody,
  functionBody,
  jsxAttributeBody,
  stripComments,
} from "@/testing/source-scope";

const read = (relative: string) =>
  readFileSync(join(import.meta.dir, "..", relative), "utf8");

const composer = stripComments(read("src/components/chat/ComposerContextMenu.tsx"));
const pageMenu = stripComments(read("src/components/PageContextMenu.tsx"));
const uiMenu = stripComments(read("src/components/ui/context-menu.tsx"));

/** The composer's trigger element, i.e. everything before the menu content. */
const composerTrigger = composer.slice(
  composer.indexOf("<ContextMenuTrigger"),
  composer.indexOf("<ContextMenuContent"),
);

/** The composer's menu content, i.e. everything after the trigger. */
const composerContent = composer.slice(composer.indexOf("<ContextMenuContent"));

/**
 * The composer's TOP-LEVEL menu content — everything before the Quick Messages
 * submenu. The submenu is a separate region with its own contract; see
 * `renders no raw element in either top-level menu` for why it is excluded
 * here rather than silently swept up.
 */
const composerTopLevel = composerContent.slice(
  0,
  composerContent.indexOf("<ContextMenuSub"),
);

/** The page menu's menu content. */
const pageMenuContent = pageMenu.slice(pageMenu.indexOf("<ContextMenuContent"));

/**
 * Bodies of every const-arrow the given snippet calls. Lets a guard follow
 * "the pre-open event reaches the read" without naming the function it reaches,
 * which is what makes the assertion survive a rename instead of breaking on one.
 */
function calledConstBodies(source: string, snippet: string): string[] {
  const names = new Set<string>();
  for (const [, name] of snippet.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) names.add(name);
  const bodies: string[] = [];
  for (const name of names) {
    // `constBody` throws when the name is not a const arrow, so only ask for
    // the ones that are — a call into a hook or an import is then simply not a
    // match rather than a crash.
    if (!new RegExp(`const\\s+${name}\\s*=`).test(source)) continue;
    bodies.push(constBody(source, name));
  }
  return bodies;
}

describe("composer context menu — spelling wiring", () => {
  it("captures the caret from the contextmenu event, not from menu open", () => {
    // The whole feature rests on this: Radix opens the menu after taking focus,
    // so by `onOpenChange` the textarea selection has collapsed and the
    // right-clicked word is unrecoverable. Asserting the read is NOT at open
    // time is the half provable from source; the e2e spec proves the rest.
    const onOpen = jsxAttributeBody(composer, "onOpenChange");
    for (const forbidden of ["selectionStart", "selectionEnd", "findWordAtCaret"]) {
      expect(onOpen).not.toContain(forbidden);
    }
  });

  it("reaches the caret read from the contextmenu event", () => {
    // Follows the call one hop rather than pinning a name: whatever the
    // `onContextMenu` handler invokes must be what reads the selection. A rename
    // of that helper is invisible here; moving the read behind the open
    // callback, or dropping it entirely, is not.
    const onContextMenu = jsxAttributeBody(composerTrigger, "onContextMenu");
    const readsCaret = calledConstBodies(composer, onContextMenu).filter(
      (body) => body.includes("selectionStart") && body.includes("findWordAtCaret"),
    );
    expect(readsCaret).toHaveLength(1);
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

  it("renders the header as a disabled menu item, not a bare element", () => {
    // Scoped to the guarded spelling block, so the element carrying the icon and
    // the label is the one asserted. APG allows only menuitem /
    // menuitemcheckbox / menuitemradio plus separator inside a `menu`, and a
    // non-activatable labelled row is precisely what a disabled item is for.
    // A bare `<div>` passes an icon-plus-copy assertion, so the element is the
    // assertion.
    const block = composerContent.slice(
      composerContent.indexOf("{spellingOffer && ("),
      composerContent.indexOf("copy.cut"),
    );
    expect(block).toContain("<ContextMenuItem disabled");
    expect(block).toContain("SpellCheck");
    expect(block).toContain("copy.spellingSuggestions");
  });

  it("renders no raw element in either top-level menu", () => {
    // The general form of the rule above, and the one that would have caught
    // the regression on sight rather than through a missing role in the e2e
    // spec. Radix renders its own `div`s internally; these are OUR children, and
    // a `role="menu"` accepts only Radix menu parts.
    //
    // SCOPE, stated rather than hidden: the Quick Messages SUBMENU is excluded
    // because its empty state is a pre-existing centred placeholder `<div>`,
    // and converting that to a disabled item would restyle it (items are
    // flex-row, not centred). It is the same ARIA class of problem, tracked
    // separately, and deliberately not folded into a guard that would otherwise
    // have to be red on arrival.
    expect(composerTopLevel).not.toContain("<div");
    expect(pageMenuContent).not.toContain("<div");
  });

  it("gives every menu item a textValue for typeahead", () => {
    // Radix builds its typeahead index from the item's own `textContent`
    // (@radix-ui/react-menu, MenuContentImpl), so a visible shortcut is in the
    // search key unless the item pins one. Without this, typing "b" matches
    // "Paste as plain text Ctrl+V". aria-hidden does not help here — textContent
    // ignores ARIA entirely.
    const items = [...composerContent.matchAll(/<ContextMenuItem\b[^>]*>/g)].map(
      (m) => m[0],
    );
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item).toContain("textValue");

    const pageItems = [...pageMenuContent.matchAll(/<ContextMenuItem\b[^>]*>/g)].map(
      (m) => m[0],
    );
    expect(pageItems.length).toBeGreaterThan(0);
    for (const item of pageItems) expect(item).toContain("textValue");
  });

  it("hides the shortcut text from the accessible name", () => {
    // Without this the item's accessible name is "Cut Ctrl+X", so every
    // consumer that addresses the item by name — screen readers, and the
    // `exact: true` locators in the e2e spec — stops matching. shadcn's own
    // ContextMenuShortcut ships without it; see docs/decisions.md.
    expect(uiMenu).toContain("ContextMenuShortcut");
    const shortcut = functionBody(
      uiMenu.slice(uiMenu.indexOf("function ContextMenuShortcut")),
      "ContextMenuShortcut",
    );
    expect(shortcut).toContain('aria-hidden="true"');
  });

  it("declares aria-keyshortcuts only where a key is actually bound", () => {
    // The composer edits: the textarea natively handles Ctrl+X/C/V/A, so the
    // items genuinely do what the hint says. The page menu is narrower —
    // ChromeShortcuts.tsx binds Ctrl/Cmd+T, +W, +Tab and +1..9 and nothing
    // else, so the two toggles and Settings must NOT claim a shortcut. An
    // unbound key advertised to assistive tech is the opposite of the truth.
    expect(pageMenuContent).toContain('aria-keyshortcuts="Control+T"');
    const pageItems = [...pageMenuContent.matchAll(/<ContextMenuItem\b[^>]*>/g)].map(
      (m) => m[0],
    );
    const labelled = pageItems.filter((i) => i.includes("aria-keyshortcuts"));
    expect(labelled.length).toBe(2);
    for (const item of labelled) expect(item).toContain("Control+");
  });

  it("does not load the spellcheck dictionary before a right-click", () => {
    // The dictionary is ~540 KB of text. It must be fetched when a correction
    // can actually be wanted, which is a right-click on a word — never because
    // the pointer crossed the composer or it gained focus. A `focus` /
    // `mouseenter` prewarm is exactly what regressed here, and it cost 540 KB
    // on first hover, so both halves of the contract are pinned.
    //
    // Counted by CALL (`ensureSpellchecker(`), not by name: the bare identifier
    // also matches the import line, so counting it would permit two call sites
    // while reporting one. One call site means a second prewarm cannot hide
    // anywhere, which is what makes the binding check below a backstop rather
    // than the only defence.
    const callSites = composer.split("ensureSpellchecker(").length - 1;
    expect(callSites).toBe(1);
    for (const binding of ["onFocus", "onMouseEnter", "onPointerEnter", "onMouseOver"]) {
      expect(composerTrigger).not.toContain(binding);
    }
    // And that one call site is not itself sitting on the trigger, where a
    // handler could reach it without a right-click.
    expect(composerTrigger).not.toContain("ensureSpellchecker");
  });

  it("hides the whole spelling block when there is no offer", () => {
    // One guarded fragment: when the offer is null, neither the header nor a
    // suggestion row nor a stray separator is rendered.
    expect(composerContent).toContain("{spellingOffer && (");
  });

  it("renders suggestions above the cut/copy/paste entries", () => {
    // Order is a user-facing contract: corrections belong where the browser
    // puts them, before the text-editing actions.
    const blockAt = composerContent.indexOf("spellingOffer &&");
    const cutAt = composerContent.indexOf("copy.cut");
    const pasteAt = composerContent.indexOf("copy.pasteAsPlainText");
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
