import {
  DEFAULT_SECTION_ORDER,
  SIDEBAR_SECTION_IDS,
  type SidebarSectionId,
} from "../config/sidebar";

/**
 * Pure sidebar section-order logic (no storage, no JSX, no runtime).
 * Unit-testable; the store and components consume these so ordering rules live
 * in one place.
 */

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
