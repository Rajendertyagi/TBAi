import { describe, expect, it } from "bun:test";
import { toolsConfig } from "@/config/tools";
import { boundText, countRows } from "./text-budget";

/**
 * The shared pre-render text budget.
 *
 * This is the module every rendered body in the app now goes through, so these
 * tests are the ones that would catch a regression in the terminal-adjacent
 * budgets too. The properties asserted here are the ones a `max-height` cannot
 * satisfy and a naive `slice()` gets wrong:
 *
 * - the bound is on the DATA, so `text` comes back within budget
 * - an under-budget body is returned byte for byte, so nothing changes for
 *   ordinary content
 * - the omission is reported exactly, because a marker that lies is worse than
 *   no marker
 * - the cut never corrupts a character
 */

const { toolBodyMaxLines, toolBodyMaxChars } = toolsConfig.limits;
const BUDGET = { maxLines: toolBodyMaxLines, maxChars: toolBodyMaxChars };

/** `n` numbered lines, so a specific row can be looked for by its content. */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
}

describe("text budget: a body that fits is untouched", () => {
  it("returns a small body byte for byte", () => {
    const text = lines(10);
    const bounded = boundText(text, BUDGET);
    expect(bounded.text).toBe(text);
    expect(bounded.truncated).toBe(false);
    expect(bounded.omitted).toEqual({ lines: 0, chars: 0 });
  });

  it("leaves an empty body alone", () => {
    const bounded = boundText("", BUDGET);
    expect(bounded.text).toBe("");
    expect(bounded.truncated).toBe(false);
  });

  it("renders a body AT the line limit completely", () => {
    // The off-by-one case in the direction that would silently cut a body that
    // only just fit.
    const text = lines(toolBodyMaxLines);
    expect(boundText(text, BUDGET).truncated).toBe(false);
  });

  it("renders a body AT the character limit completely", () => {
    const text = "x".repeat(toolBodyMaxChars);
    const bounded = boundText(text, BUDGET);
    expect(bounded.truncated).toBe(false);
    expect(bounded.text.length).toBe(text.length);
  });

  it("leaves a body whose trailing newline puts it over the row count alone", () => {
    // A trailing newline terminates the last row rather than starting a new
    // one. Counting it charged a row of budget to whitespace that paints
    // nothing, which made the boundary depend on invisible trailing whitespace.
    const text = `${lines(toolBodyMaxLines)}\n`;
    expect(boundText(text, BUDGET).truncated).toBe(false);
  });
});

describe("text budget: an oversized body is bounded", () => {
  it("cuts on a row boundary, so no kept row is ever half a row", () => {
    const text = lines(toolBodyMaxLines + 25);
    const original = text.split("\n");
    boundText(text, BUDGET)
      .text.split("\n")
      .forEach((row, i) => expect(row).toBe(original[i]));
  });

  it("reports how many whole rows went missing", () => {
    expect(boundText(lines(toolBodyMaxLines + 25), BUDGET).omitted.lines).toBe(25);
  });

  it("cuts a single enormous row even though it is only one row", () => {
    // The case a row count cannot see: a minified bundle, a base64 blob, a
    // one-line JSON payload.
    const text = "x".repeat(toolBodyMaxChars + 5000);
    const bounded = boundText(text, BUDGET);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text.length).toBeLessThanOrEqual(toolBodyMaxChars);
  });

  it("reports a mid-row cut as characters, with no row claimed missing", () => {
    const bounded = boundText("x".repeat(toolBodyMaxChars + 5000), BUDGET);
    expect(bounded.omitted.lines).toBe(0);
    // A LOWER BOUND, deliberately. The body is one row of 267 144 units and the
    // budget measured it against a 262 145-unit window, so the reported figure
    // is the window's overhang rather than all 5 000 removed characters. Counting
    // the rest would mean walking the whole row, which is the cost this budget
    // exists to avoid. The copy therefore uses this as a yes/no, never as a
    // number to print.
    expect(bounded.omitted.chars).toBeGreaterThan(0);
    expect(bounded.omitted.chars).toBeLessThan(5000);
  });

  it("always returns something for a non-empty oversized body", () => {
    // An empty body reads as "this tool returned nothing", which is a very
    // different fact from "this tool returned too much to show".
    for (const text of ["x".repeat(toolBodyMaxChars + 1), lines(toolBodyMaxLines + 1)]) {
      expect(boundText(text, BUDGET).text.length).toBeGreaterThan(0);
    }
  });

  it("never claims to have truncated while reporting nothing removed", () => {
    for (const text of [
      lines(toolBodyMaxLines + 1),
      "x".repeat(toolBodyMaxChars + 1),
      `${"y\n".repeat(toolBodyMaxLines + 40)}`,
    ]) {
      const bounded = boundText(text, BUDGET);
      if (bounded.truncated) {
        expect(bounded.omitted.lines + bounded.omitted.chars).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the part of the last row that fits, rather than dropping it whole", () => {
    // The window is deliberately one unit larger than the budget so an
    // overflowing body is detectable, which means the rows inside it always
    // total one unit too many. A cut that only accepted whole rows dropped that
    // last row in full and reported it as a dropped row, losing up to a whole
    // row of showable content every time the character cap fired. Found by an
    // existing test on a serialised object: a 5 KB JSON body rendered as `{`.
    const text = `{\n  "blob": "${"x".repeat(5000)}"\n}`;
    const bounded = boundText(text, { maxLines: 2000, maxChars: 2000 });
    expect(bounded.truncated).toBe(true);
    // The whole budget is used, not one row of it.
    expect(bounded.text.length).toBe(2000);
    expect(bounded.text.startsWith('{\n  "blob": "x')).toBe(true);
  });

  it("still cuts a single row longer than the whole budget, partially", () => {
    const bounded = boundText("y".repeat(5000), { maxLines: 2000, maxChars: 2000 });
    expect(bounded.text.length).toBe(2000);
    expect(bounded.omitted.lines).toBe(0);
  });

  it("always hands downstream a payload within BOTH budgets", () => {
    // The property the whole thing exists for, over a spread of shapes rather
    // than one.
    for (const text of [
      lines(toolBodyMaxLines * 3),
      "x".repeat(toolBodyMaxChars * 2),
      `${lines(toolBodyMaxLines)}\n${"z".repeat(toolBodyMaxChars)}`,
      "\n".repeat(toolBodyMaxChars),
    ]) {
      const bounded = boundText(text, BUDGET);
      expect(bounded.text.length).toBeLessThanOrEqual(toolBodyMaxChars);
      expect(countRows(bounded.text)).toBeLessThanOrEqual(toolBodyMaxLines);
    }
  });

  it("respects a caller-supplied budget, so one helper serves every body", () => {
    const tiny = { maxLines: 2, maxChars: 20 };
    const bounded = boundText(lines(50), tiny);
    expect(countRows(bounded.text)).toBeLessThanOrEqual(2);
    expect(bounded.text.length).toBeLessThanOrEqual(20);
  });

  it("floors a nonsense budget at one rather than producing nothing", () => {
    for (const budget of [
      { maxLines: 0, maxChars: 0 },
      { maxLines: -5, maxChars: -5 },
    ]) {
      const bounded = boundText(lines(10), budget);
      expect(bounded.truncated).toBe(true);
      expect(bounded.text.length).toBeGreaterThan(0);
    }
  });
});

describe("text budget: the cut never corrupts a character", () => {
  it("does not leave a lone surrogate when the boundary splits a pair", () => {
    // The character budget counts UTF-16 units, so it can land between the two
    // halves of an astral character. A high surrogate at the end of the result
    // is unpaired by definition and renders as U+FFFD.
    const pair = "😀"; // one astral character, two UTF-16 units
    const text = pair.repeat(200);
    const bounded = boundText(text, { maxLines: 1000, maxChars: 101 });
    const last = bounded.text.charCodeAt(bounded.text.length - 1);
    const isLoneHighSurrogate = last >= 0xd800 && last <= 0xdbff;
    expect(isLoneHighSurrogate).toBe(false);
  });

  it("counts the dropped surrogate as removed, not as free", () => {
    // A budget of 101 units against 2-unit characters cuts inside the 51st
    // pair. Both halves of that pair are gone, so both are counted: the
    // character the slice kept, and the surrogate the safety step removed.
    const text = "😀".repeat(200);
    const bounded = boundText(text, { maxLines: 1000, maxChars: 101 });
    expect(bounded.text).toBe("😀".repeat(50));
    expect(bounded.omitted.chars).toBe(2);
  });

  it("leaves a well-formed pair intact when the budget lands on its boundary", () => {
    // The budget lands exactly between two characters, so there is nothing to
    // repair and the text comes back whole.
    const text = "😀".repeat(200);
    const bounded = boundText(text, { maxLines: 1000, maxChars: 100 });
    expect(bounded.text).toBe("😀".repeat(50));
  });
});

describe("text budget: row counting", () => {
  // The counting rule is the one the trailing-newline behaviour rests on, so it
  // is pinned directly rather than only through the bound.
  const cases: readonly (readonly [string, number])[] = [
    ["", 0],
    ["a", 1],
    ["a\n", 1],
    ["a\nb", 2],
    ["a\nb\n", 2],
    ["\n", 1],
    ["\n\n", 2],
  ];

  for (const [text, rows] of cases) {
    it(`counts ${JSON.stringify(text)} as ${rows} row(s)`, () => {
      expect(countRows(text)).toBe(rows);
    });
  }
});
