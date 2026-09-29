import { describe, expect, it } from "bun:test";
import { toolsConfig } from "@/config/tools";
import { stripComments } from "@/testing/source-scope";
import { boundToolBody } from "./body-budget";

/**
 * The tool result body budget.
 *
 * Two separate claims are tested here, because they fail in different ways.
 *
 * The arithmetic is tested as a pure function, exactly as the shared helper's
 * own suite does. What that cannot reach is the SEAM: whether the bounded value
 * is what the card actually paints. A `BoundedBody` that computed a bound and
 * then rendered the full text would pass every test in this file, pass
 * typecheck, and pass the build - which is precisely the regression the code
 * fence's own `code={props.code}` guard was written for, after it shipped once.
 * So the seam is pinned against the source.
 */

const { toolBodyMaxLines, toolBodyMaxChars } = toolsConfig.limits;

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
}

describe("tool body budget: the bound applies to a result body", () => {
  it("leaves a small body untouched", () => {
    const text = lines(5);
    expect(boundToolBody(text).truncated).toBe(false);
  });

  it("bounds a body with too many rows", () => {
    const bounded = boundToolBody(lines(toolBodyMaxLines + 10));
    expect(bounded.truncated).toBe(true);
    expect(bounded.omitted.lines).toBe(10);
  });

  it("bounds a single enormous row", () => {
    // The `read_file` shape: one long file, no row structure to catch it.
    const bounded = boundToolBody("x".repeat(toolBodyMaxChars + 100));
    expect(bounded.truncated).toBe(true);
    expect(bounded.text.length).toBeLessThanOrEqual(toolBodyMaxChars);
  });

  it("uses the shared budget, not a private one", () => {
    // Every rendered body answers the same question through the same numbers.
    // A second local limit is the failure mode this whole refactor removes.
    const bounded = boundToolBody(lines(toolBodyMaxLines + 1));
    expect(bounded.text.split("\n").length).toBe(toolBodyMaxLines);
  });
});

describe("tool body budget: the card paints the bounded text", () => {
  it("renders the bounded value, never the raw input", async () => {
    // The regression this whole file exists to prevent, in the form it actually
    // takes here: `children` on a bounded body. An earlier draft of
    // `BoundedBody` accepted a `children` override, which let the browser tool
    // pass the full unbounded stdout alongside a correctly computed bound - the
    // marker would render and the full body would paint anyway. The prop was
    // removed rather than documented, because a bound that can be bypassed by a
    // prop is not a bound.
    const source = stripComments(
      await Bun.file(new URL("./body-budget.tsx", import.meta.url)).text(),
    );
    expect(source).toContain("{text ? bounded.text : (empty ?? bounded.text)}");
    expect(source).not.toMatch(/children/);
  });

  it("shows the omission, so a shortened body never reads as complete", async () => {
    // A silent truncation is worse than none: it looks like a finished answer.
    // The browser tool shipped exactly that, slicing at a hardcoded 4000
    // characters with no notice.
    //
    // Matched as JSX structure, not as a substring. Asserting only that
    // `bounded.truncated` and `toolBodyTruncated` appear in the file passed
    // against `{false && bounded.truncated && (`, which keeps both strings and
    // renders nothing - the budget would be computed, the copy would be
    // referenced, and the reader would be told nothing.
    const source = stripComments(
      await Bun.file(new URL("./body-budget.tsx", import.meta.url)).text(),
    );
    expect(source).toMatch(/\{bounded\.truncated\s*&&\s*\(/);
    expect(source).toMatch(/className="aui-tool-body-truncated[^"]*"[\s\S]*?toolBodyTruncated/);
  });

  it("no longer hardcodes a limit in the browser tool", async () => {
    const source = stripComments(
      await Bun.file(new URL("./browser/ui.tsx", import.meta.url)).text(),
    );
    expect(source).not.toMatch(/\.slice\(\s*0\s*,\s*\d/);
    expect(source).toContain("BoundedBody");
  });

  it("routes every result body through the bounded component", async () => {
    // `Json` is the seam behind every tool result, so the budget reaches them
    // all through it. If it ever stops bounding, eleven call sites go unbounded
    // at once and nothing else in the tree would notice.
    const source = stripComments(
      await Bun.file(new URL("./filesystem/ui.tsx", import.meta.url)).text(),
    );
    expect(source).toMatch(/export function Json[\s\S]*?<BoundedBody/);
  });
});

describe("tool body budget: the omission copy is honest", () => {
  const note = (lines: number, chars = 0) =>
    toolsConfig.copy.status.toolBodyTruncated({ lines, chars });

  it("names how many rows are missing", () => {
    expect(note(9)).toContain("9 more lines");
  });

  it("uses the singular for exactly one missing row", () => {
    expect(note(1)).toContain("1 more line ");
    expect(note(1)).not.toContain("1 more lines");
  });

  it("never claims a row count of zero", () => {
    // "0 more lines not shown" on a visibly cut body is a lie a reader cannot
    // tell from a bug, and it is reachable: a single minified line over the
    // character budget drops no whole row at all.
    expect(note(0, 1000)).not.toContain("0 more lines");
    expect(note(0, 1000)).toMatch(/cut short/);
  });

  it("says the result was shortened, so it is not read as the whole output", () => {
    expect(note(3)).toMatch(/shortened/);
  });

  it("does not promise a copy that does not exist", () => {
    // Unlike a code fence, a result body has no copy button. Reusing the
    // fence's wording here would point a reader at a control that is not there.
    expect(note(3)).not.toMatch(/Copying/);
  });

  it("mentions the shortened row when both kinds of cut happened", () => {
    expect(note(12, 400)).toContain("12 more lines");
    expect(note(12, 400)).toMatch(/last line is cut short/);
  });

  it("stays clear of the shortened-row clause when only rows went missing", () => {
    // Otherwise every ordinary over-long body would claim a row was cut short,
    // which is untrue of it and would train readers to ignore the note.
    expect(note(12)).not.toMatch(/cut short/);
  });
});
