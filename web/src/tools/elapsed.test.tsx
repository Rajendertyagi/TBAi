import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { stripComments } from "@/testing/source-scope";
import { ToolElapsed, formatDuration } from "./elapsed";

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
    // The expression moved into `formatDuration` when long spans stopped
    // rendering as `3618.8s`. The one-decimal seconds form is still the rule for
    // anything under a minute, so the guard follows the rule rather than the old
    // inline position.
    expect(source).toContain("(safe / 1000).toFixed(1)");
  });

  it("routes the rendered value through the formatter, not an inline expression", () => {
    // A direct source guard, because the formatter is the only thing standing
    // between a three-hour build and a card reading `11423.8s`. If a later change
    // inlines a second format next to it, this fails.
    expect(source).toContain("{formatDuration(elapsedMs)}");
  });

  it("returns null rather than a zero when there is no timing", () => {
    expect(source).toContain("if (elapsedMs === undefined) return null;");
  });
});

describe("formatDuration", () => {
  it("keeps the library's own form under a minute, which is what it is good at", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(400)).toBe("0.4s");
    expect(formatDuration(1400)).toBe("1.4s");
    expect(formatDuration(12_340)).toBe("12.3s");
    expect(formatDuration(59_999)).toBe("60.0s");
  });

  it("switches to minutes and seconds at exactly a minute", () => {
    // The boundary is pinned in both directions: 59.999s is still "60.0s", and
    // 60.0s is "1m 00s". A fence that only just fits is the case an off-by-one
    // hides, because both sides look plausible.
    expect(formatDuration(59_999)).toBe("60.0s");
    expect(formatDuration(60_000)).toBe("1m 00s");
    expect(formatDuration(134_000)).toBe("2m 14s");
    expect(formatDuration(3_599_000)).toBe("59m 59s");
  });

  it("switches to hours at exactly an hour, and drops seconds", () => {
    // The value this was written for: a real failed `shell` call rendered
    // `3618.8s`, which no reader can parse at a glance.
    expect(formatDuration(3_618_800)).toBe("1h 00m");
    expect(formatDuration(3_660_000)).toBe("1h 01m");
    expect(formatDuration(3_661_900)).toBe("1h 01m");
    expect(formatDuration(7_500_000)).toBe("2h 05m");
  });

  it("zero-pads the second unit so the badge width does not jump", () => {
    // The value ticks once a second while a call runs, so a changing digit
    // width shoves the row around. This is the same reason the badge uses
    // `tabular-nums`.
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(610_000)).toBe("10m 10s");
    expect(formatDuration(3_690_000)).toBe("1h 01m");
  });

  it("treats a nonsense duration as zero rather than printing NaN", () => {
    // A badge that reads "NaNs" is worse than one that reads "0.0s": the first
    // looks like a bug in the card, the second is a number about a call that
    // just started.
    expect(formatDuration(Number.NaN)).toBe("0.0s");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0.0s");
    expect(formatDuration(-5000)).toBe("0.0s");
  });

  it("never emits a unit the reader has to decode", () => {
    // A property rather than more examples: whatever the input, the result is one
    // of the three documented shapes and nothing else. A fourth format creeping
    // in for some range would show up here.
    for (const ms of [0, 999, 59_999, 60_000, 134_000, 3_599_999, 3_618_800, 86_400_000]) {
      expect(formatDuration(ms)).toMatch(/^\d+\.\d+s$|^\d+m \d{2}s$|^\d+h \d{2}m$/);
    }
  });
});
