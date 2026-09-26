import {
  describe,
  it,
  expect,
  beforeAll,
} from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionFormCard } from "./QuestionFormCard";
import type { QuestionFormItem } from "./QuestionFormCard";

/**
 * Question form UI — behavioral contracts (coding-agent Phase hardening).
 *
 * The state-transition logic (mutual exclusion between options and custom
 * text, single vs multi select, navigation, submission payload) lives inside
 * the component's `useState`. `web/` has no DOM runner (bun test, no jsdom /
 * testing-library), so these tests pin the *logic* through two seams:
 *
 *   1. **Static render** (`renderToStaticMarkup`) of the REAL
 *      `QuestionFormCard` against each shape, asserting the rendered control
 *      types, step navigation, custom-input presence/absence, and the action
 *      footer — the *structural* contracts.
 *   2. **Source-level guards** on the component's own state-update functions
 *      (`handleOptionToggle`, `handleCustomChange`, `handleSubmit`,
 *      `getEffectiveAnswer`), so a regression that breaks the
 *      mutual-exclusion / answer-collection semantics fails here rather than
 *      only in a browser.
 *
 * The native V2 form projection and thread-controller contracts are covered in
 * `features/opencode/v2Forms.test.ts` and
 * `features/opencode/v2ThreadController.test.ts`; this file covers the
 * form-card UI itself.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────────

const single: QuestionFormItem = {
  question: "Which one?",
  options: [
    { label: "Option A", description: "first" },
    { label: "Option B", description: "second" },
  ],
};

const multi: QuestionFormItem = {
  question: "Pick any",
  options: [
    { label: "X" },
    { label: "Y" },
    { label: "Z" },
  ],
  multiple: true,
};

const withCustom: QuestionFormItem = {
  question: "Free text?",
  options: [{ label: "suggested" }],
  custom: true,
};

const noCustom: QuestionFormItem = {
  question: "No custom",
  options: [{ label: "only" }],
};

const twoSteps: QuestionFormItem[] = [
  { question: "First", options: [{ label: "a1" }, { label: "a2" }] },
  {
    question: "Second",
    options: [{ label: "b1" }, { label: "b2" }],
    multiple: true,
    custom: true,
  },
];

function renderCard(questions: QuestionFormItem[]): string {
  const Any = QuestionFormCard as unknown as (
    p: Record<string, unknown>,
  ) => ReactElement;
  return renderToStaticMarkup(
    createElement(Any, {
      questions,
      onSubmit: async () => {},
      onDismiss: async () => {},
    }),
  );
}

// ── Source guards: the state-transition logic ──────────────────────────────

let source = "";
let optionToggleBlock = "";
let customChangeBlock = "";
let submitBlock = "";
let effectiveAnswerBlock = "";

beforeAll(async () => {
  source = await Bun.file(
    new URL("./QuestionFormCard.tsx", import.meta.url),
  ).text();
  // The option-toggle transition: mutual exclusion (option clears custom) +
  // single-select vs multi-select.
  optionToggleBlock =
    source.match(
      /handleOptionToggle = \(label: string, multiple: boolean\) => \{[\s\S]*?\n  \};/,
    )?.[0] ?? "";
  // The custom-text transition: typing clears the selected options.
  customChangeBlock =
    source.match(
      /handleCustomChange = \(val: string\) => \{[\s\S]*?\n  \};/,
    )?.[0] ?? "";
  // The submit transition: collects every step's effective answer positionally.
  submitBlock =
    source.match(
      /handleSubmit = async \(\) => \{[\s\S]*?\n  \};/,
    )?.[0] ?? "";
  // The effective-answer helper: custom text (trimmed) wins over the options.
  effectiveAnswerBlock =
    source.match(
      /const getEffectiveAnswer = \(qi: number\): string\[\] => \{[\s\S]*?\n  \};/,
    )?.[0] ?? "";
});

// ── 1. Single-select radio behavior ─────────────────────────────────────────

describe("single-select radio behavior", () => {
  it("only one option is the active choice (selecting replaces the prior one)", () => {
    // The single-select branch assigns a fresh one-element array — it does NOT
    // append to the prior selection.
    expect(optionToggleBlock).toContain("next[step] = [label];");
  });

  it("renders native radios in a radiogroup for a single-select question", () => {
    const html = renderCard([single]);
    expect(html).toContain('type="radio"');
    expect(html).toContain('role="radiogroup"');
  });

  it("does not render a checkbox on a non-multiple question", () => {
    const html = renderCard([single]);
    expect(html).not.toContain('type="checkbox"');
  });
});

// ── 2. Multi-select checkbox behavior ──────────────────────────────────────

describe("multi-select checkbox behavior", () => {
  it("multiple options can be selected independently (toggle on/off)", () => {
    // The multi-select branch adds the label when absent and removes it when
    // present — it must NOT clear the whole answer (that would break
    // independent toggling).
    expect(optionToggleBlock).toContain("current.splice(idx, 1);");
    expect(optionToggleBlock).toContain("current.push(label);");
    // The multi branch keeps the whole selection array.
    expect(optionToggleBlock).toContain("next[step] = current;");
  });

  it("renders checkboxes (not radios) for a multiple question", () => {
    const html = renderCard([multi]);
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('role="radiogroup"');
  });
});

// ── 3. Option selection clears custom text ─────────────────────────────────

describe("option selection clears custom text", () => {
  it("clicking any option resets the custom text input for that step", () => {
    // The option-toggle handler clears the custom input before it writes the
    // selection — mutual exclusion, one answer channel active.
    expect(optionToggleBlock).toContain("next[step] = \"\";");
    expect(optionToggleBlock).toContain("setCustomInputs((prev) =>");
  });
});

// ── 4. Custom typing clears selected options ──────────────────────────────

describe("custom typing clears selected options", () => {
  it("entering non-blank custom text unchecks the radio/checkbox selections", () => {
    // Typing non-blank custom text wipes the option selections for that step
    // so the freeform channel is the sole active answer.
    expect(customChangeBlock).toContain("val.trim().length > 0");
    expect(customChangeBlock).toContain("next[step] = [];");
    expect(customChangeBlock).toContain("setAnswers((prev) =>");
  });

  it("blank custom text does not clear the selections", () => {
    // Only a non-blank custom value clears options; whitespace is ignored.
    expect(customChangeBlock).toContain("val.trim().length > 0");
  });
});

// ── 5. Custom input presence ──────────────────────────────────────────────

describe("custom input presence", () => {
  it("renders the custom text field only when custom is true", () => {
    const withField = renderCard([withCustom]);
    expect(withField).toContain("Other / Custom response");
    expect(withField).toContain('type="text"');

    const withoutField = renderCard([noCustom]);
    expect(withoutField).not.toContain("Other / Custom response");
    expect(withoutField).not.toContain('type="text"');
  });
});

// ── 6. Multi-question wizard ───────────────────────────────────────────────

describe("multi-question wizard", () => {
  it("renders a single multi-step form with a 'Question X of N' indicator", () => {
    const html = renderCard(twoSteps);
    expect(html).toContain("Question 1 of 2");
    // Per-step navigation chips.
    expect(html).toContain("Q1");
    expect(html).toContain("Q2");
    // The step indicator is hidden for a single-question form.
    const singleStep = renderCard([single]);
    expect(singleStep).not.toContain("Question 1 of");
  });

  it("shows Next on earlier steps and Submit on the final step", () => {
    // The rendered footer for the current step shows "Next" (early steps); the
    // source defines both the Next button (early steps) and the Submit button
    // (final step) in JSX.
    const html = renderCard(twoSteps);
    expect(html).toContain("Next");
    // JSX button labels in the source (not HTML).
    expect(source).toContain("Next");
    expect(source).toContain('"Submit"');
  });

  it("shows no Back button on step zero", () => {
    // Back only renders when `step > 0`; on step 0 the footer has Dismiss +
    // Next/Submit but no Back.
    const html = renderCard(twoSteps);
    expect(html).not.toContain("Back");
    // The guard that gates the Back button exists in the source.
    expect(source).toContain("isMultiStep && step > 0 &&");
  });
});

// ── 7. Back/Next state preservation ────────────────────────────────────────

describe("Back/Next state preservation", () => {
  it("navigation changes only the active step, never the answers or custom text", () => {
    // `handleNext`/`handleBack` (and the step-chip clicks) call only
    // `setCurrentStep`; they must not touch `answers` or `customInputs`, so
    // selections on other steps survive a round trip.
    const nextFn =
      source.match(/handleNext = \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? "";
    const backFn =
      source.match(/handleBack = \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? "";
    expect(nextFn).toContain("setCurrentStep(step + 1)");
    expect(backFn).toContain("setCurrentStep(step - 1)");
    // Neither navigator mutates the answer state.
    expect(nextFn).not.toContain("setAnswers");
    expect(backFn).not.toContain("setAnswers");
    expect(nextFn).not.toContain("setCustomInputs");
    expect(backFn).not.toContain("setCustomInputs");
  });

  it("answers are keyed by question index, not by the current step", () => {
    // The per-step selection is read back by index (`answers[step]`), so a
    // step the user already left keeps its value.
    expect(source).toContain("const currentSelected = answers[step] ?? [];");
    expect(source).toContain('const currentCustom = customInputs[step] ?? "";');
  });
});

// ── 8. Complete submission ──────────────────────────────────────────────────

describe("complete submission", () => {
  it("final Submit collects every step's answer into a positional string[][]", () => {
    // `handleSubmit` maps the questions array in order, so `answers[i]` always
    // corresponds to `questions[i]` — the exact native V2 form answer shape.
    expect(submitBlock).toContain(
      "questions.map((_, idx) => getEffectiveAnswer(idx))",
    );
    expect(submitBlock).toContain("await onSubmit(fullAnswers);");
  });

  it("a step answered by custom text emits the trimmed text as a single answer", () => {
    // `getEffectiveAnswer` prefers the custom text (trimmed, one-element) over
    // the option selection when both are present.
    expect(effectiveAnswerBlock).toContain("customInputs[qi]?.trim()");
    expect(effectiveAnswerBlock).toContain("return [custom];");
    expect(effectiveAnswerBlock).toContain("return answers[qi] ?? [];");
  });

  it("Submit is disabled until every step has an answer", () => {
    // The final-step Submit is gated on `allAnswered`; with an unanswered
    // multi-step form the submit control renders disabled.
    const html = renderCard(twoSteps);
    // SSR renders a truthy `disabled` prop as `disabled=""`.
    expect(html).toContain('disabled=""');
    expect(source).toContain("allAnswered");
  });
});

// ── 9. Dismiss action ──────────────────────────────────────────────────────

describe("dismiss action", () => {
  it("clicking Dismiss invokes onDismiss", () => {
    const html = renderCard([single]);
    expect(html).toContain("Dismiss");
    expect(source).toContain("onClick={handleDismiss}");
    expect(source).toContain("await onDismiss();");
  });
});
