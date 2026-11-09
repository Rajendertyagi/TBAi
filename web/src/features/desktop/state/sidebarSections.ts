import {
  DEFAULT_SECTION_ORDER,
  SIDEBAR_SECTION_IDS,
  type SidebarSectionId,
} from "../../../config/sidebar";

/**
 * Pure sidebar section-order logic (no storage, no JSX, no runtime).
 * Strict semantics must match backend (docs/2026-11-08-preferences-architecture-review.md).
 */

function isSectionId(value: unknown): value is SidebarSectionId {
  return (SIDEBAR_SECTION_IDS as readonly unknown[]).includes(value);
}

/**
 * Strict sectionOrder normalization (backend/frontend parity).
 * - missing/undefined/null/[] => effective default order
 * - valid known IDs => dedupe (first occurrence), append missing in default order
 * - non-array / invalid element types / unknown IDs => throws
 */
export function normalizeSectionOrder(value: unknown): readonly SidebarSectionId[] {
  if (value === undefined || value === null) return DEFAULT_SECTION_ORDER;
  if (!Array.isArray(value)) {
    throw new Error("sectionOrder must be an array");
  }
  if (value.length === 0) return DEFAULT_SECTION_ORDER;
  const seen = new Set<SidebarSectionId>();
  const out: SidebarSectionId[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error("sectionOrder elements must be strings");
    }
    if (!isSectionId(entry)) {
      throw new Error(`sectionOrder contains unknown section id: ${entry}`);
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  for (const id of SIDEBAR_SECTION_IDS) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

/** Lenient normalizer for non-authoritative/local contexts (never for snapshot validation). */
export function normalizeSectionOrderLenient(value: unknown): readonly SidebarSectionId[] {
  try {
    return normalizeSectionOrder(value);
  } catch {
    return DEFAULT_SECTION_ORDER;
  }
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
