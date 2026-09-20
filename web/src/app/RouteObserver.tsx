import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { logger } from "../lib/logger";

/**
 * Null-render route-transition recorder.
 *
 * Routing was a total dark zone: nothing recorded that a surface changed, so a
 * lifecycle that spans two routes (draft on `/chat` → execution on `/code`)
 * could not be ordered against the rest of an operation. Mounted once in
 * `AppShell`, which both shells use, so every surface is covered by one
 * recorder instead of per-page instrumentation.
 *
 * Emits only on an actual change, and only the pathname (never query strings,
 * which can carry user data).
 */
export function RouteObserver() {
  const location = useLocation();
  const previous = useRef<string | null>(null);

  useEffect(() => {
    const to = location.pathname;
    const from = previous.current;
    previous.current = to;
    if (from === to) return;
    logger.info("app", "route.change", {
      from: from ?? undefined,
      to,
    });
  }, [location.pathname]);

  return null;
}
