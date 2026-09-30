import { describe, expect, it } from "bun:test";
import {
  parseCodexPatch,
  codexPatchToUnifiedDiff,
  codexPatchToDiffText,
  codexPatchPaths,
} from "./codex-patch";

/**
 * OpenCode v2's `patch` tool input, and the unified diff it becomes.
 *
 * ## The defect this pins
 *
 * `patch` is one of OpenCode v2's built-ins and TBAi had no renderer for it, so
 * every patch call fell through to `ToolFallback` and rendered as a raw dump —
 * the same failure shape as the delegated-agent tool, one level worse: that one
 * was a wrong NAME for a real tool, this one was a real tool with no card.
 *
 * The grammar here was not inferred from a renderer or a screenshot. It was read
 * out of OpenCode 2.0.15's own bundled patch parser, whose error strings state
 * it: `is not a valid hunk header. Valid hunk headers: '*** Add File: {path}',
 * '*** Delete File: {path}', '*** Update File: {path}'`. The parse cases below
 * mirror that parser's own rejections, because a lenient parser is how a
 * malformed patch turns into a diff that lies about what changed.
 *
 * The refusal cases matter more than the happy path. This module exists to
 * translate a header; if it invents a file, a line count, or a hunk the text
 * never carried, the card becomes a confident lie about a change to someone's
 * code.
 */

const ADD = `*** Begin Patch
*** Add File: src/new.ts
+export const a = 1
+export const b = 2
*** End Patch`;

const UPDATE = `*** Begin Patch
*** Update File: src/old.ts
@@
 const keep = true
-const gone = 1
+const here = 1
*** End Patch`;

const MULTI = `*** Begin Patch
*** Add File: a.ts
+one
*** Update File: b.ts
@@
-old
+new
*** Delete File: c.ts
*** End Patch`;

const sectionsOf = (text: string) => {
  const parsed = parseCodexPatch(text);
  if ("problem" in parsed) throw new Error(`unexpected problem: ${parsed.problem.message}`);
  return parsed.sections;
};

describe("parseCodexPatch: the envelope", () => {
  it("reads an Add File section", () => {
    const sections = sectionsOf(ADD);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.kind).toBe("add");
    expect(sections[0]?.path).toBe("src/new.ts");
    // The marker is kept, so the diff writer can tell added from context.
    expect(sections[0]?.lines).toEqual(["+export const a = 1", "+export const b = 2"]);
  });

  it("reads an Update File section, keeping context and both signs", () => {
    const sections = sectionsOf(UPDATE);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.kind).toBe("update");
    expect(sections[0]?.path).toBe("src/old.ts");
    expect(sections[0]?.lines).toEqual([
      " const keep = true",
      "-const gone = 1",
      "+const here = 1",
    ]);
  });

  it("reads all three section kinds in one patch", () => {
    const sections = sectionsOf(MULTI);
    expect(sections.map((s) => s.kind)).toEqual(["add", "update", "delete"]);
    expect(sections.map((s) => s.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("records that End of File closed a section", () => {
    const sections = sectionsOf(`*** Begin Patch
*** Update File: a.ts
@@
 last line
*** End of File
*** End Patch`);
    expect(sections[0]?.endOfFile).toBe(true);
  });

  it("skips the optional Environment ID line", () => {
    const sections = sectionsOf(`*** Begin Patch
*** Environment ID: repo-123
*** Add File: a.ts
+x
*** End Patch`);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.path).toBe("a.ts");
  });

  it("tolerates CRLF, because a Windows-authored patch arrives with it", () => {
    // The bytes carry \r. A parser that does not strip it puts a stray \r on
    // every body line, which then renders as trailing whitespace in the diff.
    const sections = sectionsOf(ADD.replace(/\n/g, "\r\n"));
    expect(sections[0]?.lines).toEqual(["+export const a = 1", "+export const b = 2"]);
  });
});

describe("parseCodexPatch: the refusals", () => {
  // Each rejection mirrors one of OpenCode's own errors. A parser that accepts
  // these would render a diff for a patch OpenCode itself would refuse.
  const refused = (text: string, fragment: string) => {
    const parsed = parseCodexPatch(text);
    expect("problem" in parsed).toBe(true);
    if ("problem" in parsed) expect(parsed.problem.message).toContain(fragment);
  };

  it("refuses a patch with no Begin marker", () => {
    refused(`*** Add File: a.ts
+x
*** End Patch`, "first line of the patch must be");
  });

  it("refuses a patch with no End marker", () => {
    refused(`*** Begin Patch
*** Add File: a.ts
+x`, "last line of the patch must be");
  });

  it("refuses an unknown header, naming the three valid ones", () => {
    refused(`*** Begin Patch
*** Rename File: a.ts
*** End Patch`, "is not a valid hunk header");
    const parsed = parseCodexPatch(`*** Begin Patch
*** Rename File: a.ts
*** End Patch`);
    if ("problem" in parsed) {
      expect(parsed.problem.message).toContain("*** Add File: {path}");
      expect(parsed.problem.message).toContain("*** Delete File: {path}");
      expect(parsed.problem.message).toContain("*** Update File: {path}");
    }
  });

  it("refuses a body line after a Delete, which OpenCode does not allow", () => {
    refused(
      `*** Begin Patch
*** Delete File: a.ts
+not allowed here
*** End Patch`,
      "Delete hunks do not contain body lines",
    );
  });

  it("refuses an unmarked line, naming the three markers", () => {
    refused(
      `*** Begin Patch
*** Add File: a.ts
no marker at all
*** End Patch`,
      "should start with ' ' (context line), '+' (added line), or '-' (removed line)",
    );
  });

  it("refuses a header carrying no path", () => {
    refused(`*** Begin Patch
*** Add File:  
+x
*** End Patch`, "carries no path");
  });

  it("refuses an update hunk with no lines", () => {
    refused(`*** Begin Patch
*** Update File: a.ts
@@
*** End Patch`, "does not contain any lines");
  });

  it("refuses an empty patch rather than rendering nothing", () => {
    // An empty card is indistinguishable from a tool that failed to run.
    expect("problem" in parseCodexPatch("")).toBe(true);
    expect("problem" in parseCodexPatch("   ")).toBe(true);
    expect("problem" in parseCodexPatch(null)).toBe(true);
    expect("problem" in parseCodexPatch(undefined)).toBe(true);
    expect("problem" in parseCodexPatch(42)).toBe(true);
  });
});

describe("codexPatchToUnifiedDiff: counts come from the text", () => {
  it("counts an add as all-additions from line 0", () => {
    const diff = codexPatchToDiffText(ADD)!;
    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+++ src/new.ts");
    // Two body lines, both additions. The old side is empty.
    expect(diff).toContain("@@ -0,0 +1,2 @@");
    expect(diff).toContain("+export const a = 1");
  });

  it("counts an update from its context and signs", () => {
    const diff = codexPatchToDiffText(UPDATE)!;
    // 1 context + 1 removed = 2 on the old side; 1 context + 1 added = 2 new.
    expect(diff).toContain("@@ -1,2 +1,2 @@");
    expect(diff).toContain("-const gone = 1");
    expect(diff).toContain("+const here = 1");
  });

  it("emits one file block per section, so a multi-file patch is a stack", () => {
    const diff = codexPatchToDiffText(MULTI)!;
    expect(diff).toContain("+++ a.ts");
    expect(diff).toContain("+++ b.ts");
    expect(diff).toContain("--- c.ts");
    expect(diff).toContain("+++ /dev/null");
  });

  it("does not invent a line count for a delete, which carries no body", () => {
    // OpenCode sends no body lines for a delete, so any line count would be
    // invented. The header says the file is going and claims nothing else.
    const diff = codexPatchToDiffText(MULTI)!;
    expect(diff).toContain("@@ -1,0 +0,0 @@");
  });

  it("returns null rather than a diff when the envelope does not parse", () => {
    expect(codexPatchToDiffText("*** Begin Patch\nnonsense\n*** End Patch")).toBeNull();
  });

  it("joins sections with a newline so parse-diff sees separate files", () => {
    const diff = codexPatchToUnifiedDiff(sectionsOf(MULTI));
    expect(diff.split("\n").filter((l) => l.startsWith("--- "))).toHaveLength(3);
  });
});

describe("codexPatchPaths: what the card titles itself from", () => {
  it("lists every path in order, without duplicates", () => {
    expect(codexPatchPaths(MULTI)).toEqual(["a.ts", "b.ts", "c.ts"]);
    const dup = `*** Begin Patch
*** Add File: a.ts
+1
*** Update File: a.ts
@@
-2
+3
*** End Patch`;
    expect(codexPatchPaths(dup)).toEqual(["a.ts"]);
  });

  it("returns nothing for a patch it could not read", () => {
    expect(codexPatchPaths("nope")).toEqual([]);
  });
});
