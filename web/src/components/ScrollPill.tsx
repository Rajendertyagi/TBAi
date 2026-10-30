"use client";

import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { ArrowDown } from "lucide-react";
import { TooltipIconButton } from "./assistant-ui/elements/tooltip-icon-button";
import {
  isTranscriptAtEnd,
  scrollTranscriptToEnd,
  useTranscriptVirtualizer,
} from "./VirtualizedTranscript";

/**
 * Unseen-message count for the scroll pill. Pure.
 *
 * `total` is the thread's message count, `lastSeen` the count when the timeline
 * was last at the live end. Clamped at zero so a replaced (shorter) history on
 * thread switch can never show a negative count.
 */
export function unseenCount(total: number, lastSeen: number): number {
  return Math.max(0, total - lastSeen);
}

/**
 * Jump-to-latest pill for the virtualized transcript, with an unseen count.
 *
 * It drives the transcript's OWN virtualizer (`isAtEnd` / `scrollToEnd`) rather
 * than an assistant-ui viewport context. That matters: when the transcript is
 * virtualized there is no `ThreadPrimitive.Viewport` providing that context, and
 * a control built on it renders, is clickable, and silently does nothing. Asking
 * the same virtualizer the list itself uses cannot disagree about where the end
 * is, and the click provably moves the element the transcript renders into.
 *
 * `virtualizer.isAtEnd()` is not a reactive store subscription, so the pill
 * re-reads it on the message count and on a short interval while there is
 * anything to show. That keeps the pill's own state minimal — it never owns
 * scroll state, it only reports the library's.
 *
 * `bottomOffset` is the composer overlay's measured height: the pill clears the
 * dock, so it can never sit behind the composer or on top of the text the reader
 * is trying to return to. It is a runtime `style` because it is a measured
 * geometry value, not a fixed design constant.
 */
export function ScrollPill({ bottomOffset }: { readonly bottomOffset: number }) {
  const virtualizer = useTranscriptVirtualizer();
  const count = useAuiState((s) => s.thread.messages.length);
  const [atEnd, setAtEnd] = useState(true);
  const [lastSeen, setLastSeen] = useState(count);

  useEffect(() => {
    if (atEnd) setLastSeen(count);
  }, [atEnd, count]);

  // Re-read the library's own answer while mounted. Cheap: it is a measurement
  // of one element, and the alternative is owning a parallel scroll state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `count` is not read in the body on purpose - it is the re-trigger. A new message can change whether the transcript is at the end without any other observed value changing, so the at-end reading has to be retaken whenever the count moves.
  useEffect(() => {
    const read = () => setAtEnd(isTranscriptAtEnd(virtualizer));
    read();
    const timer = window.setInterval(read, 250);
    return () => window.clearInterval(timer);
  }, [virtualizer, count]);

  const unseen = unseenCount(count, lastSeen);
  if (atEnd && unseen === 0) return null;

  return (
    <TooltipIconButton
      tooltip="Scroll to bottom"
      side="top"
      onClick={() => scrollTranscriptToEnd(virtualizer)}
      // `-translate-y-3` is the gap above the dock; the offset itself is the
      // measured overlay height (see the doc comment).
      //
      // `z-10` is required, not cosmetic: the transcript's content container is
      // `position: relative` and comes AFTER this control in DOM order, so at
      // equal stacking it paints over the pill and the pill is unclickable while
      // looking perfectly visible. That was measured — `elementFromPoint` at the
      // pill's centre resolved to a transcript paragraph. The composer footer is
      // also `z-10` and comes later, so it still wins where they could overlap.
      style={{ bottom: bottomOffset }}
      className="absolute right-6 z-10 -translate-y-3 h-8 w-auto gap-1.5 rounded-full border-none px-3 py-1 text-xs glass-surface shadow-floating"
    >
      <ArrowDown />
      {unseen > 0 ? <span>{unseen > 1 ? `${unseen} new` : "New"}</span> : null}
    </TooltipIconButton>
  );
}
