/**
 * Pure log-batch merge for the live Logs viewer.
 *
 * Server seqs restart at 0 on every boot, so rows are only unique within a
 * boot ({bootId}:{seq}). When the boot changes the whole list must be
 * replaced — appending would collide React keys with stale rows and leak DOM
 * nodes on every update. Kept here (dependency-free) so unit tests cover it
 * without mounting the component.
 */

export interface SequencedLogEntry {
  seq: number;
  [key: string]: unknown;
}

export interface MergedLogBatch<T> {
  entries: T[];
  bootId: string;
  /** True when the list was replaced (server restarted), not appended. */
  reset: boolean;
}

export function mergeLogEntries<T extends SequencedLogEntry>(
  prev: T[],
  incoming: T[],
  prevBootId: string | null,
  nextBootId: string,
  limit = 5000,
): MergedLogBatch<T> {
  if (prevBootId !== null && prevBootId !== nextBootId) {
    return { entries: incoming.slice(-limit), bootId: nextBootId, reset: true };
  }
  // Same boot: seqs are monotonic, so anything at/below the known max is a
  // re-delivery (initial fetch + SSE backlog overlap, refresh + stream
  // overlap). Dropping it keeps React keys unique — duplicates desync the
  // reconciler and leak DOM nodes on every update.
  const seen = maxSeq(prev);
  const fresh = incoming.filter((e) => e.seq > seen);
  if (fresh.length === 0) return { entries: prev, bootId: nextBootId, reset: false };
  return { entries: [...prev, ...fresh].slice(-limit), bootId: nextBootId, reset: false };
}

/** Newest seq in a batch (0 when empty) — drives the `since` cursor. */
export function maxSeq<T extends SequencedLogEntry>(entries: T[]): number {
  let max = 0;
  for (const e of entries) {
    if (e.seq > max) max = e.seq;
  }
  return max;
}

/** Serialize entries as JSON lines for the Export download. */
export function serializeLogEntries(entries: Array<Record<string, unknown>>): string {
  if (entries.length === 0) return "";
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
