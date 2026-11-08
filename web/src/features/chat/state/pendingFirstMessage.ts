/**
 * Pending first-prompt handoff for OpenCode drafts.
 *
 * Owns exactly one invariant: a materialized OpenCode draft has AT MOST ONE
 * pending first-prompt handoff, fired EXACTLY ONCE into the session-bound
 * OpenCode runtime - never duplicated into SQLite history, never replayed.
 *
 * Lifecycle:
 *   custom draft send -> setPendingFirstMessage(conversationId, text)
 *   Code surface binds session -> claimPendingFirstMessage (claims, and
 *                                         allocates the message id)
 *   runtime accepts the prompt -> clearPendingFirstMessage (consumed)
 *
 * ## THE MESSAGE ID IS THE PROMPT'S IDENTITY
 *
 * The id is allocated WITH the claim, in one write, BEFORE the dispatch. That
 * is what makes the handoff recoverable: a crash between the claim and the
 * dispatch leaves an entry that the next mount can resume, and the resume
 * carries the SAME id.
 *
 * The server is idempotent by that id, so a resumed dispatch is the SAME
 * prompt and not a second one. Upstream `Session.prompt` admits a repeated
 * message id as the existing prompt: `SessionInbox.admit` reconciles by id
 * first, and a prompt that was already promoted to a message is found again
 * by the same lookup. The client therefore does not have to guess whether the
 * server took a prompt - it can ask, and the answer is the same prompt.
 *
 * ## WHAT THE TWO FLAGS MEAN
 *
 * - `claimed` - a dispatch was started. The entry survives a crash, so the
 *   next mount can resume it.
 * - `failed` - the dispatch failed. The entry is NEVER dispatched again
 *   automatically: the user decides, by sending again. A dispatch that
 *   failed may have reached the server, and re-sending it on the user's
 *   behalf is how a message gets delivered twice.
 */

export interface PendingFirstPrompt {
  text: string;
  createdAt: number;
  /** A dispatch was started for this entry. */
  claimed: boolean;
  /**
   * The prompt's identity on the server, allocated with the claim.
   *
   * Every dispatch of this entry carries it, so a resumed dispatch is the
   * same prompt server-side rather than a second one.
   */
  messageId?: string;
  /**
   * The dispatch failed.
   *
   * A failed entry is never dispatched automatically again. The user's next
   * send replaces it.
   */
  failed?: boolean;
}

const KEY_PREFIX = "tbai:pending-first-prompt:";

function keyFor(conversationId: string): string {
  return `${KEY_PREFIX}${conversationId}`;
}

/**
 * The id a fresh handoff is dispatched under.
 *
 * A local, OpenCode-shaped message id. The server's own id generator is not
 * used: the client must be able to re-derive the SAME id after a reload,
 * which is what makes the resume safe.
 */
export function createPendingFirstMessageId(): string {
  return `msg_pending_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function readEntry(conversationId: string): PendingFirstPrompt | null {
  try {
    const raw = localStorage.getItem(keyFor(conversationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingFirstPrompt>;
    if (typeof parsed.text !== "string" || parsed.text.length === 0) return null;
    return {
      text: parsed.text,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      claimed: parsed.claimed === true,
      ...(typeof parsed.messageId === "string" ? { messageId: parsed.messageId } : {}),
      ...(parsed.failed === true ? { failed: true } : {}),
    };
  } catch {
    return null;
  }
}

function writeEntry(conversationId: string, entry: PendingFirstPrompt): void {
  try {
    localStorage.setItem(keyFor(conversationId), JSON.stringify(entry));
  } catch {
    /* storage blocked - handoff stays memory-only for this mount */
  }
}

/**
 * Stage the first prompt for a materialized conversation. Single slot:
 * overwrites any existing entry (at most one handoff per conversation).
 * Empty text is a no-op (nothing to hand off).
 */
export function setPendingFirstMessage(conversationId: string, text: string): void {
  if (!conversationId || !text) return;
  writeEntry(conversationId, { text, createdAt: Date.now(), claimed: false });
}

/** Inspect without consuming (null when none/corrupt/empty). */
export function peekPendingFirstMessage(conversationId: string): PendingFirstPrompt | null {
  if (!conversationId) return null;
  return readEntry(conversationId);
}

/**
 * Claims the handoff for dispatch, and allocates its message id.
 *
 * The claim and the id are written TOGETHER, before the caller dispatches, so
 * a crash between the two cannot leave a claim with no identity: a claim
 * without an id is a claim that can only be dropped, and dropping it loses the
 * reader's message (M13).
 *
 * A FAILED entry is never claimed: the dispatch failed, the user decides
 * whether to send again, and an automatic re-dispatch would be a second
 * delivery of a prompt the server may already have (M19).
 *
 * An already-claimed entry IS claimable: that is the resume path. Whether a
 * dispatch is in flight right now is the caller's business - only one
 * dispatch at a time, and this module is the storage, not the scheduler.
 *
 * @param conversationId - The conversation that owns the stashed prompt.
 * @returns The text and the id to dispatch it under, or null when there is
 * nothing to dispatch.
 */
export function claimPendingFirstMessage(
  conversationId: string,
): { readonly text: string; readonly messageId: string } | null {
  if (!conversationId) return null;
  const entry = readEntry(conversationId);
  if (!entry || entry.failed) return null;
  const messageId = entry.messageId ?? createPendingFirstMessageId();
  writeEntry(conversationId, { ...entry, claimed: true, messageId });
  return { text: entry.text, messageId };
}

/**
 * Marks a failed dispatch, so it is never dispatched again automatically.
 *
 * @param conversationId - The conversation that owns the stashed prompt.
 */
export function markPendingFirstMessageFailed(conversationId: string): void {
  if (!conversationId) return;
  const entry = readEntry(conversationId);
  if (!entry) return;
  writeEntry(conversationId, { ...entry, failed: true });
}

/** Drop the handoff after the runtime accepted it. Idempotent. */
export function clearPendingFirstMessage(conversationId: string): void {
  if (!conversationId) return;
  try {
    localStorage.removeItem(keyFor(conversationId));
  } catch {
    /* ignore */
  }
}
