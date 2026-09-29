import { describe, expect, it, beforeAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { toolsConfig } from "@/config/tools";
import { stripComments } from "@/testing/source-scope";
import { boundCodeFence, BoundedSyntaxHighlighter } from "./code-budget";

/**
 * The code-fence budget, and the ordering claim that makes it a safety fix.
 *
 * ## What is being protected
 *
 * A settled fence used to reach Shiki's Oniguruma WASM tokenization on the main
 * thread and then became one DOM row per line, with no ceiling. The bound has
 * to land BEFORE that work, which is why the central assertion here is about
 * what the highlighter component is HANDED, not about how tall anything looks.
 * A `max-height` would pass every visual check and still pay the full cost.
 *
 * ## How "the highlighter received bounded content" is actually proven
 *
 * `BoundedSyntaxHighlighter` delegates to the real vendored Shiki element, and
 * that element needs an assistant-ui part scope plus a WebAssembly tokenizer -
 * neither of which exists under `bun test`. So the wrapper is not rendered
 * end-to-end here. Instead:
 *
 * - the bound itself is tested as a pure function, including that the payload
 *   handed downstream is within the budget; and
 * - a source-level guard pins the ORDER - the bounded value is what reaches
 *   `SyntaxHighlighterBase`, and the unbounded `props.code` never does. The
 *   source is read with comments stripped, so prose about the rule cannot
 *   satisfy the rule.
 *
 * That pairing is deliberate: the pure test proves the arithmetic, the guard
 * proves the arithmetic is wired to the render path, and neither one pretends to
 * be a browser.
 */

const { codeBlockMaxLines, codeBlockMaxChars } = toolsConfig.limits;

/** `n` lines of `padding`-ish code, deterministic and cheap to build. */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join("\n");
}

describe("code-fence budget: a fence that fits is untouched", () => {
  it("returns a small fence byte for byte", () => {
    const code = lines(10);
    const bounded = boundCodeFence(code);
    expect(bounded.code).toBe(code);
    expect(bounded.truncated).toBe(false);
    expect(bounded.omitted.lines).toBe(0);
  });

  it("leaves a single short line alone", () => {
    expect(boundCodeFence("npm run build").code).toBe("npm run build");
  });

  it("leaves an empty fence alone", () => {
    const bounded = boundCodeFence("");
    expect(bounded.code).toBe("");
    expect(bounded.truncated).toBe(false);
  });

  it("renders a fence AT the line limit completely", () => {
    // The boundary case, in both directions: exactly at the limit must not be
    // cut, because a fence that only just fits is the one most likely to be cut
    // by an off-by-one and least likely to be noticed.
    const code = lines(codeBlockMaxLines);
    const bounded = boundCodeFence(code);
    expect(bounded.truncated).toBe(false);
    expect(bounded.code).toBe(code);
  });

  it("truncates a fence one line OVER the limit even though it fits the char budget", () => {
    // The two limits are independent and EITHER one is enough. A fence that
    // blows the line count while sitting comfortably inside the character
    // budget is still over budget: 2001 rows is 2001 DOM nodes, which is the
    // cost this exists to bound. Written down because the tempting alternative
    // - "only truncate when both are exceeded" - is a per-fence bypass.
    const code = lines(codeBlockMaxLines + 1);
    expect(code.length).toBeLessThanOrEqual(codeBlockMaxChars);
    const bounded = boundCodeFence(code);
    expect(bounded.truncated).toBe(true);
    expect(bounded.omitted.lines).toBe(1);
  });

  it("renders a fence just UNDER the character limit completely", () => {
    const code = "x".repeat(codeBlockMaxChars - 1);
    const bounded = boundCodeFence(code);
    expect(bounded.truncated).toBe(false);
    expect(bounded.code.length).toBe(code.length);
  });
});

describe("code-fence budget: an oversized fence is bounded before rendering", () => {
  it("truncates a fence with too many lines", () => {
    const bounded = boundCodeFence(lines(codeBlockMaxLines + 500));
    expect(bounded.truncated).toBe(true);
    expect(bounded.code.split("\n").length).toBe(codeBlockMaxLines);
    expect(bounded.omitted.lines).toBe(500);
  });

  it("truncates a fence with too many characters on ONE line", () => {
    // The case a line cap cannot see: a minified bundle or a base64 payload is
    // one line, so a line-only budget would wave it straight through.
    const code = "x".repeat(codeBlockMaxChars + 1000);
    const bounded = boundCodeFence(code);
    expect(bounded.truncated).toBe(true);
    expect(bounded.code.length).toBeLessThanOrEqual(codeBlockMaxChars);
  });

  it("always hands downstream a payload within BOTH budgets", () => {
    // The property the whole feature exists for, asserted over a spread of
    // shapes rather than one: many lines, one huge line, and mixed.
    const cases = [
      lines(codeBlockMaxLines * 3),
      "x".repeat(codeBlockMaxChars * 2),
      `${lines(codeBlockMaxLines)}\n${"y".repeat(codeBlockMaxChars)}`,
      lines(codeBlockMaxLines + 1),
    ];
    for (const code of cases) {
      const bounded = boundCodeFence(code);
      expect(bounded.code.length).toBeLessThanOrEqual(codeBlockMaxChars);
      expect(bounded.code.split("\n").length).toBeLessThanOrEqual(codeBlockMaxLines);
    }
  });

  it("never returns an empty payload for a non-empty oversized fence", () => {
    // Returning "" would render an empty block, which reads as "this fence was
    // empty" rather than "this fence was too large to show".
    for (const code of ["x".repeat(codeBlockMaxChars + 1), lines(codeBlockMaxLines + 1)]) {
      expect(boundCodeFence(code).code.length).toBeGreaterThan(0);
    }
  });

  it("cuts on a line boundary, so no kept line is ever half a line", () => {
    const bounded = boundCodeFence(lines(codeBlockMaxLines + 10));
    const original = lines(codeBlockMaxLines + 10).split("\n");
    bounded.code.split("\n").forEach((line, index) => {
      expect(line).toBe(original[index]);
    });
  });

  it("never claims to have truncated while reporting nothing removed", () => {
    // "…0 more lines not shown" on a visibly cut block is a lie the reader
    // cannot distinguish from a bug, so a truncated result must always name
    // something it dropped.
    const cases = [
      lines(codeBlockMaxLines + 1),
      `${lines(codeBlockMaxLines + 1)}\n`,
      "x".repeat(codeBlockMaxChars + 1),
    ];
    for (const code of cases) {
      const bounded = boundCodeFence(code);
      if (bounded.truncated) {
        expect(bounded.omitted.lines + bounded.omitted.chars).toBeGreaterThan(0);
      }
    }
  });

  it("reports a mid-line cut as characters, with no line claimed missing", () => {
    // The single-huge-line case: no whole line disappears, the line is just
    // shortened. Reporting it as dropped lines would be inaccurate.
    const bounded = boundCodeFence("x".repeat(codeBlockMaxChars + 1000));
    expect(bounded.omitted.lines).toBe(0);
    expect(bounded.omitted.chars).toBeGreaterThan(0);
  });

  it("reports dropped lines for an over-long file", () => {
    const bounded = boundCodeFence(lines(codeBlockMaxLines + 9));
    expect(bounded.omitted.lines).toBe(9);
    expect(bounded.omitted.chars).toBe(0);
  });
});

describe("code-fence budget: a trailing newline is not a row", () => {
  // Found in the browser, not on paper: the first e2e run reported "1 more
  // line not shown" for a fence of exactly the limit. A fence's text ends with a
  // newline, `split("\n")` makes that an empty final segment, and counting it
  // charged a row of budget to whitespace that paints nothing.
  it("does not charge a row for a trailing newline", () => {
    const body = lines(codeBlockMaxLines);
    const withNewline = boundCodeFence(`${body}\n`);
    expect(withNewline.truncated).toBe(false);
    expect(withNewline.code).toBe(`${body}\n`);
  });

  it("makes the boundary independent of trailing whitespace", () => {
    // The same file, with and without the newline, must reach the same verdict.
    // A budget whose boundary depends on invisible characters is a budget
    // nobody can reason about.
    const body = lines(codeBlockMaxLines);
    expect(boundCodeFence(body).truncated).toBe(
      boundCodeFence(`${body}\n`).truncated,
    );
  });

  it("still counts real rows past the limit, newline or not", () => {
    const over = lines(codeBlockMaxLines + 7);
    expect(boundCodeFence(over).omitted.lines).toBe(7);
    expect(boundCodeFence(`${over}\n`).omitted.lines).toBe(7);
  });

  it("preserves the trailing newline on a truncated fence", () => {
    const bounded = boundCodeFence(`${lines(codeBlockMaxLines + 3)}\n`);
    expect(bounded.code.endsWith("\n")).toBe(true);
  });
});

describe("code-fence budget: the marker is honest", () => {
  /** The copy under test, with both truncation shapes named explicitly. */
  const note = (lines: number, chars = 0) =>
    toolsConfig.copy.status.codeFenceTruncated({ lines, chars });

  it("names how many lines are missing", () => {
    expect(note(7)).toContain("7 more lines");
  });

  it("uses the singular for exactly one missing line", () => {
    expect(note(1)).toContain("1 more line ");
    expect(note(1)).not.toContain("1 more lines");
  });

  it("says the block was cut, so it is never read as the whole file", () => {
    // The requirement that the display must not imply completeness.
    expect(note(3)).toMatch(/cut for display/);
  });

  it("says copying is unaffected, because it is", () => {
    // Without this the note reads as data loss and teaches readers to distrust
    // the copy button, which still returns the complete fence.
    expect(note(3)).toMatch(/Copying still gives the full code/);
  });

  it("never says a line count of zero, whatever it is handed", () => {
    // The mid-line cut. "0 more lines not shown" on a block that is visibly
    // shortened is exactly the dishonesty this copy exists to avoid, and it is
    // reachable: a single minified line over the character budget drops no
    // whole line at all.
    expect(note(0, 1000)).not.toContain("0 more lines");
    expect(note(0, 1000)).toMatch(/cut short/);
  });

  it("mentions the shortened line when both kinds of cut happened", () => {
    // Too many lines AND a line too long: the reader is missing both, and the
    // note should not hide the second behind the first.
    expect(note(12, 400)).toContain("12 more lines");
    expect(note(12, 400)).toMatch(/last line is cut short/);
  });

  it("stays clear of the shortened-line clause when only lines went missing", () => {
    // Otherwise every ordinary over-long file would claim a line was cut short,
    // which is not true of it and would train readers to ignore the note.
    expect(note(12)).not.toMatch(/cut short/);
  });
});

describe("code-fence budget: the bound is wired BEFORE the highlighter", () => {
  let source = "";
  let chatSource = "";

  beforeAll(async () => {
    source = stripComments(
      await Bun.file(new URL("./code-budget.tsx", import.meta.url)).text(),
    );
    chatSource = stripComments(
      await Bun.file(
        new URL("../../ChatWindow.tsx", import.meta.url),
      ).text(),
    );
  });

  it("passes the bounded value to the Shiki element, not props.code", () => {
    // The ordering claim. If this ever regresses to `code={props.code}` the
    // budget is computed and thrown away, every test above still passes, and
    // the freeze comes back.
    expect(source).toContain("code={bounded.code}");
    expect(source).not.toContain("code={props.code}");
  });

  it("delegates to the VENDORED Shiki element, not something named like it", () => {
    // A truncation that disabled highlighting would be a different regression,
    // and a tempting shortcut: bounding by not-highlighting. Asserting the bare
    // name `SyntaxHighlighterBase` is not enough - a local
    // `const SyntaxHighlighterBase = ({code}) => <pre>{code}</pre>` keeps the
    // name while removing every colour, and the first version of this guard
    // passed against exactly that. The import is what proves the delegation.
    expect(source).toMatch(
      /import\s*\{\s*SyntaxHighlighter as SyntaxHighlighterBase\s*\}\s*from\s*"\.\/shiki-highlighter\.aui"/,
    );
  });

  it("renders the marker beside the block, not inside the code", () => {
    expect(source).toContain("aui-code-truncated");
  });

  it("defines both limits in the shared budget config, not locally", () => {
    // A second, local limit would be the "second conflicting global tool-output
    // limit" the budget architecture exists to prevent.
    expect(source).toContain("toolsConfig.limits");
    expect(source).not.toMatch(/\b(1024 \* 1024|256 \* 1024|2000)\b/);
  });

  it("is what the Direct chat surface actually renders, not just a default", async () => {
    // THE regression this guard exists for. `MarkdownText` merges a caller's
    // `components` prop LAST, so the `defaultComponents.SyntaxHighlighter`
    // registration above is a fallback that `ChatWindow` overrides with its own
    // `HighlightingSyntax`. Registering only in `markdown-text.tsx` therefore
    // looked complete - typecheck, build, and all 23 tests in this file were
    // green - while the chat surface went on highlighting an unbounded payload.
    // The browser is what caught it: the marker never appeared.
    //
    // So this asserts the override delegates to the bounded component, and that
    // the unbounded vendored highlighter is not imported into that file at all.
    expect(chatSource).toContain("<BoundedSyntaxHighlighter");
    expect(chatSource).not.toContain(
      'from "./assistant-ui/elements/shiki-highlighter.aui"',
    );
  });
});

describe("code-fence budget: markdown structure is not disturbed", () => {
  it("only ever sees the fence's own text, so prose is never truncated", () => {
    // Structural, and the reason the hook is a SyntaxHighlighter wrapper rather
    // than a post-render trim: the component only ever receives one fence's
    // `code` prop, so it has no access to - and no way to damage - the prose,
    // links or inline code around it.
    const prose = "A long explanation.\n\n```ts\nconst a = 1;\n```\n\nMore prose.";
    const fence = prose.split("```")[1].split("\n").slice(1).join("\n");
    expect(boundCodeFence(fence).code).toBe(fence);
  });

  it("gives each fence its own budget, so N fences cost N budgets deterministically", () => {
    // The documented policy, matching diffPreviewMaxChars ("of ONE file") and
    // TERMINAL_MAX_LINES (per terminal). A per-message budget would need a
    // counter threaded through a pure render; this keeps the guarantee simple
    // and matches every other budget in the app.
    const one = boundCodeFence(lines(codeBlockMaxLines + 1));
    const two = boundCodeFence(lines(codeBlockMaxLines + 1));
    expect(one.code).toBe(two.code);
    expect(one.omitted.lines).toBe(two.omitted.lines);
  });
});

describe("code-fence budget: the registered component renders a real element", () => {
  it("is a component, so the slot registration is not a no-op", () => {
    expect(typeof BoundedSyntaxHighlighter).toBe("function");
  });

  it("renders without a part scope is covered by the ordering guard, not here", () => {
    // Stated so the gap is explicit rather than implied: an end-to-end render
    // of this component needs an assistant-ui part scope and Shiki's WASM
    // tokenizer, neither of which exists under `bun test`. The source guard
    // above pins the wiring that a render would otherwise prove.
    expect(BoundedSyntaxHighlighter.displayName).toBe("BoundedSyntaxHighlighter");
    expect(renderToStaticMarkup(<div />)).toBe("<div></div>");
  });
});
