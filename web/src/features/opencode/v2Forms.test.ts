import { describe, expect, it } from "bun:test";
import type { FormInfo } from "@opencode/client";
import {
  isV2FormFieldVisible,
  projectV2Form,
  v2FormFieldAllowsCustom,
  v2FormFieldOptions,
  validateV2FormAnswer,
  type V2FormAnswer,
} from "./v2Forms";

const form: FormInfo = {
  id: "form-1",
  sessionID: "session-1",
  title: "Preferences",
  fields: [
    { key: "name", type: "string", required: true },
    { key: "age", type: "integer", minimum: 1, maximum: 10 },
    { key: "subscribe", type: "boolean", default: false },
  ],
};

function formOf(fields: FormInfo["fields"]): ReturnType<typeof projectV2Form> {
  return projectV2Form({ id: "f", sessionID: "s", title: "T", fields });
}

/** The field-error map of a rejected answer, or `null` when it was accepted. */
function fieldErrors(view: ReturnType<typeof projectV2Form>, answer: V2FormAnswer): Record<string, string> | null {
  const result = validateV2FormAnswer(view, answer);
  return result.ok ? null : result.fieldErrors;
}

describe("native V2 form contract", () => {
  it("projects typed fields without coercing option values", () => {
    const view = projectV2Form(form);
    expect(view.unsupportedReason).toBeNull();
    expect(view.fields.map((field) => field.type)).toEqual(["string", "integer", "boolean"]);
  });

  it("validates required and bounded values", () => {
    const view = projectV2Form(form);
    const invalid = validateV2FormAnswer(view, { age: 12 });
    expect(invalid.ok).toBe(false);
    const valid = validateV2FormAnswer(view, { name: "Ada", age: 8, subscribe: false });
    expect(valid).toEqual({ ok: true, answer: { name: "Ada", age: 8, subscribe: false } });
  });
});

/* -------------------------------------------------------------------------
 * THE OPTION CONTRACT, verified against the running server.
 *
 * `Form.StringField` has BOTH `options` and `custom` as optional properties,
 * and `Form.MultiselectField` settles what that means: there `options` is
 * REQUIRED and `custom` still exists. `custom` is therefore the free-text
 * escape hatch ADDED to an option list, not a switch that replaces it.
 *
 * Asked of the live server (v2.0.15) directly, on throwaway forms:
 *   options + custom:true   -> "anything-goes"   ACCEPTED
 *   options, no custom      -> "nope"            REJECTED ("Invalid option
 *                                                    for form field: b")
 *   multiselect + custom    -> ["x","free1"]     ACCEPTED
 *   multiselect, no custom  -> "x" (a scalar)    REJECTED ("Expected string
 *                                                    array for form field: e")
 * ---------------------------------------------------------------------- */

describe("V2 string options — the option list constrains, custom adds to it", () => {
  const choice = formOf([
    { key: "db", type: "string", options: [{ value: "SQLite", label: "SQLite" }, { value: "Postgres", label: "Postgres" }] },
  ]);

  it("accepts a listed option value", () => {
    expect(validateV2FormAnswer(choice, { db: "Postgres" })).toEqual({ ok: true, answer: { db: "Postgres" } });
  });

  it("rejects an unlisted value when the field does not allow custom input", () => {
    // The hole this fixes: `options && !custom` was read as "custom REPLACES
    // the options", so this case validated nothing at all.
    expect(fieldErrors(choice, { db: "mysql" })).toEqual({ db: "Choose one of the available options" });
  });

  it("accepts an unlisted value when the field allows custom input", () => {
    const withCustom = formOf([
      {
        key: "db",
        type: "string",
        custom: true,
        options: [{ value: "SQLite", label: "SQLite" }, { value: "Postgres", label: "Postgres" }],
      },
    ]);
    expect(validateV2FormAnswer(withCustom, { db: "mysql" })).toEqual({ ok: true, answer: { db: "mysql" } });
  });

  it("still accepts a listed option when custom input is also allowed", () => {
    const withCustom = formOf([
      { key: "db", type: "string", custom: true, options: [{ value: "SQLite", label: "SQLite" }] },
    ]);
    expect(validateV2FormAnswer(withCustom, { db: "SQLite" })).toEqual({ ok: true, answer: { db: "SQLite" } });
  });

  it("keeps the string constraints that are not about options", () => {
    // Each bound on its own field, so one assertion cannot be masked by
    // another constraint overwriting the same key's error.
    const view = formOf([
      { key: "short", type: "string", minLength: 4 },
      { key: "long", type: "string", maxLength: 5 },
      { key: "mail", type: "string", format: "email" },
      { key: "uri", type: "string", format: "uri" },
      { key: "shaped", type: "string", pattern: "^[A-Z]+$" },
    ]);
    expect(fieldErrors(view, { short: "ab", long: "a@b.co", mail: "nope", uri: "nope", shaped: "lower" })).toEqual({
      short: "Use at least 4 characters",
      long: "Use at most 5 characters",
      mail: "Enter a valid email",
      uri: "Enter a valid URI",
      shaped: "Value does not match the required format",
    });
    expect(validateV2FormAnswer(view, { short: "abcd", long: "abcde", mail: "a@b.co", uri: "https://x.dev", shaped: "AB" })).toEqual({
      ok: true,
      answer: { short: "abcd", long: "abcde", mail: "a@b.co", uri: "https://x.dev", shaped: "AB" },
    });
  });
});

describe("V2 string options — an empty list is not a list", () => {
  it("reports no options for `options: []` (truthy in JS, empty in fact)", () => {
    // `[]` passes an `if (field.options)` test, which is how an empty picker
    // and a "Choose one of the available options" error for an unanswerable
    // field got in. The server rejects every value on such a field too, so
    // there is nothing to choose from and nothing to enforce.
    const view = formOf([{ key: "note", type: "string", options: [] }]);
    expect(v2FormFieldOptions(view.fields[0])).toBeNull();
    expect(validateV2FormAnswer(view, { note: "anything" })).toEqual({ ok: true, answer: { note: "anything" } });
  });

  it("reports no options for an omitted `options`", () => {
    const view = formOf([{ key: "note", type: "string" }]);
    expect(v2FormFieldOptions(view.fields[0])).toBeNull();
    expect(validateV2FormAnswer(view, { note: "anything" })).toEqual({ ok: true, answer: { note: "anything" } });
  });

  it("reports no options for a field type that has none", () => {
    const view = formOf([{ key: "n", type: "number" }, { key: "b", type: "boolean" }]);
    for (const field of view.fields) {
      expect(v2FormFieldOptions(field)).toBeNull();
      expect(v2FormFieldAllowsCustom(field)).toBe(false);
    }
  });
});

describe("V2 multiselect — the answer is always a string array", () => {
  const tags = formOf([{ key: "tags", type: "multiselect", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }]);

  it("accepts an array of listed options", () => {
    expect(validateV2FormAnswer(tags, { tags: ["a", "b"] })).toEqual({ ok: true, answer: { tags: ["a", "b"] } });
  });

  it("rejects a bare string, which `Form.Value` allows but a multiselect does not", () => {
    // `Form.Value` is a union that includes a string, so a scalar is a
    // well-formed VALUE and the wrong shape for this field type. The server
    // answers "Expected string array for form field: e".
    expect(fieldErrors(tags, { tags: "a" })).toEqual({ tags: "Choose valid options" });
  });

  it("rejects a non-string entry inside the array", () => {
    // The answer arrives off the wire, so the declared type is not a guarantee.
    // `Form.Value` DOES allow a bare number/boolean, so `["a", 1]` is a
    // plausible payload that the contents check — not the union — has to catch.
    const loose = { tags: ["a", 1] } as unknown as V2FormAnswer;
    expect(fieldErrors(tags, loose)).toEqual({ tags: "Choose valid options" });
    expect(fieldErrors(tags, { tags: [true] } as unknown as V2FormAnswer)).toEqual({ tags: "Choose valid options" });
  });

  it("rejects an unlisted entry when the field does not allow custom input", () => {
    expect(fieldErrors(tags, { tags: ["a", "z"] })).toEqual({ tags: "Choose only available options" });
  });

  it("accepts a mixed listed-and-custom array when the field allows custom input", () => {
    const withCustom = formOf([{ key: "tags", type: "multiselect", custom: true, options: [{ value: "a", label: "A" }] }]);
    expect(validateV2FormAnswer(withCustom, { tags: ["a", "free1"] })).toEqual({ ok: true, answer: { tags: ["a", "free1"] } });
  });

  it("keeps the min/max item bounds", () => {
    const bounded = formOf([{ key: "tags", type: "multiselect", minItems: 2, maxItems: 3, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }]);
    expect(fieldErrors(bounded, { tags: ["a"] })).toEqual({ tags: "Choose at least 2 options" });
    expect(fieldErrors(bounded, { tags: ["a", "b", "a", "b"] })).toEqual({ tags: "Choose at most 3 options" });
  });
});

describe("V2 required and `when` visibility", () => {
  it("requires a value for a required field, treating [] and \"\" as missing", () => {
    const view = formOf([
      { key: "name", type: "string", required: true },
      { key: "tags", type: "multiselect", required: true, options: [{ value: "a", label: "A" }] },
    ]);
    expect(fieldErrors(view, {})).toEqual({ name: "This field is required", tags: "This field is required" });
    expect(fieldErrors(view, { name: "", tags: [] })).toEqual({ name: "This field is required", tags: "This field is required" });
  });

  it("hides a `when`-gated field and stops validating it", () => {
    // `Form.When` is `{ key, op, value }` with `op` in `eq`/`neq`; every field
    // type may carry it, and it is the field's own visibility predicate.
    const view = formOf([
      { key: "kind", type: "string", options: [{ value: "sql", label: "SQL" }] },
      { key: "host", type: "string", when: [{ key: "kind", op: "eq", value: "sql" }] },
      { key: "note", type: "string", when: [{ key: "kind", op: "neq", value: "sql" }] },
    ]);
    const [, host, note] = view.fields;
    expect(isV2FormFieldVisible(host, { kind: "sql" })).toBe(true);
    expect(isV2FormFieldVisible(host, { kind: "other" })).toBe(false);
    expect(isV2FormFieldVisible(note, { kind: "other" })).toBe(true);
    expect(isV2FormFieldVisible(note, { kind: "sql" })).toBe(false);
    // The hidden field's value is dropped from the submitted answer.
    expect(validateV2FormAnswer(view, { kind: "sql", host: "localhost", note: "ignored" })).toEqual({
      ok: true,
      answer: { kind: "sql", host: "localhost" },
    });
  });

  it("hides a `hidden` field unconditionally", () => {
    const view = formOf([{ key: "secret", type: "string", hidden: true, required: true }]);
    expect(isV2FormFieldVisible(view.fields[0], {})).toBe(false);
    expect(validateV2FormAnswer(view, {})).toEqual({ ok: true, answer: {} });
  });
});
