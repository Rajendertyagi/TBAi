import { describe, expect, it } from "bun:test";
import { normaliseMermaidSource } from "./mermaid-source";

/**
 * beautiful-mermaid validates the diagram header strictly, so a semicolon a
 * model emitted routinely turns a valid diagram into the fallback panel. These
 * cases mirror what was probed against the installed package, not what the
 * documentation implies.
 */
describe("mermaid source normalisation", () => {
  it("drops the semicolon from a graph header alone on its line", () => {
    expect(normaliseMermaidSource("graph TD;\n  A --> B")).toBe("graph TD\n  A --> B");
    expect(normaliseMermaidSource("graph LR;\n  A --> B")).toBe("graph LR\n  A --> B");
    expect(normaliseMermaidSource("flowchart TD;\n  A --> B")).toBe(
      "flowchart TD\n  A --> B",
    );
  });

  it("handles whitespace around the semicolon", () => {
    expect(normaliseMermaidSource("graph TD ;\n  A --> B")).toBe("graph TD\n  A --> B");
  });

  it("leaves an already-valid header untouched", () => {
    const valid = "graph TD\n  A --> B";
    expect(normaliseMermaidSource(valid)).toBe(valid);
  });

  it("never touches semicolons in the body", () => {
    // The renderer accepts these, so rewriting them would be wrong.
    const code = "graph TD\n  A --> B;\n  B --> C;";
    expect(normaliseMermaidSource(code)).toBe(code);
  });

  it("never touches other diagram types", () => {
    // sequenceDiagram; is accepted by the renderer; stripping it is not our job.
    const code = "sequenceDiagram;\n  A->>B: x";
    expect(normaliseMermaidSource(code)).toBe(code);
    const state = "stateDiagram-v2\n  [*] --> A;";
    expect(normaliseMermaidSource(state)).toBe(state);
  });

  it("copes with a leading blank line before the header", () => {
    expect(normaliseMermaidSource("\ngraph TD;\n  A --> B")).toBe(
      "\ngraph TD\n  A --> B",
    );
  });

  it("does not invent support the renderer does not have", () => {
    // The header must be alone on its line. This form is rejected whether or
    // not it has semicolons, so it is passed through unchanged rather than
    // silently reshaped into something that still fails.
    const inline = "graph TD; A-->B;";
    expect(normaliseMermaidSource(inline)).toBe(inline);
  });

  it("leaves non-mermaid and empty input alone", () => {
    expect(normaliseMermaidSource("")).toBe("");
    expect(normaliseMermaidSource("just some text; with a semicolon")).toBe(
      "just some text; with a semicolon",
    );
  });
});
