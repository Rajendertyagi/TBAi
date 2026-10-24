const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" });

/**
 * Format timestamp into compact relative time string:
 * - < 60s: "just now"
 * - < 1h: narrow minutes (e.g. "5m ago")
 * - < 24h: narrow hours (e.g. "2h ago")
 * - < 48h: "yesterday"
 * - < 7d: narrow days (e.g. "3d ago")
 * - older: localized short date (e.g. "Oct 24")
 */
export function formatRelativeTime(date?: Date | string | number | null): string {
  if (!date) return "";
  const target = typeof date === "number" || typeof date === "string" ? new Date(date) : date;
  const time = target.getTime();
  if (Number.isNaN(time)) return "";

  const diff = Math.max(0, Date.now() - time);

  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return rtf.format(-Math.floor(diff / 60_000), "minute");
  if (diff < 86_400_000) return rtf.format(-Math.floor(diff / 3_600_000), "hour");
  if (diff < 172_800_000) return rtf.format(-1, "day");
  if (diff < 604_800_000) return rtf.format(-Math.floor(diff / 86_400_000), "day");

  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(target);
}
