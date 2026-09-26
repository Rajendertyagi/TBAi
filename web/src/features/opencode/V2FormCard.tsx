"use client";

import { useMemo, useState } from "react";
import type { FormInfo, SessionFormReplyInput } from "@opencode/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  isV2FormFieldVisible,
  projectV2Form,
  validateV2FormAnswer,
  type V2FormAnswer,
  type V2FormFieldView,
} from "./v2Forms";

function defaultAnswer(form: FormInfo): V2FormAnswer {
  const answer: { [key: string]: string | number | boolean | readonly string[] } = {};
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

function fieldLabel(field: V2FormFieldView): string {
  return field.title ?? field.key;
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: V2FormFieldView;
  value: string | number | boolean | readonly string[] | undefined;
  onChange: (value: string | number | boolean | readonly string[] | undefined) => void;
}) {
  if (field.type === "boolean") {
    return <select aria-label={fieldLabel(field)} className="h-9 rounded-md border bg-transparent px-2 text-sm" value={value === true ? "true" : value === false ? "false" : ""} onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value === "true")}><option value="">Select…</option><option value="true">True</option><option value="false">False</option></select>;
  }
  if (field.type === "multiselect") {
    const selected = Array.isArray(value) ? value : [];
    return <div className="flex flex-wrap gap-2">{field.options.map((option) => <label key={option.value} className="inline-flex items-center gap-1 text-sm"><input type="checkbox" checked={selected.includes(option.value)} onChange={(event) => onChange(event.target.checked ? [...selected, option.value] : selected.filter((item) => item !== option.value))} />{option.label}</label>)}</div>;
  }
  if (field.type === "external") return <p className="text-sm text-destructive">This field must be completed in OpenCode.</p>;
  if (field.type === "string" && field.options && !field.custom) {
    return <select aria-label={fieldLabel(field)} className="h-9 rounded-md border bg-transparent px-2 text-sm" value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || undefined)}><option value="">Select…</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  }
  if (field.type === "string" && field.format === "date-time") return <Textarea aria-label={fieldLabel(field)} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || undefined)} />;
  if (field.type === "string") return <Input aria-label={fieldLabel(field)} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || undefined)} />;
  return <Input aria-label={fieldLabel(field)} type="number" value={typeof value === "number" ? value : ""} onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))} />;
}

/** Renders one typed OpenCode V2 form without linking it to tool approvals. */
export function V2FormCard({
  form,
  onSubmit,
  onCancel,
}: {
  form: FormInfo;
  onSubmit: (answer: SessionFormReplyInput["answer"]) => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const view = useMemo(() => projectV2Form(form), [form]);
  const [answer, setAnswer] = useState<V2FormAnswer>(() => defaultAnswer(form));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const effective: { [key: string]: string | number | boolean | readonly string[] } = { ...answer };
    for (const field of view.fields) if (!isV2FormFieldVisible(field, effective)) delete effective[field.key];
    const result = validateV2FormAnswer(view, effective);
    if (!result.ok) { setError(result.formError ?? Object.values(result.fieldErrors)[0] ?? "Invalid form"); return; }
    setBusy(true); setError(null);
    try { await onSubmit(result.answer); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not submit form"); setBusy(false); }
  };
  return <section className="rounded-lg border bg-card/60 p-3 text-sm" aria-label={view.title}>
    <h2 className="mb-2 font-medium">{view.title}</h2>
    {view.unsupportedReason && <p role="alert" className="mb-2 text-destructive">{view.unsupportedReason}</p>}
    <div className="flex flex-col gap-3">{view.fields.filter((field) => isV2FormFieldVisible(field, answer)).map((field) => <label key={field.key} className="flex flex-col gap-1"><span>{fieldLabel(field)}{field.required ? " *" : ""}</span>{field.description && <span className="text-xs text-muted-foreground">{field.description}</span>}<FieldControl field={field} value={answer[field.key]} onChange={(value) => setAnswer((current) => { const next = { ...current }; if (value === undefined) delete next[field.key]; else next[field.key] = value; return next; })} /></label>)}</div>
    {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
    <div className="mt-3 flex gap-2"><Button type="button" size="sm" disabled={busy} onClick={() => void submit()}>{busy ? "Submitting…" : "Submit"}</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void onCancel()}>Cancel</Button></div>
  </section>;
}
