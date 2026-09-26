/**
 * Per-session Auto Approval policy — a synchronous runtime projection.
 *
 * **KEYED BY THE OPENCODE SESSION ID, NOT THE CONVERSATION ID.** The live
 * native permission event boundary has no conversation id in scope. What it
 * does have — because the runtime client is built from it — is the OpenCode
 * `sessionId`. Keying by anything the
 * event path cannot read would mean inventing a lookup, so the cache is keyed by
 * the identity the runtime genuinely owns.
 *
 * WHY A CACHE AT ALL. The permission decision must be made **at event time**, and
 * the event generator runs **outside the React tree**. A component-scoped source
 * (a ref in a view, a hook result) is only current if a render happened to have
 * run first, which makes it structurally fragile. This is a plain, synchronous,
 * module-level lookup any code can read without React.
 *
 * IT IS A CACHE, NOT THE SOURCE OF TRUTH. The authoritative value remains
 * `conversation.opencodeAutoApprove`, persisted through the existing
 * `/api/conversations` path. This module exists only so the non-React event
 * generator can read the current policy without waiting for a render.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: no React, no OpenCode transport, no reply
 * logic, no UI, no persistence of its own, no rule engine. It maps one session id
 * to one boolean.
 *
 * FAIL CLOSED. An unknown or absent session reads `false` (manual). A missing
 * entry must never auto-approve anything, so the failure mode is always "ask the
 * user". A runtime without a session id can never be armed.
 */

/** OpenCode sessionId → shield enabled. Module-level: readable outside React. */
const policies = new Map<string, boolean>();

/**
 * Records the policy for one OpenCode session.
 *
 * Called from the **same operation** that persists the conversation config, so
 * the cache cannot lag the write by a render. Also used when hydrating the value
 * from the server.
 *
 * @param sessionId - The OpenCode session that owns this runtime.
 * @param enabled - The shield position.
 */
export function setAutoPolicy(sessionId: string, enabled: boolean): void {
  policies.set(sessionId, enabled === true);
}

/**
 * Reads the policy for one OpenCode session, **synchronously**.
 *
 * @param sessionId - The runtime's session id, or undefined when the runtime has
 *   none yet.
 * @returns True only when that session has explicitly enabled Auto. Unknown,
 *   absent or cleared sessions read `false` — fail closed.
 */
export function getAutoPolicy(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return policies.get(sessionId) === true;
}

/**
 * Hydrates the policy from a value of unknown shape (a server response field).
 *
 * Strictly `=== true`, matching the read in `useOpenCodeConversationConfig` and
 * the materialization in `remoteThreadListAdapter`: a malformed, absent or
 * string value must not arm the shield.
 *
 * @param sessionId - The OpenCode session the value belongs to.
 * @param value - The persisted `opencodeAutoApprove`, of unknown shape.
 */
export function hydrateAutoPolicy(sessionId: string, value: unknown): void {
  setAutoPolicy(sessionId, value === true);
}

/**
 * Drops one session's policy.
 *
 * Called when a session is terminated or its conversation is deleted, so a later
 * session reusing an id cannot inherit a stale `true`. **Not** called on a mere
 * component unmount — a resumable conversation keeps its persisted setting and
 * rehydrates the cache when its session is recreated.
 *
 * @param sessionId - The session to forget.
 */
export function clearAutoPolicy(sessionId: string): void {
  policies.delete(sessionId);
}

/** Drops every policy. Test-support and teardown only. */
export function clearAllAutoPolicies(): void {
  policies.clear();
}