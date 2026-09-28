/**
 * Word extraction and replacement for the composer's spelling menu.
 *
 * Split out of the menu component so the caret arithmetic is testable on its
 * own: it is the part most likely to go wrong, and "did we replace the right
 * characters" is not observable from a rendered menu.
 *
 * The composer's textarea is authoritative. Callers must capture
 * `selectionStart`/`selectionEnd` during the context-menu event and pass the
 * resulting offsets in, because Radix moves focus and collapses the selection
 * before its own menu logic runs.
 */

/**
 * A word located in the composer's text, with the offsets needed to replace it
 * and to put the caret back afterwards.
 */
export interface WordAtCaret {
  /** The word exactly as typed, preserving its capitalisation. */
  readonly word: string;
  /** Index of the word's first character within the full composer text. */
  readonly start: number;
  /** Index just past the word's last character. */
  readonly end: number;
}

/**
 * The editor state captured when the menu was invoked.
 *
 * Both offsets are kept, not just the collapsed caret: an active selection may
 * cover more than one word, and the caller must know that before choosing
 * which word to correct.
 */
export interface CaretSnapshot {
  /** `textarea.selectionStart` at capture time. */
  readonly selectionStart: number;
  /** `textarea.selectionEnd` at capture time. */
  readonly selectionEnd: number;
}

/**
 * Characters that make up a word.
 *
 * Letters plus apostrophes, so `don't` and `it's` stay whole. Hyphens are
 * deliberately excluded, splitting `state-of-the-art` into three words, which
 * is what a browser spellchecker does.
 */
const WORD_CHAR = /[\p{L}']/u;

/** Minimum length worth offering a correction for. */
const MIN_CORRECTABLE_LENGTH = 2;

/**
 * Finds the word to offer spelling corrections for.
 *
 * Rules, in the order they apply:
 * - a word selected by a range is used as-is, so correcting a highlighted
 *   word never surprises by targeting a neighbour;
 * - a caret sitting inside a word yields that word;
 * - a caret between words yields the word immediately before it, matching
 *   browser behaviour;
 * - anything else (whitespace, punctuation, an empty box) yields `null`, and
 *   the menu shows no spelling section.
 *
 * @param text - Full composer text at capture time.
 * @param caret - Selection offsets captured during the context-menu event.
 * @returns The target word, or `null` when there is nothing to correct.
 */
export function findWordAtCaret(
  text: string,
  caret: CaretSnapshot,
): WordAtCaret | null {
  const start = Math.min(caret.selectionStart, caret.selectionEnd);
  const end = Math.max(caret.selectionStart, caret.selectionEnd);

  if (start === end) {
    // Collapsed caret. A caret between two words belongs to the one already
    // typed — that is what a browser does, and it is the word the user has
    // actually finished writing. With nothing to the left (start of the text),
    // fall through to the word about to be typed.
    const preceding = wordBefore(text, start);
    if (preceding) return preceding;
    return wordAtOrAfter(text, start);
  }

  // An active range: use it directly, clamped to the surrounding word so a
  // selection that includes trailing punctuation still corrects one word.
  const expanded = expandToWordBounds(text, start);
  const word = text.slice(expanded.start, expanded.end);
  if (word.length < MIN_CORRECTABLE_LENGTH) return null;
  return { word, start: expanded.start, end: expanded.end };
}

/**
 * The word ending at or immediately before `index`, crossing a single run of
 * separators. Returns `null` when nothing word-like precedes the caret, or when
 * the preceding word is too short to correct.
 */
function wordBefore(text: string, index: number): WordAtCaret | null {
  if (index <= 0) return null;
  // Walk back over any separators, then over the word itself.
  let cursor = index;
  while (cursor > 0 && !WORD_CHAR.test(text[cursor - 1] ?? "")) cursor--;
  if (cursor === index) return null;
  const start = scanStart(text, cursor);
  return toWordAtCaret(text, start, cursor);
}

/**
 * The word starting at or containing `index`. Used when no word precedes the
 * caret, i.e. at the very start of the text.
 */
function wordAtOrAfter(text: string, index: number): WordAtCaret | null {
  const start = scanStart(text, index);
  const end = scanEnd(text, start);
  return toWordAtCaret(text, start, end);
}

/**
 * Resolves a selection range to the single word it starts on.
 *
 * Only `start` matters: the word is grown outwards from there, so a selection
 * that runs past the word into trailing punctuation, or that spans several
 * words, still corrects the word the user actually began selecting. Anything
 * else risks rewriting text the user did not mean to replace.
 */
function expandToWordBounds(text: string, start: number): { start: number; end: number } {
  const wordStart = scanStart(text, start);
  return { start: wordStart, end: scanEnd(text, wordStart) };
}

/** Walks backwards from `index` over word characters. */
function scanStart(text: string, index: number): number {
  let cursor = Math.min(Math.max(index, 0), text.length);
  while (cursor > 0 && WORD_CHAR.test(text[cursor - 1] ?? "")) cursor--;
  return cursor;
}

/** Walks forwards from `index` over word characters. */
function scanEnd(text: string, index: number): number {
  let cursor = Math.max(0, index);
  while (cursor < text.length && WORD_CHAR.test(text[cursor] ?? "")) cursor++;
  return cursor;
}

/** Builds a `WordAtCaret`, or `null` when the run is too short to correct. */
function toWordAtCaret(
  text: string,
  start: number,
  end: number,
): WordAtCaret | null {
  if (end - start < MIN_CORRECTABLE_LENGTH) return null;
  return { word: text.slice(start, end), start, end };
}

/**
 * Swaps one word for a correction, leaving the rest of the text untouched.
 *
 * @param text - Full composer text.
 * @param target - The word span returned by {@link findWordAtCaret}.
 * @param replacement - The correction to substitute.
 * @returns The rewritten text, and the caret offset that should follow the
 *   inserted word.
 */
export function replaceWord(
  text: string,
  target: WordAtCaret,
  replacement: string,
): { text: string; caret: number } {
  const next =
    text.slice(0, target.start) + replacement + text.slice(target.end);
  return { text: next, caret: target.start + replacement.length };
}
