"use client";

import { useEffect } from "react";
import { OPENCODE_V2_AUX_RESYNC_INTERVAL_MS } from "@/config/opencode";
import type { V2ThreadController } from "./v2ThreadController";

/**
 * Repairs a missed permission/form event without waiting for a reload.
 *
 * The event stream has one blind spot it cannot report: `ordinal` is a LOCAL
 * counter, so a dropped `form.created` or `permission.asked` leaves no trace.
 * Nothing detects the gap, the reader sees a session that is quietly blocked,
 * and the only thing that ever fixes it is a restart. Two triggers close it:
 *
 *  - `visibilitychange`. A backgrounded tab has its timers throttled and its
 *    event stream suspended by the browser, so returning to the tab is exactly
 *    when a gap is most likely. This is the cheap half and the one that
 *    removes the "I only see the question after restarting" report outright.
 *  - a slow interval, but ONLY while the session is idle. While the agent is
 *    working, events are flowing and the live path is authoritative; a poll
 *    there would spend three GETs to learn nothing. A session blocked on an
 *    unanswered request reads as idle, which is precisely the case to catch.
 *
 * The controller owns the actual fetch, the staleness guard, and the
 * already-answered filters; this only decides WHEN to ask. A re-sync that finds
 * nothing new dispatches nothing, so an idle poll costs three small GETs and
 * no re-render.
 */
export function useOpenCodeAuxiliaryResync(controller: V2ThreadController): void {
  useEffect(() => {
    const resync = (): void => {
      void controller.resyncAuxiliary();
    };

    // `document.hidden` is read at the moment of the event, not captured when
    // the listener is attached: this fires on both edges and only the
    // becoming-visible edge is a reason to re-check.
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") resync();
    };

    const timer = setInterval(() => {
      if (controller.getState().execution.type === "idle") resync();
    }, OPENCODE_V2_AUX_RESYNC_INTERVAL_MS);

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [controller]);
}
