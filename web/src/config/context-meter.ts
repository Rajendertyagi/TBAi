/**
 * Copy for the Direct context action.
 *
 * ## Scope
 *
 * One control: "Compress now". Occupancy, the window figure, its provenance and the
 * token segments are **not** here — the ring's own click-to-pin content already
 * renders all of them from the same server reading, and duplicating them into a second
 * surface was the mistake this file's earlier, larger version made.
 *
 * ## Why the copy lives here at all
 *
 * Every other piece of TBAi-owned UI copy has one home (`config/composer.ts` for
 * composer menus, `config/tools.ts` for tool cards). A string literal inside a
 * component would be the one piece of composer copy with no single source.
 *
 * ## Why no provenance table
 *
 * The provenance wording belongs to the vendored ring, which renders it inline. A
 * table here would be a second copy to keep in step with a vendor snapshot this project
 * does not fork — the earlier version of this file held one, and it was only reachable
 * from a panel that could never open.
 */

export const contextPanelCopy = {
  /** Manual compaction, routed through the existing `/compact` command path. */
  compactNow: "Compress now",
  /** Explains what the action does, since the label alone does not. */
  compactHint: "Summarise earlier turns to free up context",
} as const;
