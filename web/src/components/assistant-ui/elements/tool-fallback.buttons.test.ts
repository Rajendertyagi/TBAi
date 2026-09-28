import { describe, it, expect, beforeAll } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolApprovalOption } from "@assistant-ui/react";
import { ToolFallbackApproval } from "./tool-fallback";
import { toolsConfig } from "@/config/tools";
import { functionBody, stripComments } from "@/testing/source-scope";

/**
 * The fallback approval card's buttons, brought in line with the shared
 * approval vocabulary.
 *
 * ## What changed
 *
 * This is the card an MCP tool (or any tool with no registered renderer) lands
 * on, so it sits directly beside the rich `ApprovalGate`. An earlier pass
 * restyled both the card and the gate's buttons; this element kept upstream's
 * `variant="outline"` for everything that was not the primary, and picked its
 * primary by position (`option === allowOptions[0]`). Two things were wrong:
 *
 *   1. **Look.** The card fill is a few percent off the page
 *      (`--card-soft`), so an outline button's 10% border and 15% fill land
 *      almost on top of it — the button dissolves into the card and its label
 *      reads as dim grey. `secondary` is a solid step away from the fill, and
 *      the primary keeps the ink `default`.
 *   2. **Which one is primary.** `approval-options.ts` exists so that choice is
 *      defined ONCE. Upstream's positional rule restates it — and gets it wrong
 *      when the host lists `allow-always` before `allow-once`, leading a card
 *      with the persistent grant. `primaryApprovalOption` is the one definition,
 *      so this element calls it rather than repeating it.
 *
 * No new Button variant, no literal colour, no inline `style`: the change
 * re-SELECTS among treatments that already exist. That is asserted below.
 */
const ALLOW_ONCE = "allow-once";
const ALLOW_ALWAYS = "allow-always";
const REJECT_ONCE = "reject-once";

/** One option; `kind` is open-ended so undocumented kinds stay expressible. */
function option(kind: string, id = `opt_${kind}`): ToolApprovalOption {
  return { id, kind, label: kind } as unknown as ToolApprovalOption;
}

/**
 * Pair every rendered `<button>` with its own variant, by visible label.
 *
 * The whole element (open tag AND children) is matched, because the variant
 * lives on the open tag and the label in the children. Scoped to one element
 * at a time: `Button` emits `data-slot`/`data-variant` from its own props
 * BEFORE spreading the caller's, so a regex that assumed a given attribute
 * came first would silently match nothing and the assertion would pass for
 * the wrong reason.
 */
function variantByLabel(html: string): Map<string, string> {
  return new Map(
    [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(
      ([, attrs, children]) => [
        (children ?? "").replace(/<[^>]*>/g, "").trim(),
        /data-variant="([^"]*)"/.exec(attrs ?? "")?.[1] ?? "",
      ],
    ),
  );
}

/** Every rendered `data-variant`, in document order. */
function buttonVariants(html: string): string[] {
  return [...html.matchAll(/data-variant="([^"]*)"/g)].map((m) => m[1] ?? "");
}

/**
 * Render the fallback's approval surface with a set of declared options.
 *
 * `approved: undefined` is what "awaiting a decision" looks like, so the
 * declared-options branch is the one that runs. `ToolFallbackApproval` is
 * prop-only apart from `useStaleApprovalGuard`, which is a store read that
 * stays in its idle state without a provider.
 */
function renderApproval(
  options: readonly ToolApprovalOption[],
  approval: Record<string, unknown> = {},
): string {
  const Approval = ToolFallbackApproval as unknown as (props: Record<string, unknown>) => ReactElement;
  return renderToStaticMarkup(
    createElement(Approval, {
      title: "mcp_tool · some_arg",
      approval: { id: "per_fallback_test", options, ...approval },
      respondToApproval: async () => {},
      status: { type: "requires-action", reason: "interrupt" },
    }),
  );
}

describe("tool-fallback — the option buttons match the shared approval treatment", () => {
  it("gives the primary option the ink variant and every other option a solid one", () => {
    // `Allow` is the primary, `Always allow` and `Deny` sit beside it as
    // `secondary`. `outline` is what the guard below forbids.
    const html = renderApproval([
      option(ALLOW_ONCE),
      option(ALLOW_ALWAYS),
      option(REJECT_ONCE),
    ]);
    const byLabel = variantByLabel(html);

    expect(byLabel.size).toBeGreaterThanOrEqual(3);
    expect(byLabel.get(ALLOW_ONCE)).toBe("default");
    expect(byLabel.get(ALLOW_ALWAYS)).toBe("secondary");
    expect(byLabel.get(REJECT_ONCE)).toBe("secondary");
  });

  it("renders exactly ONE ink button for any option list", () => {
    // Two ink buttons means no primary action; none means no hierarchy. Held
    // across several shapes, including the ones below that used to go wrong.
    const lists: ToolApprovalOption[][] = [
      [option(ALLOW_ONCE), option(ALLOW_ALWAYS), option(REJECT_ONCE)],
      [option(REJECT_ONCE), option(ALLOW_ALWAYS), option(ALLOW_ONCE)],
      [option(ALLOW_ALWAYS), option(ALLOW_ONCE)],
      [option(ALLOW_ONCE)],
      [option("custom-engine-choice")],
    ];
    for (const options of lists) {
      const html = renderApproval(options);
      const primaries = buttonVariants(html).filter((v) => v === "default");
      expect(primaries.length, options.map((o) => o.kind).join(",")).toBe(1);
    }
  });

  it("puts the ink variant on allow-once even when the host lists it last", () => {
    // THE case that justifies reusing `primaryApprovalOption` rather than
    // upstream's "first allow option": with the list reordered, a positional
    // rule returns `ALLOW_ALWAYS` here and leads a card with the persistent
    // grant instead of the reversible one.
    const html = renderApproval([
      option(REJECT_ONCE),
      option(ALLOW_ALWAYS),
      option(ALLOW_ONCE),
    ]);
    const byLabel = variantByLabel(html);

    expect(byLabel.get(ALLOW_ONCE)).toBe("default");
    expect(byLabel.get(ALLOW_ALWAYS)).toBe("secondary");
    expect(byLabel.get(REJECT_ONCE)).toBe("secondary");
  });

  it("still offers every declared option — the primary is emphasis, not a filter", () => {
    const options = [option(ALLOW_ONCE), option(ALLOW_ALWAYS), option(REJECT_ONCE)];
    const html = renderApproval(options);
    for (const entry of options) {
      expect(html).toContain(`>${entry.label}</button>`);
    }
  });

  it("gives the synthesised Deny the same solid treatment", () => {
    // Drawn only when the request declares no reject option, so this list has
    // none. It used to be `outline` and vanished into the card fill.
    const html = renderApproval([option(ALLOW_ONCE), option(ALLOW_ALWAYS)]);
    const byLabel = variantByLabel(html);

    expect(html).toContain("Deny");
    expect(byLabel.get("Deny")).toBe("secondary");
  });
});

/**
 * Source guards.
 *
 * For the things a static render cannot distinguish: a class removed entirely
 * vs. one still present but unused, and a variant added vs. one that already
 * existed. Comments are stripped so prose describing the rule cannot satisfy a
 * test for the rule.
 */
describe("source guards — no new treatment, no leftover outline", () => {
  let fallbackSource = "";
  let buttonSource = "";

  beforeAll(async () => {
    fallbackSource = stripComments(
      await Bun.file(new URL("./tool-fallback.tsx", import.meta.url)).text(),
    );
    buttonSource = stripComments(
      await Bun.file(new URL("../../ui/button.tsx", import.meta.url)).text(),
    );
  });

  it("renders no outline button anywhere in the element", () => {
    // Token-checked so `variant="outline"` matches as a whole prop value.
    // Whole-file scope, so no button in this card can reintroduce it.
    expect(fallbackSource).not.toMatch(/variant="outline"/);
  });

  it("keeps the decision buttons at sm, with the primary as the default variant", () => {
    // The positive half, so the guard above cannot be satisfied by deleting
    // the buttons. `size="sm"` is unchanged from upstream; the VARIANT is what
    // moved, so that is what is pinned.
    expect(fallbackSource).toContain('size="sm"');
    expect(fallbackSource).toContain(
      'variant={option.id === primaryOptionId ? "default" : "secondary"}',
    );
  });

  it("takes the primary from the shared policy rather than restating it", () => {
    expect(fallbackSource).toContain("primaryApprovalOption(declaredOptions)?.id");
    // The positional rule this replaced. It duplicated the shared decision
    // AND disagreed with it whenever the host's order differed.
    expect(fallbackSource).not.toContain("option === allowOptions[0]");
  });

  it("adds no new Button variant", () => {
    // The exact SET is asserted, not a count, so a swap is caught as loudly as
    // an addition. Same expectation the shared `approval-options` guard uses.
    const variantsBlock = /variant:\s*\{([\s\S]*?)\n {6}\},/.exec(buttonSource);
    if (variantsBlock === null) throw new Error("button variants block not found");
    const declared = [...(variantsBlock[1] ?? "").matchAll(/^\s{8}([a-z-]+):/gm)].map(
      (m) => m[1] ?? "",
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

  it("adds no literal colour and no inline style to the card's buttons", () => {
    // The visual change had to be re-selecting among existing treatments, not
    // painting a new one. `secondary` is a variant; a hex or an `rgba(` here
    // would be a colour this file invented.
    const body = functionBody(fallbackSource, "ToolFallbackApproval");
    expect(body.length).toBeGreaterThan(0); // non-vacuity: the body was located
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(body).not.toMatch(/rgba?\(/);
    expect(body).not.toMatch(/style=\{\{/);
  });

  it("keeps the copy this card shows in the shared config", () => {
    // The buttons' LABELS come from the shared option vocabulary, not from
    // literals here — the reason the same request cannot be worded two ways on
    // two surfaces. Pinned so a literal label cannot creep back in.
    expect(fallbackSource).toContain("approvalOptionLabel(option)");
    expect(toolsConfig.copy.status.noOutput).toBe("No output.");
  });
});
