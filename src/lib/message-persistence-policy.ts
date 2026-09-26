/**
 * What counts as a persistable assistant reply.
 *
 * The client persists an assistant message row as soon as a run STARTS, carrying
 * whatever the runtime holds at that moment. At that instant the run has produced
 * nothing: the row's only part is TBAi's UI-only progress part, written by the
 * route's outer writer before the first token exists. When the run then dies
 * (interrupted / errored / cancelled) nothing ever updates that row, so it
 * survives as an assistant turn that renders NOTHING — `TodoList` returns `null`
 * for an empty stage list, leaving a blank bubble in the thread.
 *
 * Measured on a real interrupted run: 0 rows with `parts: []`, and every phantom
 * row carried exactly one `data-tbai-progress` part with `stages: []`. So the
 * defect is "an assistant message that renders no content", not "an empty array".
 *
 * The rule is deliberately about the MESSAGE, never about the run's outcome. At
 * shell-write time the outcome is unknowable — the run is still in flight — so a
 * guard cannot distinguish interrupted from cancelled from healthy, and one that
 * pretended to would have to guess. Instead: contentless is not yet a reply, and a
 * real reply arrives moments later as an update to the same message id. A run
 * that never produces content simply never gets a row.
 *
 * FAIL-OPEN on anything unrecognised: an unknown part type is treated as real
 * content, because silently dropping a part we do not understand would destroy a
 * genuine reply. Only the types listed here are ever treated as non-content.
 */

/** TBAi's UI-only progress part (server-written, rendered by `TodoList`). */
export const TBAI_PROGRESS_PART_TYPE = "data-tbai-progress";

/**
 * Part types that carry no visible reply of their own. `step-start` is a
 * multi-step boundary marker, not something a user reads.
 */
const NON_CONTENT_PART_TYPES: ReadonlySet<string> = new Set(["step-start"]);

type UnknownPart = { type?: unknown; data?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A progress part shows a panel only when it has at least one stage. */
function progressPartRenders(part: UnknownPart): boolean {
  const stages = isRecord(part.data) ? part.data.stages : undefined;
  return Array.isArray(stages) && stages.length > 0;
}

/**
 * True when this stored message content would render a visible reply.
 *
 * A payload that is not shaped like a message at all is treated as content
 * (fail open), so an unexpected envelope is persisted rather than dropped.
 */
export function hasRenderableAssistantContent(content: unknown): boolean {
  if (!isRecord(content)) return true;
  const parts = content.parts;
  // No parts array: not a shape we understand, so keep it.
  if (!Array.isArray(parts)) return true;
  if (parts.length === 0) return false;

  return parts.some((raw) => {
    if (!isRecord(raw)) return true;
    const type = raw.type;
    // A part with no type is not something we can classify — keep it.
    if (typeof type !== "string") return true;
    if (NON_CONTENT_PART_TYPES.has(type)) return false;
    if (type === TBAI_PROGRESS_PART_TYPE) return progressPartRenders(raw);
    return true;
  });
}

/**
 * True when this is an assistant message with nothing worth persisting yet.
 *
 * Deliberately role-scoped: a user turn is always persisted, however short, and
 * an empty user turn is legitimate (an attachment-only prompt).
 */
export function isContentlessAssistantMessage(content: unknown): boolean {
  if (!isRecord(content)) return false;
  if (content.role !== "assistant") return false;
  return !hasRenderableAssistantContent(content);
}
