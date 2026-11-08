import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { formatRelativeTime } from "@/lib/date-format";

/**
 * Live relative last-message time for a sidebar conversation row.
 *
 * The canonical thread list belongs to assistant-ui (hoisted to `AppShell`, so
 * the sidebar and the chat share one source) and the runtime refreshes it after
 * a turn, which is fresher than the sidebar's own paged fetch. As with
 * `ThreadRunningDot`, that runtime-derived presentation lives in a shared UI
 * leaf: the sidebar composes it and never subscribes to assistant-ui itself.
 *
 * Outside an `AuiProvider` the selector throws, so the row falls back to the
 * timestamp the sidebar fetched. A missing or unparsable value renders nothing.
 */
export function ThreadLastMessageTime({
  remoteId,
  fallback,
  className,
}: {
  remoteId: string;
  fallback?: Date | string;
  className?: string;
}) {
  const live = useAuiState((state) => {
    try {
      const items = state.threads?.threadItems ?? [];
      const match =
        items.find((t) => t.remoteId === remoteId) ?? items.find((t) => t.id === remoteId);
      return match?.lastMessageAt;
    } catch {
      return undefined;
    }
  });

  const [, setTick] = useState(0);

  useEffect(() => {
    // Tick every 30 seconds so "just now" transitions to "1m ago", etc.,
    // isolated entirely inside this leaf without re-rendering the sidebar list.
    const interval = setInterval(() => {
      setTick((t) => (t + 1) % 1_000_000);
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  const label = formatRelativeTime(live ?? fallback);
  if (!label) return null;
  return <span className={className}>{label}</span>;
}
