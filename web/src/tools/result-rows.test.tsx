import { describe, expect, it } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResultList, ResultRow } from "./result-fields";

/**
 * The two primitives every tool-result row list in this app is built from.
 *
 * ## The defect this pins
 *
 * `dirSummary`, `processSummary` and `FieldList` each wrote the same
 * `flex justify-between` + truncate + "and N more" note, and two of the three
 * emitted `<dt>`/`<dd>` inside a **bare `<div>`** with no `<dl>` parent. That is
 * not valid HTML: `dt` and `dd` are only meaningful as children of a
 * description list, and a browser silently reparents them. The rows rendered,
 * so nothing failed visibly and nothing tested it.
 *
 * So the first case here is the regression: the rows must be inside a `<dl>`.
 * It is asserted on the *markup shape* rather than on a substring, so reverting
 * `ResultList` to a `<div>` fails it.
 *
 * ## Why the other cases exist
 *
 * The shared pair also owns three contracts that were previously each
 * re-implemented per caller, and each has a way to fail quietly:
 *
 *  - the icon sits OUTSIDE the truncating `<span>`, because a glyph that is the
 *    thing being clipped is worse than no glyph;
 *  - a missing value emits NO `<dd>`, because an empty `<dd>` is a blank
 *    column the reader cannot interpret;
 *  - the omission note appears only when rows were actually withheld, because a
 *    note reading "and 0 more" is a lie about the result.
 */

/** The icon a caller would pass; a bare element keeps the assertion on position. */
const icon = createElement("span", { className: "glyph", "data-icon": "1" });

const renderRow = (props: {
  icon?: ReactNode;
  label: ReactNode;
  value?: ReactNode;
  valueTitle?: string;
}) => renderToStaticMarkup(createElement(ResultRow, props));

// `children` is passed inside the props object rather than as a rest argument:
// `ResultList` declares it as a required key, and React's `createElement`
// overload types `props` as `Attributes & P` without letting a rest child
// satisfy it. Both spellings produce identical markup.
const renderList = (
  props: { slot: string; omitted?: number; omittedLabel: (count: number) => string },
  children: ReactNode,
) => renderToStaticMarkup(createElement(ResultList, { ...props, children }));

/**
 * A stand-in for the omission note a listing caller passes. The real ones live
 * in `toolsConfig.copy.status`; this one is local so a case asserts the note was
 * BUILT from the withheld count rather than matching a string it also supplies.
 */
const omittedLabelFor = (count: number) => `…and ${count} more`;

describe("ResultList: the rows form a real description list", () => {
  it("emits dt and dd inside a dl, not inside a bare div", () => {
    const html = renderList(
      { slot: "tool-result-x", omittedLabel: omittedLabelFor },
      createElement(ResultRow, { key: "a", label: "a", value: "1" }),
    );

    // The element itself, asserted as an opening tag at position 0 — a revert of
    // `ResultList` to a `<div data-slot=…>` cannot satisfy this.
    expect(html.startsWith("<dl ")).toBe(true);
    expect(html.endsWith("</dl>")).toBe(true);

    // And the children are inside it: every `dt` and every `dd` sits strictly
    // between the `dl`'s own open and close.
    const open = html.indexOf("<dl");
    const close = html.indexOf("</dl>");
    for (const tag of ["<dt", "<dd"]) {
      let at = html.indexOf(tag);
      expect(at).toBeGreaterThan(open);
      while (at !== -1) {
        expect(at).toBeLessThan(close);
        at = html.indexOf(tag, at + 1);
      }
    }
  });

  it("keeps the dt and the dd inside one grouping element, which is valid in a dl", () => {
    // The row is one element wrapping a single dt/dd pair. That is legal as a
    // `dl` child; what was illegal was the same element with no `dl` above it.
    // Pinned structurally rather than by class string, so tuning the row's
    // spacing is not a test failure but ungrouping the pair still is.
    const html = renderList(
      { slot: "tool-result-x", omittedLabel: omittedLabelFor },
      createElement(ResultRow, { key: "a", label: "a", value: "1" }),
    );
    const group = html.slice(html.indexOf(">") + 1, html.indexOf("</dl>"));
    expect(group.startsWith("<div")).toBe(true);
    expect(group).toContain("<dt");
    expect(group).toContain("<dd");
    // One group, one pair: a second `</div>` before `</dl>` would mean the dt
    // and the dd had been split across two rows.
    expect(group.indexOf("</div>")).toBe(group.length - "</div>".length);
  });

  it("puts the caller's slot on data-slot", () => {
    const html = renderList(
      { slot: "tool-result-entries", omittedLabel: omittedLabelFor },
      createElement(ResultRow, { key: "a", label: "a" }),
    );
    expect(html).toContain('data-slot="tool-result-entries"');
  });
});

describe("ResultRow: one label-left, value-right row", () => {
  it("renders the icon outside the truncating span", () => {
    const html = renderRow({ icon, label: "src", value: "12 B" });

    // The label is truncated, so it is the span that clips. An icon inside it
    // would be the first thing to disappear on a long name.
    const span = html.indexOf('<span class="truncate">');
    expect(span).toBeGreaterThan(-1);
    const iconAt = html.indexOf('data-icon="1"');
    expect(iconAt).toBeGreaterThan(-1);
    expect(iconAt).toBeLessThan(span);
    // And it is not merely earlier in the string — it is not INSIDE the span.
    const spanBody = html.slice(html.indexOf(">", span) + 1, html.indexOf("</span>"));
    expect(spanBody).not.toContain('data-icon="1"');
  });

  it("emits no dd at all when there is no value", () => {
    // `size: null` on a directory and `memoryMB: null` on a process both reach
    // here. An empty `<dd>` would be an unreadable blank column.
    const html = renderRow({ label: "src" });
    expect(html).not.toContain("<dd");
    expect(html).toContain("src");
  });

  it("emits the dd when a value is present, with the full value in the title", () => {
    // The dd is `shrink-0` and can still overflow a narrow card, so the full
    // value has to remain reachable rather than being clipped away silently.
    const html = renderRow({ label: "a.ts", value: "12 B", valueTitle: "12 B" });
    expect(html).toContain("<dd");
    expect(html).toContain('title="12 B"');
    expect(html).toContain("12 B");
  });

  it("keeps the value when the label is long enough to need truncating", () => {
    // CSS truncation is a paint-time decision; the value must be in the markup
    // regardless of how wide the label is.
    const long = `deeply/${"nested/".repeat(40)}file.ts`;
    const html = renderRow({ label: long, value: "12 B" });
    expect(html).toContain(long);
    expect(html).toContain("12 B");
  });
});

describe("ResultList: the omission note", () => {
  it("says nothing when no rows were withheld", () => {
    const rows = createElement(ResultRow, { key: "a", label: "a" });
    expect(renderList({ slot: "s", omittedLabel: omittedLabelFor }, rows)).not.toContain(
      "and 0 more",
    );
    expect(
      renderList({ slot: "s", omitted: 0, omittedLabel: omittedLabelFor }, rows),
    ).not.toContain("and 0 more");
  });

  it("names the withheld count when rows were withheld", () => {
    const html = renderList(
      { slot: "s", omitted: 3, omittedLabel: omittedLabelFor },
      createElement(ResultRow, { key: "a", label: "a" }),
    );
    expect(html).toContain("…and 3 more");
  });

  it("builds the note from the caller's own label, not a shared string", () => {
    // `dirSummary`/`processSummary` say "and N more"; `FieldList` says
    // "N more fields not shown". One shared note would make a flat result claim
    // rows were hidden that were never fields.
    const html = renderList(
      { slot: "s", omitted: 2, omittedLabel: (n) => `…${n} more fields not shown` },
      createElement(ResultRow, { key: "a", label: "a" }),
    );
    expect(html).toContain("…2 more fields not shown");
    expect(html).not.toContain("…and 2 more");
  });
});
