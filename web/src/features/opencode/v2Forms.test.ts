import { describe, expect, it } from "bun:test";
import type { FormInfo } from "@opencode/client";
import { projectV2Form, validateV2FormAnswer } from "./v2Forms";

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
