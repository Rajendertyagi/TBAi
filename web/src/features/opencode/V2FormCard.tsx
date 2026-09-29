"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BracesIcon, FileTextIcon } from "lucide-react";
import type { FormInfo, SessionFormReplyInput } from "@opencode/client";
import { Button } from "@/components/ui/button";
import { CARD_SURFACE } from "@/components/shared/approval-card";
import { toolsConfig } from "@/config/tools";
import { writeClipboardText } from "@/lib/clipboard";
import { isIMECompositionEvent } from "@/lib/ime";
import {
  isV2FormFieldVisible,
  projectV2Form,
  v2FormFieldLabel,
  validateV2FormAnswer,
  type V2FormAnswer,
  type V2FormView,
} from "./v2Forms";
import { V2OptionControl } from "./V2OptionControl";
import { FORM_DOCK_CSS_MAX_HEIGHT_CLASS } from "./formDockSizing";
import { useFormDockMaxHeight } from "./useFormDockMaxHeight";
import { questionAsJson, questionAsMarkdown } from "./questionSerializers";
import { cn } from "@/lib/utils";

type FormValue = V2FormAnswer[string];

/** A pending question's own state: what to say about a copy, and how urgently. */
type CopyTone = "done" | "failed";

/** What the reader is told after a copy attempt. */
interface CopyStatus {
  readonly text: string;
  /** `done` expires on its own; `failed` waits to be replaced. See `copyQuestion`. */
  readonly tone: CopyTone;
}

/** How loudly a copy result is painted. One map, so the two tones cannot drift. */
const COPY_TONE_CLASS: Record<CopyTone, string> = {
  done: "text-muted-foreground",
  failed: "text-destructive",
};

/** One of the dock's two ways of taking a question away. */
interface CopyAction {
  /** The accessible name of the button, and the reason it needs one. */
  readonly label: string;
  /** What is said once the browser confirms this format's write. */
  readonly done: string;
  /** The writer. Both are pure, and both drop the routing ids. */
  readonly serialize: (form: V2FormView) => string;
  readonly icon: React.ReactNode;
}

/**
 * The two copy actions, as one list.
 *
 * A label, an icon, a confirmation and a writer travel together as one entry,
 * so a second action cannot be added without an accessible name, and a
 * confirmation cannot end up naming the wrong format.
 */
const COPY_ACTIONS: readonly CopyAction[] = [
  { label: toolsConfig.copy.form.copyMarkdown, done: toolsConfig.copy.form.copiedMarkdown, serialize: questionAsMarkdown, icon: <FileTextIcon aria-hidden="true" /> },
  { label: toolsConfig.copy.form.copyJson, done: toolsConfig.copy.form.copiedJson, serialize: questionAsJson, icon: <BracesIcon aria-hidden="true" /> },
];

/** Writes text to the clipboard, and reports which of the three outcomes it had. */
/** Cancels a pending confirmation timer, if one is armed. */
function disarmCopyConfirmation(timer: { current: ReturnType<typeof setTimeout> | null }): void {
  if (timer.current === null) return;
  clearTimeout(timer.current);
  timer.current = null;
}

/**
 * The id tying the step dots to the body they switch.
 *
 * One constant, because `aria-controls` and `id` are the same relationship
 * written twice, and a pair that can drift is an accessibility bug waiting to
 * happen.
 */
const DOCK_TABPANEL_ID = "question-dock-step";

function defaultAnswer(form: FormInfo): V2FormAnswer {
  const answer: { [key: string]: FormValue } = {};
  for (const field of form.fields) {
    if (!("default" in field) || field.default === undefined) continue;
    if (field.type === "number" || field.type === "integer") {
      if (typeof field.default === "number") answer[field.key] = field.default;
    } else if (field.type === "boolean") {
      if (typeof field.default === "boolean") answer[field.key] = field.default;
    } else if (field.type === "multiselect") {
      if (Array.isArray(field.default)) answer[field.key] = [...field.default];
    } else if (field.type === "string") {
      answer[field.key] = field.default;
    }
  }
  return answer;
}

/**
 * A step dot: filled once answered, solid while it is the current question.
 *
 * Carries the tabpanel wiring so the dots and the body they switch are one
 * relationship rather than two places that must agree.
 */
function StepDot({ index, current, done, onJump }: { index: number; current: boolean; done: boolean; onJump: () => void }) {
  return <button
    type="button"
    role="tab"
    aria-selected={current}
    aria-controls={DOCK_TABPANEL_ID}
    aria-label={toolsConfig.copy.form.stepAria(index)}
    onClick={onJump}
    className={cn(
      "size-2 shrink-0 rounded-full transition-colors",
      current ? "bg-primary" : done ? "bg-muted-foreground/50" : "bg-border",
    )}
  />;
}

/**
 * The question dock: an OpenCode form, one question at a time, docked directly
 * above the composer.
 *
 * ## Why one question at a time
 *
 * The previous card rendered every field at once. A three-field form became a
 * tall block that pushed the transcript up, and the reader had to hold all of it
 * in their head to answer any of it. A stepper keeps the dock a fixed small
 * size whatever the form's length, and it is the shape OpenCode's own clients
 * use. The progress row (`1 of 3`) and the clickable dots mean nothing is
 * hidden — the reader can see how many are left and jump to any of them.
 *
 * ## Why the answer lives here and not on the transcript card
 *
 * The `question` tool card in the transcript is a read-only history record. It
 * never hosted a control, and pointing at it as the place to answer was a dead
 * end. The dock is the single place a question is answered; the card shows the
 * settled answer afterwards.
 *
 * ## Why the header can take the question away
 *
 * Sometimes the answer belongs somewhere else — a script, another agent, a
 * colleague — and with no way to copy the question there is no way to ask it
 * there. Two formats, because there are two audiences: Markdown to read, JSON to
 * feed a script. Neither carries the routing ids, so a copy is portable to
 * another machine and another conversation; `questionSerializers.ts` owns that,
 * and says so. A copy button with no result is indistinguishable from a broken
 * one, so every outcome is reported: a short confirmation, a refusal, or the
 * clipboard being unavailable altogether.
 *
 * @param form - The pending server form.
 * @param onSubmit - Sends the keyed answer. Resolving retires the form.
 * @param onCancel - Drops the form without answering it.
 * @param queuedBehind - How many further forms are waiting, shown so a reader
 *   with several questions knows the first one is not the last.
 */
export function V2FormCard({
  form,
  onSubmit,
  onCancel,
  queuedBehind = 0,
}: {
  form: FormInfo;
  onSubmit: (answer: SessionFormReplyInput["answer"]) => Promise<void>;
  onCancel: () => Promise<void>;
  queuedBehind?: number;
}) {
  const view = useMemo(() => projectV2Form(form), [form]);
  const [answer, setAnswer] = useState<V2FormAnswer>(() => defaultAnswer(form));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [step, setStep] = useState(0);
  const [copyStatus, setCopyStatus] = useState<CopyStatus | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The dock's own scrolling body, measured so a long question cannot grow past
  // the top of the conversation. `collapsed` is the `enabled` flag, so a
  // collapsed dock measures nothing and keeps its CSS cap.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodyMaxHeight = useFormDockMaxHeight(bodyRef, !collapsed);

  // A confirmation must not outlive the dock: disarming the timer is what
  // stops a pending `setState` from firing against a card that is gone.
  useEffect(() => () => disarmCopyConfirmation(copyTimer), []);

  // Conditional fields can appear and disappear as earlier answers change, so
  // the stepper walks the VISIBLE fields and re-clamps whenever that set moves.
  const visible = view.fields.filter((field) => isV2FormFieldVisible(field, answer));
  const current = Math.min(step, Math.max(0, visible.length - 1));
  const field = visible[current];
  const last = current >= visible.length - 1;
  // A form can be shown but not answerable: every field hidden, or refused by
  // the projector. Both cases can only be dismissed.
  const canAnswer = field !== undefined && view.unsupportedReason === null;

  const setFieldValue = (value: FormValue | undefined) => {
    setAnswer((existing) => {
      const next = { ...existing };
      if (value === undefined) delete next[field.key];
      else next[field.key] = value;
      return next;
    });
    setError(null);
  };

  const submit = async () => {
    const effective: { [key: string]: FormValue } = { ...answer };
    for (const item of view.fields) if (!isV2FormFieldVisible(item, effective)) delete effective[item.key];
    const result = validateV2FormAnswer(view, effective);
    if (!result.ok) {
      setError(result.formError ?? Object.values(result.fieldErrors)[0] ?? toolsConfig.copy.form.invalidForm);
      // Take the reader TO the question that is blocking, rather than leaving
      // them on the last step with a message about a step they cannot see. The
      // key is mapped through the VISIBLE fields, because a conditional field
      // that has gone away must not become a jump target.
      const firstBad = Object.keys(result.fieldErrors).find((key) => visible.some((item) => item.key === key));
      const target = visible.findIndex((item) => item.key === firstBad);
      if (target >= 0) setStep(target);
      return;
    }
    setBusy(true); setError(null);
    try { await onSubmit(result.answer); } catch (cause) { setError(cause instanceof Error ? cause.message : toolsConfig.copy.form.submitFailed); setBusy(false); }
  };

  /** Cancels the form, surfacing a refusal instead of failing silently. */
  const cancel = async () => {
    setBusy(true); setError(null);
    try { await onCancel(); } catch (cause) { setError(cause instanceof Error ? cause.message : toolsConfig.copy.form.cancelFailed); setBusy(false); }
  };

  /**
   * Puts this question on the clipboard in one format, and says what happened.
   *
   * What is copied is the VISIBLE fields: that is the question as it stands for
   * this reader, and a `when`-gated field hidden by an earlier answer is not
   * part of it.
   *
   * A CONFIRMATION expires; a FAILURE does not. A message that has already
   * cleared itself is indistinguishable from a button that did nothing, so the
   * next attempt replaces the failure and nothing else does.
   */
  const copyQuestion = async (action: CopyAction) => {
    disarmCopyConfirmation(copyTimer);
    setCopyStatus(null);
    const outcome = await writeClipboardText(action.serialize({ ...view, fields: visible }));
    if (outcome === "copied") {
      setCopyStatus({ text: action.done, tone: "done" });
      copyTimer.current = setTimeout(() => setCopyStatus(null), toolsConfig.timing.copyConfirmMs);
      return;
    }
    setCopyStatus({
      text: outcome === "refused" ? toolsConfig.copy.form.copyRefused : toolsConfig.copy.form.copyUnavailable,
      tone: "failed",
    });
  };

  /**
   * Enter advances, Cmd/Ctrl+Enter submits, Shift+Enter is a newline.
   *
   * Two guards before either: an IME composition (accepting a candidate would
   * otherwise answer a half-typed question) and the reader's own Shift key.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" || isIMECompositionEvent(event)) return;
    if (event.shiftKey) return;
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) { void submit(); return; }
    if (last) void submit();
    else setStep(current + 1);
  };

  return <section aria-label={view.title} className={cn(CARD_SURFACE, "p-5 text-sm")}>
    {/* A fixed-shape header row. The title is the only part that gives ground
        (it truncates) and the actions are ONE `shrink-0` group, so a narrow dock
        shortens the question's name instead of wrapping three buttons onto a
        second line. That is also why the copy result is reported on its own row
        below: a long failure must never be able to widen the row it is
        reported in. */}
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="truncate font-medium text-foreground">{view.title}</h2>
        <p className="text-xs text-muted-foreground">{toolsConfig.copy.form.progress(current + 1, visible.length)}</p>
      </div>
      {queuedBehind > 0 ? <p className="shrink-0 text-xs text-muted-foreground">{toolsConfig.copy.form.queued(queuedBehind)}</p> : null}
      <div className="flex shrink-0 items-center gap-1">
        {/* Offered whether or not the question is expanded: a reader who has
            collapsed the dock can still need to take the question elsewhere. */}
        {COPY_ACTIONS.map((action) => <Button
          key={action.label}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={action.label}
          onClick={() => void copyQuestion(action)}
        >
          {action.icon}
        </Button>)}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-expanded={!collapsed}
          aria-label={collapsed ? toolsConfig.copy.form.expand : toolsConfig.copy.form.collapse}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
        </Button>
      </div>
    </div>

    {/* `status` is announced politely for a confirmation, `alert` immediately
        for a failure — a copy the reader believes in and did not happen must
        not wait its turn. */}
    {copyStatus ? <p
      role={copyStatus.tone === "failed" ? "alert" : "status"}
      className={cn("mt-2 text-xs", COPY_TONE_CLASS[copyStatus.tone])}
    >
      {copyStatus.text}
    </p> : null}

    {!collapsed && visible.length > 1 ? <div role="tablist" aria-label={toolsConfig.copy.form.stepsLabel} className="mt-3 flex items-center gap-1.5">
      {visible.map((item, index) => <StepDot
        key={item.key}
        index={index}
        current={index === current}
        done={answer[item.key] !== undefined}
        onJump={() => setStep(index)}
      />)}
    </div> : null}

    {view.unsupportedReason ? <p role="alert" className="mt-3 text-destructive">{view.unsupportedReason}</p> : null}

    {!collapsed && !field ? <p className="mt-3 text-sm text-muted-foreground">{toolsConfig.copy.form.nothingToAsk}</p> : null}

    {/*
      The body grows with its content and is only ever capped, never given a
      fixed height. Two options in a tall window want a short card; twelve
      options with a paragraph of text want a tall one. A fixed height is what
      makes the small case look like a form that needs scrolling, so the height
      is left to the content and only the ceiling is decided here.

      `max-h-1/2` is the normal case and is left entirely to CSS so it tracks
      the viewport for free. The inline value engages only when the room between
      the dock and the top of the conversation is genuinely smaller than that,
      which `useFormDockMaxHeight` measures.

      Scrolling is scoped to THIS block on purpose: the title, the progress, the
      step dots and the Back/Next/Submit row all stay put while a long list of
      options scrolls underneath them.
    */}
    {!collapsed && field ? <div
      ref={bodyRef}
      role="tabpanel"
      id={DOCK_TABPANEL_ID}
      onKeyDown={onKeyDown}
      className={cn("mt-3 overflow-y-auto overscroll-contain", FORM_DOCK_CSS_MAX_HEIGHT_CLASS)}
      style={bodyMaxHeight === undefined ? undefined : { maxHeight: bodyMaxHeight }}
    >
      <label htmlFor={`${field.key}-custom`} className="block font-medium text-foreground">
        {v2FormFieldLabel(field)}
        {field.required ? <span className="text-muted-foreground"> {toolsConfig.copy.form.requiredMarker}</span> : null}
      </label>
      {field.description ? <p className="mt-0.5 text-xs text-muted-foreground">{field.description}</p> : null}
      <div className="mt-2">
        <V2OptionControl
          field={field}
          value={answer[field.key]}
          onChange={setFieldValue}
          onKeyDown={onKeyDown}
          disabled={busy}
        />
      </div>
    </div> : null}

    {error ? <p role="alert" className="mt-3 text-destructive">{error}</p> : null}

    {!collapsed ? <div className="mt-4 flex items-center gap-2">
      {/* Advancing or submitting is offered only when there is something to
          answer and the server will accept a reply. A form whose fields are all
          hidden, or one `projectV2Form` refused outright, can only be dismissed
          — offering Submit there is offering an action guaranteed to be
          rejected, with the reason arriving after the click. */}
      {canAnswer && current > 0 ? <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setStep(current - 1)}>{toolsConfig.copy.form.back}</Button> : null}
      {/* A visible way forward on every step but the last. Enter also advances,
          but a reader using the mouse must never be stranded on a step with no
          forward action. Submit appears only once there is nothing left to step
          through, so the two are never both offered for the same step. */}
      {canAnswer && last ? <Button type="button" size="sm" disabled={busy} onClick={() => void submit()}>{busy ? toolsConfig.copy.form.submitting : toolsConfig.copy.form.submit}</Button> : null}
      {canAnswer && !last ? <Button type="button" size="sm" disabled={busy} onClick={() => setStep(current + 1)}>{toolsConfig.copy.form.next}</Button> : null}
      <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void cancel()}>{toolsConfig.copy.form.cancel}</Button>
    </div> : null}
  </section>;
}
