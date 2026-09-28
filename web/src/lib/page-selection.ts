/**
 * Page-selection capture for the right-click menu.
 *
 * The page menu replaced the browser's own, which used to offer Copy for a
 * highlighted selection. Restoring that item needs the selection text captured
 * at the moment the menu opens, because Radix moves focus and collapses the
 * browser selection as it opens — a click-time read finds nothing.
 *
 * The read is a DOM call, so it lives here behind a tiny seam rather than
 * inline in the component: the decision of *what counts as a copyable
 * selection* is then testable without a browser.
 */

/**
 * The page selection as text.
 *
 * An empty string means "nothing selected", which is what disables the Copy
 * item. Whitespace-only selections normalise to empty for the same reason a
 * user would treat them as nothing: dragging across a gap between two words
 * should not present a Copy action that appears to do nothing useful.
 *
 * @param selection - A `Selection`, or `null` where the platform has none.
 * @returns The selected text, or `""` when nothing usable is selected.
 */
export function readPageSelection(selection: Selection | null): string {
  if (!selection) return "";
  const text = selection.toString();
  return text.trim() ? text : "";
}

/**
 * Whether a captured selection can be copied.
 *
 * Kept as its own predicate so the menu's enablement rule is stated once: the
 * item is disabled rather than hidden, so the menu keeps the same shape
 * wherever the user right-clicks.
 *
 * @param capturedText - Text captured when the menu opened.
 * @returns `true` when there is text to copy.
 */
export function canCopySelection(capturedText: string): boolean {
  return capturedText.trim().length > 0;
}
