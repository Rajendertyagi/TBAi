import { describe, expect, it } from "bun:test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { stripComments } from "@/testing/source-scope";

/**
 * The two-`ApprovalCard` trap.
 *
 * There are two components called `ApprovalCard` in this app: the vendored
 * upstream element in `elements/`, and the app-owned card in `shared/` that
 * every gate actually renders. Nothing imports the vendored one. That is a
 * deliberate state, documented in each file, and this suite is what keeps it
 * deliberate rather than accidental.
 *
 * The failure this prevents is silent and expensive. A reader — or an agent —
 * greps for `ApprovalCard`, finds two files, and picks one. If they pick the
 * vendored element they get a card with none of the decisions the app made: no
 * theme-token border, no `p-5` bulk, the wrong button variant for this surface,
 * and no `CARD_SURFACE` sharing, so the OpenCode question dock and the tool gate
 * slowly drift apart. Nothing fails. The drift is only visible by eye, in
 * screenshots, months later.
 */

/** This file sits at `src/components/assistant-ui/elements/`. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ELEMENTS = path.join(HERE, "approval-card.tsx");
const SHARED = path.join(HERE, "..", "..", "shared", "approval-card.tsx");
const TOOL_FALLBACK = path.join(HERE, "tool-fallback.tsx");
const SRC = path.join(HERE, "..", "..", "..");

/** Every source file under `src`, so an import of either card can be found. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

describe("the vendored approval card is reference, not the one in use", () => {
  it("says so in its own header, and names the successor", () => {
    const header = stripComments(fs.readFileSync(ELEMENTS, "utf8"));
    // The header is stripped, so the claim is proved by the *code* around it:
    // this element is exported and used by nothing, while the shared one is
    // imported by the two surfaces that render gates. Asserting on the
    // unstripped file would let the prose satisfy its own rule.
    expect(header).toContain("export function ApprovalCard");

    const comment = fs.readFileSync(ELEMENTS, "utf8");
    expect(comment).toMatch(/CURRENTLY UNUSED/);
    expect(comment).toMatch(/components\/shared\/approval-card\.tsx/);
  });

  it("is imported by no module in the app", () => {
    const importers: string[] = [];
    for (const file of sourceFiles()) {
      if (file === ELEMENTS) continue;
      const text = fs.readFileSync(file, "utf8");
      if (/from\s+["'][^"']*elements\/approval-card["']/.test(text)) {
        importers.push(path.relative(SRC, file));
      }
    }
    // If this ever fails, a real caller appeared — and then the two cards are
    // both live, which is the ambiguity this suite exists to prevent. Resolve it
    // deliberately rather than by deleting whichever import is easier.
    expect(importers).toEqual([]);
  });

  it("is not what the MCP tool fallback renders", () => {
    // The fallback is the card most likely to be reached for by someone wiring a
    // new tool, and its docblock mentions this file — so it is checked by name
    // rather than left to the import scan.
    const text = fs.readFileSync(TOOL_FALLBACK, "utf8");
    const imports = text.match(/from\s+["'][^"']*approval-card["']/g) ?? [];
    expect(imports.length).toBe(1);
    expect(imports[0]).toContain("shared/approval-card");
  });

  it("leaves the shared card as the single exported name", () => {
    const shared = fs.readFileSync(SHARED, "utf8");
    expect(shared).toContain("export function ApprovalCard");
    // The surface both decision states share, which is the reason the app-owned
    // card exists at all rather than being a fork of the element.
    expect(shared).toContain("export const CARD_SURFACE");
  });
});
