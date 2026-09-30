import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { toolsConfig } from "@/config/tools";
import { dirSummary } from "./ui";

/**
 * The `list_dir` result card body: a name column with a size column.
 *
 * ## The defects this pins
 *
 * 1. **Invalid HTML.** `dirSummary` emitted `<dt>`/`<dd>` inside a bare `<div>`
 *    with no `<dl>` parent. It rendered, so nothing failed visibly. It now
 *    renders through `ResultList`/`ResultRow` in `@/tools/result-fields`, and
 *    the row-structure contract is asserted in `result-rows.test.tsx`.
 * 2. **Emoji as an icon.** The listing painted `📁`/`📄`. An emoji does not
 *    inherit `currentColor`, cannot be sized with its row, and renders from
 *    whatever fallback font the platform picks — in a bundled desktop app that
 *    is a visible per-machine difference, not a style choice. Now lucide
 *    `Folder`/`File`.
 * 3. **A cap with no honesty about it.** Past `dirEntryMaxRows` the rest
 *    collapse to a count, and the count is the part that lets the reader decide
 *    whether the list is complete.
 *
 * ## Result shapes
 *
 * Quoted from `runList` in `src/services/tools.ts:426-444`:
 * `{ path, entries: [{ name, type: "dir" | "file" | "other", size: number | null }] }`.
 * `size` is `null` for a directory and for a `stat` that threw, which is why the
 * no-`<dd>` case is a real shape rather than a synthetic one.
 */

/**
 * Emoji, JS-side. PowerShell's `-match` cannot express `\u{1F4C1}`, so the check
 * has to live in the test rather than in a shell grep — which is also the only
 * way it is a real assertion instead of a convention.
 */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u;

/** `runList`'s entry, typed so a test fixture cannot drift from the tool. */
type DirEntry = { name: string; type: string; size: number | null };

// `dirSummary` takes the tool's result object as a plain argument rather than as
// component props, so it is called directly. It is a pure function of its
// argument — no hooks, no state — so this is the same render `createElement`
// would perform.
const render = (entries: DirEntry[]) =>
  renderToStaticMarkup(dirSummary({ path: "web/src", entries }));

const countOf = (html: string, needle: string) => html.split(needle).length - 1;

describe("dirSummary: the shape of a directory listing", () => {
  it("renders no emoji anywhere, so the icon follows the theme", () => {
    // The defect: 📁 / 📄. Asserted as a range rather than as two literals so a
    // different emoji cannot slip through the same hole.
    const html = render(
      [
        { name: "src", type: "dir", size: null },
        { name: "a.ts", type: "file", size: 12 },
      ],
    );
    expect(EMOJI_RE.test(html)).toBe(false);
  });

  it("marks a directory with the Folder icon and anything else with File", () => {
    // `runList` emits a third type, `"other"` (a socket, a symlink), and it has
    // no icon of its own — the file glyph is the honest default for it.
    const dir = render([{ name: "src", type: "dir", size: null }]);
    expect(dir).toContain("lucide-folder");
    expect(dir).not.toContain("lucide-file");

    const file = render([{ name: "a.ts", type: "file", size: 12 }]);
    expect(file).toContain("lucide-file");
    expect(file).not.toContain("lucide-folder");

    const other = render([{ name: "sock", type: "other", size: null }]);
    expect(other).toContain("lucide-file");
  });

  it("draws the icon in currentColor, so it tracks the card's text colour", () => {
    // A glyph that hardcodes a stroke cannot follow a muted or destructive
    // context, and an emoji cannot follow one at all.
    const html = render([{ name: "src", type: "dir", size: null }]);
    expect(html).toContain('stroke="currentColor"');
  });

  it("renders a file's size and no dd at all for a directory", () => {
    // `size` is `null` for a directory, so an empty right-hand cell would be a
    // blank column on most rows of a typical listing.
    const html = render(
      [
        { name: "src", type: "dir", size: null },
        { name: "a.ts", type: "file", size: 12 },
      ],
    );
    expect(countOf(html, "<dd")).toBe(1);
    expect(html).toContain("12 B");

    const onlyDir = render([{ name: "src", type: "dir", size: null }]);
    expect(onlyDir).not.toContain("<dd");
  });

  it("gives every entry its own row, named the way the reader told us", () => {
    // Row identity is the entry name — that is what `readdirSync` returns and
    // what distinguishes one row from another. Two entries with different names
    // must be two rows, each named once, or the listing merges them.
    const html = render(
      [
        { name: "src", type: "dir", size: null },
        { name: "docs", type: "dir", size: null },
      ],
    );
    expect(countOf(html, "<dt")).toBe(2);
    expect(countOf(html, ">src</span>")).toBe(1);
    expect(countOf(html, ">docs</span>")).toBe(1);
  });

  it("collapses past the cap and says how many rows it left out", () => {
    const many: DirEntry[] = [];
    for (let i = 0; i < toolsConfig.limits.dirEntryMaxRows + 7; i += 1) {
      many.push({ name: `f${i}.ts`, type: "file", size: i });
    }
    const html = render(many);
    expect(countOf(html, "<dt")).toBe(toolsConfig.limits.dirEntryMaxRows);
    expect(html).toContain(toolsConfig.copy.status.andMoreCount(7));
    // The count is the reader's only evidence the list is partial, so it must
    // be the real overflow and not a rounded or capped figure.
    expect(html).not.toContain(toolsConfig.copy.status.andMoreCount(6));
  });

  it("says nothing about omitted rows when the listing fits", () => {
    const html = render(
      [
        { name: "a.ts", type: "file", size: 1 },
        { name: "b.ts", type: "file", size: 2 },
      ],
    );
    expect(html).not.toContain(toolsConfig.copy.status.andMoreCount(0));
    // Every omission note this component can render starts with an ellipsis, and
    // nothing else in a listing does — so its absence is "no note at all",
    // not merely "not the wrong number".
    expect(html).not.toContain("…");
  });

  it("says the folder is empty rather than rendering an empty list", () => {
    // Zero rows would look like a card that failed to load, which is a
    // different claim from "there is nothing in here". The last two are the
    // unreadable results the `r?.entries ?? []` guard exists for: a result with
    // no `entries` key, and no result at all.
    for (const result of [
      { path: "web/src", entries: [] as DirEntry[] },
      { path: "web/src" },
      undefined,
    ]) {
      const html = renderToStaticMarkup(dirSummary(result));
      expect(html).toContain(toolsConfig.copy.status.emptyFolder);
      expect(html).not.toContain("<dl");
    }
  });

  it("carries its own data-slot, distinct from the flat-field list", () => {
    // Two surfaces, two slots: a test targeting one must not pass on the other.
    const html = render([{ name: "a.ts", type: "file", size: 1 }]);
    expect(html).toContain('data-slot="tool-result-entries"');
    expect(html).not.toContain('data-slot="tool-result-fields"');
  });
});
