"use client";

import { useEffect, useState } from "react";
import {
  ThreadPrimitive,
  useAuiState,
  useThreadViewport,
} from "@assistant-ui/react";
import { ArrowDown } from "lucide-react";
import { TooltipIconButton } from "./assistant-ui/elements/tooltip-icon-button";

/**
 * Unseen-message count for the scroll pill. Pure.
 *
 * `total` is the thread's message count, `lastSeen` the count when the
 * viewport was last at the bottom. Clamped at zero so a replaced (shorter)
 * history on thread switch can never show a negative count.
 */
export function unseenCount(total: number, lastSeen: number): number {
  return Math.max(0, total - lastSeen);
}

/**
 * Jump-back pill for the thread viewport, with an unseen-message count.
 *
 * Mounted once in `ChatWindow`, so it serves Direct and OpenCode surfaces
 * alike. Behavior comes from the runtime primitives: `ScrollToBottom` hides
 * itself while at the bottom, and the viewport owns the pin. The only custom
 * state is `lastSeen`, synced in an effect (never during render) whenever the
 * viewport is at the bottom.
 *
 * Store subscriptions return primitives only (`isAtBottom`, message count),
 * so snapshots stay referentially stable and no render loop is possible.
 */
export function ScrollPill() {
  // Required (not optional): ThreadPrimitive.ScrollToBottom below consumes
  // the same viewport context, so if it is missing both fail identically —
  // no silent degraded mode that could hide a wiring break.
  const { isAtBottom } = useThreadViewport();
  const count = useAuiState((s) => s.thread.messages.length);
  const [lastSeen, setLastSeen] = useState(count);
  useEffect(() => {
    if (isAtBottom) setLastSeen(count);
  }, [isAtBottom, count]);
  const unseen = unseenCount(count, lastSeen);
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        side="top"
        className="absolute bottom-24 right-6 h-8 w-auto gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs shadow-md"
      >
        <ArrowDown />
        {unseen > 0 ? (
          <span>{unseen > 1 ? `${unseen} new` : "New"}</span>
        ) : null}
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
}
