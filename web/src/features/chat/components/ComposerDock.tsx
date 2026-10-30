/**
 * The floating composer dock — the transcript scrolls UNDER it, not above it.
 *
 * ## Why this is a measured `ViewportFooter`
 *
 * The composer used to be the transcript viewport's flex sibling, so the
 * transcript ended at a hard edge directly above it and the last line stopped
 * well clear of the box. A floating composer needs the scrollport to reach the
 * bottom of the surface AND the transcript's live end to stop at the composer's
 * top edge. Those two facts need a number: how tall the overlay actually is.
 *
 * The number is not derivable in CSS. It grows and shrinks at runtime (a top
 * row, more lines of text, a status pill row, the scope chip), so any constant
 * would either leave a dead band or hide text under the dock.
 *
 * `ThreadPrimitive.ViewportFooter` is the library's own answer: it measures its
 * height with a `ResizeObserver` through `useSizeHandle` and publishes it to the
 * thread viewport store as the content inset (`registerContentInset`). Multiple
 * footers sum, and the store state is already there app-wide because
 * `AssistantRuntimeProvider` mounts the viewport provider. So this file writes
 * NO observer, NO provider and NO CSS-variable channel — it composes the
 * library primitive and reads the published number back with `useThreadViewport`,
 * which is the same store the footer wrote to.
 *
 * The transcript then feeds that number to the virtualizer's `paddingEnd`
 * (see `VirtualizedTranscript`), which is the one place a bottom reserve can be
 * expressed without breaking `scrollHeight === getTotalSize()`.
 *
 * ## Why the reserve is the measured height PLUS a gap
 *
 * Reserving exactly the overlay's height puts the newest line on the band's top
 * edge: the moment a row is a little taller than measured, or the follow glide
 * trails the live edge, readable text sits inside the fade and then disappears
 * behind the dock — it reads as the composer eating the answer. The reserve
 * carries `COMPOSER_TAIL_GAP_PX` of clear air on top of the measured height, so
 * the band dissolves empty space at rest and only covers text that the reader
 * has deliberately scrolled under it.
 *
 * ## Why the reserved `min-height` row stays
 *
 * The status row is inside the DOCK, not above the transcript. It keeps its
 * reserved one-line height for the same reason as before: a status pill
 * appearing or disappearing would otherwise resize the dock, and a resizing dock
 * now changes the reserve (and therefore the transcript's end) instead of moving
 * the viewport. The reserve absorbs that churn; the dock's height still changes
 * when real content does (a question form), which is content, not a label.
 */

import type { ReactNode } from "react";
import { ThreadPrimitive, useThreadViewport } from "@assistant-ui/react";

/** The dock's height while the footer has not measured itself yet. */
const UNMEASURED_INSET_PX = 0;

/**
 * Clear air the transcript keeps between its last row and the fade band.
 *
 * The band is already part of the measured footer, so this is the space ABOVE
 * the gradient: one paragraph line of margin, which is what keeps a followed
 * reply from ending inside the dissolve.
 */
export const COMPOSER_TAIL_GAP_PX = 32;

/**
 * The height of the composer overlay, as measured by the library.
 *
 * Returns 0 before the footer's first measurement; callers treat that as "no
 * reserve yet", which is correct — nothing is overlapping the transcript until
 * the dock has a box.
 */
export function useComposerInset(): number {
  return useThreadViewport((state) => state.height.inset) ?? UNMEASURED_INSET_PX;
}

/**
 * The transcript's end reserve: the measured overlay height plus the tail gap.
 *
 * Returns 0 (no reserve at all) until the footer has measured itself, so a
 * surface with no dock — the welcome screen — does not reserve a phantom gap.
 */
export function useComposerReserve(): number {
  const inset = useComposerInset();
  return inset === UNMEASURED_INSET_PX ? UNMEASURED_INSET_PX : inset + COMPOSER_TAIL_GAP_PX;
}

export function ComposerDock({ children }: { readonly children: ReactNode }) {
  return (
    <ThreadPrimitive.ViewportFooter
      data-composer-footer
      // The wrapper spans the column so the fade band is full-bleed, but it must
      // not swallow clicks on the transcript that scrolls beneath it. Only the
      // dock itself re-enables pointer events.
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col"
    >
      {/*
        The fade band. Solid `background` at the bottom edge so the opaque dock
        does not start with a visible seam, transparent at the top so text
        dissolves into the dock instead of being guillotined by a hard line.
        `from-background to-transparent` is bottom-to-top because
        `bg-linear-to-t` points up the y axis. One paragraph line of ramp: a
        shorter band puts readable text behind a visible edge.
      */}
      <div
        data-composer-fade
        aria-hidden="true"
        className="pointer-events-none h-12 w-full shrink-0 bg-linear-to-t from-background to-transparent"
      />
      <div
        data-composer-dock
        className="pointer-events-auto relative mx-auto w-full max-w-3xl bg-background px-4 pb-4"
      >
        {children}
      </div>
    </ThreadPrimitive.ViewportFooter>
  );
}
