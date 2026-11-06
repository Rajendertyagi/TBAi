import { createResumableSessionStorage, type ResumableClientStorage } from "@assistant-ui/ai-sdk";

const DIRECT_RESUME_KEY_PREFIX = "tbai-resume:";

/** Return the stable Direct-chat resumable-storage key for a thread. */
export function directResumeStorageKey(threadId: string): string {
  return `${DIRECT_RESUME_KEY_PREFIX}${threadId}`;
}

/**
 * Conversations whose history load has settled this session.
 *
 * A resumable pointer read stays suppressed until then, so the runtime cannot
 * resume a stream against a thread whose stored rows have not been imported
 * yet: the slow-load race let the arriving history clobber a resumed reply.
 * Resets with the module, which is exactly the reload this protects.
 */
const settledHistory = new Set<string>();
const settledListeners = new Set<{
  listener: () => void;
  threadId: string | undefined;
}>();

/**
 * Record that a conversation's history load finished, successfully or not.
 * A failure settles too: the runtime must not wait for a load that already
 * ended, and a finished load has nothing left to clobber.
 */
export function markDirectHistorySettled(threadId: string): void {
  if (!threadId || settledHistory.has(threadId)) return;
  settledHistory.add(threadId);
  for (const entry of settledListeners) {
    if (entry.threadId !== undefined && entry.threadId !== threadId) continue;
    try {
      entry.listener();
    } catch {
      // One failing subscriber must not hide the settled state from the rest.
    }
  }
}

function createInnerDirectStorage(getThreadId: () => string | undefined): ResumableClientStorage {
  return createResumableSessionStorage({
    key: () => {
      const threadId = getThreadId();
      return threadId ? directResumeStorageKey(threadId) : undefined;
    },
  });
}

/**
 * Create the per-thread storage used by the Direct assistant-ui transport.
 * The getter is evaluated lazily so an unmaterialized draft never reads or
 * writes another conversation's stream pointer.
 *
 * Reads that name a thread are gated on that conversation's history having
 * settled. Only the runtime's own reads pass a thread id; the transport's
 * internal checkpoint bookkeeping reads without one and must keep working
 * while the gate is closed. Writes are never gated, so a send during the load
 * window still records its stream id.
 */
export function createDirectResumableStorage(
  getThreadId: () => string | undefined,
): ResumableClientStorage {
  const inner = createInnerDirectStorage(getThreadId);
  return {
    getStreamId(threadId?: string) {
      if (threadId && !settledHistory.has(threadId)) return null;
      return inner.getStreamId(threadId);
    },
    setStreamId(id: string, threadId?: string) {
      inner.setStreamId(id, threadId);
    },
    clear(threadId?: string) {
      inner.clear(threadId);
    },
    subscribe(listener: () => void, threadId?: string) {
      const unsubscribe = inner.subscribe?.(listener, threadId) ?? (() => {});
      const entry = { listener, threadId };
      settledListeners.add(entry);
      return () => {
        unsubscribe();
        settledListeners.delete(entry);
      };
    },
  };
}

/** Read a Direct stream pointer without duplicating session-storage protocol. */
export function readDirectResumableStreamId(threadId: string | null | undefined): string | null {
  if (!threadId) return null;
  try {
    return createInnerDirectStorage(() => threadId).getStreamId(threadId);
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
