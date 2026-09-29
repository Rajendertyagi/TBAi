import { describe, expect, it } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { OpenCodeSubagentToolUI, OpenCodeTaskToolUI } from "./ui";
import { appToolkit } from "@/tools/toolkit";

/**
 * The delegated-agent card, under the name the running server actually sends.
 *
 * ## The defect this pins
 *
 * The registry carried this renderer under `task`, reading `subagent_type`. A real
 * turn on 2026-09-30 emitted a tool part named **`subagent`** with arguments
 * `{ agent, description, prompt }`. A name-keyed registry that lacks the name the
 * server used means the renderer never fires: the part falls through to
 * `ToolFallback` and the delegated call renders as a raw JSON dump. That was the
 * whole of the reported "a subagent call shows nothing of what it did".
 *
 * This needed a test because **the old code passed everything**. Typecheck, build
 * and the full suite were green while the tool was unregistered, since nothing in
 * the repo knew which name the server sends. So the primary guard is on the
 * *registry* — the name is the contract — and the rendering tests are there to
 * keep the card honest once it does fire.
 */

type AnyProps = Record<string, unknown>;

function render(UI: ToolCallMessagePartComponent, props: AnyProps): string {
  const Any = UI as unknown as (p: AnyProps) => ReactElement;
  return renderToStaticMarkup(createElement(Any, props));
}

/**
 * The prompt is shown in the GATE branch — an undecided approval — and the result
 * in the completed card. Both are the card's real behaviour, so each assertion
 * asks for the state it is actually about rather than bending the component.
 */
const gated = (args: AnyProps) => ({
  args,
  status: { type: "requires-action", reason: "interrupt" },
  approval: { id: "apv-1" },
  respondToApproval: () => undefined,
});

const completed = (args: AnyProps, result?: unknown) => ({
  args,
  status: { type: "complete" },
  ...(result === undefined ? {} : { result }),
});

const REGISTRY = appToolkit as unknown as Record<string, { type: string; render?: unknown }>;

describe("the delegated-agent tool is registered under the name the server sends", () => {
  it("registers `subagent`, the name verified against the live server", () => {
    // If this fails, the live tool is unregistered again and every delegated call
    // renders as a raw fallback dump. This one assertion is the regression.
    expect(REGISTRY.subagent).toBeDefined();
    expect(REGISTRY.subagent?.type).toBe("backend");
    expect(REGISTRY.subagent?.render).toBe(OpenCodeSubagentToolUI);
  });

  it("keeps `task` too, so a build that names it that way does not lose the card", () => {
    expect(REGISTRY.task).toBeDefined();
    expect(REGISTRY.task?.render).toBe(OpenCodeTaskToolUI);
  });
});

describe("the card names the subagent it delegated to", () => {
  it("reads the live argument name, `agent`", () => {
    const html = render(OpenCodeSubagentToolUI, gated({ agent: "explore", prompt: "go" }));
    expect(html).toContain("explore");
  });

  it("still reads `subagent_type`, so the older spelling renders just as well", () => {
    const html = render(OpenCodeTaskToolUI, gated({ subagent_type: "general", prompt: "go" }));
    expect(html).toContain("general");
  });

  it("says it delegated to a subagent, not that it used a raw tool", () => {
    const html = render(OpenCodeSubagentToolUI, completed({ agent: "explore", prompt: "go" }));
    // A fallback dump says "Used tool:" instead.
    expect(html).not.toContain("Used tool:");
    expect(html).toContain("subagent");
  });

  it("shows the prompt it was given, which is the thing being delegated", () => {
    const html = render(
      OpenCodeSubagentToolUI,
      gated({ agent: "explore", description: "d", prompt: "PROMPTMARKER" }),
    );
    expect(html).toContain("PROMPTMARKER");
  });

  it("does not invent a subagent name when the argument is missing", () => {
    // The tool label alone is honest; an empty title would read as a broken card.
    const html = render(OpenCodeSubagentToolUI, gated({ prompt: "PROMPTMARKER" }));
    expect(html).toContain("subagent");
    expect(html).toContain("PROMPTMARKER");
  });
});

describe("what the card deliberately does not claim", () => {
  it("shows no fabricated step list for work it cannot see", () => {
    // The subagent's internal steps are not in the session stream, and the server
    // 404s every child-session route, so a step list here would be invented. The
    // assertion is here to make that a decision someone has to undo, rather than
    // an omission someone has to notice.
    const html = render(
      OpenCodeSubagentToolUI,
      completed({ agent: "explore", prompt: "go" }, "The subagent's final answer."),
    );
    expect(html).toContain("final answer");
    expect(html).not.toMatch(/\d+ steps?/);
    expect(html).not.toMatch(/files? changed/);
  });
});
