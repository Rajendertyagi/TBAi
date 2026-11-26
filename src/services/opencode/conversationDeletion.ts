/**
 * Conversation deletion for OpenCode rows — local-only teardown.
 *
 * Deleting a TBAi conversation removes only TBAi's local conversation and
 * messages. It never issues a remote OpenCode request: the shared OpenCode
 * session and its children remain in OpenCode for the user to manage there.
 *
 * The pointer comparison, row delete and message delete run in ONE SQLite
 * transaction (`deleteConversationIfSessionMatches`). A failure at any step
 * rolls everything back, so the conversation keeps its session association.
 * A pointer that changed after the request started is never overwritten: the
 * row is preserved and the route answers 409. Direct-engine rows never reach
 * this module; the route keeps their existing deletion path.
 */
import { conversationService } from "../storage";

/** What the DELETE request observed when it began. */
export interface OpenCodeDeletionEntry {
  engine: string | null;
  opencodeSessionId: string | null;
}

/** No remote cleanup is performed, so there is nothing to settle. */
export type SessionCleanup = "none";

export type OpenCodeConversationDeletionOutcome =
  | { kind: "deleted"; sessionCleanup: SessionCleanup }
  | { kind: "missing"; sessionCleanup: SessionCleanup }
  | { kind: "conflict"; reason: "session_rebound" };

/**
 * Deletes an OpenCode conversation locally.
 *
 * @returns The outcome the route maps to HTTP. Never throws for expected
 *   lifecycle failures; unexpected storage errors propagate to the caller.
 */
export async function deleteOpenCodeConversation(input: {
  conversationId: string;
  entry: OpenCodeDeletionEntry;
}): Promise<OpenCodeConversationDeletionOutcome> {
  const { conversationId, entry } = input;

  const current = await conversationService.get(conversationId);
  if (current && current.engine !== "opencode") {
    return { kind: "conflict", reason: "session_rebound" };
  }

  const result = await conversationService.deleteConversationIfSessionMatches(
    conversationId,
    entry.opencodeSessionId,
  );
  if (result === "deleted") return { kind: "deleted", sessionCleanup: "none" };
  if (result === "rebound") return { kind: "conflict", reason: "session_rebound" };
  return { kind: "missing", sessionCleanup: "none" };
}
