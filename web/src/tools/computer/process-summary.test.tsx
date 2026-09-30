import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { toolsConfig } from "@/config/tools";
import { processSummary } from "./ui";

/**
 * The `process_list` result card body: a name column with a memory column.
 *
 * ## The defect this pins
 *
 * `processSummary` emitted `<dt>`/`<dd>` inside a bare `<div>` with no `<dl>`
 * parent — the same invalid HTML `dirSummary` had, and the same reason it went
 * unnoticed: the rows rendered. It now renders through `ResultList`/`ResultRow`
 * in `@/tools/result-fields`; the row-structure contract is asserted once, in
 * `result-rows.test.tsx`, rather than duplicated per caller.
 *
 * ## What is specific to this card
 *
 * The label is `name (pid)` rather than the name alone, because a process list
 * routinely carries two rows with the same executable name (a browser's main
 * process and its renderers) and the pid is the only thing that tells them
 * apart. And `memoryMB` is nullable — see below — so the missing-value case is
 * the common one, not a corner.
 *
 * ## Result shape
 *
 * Quoted from `runProcesses` in `src/services/tools.ts:579-590`:
 * `{ count, processes: [{ pid, name, cpuSeconds, memoryMB }] }`, where
 * `memoryMB` is `p.MemoryMB ?? null` and so is genuinely absent for a process
 * PowerShell declined to report it for.
 */

/** One row of `runProcesses`' `processes`, typed as the tool returns it. */
type Proc = { pid: number; name: string; cpuSeconds: number | null; memoryMB: number | null };

// `processSummary` takes the tool's result object as a plain argument rather
// than as component props, so it is called directly. It is a pure function of
// its argument — no hooks, no state — so this is the same render `createElement`
// would perform.
const render = (processes: Proc[]) =>
  renderToStaticMarkup(processSummary({ count: processes.length, processes }));

const countOf = (html: string, needle: string) => html.split(needle).length - 1;

describe("processSummary: the shape of a process listing", () => {
  it("labels the row with the name and the pid, and values it with the memory", () => {
    // The pid is in the label, not the value, so the right-hand column is one
    // unit wide and two rows with the same executable name stay tellable apart.
    const html = render([{ pid: 4212, name: "chrome", cpuSeconds: 91.5, memoryMB: 512.4 }]);
    expect(html).toContain("chrome (4212)");
    expect(html).toContain("512.4 MB");
    expect(countOf(html, "<dt")).toBe(1);
  });

  it("emits no dd at all for a process with no reported memory", () => {
    // `memoryMB: null` is what `p.MemoryMB ?? null` produces, so this is the
    // shape a real listing contains — and an empty right-hand cell would be a
    // blank column the reader cannot read as "unknown".
    const html = render(
      [
        { pid: 1, name: "System", cpuSeconds: null, memoryMB: null },
        { pid: 2, name: "explorer", cpuSeconds: 4, memoryMB: 88 },
      ],
    );
    expect(countOf(html, "<dd")).toBe(1);
    expect(html).toContain("88 MB");
    expect(html).toContain("System (1)");
  });

  it("collapses past the cap and says how many rows it left out", () => {
    const many: Proc[] = [];
    for (let i = 0; i < toolsConfig.limits.processRowMaxRows + 12; i += 1) {
      many.push({ pid: 100 + i, name: `proc${i}`, cpuSeconds: i, memoryMB: i * 1.5 });
    }
    const html = render(many);
    expect(countOf(html, "<dt")).toBe(toolsConfig.limits.processRowMaxRows);
    expect(html).toContain(toolsConfig.copy.status.andMoreCount(12));
    expect(html).not.toContain(toolsConfig.copy.status.andMoreCount(11));
  });

  it("says no processes are running rather than rendering an empty list", () => {
    // Zero rows would look like a card that failed to load, which is a
    // different claim from "the machine is idle". The last two are the
    // unreadable results the `r?.processes ?? []` guard exists for: a result
    // with no `processes` key, and no result at all.
    for (const result of [
      { count: 0, processes: [] as Proc[] },
      { count: 0 },
      undefined,
    ]) {
      const html = renderToStaticMarkup(processSummary(result));
      expect(html).toContain(toolsConfig.copy.status.noProcesses);
      expect(html).not.toContain("<dl");
    }
  });

  it("carries its own data-slot, distinct from the other row lists", () => {
    const html = render([{ pid: 1, name: "a", cpuSeconds: 0, memoryMB: 1 }]);
    expect(html).toContain('data-slot="tool-result-processes"');
    expect(html).not.toContain('data-slot="tool-result-fields"');
  });
});
