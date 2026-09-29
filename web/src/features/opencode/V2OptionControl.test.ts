import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FormInfo } from "@opencode/client";
import { V2OptionControl, shouldClearOnOpeningCustom } from "./V2OptionControl";
import { capturedQuestionForm } from "@/testing/question-payloads";
import { v2FormFieldOptions, type V2FormFieldView, type V2FormOptionView } from "./v2Forms";
import { toolsConfig } from "@/config/tools";

/**
 * The free-text escape hatch on a question with options.
 *
 * Two defects, both reported from using the real dock:
 *
 *  1. Pick an option, then decide to type your own answer — the option was still
 *     sitting in the box as though it were what you typed.
 *  2. With the hatch open, the "Other." row and the text box read as ONE merged
 *     control rather than as a row and the answer to that row.
 *
 * The first is a decision, so it is extracted and tested purely. The second is
 * rendered, so it is asserted on the markup.
 */

/** A single-select field offering options AND a free-text escape hatch. */
function fieldWithOptions(): V2FormFieldView {
  const form = capturedQuestionForm as unknown as FormInfo;
  const field = form.fields.find((candidate) =>
    (candidate as { options?: unknown[] }).options !== undefined,
  );
  if (!field) throw new Error("fixture has no field with options");
  return field as unknown as V2FormFieldView;
}

const OPTIONS: readonly V2FormOptionView[] = [
  { value: "typescript", label: "TypeScript", description: null },
  { value: "python", label: "Python", description: null },
];

describe("bug 1 · the chosen option must not become your custom answer", () => {
  it("clears a listed option when the hatch is opened", () => {
    // The reported case: "TypeScript" is the current answer and the reader then
    // chooses Other. The box must start empty, not pre-filled with TypeScript.
    expect(shouldClearOnOpeningCustom("typescript", OPTIONS)).toBe(true);
  });

  it("keeps an answer that names no option, because that is the reader's own text", () => {
    // A re-opened dock, or a second form carrying the same default, restores
    // free text. Clearing it would destroy an answer nobody retyped.
    expect(shouldClearOnOpeningCustom("Kotlin", OPTIONS)).toBe(false);
  });

  it("has nothing to clear when nothing is answered yet", () => {
    expect(shouldClearOnOpeningCustom("", OPTIONS)).toBe(false);
  });

  it("has nothing to clear on a field with no options at all", () => {
    // Free text IS the control there, so there is no hatch to open.
    expect(shouldClearOnOpeningCustom("anything", null)).toBe(false);
  });

  it("is case- and whitespace-exact, because option values are not", () => {
    // Matching loosely would clear a legitimate custom answer that merely
    // resembles an option.
    expect(shouldClearOnOpeningCustom("TypeScript", OPTIONS)).toBe(false);
    expect(shouldClearOnOpeningCustom("typescript ", OPTIONS)).toBe(false);
  });
});

describe("bug 2 · the row and the box must not read as one control", () => {
  /** Renders the control with the hatch already open, via an off-list answer. */
  function renderWithHatchOpen(): string {
    return renderToStaticMarkup(
      createElement(V2OptionControl, {
        field: fieldWithOptions(),
        value: "an answer the reader typed",
        onChange: () => undefined,
      }),
    );
  }

  it("keeps the Other row AND the box, so custom mode stays visible", () => {
    const html = renderWithHatchOpen();
    expect(html).toContain(toolsConfig.copy.form.other);
    expect(html).toContain("<textarea");
  });

  it("indents the box, so its left edge does not line up with the row's", () => {
    // This is the actual fix. As full-width siblings 4px apart with a filled row
    // above a bordered box, every edge lined up and the eye merged them.
    const html = renderWithHatchOpen();
    // The indent wrapper sits between the row and the textarea.
    expect(html).toMatch(/pl-8[^"]*"[^>]*>\s*<textarea/);
  });

  it("leaves a gap between the row and the box, so the two never touch", () => {
    const html = renderWithHatchOpen();
    expect(html).toMatch(/pt-2 pl-8/);
  });

  it("does not indent anything when the hatch is closed", () => {
    // A closed hatch has no box, so the indent must not appear at all. The value
    // has to be one of the field's REAL options: a value naming no option is
    // the reader's own text, which correctly OPENS the hatch and preserves it.
    const listed = v2FormFieldOptions(fieldWithOptions())?.[0]?.value ?? "";
    expect(listed.length > 0).toBe(true);
    const html = renderToStaticMarkup(
      createElement(V2OptionControl, {
        field: fieldWithOptions(),
        value: listed,
        onChange: () => undefined,
      }),
    );
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("pl-8");
  });

  it("keeps an off-list answer in the box, because that is a restored answer", () => {
    // The counterpart to bug 1's fix: clearing is for LISTED options only, and
    // this is the case that must never be cleared.
    const html = renderWithHatchOpen();
    expect(html).toContain("an answer the reader typed");
  });
});
