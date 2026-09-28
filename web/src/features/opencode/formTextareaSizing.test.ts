import { describe, expect, it } from "bun:test";
import {
  FORM_TEXTAREA_LINE_HEIGHT_PX,
  FORM_TEXTAREA_MAX_HEIGHT_PX,
  FORM_TEXTAREA_MIN_LINES,
  FORM_TEXTAREA_MAX_LINES,
  formTextareaHeight,
  formTextareaOverflows,
} from "./formTextareaSizing";

/**
 * The growth rule for a free-text answer.
 *
 * Pure arithmetic, so it is pinned here rather than by opening a browser: the
 * bounds are what stop a long answer from pushing the dock off screen, and a
 * silent change to either bound would be invisible in review.
 */

describe("formTextareaHeight", () => {
  it("never collapses below the minimum, whatever the content", () => {
    const min = FORM_TEXTAREA_LINE_HEIGHT_PX * FORM_TEXTAREA_MIN_LINES;
    expect(formTextareaHeight(0)).toBe(min);
    expect(formTextareaHeight(1)).toBe(min);
    expect(formTextareaHeight(min)).toBe(min);
  });

  it("grows with the content between the bounds", () => {
    const threeLines = FORM_TEXTAREA_LINE_HEIGHT_PX * 3;
    expect(formTextareaHeight(threeLines)).toBe(threeLines);
  });

  it("never exceeds the cap, however long the answer gets", () => {
    expect(formTextareaHeight(FORM_TEXTAREA_MAX_HEIGHT_PX)).toBe(FORM_TEXTAREA_MAX_HEIGHT_PX);
    expect(formTextareaHeight(FORM_TEXTAREA_MAX_HEIGHT_PX * 10)).toBe(FORM_TEXTAREA_MAX_HEIGHT_PX);
  });

  it("rounds a fractional measurement up, so a clipped last line is avoided", () => {
    expect(formTextareaHeight(60.2)).toBe(61);
  });

  it("falls back to the minimum for a measurement that is not a number", () => {
    // `scrollHeight` is an integer, but the rule must not produce NaN if it
    // ever is not — a NaN height collapses the box to nothing.
    const min = FORM_TEXTAREA_LINE_HEIGHT_PX * FORM_TEXTAREA_MIN_LINES;
    expect(formTextareaHeight(Number.NaN)).toBe(min);
    expect(formTextareaHeight(Number.POSITIVE_INFINITY)).toBe(FORM_TEXTAREA_MAX_HEIGHT_PX);
  });
});

describe("formTextareaOverflows", () => {
  it("is true only once the cap is reached, so the box scrolls instead of growing", () => {
    expect(formTextareaOverflows(FORM_TEXTAREA_MAX_HEIGHT_PX)).toBe(true);
    expect(formTextareaOverflows(FORM_TEXTAREA_MAX_HEIGHT_PX - 1)).toBe(false);
  });

  it("agrees with the height rule at the boundary", () => {
    // A box exactly at the cap must already be scrollable, or the last line is
    // unreachable: `formTextareaHeight` may return exactly the cap.
    expect(formTextareaOverflows(formTextareaHeight(FORM_TEXTAREA_MAX_LINES * FORM_TEXTAREA_LINE_HEIGHT_PX))).toBe(true);
  });
});
