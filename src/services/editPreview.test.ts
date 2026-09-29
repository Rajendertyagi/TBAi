import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { previewEdit, runEdit, ToolError } from "./tools";

/**
 * The read-only preview an `edit_file` approval gate renders.
 *
 * The property that matters is not "produces a plausible diff" — it is that the
 * preview describes **exactly** what `runEdit` would do, without doing it. A
 * preview that disagreed with the tool would be worse than no preview at all: it
 * would promise a change that cannot happen, in the one place the user is being
 * asked to agree to something.
 *
 * The tests are therefore written as comparisons against the real `runEdit`, not
 * against hand-written expectations of the patch text.
 */

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tbai-edit-preview-"));
  file = join(dir, "a.ts");
  writeFileSync(
    file,
    [
      "const one = 1;",
      "const two = 2;",
      "const target = 3;",
      "const four = 4;",
      "const five = 5;",
      "const six = 6;",
      "",
    ].join("\n"),
    "utf8",
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const contents = () => readFileSync(file, "utf8");

describe("previewEdit never writes", () => {
  it("leaves the file exactly as it was", () => {
    const before = contents();
    previewEdit({ path: file, oldText: "const target = 3;", newText: "const target = 99;" }, dir);
    expect(contents()).toBe(before);
  });

  it("leaves the file alone even when the preview fails", () => {
    const before = contents();
    expect(() => previewEdit({ path: file, oldText: "absent", newText: "x" }, dir)).toThrow();
    expect(contents()).toBe(before);
  });

  it("does not create a file that does not exist", () => {
    const missing = join(dir, "nope.ts");
    expect(() => previewEdit({ path: missing, oldText: "a", newText: "b" }, dir)).toThrow(ToolError);
    expect(() => readFileSync(missing, "utf8")).toThrow();
  });
});

describe("previewEdit describes what runEdit does", () => {
  it("emits every line runEdit changes, as removed and added", () => {
    const { patch, occurrences } = previewEdit(
      { path: file, oldText: "const target = 3;", newText: "const target = 99;" },
      dir,
    );
    expect(occurrences).toBe(1);
    expect(patch).toContain("-const target = 3;");
    expect(patch).toContain("+const target = 99;");
    // And the untouched neighbours are present, which is the whole point: the
    // find/replace pair this replaces showed neither of them.
    expect(patch).toContain(" const two = 2;");
    expect(patch).toContain(" const four = 4;");
  });

  it("agrees with runEdit on the resulting file", () => {
    // The strongest available statement: preview the change, apply it with the
    // real tool, and confirm the patch's added lines are what the file now says.
    const { patch } = previewEdit(
      { path: file, oldText: "const target = 3;", newText: "const target = 99;\nconst extra = 5;" },
      dir,
    );
    const added = patch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
    runEdit(
      { path: file, oldText: "const target = 3;", newText: "const target = 99;\nconst extra = 5;" },
      dir,
    );
    const after = contents();
    for (const line of added) expect(after).toContain(line);
    expect(after).not.toContain("const target = 3;");
  });

  it("carries a hunk header a standard parser accepts", () => {
    const { patch } = previewEdit({ path: file, oldText: "const two = 2;", newText: "const two = 22;" }, dir);
    expect(patch).toContain("--- ");
    expect(patch).toContain("+++ ");
    expect(patch).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
  });

  it("counts every occurrence when the text repeats", () => {
    writeFileSync(file, ["a", "dup", "b", "dup", "c"].join("\n"), "utf8");
    const { occurrences } = previewEdit({ path: file, oldText: "dup", newText: "DUP" }, dir);
    expect(occurrences).toBe(2);
  });

  it("shows the FIRST match, and does not invent later locations", () => {
    // A hunk for the second occurrence would carry a line number only correct
    // after the first replacement is applied. The preview reports the count
    // instead, and the card words it.
    writeFileSync(file, ["a", "dup", "b", "dup", "c"].join("\n"), "utf8");
    const { patch, occurrences } = previewEdit({ path: file, oldText: "dup", newText: "DUP" }, dir);
    expect(occurrences).toBe(2);
    expect(patch).toContain("-dup");
    expect(patch).toContain("+DUP");
    // One hunk, not two: there is exactly one @@ header.
    expect(patch.match(/^@@ /gm)?.length).toBe(1);
  });

  it("handles a multi-line match as a single contiguous hunk", () => {
    const { patch } = previewEdit(
      { path: file, oldText: "const two = 2;\nconst target = 3;", newText: "const two = 2;" },
      dir,
    );
    expect(patch).toContain("-const two = 2;");
    expect(patch).toContain("-const target = 3;");
    expect(patch.match(/^@@ /gm)?.length).toBe(1);
  });

  it("keeps the context bounded for a match deep inside a large file", () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(file, long, "utf8");
    const { patch } = previewEdit({ path: file, oldText: "line 250", newText: "CHANGED" }, dir);
    const rows = patch.split("\n").length;
    // 3 context rows either side, plus the headers, the removal and the addition.
    expect(rows).toBeLessThan(20);
    expect(patch).toContain("-line 250");
    expect(patch).toContain("+CHANGED");
  });
});

describe("previewEdit refuses exactly what runEdit refuses", () => {
  it("refuses a path outside the workspace, the same as runEdit", () => {
    expect(() => previewEdit({ path: "../escape.ts", oldText: "a", newText: "b" }, dir)).toThrow();
    expect(() => runEdit({ path: "../escape.ts", oldText: "a", newText: "b" }, dir)).toThrow();
  });

  it("refuses a missing file", () => {
    expect(() => previewEdit({ path: join(dir, "gone.ts"), oldText: "a", newText: "b" }, dir)).toThrow(
      ToolError,
    );
  });

  it("refuses text that does not match, so it cannot promise a doomed edit", () => {
    expect(() => previewEdit({ path: file, oldText: "not present", newText: "x" }, dir)).toThrow(
      /not found/,
    );
  });

  it("is unchanged for a directory, which runEdit also refuses to read as a file", () => {
    const sub = join(dir, "sub");
    mkdirSync(sub);
    expect(() => previewEdit({ path: sub, oldText: "a", newText: "b" }, dir)).toThrow();
  });
});
