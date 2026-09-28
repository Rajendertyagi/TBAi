import { describe, expect, it } from "bun:test";
import { canCopySelection, readPageSelection } from "./page-selection";

/**
 * Selection capture for the page right-click menu.
 *
 * The behaviour that matters is decided at menu-open time and then held
 * constant: a Radix menu takes focus as it opens, collapsing the browser
 * selection, so anything read later is empty. These tests pin the two rules
 * that follow from that — what counts as selected, and that the captured text
 * (not a live re-read) is what gets copied.
 */

/** Minimal `Selection` stand-in; only `toString()` is consulted. */
function selectionReturning(text: string): Selection {
  return { toString: () => text } as unknown as Selection;
}

describe("readPageSelection", () => {
  it("returns the selected text", () => {
    expect(readPageSelection(selectionReturning("hello world"))).toBe("hello world");
  });

  it("returns an empty string for a collapsed selection", () => {
    // A right-click that places a caret without highlighting anything: this is
    // the "no selection" case that disables Copy.
    expect(readPageSelection(selectionReturning(""))).toBe("");
  });

  it("returns an empty string for a null selection", () => {
    // Some environments expose no Selection at all; this must not throw.
    expect(readPageSelection(null)).toBe("");
  });

  it("normalises a whitespace-only selection to empty", () => {
    // Dragging across a gap between two words selects whitespace. Presenting a
    // Copy action here would appear to do nothing useful.
    expect(readPageSelection(selectionReturning("   \n\t "))).toBe("");
  });

  it("preserves the text exactly, including inner whitespace", () => {
    // Non-vacuity: only the *decision* is trimmed, never the copied text, so
    // indentation and line breaks in a pasted code block survive.
    const selected = "  const a = 1;\n\n  return a;  ";
    expect(readPageSelection(selectionReturning(selected))).toBe(selected);
  });

  it("preserves a multi-line selection verbatim", () => {
    const selected = "line one\nline two\n\nline four";
    expect(readPageSelection(selectionReturning(selected))).toBe(selected);
  });

  it("returns a value that is independent of later selection changes", () => {
    // The capture is a string, so focus moving and the selection collapsing
    // afterwards cannot change what was captured.
    let live = selectionReturning("captured text");
    const captured = readPageSelection(live);
    live = selectionReturning("");
    expect(captured).toBe("captured text");
    expect(readPageSelection(live)).toBe("");
    expect(captured).toBe("captured text");
  });
});

describe("canCopySelection", () => {
  it("allows copying when text was captured", () => {
    expect(canCopySelection("some selected text")).toBe(true);
  });

  it("disallows copying when nothing was captured", () => {
    expect(canCopySelection("")).toBe(false);
  });

  it("disallows copying a whitespace-only capture", () => {
    expect(canCopySelection("  \n ")).toBe(false);
  });

  it("agrees with readPageSelection about what is copyable", () => {
    // The two are used together (capture, then enable), so they must not
    // disagree about the same text.
    for (const text of ["", "   ", "a", "hello", "\n\ttext  "]) {
      const captured = readPageSelection(selectionReturning(text));
      expect(canCopySelection(captured)).toBe(canCopySelection(text));
    }
  });
});
