/**
 * The form projection's two honesty guarantees.
 *
 * ## M15 — a truncated option list is reported
 *
 * A field whose options exceed the limit is a field the reader CANNOT
 * answer: the answer they need is not in the list they are shown. The old
 * projection sliced the list and said nothing, so the form claimed to be
 * answerable while silently offering the wrong answers.
 *
 * ## M16 — an unknown field type is reported, not mis-projected
 *
 * The upstream's `Form.Field` union is closed - six types, exactly the ones
 * the renderer handles. The old projection had a CATCH-ALL that projected
 * every remaining type as a `multiselect`, so the day the server grew a
 * seventh type the renderer would have drawn a picker that cannot work and
 * answered with the wrong shape.
 *
 * The behaviour for the six supported types is unchanged. What changed is
 * that the catch-all is now an explicit "unsupported" projection, so a type
 * the renderer does not know is REPORTED rather than silently mistyped.
 */

import { describe, expect, it } from "bun:test";
import type { FormInfo } from "@opencode/client";
import { OPENCODE_V2_FORM_OPTION_LIMIT } from "@web/features/opencode/config.ts";
import { projectV2Form } from "@web/features/opencode/v2Forms.ts";

function formOf(fields: FormInfo["fields"]): ReturnType<typeof projectV2Form> {
  return projectV2Form({ id: "f", sessionID: "s", title: "T", fields });
}

/** A string field with `count` options. */
function stringFieldWithOptions(count: number): FormInfo["fields"][number] {
  return {
    key: "choice",
    type: "string",
    required: true,
    options: Array.from({ length: count }, (_unused, index) => ({
      value: `v${index}`,
      label: `Option ${index}`,
    })),
  };
}

describe("the form projection's honesty guarantees", () => {
  it("reports a field whose options were truncated", () => {
    const view = formOf([stringFieldWithOptions(OPENCODE_V2_FORM_OPTION_LIMIT + 1)]);

    // The form says WHY it cannot be answered.
    expect(view.unsupportedReason).not.toBeNull();
    // And the options it does show are the ones within the limit.
    expect(view.fields[0]?.type).toBe("string");
    const options = view.fields[0]?.type === "string" ? view.fields[0].options : null;
    expect(options).toHaveLength(OPENCODE_V2_FORM_OPTION_LIMIT);
  });

  it("does NOT report a field whose options fit", () => {
    const view = formOf([stringFieldWithOptions(OPENCODE_V2_FORM_OPTION_LIMIT)]);

    expect(view.unsupportedReason).toBeNull();
  });

  it("projects a multiselect as a multiselect, not as a catch-all", () => {
    // The explicit branch. Its behaviour is unchanged - the same fields, the
    // same options - and that is the point: the change made the branch
    // EXPLICIT rather than moving it.
    const view = formOf([
      {
        key: "tags",
        type: "multiselect",
        options: [{ value: "a", label: "A" }],
        minItems: 1,
        maxItems: 3,
      },
    ]);

    expect(view.unsupportedReason).toBeNull();
    expect(view.fields[0]?.type).toBe("multiselect");
    if (view.fields[0]?.type !== "multiselect") throw new Error("expected a multiselect");
    expect(view.fields[0].options).toHaveLength(1);
    expect(view.fields[0].minItems).toBe(1);
    expect(view.fields[0].maxItems).toBe(3);
  });

  it("reports an unknown field type instead of projecting it as a multiselect", () => {
    // The server grows a seventh type. The client accepts it (the union is
    // the server's), and the renderer does not know it.
    const unknown = {
      key: "future",
      type: "color-picker",
    } as unknown as FormInfo["fields"][number];
    const view = formOf([unknown]);

    expect(view.unsupportedReason).not.toBeNull();
    expect(view.fields[0]?.type).toBe("unsupported");
    if (view.fields[0]?.type !== "unsupported") throw new Error("expected an unsupported field");
    expect(view.fields[0].fieldType).toBe("color-picker");
    expect(view.fields[0].supported).toBe(false);
  });
});
