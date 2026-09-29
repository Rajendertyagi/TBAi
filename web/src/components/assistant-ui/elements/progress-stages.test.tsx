import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressStages, type ProgressData } from "./progress-stages";

/**
 * The progress renderer, and the name it now has.
 *
 * This component was `TodoList`, which was actively misleading: it renders the
 * server's *aggregated progress stages*, not a task list, and an audit wrote that
 * misnomer down as a finding ("three designs for one todo feature"). The rename
 * is the fix, and this test is what makes the rename mean something — a renderer
 * that compiles but paints nothing is exactly the failure this repo has been
 * bitten by twice.
 *
 * The `null` case is load-bearing rather than defensive: an interrupted run leaves
 * a message whose only part is an empty progress part, and rendering a panel for
 * it produced a blank assistant bubble in the thread. That is measured, not
 * hypothetical — see `src/lib/message-persistence-policy.ts`.
 */

type Stage = ProgressData["stages"][number];

const progress = (stages: Stage[]): ProgressData => ({
  kind: "tbai-progress",
  version: 1,
  stages,
});

/** One finished, one in flight — the state a run is actually in mid-turn. */
const stages = (): ProgressData =>
  progress([
    { id: "inspect", label: "Inspecting workspace", status: "completed" },
    { id: "read", label: "Reading files", status: "active" },
  ]);

const render = (data: unknown) =>
  renderToStaticMarkup(
    createElement(ProgressStages as never, { data } as never),
  );

describe("the progress panel", () => {
  it("names the progress and every stage", () => {
    const html = render(stages());
    expect(html).toContain("Agent progress");
    expect(html).toContain("Inspecting workspace");
    expect(html).toContain("Reading files");
  });

  it("counts what is in flight while work is running", () => {
    // One active of two: the reader is told both how much is moving and how much
    // there is in total, which is the number that tells them whether to wait.
    expect(render(stages())).toContain("1/2 active");
  });

  it("counts the stages once nothing is in flight", () => {
    const settled = progress([
      { id: "inspect", label: "Inspecting workspace", status: "completed" },
      { id: "read", label: "Reading files", status: "completed" },
    ]);
    expect(render(settled)).toContain("2 steps");
  });

  it("renders nothing at all for an empty stage list", () => {
    // The blank-bubble defect. Asserted as an empty string, not as "no stages",
    // so a future wrapper around the panel cannot reintroduce the empty shell.
    expect(render({ kind: "tbai-progress", version: 1, stages: [] })).toBe("");
  });

  it("marks a completed stage as done rather than merely listing it", () => {
    const html = render(stages());
    expect(html).toContain("line-through");
  });

  it("does not claim a stage is done when it is not", () => {
    // One completed, one active: the active row must not be struck through.
    const html = render(stages());
    // The completed label is the only one wrapped in the strike-through class.
    const struck = html.match(/line-through[^>]*>([^<]*)</g) ?? [];
    expect(struck.length).toBe(1);
    expect(struck[0]).toContain("Inspecting workspace");
  });
});
