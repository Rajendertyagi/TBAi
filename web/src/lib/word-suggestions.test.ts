import { describe, expect, test } from "bun:test";
import { findWordAtCaret, replaceWord } from "./word-suggestions";

/**
 * The caret arithmetic behind the composer's spelling menu.
 *
 * Every case here is a character range, so the assertions quote offsets
 * directly. That makes a regression obvious: an off-by-one in the boundary
 * scan shows up as a word that starts or stops one character early, which is
 * exactly the failure that would silently eat a letter from a prompt.
 */
describe("findWordAtCaret", () => {
  test("finds the word the caret sits inside", () => {
    // "coztom" spans 0..6; caret at 3 is between 'z' and 't'.
    const found = findWordAtCaret("coztom", { selectionStart: 3, selectionEnd: 3 });
    expect(found).toEqual({ word: "coztom", start: 0, end: 6 });
  });

  test("finds the word in a longer sentence", () => {
    // "the coztom value" — the typo starts at index 4.
    const found = findWordAtCaret("the coztom value", { selectionStart: 6, selectionEnd: 6 });
    expect(found).toEqual({ word: "coztom", start: 4, end: 10 });
  });

  test("uses the preceding word when the caret sits after a space", () => {
    // "the coztom value": caret at 11 is just past the space following the
    // typo, i.e. between two words. Browsers pick the word before.
    const found = findWordAtCaret("the coztom value", { selectionStart: 11, selectionEnd: 11 });
    expect(found).toEqual({ word: "coztom", start: 4, end: 10 });
  });

  test("uses the following word when the caret precedes a space", () => {
    // Caret at 10 is immediately after "coztom" and before the space, so it
    // is still inside that word.
    const found = findWordAtCaret("the coztom value", { selectionStart: 10, selectionEnd: 10 });
    expect(found).toEqual({ word: "coztom", start: 4, end: 10 });
  });

  test("treats an apostrophe as part of the word", () => {
    // "doesn't" is one word, not "does" plus a stray "t".
    const found = findWordAtCaret("i don't think", { selectionStart: 4, selectionEnd: 4 });
    expect(found).toEqual({ word: "don't", start: 2, end: 7 });
  });

  test("splits hyphenated words", () => {
    // "state-of-the-art" breaks at each hyphen; caret at 3 is inside "state".
    const found = findWordAtCaret("state-of-the-art", { selectionStart: 3, selectionEnd: 3 });
    expect(found).toEqual({ word: "state", start: 0, end: 5 });
  });

  test("finds the part after a hyphen", () => {
    // "state-of-the-art": s0 t1 a2 t3 e4 -5 o6 f7 -8 t9 h10 e11 ...
    // Caret at 10 is inside "the", the segment between the 2nd and 3rd hyphens.
    const found = findWordAtCaret("state-of-the-art", { selectionStart: 10, selectionEnd: 10 });
    expect(found).toEqual({ word: "the", start: 9, end: 12 });
  });

  test("uses a selected range as the target word", () => {
    // A highlighted word is corrected as-is, so the offsets match the
    // selection rather than a scan outward from the caret.
    const found = findWordAtCaret("the coztom value", { selectionStart: 4, selectionEnd: 10 });
    expect(found).toEqual({ word: "coztom", start: 4, end: 10 });
  });

  test("trims punctuation from a selection before correcting", () => {
    // Right-clicking a quoted word should still correct the word, not the
    // quote mark. `say "coztom", ok` is s0 a1 y2 ' '3 "4 c5 ... m10 "11 ,12,
    // so a selection of 5..13 (through the closing quote) trims to `coztom`.
    const found = findWordAtCaret('say "coztom", ok', { selectionStart: 5, selectionEnd: 13 });
    expect(found).toEqual({ word: "coztom", start: 5, end: 11 });
  });

  test("returns the following word when the caret is at the very start", () => {
    // Nothing precedes the caret, so the word about to be typed is the one
    // under it.
    const found = findWordAtCaret("coztom", { selectionStart: 0, selectionEnd: 0 });
    expect(found).toEqual({ word: "coztom", start: 0, end: 6 });
  });

  test("returns null in empty text", () => {
    expect(findWordAtCaret("", { selectionStart: 0, selectionEnd: 0 })).toBeNull();
  });

  test("returns null on a space far from any word", () => {
    expect(findWordAtCaret("a  b", { selectionStart: 2, selectionEnd: 2 })).toBeNull();
  });

  test("returns null for a single-character word", () => {
    // Too short to correct meaningfully; the menu stays silent.
    expect(findWordAtCaret("a b", { selectionStart: 0, selectionEnd: 0 })).toBeNull();
  });

  test("tolerates offsets past the end of the text", () => {
    // A stale selection offset must not throw. Clamping lands on the last word
    // rather than inventing one, which is the useful outcome.
    const found = findWordAtCaret("the coztom", { selectionStart: 99, selectionEnd: 99 });
    expect(found).toEqual({ word: "coztom", start: 4, end: 10 });
  });

  test("normalises a backwards selection", () => {
    // Some browsers report selectionStart > selectionEnd; the word is still
    // found rather than silently producing no suggestions.
    const found = findWordAtCaret("the coztom value", { selectionStart: 10, selectionEnd: 4 });
    expect(found).toEqual({ word: "coztom", start: 4, end: 10 });
  });

  test("handles a word at the very end of the text", () => {
    const found = findWordAtCaret("fix coztom", { selectionStart: 7, selectionEnd: 7 });
    expect(found).toEqual({ word: "coztom", start: 4, end: 10 });
  });
});

describe("replaceWord", () => {
  test("replaces only the target word", () => {
    // The bug this guards: a naive implementation that rebuilds the whole
    // string from the word alone would drop "the " and " value".
    const target = findWordAtCaret("the coztom value", { selectionStart: 6, selectionEnd: 6 })!;
    const { text } = replaceWord("the coztom value", target, "custom");
    expect(text).toBe("the custom value");
  });

  test("reports the caret offset just after the replacement", () => {
    // The typo starts at index 4 and "custom" is 6 characters, so the caret
    // belongs at 10 — immediately after the corrected word.
    const target = findWordAtCaret("the coztom value", { selectionStart: 6, selectionEnd: 6 })!;
    const { text, caret } = replaceWord("the coztom value", target, "custom");
    expect(caret).toBe(10);
    // Non-vacuity: the caret really does sit immediately after the new word.
    expect(text.slice(0, caret)).toBe("the custom");
    expect(text[caret]).toBe(" ");
  });

  test("handles a replacement that changes length", () => {
    // "custom" (6) from "coztom" (6) is same-length; "separate" (8) is not.
    const target = findWordAtCaret("a seperate b", { selectionStart: 4, selectionEnd: 4 })!;
    const { text, caret } = replaceWord("a seperate b", target, "separate");
    expect(text).toBe("a separate b");
    expect(caret).toBe(10);
    expect(text.slice(0, caret)).toBe("a separate");
  });

  test("leaves surrounding whitespace and punctuation intact", () => {
    const target = findWordAtCaret('say "coztom", ok', { selectionStart: 6, selectionEnd: 6 })!;
    const { text } = replaceWord('say "coztom", ok', target, "custom");
    expect(text).toBe('say "custom", ok');
  });

  test("replaces a word that is the entire text", () => {
    const target = findWordAtCaret("coztom", { selectionStart: 3, selectionEnd: 3 })!;
    const { text, caret } = replaceWord("coztom", target, "custom");
    expect(text).toBe("custom");
    expect(caret).toBe(6);
  });

  test("preserves a leading capital when replacing mid-sentence", () => {
    const target = findWordAtCaret("Fix the Coztom bug", { selectionStart: 9, selectionEnd: 9 })!;
    expect(target.word).toBe("Coztom");
    const { text } = replaceWord("Fix the Coztom bug", target, "Custom");
    expect(text).toBe("Fix the Custom bug");
  });
});
