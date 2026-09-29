/**
 * The shared pre-render text budget.
 *
 * ## Why this exists
 *
 * Every rendered body in a chat timeline needs the same answer to the same
 * question: how much of this text may I paint? The terminal block, the diff
 * preview, a Markdown code fence and a tool result all ask it, and each of them
 * used to answer differently — some with a limit, some with a CSS
 * `max-height`, and the browser tool with a hardcoded `slice(0, 4000)` that
 * told the reader nothing at all. This module is the one place that answers, so
 * a new body cannot quietly invent a second rule.
 *
 * A CSS `max-height` is explicitly not an answer. It clips what has already
 * been paid for: the string was serialised, the DOM was built, the layout ran.
 * The bound has to land on the data.
 *
 * ## Shape of the bound
 *
 * Two limits, because each catches what the other cannot. `maxLines` bounds a
 * long-but-narrow file; `maxChars` bounds a single enormous line - a minified
 * bundle, a base64 blob, a one-line JSON payload - which no line count would
 * ever notice. The same pairing every other budget in the app already uses.
 *
 * EITHER limit is enough. "Only truncate when both are exceeded" is a
 * per-body bypass, and it is the tempting reading of "either".
 *
 * Head-only, never head+tail. The diff preview trims both ends because a
 * change can be anywhere in a file; a truncated result body is not that, and a
 * tail of an arbitrary body is arbitrary. The durable tool result is
 * authoritative regardless - this shapes what a card paints, never what is
 * stored.
 *
 * ## Two things this gets right that a naive split does not
 *
 * A **trailing newline is not a row.** Body text almost always ends with one,
 * and `split("\n")` turns it into a final empty segment. Counting it charges a
 * row of budget to whitespace that paints nothing, which makes the boundary
 * depend on invisible trailing whitespace - a body that only just fits is cut,
 * and the same body without the newline is not. Found in the browser, not on
 * paper.
 *
 * The cut never **splits a surrogate pair.** The character budget counts UTF-16
 * units, so it can land between the two halves of an astral character. Cutting
 * there leaves a lone surrogate that renders as the replacement glyph, and the
 * character is counted as removed, so this is the one place the reported
 * omission is deliberately nudged up by one.
 *
 * Ported from the OpenChamber reference, which solves the same problem with
 * `capToolOutputText` and `getToolDiffPreviewText`
 * (`packages/ui/src/components/chat/message/`). Two differences, both
 * deliberate: they return a string with the notice baked into the text, which
 * corrupts a JSON body and makes the notice indistinguishable from content;
 * this returns the omission separately so the caller can render it as its own
 * element. And they skip highlighting a large code fence silently
 * (`markdownCore.ts`, `CODE_HIGHLIGHT_LINE_LIMIT = 1200`) rather than saying
 * so, which reads as a highlighting failure rather than a deliberate choice.
 */

/** What a bound removed, so a UI can name it exactly rather than gesture at it. */
export interface OmittedContent {
  /** Whole rows not shown. 0 when only part of a row was cut. */
  readonly lines: number;
  /**
   * Characters cut from the row that is still shown, rather than from rows that
   * were dropped whole (those are counted in `lines`).
   *
   * This is a LOWER BOUND when the character limit is what fired, because the
   * true length of an oversized row is deliberately not scanned - walking a
   * 50 MB single-row body to count its length is the exact cost this budget
   * exists to prevent. Callers therefore use it as a yes/no ("was a row cut
   * short?"), not as a number to print.
   */
  readonly chars: number;
}

/** A bounded payload plus what the bound removed. */
export interface BoundedText {
  /** What may be rendered. Never larger than the budget. */
  readonly text: string;
  /** True when `text` is not the whole input. */
  readonly truncated: boolean;
  /** What was removed. Never both-zero while `truncated` is true. */
  readonly omitted: OmittedContent;
}

/** The two limits, as plain numbers so callers stay framework-free. */
export interface TextBudget {
  readonly maxLines: number;
  readonly maxChars: number;
}

/**
 * Count the rows this text would paint, without allocating a row array.
 *
 * A trailing newline terminates the last row rather than starting a new one, so
 * `"a\n"` is one row and `"a\nb"` is two. The scan is a single `indexOf` walk
 * with no allocation, which is what makes it affordable to run over a body far
 * larger than the budget; the expensive `split` below is only ever applied to a
 * bounded window.
 *
 * Exported because the trailing-newline rule is load-bearing and the browser
 * caught it once already: it is the difference between a body that only just
 * fits being cut and not.
 */
export function countRows(text: string): number {
  if (!text) return 0;
  let newlines = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    newlines += 1;
  }
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/**
 * Drop a trailing lone high surrogate, if the cut produced one.
 *
 * A high surrogate at the very end of the string is unpaired by definition -
 * its low half would have followed it. Left in place it renders as U+FFFD, so
 * a correct-looking bound produces a corrupted glyph.
 */
function withoutSplitSurrogate(text: string): string {
  if (!text) return text;
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/**
 * Apply a text budget.
 *
 * A body at or under both limits comes back UNCHANGED, byte for byte, so
 * ordinary content renders exactly as it did before.
 *
 * @param text - The full body text.
 * @param budget - Row and character limits; both are floored at 1.
 * @returns The bounded text and exactly what the bound removed.
 */
export function boundText(text: string, budget: TextBudget): BoundedText {
  const maxLines = Math.max(1, Math.floor(budget.maxLines));
  const maxChars = Math.max(1, Math.floor(budget.maxChars));

  if (!text) return { text, truncated: false, omitted: { lines: 0, chars: 0 } };
  if (countRows(text) <= maxLines && text.length <= maxChars) {
    return { text, truncated: false, omitted: { lines: 0, chars: 0 } };
  }

  // Never materialise the whole body as rows. A 50 MB result must not become a
  // 50 MB array of strings merely to be told it is over budget, so the row split
  // is applied to a window no larger than the character budget plus one unit.
  // A windowed cut cannot preserve a trailing newline, because whether the
  // original had one is no longer knowable - and it does not need to, since the
  // character limit is what governs in that case.
  const windowed = text.length > maxChars;
  const window = windowed ? text.slice(0, maxChars + 1) : text;
  const trailing = !windowed && window.endsWith("\n") ? "\n" : "";
  const rows = window.slice(0, window.length - trailing.length).split("\n");

  // Row cap first, so a long-but-narrow file is cut on a row boundary and the
  // result stays readable code rather than a mid-token slice.
  let kept = rows.length > maxLines ? rows.slice(0, maxLines) : rows;
  const keptChars = () => kept.join("\n").length + trailing.length;
  let omittedChars = 0;

  // Then the character cap, the only one of the pair that catches a single huge
  // row. Cut on a row boundary where one exists, so the last kept row is whole.
  if (keptChars() > maxChars) {
    const bounded: string[] = [];
    let used = 0;
    for (const row of kept) {
      const separator = bounded.length > 0 ? 1 : 0;
      const room = maxChars - used - separator;
      if (row.length <= room) {
        bounded.push(row);
        used += row.length + separator;
        continue;
      }
      // This row does not fit whole. Take the part of it that does, rather than
      // dropping the row entirely.
      //
      // The window above is `maxChars + 1` units precisely so that an
      // overflowing body is detectable, which means the rows inside it always
      // total one unit more than the budget. A cut that only ever kept whole
      // rows therefore dropped that last row in full - losing up to a whole row
      // of showable content every time the character cap fired, and reporting it
      // as a dropped row. An existing test on a serialised object caught it: a
      // 5 KB JSON body rendered as `{` and a note.
      if (room > 0) {
        bounded.push(row.slice(0, room));
        used += room;
      }
      break;
    }
    // `maxChars` is floored at 1 and the first row is always offered the whole
    // remaining budget, so a non-empty `kept` can never leave `bounded` empty -
    // an empty body would read as "this tool returned nothing" rather than "this
    // tool returned too much to show", and those are very different facts.
    omittedChars = Math.max(
      0,
      keptChars() - (bounded.join("\n").length + trailing.length),
    );
    kept = bounded;
  }

  const cut = kept.join("\n") + trailing;
  const safe = withoutSplitSurrogate(cut);
  // A dropped surrogate is a removed character, so report it rather than
  // undercounting a body the reader can see is short.
  omittedChars += cut.length - safe.length;

  return {
    text: safe,
    truncated: true,
    omitted: { lines: countRows(text) - kept.length, chars: omittedChars },
  };
}