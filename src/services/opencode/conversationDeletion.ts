/**
 * Conversation deletion for OpenCode rows — local-only teardown.
 *
 * Deleting a TBAi conversation removes only TBAi's local conversation and
 * messages. It never issues a remote OpenCode request: the shared OpenCode
 * session and its children remain in OpenCode for the user to manage there.
 * No durable delete marker is armed, because there is no remote cleanup to
 * account for.
 *
 * The request-entry snapshot is authoritative. A pointer that changes after
 * the request started is never overwritten: the row is preserved and the
 * route answers 409. Direct-engine rows never reach this module; the route
 * keeps their existing deletion path.
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
  const expectedSessionId = entry.opencodeSessionId;

  const current = await conversationService.get(conversationId);
  if (!current) return finishMissing(conversationId);
  if (current.engine !== "opencode" || current.opencodeSessionId !== expectedSessionId) {
    return recoverWithoutTermination(conversationId, expectedSessionId);
  }
  return finalizeDeletion(conversationId, expectedSessionId);
}

/**
 * Recovery for a request that did not delete the entry session: a null pointer
 * is deletable, a pointer that remains is preserved. The pointer check is
 * engine-independent: a request that entered through the OpenCode branch must
 * never delete a row whose new binding it did not own.
 */
async function recoverWithoutTermination(
  conversationId: string,
  expectedSessionId: string | null,
): Promise<OpenCodeConversationDeletionOutcome> {
  const latest = await conversationService.get(conversationId);
  if (!latest) return finishMissing(conversationId);
  if (latest.opencodeSessionId !== null) {
    return { kind: "conflict", reason: "session_rebound" };
  }
  return finalizeDeletion(conversationId, expectedSessionId);
}

/**
 * Conditional teardown. An already-null pointer after a failed compare-and-set
 * is a valid state (another operation cleared it), not a storage fault: it
 * proceeds to the deletion transaction. A non-null pointer is preserved.
 */
async function finalizeDeletion(
  conversationId: string,
  expectedSessionId: string | null,
): Promise<OpenCodeConversationDeletionOutcome> {
  if (expectedSessionId !== null) {
    const cleared = await conversationService.clearOpenCodeSessionPointer(
      conversationId,
      expectedSessionId,
    );
    if (!cleared) {
      const latest = await conversationService.get(conversationId);
      if (!latest) return finishMissing(conversationId);
      if (latest.opencodeSessionId !== null) {
        return { kind: "conflict", reason: "session_rebound" };
      }
    }
  }

  const result = await conversationService.deleteIfNoOpenCodeSession(conversationId);
  if (result === "deleted") return { kind: "deleted", sessionCleanup: "none" };
  if (result === "rebound") return { kind: "conflict", reason: "session_rebound" };
  return { kind: "missing", sessionCleanup: "none" };
}

async function finishMissing(
  conversationId: string,
): Promise<OpenCodeConversationDeletionOutcome> {
  await conversationService.deleteIfNoOpenCodeSession(conversationId);
  return { kind: "missing", sessionCleanup: "none" };
}
