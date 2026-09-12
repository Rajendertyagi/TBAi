import {
  DEFAULT_SECTION_ORDER,
  SIDEBAR_SECTION_IDS,
  type SidebarSectionId,
  type SidebarSortMode,
} from "../config/sidebar";

/**
 * Pure sidebar list logic (no storage, no JSX, no runtime). Unit-testable;
 * the store and components consume these so ordering rules live in one place.
 */

export interface SidebarThread {
  id: string;
  remoteId: string | undefined;
  title?: string;
  status: string;
  lastMessageAt?: Date;
  /** Epoch ms of conversation creation (adapter `custom.createdAt`). */
  createdAtMs?: number;
}

function isSectionId(value: unknown): value is SidebarSectionId {
  return (SIDEBAR_SECTION_IDS as readonly unknown[]).includes(value);
}

/**
 * Coerce an arbitrary persisted value into a full, duplicate-free permutation
 * of the known section ids. Unknown entries and repeats are dropped; sections
 * the value omits are appended in default order so a newly added section
 * appears instead of vanishing for existing users.
 */
export function normalizeSectionOrder(
  value: unknown,
): readonly SidebarSectionId[] {
  if (!Array.isArray(value)) return DEFAULT_SECTION_ORDER;
  const seen = new Set<SidebarSectionId>();
  const out: SidebarSectionId[] = [];
  for (const entry of value) {
    if (!isSectionId(entry) || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  for (const id of SIDEBAR_SECTION_IDS) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

/**
 * Move `id` by `delta` slots (negative = towards the top). A move that would
 * fall off either end, or names an unknown id, returns the SAME array
 * reference so callers can skip no-op writes/renders.
 */
export function moveSectionInOrder(
  order: readonly SidebarSectionId[],
  id: SidebarSectionId,
  delta: number,
): readonly SidebarSectionId[] {
  const from = order.indexOf(id);
  if (from < 0) return order;
  const to = from + delta;
  if (to < 0 || to >= order.length || to === from) return order;
  const next = order.slice();
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

function timeOf(thread: SidebarThread, sort: SidebarSortMode): number {
  if (sort === "created") {
    if (typeof thread.createdAtMs === "number") return thread.createdAtMs;
  }
  return thread.lastMessageAt ? thread.lastMessageAt.getTime() : 0;
}

/** Newest-first by the active sort key. Stable: ties keep server order. */
export function sortThreads(
  threads: readonly SidebarThread[],
  sort: SidebarSortMode,
): SidebarThread[] {
  return threads
    .map((thread, index) => ({ thread, index }))
    .sort((a, b) => {
      const diff = timeOf(b.thread, sort) - timeOf(a.thread, sort);
      return diff !== 0 ? diff : a.index - b.index;
    })
    .map(({ thread }) => thread);
}

/** Case-insensitive title match. Empty query matches everything. */
export function filterThreads(
  threads: readonly SidebarThread[],
  query: string,
): SidebarThread[] {
  const q = query.trim().toLowerCase();
  if (!q) return threads.slice();
  return threads.filter((t) => (t.title ?? "").toLowerCase().includes(q));
}

const DAY_MS = 86400000;

export type DateGroup = "Today" | "Yesterday" | "Previous 7 days" | "Older";

export function dateGroupLabel(date?: Date): DateGroup {
  if (!date) return "Older";
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const diff = startOfToday - new Date(date).getTime();
  if (diff < 0) return "Today";
  if (diff < DAY_MS) return "Yesterday";
  if (diff < 7 * DAY_MS) return "Previous 7 days";
  return "Older";
}
