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
 *
 * A failed run is the one exception to "contentless is not a reply": the turn
 * produced nothing to read, but the sanitized provider error IS what the reader
 * has to see, and it lives in `metadata.error`. That field is declared here for
 * the same reason as the part types above — the writer (the chat route), the
 * storage guard (the message POST), and the reload renderer all have to agree on
 * one spelling, and the browser reads it as `metadata.custom.error`.
 */

/** TBAi's UI-only progress part (server-written, rendered by `TodoList`). */
export const TBAI_PROGRESS_PART_TYPE = "data-tbai-progress";

/**
 * TBAi's compaction divider part, as stored in history.
 *
 * The AI SDK's on-the-wire form (`data-tbai-*`), the same envelope every other
 * TBAi-owned part uses — not assistant-ui's internal `{ type: "data", name }`.
 *
 * It is PRESENTATION, not message text, and that distinction is load-bearing in two
 * places. The browser's history adapter strips it before persisting
 * (`web/src/adapters/threadHistoryAdapter.ts`), so a stored row that lacks it and a
 * captured stream message that carries it describe the SAME message — comparing
 * them literally would rewrite a row the client legitimately owns. It is declared
 * here, in the module that already owns TBAi's part-type vocabulary for persisted
 * messages, so the route that writes the divider and the storage layer that
 * compares it cannot drift.
 */
export const COMPACT_DIVIDER_PART_TYPE = "data-tbai-compact";

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
  // A failed turn renders its error card even with no parts at all, so it is
  // content by this module's own definition.
  if (storedErrorMessage(content) !== null) return true;
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

/**
 * Where a failed run's sanitized user-facing error is stored, as the runtime's
 * own message metadata (`{ role, parts, metadata: { error } }`).
 *
 * It is NOT `status`. A stored `status` is dropped by the assistant-ui AI SDK
 * converter on the way in — only a synthesized `cancelled` survives — so a
 * persisted status would be lost on reload. Metadata is carried through: the
 * converter folds any key it does not recognise into `metadata.custom`, which is
 * why the browser reads `message.metadata.custom.error`.
 *
 * The value is a string because it comes from `sanitizeStreamError`, which
 * already replaced provider prose with fixed, user-facing copy. Nothing raw is
 * ever written here, and the string is what the reader sees on both paths: live
 * (from the stream's error status) and after a reload (from this field).
 */
export const MESSAGE_ERROR_METADATA_KEY = "error";

/**
 * The stored error text for a message, or null when it carries none.
 *
 * Deliberately strict about the value being a NON-EMPTY string: `{ error: "" }`
 * and `{ error: {} }` describe no failure a reader could act on, and treating
 * them as an error would let an empty row claim the "has an error" rule that
 * makes an otherwise contentless turn persistable.
 */
export function storedErrorMessage(content: unknown): string | null {
  if (!isRecord(content)) return null;
  const metadata = content.metadata;
  if (!isRecord(metadata)) return null;
  // Two spellings describe the same fact, because the message crosses the
  // assistant-ui converter in both directions.
  //
  // `metadata.error` is what the server writes (the AI SDK message's own
  // metadata). The converter folds every key it does not recognise into
  // `custom`, so the browser reads `metadata.custom.error`; a message the
  // browser then writes back carries that folded shape instead. Recognising only
  // one spelling would make a reloaded error row look like a row with no error
  // to every writer and guard that runs after it.
  const direct = metadata[MESSAGE_ERROR_METADATA_KEY];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const custom = metadata.custom;
  if (!isRecord(custom)) return null;
  const folded = custom[MESSAGE_ERROR_METADATA_KEY];
  return typeof folded === "string" && folded.length > 0 ? folded : null;
}

/** True when this stored message body carries a failed run's error text. */
export function hasStoredErrorMetadata(content: unknown): boolean {
  return storedErrorMessage(content) !== null;
}
