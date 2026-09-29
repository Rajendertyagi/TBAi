import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { stripComments } from "@/testing/source-scope";
import { ToolElapsed } from "./elapsed";

/**
 * The duration badge's contract, and the regression it exists to prevent.
 *
 * ## The regression, stated once
 *
 * `useToolCallElapsed` reads `s.optional.part.timing`. Its own docblock says it
 * returns `undefined` "when no message part scope is available (so kit
 * components stay renderable standalone)". It does not — outside a part scope
 * `s.optional` is `undefined` and the selector throws. Mounting the badge
 * directly inside `ToolCard` broke five `websearch.test.tsx` cases, which
 * render these renderers bare with `react-dom/server` and no `AuiProvider`.
 *
 * So the badge reads the scope itself, null-safely, and only mounts the library
 * hook when a scope is actually there.
 *
 * ## What is and is not asserted here
 *
 * The formatting cases are source-level, and that is a deliberate limit rather
 * than a shortcut: the badge's classes and its `toFixed(1)` only exist once a
 * part scope is present, and a static render has none. Constructing a real part
 * scope means mounting a provider and a part, which is the browser's job, not
 * this file's — so the DOM-visible formatting is verified in the app and the
 * literal contract is pinned here. Both are scoped to this module's own body
 * with COMMENTS STRIPPED, which is load-bearing rather than ceremonial: this
 * component's docblock explains at length why it does NOT use `setInterval` and
 * `Date.now()`, so an unstripped match would prove the opposite of the rule and
 * fail the "no hand-rolled timer" assertion for the wrong reason.
 */

const source = stripComments(
  await Bun.file(new URL("./elapsed.tsx", import.meta.url)).text(),
);

describe("ToolElapsed outside a message part", () => {
  it("renders nothing rather than throwing", () => {
    // The regression. A tool renderer mounted bare — no AuiProvider, no part
    // scope — must still render, because that is how the render tests and any
    // docs preview mount it.
    expect(renderToStaticMarkup(<ToolElapsed />)).toBe("");
  });

  it("emits no placeholder for a missing duration", () => {
    // "0.0s" on a call the runtime never timed is a number about nothing, so
    // the absence of timing must produce absence of text.
    const html = renderToStaticMarkup(<ToolElapsed />);
    expect(html).not.toContain("0.0s");
    expect(html).toBe("");
  });
});

describe("ToolElapsed reads the runtime's own timing", () => {
  it("uses the library hook rather than a hand-rolled interval", () => {
    // The reason this component exists. A local setInterval/Date.now timer
    // would be a second source of truth for duration, measured from mount
    // rather than from the timing the runtime recorded, and it would keep
    // counting for a call that already finished.
    expect(source).toContain("useToolCallElapsed");
    expect(source).not.toContain("setInterval");
    expect(source).not.toContain("Date.now()");
  });

  it("reads the part scope defensively instead of letting the selector throw", () => {
    expect(source).toContain("optional?.part");
  });
});

describe("ToolElapsed presentation contract", () => {
  it("uses tabular numerals so a ticking value cannot move the row", () => {
    // A plain proportional digit width would shove the row sideways once per
    // second. This is a layout promise, so it is pinned as a literal.
    expect(source).toContain("tabular-nums");
  });

  it("uses the existing muted token at the existing small size", () => {
    // No new token, no new size, no new colour: the badge is metadata about the
    // card, so it takes the muted foreground the card already uses.
    expect(source).toContain("text-xs");
    expect(source).toContain("text-muted-foreground");
  });

  it("formats seconds with one decimal, matching the hook's own example", () => {
    expect(source).toContain("(elapsedMs / 1000).toFixed(1)");
  });

  it("returns null rather than a zero when there is no timing", () => {
    expect(source).toContain("if (elapsedMs === undefined) return null;");
  });
});
