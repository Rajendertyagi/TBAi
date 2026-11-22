import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/date-format";

/**
 * Relative last-message time for a sidebar conversation row.
 *
 * The timestamp is HTTP-owned: it comes from the conversation list's
 * `lastMessageAt` (SQLite `last_message_at`), not from assistant-ui runtime
 * metadata. A 30-second ticker keeps relative labels fresh without re-rendering
 * the sidebar list. A missing or unparsable value renders nothing.
 */
export function ThreadLastMessageTime({
  fallback,
  className,
}: {
  remoteId: string;
  fallback?: Date | string;
  className?: string;
}) {
  const [, setTick] = useState(0);

  useEffect(() => {
    // Tick every 30 seconds so "just now" transitions to "1m ago", etc.,
    // isolated entirely inside this leaf without re-rendering the sidebar list.
    const interval = setInterval(() => {
      setTick((t) => (t + 1) % 1_000_000);
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  const label = formatRelativeTime(fallback);
  if (!label) return null;
  return <span className={className}>{label}</span>;
}
