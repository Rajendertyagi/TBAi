/**
 * Portable copies of a pending question.
 *
 * WHY A QUESTION CAN BE COPIED. The dock is the only place a question is
 * answered, and sometimes the answer belongs somewhere else — a script, another
 * agent, a colleague. The reference behaviour (OpenChamber `formSerializers`)
 * puts it in one sentence: *the question travels to other tools as Markdown (to
 * read) or JSON (to feed a script); both leave the routing ids behind.*
 *
 * WHY THE ROUTING IDS ARE LEFT BEHIND. `FormInfo.id`, `sessionID` and
 * `metadata.tool` address ONE question inside ONE session on THIS machine.
 * A copy that carried them would be pasted into a tool that cannot resolve them
 * and would read as if it identified something. So both writers take the whole
 * view — `id` included — and emit only the question's CONTENT.
 *
 * The stripping is not a filter, it is a CONSTRUCTION: every value written out
 * below is named, one by one, from the field. There is no spread of a wire
 * object anywhere in this module, so no property the server adds later can
 * appear in a copy. That is the property the tests assert, including by walking
 * the parsed JSON for an `id`/`sessionID`/`metadata` key at ANY depth.
 *
 * The two formats are deliberately not the same shape. Markdown is a document a
 * person reads, so it leads with the question's title and spells out what an
 * answer may be. JSON is an array a script indexes, so it is the fields and
 * nothing else — no title, no envelope, no ids.
 */
import { toolsConfig } from "@/config/tools";
import {
  v2FormFieldAllowsCustom,
  v2FormFieldLabel,
  v2FormFieldOptions,
  type V2FormFieldView,
  type V2FormView,
} from "./v2Forms";

/** One choice a question offers, as it travels. */
export interface QuestionJsonOption {
  readonly value: string;
  readonly label: string;
  readonly description: string | null;
}

/**
 * One question, as it travels: what is asked, and what may be answered.
 *
 * `type` is the server's own field-type vocabulary rather than a second one, so
 * a script that already speaks the `question` tool needs no translation table.
 */
export interface QuestionJsonField {
  readonly key: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly required: boolean;
  readonly type: V2FormFieldView["type"];
  /**
   * The field's own option list, or `null` when it has none. A boolean is
   * `null` here even though Markdown lists `True`/`False`: a boolean's answer
   * is a JSON boolean, not one of two strings, and `type` already says so.
   */
  readonly options: readonly QuestionJsonOption[] | null;
  /** Whether the field also accepts an answer of the reader's own. */
  readonly freeText: boolean;
}

/** Markdown block separator. Two newlines, so every block is its own paragraph. */
const BLANK_LINE = "\n\n";
/** Question-set title marker. */
const HEADING1 = "# ";
/** Question marker, one level below the title. */
const HEADING2 = "## ";
/** Option marker. */
const BULLET = "- ";
/** Indent of an option's detail line, two spaces — a valid Markdown sub-list. */
const DETAIL_INDENT = "  ";
/** Indent of a JSON block, so a pasted question is readable before it is parsed. */
const JSON_INDENT = 2;

/** One answer a field offers, with the detail the dock shows beside it. */
interface MarkdownChoice {
  readonly label: string;
  readonly description: string | null;
}

/**
 * The answers a field offers, as prose.
 *
 * A boolean carries no option list on the wire, but a reader still has to be
 * told what its two answers are — so it offers the two labels the dock itself
 * draws. JSON does NOT do this; see `QuestionJsonField.options`.
 */
function choicesOf(field: V2FormFieldView): readonly MarkdownChoice[] {
  if (field.type === "boolean") {
    return [
      { label: toolsConfig.copy.form.trueLabel, description: null },
      { label: toolsConfig.copy.form.falseLabel, description: null },
    ];
  }
  const options = v2FormFieldOptions(field);
  if (options === null) return [];
  return options.map((option) => ({ label: option.label, description: option.description }));
}

/** The kind of answer a field expects, for a field that offers no choices. */
function answerHint(field: V2FormFieldView): string | null {
  if (field.type === "external") return toolsConfig.copy.form.externalField;
  if (field.type === "number") return toolsConfig.copy.form.copyAnswerNumber;
  if (field.type === "integer") return toolsConfig.copy.form.copyAnswerInteger;
  // Only the no-option case needs a hint: with options on screen the choices
  // already say what may be answered.
  if (field.type === "multiselect" && v2FormFieldOptions(field) === null) return toolsConfig.copy.form.copyAnswerList;
  if (field.type === "string" && v2FormFieldOptions(field) === null) return toolsConfig.copy.form.copyAnswerText;
  return null;
}

/** One question as a Markdown block: name, detail, choices, and how to answer. */
function fieldAsMarkdown(field: V2FormFieldView): string {
  const required = field.required ? toolsConfig.copy.form.copyRequired : "";
  const lines = [`${HEADING2}${v2FormFieldLabel(field)}${required}`];
  if (field.description) lines.push(field.description);
  const choices = choicesOf(field);
  for (const choice of choices) {
    lines.push(`${BULLET}${choice.label}`);
    if (choice.description) lines.push(`${DETAIL_INDENT}${BULLET}${choice.description}`);
  }
  // Exactly one hint, and never both: with choices on screen only the escape
  // hatch is unstated, and without them the type of answer is.
  const hint = choices.length > 0
    ? (v2FormFieldAllowsCustom(field) ? toolsConfig.copy.form.customEntryLabel : null)
    : answerHint(field);
  if (hint) lines.push(hint);
  return lines.join(BLANK_LINE);
}

/**
 * The question as Markdown, for a person to read.
 *
 * Emits the question set's title (when it has one), then one block per field.
 * A form with no fields emits the "nothing to copy" line rather than an empty
 * document, because an empty string on a clipboard is indistinguishable from a
 * copy that silently did nothing.
 */
export function questionAsMarkdown(form: V2FormView): string {
  const blocks: string[] = [];
  const title = form.title.trim();
  if (title) blocks.push(`${HEADING1}${title}`);
  if (form.fields.length === 0) {
    blocks.push(toolsConfig.copy.form.copyEmpty);
    return blocks.join(BLANK_LINE);
  }
  for (const field of form.fields) blocks.push(fieldAsMarkdown(field));
  return blocks.join(BLANK_LINE);
}

/**
 * The question as a JSON array of fields, for a script to consume.
 *
 * The question's CONTENT, not the form envelope: no `id`, no `sessionID`, no
 * `metadata`, and not the title either — an array a script indexes needs no
 * wrapper. Every property is written by name, so nothing the server sends can
 * ride along.
 */
export function questionAsJson(form: V2FormView): string {
  const fields: QuestionJsonField[] = form.fields.map((field) => {
    const options = v2FormFieldOptions(field);
    return {
      key: field.key,
      title: field.title,
      description: field.description,
      required: field.required,
      type: field.type,
      options: options === null
        ? null
        : options.map((option) => ({ value: option.value, label: option.label, description: option.description })),
      freeText: v2FormFieldAllowsCustom(field),
    };
  });
  return JSON.stringify(fields, null, JSON_INDENT);
}
