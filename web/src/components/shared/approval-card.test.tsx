/**
 * The card surface and the card/element SIZE contract.
 *
 * ## What changed
 *
 * Cards lost the hard 1px border in favour of a soft fill plus a very
 * low-contrast ring, driven by two new theme tokens (`--card-soft` /
 * `--card-outline` in `globals.css`). The height and width floors went with it:
 * `min-h-[140px]` off the permission card, `max-w-md` off both vendored
 * elements, `min-h-[8.5rem]` off the terminal body, and padding `p-4` → `p-5`.
 *
 * Each of those was a deliberate decision, and each is a regression waiting to
 * happen: re-adding a `min-h` is invisible in review until someone notices dead
 * space under a one-line result again, and copying one scheme's token value into
 * the other makes light mode silently become dark mode's card.
 *
 * ## Why the shared surface is asserted as ONE value
 *
 * `ApprovalCard` (the open gate) and `CollapsedDecisionRow` (the decided row)
 * share a single private `CARD_SURFACE` const. These cases compare the two
 * RENDERED surfaces to each other rather than asserting one expected string
 * twice — so a future edit that changes one and not the other fails here,
 * instead of passing a per-component check that has quietly drifted apart.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard, CollapsedDecisionRow } from "./approval-card";
import { TerminalBlock } from "../assistant-ui/elements/terminal-block";
import { CodeDiff } from "../assistant-ui/elements/code-diff";
import { stripComments, functionBody, commentedBodyOf } from "@/testing/source-scope";

/**
 * Read every `class` token out of a rendered element, from the first element
 * the component emitted.
 *
 * Tag-scoped on purpose: a whole-markup `toContain("max-w-md")` would be
 * satisfied by ANY descendant, and these components nest. Asserting on the
 * component's own root is what makes "the card lost its width cap" mean the
 * card, not some inner scroll region.
 */
function rootClasses(html: string): string[] {
  const root = /<div\b[^>]*\bclass="([^"]*)"/.exec(html);
  if (root === null) throw new Error("no root element with a class attribute");
  return (root[1] ?? "").split(/\s+/).filter((token) => token.length > 0);
}

/** The surface tokens every card decision state must share. */
const SOFT_FILL = "bg-card-soft";
const SOFT_RING = "ring-1";
const OUTLINE_RING = "ring-card-outline";

const renderApprovalCard = () =>
  renderToStaticMarkup(
    createElement(
      ApprovalCard as unknown as (props: Record<string, unknown>) => ReactElement,
      { title: "shell", children: "body" },
    ),
  );

const renderDecisionRow = () =>
  renderToStaticMarkup(
    createElement(
      CollapsedDecisionRow as unknown as (props: Record<string, unknown>) => ReactElement,
      { title: "shell", badge: createElement("span", null, "Allowed") },
    ),
  );

describe("approval card — the surface both decision states share", () => {
  it("gives the open card and the decided row the SAME surface", () => {
    // The regression this pins: two cards that look different depending on
    // whether they are asking for a decision or already have one. They share one
    // const today; this comparison is what fails if that stops being true, in
    // either direction.
    const open = rootClasses(renderApprovalCard());
    const decided = rootClasses(renderDecisionRow());

    const surfaceOf = (tokens: readonly string[]) =>
      tokens.filter((token) =>
        [SOFT_FILL, SOFT_RING, OUTLINE_RING, "rounded-2xl", "border-border", "bg-card"].includes(
          token,
        ),
      );

    expect(surfaceOf(open)).toEqual(surfaceOf(decided));
    // Non-vacuous: the shared surface is a real, non-empty set of tokens.
    expect(surfaceOf(open).length).toBeGreaterThan(0);
  });

  it("draws the card with a soft fill and a low-contrast ring", () => {
    for (const [name, html] of [
      ["open card", renderApprovalCard()],
      ["decided row", renderDecisionRow()],
    ] as const) {
      const tokens = rootClasses(html);
      expect(tokens, name).toContain(SOFT_FILL);
      expect(tokens, name).toContain(OUTLINE_RING);
    }
  });

  it("uses no hard border and no solid card fill on either state", () => {
    // The replaced treatment. `bg-card` in particular would put an opaque step
    // under the buttons and undo the whole "a few percent off the page" idea.
    for (const [name, html] of [
      ["open card", renderApprovalCard()],
      ["decided row", renderDecisionRow()],
    ] as const) {
      const tokens = rootClasses(html);
      expect(tokens, name).not.toContain("border-border");
      expect(tokens, name).not.toContain("bg-card");
      expect(tokens, name).not.toContain("border");
    }
  });
});

describe("approval card — sizing", () => {
  it("the permission card reserves no minimum height", () => {
    // The removed `min-h-[140px]` held the box steady when the gate swapped to a
    // result, at the cost of ~140px of dead space under a one-line answer. The
    // `max-h-[60vh]` viewport guard is the remaining protection and must stay.
    const tokens = rootClasses(renderApprovalCard());
    expect(tokens.filter((token) => token.startsWith("min-h-"))).toEqual([]);
    expect(tokens).toContain("max-h-[60vh]");
  });

  it("the decided row reserves no minimum height either", () => {
    // Checked separately because the two cards are NOT symmetric: the decided
    // row never had a viewport cap (it is a one-line summary), and asserting it
    // did would be asserting a change nobody made.
    const tokens = rootClasses(renderDecisionRow());
    expect(tokens.filter((token) => token.startsWith("min-h-"))).toEqual([]);
  });

  it("pads with p-5, not the old p-4", () => {
    // The bulk is deliberate: padding should grow with the content instead of
    // reserving space under it.
    const tokens = rootClasses(renderApprovalCard());
    expect(tokens).toContain("p-5");
    expect(tokens).not.toContain("p-4");
  });
});

describe("vendored elements — the width cap is gone", () => {
  const TERMINAL = {
    command: "bun test",
    lines: ["1 pass"],
    visibleCount: 1,
    done: true,
  } as const;

  // `CodeDiff` takes already-parsed lines, not a raw patch string.
  const DIFF = {
    filename: "a.ts",
    additions: 1,
    deletions: 1,
    lines: [
      { kind: "context", text: "a" },
      { kind: "added", text: "b" },
      { kind: "removed", text: "c" },
    ],
    cycle: 0,
  } as const;

  it("the terminal block and the code diff both fill their column", () => {
    // `max-w-md` capped both at 28rem, so the SAME tool call visibly narrowed
    // the moment its permission was decided — the diff and the output were half
    // the width of the card asking about them. `w-full` was already there and
    // the message column is bounded, so removing the cap cannot overflow.
    const terminal = rootClasses(
      renderToStaticMarkup(createElement(TerminalBlock, { ...TERMINAL })),
    );
    const diff = rootClasses(
      renderToStaticMarkup(createElement(CodeDiff, { ...DIFF })),
    );

    for (const [name, tokens] of [
      ["terminal-block", terminal],
      ["code-diff", diff],
    ] as const) {
      expect(tokens, name).not.toContain("max-w-md");
      expect(tokens, name).not.toContain("max-w-lg");
      expect(tokens, name).toContain("w-full");
    }
  });

  it("the terminal body reserves no minimum height either", () => {
    // A one-line result used to reserve 136px. Checked across the component's
    // own markup, not just its root: only the BODY ever had the floor, so a
    // root-only check would pass while the dead space came straight back.
    const html = renderToStaticMarkup(createElement(TerminalBlock, { ...TERMINAL }));
    expect(html.match(/min-h-/g) ?? []).toEqual([]);
  });
});

/**
 * The theme tokens behind the surface.
 *
 * Asserted at the source level because a static render cannot see a CSS custom
 * property: the classes prove the card ASKS for `--card-soft`; only the
 * stylesheet proves the token exists in both schemes and that the two schemes
 * actually differ.
 */
describe("globals.css — the card surface tokens", () => {
  let rootBlock = "";
  let darkBlock = "";

  beforeAll(async () => {
    const source = await Bun.file(
      new URL("../../styles/globals.css", import.meta.url),
    ).text();

    /**
     * The declarations of one top-level scheme block, brace-matched.
     *
     * Read from the raw source rather than parsed, because the assertion is that
     * a token is DECLARED in each block — a cascade lookup would not distinguish
     * "declared in :root" from "inherited from somewhere above".
     */
    function schemeBlock(selector: string): string {
      const at = source.indexOf(`${selector} {`);
      if (at === -1) throw new Error(`${selector} block not found`);
      let depth = 0;
      for (let i = source.indexOf("{", at); i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") {
          depth--;
          if (depth === 0) return source.slice(at, i + 1);
        }
      }
      throw new Error(`${selector} block is unbalanced`);
    }

    rootBlock = schemeBlock(":root");
    darkBlock = schemeBlock(".dark");
  });

  it("declares both tokens in :root and in .dark", () => {
    for (const token of ["--card-soft", "--card-outline"]) {
      expect(rootBlock, `${token} in :root`).toContain(`${token}:`);
      expect(darkBlock, `${token} in .dark`).toContain(`${token}:`);
    }
  });

  it("gives the two schemes DIFFERENT values, so light mode is not a copy of dark", () => {
    /**
     * The value a scheme declares for one token: the text after the colon, up
     * to the terminating semicolon. Comments are stripped first, so a comment
     * mentioning the value cannot satisfy the assertion.
     */
    const valueOf = (block: string, token: string): string => {
      const source = stripComments(block);
      const at = source.indexOf(`${token}:`);
      if (at === -1) throw new Error(`${token} not declared`);
      const end = source.indexOf(";", at);
      return source.slice(at + token.length + 1, end).trim();
    };

    for (const token of ["--card-soft", "--card-outline"]) {
      const light = valueOf(rootBlock, token);
      const dark = valueOf(darkBlock, token);
      expect(light, `${token} in :root`).not.toBe("");
      expect(dark, `${token} in .dark`).not.toBe("");
      // Light steps DOWN from white, dark steps UP from near-black. A copy here
      // would make the light-mode card carry dark mode's weight.
      expect(light, `${token} must differ between schemes`).not.toBe(dark);
    }

    // The soft fill and the ring are DIFFERENT steps of the same family, so the
    // edge reads as a hint rather than a second fill.
    expect(valueOf(rootBlock, "--card-soft")).not.toBe(valueOf(rootBlock, "--card-outline"));
    expect(valueOf(darkBlock, "--card-soft")).not.toBe(valueOf(darkBlock, "--card-outline"));
  });

  it("exposes both tokens to Tailwind, so the classes resolve", async () => {
    // `bg-card-soft` / `ring-card-outline` are generated from these. Without the
    // `@theme` entries the classes render as nothing at all — invisible in a
    // source grep, obvious only in the browser.
    const source = await Bun.file(
      new URL("../../styles/globals.css", import.meta.url),
    ).text();
    expect(source).toContain("--color-card-soft: var(--card-soft);");
    expect(source).toContain("--color-card-outline: var(--card-outline);");
  });
});

/**
 * The shared const is the mechanism, not just the outcome.
 *
 * The comparison above proves the two surfaces MATCH. This proves they match
 * because they are literally one value — so the comparison cannot start passing
 * for the wrong reason (two hand-written copies that happen to agree today).
 */
describe("approval-card.tsx — the surface is one shared const", () => {
  let cardSource = "";
  let surfaceConst = "";
  let openCardBody = "";
  let decisionRowBody = "";

  beforeAll(async () => {
    cardSource = stripComments(
      await Bun.file(new URL("./approval-card.tsx", import.meta.url)).text(),
    );
    openCardBody = functionBody(cardSource, "ApprovalCard");
    decisionRowBody = functionBody(cardSource, "CollapsedDecisionRow");

    const at = cardSource.indexOf("const CARD_SURFACE =");
    if (at === -1) throw new Error("CARD_SURFACE is not declared");
    const end = cardSource.indexOf("\n", at);
    surfaceConst = cardSource.slice(at, end);
  });

  it("declares exactly one surface const, and it is the soft fill plus ring", () => {
    // TOKEN-matched, not substring-matched: `bg-card-soft` CONTAINS the text
    // `bg-card`, so a plain `not.toContain("bg-card")` on the raw const would
    // fail on the very class this design requires. Reading the declared classes
    // out of the string literal as tokens is what makes the assertion true.
    const declared = (surfaceConst.match(/"([^"]*)"/)?.[1] ?? "").split(/\s+/);

    expect(declared).toContain(SOFT_FILL);
    expect(declared).toContain(OUTLINE_RING);
    // The replaced treatment, as exact classes.
    expect(declared).not.toContain("bg-card");
    expect(declared).not.toContain("border-border");
    expect(declared).not.toContain("border");
  });

  it("uses that const in BOTH decision states", () => {
    // Scoped to each component's own body, comments stripped: an import line or
    // a doc comment mentioning the name could not satisfy either.
    expect(openCardBody).toContain("CARD_SURFACE");
    expect(decisionRowBody).toContain("CARD_SURFACE");
    // …and neither re-spells the surface inline instead of using it.
    expect(openCardBody).not.toContain(SOFT_FILL);
    expect(decisionRowBody).not.toContain(SOFT_FILL);
  });
});

/** Unused-import guard: keeps the shared helper's contract visible here. */
describe("source-scope helpers used by this file", () => {
  it("reads a component body out of the real file", async () => {
    const body = await commentedBodyOf(
      "ApprovalCard",
      "./approval-card.tsx",
      import.meta.url,
    );
    expect(body).toContain("CARD_SURFACE");
  });
});
