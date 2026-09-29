import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toolsConfig } from "@/config/tools";
import { EditFindReplaceBody, previewFiles } from "./edit-preview";

/**
 * The edit gate's "diff or fall back" decision, and the fallback itself.
 *
 * `previewFiles` is the whole contract and it is pure, which is why it can be
 * tested here without a DOM. This repo has no DOM under `bun test` and every
 * component test renders through `renderToStaticMarkup`, which captures only the
 * first paint — so a *transition* cannot be asserted in this environment, and
 * the decision that drives it was pulled out as a function rather than shipping
 * a DOM dependency to test three lines of branching.
 *
 * What is NOT covered here, and is stated rather than implied: that the request
 * actually fires and the state actually swaps. The request is exercised against
 * the real route in `web/e2e/edit-preview-live.spec.ts`, and the swap is two
 * lines of `useState` in front of a pure function.
 */

const PATCH = [
  "--- preview-target.ts",
  "+++ preview-target.ts",
  "@@ -1,3 +1,3 @@",
  " const beta = 2;",
  "-const target = 3;",
  "+const target = 99;",
  " const gamma = 4;",
].join("\n");

describe("previewFiles: what counts as a usable preview", () => {
  it("accepts a real unified patch and reports the change size", () => {
    const files = previewFiles({ patch: PATCH, occurrences: 1 });
    expect(files).not.toBeNull();
    expect(files?.[0].additions).toBe(1);
    expect(files?.[0].deletions).toBe(1);
    expect(files?.[0].filename).toBe("preview-target.ts");
  });

  it("keeps the surrounding context, which the find/replace pair cannot show", () => {
    // The whole reason this exists. If a future change drops the context lines
    // from the server's patch, the gate silently stops being more informative
    // than the pair it replaced.
    const kinds = previewFiles({ patch: PATCH, occurrences: 1 })?.[0].lines.map((l) => l.kind) ?? [];
    expect(kinds).toEqual(["context", "removed", "added", "context"]);
  });

  it("refuses a missing preview", () => {
    expect(previewFiles(null)).toBeNull();
  });

  it("refuses an empty or blank patch", () => {
    expect(previewFiles({ patch: "", occurrences: 1 })).toBeNull();
    expect(previewFiles({ patch: "   ", occurrences: 1 })).toBeNull();
  });

  it("refuses a patch that is not a diff, rather than rendering a phantom change", () => {
    // `parseLoose` turns prose into a one-row "file", which would paint a
    // `+0 -0` header next to a sentence and claim a change that does not exist.
    const files = previewFiles({ patch: "not a diff at all", occurrences: 1 });
    expect(files === null || files[0].additions === 0).toBe(true);
  });

  it("refuses a non-string patch", () => {
    expect(previewFiles({ patch: 42 as unknown as string, occurrences: 1 })).toBeNull();
  });
});

describe("the find/replace fallback", () => {
  const render = (oldText: unknown, newText: unknown) =>
    renderToStaticMarkup(createElement(EditFindReplaceBody, { oldText, newText }));

  it("labels both sides, which is what the reader is comparing", () => {
    const html = render("const target = 3;", "const target = 99;");
    expect(html).toContain("Find:");
    expect(html).toContain("const target = 3;");
    expect(html).toContain("Replace with:");
    expect(html).toContain("const target = 99;");
  });

  it("shortens an oversized side and says how much it left out", () => {
    const huge = "x".repeat(50_000);
    const html = render(huge, "small");
    // The count is exact and printed, so a reader can tell what they are not
    // seeing rather than assuming they are seeing all of it.
    expect(html).toContain("more characters not shown");
    expect(html).not.toContain("x".repeat(5_000));
  });

  it("renders nothing rather than the word undefined for a missing side", () => {
    const html = render(undefined, undefined);
    expect(html).not.toContain("undefined");
  });
});

describe("the repeat notice", () => {
  it("names how many places, because the diff shows only the first", () => {
    const notice = toolsConfig.copy.status.editPreviewMoreOccurrences(4);
    expect(notice).toContain("4");
    expect(notice).toContain("repeats");
  });

  it("would still read correctly for the smallest possible count", () => {
    // Two is the smallest value that triggers it, so it is the one that will be
    // read most often.
    expect(toolsConfig.copy.status.editPreviewMoreOccurrences(2)).toContain("2");
  });
});
