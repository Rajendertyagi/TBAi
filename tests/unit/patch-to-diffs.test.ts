/**
 * `patchToCodeDiffs` render-budget tests.
 *
 * The cap is display-only: it bounds how much of ONE file's diff a card paints,
 * never the durable result. Two things therefore have to hold at once, and this
 * file proves both:
 *
 *   1. A patch INSIDE the budget comes back byte-for-byte as the plain parse —
 *      no reordering, no dropped rows, no marker. The budget is a ceiling, not a
 *      new rendering shape; if this file's cases fail, the common path regressed.
 *   2. A patch OVER the budget keeps its head AND its tail, drops the middle,
 *      inserts exactly one marker row naming how many rows went missing, and
 *      leaves `additions` / `deletions` at the FULL patch's counts — those two
 *      are what the card's `+N -N` header shows, so re-deriving them from the
 *      window would misreport the change size.
 *
 * Budgets and the marker copy are read from `toolsConfig`, their single home, so
 * tuning a cap is a one-file change and these cases follow it.
 */
import { describe, it, expect } from "bun:test";
import { patchToCodeDiffs } from "../../web/src/lib/patch-to-diffs";
import { toolsConfig } from "../../web/src/config/tools";
import {
  prettyPatch,
  sortingScriptLoosePatch,
  sortingScriptPatch,
} from "../../web/tests/fixtures/diff-samples";

const MAX_LINES = toolsConfig.limits.diffPreviewMaxLines;
const MAX_CHARS = toolsConfig.limits.diffPreviewMaxChars;
/** Per-side share the head and the tail each get. */
const SIDE_LINES = Math.floor(MAX_LINES / 2);
const SIDE_CHARS = Math.floor(MAX_CHARS / 2);
/** The marker's own text for `count` dropped rows. */
const marker = (count: number) => toolsConfig.copy.status.diffRowsOmitted(count);

/**
 * A single-file strict unified patch of `count` added rows, each named
 * `rowText(i)`. Every row is distinct so a duplication or a loss is visible.
 */
const strictAddPatch = (count: number, rowText: (i: number) => string = (i) => `row-${i}`) =>
  [
    "--- a/src/big.ts",
    "+++ b/src/big.ts",
    `@@ -0,0 +1,${count} @@`,
    ...Array.from({ length: count }, (_, i) => `+${rowText(i)}`),
    "",
  ].join("\n");

/** Additions/deletions counted straight off the patch text, independently. */
const countMarkers = (patch: string, markerChar: "+" | "-") =>
  patch
    .split("\n")
    .filter((line) => line.startsWith(markerChar) && !line.startsWith(markerChar.repeat(3)))
    .length;

describe("patchToCodeDiffs — within budget (unchanged)", () => {
  it("returns a real patch byte-for-byte as the plain parse", () => {
    expect(patchToCodeDiffs(sortingScriptPatch)).toEqual([
      {
        filename: "sorting_script_modified.py",
        additions: 1,
        deletions: 0,
        lines: [
          { kind: "context", text: 'print(f"\\nOriginal array: {numbers}")' },
          { kind: "context", text: "sorted_array = sort_func(numbers.copy())" },
          {
            kind: "context",
            text: 'print(f"Sorted array ({algorithm_name}): {sorted_array}")',
          },
          { kind: "added", text: "print('added line')" },
        ],
      },
    ]);
  });

  it("returns the loose (header-less) parse unchanged too", () => {
    const [file] = patchToCodeDiffs(sortingScriptLoosePatch);
    expect(file.filename).toBe("");
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(0);
    expect(file.lines).toHaveLength(4);
    expect(file.lines.map((line) => line.text)).not.toContain(marker(1));
  });

  it("leaves every file of a multi-file patch alone", () => {
    const files = patchToCodeDiffs(prettyPatch);
    expect(files.map((f) => [f.filename, f.additions, f.deletions, f.lines.length])).toEqual([
      ["src/hello.ts", 2, 1, 6],
      ["src/index.ts", 2, 1, 5],
    ]);
    // The budget is PER FILE, so a second file never pushes the first over.
    expect(files.flatMap((f) => f.lines).some((l) => l.text.includes("omitted"))).toBe(
      false,
    );
  });

  it("leaves a file at exactly the line budget untouched", () => {
    const file = patchToCodeDiffs(strictAddPatch(MAX_LINES))[0];
    expect(file.lines).toHaveLength(MAX_LINES);
    expect(file.lines[0].text).toBe("row-0");
    expect(file.lines[MAX_LINES - 1].text).toBe(`row-${MAX_LINES - 1}`);
    expect(file.lines.some((l) => l.text.includes("omitted"))).toBe(false);
  });

  it("leaves a file at exactly the character budget untouched", () => {
    // 256 rows x 1024 chars = MAX_CHARS exactly. The rule is "over budget", so
    // the boundary is inclusive and must not be trimmed.
    const rowLen = 1024;
    const rows = MAX_CHARS / rowLen;
    const file = patchToCodeDiffs(
      strictAddPatch(rows, () => "A".repeat(rowLen)),
    )[0];
    expect(file.lines).toHaveLength(rows);
    expect(
      file.lines.reduce((total, line) => total + line.text.length, 0),
    ).toBe(MAX_CHARS);
    expect(file.lines.some((l) => l.text.includes("omitted"))).toBe(false);
  });

  it("returns [] when the patch yields no rows at all", () => {
    // `parseLoose` renders any non-blank line as a context row, so "no diff"
    // here means literally nothing to show — which is what the caller's empty
    // state is for.
    expect(patchToCodeDiffs("")).toEqual([]);
    expect(patchToCodeDiffs("   \n\t\n  ")).toEqual([]);
  });
});

describe("patchToCodeDiffs — over the line budget", () => {
  it("keeps the head, drops the middle, and names the omitted rows", () => {
    const count = 5000;
    const file = patchToCodeDiffs(strictAddPatch(count))[0];

    // 1000 head + 1 marker + 1000 tail.
    expect(file.lines).toHaveLength(MAX_LINES + 1);
    expect(file.lines[0]).toEqual({ kind: "added", text: "row-0" });
    expect(file.lines[2000]).toEqual({ kind: "added", text: "row-4999" });

    // The marker says how many rows are missing, and there is exactly one of
    // it: 5000 - 1000 - 1000 = 3000.
    expect(file.lines[1000].text).toBe(marker(3000));
    expect(file.lines[1000].text).toContain("3000");
    expect(file.lines.filter((l) => l.text.includes("omitted"))).toHaveLength(1);
    // A marker is a context row, never an added/removed one.
    expect(file.lines[1000].kind).toBe("context");

    // Head is rows 0..999, tail is rows 2000..4999: the middle 3000 are gone.
    expect(file.lines.slice(0, SIDE_LINES).map((l) => l.text)).toEqual(
      Array.from({ length: SIDE_LINES }, (_, i) => `row-${i}`),
    );
    expect(file.lines.slice(SIDE_LINES + 1).map((l) => l.text)).toEqual(
      Array.from({ length: SIDE_LINES }, (_, i) => `row-${count - SIDE_LINES + i}`),
    );
  });

  it("keeps the true additions and deletions after trimming", () => {
    const patch = [
      "--- a/src/mixed.ts",
      "+++ b/src/mixed.ts",
      "@@ -1,2500 +1,2500 @@",
      ...Array.from({ length: 5000 }, (_, i) =>
        i % 2 === 0 ? `+add-${i}` : `-del-${i}`,
      ),
      "",
    ].join("\n");
    const file = patchToCodeDiffs(patch)[0];

    // The header reports the FULL change, counted straight off the patch.
    expect(file.additions).toBe(countMarkers(patch, "+"));
    expect(file.deletions).toBe(countMarkers(patch, "-"));
    expect(file.additions).toBe(2500);
    expect(file.deletions).toBe(2500);

    // The window holds fewer rows, which is exactly why the counts must NOT be
    // re-derived from it.
    expect(file.lines).toHaveLength(MAX_LINES + 1);
    expect(file.lines.filter((l) => l.kind === "added").length).toBeLessThan(
      file.additions,
    );
    expect(file.lines.filter((l) => l.kind === "removed").length).toBeLessThan(
      file.deletions,
    );
  });

  it("never duplicates or loses a row when trimming a pathological file", () => {
    // Odd row count, so the head and the tail cannot land symmetrically.
    const count = 4001;
    const file = patchToCodeDiffs(strictAddPatch(count))[0];
    const dropped = count - SIDE_LINES * 2;

    expect(file.lines).toHaveLength(SIDE_LINES * 2 + 1);
    expect(file.lines[SIDE_LINES].text).toBe(marker(dropped));
    expect(dropped).toBe(2001);

    const kept = file.lines.filter((line) => line.text !== marker(dropped));
    expect(kept).toHaveLength(SIDE_LINES * 2);

    // Every kept row is one of the patch's own rows, and each appears once.
    const originalIndex = new Map(
      Array.from({ length: count }, (_, i) => [`row-${i}`, i]),
    );
    const indices = kept.map((line) => {
      const index = originalIndex.get(line.text);
      expect(index).toBeDefined();
      return index as number;
    });
    expect(new Set(indices).size).toBe(indices.length);

    // Head before tail, in the patch's own order, with the right rows at the
    // edges: no row can be claimed by both sides or appear out of order.
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(count - 1);
    expect(indices.slice(0, SIDE_LINES).every((i) => i < SIDE_LINES)).toBe(true);
    expect(
      indices.slice(SIDE_LINES).every((i) => i >= count - SIDE_LINES),
    ).toBe(true);
  });

  it("trims the loose (header-less) parse identically to the strict path", () => {
    const count = 5000;
    const loosePatch = Array.from({ length: count }, (_, i) => `+row-${i}`).join(
      "\n",
    );
    const [loose] = patchToCodeDiffs(loosePatch);
    const [strict] = patchToCodeDiffs(strictAddPatch(count));

    // Same rows, same marker, same counts — the loose fallback must not be a
    // way around the budget.
    expect(loose.lines).toEqual(strict.lines);
    expect(loose.additions).toBe(strict.additions);
    expect(loose.deletions).toBe(strict.deletions);
    expect(loose.lines).toHaveLength(MAX_LINES + 1);
    expect(loose.lines[SIDE_LINES].text).toBe(marker(3000));

    // What the two paths may still differ on is the name: the loose patch
    // declares none, and none is invented.
    expect(loose.filename).toBe("");
    expect(strict.filename).toBe("src/big.ts");
  });
});

describe("patchToCodeDiffs — the character budget", () => {
  /** A few enormous rows — inlined base64 or a minified bundle. */
  const hugeRow = (i: number) => `${i}#${"a".repeat(30_000)}`;

  it("bounds a file of few enormous rows, never cutting a row mid-way", () => {
    const rowCount = 10;
    const patch = strictAddPatch(rowCount, hugeRow);
    const file = patchToCodeDiffs(patch)[0];

    // Over the character budget while comfortably UNDER the row budget, so
    // only the character rule can explain the trim.
    const originalChars = Array.from({ length: rowCount }, (_, i) => hugeRow(i)).reduce(
      (sum, text) => sum + text.length,
      0,
    );
    expect(originalChars).toBeGreaterThan(MAX_CHARS);
    expect(rowCount).toBeLessThan(MAX_LINES);

    // 4 head + marker + 4 tail: each side fits under SIDE_CHARS.
    expect(file.lines).toHaveLength(9);
    expect(file.lines[4].text).toBe(marker(rowCount - 8));
    const keptChars = file.lines.reduce((sum, line) => sum + line.text.length, 0);
    expect(keptChars).toBeLessThanOrEqual(SIDE_CHARS * 2 + file.lines[4].text.length);

    // Every kept row is one of the patch's own rows, WHOLE — a base64 or
    // minified row has no honest cut point, so it is kept or dropped, never
    // shortened.
    const originals = new Set(
      Array.from({ length: rowCount }, (_, i) => hugeRow(i)),
    );
    const kept = file.lines.filter((line) => line.text !== file.lines[4].text);
    expect(kept).toHaveLength(8);
    for (const line of kept) {
      expect(originals.has(line.text)).toBe(true);
      expect(line.text).toBe(hugeRow(Number(line.text[0])));
    }
  });

  it("bounds a file that busts BOTH budgets with the tighter of the two", () => {
    // 3000 short rows bust the line budget; the char budget is nowhere near,
    // so the line rule decides and the char budget must not shrink the window
    // further.
    const file = patchToCodeDiffs(strictAddPatch(3000))[0];
    expect(file.lines).toHaveLength(MAX_LINES + 1);
    expect(file.lines[0].text).toBe("row-0");
    expect(file.lines[MAX_LINES].text).toBe("row-2999");
    expect(file.lines[SIDE_LINES].text).toBe(marker(3000 - SIDE_LINES * 2));
  });
});
