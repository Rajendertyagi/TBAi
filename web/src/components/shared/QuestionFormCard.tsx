"use client";

import { useState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface QuestionFormOption {
  label: string;
  description?: string;
}

export interface QuestionFormItem {
  question: string;
  header?: string;
  options: QuestionFormOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionFormCardProps {
  questions: QuestionFormItem[];
  onSubmit: (answers: string[][]) => Promise<void> | void;
  onDismiss: () => Promise<void> | void;
  title?: string;
  className?: string;
}

/**
 * Provider-agnostic Question Form Card.
 *
 * Renders a questionnaire interface for single or multiple questions.
 * - Single select: native <input type="radio">. Selection clears custom text.
 * - Multi select: native <input type="checkbox">.
 * - Custom freeform: native <Input> when supported. Typing clears selected options; selecting an option clears custom text.
 * - Multi-question: Step wizard (Question 1 of N) with Back/Next preserving all choices until final Submit.
 * - Actions: Dismiss, Back, Next, Submit. (No approval/permission metaphors).
 */
export function QuestionFormCard({
  questions,
  onSubmit,
  onDismiss,
  title,
  className,
}: QuestionFormCardProps) {
  const formId = useId();
  const [currentStep, setCurrentStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // answers[questionIndex] = string[]
  const [answers, setAnswers] = useState<string[][]>(() =>
    questions.map(() => []),
  );
  // customInputs[questionIndex] = string
  const [customInputs, setCustomInputs] = useState<string[]>(() =>
    questions.map(() => ""),
  );

  if (questions.length === 0) return null;

  const totalSteps = questions.length;
  const isMultiStep = totalSteps > 1;
  const step = Math.min(Math.max(currentStep, 0), totalSteps - 1);
  const activeQuestion = questions[step];

  // Helper to determine effective answer for a question index
  const getEffectiveAnswer = (qi: number): string[] => {
    const custom = customInputs[qi]?.trim();
    if (questions[qi]?.custom && custom && custom.length > 0) {
      return [custom];
    }
    return answers[qi] ?? [];
  };

  // Check if a question has been answered
  const isQuestionAnswered = (qi: number): boolean => {
    const ans = getEffectiveAnswer(qi);
    return ans.length > 0;
  };

  // Current step answer status
  const canProceed = isQuestionAnswered(step);
  const allAnswered = questions.every((_, idx) => isQuestionAnswered(idx));

  // Option selection handlers
  const handleOptionToggle = (label: string, multiple: boolean) => {
    // Selecting any option clears custom input for this step (mutual exclusion)
    setCustomInputs((prev) => {
      const next = [...prev];
      next[step] = "";
      return next;
    });

    setAnswers((prev) => {
      const next = prev.map((arr) => [...arr]);
      const current = next[step] ?? [];
      if (multiple) {
        const idx = current.indexOf(label);
        if (idx >= 0) {
          current.splice(idx, 1);
        } else {
          current.push(label);
        }
        next[step] = current;
      } else {
        next[step] = [label];
      }
      return next;
    });
  };

  // Custom text change handler
  const handleCustomChange = (val: string) => {
    setCustomInputs((prev) => {
      const next = [...prev];
      next[step] = val;
      return next;
    });

    // Typing custom text clears selected options for this step (mutual exclusion)
    if (val.trim().length > 0) {
      setAnswers((prev) => {
        const next = prev.map((arr) => [...arr]);
        next[step] = [];
        return next;
      });
    }
  };

  const handleNext = () => {
    if (step < totalSteps - 1) {
      setError(null);
      setCurrentStep(step + 1);
    }
  };

  const handleBack = () => {
    if (step > 0) {
      setError(null);
      setCurrentStep(step - 1);
    }
  };

  const handleSubmit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const fullAnswers = questions.map((_, idx) => getEffectiveAnswer(idx));
      await onSubmit(fullAnswers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const handleDismiss = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDismiss();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const currentSelected = answers[step] ?? [];
  const currentCustom = customInputs[step] ?? "";

  return (
    <div
      className={cn(
        "my-2 w-full rounded-2xl border border-border bg-card p-4 text-sm animate-in fade-in-0 zoom-in-95 duration-150",
        className,
      )}
    >
      {/* Header / Title */}
      {(title || activeQuestion.header) && (
        <div className="mb-2">
          {title && <h3 className="font-semibold text-foreground">{title}</h3>}
          {activeQuestion.header && (
            <p className="text-xs font-medium text-muted-foreground">
              {activeQuestion.header}
            </p>
          )}
        </div>
      )}

      {/* Multi-step progress indicator */}
      {isMultiStep && (
        <div className="mb-4 border-b border-border pb-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
            <span className="font-medium text-foreground">
              Question {step + 1} of {totalSteps}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {questions.map((q, idx) => {
              const answered = isQuestionAnswered(idx);
              const isCurrent = idx === step;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    setError(null);
                    setCurrentStep(idx);
                  }}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
                    isCurrent
                      ? "bg-primary text-primary-foreground"
                      : answered
                        ? "bg-muted text-foreground hover:bg-muted/80"
                        : "bg-muted/40 text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  {answered && <Check className="size-3 text-current" />}
                  <span>{q.header || `Q${idx + 1}`}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Question Prompt */}
      <div className="mb-3">
        <p className="font-medium text-foreground">{activeQuestion.question}</p>
      </div>

      {/* Options list */}
      {activeQuestion.options.length > 0 && (
        <div
          className="mb-4 space-y-2"
          role={activeQuestion.multiple ? "group" : "radiogroup"}
          aria-label={activeQuestion.question}
        >
          {activeQuestion.options.map((opt, optIdx) => {
            const inputId = `${formId}-q${step}-opt${optIdx}`;
            const isChecked = currentSelected.includes(opt.label);
            return (
              <label
                key={opt.label}
                htmlFor={inputId}
                className={cn(
                  "flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition-colors select-none",
                  isChecked
                    ? "border-primary/50 bg-primary/5 text-foreground"
                    : "border-border/60 bg-muted/20 hover:bg-muted/40 text-muted-foreground",
                )}
              >
                <input
                  id={inputId}
                  type={activeQuestion.multiple ? "checkbox" : "radio"}
                  name={`${formId}-q${step}`}
                  checked={isChecked}
                  onChange={() =>
                    handleOptionToggle(opt.label, activeQuestion.multiple ?? false)
                  }
                  className="mt-0.5 size-4 shrink-0 rounded border-border text-primary focus:ring-primary focus:ring-offset-0"
                />
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="font-medium text-foreground leading-tight">
                    {opt.label}
                  </span>
                  {opt.description && (
                    <span className="text-xs text-muted-foreground leading-normal">
                      {opt.description}
                    </span>
                  )}
                </div>
              </label>
            );
          })}
        </div>
      )}

      {/* Custom text field when protocol supports custom */}
      {activeQuestion.custom && (
        <div className="mb-4">
          <label
            htmlFor={`${formId}-q${step}-custom`}
            className="block text-xs font-medium text-muted-foreground mb-1.5"
          >
            Other / Custom response
          </label>
          <Input
            id={`${formId}-q${step}-custom`}
            type="text"
            value={currentCustom}
            onChange={(e) => handleCustomChange(e.target.value)}
            placeholder="Type your answer…"
            className="w-full"
          />
        </div>
      )}

      {/* Error alert */}
      {error && (
        <div className="mb-3 text-xs text-destructive" role="alert">
          {error}
        </div>
      )}

      {/* Actions footer */}
      <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={handleDismiss}
        >
          Dismiss
        </Button>

        <div className="flex items-center gap-2">
          {isMultiStep && step > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={handleBack}
            >
              Back
            </Button>
          )}

          {isMultiStep && step < totalSteps - 1 ? (
            <Button
              type="button"
              size="sm"
              disabled={busy || !canProceed}
              onClick={handleNext}
            >
              Next
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={busy || !allAnswered}
              onClick={handleSubmit}
            >
              {busy ? "Submitting…" : "Submit"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
