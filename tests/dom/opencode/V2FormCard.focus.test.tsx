/**
 * The question dock's per-question state and focus, asserted BEHAVIOURALLY.
 *
 * ## Why this file exists
 *
 * Two findings were guarded by source-text assertions, which is exactly the
 * kind of guard that cannot fail for the reason it exists:
 *
 * - **M14** — `V2OptionControl` was rendered without a `key`, so React reused
 *   the same instance across a question change and the control's `otherChosen`
 *   / `draft` state survived it: a half-typed custom entry leaked into the next
 *   question, and `commitDraft` appended the PREVIOUS question's text to the
 *   CURRENT field's answer. The wrong answer reaches the agent.
 * - **M18** — `dockSeen.current` was assigned `false` twice and never `true`, so
 *   the step-change focus move was dead code. The reader pressed Enter, the dock
 *   advanced, and focus stayed behind on the step they had left - which is how
 *   one Enter press ends up answering two different questions.
 *
 * The source-text guards are gone; the behaviour is asserted here, in a DOM,
 * with the real component.
 *
 * ## Why the DOM suite
 *
 * These are React rendering behaviours: a `key`, a `useState` that must not
 * survive a re-render into a different element, and a `useEffect` that must
 * move DOM focus. None of them can be observed by `renderToStaticMarkup`
 * (which runs no effects and no event handlers) or by a source-text match.
 *
 * `bun test` has no DOM, so this runs under `bun run test:dom`, which preloads
 * happy-dom (`tests/setup/dom-preload.ts`).
 *
 * ## Two conventions worth knowing
 *
 * 1. **Focus is compared as a BOOLEAN**, never as `expect(a).toBe(b)`. A failed
 *    identity assertion prints both elements, and happy-dom's element graph is
 *    enormous - one such failure wrote 350 MB of output.
 * 2. **The registry's focus is deferred to a microtask** (`scheduleFocusPick`),
 *    so a test that observes the ARRIVAL has to let the microtask run first.
 */

import { describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FormInfo } from "@opencode/client";
import { V2FormCard } from "@web/features/opencode/V2FormCard.tsx";

/** A multiselect question, which is where the DRAFT lives. */
function multiselectField(key: string, values: readonly string[]): FormInfo["fields"][number] {
  return {
    key,
    type: "multiselect",
    required: true,
    options: values.map((value) => ({ value, label: value })),
    custom: true,
  };
}

/** A single-select question, which is where the free-text HATCH lives. */
function singleField(key: string, values: readonly string[]): FormInfo["fields"][number] {
  return {
    key,
    type: "string",
    required: true,
    options: values.map((value) => ({ value, label: value })),
    custom: true,
  };
}

function formOf(fields: FormInfo["fields"]): FormInfo {
  return { id: "frm_m14", sessionID: "ses_m14", title: "Two questions", fields };
}

interface Mounted {
  readonly root: Root;
  readonly container: HTMLElement;
}

/** Mounts the dock and returns the container to query. */
function mount(form: FormInfo, onSubmit?: (answer: unknown) => Promise<void>): Mounted {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = () =>
    act(() => {
      root.render(
        <V2FormCard
          form={form}
          onSubmit={onSubmit ? (answer) => onSubmit(answer) : () => Promise.resolve()}
          onCancel={() => Promise.resolve()}
        />,
      );
    });
  render();
  return { root, container };
}

function unmount(mounted: Mounted): void {
  act(() => {
    mounted.root.unmount();
  });
  mounted.container.remove();
}

/** The dock BODY - the only place a field's control lives. */
function dockBody(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[role="tabpanel"]');
}

/**
 * The "Other" row: the button that opens the free-text hatch of a
 * single-select.
 *
 * Scoped to the dock BODY, because the header's collapse toggle also carries
 * `aria-expanded` and would otherwise be picked up.
 */
function otherRow(container: HTMLElement): HTMLButtonElement | null {
  const body = dockBody(container);
  if (!body) return null;
  return (body.querySelector("button[aria-expanded]") ?? null) as HTMLButtonElement | null;
}

/** The "Next" button, which advances the step. */
function nextButton(container: HTMLElement): HTMLButtonElement | null {
  return ([...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Next",
  ) ?? null) as HTMLButtonElement | null;
}

/** The "Submit" button, which answers the last question. */
function submitButton(container: HTMLElement): HTMLButtonElement | null {
  return ([...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Submit",
  ) ?? null) as HTMLButtonElement | null;
}

/** The "Back" button. */
function backButton(container: HTMLElement): HTMLButtonElement | null {
  return ([...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Back",
  ) ?? null) as HTMLButtonElement | null;
}

/** The free-text control of the CURRENT question, once the hatch is open. */
function customInput(container: HTMLElement): HTMLInputElement | HTMLTextAreaElement | null {
  const body = dockBody(container);
  if (!body) return null;
  return (
    (body.querySelector('input[id$="-custom"], textarea[id$="-custom"]') as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null) ?? null
  );
}

/** The option rows of the dock's CURRENT question. */
function optionRows(container: HTMLElement): HTMLButtonElement[] {
  const body = dockBody(container);
  if (!body) return [];
  return [
    ...body.querySelectorAll<HTMLButtonElement>('button[role="radio"], button[role="checkbox"]'),
  ];
}

/**
 * Whether `element` is the focused element.
 *
 * Compared as a BOOLEAN, never as `expect(element).toBe(other)`: a failed
 * identity assertion prints both elements, and happy-dom's element graph is
 * enormous - one such failure wrote 350 MB of output. A boolean prints one
 * word.
 */
function isFocused(element: Element | null | undefined): boolean {
  return element !== null && element !== undefined && document.activeElement === element;
}

/** Types into the dock's free-text control, the way a reader would. */
function typeInto(element: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Lets the registry's deferred focus pick run. */
function settleFocus(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("M14 — the control's state cannot survive a question change", () => {
  it("does not carry the previous question's half-typed draft into the next one", () => {
    // The DRAFT lives in the control's own state, so this is the state that
    // leaked: React reused the same instance across the step change, and the
    // text the reader had typed on the FIRST question was still in the SECOND
    // question's box.
    const mounted = mount(
      formOf([
        multiselectField("first", ["alpha", "beta"]),
        multiselectField("second", ["gamma", "delta"]),
      ]),
    );
    try {
      const { container } = mounted;

      // The reader types into the FIRST question's free-text box, and does not
      // commit it.
      const first = customInput(container);
      expect(first).not.toBeNull();
      typeInto(first as HTMLInputElement, "leaked");

      // They advance to the next question.
      act(() => {
        nextButton(container)?.click();
      });

      // The SECOND question's free-text box is EMPTY.
      const second = customInput(container);
      expect(second).not.toBeNull();
      expect((second as HTMLInputElement).value).toBe("");
    } finally {
      unmount(mounted);
    }
  });

  it("does not append the previous question's text to the next question's answer", () => {
    // The consequence, not the mechanism: `commitDraft` APPENDS the draft to
    // the CURRENT field's answer. So a leaked draft became part of the answer
    // the agent received - the wrong answer, for a question the reader never
    // typed it for.
    //
    // THREE questions, and the Enter lands on the SECOND one. The draft is
    // committed on Enter in the free-text box - that is how a reader adds
    // their own answer to a multiselect - and on a NON-LAST question the
    // Enter advances rather than submits, so the committed value stays in the
    // answer and is sent when the form is finally submitted.
    //
    // (On the LAST question the same Enter would submit with the pre-Enter
    // answer, because `submit` reads the answer from its render closure and
    // `setAnswer` has not re-rendered yet. That is a separate concern; the
    // leak this test is about is the one that reaches the agent.)
    const submitted: unknown[] = [];
    const mounted = mount(
      formOf([
        multiselectField("first", ["alpha", "beta"]),
        multiselectField("second", ["gamma", "delta"]),
        multiselectField("third", ["epsilon"]),
      ]),
      (answer) => {
        submitted.push(answer);
        return Promise.resolve();
      },
    );
    try {
      const { container } = mounted;

      // Type into the FIRST question's free-text box, without committing.
      const first = customInput(container);
      expect(first).not.toBeNull();
      typeInto(first as HTMLInputElement, "leaked");

      // Answer the FIRST question with a listed option, so the form can be
      // submitted: the leak is about the SECOND question's answer, and a form
      // with an unanswered required field never submits at all.
      act(() => {
        optionRows(container)
          .find((option) => option.textContent?.includes("alpha"))
          ?.click();
      });

      // Advance to the SECOND question, and pick a listed option there.
      act(() => {
        nextButton(container)?.click();
      });
      act(() => {
        optionRows(container)
          .find((option) => option.textContent?.includes("gamma"))
          ?.click();
      });

      // Press Enter in the SECOND question's free-text box. The draft the
      // reader typed on the FIRST question must NOT be in that box, so the
      // Enter commits nothing.
      const second = customInput(container);
      expect(second).not.toBeNull();
      act(() => {
        second?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      });

      // The Enter advanced to the THIRD question.
      expect(optionRows(container).some((row) => row.textContent?.includes("epsilon"))).toBe(true);

      // Answer the third question, and submit.
      act(() => {
        optionRows(container)
          .find((option) => option.textContent?.includes("epsilon"))
          ?.click();
      });
      act(() => {
        submitButton(container)?.click();
      });

      // The answer carries the SECOND question's own value and NOTHING from the
      // first question.
      expect(submitted).toHaveLength(1);
      const answer = submitted[0] as Record<string, unknown>;
      expect(answer.second).toEqual(["gamma"]);
      expect(answer.first).toEqual(["alpha"]);
    } finally {
      unmount(mounted);
    }
  });

  it("does not leave the free-text hatch open on the next question", () => {
    // The OTHER state: `otherChosen` says the reader asked for the free-text
    // box. It is per-field state, so it must not survive the step change
    // either - otherwise the next question opens a box the reader never
    // asked for, with the previous question's answer in it.
    const mounted = mount(
      formOf([singleField("first", ["alpha", "beta"]), singleField("second", ["gamma", "delta"])]),
    );
    try {
      const { container } = mounted;

      const other = otherRow(container);
      expect(other).not.toBeNull();
      expect(other?.getAttribute("aria-expanded")).toBe("false");
      act(() => {
        other?.click();
      });
      expect(otherRow(container)?.getAttribute("aria-expanded")).toBe("true");

      act(() => {
        nextButton(container)?.click();
      });

      // The SECOND question's hatch is CLOSED, and it has no free-text box.
      expect(otherRow(container)?.getAttribute("aria-expanded")).toBe("false");
      expect(customInput(container)).toBeNull();
    } finally {
      unmount(mounted);
    }
  });
});

describe("M15 / M16 — a form that cannot be answered says so", () => {
  it("reports a truncated option list, and offers no way to answer it", () => {
    // M15: the option list was sliced to the limit and nothing said, so a
    // required select whose answer was option #120 could never be answered -
    // and the form claimed to be answerable. The projection now reports the
    // truncation, and the dock reports the form as unanswerable.
    const mounted = mount(
      formOf([
        {
          key: "choice",
          type: "string",
          required: true,
          options: Array.from({ length: 200 }, (_unused, index) => ({
            value: `v${index}`,
            label: `Option ${index}`,
          })),
        },
      ]),
    );
    try {
      const { container } = mounted;

      // The reason is on screen, and it is announced as an alert.
      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert?.textContent ?? "").toContain("too many options");

      // And there is no way to answer it: no Next, no Submit. Only Cancel.
      const buttons = [...container.querySelectorAll("button")].map((button) =>
        button.textContent?.trim(),
      );
      expect(buttons).not.toContain("Next");
      expect(buttons).not.toContain("Submit");
      expect(buttons).toContain("Cancel");
    } finally {
      unmount(mounted);
    }
  });

  it("reports an unknown field type, and offers no way to answer it", () => {
    // M16: the catch-all projected EVERY unrecognised type as a multiselect,
    // so the day the server grew a seventh type the renderer would have drawn
    // a picker that cannot work and answered with the wrong shape. Now the
    // type is REPORTED.
    const unknown = {
      key: "future",
      type: "color-picker",
    } as unknown as FormInfo["fields"][number];
    const mounted = mount(formOf([unknown]));
    try {
      const { container } = mounted;

      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert?.textContent ?? "").toContain("color-picker");

      // And it is not presented as answerable.
      const buttons = [...container.querySelectorAll("button")].map((button) =>
        button.textContent?.trim(),
      );
      expect(buttons).not.toContain("Next");
      expect(buttons).not.toContain("Submit");
    } finally {
      unmount(mounted);
    }
  });
});

describe("M18 — the step-change focus move runs", () => {
  it("moves focus to the next step's first control", async () => {
    const mounted = mount(
      formOf([singleField("first", ["alpha", "beta"]), singleField("second", ["gamma", "delta"])]),
    );
    try {
      const { container } = mounted;
      await settleFocus();

      // Advance to the second question.
      act(() => {
        nextButton(container)?.click();
      });

      // The dock's first control of the SECOND question now has focus. Before
      // the fix the focus move was dead code (`dockSeen.current` was only ever
      // set to `false`), so focus stayed on the button the reader had clicked -
      // on the step they had LEFT - and one Enter press there would answer the
      // wrong question.
      const gamma = optionRows(container).find((option) => option.textContent?.includes("gamma"));
      expect(gamma).toBeDefined();
      expect(isFocused(gamma)).toBe(true);
    } finally {
      unmount(mounted);
    }
  });

  it("moves focus on EVERY step change, not only the first", async () => {
    const mounted = mount(
      formOf([singleField("first", ["alpha", "beta"]), singleField("second", ["gamma", "delta"])]),
    );
    try {
      const { container } = mounted;
      await settleFocus();

      // First step change: focus lands on the second question's control.
      act(() => {
        nextButton(container)?.click();
      });
      const gamma = optionRows(container).find((option) => option.textContent?.includes("gamma"));
      expect(isFocused(gamma)).toBe(true);

      // And back again: a one-shot flag would skip this one.
      act(() => {
        backButton(container)?.click();
      });
      const alpha = optionRows(container).find((option) => option.textContent?.includes("alpha"));
      expect(isFocused(alpha)).toBe(true);
    } finally {
      unmount(mounted);
    }
  });

  it("does not move focus on the dock's ARRIVAL, which the registry owns", async () => {
    const mounted = mount(
      formOf([singleField("first", ["alpha", "beta"]), singleField("second", ["gamma", "delta"])]),
    );
    try {
      const { container } = mounted;
      await settleFocus();

      // The registry owns the ARRIVAL: it focuses the dock BODY, which is the
      // element it registered. It never focuses a field's CONTROL - that is
      // the step change's job, and a step change is the reader's own doing.
      const body = dockBody(container);
      expect(body).not.toBeNull();
      expect(isFocused(body)).toBe(true);
      const alpha = optionRows(container).find((option) => option.textContent?.includes("alpha"));
      expect(isFocused(alpha)).toBe(false);

      // And an unrelated re-render - the same field, a new form object - does
      // NOT move focus. The step-change effect keys on the field's KEY, and the
      // key did not change.
      const outside = document.createElement("button");
      document.body.append(outside);
      outside.focus();
      act(() => {
        mounted.root.render(
          <V2FormCard
            form={formOf([
              singleField("first", ["alpha", "beta"]),
              singleField("second", ["gamma", "delta"]),
            ])}
            onSubmit={() => Promise.resolve()}
            onCancel={() => Promise.resolve()}
          />,
        );
      });
      expect(isFocused(outside)).toBe(true);

      outside.remove();
    } finally {
      unmount(mounted);
    }
  });
});
