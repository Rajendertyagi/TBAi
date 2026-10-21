/**
 * What the held buffer may re-apply to a committed history snapshot.
 *
 * ## WHY THIS EXISTS
 *
 * The commit takes the snapshot's copy of a message the client did not change
 * while the read was in flight, and the events the read held are replayed on
 * top. That composition is only correct where the two halves do not overlap.
 *
 * The server persists a streamed part in three steps: `text.started` stores the
 * part EMPTY, the deltas are never written to the database, and `text.ended`
 * stores the finished text. A durable event is committed to that store BEFORE it
 * is published to SSE subscribers (`packages/core/src/bus.ts`: projectors run,
 * then `notify`). Two consequences follow, and they are the whole rule here:
 *
 * 1. A snapshot that carries text for a part therefore carries the FINISHED
 *    part, and every delta that produced it is already inside it - including
 *    the deltas this client is still holding, because they were published
 *    before `ended` was committed. Appending them would double the text.
 * 2. A snapshot that carries the part EMPTY has not seen the deltas at all, so
 *    every held delta still has to be replayed - even one that arrived before
 *    the read's ordinal boundary, which is possible while the read is being
 *    prepared.
 *
 * So the snapshot's own per-part text decides, not the ordinal. The ordinal
 * still decides for everything else, because every other event's effect IS
 * persisted before the read can be answered.
 *
 * A tool part is the exception in the other direction: a delta alone cannot
 * rebuild it (its name arrives only in `session.tool.input.started`, and
 * `v2Events.ts` would synthesize `unknown`), so a held tool-input delta is
 * replayed only when it arrived after the boundary.
 *
 * What this module does NOT own: the commit's own precedence over message ids
 * (the `history_loaded` reducer owns that), and the buffer's shape (the event
 * pipeline owns that). This module answers one question - may this held event
 * be re-applied to that snapshot - and the controller applies the answer.
 */

import type { V2Event } from "@opencode/client";
import type { V2MessageState } from "../v2Types";
import type { BufferedEvent } from "./eventPipeline";

/**
 * The part a buffered delta would write to.
 *
 * @param event - The buffered event.
 * @returns The part id, or null when the event is not a part delta.
 */
export function deltaPartId(event: V2Event): string | null {
  switch (event.type) {
    case "session.text.delta":
      return `text:${event.data.assistantMessageID}:${event.data.ordinal}`;
    case "session.reasoning.delta":
      return `reasoning:${event.data.assistantMessageID}:${event.data.ordinal}`;
    case "session.tool.input.delta":
      return `tool:${event.data.assistantMessageID}:${event.data.id}`;
    default:
      return null;
  }
}

/**
 * The parts the committed snapshot already carries text for.
 *
 * Only the snapshot's OWN copy of a message speaks for the text it holds.
 *
 * @param messages - The messages the commit installed from the snapshot.
 * @returns The ids of the parts whose text the snapshot speaks for.
 */
export function coveredTextPartIds(messages: readonly V2MessageState[]): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind === "text" || part.kind === "reasoning") {
        if (part.value !== "") covered.add(part.id);
        continue;
      }
      if (part.kind === "tool" && typeof part.input.text === "string" && part.input.text !== "")
        covered.add(part.id);
    }
  }
  return covered;
}

/**
 * Whether one held event belongs on top of the committed snapshot.
 *
 * @param entry - The held event and the ordinal it arrived at.
 * @param boundary - The ordinal the history read started at.
 * @param covered - The parts the snapshot already carries text for.
 * @returns True when replaying the event cannot double or lose text.
 */
export function shouldReplayBuffered(
  entry: BufferedEvent,
  boundary: number,
  covered: ReadonlySet<string>,
): boolean {
  const partId = deltaPartId(entry.event);
  if (partId === null) return entry.ordinal > boundary;
  if (covered.has(partId)) return false;
  if (entry.ordinal > boundary) return true;
  // A text or reasoning delta carries everything the part needs (its id and its
  // ordinal), so a pre-boundary one can still be replayed into an empty part.
  return (
    entry.event.type === "session.text.delta" || entry.event.type === "session.reasoning.delta"
  );
}
