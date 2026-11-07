import { describe, expect, it, beforeEach } from "bun:test";
import {
  clampWindowZoom,
  DEFAULT_WINDOW_ZOOM,
  readWindowZoom,
  WINDOW_ZOOM_MAX,
  WINDOW_ZOOM_MIN,
  WINDOW_ZOOM_PRESETS,
  WINDOW_ZOOM_STORAGE_KEY,
  writeWindowZoom,
} from "@web/lib/platform";
import { readTypography } from "@web/features/appearance/typography";

describe("Window Zoom & Platform Abstraction (V7 Independence)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to 1.0 when uninitialized", () => {
    expect(readWindowZoom()).toBe(DEFAULT_WINDOW_ZOOM);
  });

  it("clamps values outside 0.8–3.0 range", () => {
    expect(clampWindowZoom(0.5)).toBe(WINDOW_ZOOM_MIN);
    expect(clampWindowZoom(4.5)).toBe(WINDOW_ZOOM_MAX);
    expect(clampWindowZoom(Number.NaN)).toBe(DEFAULT_WINDOW_ZOOM);
    expect(clampWindowZoom(1.25)).toBe(1.25);
  });

  it("persists and reads window zoom safely in localStorage", () => {
    writeWindowZoom(1.75);
    expect(window.localStorage.getItem(WINDOW_ZOOM_STORAGE_KEY)).toBe("1.75");
    expect(readWindowZoom()).toBe(1.75);
  });

  it("verifies presets array covers the 80% to 300% specification", () => {
    expect(WINDOW_ZOOM_PRESETS[0]).toBe(0.8);
    expect(WINDOW_ZOOM_PRESETS[WINDOW_ZOOM_PRESETS.length - 1]).toBe(3.0);
    expect(WINDOW_ZOOM_PRESETS).toContain(1.0);
    expect(WINDOW_ZOOM_PRESETS).toContain(1.25);
    expect(WINDOW_ZOOM_PRESETS).toContain(1.5);
    expect(WINDOW_ZOOM_PRESETS).toContain(2.0);
  });

  it("changing window zoom NEVER modifies the tbai-typography record", () => {
    const beforeTypography = readTypography();
    writeWindowZoom(2.5);
    const afterTypography = readTypography();

    expect(afterTypography).toEqual(beforeTypography);
    expect(window.localStorage.getItem("tbai-typography")).toBeNull();
  });
});
