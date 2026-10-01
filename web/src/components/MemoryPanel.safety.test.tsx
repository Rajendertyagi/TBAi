/**
 * Phase 5 Part 4 — the MemoryPanel's derived-safety display.
 *
 * ## Why the display logic is tested as a function
 *
 * The repo has no DOM test runner. `renderToStaticMarkup` reads zustand's SERVER
 * snapshot (`getInitialState`), not `getState()`, so a component test cannot
 * populate the store and then assert on what the populated component renders —
 * verified directly: the store holds the memory and the markup does not contain
 * it. `stalePermissionsStore.test.ts` documents the same limitation and
 * deliberately avoids render-based store testing.
 *
 * So the sentence the user sees is pinned as a pure function, the store-independent
 * shell is pinned by rendering it, and the wiring between them is asserted
 * structurally. Saying so plainly is better than a test that appears to cover the
 * panel and does not.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { MemoryPanel, memoryStatusLine } from "./MemoryPanel";

describe("22. derived safety status wording", () => {
  it.each([
    ["instruction_displacement", "tries to override instructions"],
    ["turn_structure", "looks like it is trying to fake a speaker"],
    ["credential_request", "asks for credentials or secrets"],
    ["secret_material", "looks like it contains a credential"],
  ])("explains %s in plain language", (token, prose) => {
    const line = memoryStatusLine({ safetyFlag: true, safetyReason: token });
    expect(line).toContain("Not sent to the model");
    expect(line).toContain(prose);
    // Both halves of the truth: withheld from the model, still the user's to fix.
    expect(line).toContain("You can edit or delete it");
  });

  it("returns nothing for a memory that screened clean", () => {
    expect(memoryStatusLine({})).toBeNull();
    expect(memoryStatusLine({ safetyReason: "instruction_displacement" })).toBeNull();
  });

  it("degrades gracefully for a reason token this build does not know", () => {
    const line = memoryStatusLine({ safetyFlag: true, safetyReason: "a_class_from_a_future_build" });
    expect(line).toContain("Not sent to the model");
    expect(line).toContain("did not pass a safety check");
  });

  it("never leaks the raw token into user-facing copy", () => {
    const line = memoryStatusLine({ safetyFlag: true, safetyReason: "instruction_displacement" });
    expect(line).not.toContain("instruction_displacement");
  });
});

describe("the panel wires the status into the existing memory row", () => {
  const source = readFileSync(new URL("./MemoryPanel.tsx", import.meta.url), "utf8");

  it("renders memoryStatusLine inside the memory list", () => {
    expect(source).toContain("memoryStatusLine(memory)");
  });

  it("keeps the existing panel surface — no new route, dialog, or primitive", () => {
    // The panel is still the same component rendering the same settings grammar.
    expect(source).toContain('title="Memory"');
    expect(source).toContain("SettingsPage");
    expect(source).toContain('title="Saved memories"');
    // No navigation, no dialog primitives, no new shared component was added.
    expect(source).not.toMatch(/useNavigate|Dialog|Sheet|Modal/);
  });

  it("offers edit and delete for every memory row", () => {
    expect(source).toContain('aria-label="Edit memory"');
    expect(source).toContain('aria-label="Delete memory"');
    expect(source).toContain("updateMemory(");
  });

  it("does not re-implement the screen: no pattern is evaluated in the browser", () => {
    // A token→prose table is fine (it is a label, not a decision). Constructing or
    // running a matcher is not — the backend owns the verdict.
    expect(source).not.toMatch(/new RegExp|\.test\(|\.match\(|\.search\(|\.exec\(/);
  });
});

describe("store-independent render", () => {
  it("renders the existing panel shell and empty state", () => {
    const markup = renderToStaticMarkup(React.createElement(MemoryPanel));
    expect(markup).toContain("Memory");
    expect(markup).toContain("Store important information that persists across conversations.");
    expect(markup).toContain("No memories yet.");
    expect(markup).toContain("Add a memory");
    // The add affordance still exists.
    expect(markup).toContain("Add");
  });
});