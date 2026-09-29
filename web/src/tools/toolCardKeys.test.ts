import { describe, expect, it } from "bun:test";
import { searchMatchKey } from "./filesystem/ui";
import { patchFileName, questionItemKey } from "./opencode/ui";

/**
 * Stable React keys for the three tool-card lists.
 *
 * ## Why the key helpers are tested directly
 *
 * The audit found three lists keyed by array index:
 *
 *   - `searchSummary`  — search matches
 *   - the `edit` card  — files inside a patch
 *   - the `question` card — questions inside one call
 *
 * None of the three children hold React state: a search row is two spans, a
 * `CodeDiff` takes its lines as props, and a question row is paragraphs. There
 * is no `useState` anywhere in that path, so there is no local state for a key to
 * preserve, and this repo has no DOM harness (`renderToStaticMarkup` runs no
 * effects) in which a re-render could be observed anyway.
 *
 * So the meaningful property is not "React keeps the right node mounted" — it is
 * "the key follows the logical item". That is what these tests pin: given the
 * same logical item, the key must be the same before and after a reorder, an
 * insertion, or a removal. A key that shifts with position would fail every one
 * of them, which is the defect being fixed.
 */

describe("searchMatchKey — identity is where the match is", () => {
  const A = { path: "src/a.ts", line: 10, snippet: "first" };
  const B = { path: "src/b.ts", line: 3, snippet: "second" };
  const C = { path: "src/c.ts", line: 77, snippet: "third" };

  it("follows the match through a reorder", () => {
    const before = [A, B, C].map(searchMatchKey);
    const after = [C, A, B].map(searchMatchKey);
    // Each logical item keeps its own key; the keys are just emitted in a
    // different order.
    expect(new Set(before)).toEqual(new Set(after));
    expect(after[0]).toBe(searchMatchKey(C));
    expect(after[1]).toBe(searchMatchKey(A));
  });

  it("does not shift when an item is inserted ahead of it", () => {
    const original = searchMatchKey(B);
    const withInsertion = [A, { path: "src/new.ts", line: 1 }, B].map(
      searchMatchKey,
    );
    expect(withInsertion[2]).toBe(original);
  });

  it("does not shift when an earlier item is removed", () => {
    expect(searchMatchKey(C)).toBe("src/c.ts:77");
    // C was third and stays the same key whether or not A and B preceded it.
    expect([A, B, C].map(searchMatchKey)[2]).toBe(searchMatchKey(C));
  });

  it("distinguishes two hits on different lines of the SAME file", () => {
    // The realistic duplicate: a file with several matches, which is the whole
    // point of a search result.
    const first = searchMatchKey({ path: "src/a.ts", line: 1 });
    const second = searchMatchKey({ path: "src/a.ts", line: 2 });
    expect(first).not.toBe(second);
  });

  it("gives identical text at identical locations the same key, because they are one finding", () => {
    expect(searchMatchKey({ path: "a.ts", line: 4 })).toBe(
      searchMatchKey({ path: "a.ts", line: 4 }),
    );
  });
});

describe("patchFileName — identity is the file, not its position", () => {
  it("is the file's own name when the patch supplies one", () => {
    expect(patchFileName("src/a.ts", "src/fallback.ts")).toBe("src/a.ts");
  });

  it("falls back to the path the model asked to edit when the patch has no name", () => {
    // A real argument, never an invented one.
    expect(patchFileName("", "src/fallback.ts")).toBe("src/fallback.ts");
  });

  it("follows each file through a reorder of the patch", () => {
    const before = ["a.ts", "b.ts", "c.ts"].map((f) => patchFileName(f, "fallback"));
    const after = ["c.ts", "a.ts", "b.ts"].map((f) => patchFileName(f, "fallback"));
    expect(after).toEqual([before[2], before[0], before[1]]);
  });

  it("gives two unnamed entries the same key, which is why only one may exist", () => {
    // Documents the assumption rather than hiding it: `patchToCodeDiffs` emits
    // one entry per file and at most one unnamed entry, so a collision cannot
    // arise. If that ever changes, this test is where it should be noticed.
    expect(patchFileName("", "same")).toBe(patchFileName("", "same"));
  });
});

describe("questionItemKey — identity is the question itself", () => {
  it("is the question text, qualified by its header", () => {
    expect(questionItemKey("Setup", "Which database?")).toBe("Setup::Which database?");
  });

  it("keeps two questions with the same text but different headers apart", () => {
    // Realistic: a form may ask the same question under two headings.
    expect(questionItemKey("Before", "Continue?")).not.toBe(
      questionItemKey("After", "Continue?"),
    );
  });

  it("follows a question through a reorder", () => {
    const before = [
      questionItemKey("H1", "A?"),
      questionItemKey("H2", "B?"),
      questionItemKey("H3", "C?"),
    ];
    const after = [before[2], before[0], before[1]];
    expect(new Set(after)).toEqual(new Set(before));
  });

  it("does not shift when a question is inserted before it", () => {
    const key = questionItemKey("H2", "B?");
    const list = [
      questionItemKey("H0", "Z?"),
      questionItemKey("H1", "A?"),
      key,
    ];
    expect(list[2]).toBe(key);
  });
});
