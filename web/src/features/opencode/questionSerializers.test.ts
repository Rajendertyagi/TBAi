import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FormInfo } from "@opencode/client";
import { V2FormCard } from "./V2FormCard";
import { projectV2Form, type V2FormView } from "./v2Forms";
import { questionAsJson, questionAsMarkdown } from "./questionSerializers";
import { capturedQuestionForm, CAPTURED_QUESTION_PART_ID, CAPTURED_QUESTION_SESSION_ID } from "@/testing/question-payloads";
import { toolsConfig } from "@/config/tools";

/**
 * Taking a pending question away from the dock.
 *
 * Two things are proved here, and they are proved differently on purpose.
 *
 * 1. WHAT A COPY CONTAINS — the real captured form goes in, because a form
 *    invented to match a guess cannot catch the guess being wrong. The capture
 *    (`@/testing/question-payloads`) is the one shape that broke this card
 *    before: options and `custom` on the same field.
 *
 * 2. WHAT A COPY MUST NOT CONTAIN — the routing ids. The capture carries all of
 *    them (`id`, `sessionID`, and a `metadata.tool.id`/`messageID` that links
 *    the form back to the tool call), which is exactly the payload a copy must
 *    leave behind. This is asserted twice, because the two assertions fail for
 *    different reasons: by STRING, which catches an id printed as a value, and
 *    by walking the parsed JSON for a forbidden KEY at any depth, which catches
 *    an id that rode along as a property. A comment could not catch either.
 */

/**
 * The captured form as the wire type the production path receives, ids and all.
 *
 * Rebuilt rather than asserted: the fixture is a plain object, and its single
 * field is cast exactly as `V2FormCard.test.tsx` casts the same field, so the
 * ids under test are the CAPTURED ones and not values invented here.
 */
const CAPTURED_FORM: FormInfo = {
  ...capturedQuestionForm,
  fields: [capturedQuestionForm.fields[0] as FormInfo["fields"][number]],
};

/** The captured form, as the projector the production path uses sees it. */
const CAPTURED_VIEW: V2FormView = projectV2Form(CAPTURED_FORM);

/** Ids the capture carries, which a portable copy must not. */
const ROUTING_IDS = [
  capturedQuestionForm.id,
  CAPTURED_QUESTION_SESSION_ID,
  CAPTURED_QUESTION_PART_ID,
  "msg_0e493baaf001A64CwYFNq1RGlF",
] as const;

/** Keys that address one question in one session, at any depth of a copy. */
const FORBIDDEN_KEYS = ["id", "sessionID", "metadata"] as const;

/** Every key in a parsed copy, at every depth, so a nested id cannot hide. */
function keysIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) keysIn(item, found);
    return found;
  }
  if (typeof value !== "object" || value === null) return found;
  for (const [key, nested] of Object.entries(value)) {
    found.push(key);
    keysIn(nested, found);
  }
  return found;
}

function viewOf(fields: FormInfo["fields"]): V2FormView {
  return projectV2Form({ id: "frm_route_me_not", sessionID: "ses_route_me_not", title: "Preferences", fields });
}

describe("a copied question carries the question and nothing that routes it", () => {
  it("names every visible field and every option, in Markdown", () => {
    const markdown = questionAsMarkdown(CAPTURED_VIEW);
    // The question set's own title, then the field's, then both labels — all
    // verbatim from the capture.
    expect(markdown).toContain("# Questions");
    expect(markdown).toContain("## Database choice");
    expect(markdown).toContain("Which database should you use?");
    expect(markdown).toContain("- SQLite");
    expect(markdown).toContain("- Postgres");
    // The detail under an option travels too, so the choice can be made by
    // reading rather than by recognising a word.
    expect(markdown).toContain("file-based, zero-config, ideal for a small app with minimal ops overhead");
    // And the escape hatch is offered, because the capture's field has options
    // AND `custom: true` — the very combination this app got wrong before.
    expect(markdown).toContain(toolsConfig.copy.form.customEntryLabel);
  });

  it("says what a question with no options expects, and what a boolean offers", () => {
    const view = viewOf([
      { key: "note", title: "Notes", type: "string", required: true },
      { key: "count", type: "integer" },
      { key: "ratio", type: "number" },
      // `options: []` is the no-options multiselect: the client types make the
      // list required, and the projector reads an empty one as no list at all.
      { key: "tags", type: "multiselect", options: [] },
      { key: "ok", type: "boolean" },
    ]);
    const markdown = questionAsMarkdown(view);
    // A required question says so in the copy, from the one place that knows it.
    expect(markdown).toContain(`## Notes${toolsConfig.copy.form.copyRequired}`);
    expect(markdown).toContain(toolsConfig.copy.form.copyAnswerText);
    expect(markdown).toContain(toolsConfig.copy.form.copyAnswerInteger);
    expect(markdown).toContain(toolsConfig.copy.form.copyAnswerNumber);
    expect(markdown).toContain(toolsConfig.copy.form.copyAnswerList);
    // A boolean has no option list on the wire, but a reader still has to be
    // told its two answers.
    expect(markdown).toContain(`- ${toolsConfig.copy.form.trueLabel}`);
    expect(markdown).toContain(`- ${toolsConfig.copy.form.falseLabel}`);
  });

  it("names a field that has no title by its key, rather than dropping it", () => {
    const markdown = questionAsMarkdown(viewOf([{ key: "untitled_field", type: "string" }]));
    expect(markdown).toContain("## untitled_field");
  });

  it("drops the form's own id from the Markdown", () => {
    // Non-vacuous: the view handed in really does carry `id`, and the Markdown
    // really does not contain it.
    expect(CAPTURED_VIEW.id).toBe(capturedQuestionForm.id);
    const markdown = questionAsMarkdown(CAPTURED_VIEW);
    for (const id of ROUTING_IDS) expect(markdown).not.toContain(id);
  });

  it("round-trips the JSON and describes the question, not the envelope", () => {
    const parsed: unknown = JSON.parse(questionAsJson(CAPTURED_VIEW));
    expect(Array.isArray(parsed)).toBe(true);
    const [field] = parsed as [
      { key: string; title: string; description: string; required: boolean; type: string; freeText: boolean; options: { value: string; label: string }[] },
    ];
    expect(field.key).toBe("q0");
    expect(field.title).toBe("Database choice");
    expect(field.description).toBe("Which database should you use?");
    // The wire's own type vocabulary, so a script needs no translation table.
    expect(field.type).toBe("string");
    expect(field.required).toBe(false);
    expect(field.freeText).toBe(true);
    expect(field.options.map((option) => option.value)).toEqual(["SQLite", "Postgres"]);
    expect(field.options.map((option) => option.label)).toEqual(["SQLite", "Postgres"]);
  });

  it("wraps the JSON in nothing: an array of fields, with no title or ids beside them", () => {
    // "The question content only, not the whole form envelope": the title is
    // document furniture for Markdown and is deliberately absent here, so a
    // script can index the questions without unwrapping anything.
    const parsed = JSON.parse(questionAsJson(CAPTURED_VIEW)) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect(Object.keys(parsed[0])).toEqual(["key", "title", "description", "required", "type", "options", "freeText"]);
  });

  it("writes an option's own shape and nothing else, so no id can hide inside one", () => {
    const parsed = JSON.parse(questionAsJson(CAPTURED_VIEW)) as { options: Record<string, unknown>[] }[];
    expect(Object.keys(parsed[0].options[0])).toEqual(["value", "label", "description"]);
  });

  it("finds no routing key at ANY depth of the JSON", () => {
    // The recursive walk is what a string search cannot do: a nested property
    // named `id` carries no id in the text and would still be a copy that
    // cannot be pasted anywhere. It would survive a `{ ...field } spread, which
    // is why neither writer is allowed one.
    const keys = keysIn(JSON.parse(questionAsJson(CAPTURED_VIEW)));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(FORBIDDEN_KEYS as readonly string[]).not.toContain(key);
  });

  it("finds no routing id in the JSON text, at any nesting", () => {
    const json = questionAsJson(CAPTURED_VIEW);
    for (const id of ROUTING_IDS) expect(json).not.toContain(id);
    // A boolean keeps `options: null` — its answer is a JSON boolean, not one
    // of two strings, so no two-string fiction rides along.
    const [booleanField] = JSON.parse(questionAsJson(viewOf([{ key: "ok", type: "boolean" }]))) as { options: unknown }[];
    expect(booleanField.options).toBeNull();
  });

  it("copies an empty question as something readable rather than nothing", () => {
    // A form whose fields are all hidden still offers both copy actions, so both
    // writers must have an answer for "no questions" — an empty string on a
    // clipboard is indistinguishable from a copy that did nothing.
    const view: V2FormView = { ...CAPTURED_VIEW, fields: [] };
    expect(questionAsMarkdown(view)).toContain(toolsConfig.copy.form.copyEmpty);
    expect(JSON.parse(questionAsJson(view))).toEqual([]);
  });

  it("survives a field that is only a title, with nothing else to say", () => {
    const markdown = questionAsMarkdown(viewOf([{ key: "bare", type: "string" }]));
    expect(markdown).toContain("## bare");
    expect(markdown).toContain(toolsConfig.copy.form.copyAnswerText);
  });
});

describe("the dock's header — the two copy actions", () => {
  function renderHeader(fields: FormInfo["fields"]): string {
    return renderToStaticMarkup(
      createElement(V2FormCard, {
        form: { id: "frm_test", sessionID: "ses_test", title: "Questions", fields },
        onSubmit: () => Promise.resolve(),
        onCancel: () => Promise.resolve(),
      }),
    );
  }

  it("offers both formats as buttons that can be named out loud", () => {
    const html = renderHeader([{ key: "a", title: "First", type: "string" }]);
    // An icon-only button is announced by its aria-label, so the two actions
    // must each carry one — and they must be the copy actions, not two more
    // glyphs a reader has to guess at.
    expect(html).toContain(`aria-label="${toolsConfig.copy.form.copyMarkdown}"`);
    expect(html).toContain(`aria-label="${toolsConfig.copy.form.copyJson}"`);
    expect(html).toContain(`aria-label="${toolsConfig.copy.form.collapse}"`);
  });

  it("keeps the collapse control and the copy actions in one non-shrinking group", () => {
    // A narrow dock must shorten the title, not wrap the actions onto a second
    // line: the header row holds one `shrink-0` group, and the title is the only
    // part that gives ground.
    const html = renderHeader([{ key: "a", title: "First", type: "string" }]);
    expect(html).toMatch(/class="min-w-0 flex-1"/);
    expect(html).toMatch(/class="flex shrink-0 items-center gap-1"/);
    // Three icon buttons, and the title still truncates rather than wrapping.
    expect(html.match(/data-size="icon-sm"/g)).toHaveLength(3);
    expect(html).toContain("truncate");
  });

  it("keeps the icons themselves out of the accessible name", () => {
    const html = renderHeader([{ key: "a", type: "string" }]);
    expect(html).toContain('aria-hidden="true"');
  });

  it("has every string it needs in toolsConfig, and its duration in the timing bucket", () => {
    // The words are the single source of truth; the card holds none of them. The
    // dwell time is a duration, so it lives with the durations rather than among
    // the strings — a number in a copy bucket reads as an accident and the next
    // person follows the precedent instead of the rule.
    const form = toolsConfig.copy.form;
    for (const key of [
      "copyMarkdown", "copyJson", "copiedMarkdown", "copiedJson", "copyRefused",
      "copyUnavailable", "copyEmpty", "copyRequired", "copyAnswerText",
      "copyAnswerNumber", "copyAnswerInteger", "copyAnswerList",
    ] as const) {
      expect(typeof form[key]).toBe("string");
      expect(form[key].length).toBeGreaterThan(0);
    }
    expect(toolsConfig.timing.copyConfirmMs).toBeGreaterThan(0);
    // Non-vacuity on the placement: the duration must NOT still be in the copy
    // bucket, or the move was cosmetic.
    expect(Object.keys(form)).not.toContain("copyConfirmMs");
  });
});
