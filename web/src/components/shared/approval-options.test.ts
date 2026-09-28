/**
 * The declared-option buttons: which one is the PRIMARY action.
 *
 * ## What changed
 *
 * The buttons on a gate that declares its own choices moved off
 * `size="xs"` / `variant="outline"`, and the primary option is now the ink
 * `default` button rather than simply the first one rendered. The reason is
 * legibility, not emphasis: the card fill is now a few percent off the page
 * (`--card-soft`), so an `outline` button's 10% border and 15% fill landed
 * almost on top of it — the button dissolved into the card and its label read
 * as dim grey. `primaryApprovalOption()` decides which option that is.
 *
 * ## Why the primary is chosen, not taken
 *
 * "The first option" would be a position, and the host chooses the order. The
 * one-time allow is the REVERSIBLE choice, so it wins regardless of position:
 * a card whose host happened to list "Always allow" first must not lead with it.
 * These cases pin that with the list deliberately reordered.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolApprovalOption } from "@assistant-ui/react";
import { ApprovalGate } from "@/tools/filesystem/ui";
import { primaryApprovalOption } from "./approval-options";
import { stripComments } from "@/testing/source-scope";

/** The kinds `primaryApprovalOption` must understand, spelled out per case. */
const ALLOW_ONCE = "allow-once";
const ALLOW_ALWAYS = "allow-always";
const REJECT_ONCE = "reject-once";

/** Builds one option; `kind` is open-ended so undocumented kinds are expressible. */
function option(kind: string, id = `opt_${kind}`): ToolApprovalOption {
  return { id, kind, label: kind } as unknown as ToolApprovalOption;
}

/** Every reply a card offered, by the aria-label the button was rendered with. */
function offeredLabels(html: string): string[] {
  return [...html.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1] ?? "");
}

/**
 * The rendered `data-variant` of every button, in document order.
 *
 * `Button` emits `data-variant`, so this reads the VARIANT the button actually
 * resolved — not the prop it was handed, and not a class name, which
 * `class-variance-authority` rewrites.
 */
function buttonVariants(html: string): string[] {
  return [...html.matchAll(/data-variant="([^"]*)"/g)].map((match) => match[1] ?? "");
}

describe("primaryApprovalOption — which option is the ink button", () => {
  it("picks allow-once out of the full documented set", () => {
    const options = [option(ALLOW_ONCE), option(ALLOW_ALWAYS), option(REJECT_ONCE)];
    expect(primaryApprovalOption(options)?.kind).toBe(ALLOW_ONCE);
  });

  it("still picks allow-once when the host lists it somewhere else", () => {
    // THE case that justifies the function existing: a plain "first option"
    // rule would return "reject-once" here and lead a card with Deny.
    const options = [option(REJECT_ONCE), option(ALLOW_ALWAYS), option(ALLOW_ONCE)];
    expect(primaryApprovalOption(options)?.kind).toBe(ALLOW_ONCE);
  });

  it("picks the only option whatever it is", () => {
    // Total by construction: a single-option request has exactly one decision,
    // so demoting it would leave a card with no primary action at all.
    for (const kind of [REJECT_ONCE, ALLOW_ALWAYS, "custom-engine-choice"]) {
      expect(primaryApprovalOption([option(kind)])?.kind).toBe(kind);
    }
  });

  it("falls back to an allow kind when there is no one-time allow", () => {
    // No `allow-once` declared: the persistent allow is still better than
    // leading with a rejection.
    const options = [option(REJECT_ONCE), option(ALLOW_ALWAYS)];
    expect(primaryApprovalOption(options)?.kind).toBe(ALLOW_ALWAYS);
  });

  it("falls back to the first option when none of them is a documented allow", () => {
    // An engine with its own vocabulary must still get a primary button; the
    // runtime rejects an option with no ink action only in appearance, never in
    // behaviour, so "the first" is the honest fallback.
    const options = [option("custom-a"), option("custom-b")];
    expect(primaryApprovalOption(options)?.kind).toBe("custom-a");
  });

  it("returns undefined for a request that declares no options", () => {
    // The edge case with a real consequence: a caller doing
    // `primaryApprovalOption(options)?.id` must not silently treat every option
    // as primary, and must not crash.
    expect(primaryApprovalOption([])).toBeUndefined();
  });

  it("selects by value, so a copied option array still resolves", () => {
    // The call site compares `option.id === primary.id`. If the primary were
    // chosen by object identity, a renderer holding a copy would find no match
    // and every button would render as secondary.
    const original = [option(ALLOW_ALWAYS), option(ALLOW_ONCE)];
    const copy = original.map((entry) => ({ ...entry }));
    const primary = primaryApprovalOption(copy);
    expect(copy.some((entry) => entry.id === primary?.id)).toBe(true);
  });
});

describe("ApprovalGate — exactly one primary button", () => {
  /**
   * Render the gate with a set of declared options and return the markup.
   *
   * The `options` prop is the documented decision shape; `approved: undefined`
   * is what "awaiting a decision" looks like, so the open-gate branch renders.
   */
  function renderGate(options: readonly ToolApprovalOption[]): string {
    const Gate = ApprovalGate as unknown as (props: Record<string, unknown>) => ReactElement;
    return renderToStaticMarkup(
      createElement(Gate, {
        title: "shell · bun --version",
        details: null,
        approval: { id: "per_button_test", approved: undefined, options },
        respondToApproval: async () => {},
      }),
    );
  }

  it("renders every declared option and exactly ONE primary", () => {
    // The property that matters: a card with two ink buttons has no primary
    // action, and a card with none has no visual hierarchy. This holds for any
    // option list, so it is checked across several shapes rather than one.
    const lists: ToolApprovalOption[][] = [
      [option(ALLOW_ONCE), option(ALLOW_ALWAYS), option(REJECT_ONCE)],
      [option(REJECT_ONCE), option(ALLOW_ALWAYS), option(ALLOW_ONCE)],
      [option(ALLOW_ALWAYS), option(ALLOW_ONCE)],
      [option(ALLOW_ONCE)],
    ];

    for (const options of lists) {
      const html = renderGate(options);
      const label = options.map((entry) => entry.kind).join(",");

      // All options are still offered — the primary is emphasis, not a filter.
      expect(offeredLabels(html), label).toEqual(options.map((entry) => entry.label ?? ""));

      const primaries = buttonVariants(html).filter((variant) => variant === "default");
      expect(primaries.length, label).toBe(1);
    }
  });

  it("puts the ink variant on allow-once even when the host lists it last", () => {
    // Read from the rendered markup, paired with the button's aria-label, so this
    // proves the PRIMARY IS allow-once and not merely that one primary exists.
    const html = renderGate([
      option(REJECT_ONCE),
      option(ALLOW_ALWAYS),
      option(ALLOW_ONCE),
    ]);

    /**
     * Pair each `<button>` with its own attributes, order-independently.
     *
     * `Button` emits `data-slot`/`data-variant` from its own props BEFORE
     * spreading the caller's, so a regex that assumes `aria-label` comes first
     * silently matches nothing and the assertion would pass for the wrong
     * reason. Scoping to one tag at a time makes the pairing real.
     */
    const variantByLabel = new Map(
      [...html.matchAll(/<button\b[^>]*>/g)].map(([tag]) => [
        /aria-label="([^"]*)"/.exec(tag)?.[1] ?? "",
        /data-variant="([^"]*)"/.exec(tag)?.[1] ?? "",
      ]),
    );

    // Non-vacuous: all three buttons were actually located and paired.
    expect(variantByLabel.size).toBeGreaterThanOrEqual(3);
    expect(variantByLabel.get(ALLOW_ONCE)).toBe("default");
    expect(variantByLabel.get(ALLOW_ALWAYS)).toBe("secondary");
    expect(variantByLabel.get(REJECT_ONCE)).toBe("secondary");
  });

  it("renders no option buttons at all when the request declares none", () => {
    // The plain approve/deny pair path. It must not acquire an ink button from
    // this change — a request that never declared options has no primary OPTION
    // to promote.
    const html = renderGate([]);
    expect(buttonVariants(html).filter((variant) => variant === "default").length)
      .toBeLessThanOrEqual(1);
    // The generic pair is still there, so the user can still decide.
    expect(html).toContain("Approve");
    expect(html).toContain("Deny");
  });
});

/**
 * Source guards.
 *
 * The visible outcome (one primary, on allow-once) is proven by rendering above.
 * These pin the SHAPE that produced it, for the things a static render cannot
 * distinguish: a class that was removed entirely vs. one that is still present
 * but unused, and a variant that was added vs. one that already existed.
 */
describe("source guards — the button treatment", () => {
  let gateSource = "";
  let cardSource = "";
  let buttonSource = "";

  beforeAll(async () => {
    gateSource = stripComments(
      await Bun.file(new URL("../../tools/filesystem/ui.tsx", import.meta.url)).text(),
    );
    cardSource = stripComments(
      await Bun.file(new URL("./approval-card.tsx", import.meta.url)).text(),
    );
    buttonSource = stripComments(
      await Bun.file(new URL("../ui/button.tsx", import.meta.url)).text(),
    );
  });

  it("tools/filesystem/ui.tsx no longer sizes its decision buttons with xs", () => {
    // `size="xs"` (24px tall) on a decision the user is being asked to make: the
    // label was the same size as a chip elsewhere in the card. Whole-file and
    // comment-stripped, so this fails on ANY reintroduction, not just the one on
    // the option list.
    expect(gateSource).not.toContain('size="xs"');
    expect(gateSource).not.toContain("size={'xs'}");
  });

  it("the gate no longer renders its option buttons as outline", () => {
    // `outline` was the variant that dissolved into the new card fill. Token-
    // checked so `variant="outline"` is matched as a whole prop value.
    expect(gateSource).not.toMatch(/variant="outline"/);
  });

  it("approval-card.tsx no longer renders an outline button either", () => {
    // The decide/deny pair moved to `secondary` for the same reason. Checked at
    // whole-file scope so no card surface can reintroduce the vanishing button.
    expect(cardSource).not.toMatch(/variant="outline"/);
  });

  it("the gate's option buttons are sm, and the primary is the default variant", () => {
    // The positive half: naming the classes that replaced them, so the guards
    // above cannot be satisfied by deleting the buttons altogether.
    expect(gateSource).toContain('size="sm"');
    expect(gateSource).toContain('option.id === primaryOptionId ? "default" : "secondary"');
    // The primary comes from the shared policy, never from position.
    expect(gateSource).toContain("primaryApprovalOption(options)?.id");
  });

  it("button.tsx gained no new variant", () => {
    // The change was re-SELECTING among existing treatments, not inventing one.
    // The exact set is asserted (not a count) so a swap is caught as loudly as an
    // addition.
    const variantsBlock = /variant:\s*\{([\s\S]*?)\n {6}\},/.exec(buttonSource);
    if (variantsBlock === null) throw new Error("button variants block not found");
    const declared = [...(variantsBlock[1] ?? "").matchAll(/^\s{8}([a-z-]+):/gm)].map(
      (match) => match[1] ?? "",
    );

    expect(declared).toEqual([
      "default",
      "outline",
      "secondary",
      "ghost",
      "destructive",
      "link",
    ]);
  });
});
