/**
 * Render-cap tests for the vendored `ToolFallback` element's args and result
 * bodies — the ONE deviation this repo makes to the upstream element.
 *
 * WHY THIS IS RENDER-VERIFIED, NOT SOURCE-GUARDED. `ToolFallbackArgs` and
 * `ToolFallbackResult` are both exported from `tool-fallback.tsx`, and neither
 * reads the assistant runtime: they are plain prop-to-`<pre>` components, so
 * `react-dom/server` renders them under `bun test` with no DOM and no runtime
 * provider (the same path `web/tests/rendering.test.tsx` already uses for
 * `CodeDiff`). What a user sees is therefore assertable here, not inferred from
 * the source. The full composite still needs the runtime and stays out of scope.
 *
 * THE CONTRACT. Upstream renders both bodies in full, so a tool called with a
 * huge argument — or an MCP tool answering with a page of HTML — pushes an
 * unbounded string through the DOM and the card grows until the transcript
 * stops being usable. Both bodies must now:
 *   1. pass through the app's shared `textPreview` helper, so a truncated body
 *      SAYS it is truncated instead of quietly lying about being complete; and
 *   2. paint inside a height-capped, scrollable box.
 * A body inside the cap must come through byte-for-byte unchanged — the cap is a
 * ceiling, not a new rendering shape. `ToolFallbackError` is deliberately NOT
 * capped (a one-line reason, not a tool body) and that is pinned too, because
 * "we only meant the big ones" is exactly the kind of rule that rots silently.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackError,
} from "@/components/assistant-ui/elements/tool-fallback";
import { functionBody, stripComments } from "@/testing/source-scope";
import { toolsConfig } from "@/config/tools";

/** Mirrors `textPreview`'s cap, read from the shared config rather than repeated. */
const PREVIEW_MAX = toolsConfig.limits.toolArgPreviewMaxChars;
/**
 * The helper's own truncation marker. Spelled with an escape rather than a
 * literal glyph so this file cannot be misread by a tool that re-encodes it.
 */
const moreChars = (dropped: number) =>
  `\n\u2026${dropped} more character${dropped === 1 ? "" : "s"} not shown`;
/** Matches the marker without pinning how many chars were dropped. */
const MORE_CHARS_SHAPE = /\u2026\d+ more characters? not shown$/;

/** The single `<pre>` a body painted, split into its open tag and its text. */
function pre(html: string): { openTag: string; text: string } {
  const open = /<pre\b[^>]*>/.exec(html);
  if (open === null) throw new Error("no <pre> was rendered");
  const start = open.index + open[0].length;
  const end = html.indexOf("</pre>", start);
  if (end === -1) throw new Error("the <pre> was never closed");
  return { openTag: open[0], text: html.slice(start, end) };
}

const renderArgs = (argsText?: string) =>
  renderToStaticMarkup(<ToolFallbackArgs argsText={argsText} />);
const renderResult = (result?: unknown) =>
  renderToStaticMarkup(<ToolFallbackResult result={result} />);

const BIG = "x".repeat(5000);
const SHORT = "first line\nsecond line";

describe("ToolFallbackArgs — capped and scrollable", () => {
  it("caps an oversized body and names how many characters it dropped", () => {
    const { text } = pre(renderArgs(BIG));
    expect(text).toBe(`${"x".repeat(PREVIEW_MAX)}${moreChars(3000)}`);
    // The point of the cap: the DOM gets ~2 KB, not the whole payload.
    expect(text.length).toBeLessThan(BIG.length);
  });

  it("paints the body inside a height-capped, scrollable box", () => {
    const { openTag } = pre(renderArgs(SHORT));
    expect(openTag).toContain("max-h-64");
    expect(openTag).toContain("overflow-auto");
  });

  it("leaves a body inside the cap byte-for-byte unchanged", () => {
    const { text } = pre(renderArgs(SHORT));
    expect(text).toBe(SHORT);
    expect(text).not.toContain("more chars");
  });

  it("renders nothing at all without args", () => {
    expect(renderArgs(undefined)).toBe("");
    expect(renderArgs("")).toBe("");
  });
});

describe("ToolFallbackResult — capped and scrollable", () => {
  it("caps an oversized body and names how many characters it dropped", () => {
    const { text } = pre(renderResult(BIG));
    expect(text).toBe(`${"x".repeat(PREVIEW_MAX)}${moreChars(3000)}`);
    expect(text.length).toBeLessThan(BIG.length);
  });

  it("paints the body inside a height-capped, scrollable box", () => {
    const { openTag } = pre(renderResult(SHORT));
    expect(openTag).toContain("max-h-64");
    expect(openTag).toContain("overflow-auto");
  });

  it("leaves a body inside the cap byte-for-byte unchanged", () => {
    const { text } = pre(renderResult(SHORT));
    expect(text).toBe(SHORT);
    expect(text).not.toContain("more chars");
  });

  it("serialises a non-string result before capping it", () => {
    // The cap is applied to what the DOM receives, so a non-string result is
    // still pretty-printed JSON first — an object is never stringified down to
    // "[object Object]", and the cap never changes how it is serialised.
    const value = { a: 1, b: [2, 3] };
    const { text } = pre(renderResult(value));
    expect(text).toBe(JSON.stringify(value, null, 2).replace(/"/g, "&quot;"));
  });

  it("caps a serialised object whose JSON overruns the budget", () => {
    const { text } = pre(renderResult({ blob: "x".repeat(5000) }));
    // The JSON wrapper is part of the capped payload, so the serialised length
    // — not the raw value length — decides how much is dropped.
    expect(text).toMatch(MORE_CHARS_SHAPE);
    expect(text.length).toBeLessThan(
      JSON.stringify({ blob: "x".repeat(5000) }, null, 2).length,
    );
    expect(text.startsWith('{\n  &quot;blob&quot;: &quot;x')).toBe(true);
  });

  it("renders nothing at all without a result", () => {
    expect(renderResult(undefined)).toBe("");
  });
});

describe("ToolFallbackError — deliberately NOT capped", () => {
  const renderError = (error: string) =>
    renderToStaticMarkup(
      <ToolFallbackError
        status={{ type: "incomplete", reason: "tool-calls", error }}
      />,
    );

  it("paints the one-line reason in a plain, unscrollable paragraph", () => {
    const html = renderError("boom");
    expect(html).toContain("boom");
    expect(html).not.toContain("<pre");
    expect(html).not.toContain("max-h-64");
    expect(html).not.toContain("overflow-auto");
  });

  it("does not truncate even a long reason", () => {
    const long = "e".repeat(5000);
    const html = renderError(long);
    expect(html).toContain(long);
    expect(html).not.toContain("more chars");
  });
});

describe("the cap has exactly one implementation", () => {
  /**
   * The render assertions above cannot tell the app's shared `textPreview`
   * from a private re-implementation that happens to produce the same string,
   * so the single-source rule is guarded at the source. Comments are stripped
   * and each match must sit inside the component's own body: the file header
   * prose describing the cap can never satisfy these.
   */
  let source = "";
  let argsBody = "";
  let resultBody = "";

  beforeAll(async () => {
    source = stripComments(
      await Bun.file(
        new URL(
          "../src/components/assistant-ui/elements/tool-fallback.tsx",
          import.meta.url,
        ),
      ).text(),
    );
    argsBody = functionBody(source, "ToolFallbackArgs");
    resultBody = functionBody(source, "ToolFallbackResult");
  });

  it("imports the shared helper rather than re-implementing a cap", () => {
    expect(source).toMatch(
      /import\s*\{\s*textPreview\s*\}\s*from\s*"@\/tools\/filesystem\/ui"/,
    );
  });

  it("routes both bodies through that helper", () => {
    expect(argsBody).toContain("textPreview(argsText)");
    expect(resultBody).toContain("textPreview(formatUnknownValue(result, 2))");
  });

  it("does not redefine the helper locally", () => {
    // A copied-in cap would be a second implementation to tune. The effective
    // cap itself is pinned by the render assertions above.
    expect(source).not.toMatch(
      /(?:function|const|let|var)\s+textPreview\b/,
    );
  });
});
