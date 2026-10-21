/**
 * The one line a status surface says about pending sets it could not read.
 *
 * ## Why this is separate from the component
 *
 * The decision is which sets are stale and what the reader is told, and it is
 * worth testing without mounting a popover. The component keeps the markup.
 *
 * ## Why the words are the reader's
 *
 * `inbox` is the protocol's name for queued prompts. The notice is read by
 * someone looking at a chat, so it says "queued prompts" — the same mapping the
 * status bar already uses for the states it shows.
 */
import type { V2AuxiliaryState } from "./v2Types";

/** What each pending set is called in copy the reader sees. */
const AUXILIARY_LABELS: Record<keyof V2AuxiliaryState, string> = {
  inbox: "queued prompts",
  permissions: "permissions",
  forms: "questions",
};

/**
 * The notice for pending sets whose last read FAILED, or null when every set is
 * current.
 *
 * A failed read leaves the entries already held in state, so the surface still
 * shows them. Saying nothing would present them as confirmed, which is the
 * defect: an unavailable read and an authoritative empty list look identical
 * until one of them is named.
 *
 * @param auxiliary - Per-kind availability.
 * @returns The notice, or null when nothing is stale.
 */
export function pendingSetNotice(auxiliary: V2AuxiliaryState): string | null {
  const stale = (Object.keys(AUXILIARY_LABELS) as (keyof V2AuxiliaryState)[])
    .filter((kind) => auxiliary[kind] === "unavailable")
    .map((kind) => AUXILIARY_LABELS[kind]);
  if (stale.length === 0) return null;
  return `Last refresh failed — ${stale.join(", ")} may be out of date.`;
}
