"use client";

import { V2FormCard } from "./V2FormCard";
import { useOptionalV2RuntimeExtras } from "./v2RuntimeExtras";

/**
 * The question dock: every OpenCode form still waiting on an answer, docked
 * directly above the composer.
 *
 * ## Why only the first form is drawn
 *
 * OpenCode can hold several pending forms at once. Rendering all of them stacks
 * a column of docks above the composer, which is the tall-block problem the
 * stepper exists to solve — moved one level up instead of solved. So the oldest
 * is shown and the rest are counted, and answering it brings the next one.
 * They stay in arrival order, so a form that has been waiting longest is the
 * one being asked.
 *
 * ## Why nothing is here when there are no forms
 *
 * An empty dock is worse than none: it would hold a slot above the composer
 * forever. `extras.forms` empties as soon as a reply is accepted, because the
 * controller retires the form on success.
 */
export function OpenCodeQuestions() {
  const extras = useOptionalV2RuntimeExtras();
  if (!extras || extras.forms.length === 0) return null;
  const [form] = extras.forms;
  return <V2FormCard
    form={form}
    queuedBehind={extras.forms.length - 1}
    onSubmit={(answer) => extras.replyToForm(form.id, answer)}
    onCancel={() => extras.rejectForm(form.id)}
  />;
}
