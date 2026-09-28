import type { FormField, FormInfo, FormOption, FormWhen, SessionFormReplyInput } from "@opencode/client";
import { OPENCODE_V2_FORM_FIELD_LIMIT, OPENCODE_V2_FORM_OPTION_LIMIT } from "@/config/opencode";

export type V2FormAnswer = SessionFormReplyInput["answer"];
type FormValue = V2FormAnswer[string];

export interface V2FormOptionView { readonly value: string; readonly label: string; readonly description: string | null }
export interface V2FormWhenView { readonly key: string; readonly op: "eq" | "neq"; readonly value: string | number | boolean }

interface V2FormFieldBase {
  readonly key: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly required: boolean;
  readonly hidden: boolean;
  readonly when: readonly V2FormWhenView[];
}

export type V2FormFieldView = V2FormFieldBase & (
  | { readonly type: "string"; readonly default: string | null; readonly options: readonly V2FormOptionView[] | null; readonly custom: boolean; readonly format: "email" | "uri" | "date" | "date-time" | null; readonly minLength: number | null; readonly maxLength: number | null; readonly pattern: string | null }
  | { readonly type: "number" | "integer"; readonly default: string | number | null; readonly minimum: number | string | null; readonly maximum: number | string | null }
  | { readonly type: "boolean"; readonly default: boolean | null }
  | { readonly type: "multiselect"; readonly default: readonly string[] | null; readonly options: readonly V2FormOptionView[] | null; readonly minItems: number | null; readonly maxItems: number | null; readonly custom: boolean }
  | { readonly type: "external"; readonly url: string; readonly supported: false }
);

export interface V2FormView {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly V2FormFieldView[];
  readonly unsupportedReason: string | null;
}

export type V2FormValidationResult =
  | { readonly ok: true; readonly answer: V2FormAnswer }
  | { readonly ok: false; readonly fieldErrors: Readonly<Record<string, string>>; readonly formError: string | null };

function options(value: readonly FormOption[] | undefined): readonly V2FormOptionView[] | null {
  // `[]` is truthy in JS, so an empty list would otherwise be read as "this
  // field HAS options" and render an empty picker. Verified against the live
  // server: `options: []` without `custom` rejects every value, and with
  // `custom: true` accepts free text — so an empty list is a field with NO
  // options, and `null` is the one representation both readers can test.
  if (value === undefined || value.length === 0) return null;
  return value.slice(0, OPENCODE_V2_FORM_OPTION_LIMIT).map((option) => ({ value: option.value, label: option.label, description: option.description ?? null }));
}

function when(value: readonly FormWhen[] | undefined): readonly V2FormWhenView[] {
  return (value ?? []).map((condition) => ({ key: condition.key, op: condition.op, value: condition.value }));
}

function base(field: FormField): V2FormFieldBase {
  const required = "required" in field && field.required === true;
  const hidden = "hidden" in field && field.hidden === true;
  const conditions = "when" in field ? when(field.when) : [];
  return { key: field.key, title: field.title ?? null, description: field.description ?? null, required, hidden, when: conditions };
}

/** Normalizes an official form into the typed fields supported by the V2 renderer. */
export function projectV2Form(form: FormInfo): V2FormView {
  const fields: V2FormFieldView[] = [];
  const keys = new Set<string>();
  let unsupportedReason: string | null = null;
  for (const field of form.fields.slice(0, OPENCODE_V2_FORM_FIELD_LIMIT)) {
    if (keys.has(field.key)) {
      unsupportedReason = `Duplicate form field: ${field.key}`;
      continue;
    }
    keys.add(field.key);
    const common = base(field);
    if (field.type === "external") {
      unsupportedReason = "External form fields are not supported";
      fields.push({ ...common, type: "external", url: field.url, supported: false });
    } else if (field.type === "string") {
      fields.push({ ...common, type: "string", default: field.default ?? null, options: options(field.options), custom: field.custom ?? false, format: field.format ?? null, minLength: field.minLength ?? null, maxLength: field.maxLength ?? null, pattern: field.pattern ?? null });
    } else if (field.type === "number" || field.type === "integer") {
      if (field.minimum === "NaN" || field.maximum === "NaN" || field.default === "NaN") unsupportedReason = "NaN form bounds are not supported";
      fields.push({ ...common, type: field.type, default: field.default ?? null, minimum: field.minimum ?? null, maximum: field.maximum ?? null });
    } else if (field.type === "boolean") {
      fields.push({ ...common, type: "boolean", default: field.default ?? null });
    } else {
      fields.push({ ...common, type: "multiselect", default: field.default ?? null, options: options(field.options), minItems: field.minItems ?? null, maxItems: field.maxItems ?? null, custom: field.custom ?? false });
    }
  }
  if (form.fields.length > OPENCODE_V2_FORM_FIELD_LIMIT) unsupportedReason = "This form has too many fields";
  return { id: form.id, title: form.title, fields, unsupportedReason };
}

/**
 * The options a field offers, or `null` when it offers none.
 *
 * One reader for the whole family, so the renderer and the validator cannot
 * disagree about whether a field "has options" — the bug this module had. Only
 * `string` and `multiselect` carry an option list in `Form.StringField` /
 * `Form.MultiselectField`; the number/integer/boolean/external fields do not.
 */
export function v2FormFieldOptions(field: V2FormFieldView): readonly V2FormOptionView[] | null {
  if (field.type === "string" || field.type === "multiselect") return field.options;
  return null;
}

/**
 * Whether a field accepts a value that is not one of its options.
 *
 * `custom` is the server's own switch for the free-text escape hatch and it
 * COEXISTS with `options` — it does not replace them (see `validateField`).
 */
export function v2FormFieldAllowsCustom(field: V2FormFieldView): boolean {
  return (field.type === "string" || field.type === "multiselect") && field.custom;
}

/**
 * The name a field goes by in front of a reader: its title, or its key.
 *
 * One rule, three readers — the dock's label, its Markdown copy and the control
 * itself. It was written out in each of them, which is the AGENTS.md §4 failure
 * of a duplicated primitive: change one and the other two quietly disagree, and
 * nothing fails until a title is missing.
 */
export function v2FormFieldLabel(field: V2FormFieldView): string {
  return field.title ?? field.key;
}

function sameValue(left: unknown, right: string | number | boolean): boolean {
  return left === right;
}

/** Evaluates all conditional predicates conjunctively against keyed answers. */
export function isV2FormFieldVisible(field: V2FormFieldView, answer: V2FormAnswer): boolean {
  if (field.hidden) return false;
  return field.when.every((condition) => {
    const matches = sameValue(answer[condition.key], condition.value);
    return condition.op === "eq" ? matches : !matches;
  });
}

function isMissing(value: FormValue | undefined): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function numericBound(value: number | string | null): number | null {
  if (value === null || value === "Infinity") return null;
  if (value === "-Infinity") return null;
  return typeof value === "number" ? value : null;
}

function validateField(field: V2FormFieldView, value: FormValue | undefined, errors: Record<string, string>): void {
  if (field.required && isMissing(value)) { errors[field.key] = "This field is required"; return; }
  if (value === undefined) return;
  if (field.type === "string") {
    if (typeof value !== "string") { errors[field.key] = "Enter text"; return; }
    if (field.minLength !== null && value.length < field.minLength) errors[field.key] = `Use at least ${field.minLength} characters`;
    if (field.maxLength !== null && value.length > field.maxLength) errors[field.key] = `Use at most ${field.maxLength} characters`;
    // `options` and `custom` COEXIST on one field — `Form.MultiselectField`
    // proves it (`options` is REQUIRED there and `custom` still exists), and
    // the server was asked directly: with both, free text is ACCEPTED; with
    // options and no `custom`, an unlisted value is REJECTED. So the option
    // constraint applies only when the field offers options AND does not allow
    // custom input. Reading it the other way round — as `!custom` replacing the
    // options — is what let any string through.
    const options = v2FormFieldOptions(field);
    if (options !== null && !v2FormFieldAllowsCustom(field) && !options.some((option) => option.value === value)) errors[field.key] = "Choose one of the available options";
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors[field.key] = "Enter a valid email";
    if (field.format === "uri") { try { new URL(value); } catch { errors[field.key] = "Enter a valid URI"; } }
    if (field.pattern) { try { if (!new RegExp(field.pattern).test(value)) errors[field.key] = "Value does not match the required format"; } catch { errors[field.key] = "The form pattern is invalid"; } }
  } else if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) { errors[field.key] = field.type === "integer" ? "Enter a whole number" : "Enter a finite number"; return; }
    const minimum = numericBound(field.minimum); const maximum = numericBound(field.maximum);
    if (minimum !== null && value < minimum) errors[field.key] = `Enter a value of at least ${minimum}`;
    if (maximum !== null && value > maximum) errors[field.key] = `Enter a value of at most ${maximum}`;
  } else if (field.type === "boolean") {
    if (typeof value !== "boolean") errors[field.key] = "Choose true or false";
  } else if (field.type === "multiselect") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) { errors[field.key] = "Choose valid options"; return; }
    // Same coexist rule as the string field: options AND a custom escape hatch,
    // not one instead of the other. `Form.Value` allows a string OR a string
    // array, and a multiselect answer is always the array — the server rejects
    // a scalar here ("Expected string array for form field: e").
    const options = v2FormFieldOptions(field);
    if (options !== null && !v2FormFieldAllowsCustom(field) && value.some((item) => !options.some((option) => option.value === item))) errors[field.key] = "Choose only available options";
    if (field.minItems !== null && value.length < field.minItems) errors[field.key] = `Choose at least ${field.minItems} options`;
    if (field.maxItems !== null && value.length > field.maxItems) errors[field.key] = `Choose at most ${field.maxItems} options`;
  }
}

/** Validates a keyed answer against visible fields and conditional rules. */
export function validateV2FormAnswer(form: V2FormView, answer: V2FormAnswer): V2FormValidationResult {
  if (form.unsupportedReason !== null) return { ok: false, fieldErrors: {}, formError: form.unsupportedReason };
  const errors: Record<string, string> = {};
  const visible: { [key: string]: FormValue } = {};
  for (const field of form.fields) {
    if (!isV2FormFieldVisible(field, answer)) continue;
    const value = answer[field.key];
    validateField(field, value, errors);
    if (value !== undefined) visible[field.key] = value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors, formError: null };
  return { ok: true, answer: visible };
}
