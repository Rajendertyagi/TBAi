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
 */
export function ScrollPill() {
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
      className="absolute bottom-24 right-6 h-8 w-auto gap-1.5 rounded-full border-none px-3 py-1 text-xs glass-surface shadow-floating"
    >
      <ArrowDown />
      {unseen > 0 ? <span>{unseen > 1 ? `${unseen} new` : "New"}</span> : null}
    </TooltipIconButton>
  );
}
