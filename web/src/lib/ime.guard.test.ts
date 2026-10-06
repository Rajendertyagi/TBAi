import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Stops an IME guard being silently deleted.
 *
 * ## Why a source-text test at all
 *
 * The behaviour itself is covered by `ime.test.ts`. What is NOT covered is
 * someone removing a guard from a *call site* — the unit tests keep passing,
 * typecheck passes, and the bug ships silently. That is not hypothetical: the
 * four rename handlers in this list had no guard at all for the life of the
 * feature, and nothing failed.
 *
 * So this asserts the guard is still REFERENCED in each file. Crude, and
 * deliberately so — it costs one regex and it fails loudly. OpenChamber uses the
 * same technique in `ime.commentInputs.test.ts`, asserting the guard expression
 * is still present in specific files.
 *
 * ## How to use it when adding a site
 *
 * Add the file here and add the import + call in the same change. If a guard
 * genuinely does not belong (a surface where no composition can be open — a
 * button bar, a focus-trapped overlay with no text input), do NOT add it, and do
 * not add the file here either.
 */

/**
 * Files where a keydown handler commits, saves, navigates or dismisses, AND which
 * contain a text input a composition can be open in.
 */
const GUARDED_SITES: ReadonlyArray<{ file: string; helper: string; why: string }> = [
  { file: "web/src/features/chat/components/ChatHeader.tsx", helper: "isPlainEnter", why: "renames a chat" },
  { file: "web/src/features/sidebar/components/SidebarThreadRow.tsx", helper: "isPlainEnter", why: "renames a chat" },
  { file: "web/src/features/sidebar/components/FolderConversationRow.tsx", helper: "isPlainEnter", why: "renames a conversation" },
  { file: "web/src/features/sidebar/components/FolderHeader.tsx", helper: "isPlainEnter", why: "renames a folder" },
  { file: "web/src/components/shared/directory-browser.tsx", helper: "isPlainEnter", why: "navigates to a typed path" },
  { file: "web/src/features/providers/ProviderDialog.tsx", helper: "isPlainEnter", why: "commits a context-window value" },
  { file: "web/src/features/providers/ProviderDialog.tsx", helper: "isPlainEscape", why: "discards a context-window edit" },
  { file: "web/src/components/LeftEdgeChrome.tsx", helper: "isPlainEscape", why: "closes the search box" },
  { file: "web/src/features/opencode/OpenCodeChipShared.tsx", helper: "isPlainEscape", why: "closes the menu from a document listener" },
  { file: "web/src/components/ChromeShortcuts.tsx", helper: "isComposing", why: "Ctrl/Cmd chords fire during composition too" },
  { file: "web/src/features/opencode/V2FormCard.tsx", helper: "isIMECompositionEvent", why: "advances a multi-step question" },
  // The one that was missed the first time round. It sits inside the dock above
  // and handles Enter BEFORE delegating, so the dock's guard could never see it.
  { file: "web/src/features/opencode/V2OptionControl.tsx", helper: "isPlainEnter", why: "commits the multiselect custom-answer draft" },
  // Event-signal-only before, which left the Safari ordering case open: the Enter
  // that ENDED a composition selected a model out of a half-typed query.
  { file: "web/src/components/chat/ModelOptionList.tsx", helper: "isComposing", why: "selects a model from a search box" },
];

/**
 * Deliberately NOT in the list. Each reason below was verified by reading the
 * file, not assumed — the previous version of this comment asserted all four
 * without opening a single one, and two of the claims were wrong.
 *
 *   mermaid-diagram.tsx  — Escape closes a focus-trapped zoom overlay. Verified:
 *                          zero `<input>`, `<textarea>` or `contentEditable` in the
 *                          file, so no composition can be open.
 *   LogsPanel.tsx        — bails when the target is an input/textarea/select, and
 *                          handles only `/` and `End`. A composition can only be
 *                          open in a text field, so the target check already
 *                          covers the Safari ordering case.
 *   SidebarSectionOrderControl.tsx — Alt+ArrowUp/Down reordering, and verified to
 *                          contain no text entry at all. No Enter or Escape.
 *   QuickMessagesPage.tsx — Enter/Space on a list row, guarded by
 *                          `event.target !== event.currentTarget`, so it ignores
 *                          anything originating in a child field.
 *
 * NOTE on ModelOptionList.tsx, which used to sit in this list as "already guards
 * composition itself". It did guard, but against the EVENT flag only — and on
 * Safari that flag is already false on the keydown that ends a composition, so
 * it selected a model the reader never chose. It has been fixed and moved up
 * into GUARDED_SITES. Do not move anything back down here on a casual read.
 */

function read(file: string): string {
  return readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
}

/**
 * Drop comments, so a check for a code pattern cannot trip over prose describing
 * it.
 *
 * This is not hypothetical: the explanation beside the multiselect draft's Enter
 * handler has to name the unguarded form it replaced (`event.key === "Enter"`),
 * and that sentence alone failed the bare-comparison check. The fix that was
 * available at the time was to delete the explanation -- which is precisely the
 * wrong incentive. A comment cannot dispatch a key, so it must not be evidence.
 *
 * Known imprecision: `//` immediately after a `:` is left alone so that URLs in
 * strings survive. That can, in principle, hide a comparison that followed one
 * on the same line. Accepted: a false positive that pressures people into
 * deleting comments is a worse failure than a rare missed detection, and every
 * site in {@link GUARDED_SITES} is also covered by a behavioural or
 * presence test.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("IME guards are present at every commit-or-dismiss keydown site", () => {
  for (const { file, helper, why } of GUARDED_SITES) {
    it(`${file} uses ${helper} — ${why}`, () => {
      const source = read(file);
      expect(source, `${file} should import ${helper}`).toContain(helper);
    });
  }
});

describe("no bare `===` key comparison survives on a guarded site", () => {
  // The helpers exist so that `e.key === "Enter"` becomes a greppable smell: if a
  // bare `===` is still dispatching a key on one of these files, the guard was
  // added ALONGSIDE the original rather than replacing it, and the unguarded
  // branch is the one that runs.
  //
  // Deliberately `===` only. The `!==` early-return form
  // (`if (e.key !== "Enter" || isIMECompositionEvent(e)) return;`, used by
  // V2FormCard) is a correct guard, not a bypass, so flagging it would push the
  // next reader toward the worse version.
  for (const { file } of GUARDED_SITES) {
    it(`${file} dispatches Enter/Escape through the helpers`, () => {
      // Comments stripped: a comment may name the unguarded form in order to
      // explain why it is gone, and that is not a regression. See
      // `stripComments`.
      const source = stripComments(read(file));
      const bare = [...source.matchAll(/\.key\s*===\s*["'](Enter|Escape)["']/g)].map((m) => m[1]);
      expect(bare, `${file} still compares .key directly: ${bare.join(", ")}`).toEqual([]);
    });
  }
});

describe("the helper module is the one the tests pin", () => {
  it("still exports every helper the guarded sites import", () => {
    const ime = read("web/src/lib/ime.ts");
    for (const helper of ["isIMECompositionEvent", "isComposing", "isPlainEnter", "isPlainEscape"]) {
      expect(ime, `lib/ime.ts should export ${helper}`).toMatch(
        new RegExp(`export function ${helper}\\b|export (const|function) ${helper}\\b`),
      );
    }
  });

  it("still exports createCompositionTracker, which the Safari fix depends on", () => {
    // If this is removed, the deferred reset goes with it and Safari regresses to
    // letting the composition-ending Enter through.
    expect(read("web/src/lib/ime.ts")).toContain("export function createCompositionTracker");
  });
});