/**
 * Pure time formatting for the scheduler UI. Null/invalid → em dash, never
 * a throw during render. Unit-tested.
 */

/** Absolute local date-time for run-history rows. */
export function formatTime(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

/** Forward-looking ("in 5m", "due now") for next-run labels. */
export function formatRelative(ms: number | null, nowMs = Date.now()): string {
  if (!ms) return "—";
  const diff = ms - nowMs;
  if (diff <= 0) return "due now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "in seconds";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

/** Compact past-tense ("now", "5m", "2h", "3d") for last-run labels. */
export function formatRelativePast(ms: number | null, nowMs = Date.now()): string {
  if (!ms) return "—";
  const sec = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (sec < 45) return "now";
  const mins = Math.round(sec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.round(months / 12)}y`;
}

/** Duration ("45s", "3m 12s", "2h 5m") for run-history rows. */
export function formatDuration(durationMs: number | null): string {
  if (durationMs == null || durationMs < 0) return "—";
  const sec = Math.round(durationMs / 1000);
  if (sec < 60) return `${sec}s`;
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  if (mins < 60) return rem ? `${mins}m ${rem}s` : `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
