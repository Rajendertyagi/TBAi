"use client";

import { V2FormCard } from "./V2FormCard";
import { useOptionalV2RuntimeExtras } from "./v2RuntimeExtras";

/** Typed native V2 forms rendered in the fallback panel, separate from permissions. */
export function OpenCodeQuestions() {
  const extras = useOptionalV2RuntimeExtras();
  if (!extras || extras.forms.length === 0) return null;
  return <div className="flex flex-col gap-2 px-3 py-2">{extras.forms.map((form) => <V2FormCard key={form.id} form={form} onSubmit={(answer) => extras.replyToForm(form.id, answer)} onCancel={() => extras.rejectForm(form.id)} />)}</div>;
}
