import { describe, expect, it } from "bun:test";
import {
  FORM_DOCK_BOUNDARY_GAP_PX,
  FORM_DOCK_CHROME_PX,
  FORM_DOCK_MIN_HEIGHT_PX,
  FORM_DOCK_NORMAL_MAX_HEIGHT_PX,
  formDockAvailablePx,
  formDockBodyMaxHeight,
  formDockMeasuredMaxHeight,
} from "./formDockSizing";

/**
 * The dock body's height cap — the three steps the reference client uses.
 *
 * Pure arithmetic, so it is pinned here rather than by resizing a real window.
 * The four numbers are load-bearing: the boundary gap, the 320px comparison, the
 * 120px floor, and the 96px chrome allowance. A silent change to any of them
 * would be invisible in review and would show up only as a header pushed off
 * screen.
 */

describe("step 1 · formDockAvailablePx", () => {
  it("measures from the body's anchor up to the boundary, less the gap", () => {
    expect(formDockAvailablePx(900, 100)).toBe(900 - 100 - FORM_DOCK_BOUNDARY_GAP_PX);
  });

  it("never reports negative room", () => {
    // The anchor can sit above the boundary during a keyboard pan.
    expect(formDockAvailablePx(100, 900)).toBe(0);
  });

  it("rounds down, so a fractional measurement cannot overstate the room", () => {
    expect(formDockAvailablePx(500.9, 100)).toBe(392);
  });
});

describe("step 2 · formDockMeasuredMaxHeight", () => {
  it("leaves the CSS cap alone when there is room for it", () => {
    // undefined is what keeps the normal case on `max-h-1/2`, which tracks the
    // viewport without a pixel value being pinned to it.
    expect(formDockMeasuredMaxHeight(FORM_DOCK_NORMAL_MAX_HEIGHT_PX)).toBeUndefined();
    expect(formDockMeasuredMaxHeight(FORM_DOCK_NORMAL_MAX_HEIGHT_PX + 400)).toBeUndefined();
  });

  it("caps to the measured space when the CSS cap would not fit", () => {
    expect(formDockMeasuredMaxHeight(240)).toBe(240);
    expect(formDockMeasuredMaxHeight(FORM_DOCK_NORMAL_MAX_HEIGHT_PX - 1)).toBe(
      FORM_DOCK_NORMAL_MAX_HEIGHT_PX - 1,
    );
  });

  it("never collapses the body, however little room is measured", () => {
    expect(formDockMeasuredMaxHeight(0)).toBe(FORM_DOCK_MIN_HEIGHT_PX);
    expect(formDockMeasuredMaxHeight(40)).toBe(FORM_DOCK_MIN_HEIGHT_PX);
  });

  it("falls back to CSS for a measurement that is not a usable number", () => {
    // An inline `max-height: NaN` is dropped by the browser, which would
    // silently uncap the body.
    expect(formDockMeasuredMaxHeight(Number.NaN)).toBeUndefined();
    expect(formDockMeasuredMaxHeight(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("step 3 · formDockBodyMaxHeight", () => {
  it("passes undefined straight through, so CSS keeps deciding", () => {
    expect(formDockBodyMaxHeight(undefined)).toBeUndefined();
  });

  it("subtracts the chrome the body does not own", () => {
    // Without this the title and the step dots get pushed off the top of the
    // screen by a long option list — the exact failure the cap exists to stop.
    expect(formDockBodyMaxHeight(300)).toBe(300 - FORM_DOCK_CHROME_PX);
  });

  it("re-applies the floor, because chrome can eat a small room entirely", () => {
    expect(formDockBodyMaxHeight(FORM_DOCK_MIN_HEIGHT_PX)).toBe(FORM_DOCK_MIN_HEIGHT_PX);
    expect(formDockBodyMaxHeight(140)).toBe(FORM_DOCK_MIN_HEIGHT_PX);
  });

  it("ends up no taller than the room it was measured from", () => {
    // A cap larger than the available room would be a lie to the layout engine.
    for (const room of [150, 200, 260, 319]) {
      expect(formDockBodyMaxHeight(room) ?? 0).toBeLessThanOrEqual(room);
    }
  });
});

describe("the three steps together", () => {
  it("leaves a tall question entirely to the CSS cap", () => {
    const available = formDockAvailablePx(900, 100);
    expect(formDockBodyMaxHeight(formDockMeasuredMaxHeight(available))).toBeUndefined();
  });

  it("engages only for a short question, and never below the floor", () => {
    const available = formDockAvailablePx(300, 100); // 192px of room
    const cap = formDockBodyMaxHeight(formDockMeasuredMaxHeight(available));
    expect(cap).toBe(FORM_DOCK_MIN_HEIGHT_PX);
  });

  it("grows with the room, so a small question is not padded to a fixed height", () => {
    // This is the behaviour the open question was really about: two options in a
    // tall window want a short card, and the cap must not make it look full.
    const small = formDockBodyMaxHeight(formDockMeasuredMaxHeight(260));
    const large = formDockBodyMaxHeight(formDockMeasuredMaxHeight(318));
    expect(small).toBeLessThan(large ?? 0);
  });
});
