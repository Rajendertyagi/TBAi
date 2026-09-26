/**
 * Pending first-prompt handoff for OpenCode drafts (Phase 4).
 *
 * Owns exactly one invariant: a materialized OpenCode draft has AT MOST ONE
 * pending first-prompt handoff, fired EXACTLY ONCE into the session-bound
 * OpenCode runtime — never duplicated into SQLite history, never replayed.
 *
 * Lifecycle:
 *   custom draft send → setPendingFirstMessage(conversationId, text)
 *   Code surface binds session → claimPendingFirstMessage (marks claimed)
 *   runtime.thread.append(text) → clearPendingFirstMessage (consumed)
 *
 * The claim flag makes consumption idempotent across remounts/reconnects: a
 * second consumer finds the entry claimed (or gone) and never refires. A
 * synchronous append failure unclaims so a later attempt may fire it; async
 * prompt failures surface in-thread (error card) and the user retries
 * explicitly — failed prompts are never auto-resubmitted. Persisted in
 * localStorage (message text only, never credentials) so a refresh mid-
 * handoff still delivers the live user action exactly once.
 */

export interface PendingFirstPrompt {
  text: string;
  createdAt: number;
  claimed: boolean;
  /** Stable native V2 message id, allocated before the append is dispatched. */
  messageId?: string;
}

const KEY_PREFIX = "tbai:pending-first-prompt:";

function keyFor(conversationId: string): string {
  return `${KEY_PREFIX}${conversationId}`;
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
    };
  } catch {
    return null;
  }
}

function writeEntry(conversationId: string, entry: PendingFirstPrompt): void {
  try {
    localStorage.setItem(keyFor(conversationId), JSON.stringify(entry));
  } catch {
    /* storage blocked — handoff stays memory-only for this mount */
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

/** Persists the native message id before dispatching the claimed handoff. */
export function setPendingFirstMessageIdentity(conversationId: string, messageId: string): void {
  if (!conversationId || !messageId) return;
  const entry = readEntry(conversationId);
  if (!entry) return;
  writeEntry(conversationId, { ...entry, messageId });
}

/** Inspect without consuming (null when none/corrupt/empty). */
export function peekPendingFirstMessage(conversationId: string): PendingFirstPrompt | null {
  if (!conversationId) return null;
  return readEntry(conversationId);
}

/**
 * Atomically claim the handoff for sending. Returns the text to send, or
 * null when there is nothing to fire (none, already claimed, or empty).
 * The claim persists before the caller appends, so a remount between claim
 * and clear cannot refire the same prompt.
 */
export function claimPendingFirstMessage(conversationId: string): string | null {
  if (!conversationId) return null;
  const entry = readEntry(conversationId);
  if (!entry || entry.claimed) return null;
  writeEntry(conversationId, { ...entry, claimed: true });
  return entry.text;
}

/** Release a claim without sending (synchronous append failure path). */
export function unclaimPendingFirstMessage(conversationId: string): void {
  if (!conversationId) return;
  const entry = readEntry(conversationId);
  if (!entry) return;
  writeEntry(conversationId, { ...entry, claimed: false });
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
