import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toolsConfig } from "@/config/tools";
import { flatResultFields, FieldsOrJson } from "./result-fields";

/**
 * Flat tool results render as labelled rows; anything else falls back to a
 * bounded JSON body.
 *
 * The six tools this replaced — `file_info`, `system_info`, `scheduler`,
 * `delete_file`, `process_kill`, `write_file` — all return the same kind of
 * thing: a small flat object of named primitives. They were being painted as
 * `JSON.stringify(…, null, 2)`, which spent a card's width on braces and
 * indentation to make one fact findable.
 *
 * The cases that matter are the refusals. A component that renders `[object
 * Object]` or an empty list for a nested result would be worse than the JSON it
 * replaced, so "is this flat?" is the whole contract and it is tested from both
 * sides.
 */

const render = (value: unknown) =>
  renderToStaticMarkup(createElement(FieldsOrJson, { value }));

describe("flatResultFields: what counts as a flat result", () => {
  it("accepts the real shapes these six tools return", () => {
    // Quoted from `src/services/tools.ts`, not invented.
    expect(flatResultFields({ path: "a.txt", deleted: true, wasDir: false })).not.toBeNull();
    expect(flatResultFields({ path: "a.txt", bytes: 12, created: false })).not.toBeNull();
    expect(flatResultFields({ pid: 42, killed: true })).not.toBeNull();
    expect(
      flatResultFields({
        platform: "win32",
        arch: "x64",
        cpuCount: 16,
        totalMemoryMB: 32_000,
        uptimeHours: 4.2,
      }),
    ).not.toBeNull();
  });

  it("accepts null and empty-string values as primitives", () => {
    // `os.cpus()[0]?.model ?? "unknown"` can be null, and a legitimately empty
    // string is still a field. Treating either as "not flat" would drop a real
    // result to the JSON fallback for no reason.
    expect(flatResultFields({ a: null, b: "" })).not.toBeNull();
  });

  it("refuses anything nested, because rows would show [object Object]", () => {
    expect(flatResultFields({ entries: [{ name: "a" }] })).toBeNull();
    expect(flatResultFields({ meta: { a: 1 } })).toBeNull();
  });

  it("refuses arrays, strings and numbers", () => {
    expect(flatResultFields([1, 2, 3])).toBeNull();
    expect(flatResultFields("plain text")).toBeNull();
    expect(flatResultFields(42)).toBeNull();
    expect(flatResultFields(null)).toBeNull();
    expect(flatResultFields(undefined)).toBeNull();
  });

  it("refuses an empty object, since there is nothing to list", () => {
    // Rendering zero rows would look like a card that failed to load.
    expect(flatResultFields({})).toBeNull();
  });

  it("caps the rows and reports how many it hid", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < toolsConfig.limits.resultFieldMaxRows + 5; i += 1) many[`k${i}`] = i;
    const flat = flatResultFields(many);
    expect(flat?.fields).toHaveLength(toolsConfig.limits.resultFieldMaxRows);
    expect(flat?.hidden).toBe(5);
  });
});

describe("FieldsOrJson: the rendered result", () => {
  it("paints a flat result as labelled rows, not as JSON", () => {
    const html = render({ path: "src/a.ts", deleted: true, wasDir: false });
    expect(html).toContain("src/a.ts");
    expect(html).toContain("deleted");
    expect(html).toContain("wasDir");
    // The braces and quotes of a serialised object are exactly what this
    // replaces, so their absence is the assertion.
    expect(html).not.toContain("&quot;deleted&quot;");
    expect(html).toContain('data-slot="tool-result-fields"');
  });

  it("writes a boolean as a word, not as 0/1", () => {
    // `true`/`false` read as the answer to "did it work", which is what a
    // deletion card is actually saying.
    expect(render({ deleted: true })).toContain("yes");
    expect(render({ deleted: false })).toContain("no");
  });

  it("marks an empty value as empty rather than showing nothing", () => {
    // A blank row is unreadable: the reader cannot tell "empty" from "broken".
    expect(render({ name: "" })).toContain("empty");
  });

  it("falls back to a bounded JSON body for a nested result", () => {
    const html = render({ entries: [{ name: "a", type: "file" }] });
    expect(html).toContain('class="aui-tool-body"');
    expect(html).not.toContain('data-slot="tool-result-fields"');
    // The fallback is still serialised, so the data is not merely dropped.
    expect(html).toContain("entries");
  });

  it("falls back for a plain string rather than splitting it into characters", () => {
    const html = render("just some output");
    expect(html).toContain("just some output");
    expect(html).not.toContain('data-slot="tool-result-fields"');
  });

  it("shows the cap when a flat result is too wide to list", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < toolsConfig.limits.resultFieldMaxRows + 3; i += 1) many[`k${i}`] = i;
    const html = render(many);
    expect(html).toContain("3 more fields not shown");
  });
});
