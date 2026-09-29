"use client";

import { useLayoutEffect, useState, type RefObject } from "react";
import {
  formDockAvailablePx,
  formDockBodyMaxHeight,
  formDockMeasuredMaxHeight,
} from "./formDockSizing";

/**
 * Caps the question dock's body at the room actually left on screen.
 *
 * This is the reference client's `useMobileAutocompleteMaxHeight`, ported rather
 * than reinvented. It does the measuring and calls the three pure steps in
 * `formDockSizing`; the arithmetic and every number in it live there, so this
 * file holds only the DOM work.
 *
 * The reference re-measures on window resize and on visual-viewport changes,
 * because a mobile keyboard moves the dock's anchor without a window resize ever
 * firing. Its own keyboard-settled event is not ported: that is its private
 * event bus, and the visual viewport already reports the same movement.
 *
 * @param bodyRef - The scrolling body, whose bottom edge is the anchor.
 * @param enabled - False while the dock is collapsed, so nothing is measured.
 * @returns An inline `max-height` in pixels, or `undefined` to let CSS decide.
 */
export function useFormDockMaxHeight(
  bodyRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): number | undefined {
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (!enabled) {
      setMaxHeight(undefined);
      return;
    }
    const measure = () => {
      const body = bodyRef.current;
      if (!body) return;
      // The conversation is the boundary the dock must not grow past. If the
      // page has been panned, `<main>`'s top can sit above the visible screen,
      // so the binding boundary is whichever of the two is LOWER.
      const main = body.closest("main");
      if (!main) return;
      const visualTop = window.visualViewport?.offsetTop ?? 0;
      const boundaryTop = Math.max(main.getBoundingClientRect().top, visualTop);
      // The body's bottom edge is its anchor and does not depend on how tall it
      // currently is, so this measurement is not circular.
      const available = formDockAvailablePx(
        body.getBoundingClientRect().bottom,
        boundaryTop,
      );
      const next = formDockBodyMaxHeight(formDockMeasuredMaxHeight(available));
      setMaxHeight((previous) => (previous === next ? previous : next));
    };

    measure();
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
    };
  }, [bodyRef, enabled]);

  return enabled ? maxHeight : undefined;
}
