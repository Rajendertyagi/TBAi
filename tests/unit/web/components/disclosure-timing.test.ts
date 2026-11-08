import { describe, it, expect, beforeAll } from "bun:test";
import path from "node:path";
import { REPO_ROOT } from "../../../helpers/repo-root";
import { stripComments } from "@web/testing/source-scope";
import { DISCLOSURE_ANIMATION_DURATION_MS } from "@web/components/shared/disclosure-timing";

/**
 * The disclosure collapse/expand duration has two halves that CANNOT be one
 * literal: the stylesheet's `aui-disclosure-timing` utility defines the
 * `--animation-duration` custom property that every `duration-(--animation-
 * duration)` utility reads, and `components/shared/disclosure-timing.ts` holds
 * the same number as a JS argument for `useScrollLock`.
 *
 * Before this pair existed the literal `200` appeared in FOUR places: an
 * `ANIMATION_DURATION = 200` constant in each of the three element files, plus
 * the stylesheet's `--animation-duration`. Each element ALSO restated it through
 * an inline `style` prop, but those interpolated their own file's constant and so
 * never held the literal themselves — they were specification sites, not copies.
 * An earlier version of this comment said "six", repeating the stylesheet's
 * wording without recounting it. These guards make the remaining two halves
 * impossible to drift apart silently, which is what the earlier comment-only
 * "keep them in step" could not do.
 */
const ELEMENT_FILES = [
  "web/src/components/assistant-ui/elements/reasoning.tsx",
  "web/src/components/assistant-ui/elements/tool-group.tsx",
  "web/src/components/assistant-ui/elements/tool-fallback.tsx",
] as const;

const STYLESHEET = "web/src/styles/globals.css";

let css: string;
const sources = new Map<string, string>();

/** The value in ms declared by the `aui-disclosure-timing` utility body. */
function cssDurationMs(source: string): number | null {
  const body = /@utility\s+aui-disclosure-timing\s*\{([\s\S]*?)\}/.exec(source);
  if (body === null) return null;
  const value = /--animation-duration:\s*(\d+(?:\.\d+)?)ms\s*;/.exec(body[1] ?? "");
  if (value === null) return null;
  return Number(value[1]);
}

beforeAll(async () => {
  css = await Bun.file(path.join(REPO_ROOT, STYLESHEET)).text();
  for (const file of ELEMENT_FILES) {
    sources.set(file, await Bun.file(path.join(REPO_ROOT, file)).text());
  }
});

describe("the disclosure duration has one owner on each side", () => {
  it("declares the stylesheet half exactly once", () => {
    // Non-vacuity: the utility must exist, or the next assertion would compare
    // two undefined things and pass.
    expect(css).toContain("@utility aui-disclosure-timing");
    const occurrences = css.match(/@utility\s+aui-disclosure-timing\b/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("keeps the CSS half equal to the JS half", () => {
    const fromCss = cssDurationMs(css);
    expect(fromCss).not.toBeNull();
    expect(fromCss).toBe(DISCLOSURE_ANIMATION_DURATION_MS);
  });

  // `it.each` is avoided here deliberately: bun's overloads for a flat string
  // array are typed as tuples, and a plain loop keeps the parameter a string
  // without a cast.
  for (const file of ELEMENT_FILES) {
    it(`${file} takes the timing from the class, not an inline style`, () => {
      const source = sources.get(file);
      if (source === undefined) throw new Error(`source not loaded: ${file}`);
      const code = stripComments(source);
      // The invariant is that nothing here SETS the variable. Reading it is the
      // whole point of these elements - `duration-(--animation-duration)` and
      // `var(--animation-duration)` appear many times and must keep working - so
      // the guard matches an object key, never the bare property name.
      expect(code).not.toMatch(/--animation-duration\s*:/);
      expect(code).toContain("aui-disclosure-timing");
    });

    it(`${file} reads the JS half from the shared constant`, () => {
      const source = sources.get(file);
      if (source === undefined) throw new Error(`source not loaded: ${file}`);
      const code = stripComments(source);
      // No element may re-declare the literal: a fourth copy is exactly what
      // this module exists to prevent.
      expect(code).not.toMatch(/ANIMATION_DURATION\s*=\s*\d/);
      expect(code).toContain("DISCLOSURE_ANIMATION_DURATION_MS");
    });
  }

  it("keeps reasoning's re-export as an alias, not a second value", () => {
    // `reasoning.tsx` re-exports the name its sibling `reasoning.aui.tsx`
    // imports. The re-export must carry no number of its own.
    const reasoning = sources.get(ELEMENT_FILES[0]);
    if (reasoning === undefined) throw new Error(`source not loaded: ${ELEMENT_FILES[0]}`);
    expect(stripComments(reasoning)).toMatch(
      /export const ANIMATION_DURATION\s*=\s*DISCLOSURE_ANIMATION_DURATION_MS/,
    );
  });
});
