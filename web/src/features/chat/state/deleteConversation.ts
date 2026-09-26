import { useCallback } from "react";
import { logger } from "@/lib/logger";
import { useChatTabsStore } from "./chatTabs";
import { readDirectResumableStreamId } from "./resumable-stream";

/** Authoritative result of server-side conversation teardown. No UI inside. */
export interface DeleteConversationResult {
  conversationId: string;
  /** A locally-tracked run was found and a server cancel was issued. */
  runCancelled: boolean;
  /** The managed OpenCode session was terminated (false = nothing to do). */
  opencodeTerminated: boolean;
}

/**
 * Issues the explicit server cancel for a Direct thread's resumable run, if
 * this tab tracks one. The storage helper owns the session-storage protocol;
 * this function only performs the server-side cancellation.
 *
 * @param threadKey - thread remoteId (bound) or runtime id; null when unknown.
 */
export async function cancelActiveRun(
  threadKey: string | null | undefined,
): Promise<boolean> {
  const streamId = readDirectResumableStreamId(threadKey);
  if (!streamId) return false;
  try {
    // Cancellation is a lifecycle event, not just cleanup: it ends a run whose
    // server side would otherwise keep burning tokens. Logged before the call
    // so the request exists in the timeline even if the response never lands.
    logger.info("chat", "run.cancel_requested", { streamId });
    const res = await fetch(
      `/api/chat/cancel/${encodeURIComponent(streamId)}`,
      { method: "POST" },
    );
    if (!res.ok) {
      logger.warn("chat", "run.cancel_rejected", { streamId, status: res.status });
    }
    return res.ok;
  } catch (err) {
    logger.warn("chat", "run_cancel_failed", {
      streamId,
      errorType: err instanceof Error ? err.name : typeof err,
    });
    return false;
  }
}

/**
 * Canonical server/domain conversation teardown. Owns authoritative cleanup
 * ONLY, in fixed order:
 *   1. cancel a locally-tracked active run (server-owned work must not
 *      outlive the delete);
 *   2. best-effort terminate/invalidate the OpenCode session (never blocks);
 *   3. delete the conversation row + messages (authoritative; throws).
 *
 * Never touches tabs, routes, or runtime state — the UI layer
 * (`useDeleteConversation`) consumes the result for those, keeping domain and
 * projection structurally separate. Idempotent: absent runs, sessions, and
 * rows (404) resolve as already-complete. Throws ONLY when the authoritative
 * row delete fails; callers must surface that (nothing was removed).
 *
 * @param ref - conversation id (remoteId) being deleted.
 */
export async function deleteConversation(
  ref: string,
): Promise<DeleteConversationResult> {
  const runCancelled = await cancelActiveRun(ref);

  let opencodeTerminated = false;
  try {
    const res = await fetch("/api/opencode/session/terminate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: ref }),
    });
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        terminated?: boolean;
      };
      opencodeTerminated = data.terminated === true;
    } else {
      logger.debug("chat", "opencode_terminate_skipped", {
        threadId: ref,
        status: res.status,
      });
    }
  } catch (err) {
    logger.debug("chat", "opencode_terminate_skipped", {
      threadId: ref,
      errorType: err instanceof Error ? err.name : typeof err,
    });
  }

  const res = await fetch(`/api/conversations/${ref}`, { method: "DELETE" });
  // 404 means already gone (repeat call or raced delete): the desired end
  // state holds, so resolve. Any other failure rejects — local state must not
  // claim a deletion the server refused.
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to delete conversation (${res.status})`);
  }
  return { conversationId: ref, runCancelled, opencodeTerminated };
}

/**
 * UI-side deletion flow (projection layer). Runs the server coordinator,
 * then closes every tab bound to the conversation on both surfaces. Route
 * correction follows structurally through TabUrlSync reacting to the
 * active-key change, so this hook never navigates. Rejects with the
 * coordinator error for the caller to surface.
 */
export function useDeleteConversation(): (
  ref: string,
) => Promise<DeleteConversationResult> {
  return useCallback(async (ref: string) => {
    const result = await deleteConversation(ref);
    useChatTabsStore.getState().closeByRef(ref);
    return result;
  }, []);
}
