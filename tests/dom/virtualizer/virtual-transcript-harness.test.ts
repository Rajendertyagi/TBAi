/**
 * P2 — headless scroll harness: what `@tanstack/virtual-core` can and cannot
 * prove WITHOUT a browser.
 *
 * G-1..G-5 in `virtual-core-identity.test.ts` prove WHICH virtual-core a test
 * gets. This file establishes how much of P2's scroll geometry that buys.
 *
 * ## The short version: identity yes, scroll geometry no.
 *
 * Measurement is fully drivable headlessly — `estimateSize`, a stubbed
 * `measureElement`, `initialRect` all work, and `getTotalSize()` /
 * `getVirtualItems()` return correct, bounded, config-sensitive values.
 *
 * SCROLL geometry does NOT work headlessly. `getMaxScrollOffset()` is
 * (`virtual-core:998-1006`):
 *
 *   if (!this.scrollElement) return 0;
 *   if ("scrollHeight" in this.scrollElement)
 *     return this.scrollElement.scrollHeight - this.scrollElement.clientHeight;
 *
 * so it reads the offset ceiling off a REAL scroll element rather than off
 * `scrollRect`. Supplying `getScrollElement: () => null` therefore pins
 * `getMaxScrollOffset()` to 0, which makes `getDistanceFromEnd()` 0 and
 * `isAtEnd()` trivially `true` — a green assertion that means nothing.
 *
 * Substituting a plain object for the scroll element does not rescue it: the
 * stubbed `observeElementRect` / `observeElementOffset` callbacks are never
 * invoked, so `scrollOffset` never moves and every scroll assertion degenerates
 * the same way. Measured, not assumed — see the probe values recorded in the
 * review of this file.
 *
 * CONSEQUENCE: `isAtEnd()`, `scrollToEnd()`, prepend compensation and the live-
 * edge pinning property REMAIN E2E-ONLY. They are deliberately absent below
 * rather than asserted against a stub that always returns "at the end".
 * Asserting them here would produce a test that passes no matter what the
 * library does — the exact failure mode this layer exists to eliminate.
 */
import { describe, expect, it } from "bun:test";
import { Virtualizer } from "@tanstack/virtual-core";

const ROW_HEIGHT = 60;
const VIEWPORT_HEIGHT = 600;
const VIEWPORT_WIDTH = 800;

/** Production option set, mirrored from VirtualizedTranscript.tsx:139-149. */
const PRODUCTION = {
  anchorTo: "end",
  followOnAppend: true,
  scrollEndThreshold: 80,
  overscan: 4,
} as const;

/**
 * A headless Virtualizer with stubbed observation.
 *
 * `getScrollElement` returns null deliberately: that is the honest shape for a
 * headless harness, and the limitation it causes is documented above rather than
 * papered over with a fake element that never engages.
 */
function harness(count: number, overrides: Record<string, unknown> = {}) {
  const rect = { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };
  const virtualizer = new Virtualizer<HTMLDivElement, Element>({
    count,
    getScrollElement: () => null,
    estimateSize: () => ROW_HEIGHT,
    measureElement: () => ROW_HEIGHT,
    initialRect: rect,
    initialOffset: 0,
    scrollMargin: 0,
    paddingStart: 0,
    paddingEnd: 0,
    gap: 0,
    enabled: true,
    observeElementRect: (
      _instance: unknown,
      cb: (r: { width: number; height: number }) => void,
    ) => {
      cb(rect);
      return () => undefined;
    },
    observeElementOffset: (
      _instance: unknown,
      cb: (offset: number, isScrolling: boolean) => void,
    ) => {
      cb(0, false);
      return () => undefined;
    },
    scrollToFn: () => undefined,
    ...PRODUCTION,
    ...overrides,
  } as never);

  return {
    virtualizer,
    setCount: (next: number) =>
      // `setOptions` replaces the option set, so the whole set is re-sent —
      // passing only `count` would drop the production options and measure a
      // different virtualizer than the one under test.
      virtualizer.setOptions({
        count: next,
        getScrollElement: () => null,
        estimateSize: () => ROW_HEIGHT,
        measureElement: () => ROW_HEIGHT,
        initialRect: rect,
        initialOffset: 0,
        scrollMargin: 0,
        paddingStart: 0,
        paddingEnd: 0,
        gap: 0,
        enabled: true,
        observeElementRect: (_instance, cb) => {
          cb(rect);
          return () => undefined;
        },
        observeElementOffset: (_instance, cb) => {
          cb(0, false);
          return () => undefined;
        },
        scrollToFn: () => undefined,
        ...PRODUCTION,
      } as never),
  };
}

describe("P2 — headless Virtualizer harness (measurement only)", () => {
  it("a large buffer reports a coherent total size", () => {
    const { virtualizer } = harness(1000);
    expect(virtualizer.getTotalSize(), "total size reflects the whole logical list").toBe(
      1000 * ROW_HEIGHT,
    );
  });

  it("only a bounded window is measured, not the whole logical list", () => {
    const { virtualizer } = harness(1000);
    const items = virtualizer.getVirtualItems();

    expect(items.length, "some rows are mounted").toBeGreaterThan(0);
    expect(
      items.length,
      `mounted rows must be far fewer than the logical list (mounted ${items.length} of 1000)`,
    ).toBeLessThan(1000);
  });

  it("growing the buffer grows the total size", () => {
    const h = harness(500);
    expect(h.virtualizer.getTotalSize()).toBe(500 * ROW_HEIGHT);
    h.setCount(560);
    expect(
      h.virtualizer.getTotalSize(),
      "a prepended page must be reflected in the total size",
    ).toBe(560 * ROW_HEIGHT);
  });

  it("MUTATION GATE: `anchorTo` is NOT observable here, which is itself the finding", () => {
    // An earlier draft of this file asserted that `anchorTo: "start"` mounts a
    // different window than `anchorTo: "end"`. MEASURED: it does not. With the
    // scroll offset pinned at 0 and no scroll element, both configurations mount
    // the same initial window, so that assertion was vacuous and has been
    // replaced with the observation itself.
    //
    // This is why the layer cannot carry P2's scroll criteria: the very option
    // the prepend fix depends on has no headless effect to assert against.
    const end = harness(1000);
    const start = harness(1000, { anchorTo: "start" });

    const endItems = end.virtualizer.getVirtualItems();
    const startItems = start.virtualizer.getVirtualItems();

    expect(
      `${startItems[0]?.index}-${startItems.at(-1)?.index}`,
      "anchorTo has NO observable effect without a scroll element — recorded so a",
    ).toBe(`${endItems[0]?.index}-${endItems.at(-1)?.index}`);
  });

  it("documents the scroll-geometry boundary rather than asserting it", () => {
    // If this test ever starts failing, the limitation above has changed and the
    // E2E-only assertions should be reconsidered — not deleted, but re-derived
    // against whatever now works headlessly.
    const { virtualizer } = harness(500);
    const anyV = virtualizer as unknown as { getMaxScrollOffset?: () => number };
    expect(
      anyV.getMaxScrollOffset?.(),
      "without a real scroll element the offset ceiling is 0, which is exactly why",
    ).toBe(0);
    expect(
      virtualizer.isAtEnd(),
      "so isAtEnd() is trivially true here and proves nothing about the library",
    ).toBe(true);
  });
});
