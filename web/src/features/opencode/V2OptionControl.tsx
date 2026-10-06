"use client";

import { useEffect, useRef, useState } from "react";
import { toolsConfig } from "@/config/tools";
import {
  v2FormFieldAllowsCustom,
  v2FormFieldLabel,
  v2FormFieldOptions,
  type V2FormAnswer,
  type V2FormFieldView,
  type V2FormOptionView,
} from "./v2Forms";
import { formTextareaHeight, formTextareaOverflows } from "./formTextareaSizing";
import { cn } from "@/lib/utils";
import { isPlainEnter } from "@/lib/ime";

type FormValue = V2FormAnswer[string];

/**
 * Narrows a wire bound to a number the DOM can use.
 *
 * The form schema types `minimum`/`maximum` as `number | string | null` because
 * the server may send the JSON stand-ins `'Infinity' | '-Infinity' | 'NaN'`.
 * Anything non-finite means "unbounded", which the DOM spells as `undefined`.
 * This mirrors `v2Forms.numericBound`; the two are kept apart deliberately —
 * that one is part of validation, this one is part of rendering.
 */
function finiteBound(value: number | string | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Normalises the option list to `null` when there is nothing to pick from.
 *
 * `v2FormFieldOptions` returns `null` for a field with no options only AFTER
 * `projectV2Form` has run, because the projector is what maps the wire's
 * `undefined` and `[]` to `null`. Handed a raw field, it returns `undefined` —
 * and `[]` for a raw field carrying an empty list. Both are "no options", and
 * a control that trusted the distinction would draw an empty option group and
 * then crash mapping it. So the control does not depend on having been
 * projected: it treats only a non-empty array as options.
 */
function normalizeOptions(options: readonly V2FormOptionView[] | null | undefined): readonly V2FormOptionView[] | null {
  return options != null && options.length > 0 ? options : null;
}

/**
 * Whether opening the free-text escape hatch must clear the current answer.
 *
 * Picking an option and then choosing to type your own answer must not leave the
 * option sitting in the box as if it were what you typed. The reference client
 * clears the selection on this same transition.
 *
 * But only a LISTED option is cleared. An answer naming no option is already the
 * reader's own text — a re-opened dock, a second form carrying the same default
 * — and clearing that would silently destroy an answer nobody retyped. That is
 * the case `offListAnswer` exists to preserve, so the distinction is the rule.
 *
 * Pure, so the decision is pinned by a unit test rather than by clicking.
 *
 * @param selectedText - The current single-select answer, or "" for none.
 * @param options - The field's options, or null when it has none.
 * @returns True when the answer must be cleared on opening the hatch.
 */
export function shouldClearOnOpeningCustom(
  selectedText: string,
  options: readonly V2FormOptionView[] | null,
): boolean {
  if (selectedText.length === 0) return false;
  return (options ?? []).some((option) => option.value === selectedText);
}

export interface V2OptionControlProps {
  field: V2FormFieldView;
  value: FormValue | undefined;
  onChange: (value: FormValue | undefined) => void;
  /** Bubbled to the dock, which owns advancing and submitting. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
  disabled?: boolean;
}

/**
 * A free-text answer that grows with what is typed, then scrolls at the cap.
 *
 * The height comes from {@link formTextareaHeight}, a pure function, so the
 * growth rule is unit-tested rather than eyeballed. The one imperative height
 * write is a measured value, not a style decision — `AGENTS.md` forbids inline
 * *styling*, and no CSS-only equivalent sizes a box to its content in every
 * supported browser.
 */
function AnswerTextarea({
  value,
  onChange,
  onKeyDown,
  autoFocus,
  placeholder,
  id,
  disabled,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
  autoFocus?: boolean;
  placeholder: string;
  id: string;
  disabled?: boolean;
  label: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const height = formTextareaHeight(element.scrollHeight);
    element.style.height = `${height}px`;
    // Past the cap the box scrolls, so a long answer cannot push the dock off
    // the screen or the transcript to nothing.
    element.style.overflowY = formTextareaOverflows(height) ? "auto" : "hidden";
  }, [value]);
  return <textarea
    ref={ref}
    id={id}
    aria-label={label}
    rows={1}
    autoFocus={autoFocus}
    disabled={disabled}
    placeholder={placeholder}
    value={value}
    onChange={(event) => onChange(event.target.value)}
    onKeyDown={onKeyDown}
    className="w-full resize-none overflow-y-hidden rounded-md border border-border bg-transparent px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
  />;
}

/** The shared visual treatment of an option row and the Other row. */
const ROW_BASE =
  "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-50";
const ROW_SELECTED = "bg-muted text-foreground";
const ROW_UNSELECTED = "text-muted-foreground";

/** One option as a full-width row: control and label on a line, description under. */
function OptionRow({
  option,
  selected,
  multiple,
  onSelect,
  disabled,
}: {
  option: V2FormOptionView;
  selected: boolean;
  multiple: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return <button
    type="button"
    role={multiple ? "checkbox" : "radio"}
    aria-checked={selected}
    disabled={disabled}
    onClick={onSelect}
    className={cn(ROW_BASE, selected ? ROW_SELECTED : ROW_UNSELECTED)}
  >
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 size-3.5 shrink-0 border",
        multiple ? "rounded-[4px]" : "rounded-full",
        selected ? "border-primary bg-primary" : "border-border",
      )}
    />
    <span className="min-w-0 flex-1">
      <span className="block break-words font-medium text-foreground">{option.label}</span>
      {option.description ? <span className="mt-0.5 block break-words text-xs text-muted-foreground">{option.description}</span> : null}
    </span>
  </button>;
}

/**
 * The answer control for one question: its options, and the free-text escape
 * hatch when the field allows one.
 *
 * ## The two facts, read independently
 *
 * Whether the options render is decided by {@link v2FormFieldOptions} alone —
 * "does this field offer options?". Whether the Other row is added on top is
 * decided by {@link v2FormFieldAllowsCustom} alone. They are never combined into
 * one expression.
 *
 * This is the whole point of the module. A field can carry `options` AND
 * `custom: true` simultaneously — the live server sends exactly that
 * (`web/src/testing/question-payloads.ts`), and `Form.MultiselectField` proves
 * it structurally, since `options` is REQUIRED there and `custom` still
 * exists. An earlier renderer gated on `options && !custom`, which is false for
 * that payload, so the options vanished and the reader got a bare text box.
 * `custom` means "these options PLUS your own answer", never "instead of".
 *
 * ## Why single-select and multiselect differ on the Other row
 *
 * A single-select answer is one value, so typing replaces it. A multiselect
 * answer is an array (`Form.Value` rejects a scalar here — the server answers
 * "Expected string array for form field: e"), so a typed entry is APPENDED to
 * the selection rather than replacing it.
 */
export function V2OptionControl({ field, value, onChange, onKeyDown, disabled }: V2OptionControlProps) {
  const options = normalizeOptions(v2FormFieldOptions(field));
  const allowsCustom = v2FormFieldAllowsCustom(field);
  const multiple = field.type === "multiselect";
  const groupId = `${field.key}-options`;
  const textId = `${field.key}-custom`;
  const label = v2FormFieldLabel(field);

  // Single-select free text is a MODE the reader enters, so its open/closed
  // state is per-field UI state and lives here. Multiselect free text is
  // ADDITIVE, so it is a draft that is committed, not a mode.
  const [otherChosen, setOtherChosen] = useState(false);
  const [draft, setDraft] = useState("");

  const selectedList: readonly string[] = multiple ? (Array.isArray(value) ? value : []) : [];
  const selectedText = !multiple && typeof value === "string" ? value : "";

  // A value that names no option IS the reader's own answer, so the Other row
  // is open for it. Without this, an answer restored from state — a re-opened
  // dock, a second form carrying the same default — would hold text that
  // nothing on screen showed. Picking an option sets the value to a listed one,
  // which closes the row on its own, so the two cannot both read as chosen.
  const offListAnswer = !multiple && selectedText.length > 0 && !(options ?? []).some((option) => option.value === selectedText);
  const otherOpen = otherChosen || offListAnswer;

  // Options present → draw them. Nothing about `custom` participates here.
  if (options !== null) {
    // A multiselect answer is an array, so a typed entry is APPENDED to the
    // selection. It is committed on Enter only — never on blur, because a blur
    // fires while the reader is still mid-word (tabbing away to a button, for
    // instance) and would silently append a half-typed entry to their answer.
    // The draft is kept, so tabbing back shows exactly what was typed.
    const commitDraft = () => {
      const entry = draft.trim();
      if (entry.length === 0 || selectedList.includes(entry)) { setDraft(""); return; }
      onChange([...selectedList, entry]);
      setDraft("");
    };
    const rows = options.map((option) => {
      // While the reader is typing their own answer for a single-select, no
      // option may read as chosen — the typed text is the answer.
      const selected = multiple ? selectedList.includes(option.value) : !otherOpen && selectedText === option.value;
      const onSelect = () => {
        if (multiple) {
          onChange(selected ? selectedList.filter((entry) => entry !== option.value) : [...selectedList, option.value]);
          return;
        }
        setOtherChosen(false);
        onChange(option.value);
      };
      return <OptionRow key={option.value} option={option} selected={selected} multiple={multiple} onSelect={onSelect} disabled={disabled} />;
    });

    return <div role={multiple ? "group" : "radiogroup"} aria-label={toolsConfig.copy.form.optionGroupLabel(label)} className="flex flex-col gap-1" id={groupId}>
      {rows}
      {allowsCustom ? multiple ? <div className="flex items-center gap-2 pt-1">
        <input
          id={textId}
          aria-label={toolsConfig.copy.form.customEntryLabel}
          disabled={disabled}
          placeholder={toolsConfig.copy.form.customEntryPlaceholder}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // `isPlainEnter`, not `event.key === "Enter"`. Accepting an IME
            // candidate also fires a keydown, so the bare check committed the
            // PINYIN draft and closed the box instead of keeping the kanji the
            // reader actually typed.
            //
            // This site is worse than a missing guard, because of the `return`:
            // the event never reaches `onKeyDown`, so the dock's own IME-guarded
            // handler in `V2FormCard` never sees it either. Nothing downstream
            // could have caught it -- the guard has to be right here.
            if (isPlainEnter(event)) { event.preventDefault(); commitDraft(); return; }
            onKeyDown?.(event);
          }}
          className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        />
      </div> : <div className="pt-1">
        <button
          type="button"
          aria-expanded={otherOpen}
          disabled={disabled}
          onClick={() => {
            setOtherChosen(true);
            // Choosing to type your own answer must not start you off with the
            // option you happened to click a moment ago pre-filled in the box.
            // The reference client clears the selection on the same transition
            // (`{ custom: true, selected: [] }`).
            //
            // Only a LISTED option is cleared. An answer that names no option is
            // already the reader's own text — a re-opened dock, a second form
            // carrying the same default — and clearing that would silently
            // destroy an answer the reader never retyped. That case is exactly
            // what `offListAnswer` exists to preserve.
            // Only a LISTED option is cleared; an off-list answer is already the
            // reader's own text and must survive. See
            // `shouldClearOnOpeningCustom`.
            if (shouldClearOnOpeningCustom(selectedText, options)) onChange(undefined);
          }}
          className={cn(ROW_BASE, otherOpen ? ROW_SELECTED : ROW_UNSELECTED)}
        >
          <span className="font-medium">{toolsConfig.copy.form.other}</span>
        </button>
        {/*
          The row and the box are two things, and this is what stops them reading
          as one control. Drawn as siblings they were both full width, 4px apart,
          with a filled row directly above a bordered box — every edge lined up,
          so the eye merged them into a single "custom" widget.

          The box is now INSET from the row's left edge, which reads as "the
          answer to that row" rather than as a second peer, and the gap is wider
          so the two are never touching. Both are kept: the row still shows that
          you are in custom mode, which is worth keeping.
        */}
        {otherOpen ? <div className="pt-2 pl-8">
          <AnswerTextarea
            id={textId}
            label={toolsConfig.copy.form.customEntryLabel}
            placeholder={toolsConfig.copy.form.customEntryPlaceholder}
            autoFocus
            disabled={disabled}
            value={selectedText}
            onChange={(next) => onChange(next.length > 0 ? next : undefined)}
            onKeyDown={onKeyDown}
          />
        </div> : null}
      </div> : null}
    </div>;
  }

  // No options: free text IS the control. `custom` is not consulted, because a
  // field with nothing to pick from has nothing to add an escape hatch to.
  if (field.type === "string") {
    return <AnswerTextarea
      id={textId}
      label={label}
      placeholder={field.format === "date-time" ? toolsConfig.copy.form.customEntryPlaceholder : toolsConfig.copy.form.yourAnswer}
      disabled={disabled}
      value={selectedText}
      onChange={(next) => onChange(next.length > 0 ? next : undefined)}
      onKeyDown={onKeyDown}
    />;
  }

  // A number carries no options and no `custom`, so the input IS the control.
  // `minimum`/`maximum` reach here as `number | string | null` because the wire
  // may carry the JSON stand-ins 'Infinity' | '-Infinity' | 'NaN', so they are
  // narrowed the same way `v2Forms.numericBound` does before reaching the DOM.
  if (field.type === "number" || field.type === "integer") {
    return <input
      id={textId}
      type="number"
      inputMode={field.type === "integer" ? "numeric" : "decimal"}
      step={field.type === "integer" ? 1 : "any"}
      min={finiteBound(field.minimum) ?? undefined}
      max={finiteBound(field.maximum) ?? undefined}
      disabled={disabled}
      value={typeof value === "number" ? value : ""}
      onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
      onKeyDown={onKeyDown}
      className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
    />;
  }

  // A boolean is a two-value choice, so it is drawn as two option rows rather
  // than a dropdown. The old native `<select>` needed a third "unset" entry to
  // represent "not answered yet"; an unselected pair expresses that natively.
  if (field.type === "boolean") {
    const choices: readonly { value: boolean; label: string }[] = [
      { value: true, label: toolsConfig.copy.form.trueLabel },
      { value: false, label: toolsConfig.copy.form.falseLabel },
    ];
    return <div role="radiogroup" aria-label={label} className="flex flex-col gap-1">
      {choices.map((choice) => <button
        key={String(choice.value)}
        type="button"
        role="radio"
        aria-checked={value === choice.value}
        disabled={disabled}
        onClick={() => onChange(choice.value)}
        className={cn(ROW_BASE, value === choice.value ? ROW_SELECTED : ROW_UNSELECTED)}
      >
        <span aria-hidden="true" className={cn("mt-0.5 size-3.5 shrink-0 rounded-full border", value === choice.value ? "border-primary bg-primary" : "border-border")} />
        <span className="font-medium text-foreground">{choice.label}</span>
      </button>)}
    </div>;
  }

  // An external field must be completed in OpenCode itself; there is nothing to
  // answer here, and the form cannot be replied to until it is done.
  return <p className="text-sm text-destructive">{toolsConfig.copy.form.externalField}</p>;
}
