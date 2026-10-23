"use client";

import { useEffect, useState } from "react";
import { OPENCODE_RETRY_TICK_MS, formatRetryCountdown } from "./config";
import { useOptionalV2RuntimeExtras } from "./v2RuntimeExtras";

/**
 * The live engine retry, directly above the composer.
 *
 * ## What it shows, and what it refuses to show
 *
 * The countdown is DERIVED from the server's absolute epoch-ms deadline. The
 * plan deliberately does not persist or rebuild a countdown: after a reconnect
 * or process restart there is no scheduled wait to count, so the banner is
 * absent unless a new live event established one. When the deadline is missing
 * or already passed the copy says "Retrying" with no number — a fabricated
 * second is worse than no second.
 *
 * The connection is checked defensively as well. Retry state is already cleared
 * when the connection leaves `connected`, but a banner showing a countdown
 * during a reconnect would contradict the status chip.
 *
 * Accessibility: one polite announcement per ATTEMPT. The changing seconds are
 * `aria-hidden`, so a screen reader hears "Retrying, attempt 2" once rather
 * than every tick.
 */
export function OpenCodeRetryBanner() {
  const extras = useOptionalV2RuntimeExtras();
  const retry = extras?.state.retry ?? null;
  const connection = extras?.state.connection ?? null;
  const next = retry?.next ?? null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (next === null) return;
    // Repaint immediately on a new deadline, then follow the tick. The
    // interval exists only while a trustworthy deadline does.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), OPENCODE_RETRY_TICK_MS);
    return () => clearInterval(timer);
  }, [next]);

  if (!retry || connection === null || connection.type !== "connected") return null;

  const remaining = next === null ? null : Math.max(0, Math.ceil((next - now) / 1000));
  const countdown =
    remaining !== null && remaining > 0
      ? `Retrying in ${formatRetryCountdown(remaining)}`
      : "Retrying";

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
      <span role="status" className="sr-only">
        Retrying, attempt {retry.attempt}
      </span>
      <span aria-hidden="true">
        {countdown} (attempt {retry.attempt})
      </span>
    </div>
  );
}
