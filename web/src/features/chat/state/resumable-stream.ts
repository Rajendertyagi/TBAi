import {
  createResumableSessionStorage,
  type ResumableClientStorage,
} from "@assistant-ui/ai-sdk";

const DIRECT_RESUME_KEY_PREFIX = "tbai-resume:";

/** Return the stable Direct-chat resumable-storage key for a thread. */
export function directResumeStorageKey(threadId: string): string {
  return `${DIRECT_RESUME_KEY_PREFIX}${threadId}`;
}

/**
 * Create the per-thread storage used by the Direct assistant-ui transport.
 * The getter is evaluated lazily so an unmaterialized draft never reads or
 * writes another conversation's stream pointer.
 */
export function createDirectResumableStorage(
  getThreadId: () => string | undefined,
): ResumableClientStorage {
  return createResumableSessionStorage({
    key: () => {
      const threadId = getThreadId();
      return threadId ? directResumeStorageKey(threadId) : undefined;
    },
  });
}

/** Read a Direct stream pointer without duplicating session-storage protocol. */
export function readDirectResumableStreamId(
  threadId: string | null | undefined,
): string | null {
  if (!threadId) return null;
  try {
    return createDirectResumableStorage(() => threadId).getStreamId(threadId);
  } catch {
    return null;
  }
}

/**
 * Last stream id the transport recorded per thread, kept after the transport
 * clears its own pointer.
 *
 * Needed because the two events arrive in the wrong order for recovery: the
 * transport stores the id when a send's response headers arrive, and clears it
 * when that send fails — but the failure is only *reported* afterwards, by which
 * time `getStreamId` already returns null. Observed live: without this, a backend
 * that dies mid-reply produced no recovery state at all, because the only id had
 * been thrown away a moment before we needed it.
 *
 * Bounded by the threads the user actually visits, and cleared on a successful
 * send, so it never accumulates a stale id per conversation.
 */
const lastKnownStreamId = new Map<string, string>();

/** Record the id for a thread; called from the storage subscription. */
export function rememberStreamId(threadId: string, streamId: string | null): void {
  if (streamId) lastKnownStreamId.set(threadId, streamId);
}

/** The id the transport most recently recorded for a thread, if any. */
export function lastRememberedStreamId(threadId: string): string | null {
  return lastKnownStreamId.get(threadId) ?? null;
}

/** Forget a thread's id once its run is no longer in doubt. */
export function forgetRememberedStreamId(threadId: string): void {
  lastKnownStreamId.delete(threadId);
}
