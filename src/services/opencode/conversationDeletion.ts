/**
 * Conversation deletion for OpenCode rows (RT-011).
 *
 * A conversation row is the only in-memory handle to its remote session. Tearing
 * the row down before the session is gone orphans it: nothing durable names the
 * id any more. This coordinator therefore arms a durable delete marker BEFORE
 * any remote call, terminates only the exact session the request observed, and
 * deletes the row only while no session is bound.
 *
 * The marker distinguishes two very different failures:
 *  - preservation failure (journal write throws or does not land) -> 503, and
 *    nothing is deleted;
 *  - remote removal failure (unconfirmed, inconclusive, unreachable) -> the
 *    marker is the durable handle, so the conversation may still be deleted
 *    (Option A).
 *
 * The request-entry snapshot is authoritative. A pointer that changes after the
 * request started is never overwritten: the row is preserved and the route
 * answers 409. Direct-engine rows never reach this module; the route keeps
 * their existing deletion path.
 */
import { logger } from "../../lib/logger";
import { classifyError } from "../../lib/errors";
import { conversationService } from "../storage";
import { resolveConversationWorkspace } from "../workspace";
import { opencodeOrphanService } from "../storage/opencodeSessionOrphans";
import { terminateSessionForConversationDeletion } from "./sessions";

/** What the DELETE request observed when it began. */
export interface OpenCodeDeletionEntry {
  engine: string | null;
  opencodeSessionId: string | null;
}

export type SessionCleanup = "removed" | "retained" | "none";

export type OpenCodeConversationDeletionOutcome =
  | { kind: "deleted"; sessionCleanup: SessionCleanup }
  | { kind: "missing"; sessionCleanup: SessionCleanup }
  | { kind: "conflict"; reason: "session_rebound" }
  | {
      kind: "unavailable";
      reason: "journal_unavailable" | "settlement_failed" | "termination_missing";
    };

/**
 * Deletes an OpenCode conversation under the Option A contract.
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
  let armed = false;
  let directory: string | null = null;

  // Journal BEFORE the first decision read. The session id comes only from the
  // entry snapshot, so a pointer that changes in this window cannot suppress
  // the durable handle for the session this request observed.
  if (expectedSessionId !== null) {
    directory = await resolveDirectory(conversationId);
    try {
      armed = await opencodeOrphanService.recordDeletionIntent({
        conversationId,
        sessionId: expectedSessionId,
        locationDirectory: directory,
      });
    } catch (error) {
      logger.error("opencode", "opencode.conversation_delete_arm_failed", {
        conversationId,
        ...classifyError(error),
      });
      return { kind: "unavailable", reason: "journal_unavailable" };
    }
    if (!armed) {
      logger.error("opencode", "opencode.conversation_delete_arm_unconfirmed", {
        conversationId,
      });
      return { kind: "unavailable", reason: "journal_unavailable" };
    }
  }

  const current = await conversationService.get(conversationId);
  if (!current) return finishMissing(conversationId, armed);
  if (current.engine !== "opencode" || current.opencodeSessionId !== expectedSessionId) {
    return recoverWithoutTermination(conversationId, expectedSessionId, armed);
  }
  if (expectedSessionId === null) {
    return recoverWithoutTermination(conversationId, null, armed);
  }

  let remote: Awaited<ReturnType<typeof terminateSessionForConversationDeletion>>;
  try {
    remote = await terminateSessionForConversationDeletion({
      conversationId,
      expectedSessionId,
      directory,
    });
  } catch (error) {
    logger.error("opencode", "opencode.conversation_delete_terminate_threw", {
      conversationId,
      ...classifyError(error),
    });
    return { kind: "unavailable", reason: "settlement_failed" };
  }

  if (remote.outcome === "missing") {
    // The row existed when the marker was armed; a concurrent delete is not a
    // reason to lose the marker, but completing normally would claim a teardown
    // this request did not perform.
    logger.warn("opencode", "opencode.conversation_delete_row_vanished", {
      conversationId,
    });
    return { kind: "unavailable", reason: "termination_missing" };
  }
  if (remote.outcome === "blocked") {
    return recoverWithoutTermination(conversationId, expectedSessionId, true);
  }

  if (remote.outcome === "removed") {
    let settled: Awaited<ReturnType<typeof opencodeOrphanService.settleConfirmedDeletion>>;
    try {
      settled = await opencodeOrphanService.settleConfirmedDeletion({
        conversationId,
        sessionId: expectedSessionId,
        at: Date.now(),
      });
    } catch (error) {
      logger.error("opencode", "opencode.conversation_delete_settle_failed", {
        conversationId,
        ...classifyError(error),
      });
      return { kind: "unavailable", reason: "settlement_failed" };
    }
    if (settled === "absent") {
      logger.error("opencode", "opencode.conversation_delete_marker_missing", {
        conversationId,
      });
      return { kind: "unavailable", reason: "settlement_failed" };
    }
    return finalizeDeletion(conversationId, expectedSessionId, "removed");
  }

  // Unconfirmed, inconclusive or unreachable: keep the durable handle, then
  // delete anyway (Option A). A failure to re-affirm the marker is structural:
  // the caller must not delete without a trustworthy obligation.
  let retained: boolean;
  try {
    retained = await opencodeOrphanService.retainDeletionAfterFailedRemoval({
      conversationId,
      sessionId: expectedSessionId,
      at: Date.now(),
      locationDirectory: directory,
    });
  } catch (error) {
    logger.error("opencode", "opencode.conversation_delete_retain_failed", {
      conversationId,
      outcome: remote.outcome,
      ...classifyError(error),
    });
    return { kind: "unavailable", reason: "settlement_failed" };
  }
  if (!retained) {
    logger.error("opencode", "opencode.conversation_delete_retain_unconfirmed", {
      conversationId,
      outcome: remote.outcome,
    });
    return { kind: "unavailable", reason: "settlement_failed" };
  }
  logger.warn("opencode", "opencode.conversation_delete_cleanup_retained", {
    conversationId,
    outcome: remote.outcome,
  });
  return finalizeDeletion(conversationId, expectedSessionId, "retained");
}

async function resolveDirectory(conversationId: string): Promise<string | null> {
  try {
    const resolved = await resolveConversationWorkspace(conversationId);
    return resolved.dir;
  } catch (error) {
    // The directory is a cleanup scope hint, not a precondition. Journaling
    // still proceeds with an unknown scope; the remote can be probed without it.
    logger.warn("opencode", "opencode.conversation_delete_directory_unresolved", {
      conversationId,
      ...classifyError(error),
    });
    return null;
  }
}

/**
 * Recovery for a request that did not terminate the entry session: a null
 * pointer is deletable, a pointer that remains is preserved.
 *
 * The pointer check is engine-independent: a request that entered through the
 * OpenCode branch must never delete a row whose new binding it did not own.
 */
async function recoverWithoutTermination(
  conversationId: string,
  expectedSessionId: string | null,
  armed: boolean,
): Promise<OpenCodeConversationDeletionOutcome> {
  const cleanup: SessionCleanup = armed ? "retained" : "none";
  const latest = await conversationService.get(conversationId);
  if (!latest) return finishMissing(conversationId, armed);
  if (latest.opencodeSessionId !== null) {
    return { kind: "conflict", reason: "session_rebound" };
  }
  return finalizeDeletion(conversationId, expectedSessionId, cleanup);
}

/**
 * Conditional teardown. An already-null pointer after a failed compare-and-set
 * is a valid state (another operation cleared it), not a storage fault: it
 * proceeds to the deletion transaction. A non-null pointer is preserved.
 */
async function finalizeDeletion(
  conversationId: string,
  expectedSessionId: string | null,
  cleanup: SessionCleanup,
): Promise<OpenCodeConversationDeletionOutcome> {
  if (expectedSessionId !== null) {
    const cleared = await conversationService.clearOpenCodeSessionPointer(
      conversationId,
      expectedSessionId,
    );
    if (!cleared) {
      const latest = await conversationService.get(conversationId);
      if (!latest) return finishMissing(conversationId, cleanup !== "none");
      if (latest.opencodeSessionId !== null) {
        return { kind: "conflict", reason: "session_rebound" };
      }
    }
  }

  const result = await conversationService.deleteIfNoOpenCodeSession(conversationId);
  if (result === "deleted") return { kind: "deleted", sessionCleanup: cleanup };
  if (result === "rebound") return { kind: "conflict", reason: "session_rebound" };
  return { kind: "missing", sessionCleanup: cleanup };
}

async function finishMissing(
  conversationId: string,
  armed: boolean,
): Promise<OpenCodeConversationDeletionOutcome> {
  await conversationService.deleteIfNoOpenCodeSession(conversationId);
  return { kind: "missing", sessionCleanup: armed ? "retained" : "none" };
}
