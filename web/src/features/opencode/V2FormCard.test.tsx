import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FormInfo } from "@opencode/client";
import { V2FormCard } from "./V2FormCard";
import { V2OptionControl } from "./V2OptionControl";
import { capturedQuestionForm } from "@/testing/question-payloads";
import { toolsConfig } from "@/config/tools";
import { projectV2Form } from "./v2Forms";
import { stripComments } from "@/testing/source-scope";

/**
 * The question dock's control contracts, rendered for real.
 *
 * `web/` has no DOM runner (bun test, no jsdom / testing-library), so these pin
 * the structure `renderToStaticMarkup` can see: which control a field got, and
 * whether the options and the free-text escape hatch are BOTH present.
 *
 * ## The regression these exist for
 *
 * The option list was once gated on `field.options && !field.custom`, which is
 * false for every real `question` form — the live server sends `options` and
 * `custom: true` TOGETHER (`web/src/testing/question-payloads.ts`, captured
 * verbatim). The options therefore vanished and the reader got a bare text box.
 * The two facts must never be combined into one expression again, so the last
 * test in this file is a source guard rather than a render assertion.
 *
 * `V2OptionControl` is rendered directly where a single control is what is
 * under test, because `V2FormCard` shows one field per step and a multi-field
 * form would otherwise need its later steps reached to be seen.
 */

function renderCard(fields: FormInfo["fields"], queuedBehind = 0): string {
  const form: FormInfo = { id: "frm_test", sessionID: "ses_test", title: "Questions", fields };
  return renderToStaticMarkup(
    createElement(V2FormCard, {
      form,
      queuedBehind,
      onSubmit: () => Promise.resolve(),
      onCancel: () => Promise.resolve(),
    }),
  );
}

function renderControl(field: FormInfo["fields"][number], value?: string | readonly string[] | number | boolean) {
  // Through `projectV2Form`, because that is the only path production takes —
  // and it is what turns the wire's `undefined`/`[]` into the `null` the
  // option predicate documents. Rendering a raw wire field would test a shape
  // the app never hands the control.
  const form: FormInfo = { id: "frm_test", sessionID: "ses_test", title: "Questions", fields: [field] };
  const projected = projectV2Form(form);
  return renderToStaticMarkup(
    createElement(V2OptionControl, {
      field: projected.fields[0] as never,
      value: value as never,
      onChange: () => undefined,
    }),
  );
}

const SQLITE = { value: "SQLite", label: "SQLite", description: "file-based, zero-config" };
const POSTGRES = { value: "Postgres", label: "Postgres", description: "a full relational database server" };

describe("V2OptionControl — options and the escape hatch are independent", () => {
  it("draws the options as full-width rows when the field has them and no custom input", () => {
    const html = renderControl({ key: "db", type: "string", options: [SQLITE, POSTGRES] });
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="radio"');
    expect(html).toContain("SQLite");
    expect(html).toContain("Postgres");
    // No escape hatch on this field, so no Other row and no textarea.
    expect(html).not.toContain(toolsConfig.copy.form.other);
    expect(html).not.toContain("<textarea");
  });

  it("draws the options AND the Other row on the live shape: options with custom: true", () => {
    // THE LIVE CASE, from the real capture. The old `options && !custom` gate
    // hid the options for precisely this shape.
    const captured = capturedQuestionForm.fields[0] as FormInfo["fields"][number];
    const html = renderControl(captured);
    expect(html).toContain("SQLite");
    expect(html).toContain("Postgres");
    // Both descriptions, verbatim from the capture.
    expect(html).toContain("file-based, zero-config");
    expect(html).toContain("a full relational database server");
    // And the escape hatch is offered alongside, not instead of.
    expect(html).toContain(toolsConfig.copy.form.other);
  });

  it("omits the Other row when the field does not allow custom input", () => {
    const html = renderControl({ key: "db", type: "string", options: [SQLITE] });
    expect(html).toContain("SQLite");
    expect(html).not.toContain(toolsConfig.copy.form.other);
  });

  it("draws free text alone when the field has no options", () => {
    const html = renderControl({ key: "note", type: "string" });
    expect(html).not.toContain('role="radio"');
    expect(html).toContain("<textarea");
    expect(html).not.toContain(toolsConfig.copy.form.other);
  });

  it("draws free text alone for `options: []`, which is truthy but empty", () => {
    // In JS `[]` passes `if (field.options)`, which is how a blank box got on
    // screen for a field the server gave an empty list to.
    const html = renderControl({ key: "note", type: "string", options: [] });
    expect(html).not.toContain('role="radio"');
    expect(html).toContain("<textarea");
  });

  it("keeps the Other row closed until it is chosen, and marks its state", () => {
    // A closed Other row must not be a textarea on screen, and must announce
    // that it opens something.
    const html = renderControl(capturedQuestionForm.fields[0] as FormInfo["fields"][number]);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("<textarea");
  });

  it("marks the chosen option with aria-checked and leaves the rest unchecked", () => {
    const html = renderControl({ key: "db", type: "string", options: [SQLITE, POSTGRES] }, "Postgres");
    expect(html).toMatch(/aria-checked="true"[^]*?Postgres/);
    // Non-vacuity: the other option must NOT also read as chosen.
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
  });

  it("shows no option as chosen while the reader is typing their own answer", () => {
    // Single-select custom text is a MODE: an option and a typed answer cannot
    // both be the value, so the rows must all read unchecked.
    const html = renderControl(capturedQuestionForm.fields[0] as FormInfo["fields"][number], "DuckDB");
    expect(html).toContain("DuckDB");
    expect(html).not.toContain('aria-checked="true"');
  });
});

describe("V2OptionControl — multiselect is additive where single-select replaces", () => {
  it("uses checkboxes for multiselect and radios for single-select", () => {
    const multi = renderControl({ key: "t", type: "multiselect", options: [SQLITE, POSTGRES] });
    expect(multi).toContain('role="checkbox"');
    expect(multi).toContain('role="group"');
    expect(multi).not.toContain('role="radio"');
    const single = renderControl({ key: "d", type: "string", options: [SQLITE] });
    expect(single).toContain('role="radio"');
  });

  it("gives a multiselect that allows custom input an adder, checked boxes included", () => {
    // A multiselect answer is an array, so a typed entry is APPENDED — the
    // adder is not a mode that hides the checkboxes.
    const html = renderControl({ key: "t", type: "multiselect", custom: true, options: [SQLITE] });
    expect(html).toContain('role="checkbox"');
    expect(html).toContain("SQLite");
    expect(html).toContain(toolsConfig.copy.form.customEntryLabel);
  });

  it("gives a multiselect no escape hatch when the field does not allow custom input", () => {
    const html = renderControl({ key: "t", type: "multiselect", options: [SQLITE] });
    expect(html).toContain('role="checkbox"');
    expect(html).not.toContain(toolsConfig.copy.form.customEntryLabel);
  });
});

describe("V2OptionControl — the field types with no options", () => {
  it("gives a boolean two option rows rather than a dropdown with an unset state", () => {
    const html = renderControl({ key: "ok", type: "boolean" });
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain(toolsConfig.copy.form.trueLabel);
    expect(html).toContain(toolsConfig.copy.form.falseLabel);
    expect(html).not.toContain("<select");
  });

  it("marks a chosen boolean, and nothing when it is unanswered", () => {
    expect(renderControl({ key: "ok", type: "boolean" }, true)).toMatch(/aria-checked="true"[^]*?True/);
    // Unanswered must read as neither, so "not answered" is expressible at all.
    expect(renderControl({ key: "ok", type: "boolean" })).not.toContain('aria-checked="true"');
  });

  it("gives numeric fields a number input and passes finite bounds through", () => {
    const html = renderControl({ key: "n", type: "integer", minimum: 1, maximum: 9 });
    expect(html).toContain('type="number"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="9"');
    // React emits the prop name verbatim here; the DOM lowercases it.
    expect(html).toContain('inputMode="numeric"');
  });

  it("drops a non-finite bound, which the wire may carry as a JSON stand-in", () => {
    // The schema types bounds as `number | string | null` because the server may
    // send 'Infinity' | '-Infinity' | 'NaN'. Passing those to the DOM would put
    // a literal string in `min`.
    const html = renderControl({ key: "n", type: "number", minimum: "Infinity" as never, maximum: "NaN" as never });
    expect(html).not.toContain("Infinity");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("min=");
  });

  it("tells the reader an external field must be completed in OpenCode", () => {
    const html = renderControl({ key: "e", type: "external", url: "https://example.com" });
    expect(html).toContain(toolsConfig.copy.form.externalField);
  });
});

describe("V2FormCard — the dock shell", () => {
  it("shows one question at a time, with its progress", () => {
    const html = renderCard([
      { key: "a", title: "First", type: "string" },
      { key: "b", title: "Second", type: "string" },
      { key: "c", title: "Third", type: "string" },
    ]);
    expect(html).toContain(toolsConfig.copy.form.progress(1, 3));
    // The stepper's whole reason: the later questions are NOT on screen yet.
    expect(html).toContain("First");
    expect(html).not.toContain("Second");
    expect(html).not.toContain("Third");
  });

  it("offers a clickable step per question and marks the current one", () => {
    const html = renderCard([
      { key: "a", title: "First", type: "string" },
      { key: "b", title: "Second", type: "string" },
    ]);
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('aria-selected="true"');
  });

  it("shows only the first form and counts the ones behind it", () => {
    // Several pending forms must not stack into a column of docks; that is the
    // tall-block problem moved one level up rather than solved.
    const html = renderCard([{ key: "a", title: "First", type: "string" }], 2);
    expect(html).toContain(toolsConfig.copy.form.queued(2));
  });

  it("counts nothing when this is the only form waiting", () => {
    const html = renderCard([{ key: "a", title: "First", type: "string" }], 0);
    expect(html).not.toContain("more waiting");
  });

  it("collapses to a strip that hides the question and announces its state", () => {
    const html = renderCard([{ key: "a", title: "First", type: "string" }]);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(toolsConfig.copy.form.collapse);
  });

  it("keeps the submit and cancel actions, and only Back once past the first", () => {
    const one = renderCard([{ key: "a", type: "string" }]);
    expect(one).toContain(toolsConfig.copy.form.submit);
    expect(one).toContain(toolsConfig.copy.form.cancel);
    expect(one).not.toContain(toolsConfig.copy.form.back);
  });

  it("offers a way forward on every step but the last, and never both", () => {
    // A reader using the mouse must not be stranded on step 1 with no forward
    // action. Enter also advances, but Enter is not available to everyone, and
    // the two are never offered for the same step.
    const first = renderCard([
      { key: "a", title: "First", type: "string" },
      { key: "b", title: "Second", type: "string" },
    ]);
    expect(first).toContain(toolsConfig.copy.form.next);
    expect(first).not.toContain(toolsConfig.copy.form.submit);
    // And the last step is where Submit lives.
    const only = renderCard([{ key: "a", title: "First", type: "string" }]);
    expect(only).toContain(toolsConfig.copy.form.submit);
    expect(only).not.toContain(toolsConfig.copy.form.next);
  });

  it("says so when every field is hidden, and offers nothing to submit", () => {
    // A form whose only field is hidden has no question to ask. Rendering
    // Submit here would let the reader send an empty answer to the server,
    // which the validator would refuse anyway — with a message about a
    // question that is not on screen.
    const html = renderCard([{ key: "secret", title: "Hidden", type: "string", hidden: true }]);
    expect(html).toContain(toolsConfig.copy.form.nothingToAsk);
    expect(html).not.toContain(toolsConfig.copy.form.submit);
    expect(html).not.toContain(toolsConfig.copy.form.next);
  });

  it("shows the unsupported reason and still offers only Cancel, never Submit", () => {
    // `projectV2Form` refuses these forms outright — a duplicate key, a field
    // count over the cap, an external field. Submitting one is guaranteed to
    // be rejected, so offering the button is offering a dead end.
    const html = renderCard([{ key: "e", type: "external", url: "https://example.com" }]);
    expect(html).toContain(toolsConfig.copy.form.externalField);
    expect(html).not.toContain(toolsConfig.copy.form.submit);
    expect(html).toContain(toolsConfig.copy.form.cancel);
  });

  it("ties the step dots to the body they switch", () => {
    // `aria-controls` and the panel's `id` are one relationship written twice.
    // A pair that can drift is an accessibility bug that no render assertion
    // would otherwise catch.
    const html = renderCard([
      { key: "a", title: "First", type: "string" },
      { key: "b", title: "Second", type: "string" },
    ]);
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBeDefined();
    expect(html).toContain(`id="${controls}"`);
    expect(html).toContain('role="tabpanel"');
  });

  it("counts one question of one, not one of zero, when a single field is asked", () => {
    // The progress denominator is the VISIBLE field count. It must never render
    // "1 of 0" for a form that plainly has one question, which is what a
    // naive `visible.length - 1` would produce on the clamped step index.
    const html = renderCard([{ key: "a", type: "string" }]);
    expect(html).toContain(toolsConfig.copy.form.progress(1, 1));
    expect(html).not.toContain("0)");
  });

  it("uses the shared card surface rather than a restated one", () => {
    // `CARD_SURFACE` is the single class list every reader-facing card shares.
    // Restating it is how two cards drift apart visually.
    const html = renderCard([{ key: "a", type: "string" }]);
    expect(html).toContain("bg-card-soft");
    expect(html).toContain("ring-card-outline");
  });

  it("marks a required field and drops a hidden one", () => {
    const html = renderCard([
      { key: "db", title: "Shown", type: "string", required: true },
      { key: "secret", title: "Hidden", type: "string", hidden: true },
    ]);
    expect(html).toContain(toolsConfig.copy.form.requiredMarker);
    expect(html).toContain("Shown");
    expect(html).not.toContain("Hidden");
  });

  it("renders no `undefined` anywhere, for every field type at once", () => {
    // The cheapest guard that the option accessors return real values on every
    // branch, and that no field type silently renders nothing.
    const html = renderCard([
      { key: "s", type: "string", options: [SQLITE], custom: true },
      { key: "m", type: "multiselect", options: [POSTGRES], custom: true },
      { key: "n", type: "number" },
      { key: "b", type: "boolean" },
      { key: "e", type: "external", url: "https://example.com" },
    ]);
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("null");
  });
});

describe("the options/Other gate — the guard that matters", () => {
  /** The question path's source, comments stripped so prose cannot trip a guard. */
  async function sourceOf(file: string): Promise<string> {
    return stripComments(await Bun.file(new URL(file, import.meta.url)).text());
  }

  const FORBIDDEN = [
    /options\s*&&\s*!\s*custom/,
    /options\s*&&\s*!?\s*\w+\.custom/,
    /!\s*\w*\.?custom\s*&&\s*options/,
    /!\s*\w+\.custom\s*&&\s*options/,
  ];

  it("never combines `options` and `custom` into one expression again", async () => {
    // Render tests prove today's behaviour. This proves the SHAPE cannot come
    // back, because the next person to write `options && !custom` fails here
    // rather than shipping the dead end for a third time.
    for (const file of ["./V2OptionControl.tsx", "./V2FormCard.tsx", "./v2Forms.ts"]) {
      const source = await sourceOf(file);
      for (const pattern of FORBIDDEN) {
        expect(source).not.toMatch(pattern);
      }
    }
  });

  it("reads options and custom only through their own predicates", async () => {
    // The decision is delegated, not restated: `v2FormFieldOptions` answers
    // "does this field offer options?" and `v2FormFieldAllowsCustom` answers
    // "may it take a value of its own?". Two questions, two readers — which is
    // what makes the combined gate impossible to write by accident.
    const source = await sourceOf("./V2OptionControl.tsx");
    expect(source).not.toMatch(/field\.options\b/);
    expect(source).not.toMatch(/field\.custom\b/);
  });
});

